// The pull-request view of a branch's review record. The record itself stays in .git; this module only
// decides what GitHub is allowed to show. Pure, no Node APIs: shared by the publisher and the desk.
//
// success is gateReason returning nothing for this commit. A review's own prose never counts, and a
// caller cannot pass a state in: the only success is a clean saved record. Anything else is failure,
// so a pull request with open findings or no finished cadence is visibly unclean.

import { gateReason, openFindings } from './cadence.mjs';
import { clean } from './term.mjs';

export const STATUS_CONTEXT = 'session-rail/review';
export const COMMENT_MARKER = '<!-- session-rail-review -->';
const DESC_MAX = 140;

const runsOf = (runs) => (Array.isArray(runs) ? runs : []).filter((r) => r && Array.isArray(r.findings));

const plain = (s, n) => {
  const t = clean(String(s ?? '')).replace(/\s+/g, ' ').trim().split(COMMENT_MARKER).join('');
  if (t.length <= n) return t;
  return `${t.slice(0, Math.max(0, n - 1))}…`;
};

// Why the record is not clean, as one short sentence for the status description. The lead-in is the same
// for every miss; the next sentence says which part of the cadence is missing.
function shortReason(reason) {
  const text = plain(String(reason ?? '').replace(/^session-rail:\s*/, ''), 800);
  const parts = text.split(/(?<=\.)\s/).filter(Boolean);
  const useful = parts.find((p) => !/^merge after a final review/i.test(p)) || parts[0] || text;
  return plain(useful, DESC_MAX);
}

/**
 * The status for `head`. `state` is `success` only when the merge gate is clear for that commit.
 * @param {unknown[]} runs
 * @param {{ head?: string }} [opts]
 */
export function reviewStatus(runs, { head } = {}) {
  const list = runsOf(runs);
  const sha = typeof head === 'string' ? head.trim() : '';
  const reason = sha ? gateReason(list, { head: sha }) : 'session-rail: no commit to attach a review to.';
  const open = openFindings(list);
  const cleanGate = reason == null;
  let description;
  if (!sha) description = 'No commit to attach a review to.';
  else if (cleanGate) description = 'Reviewed. The code review and the final approach review are clean.';
  else if (open.approach.length || open.code.length) description = `Open findings: ${open.approach.length} approach, ${open.code.length} code.`;
  else description = shortReason(reason);
  return {
    state: cleanGate ? 'success' : 'failure',
    clean: cleanGate,
    context: STATUS_CONTEXT,
    description: plain(description, DESC_MAX),
    head: sha,
    reason: reason ?? null,
    openApproach: open.approach.length,
    openCode: open.code.length,
  };
}

// The JSON body for the commit status API. `success` requires both flags; a lone `state: 'success'` posts failure.
export function statusRequest(status, { targetUrl } = {}) {
  const success = status?.clean === true && status?.state === 'success';
  const given = typeof status?.description === 'string' ? status.description : '';
  // A failure keeps its own sentence. A description that claims the review passed does not survive a failure.
  const description = plain(
    success ? (given || 'Reviewed. The code review and the final approach review are clean.')
      : (given && !given.startsWith('Reviewed.') ? given : 'No passing review recorded.'),
    DESC_MAX,
  );
  const body = { state: success ? 'success' : 'failure', context: STATUS_CONTEXT, description };
  if (typeof targetUrl === 'string' && /^https:\/\/\S+$/.test(targetUrl) && targetUrl.length <= 500) body.target_url = targetUrl;
  return body;
}

/** Open findings, approach then code, for the pull request comment. */
export function openTitles(runs) {
  const open = openFindings(runsOf(runs));
  const row = (kind, f) => ({
    kind, title: typeof f.title === 'string' ? f.title : '',
    file: typeof f.file === 'string' ? f.file : null, line: Number.isInteger(f.line) ? f.line : null,
  });
  return [...open.approach.map((f) => row('approach', f)), ...open.code.map((f) => row('code', f))];
}

/** The one comment the plugin keeps on the pull request. The marker is how the next post finds it. */
export function commentBody(status, { findings = [] } = {}) {
  const head = status?.head ? `\`${plain(status.head, 64)}\`` : 'unknown';
  const state = status?.clean === true && status?.state === 'success' ? 'success' : 'failure';
  const lines = [
    COMMENT_MARKER,
    '## session-rail review',
    '',
    `**${state}** · \`${STATUS_CONTEXT}\` · commit ${head}`,
    '',
    state === 'success'
      ? 'The code review has run since the last chunk, and the final approach review has run after it on this commit with nothing uncommitted. Nothing is open.'
      : plain(status?.reason || 'No passing review recorded.', 2000),
    '',
  ];
  const list = (Array.isArray(findings) ? findings : []).filter((f) => f && f.title).slice(0, 20);
  if (list.length) {
    lines.push('### Open findings', '');
    for (const f of list) {
      const where = f.file ? ` (${plain(f.file, 160)}${f.line ? `:${f.line}` : ''})` : '';
      lines.push(`- ${f.kind === 'code' ? 'code' : 'approach'}: ${plain(f.title, 200)}${where}`);
    }
    if (findings.length > list.length) lines.push(`- and ${findings.length - list.length} more`);
    lines.push('');
  }
  lines.push('This status is not a required check unless the repository asks for `session-rail/review`. A person can still merge by hand, and `git merge` is not blocked.');
  lines.push('');
  lines.push('The plugin posts `success` only when the saved review record passes the merge gate. It does not invent a passing review.');
  return lines.join('\n');
}

/**
 * What the Review tab says when a person could merge, or already did, without a clean record.
 * Null when there is no pull request, the record is clean, or GitHub is not offering the merge.
 * @param {unknown[]} runs
 * @param {{ head?: string, pr?: { state?: string, draft?: boolean, isDraft?: boolean, mergeable?: boolean | null, mergeStateStatus?: string, head?: string } | null }} [opts]
 * @returns {{ tone: 'bad' | 'warn', text: string } | null}
 */
export function mergeWarning(runs, { head, pr } = {}) {
  if (!pr || typeof pr !== 'object') return null;
  const sha = typeof pr.head === 'string' && pr.head.trim() ? pr.head.trim() : head;
  if (reviewStatus(runs, { head: sha }).clean) return null;
  const state = String(pr.state || '').toUpperCase();
  const draft = pr.draft === true || pr.isDraft === true || String(pr.mergeStateStatus || '').toUpperCase() === 'DRAFT';
  if (state === 'MERGED') {
    return { tone: 'bad', text: 'This pull request is merged, and the review record is not clean. GitHub has no passing session-rail review for this commit.' };
  }
  if (state !== 'OPEN' || draft || pr.mergeable === false) return null;
  const mergeState = String(pr.mergeStateStatus || '').toUpperCase();
  const canMerge = pr.mergeable === true || mergeState === 'CLEAN' || mergeState === 'UNSTABLE';
  if (!canMerge) return null;
  return { tone: 'warn', text: 'GitHub will let a person merge this pull request, and the review record is not clean. The session-rail/review check is not required until this repo turns that on.' };
}

/** `owner/repo` from `gh repo view`, or null. */
export function repoSlug(text) {
  const name = String(text ?? '').trim().replace(/^"|"$/g, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) ? name : null;
}

/** A full commit id, or null. A short or empty head is not posted, so a stand-in cannot become a status. */
export function commitSha(text) {
  const sha = String(text ?? '').trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/**
 * The newest `session-rail/review` status in a statuses payload (an array, or `{ statuses }`).
 * Missing, failure, and a payload that will not parse are not success.
 * @param {unknown} payload
 */
export function requireVerdict(payload) {
  const list = Array.isArray(payload) ? payload : payload?.statuses;
  if (!Array.isArray(list)) return { ok: false, state: 'missing' };
  const ours = list.filter((s) => s && s.context === STATUS_CONTEXT);
  const state = ours.length ? String(ours[0].state) : 'missing';
  return { ok: state === 'success', state };
}

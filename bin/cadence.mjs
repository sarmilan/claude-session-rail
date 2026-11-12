// The review cadence: an approach review (reviewer.mjs) when the brief is complete and after each chunk, and
// before a merge a code review of the whole branch (/code-review, recorded from its final JSON block) followed
// by a final approach review that also judges what the code review's fixer did. This module owns the rules over
// a branch's review record (reviewer.mjs's store): finding statuses, what's still open, and why a merge must
// wait. Pure, no Node APIs: shared by the hooks, the reviewer and the desk.
//
// A run: { type: 'approach' | 'code', startedAt, finishedAt, head, dirty, final?, manual?, verdict, summary, error?, findings }.
// `head` is the commit it reviewed, `dirty` whether there were uncommitted changes, and `manual` an approach
// review run from the desk (on demand, not a chunk's). Runs from before the
// cadence have no type (an approach review) and no head.
// A finding: { id, kind, title, detail, severity, chunk?, file?, line?, status, outcome?, checked?, note? }, `status`
// one of open, applied, declined; a code finding's `outcome` is its fixer's verdict and `checked` says an approach
// review judged it. Findings from before the cadence have no status and are left out of every count.

export const STATUSES = ['open', 'applied', 'declined'];
// The record's file (the same place as sources.reviewsPath) and how many runs it keeps.
export const reviewsFile = (common, branch) => `${common}/session-rail/reviews/${encodeURIComponent(branch)}.json`;
export const KEEP_RUNS = 30;
// The runs to save: the newest KEEP_RUNS, and any older one still holding an open finding, so the gate never
// loses one by trimming.
export const keptRuns = (runs) => runs.filter((r, i) => i < KEEP_RUNS || r.findings?.some((f) => f?.status === 'open'));
export const runType = (r) => (r.type === 'code' ? 'code' : 'approach');
const tracked = (f) => STATUSES.includes(f.status);

// The findings still open. Approach findings stay open across runs until a later review marks them; a code
// review supersedes the one before it (a /code-review --fix re-reports with outcomes), so only the newest counts.
export function openFindings(runs) {
  const approach = runs.filter((r) => !r.error && runType(r) === 'approach').flatMap((r) => r.findings);
  return {
    approach: approach.filter((f) => tracked(f) && f.status === 'open'),
    code: codeFindings(runs).filter((f) => f.status === 'open'),
  };
}

// The code findings that count: the newest code review's, plus any the approach review reopened in an older one
// (checked and open), which stay until a later approach review settles them, whatever the next /code-review says.
export function codeFindings(runs) {
  const code = runs.filter((r) => !r.error && runType(r) === 'code');
  const reopened = code.slice(1).flatMap((r) => r.findings.filter((f) => tracked(f) && f.checked && f.status === 'open'));
  return [...(code[0]?.findings ?? []).filter(tracked), ...reopened];
}

// A /code-review report ({ findings } in ReportFindings' shape, from reportFromText) as a code run. fixed → applied; no_change_needed or skipped → declined (the fixer's
// call is trusted: a skip is usually a false positive); no outcome (the first report, before fixing) → open.
// The outcome is kept, so the desk can tell a skip from no change needed.
export function codeRun(report, { head, dirty, at }) {
  const list = Array.isArray(report?.findings) ? report.findings : [];
  const findings = list.filter((f) => f && typeof f.summary === 'string').map((f, i) => {
    const status = f.outcome === 'fixed' ? 'applied' : f.outcome === 'no_change_needed' || f.outcome === 'skipped' ? 'declined' : 'open';
    return {
      id: `c${at.toString(36)}-${i}`, kind: typeof f.category === 'string' ? f.category : 'correctness',
      title: (typeof f.short_summary === 'string' && f.short_summary) || f.summary, detail: [f.summary, f.failure_scenario].filter(Boolean).join(' '),
      severity: 'medium', file: typeof f.file === 'string' ? f.file : null, line: Number.isInteger(f.line) ? f.line : null,
      status, ...(typeof f.outcome === 'string' ? { outcome: f.outcome } : {}),
    };
  });
  const open = findings.filter((f) => f.status === 'open').length;
  return { type: 'code', startedAt: at, finishedAt: at, head, dirty, findings,
    verdict: open ? 'open-findings' : 'clean',
    summary: findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}, ${open} open` : 'No findings' };
}

// /code-review's report from its final text: the last ```json block holding findings (each with a summary), as
// { findings, run } (run: the token it carried, or null), or null when there's none. Its findings carry `outcome` once --fix has applied them.
export function reportFromText(text) {
  // Fences open and close at a line's start, so a ``` inside a finding's text (JSON strings hold no newline) can't end one.
  const blocks = [...String(text ?? '').matchAll(/^[ \t]*```json[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map((m) => m[1]);
  for (const b of blocks.reverse()) {
    try {
      // A run's report is { run, findings } (the token says which run); a bare list is a report with no token.
      const j = JSON.parse(b), list = Array.isArray(j) ? j : j?.findings;
      if (Array.isArray(list) && list.every((f) => f && typeof f.summary === 'string'))
        return { findings: list, run: typeof j?.run === 'string' ? j.run : null };
    } catch {}
  }
  return null;
}

// Ids for a new approach run's findings, open until a later review checks them.
export const trackFindings = (findings, at) =>
  findings.map((f, i) => ({ ...f, id: `a${at.toString(36)}-${i}`, status: 'open' }));

// The newest code review's findings for the approach review's staff-engineer pass: each one not yet checked
// (did a fix really land, is a skip or no-change sound), and any it reopened, until a later check settles it.
export function staffCheck(runs) {
  return codeFindings(runs).filter((f) => !f.checked || f.status === 'open');
}

// The fixer's own verdicts (fixed, skipped, no change needed) still waiting for that check.
export const uncheckedFixes = (runs) => staffCheck(runs).filter((f) => f.status !== 'open');

// Apply a review's verdicts on earlier findings ([{ id, status, note }]) to the runs, in place of the old ones.
// A finding a review checked is marked `checked`.
export function applyChecks(runs, checks) {
  const by = new Map((checks ?? []).filter((c) => c && STATUSES.includes(c.status)).map((c) => [c.id, c]));
  if (!by.size) return runs;
  return runs.map((r) => ({ ...r, findings: r.findings.map((f) => {
    const c = by.get(f.id);
    return c && tracked(f) ? { ...f, status: c.status, checked: true, note: typeof c.note === 'string' && c.note ? c.note : f.note } : f;
  }) }));
}

// Why a merge must wait, or null. `head` is the branch's current commit. The final approach review must have
// run after the last commit with nothing uncommitted, so it saw the branch as it will merge; it judges whether
// the code review's fixes landed, so the code review only has to come after the chunks' approach reviews and
// before that final one (its fixes are committed in between). Nothing may be open, and the fixer's verdicts
// must have been judged. Commits aren't gated: the merge is what ships.
/** @param {{ head: string }} state */
export function gateReason(runs, { head }) {
  const done = runs.filter((r) => !r.error);
  const final = done.find((r) => runType(r) === 'approach' && r.final === true && r.head === head && r.dirty === false);
  const code = done.find((r) => runType(r) === 'code');
  // A review run from the desk on demand isn't a chunk's, so it doesn't make the code review stale.
  const lastChunkReview = done.find((r) => runType(r) === 'approach' && r.final !== true && !r.manual);
  const missing = [];
  if (!code || (lastChunkReview && code.startedAt < lastChunkReview.startedAt))
    missing.push("/code-review hasn't run over the whole branch since the last chunk's review: run /code-review --fix against the default branch, and commit its fixes.");
  else if (!final || final.startedAt < code.startedAt)
    missing.push("The final approach review hasn't run after the code review, on the last commit with nothing uncommitted: commit any fixes, then call review_approach with final: true.");
  const open = openFindings(runs);
  const titles = (l) => l.slice(0, 3).map((f) => `"${f.title}"`).join(', ') + (l.length > 3 ? ` and ${l.length - 3} more` : '');
  if (open.approach.length) missing.push(`The approach review has ${open.approach.length} open finding${open.approach.length === 1 ? '' : 's'} (${titles(open.approach)}).`);
  if (open.code.length) missing.push(`/code-review has ${open.code.length} open finding${open.code.length === 1 ? '' : 's'} (${titles(open.code)}).`);
  const unchecked = uncheckedFixes(runs);
  if (unchecked.length) missing.push(`The approach review hasn't checked what /code-review's fixer did about ${unchecked.length} finding${unchecked.length === 1 ? '' : 's'} (${titles(unchecked)}): call review_approach with final: true again.`);
  if (!missing.length) return null;
  const capped = open.approach.length || open.code.length
    ? " Apply open findings, commit, and call review_approach with final: true to check them (or give your reason in its notes), at most two rounds; after that, list what is still open in the PR and ask the person instead of looping." : '';
  return `session-rail: merge after a final review of the whole branch. ${missing.join(' ')}${capped}`;
}

// Whether a shell command merges a pull request (gh pr merge). Only a command at the start of a segment counts
// (after ;, &, &&, ||, |, ( or a newline, past env assignments and command/exec/env/time), so a message that
// mentions it doesn't.
export function mergesPr(command) {
  for (const seg of String(command ?? '').split(/&&|\|\||[;|&\n]/)) {
    const s = seg.trim().replace(/^(?:\(\s*|(?:command|exec|env|time)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '');
    if (/^gh\s+pr\s+merge\b/.test(s)) return true;
  }
  return false;
}

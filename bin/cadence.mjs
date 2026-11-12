// The review cadence: before each chunk's commit an approach review (reviewer.mjs) and a code review
// (/code-review, recorded from its final JSON block) run and every finding gets applied; before a merge
// both run again over the whole branch. This module owns the rules over a branch's review record
// (reviewer.mjs's store): finding statuses, what's still open, and why a commit or merge must wait.
// Pure, no Node APIs: shared by the hooks, the reviewer and the desk.
//
// A run: { type: 'approach' | 'code', startedAt, finishedAt, head, dirty, final?, verdict, summary, error?, findings }.
// `head` is the commit it reviewed and `dirty` whether there were uncommitted changes. Runs from before the
// cadence have no type (an approach review) and no head.
// A finding: { id, kind, title, detail, severity, chunk?, file?, line?, status, note? }, `status` one of
// open, applied, declined. Findings from before the cadence have no status and are left out of every count.

export const STATUSES = ['open', 'applied', 'declined'];
// The record's file (the same place as sources.reviewsPath) and how many runs it keeps.
export const reviewsFile = (common, branch) => `${common}/session-rail/reviews/${encodeURIComponent(branch)}.json`;
export const KEEP_RUNS = 30;
export const runType = (r) => (r.type === 'code' ? 'code' : 'approach');
const tracked = (f) => STATUSES.includes(f.status);

// The findings still open. Approach findings stay open across runs until a later review marks them; a code
// review supersedes the one before it (a /code-review --fix re-reports with outcomes), so only the newest counts.
export function openFindings(runs) {
  const approach = runs.filter((r) => !r.error && runType(r) === 'approach').flatMap((r) => r.findings);
  const code = runs.find((r) => !r.error && runType(r) === 'code')?.findings ?? [];
  return {
    approach: approach.filter((f) => tracked(f) && f.status === 'open'),
    code: code.filter((f) => tracked(f) && f.status === 'open'),
  };
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
      title: f.short_summary || f.summary, detail: [f.summary, f.failure_scenario].filter(Boolean).join(' '),
      severity: 'medium', file: typeof f.file === 'string' ? f.file : null, line: Number.isInteger(f.line) ? f.line : null,
      status, ...(typeof f.outcome === 'string' ? { outcome: f.outcome } : {}),
    };
  });
  const open = findings.filter((f) => f.status === 'open').length;
  return { type: 'code', startedAt: at, finishedAt: at, head, dirty, findings,
    verdict: open ? 'open-findings' : 'clean',
    summary: findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}, ${open} open` : 'No findings' };
}

// /code-review's report from its final text: the last ```json block holding a list of findings (each with a
// summary), as { findings }, or null when there's none. Its findings carry `outcome` once --fix has applied them.
export function reportFromText(text) {
  // Fences open and close at a line's start, so a ``` inside a finding's text (JSON strings hold no newline) can't end one.
  const blocks = [...String(text ?? '').matchAll(/^[ \t]*```json[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map((m) => m[1]);
  for (const b of blocks.reverse()) {
    try {
      const list = JSON.parse(b);
      if (Array.isArray(list) && list.every((f) => f && typeof f.summary === 'string')) return { findings: list };
    } catch {}
  }
  return null;
}

// Ids for a new approach run's findings, open until a later review checks them.
export const trackFindings = (findings, at) =>
  findings.map((f, i) => ({ ...f, id: `a${at.toString(36)}-${i}`, status: 'open' }));

// Apply a review's verdicts on earlier findings ([{ id, status, note }]) to the runs, in place of the old ones.
export function applyChecks(runs, checks) {
  const by = new Map((checks ?? []).filter((c) => c && STATUSES.includes(c.status)).map((c) => [c.id, c]));
  if (!by.size) return runs;
  return runs.map((r) => ({ ...r, findings: r.findings.map((f) => {
    const c = by.get(f.id);
    return c && tracked(f) ? { ...f, status: c.status, note: typeof c.note === 'string' && c.note ? c.note : f.note } : f;
  }) }));
}

// Why a commit or a merge must wait, or null. `head` is the branch's current commit. A commit needs both
// reviews since the last commit; a merge needs both after the last commit with nothing uncommitted (so they
// covered the whole branch as it will merge). Either way nothing may be open.
export function gateReason(runs, { action, head }) {
  // A merge counts only an approach review asked for as final (the whole branch, as finished).
  const ok = runs.filter((r) => !r.error && r.head === head
    && (action === 'commit' || (r.dirty === false && (runType(r) === 'code' || r.final === true))));
  const since = action === 'commit' ? 'since the last commit' : 'after the last commit with nothing uncommitted';
  const missing = [];
  if (!ok.some((r) => runType(r) === 'approach')) missing.push(`The approach review hasn't run ${since}: call review_approach${action === 'merge' ? ' with final: true' : ''}.`);
  // The newest code review must be the one that counts, so a later one with open findings isn't hidden.
  const code = runs.find((r) => !r.error && runType(r) === 'code');
  if (!code || !ok.includes(code)) missing.push(`/code-review hasn't run ${since}: run /code-review --fix${action === 'merge' ? ' over the whole branch' : ''}.`);
  const open = openFindings(runs);
  const titles = (l) => l.slice(0, 3).map((f) => `"${f.title}"`).join(', ') + (l.length > 3 ? ` and ${l.length - 3} more` : '');
  if (open.approach.length) missing.push(`The approach review has ${open.approach.length} open finding${open.approach.length === 1 ? '' : 's'} (${titles(open.approach)}): apply them, or say why not in notes, and call review_approach again so it checks them.`);
  if (open.code.length) missing.push(`/code-review has ${open.code.length} open finding${open.code.length === 1 ? '' : 's'} (${titles(open.code)}): fix them and run /code-review --fix again.`);
  if (!missing.length) return null;
  return `session-rail: ${action === 'commit' ? 'commit after the reviews' : 'merge after a final review of the whole branch'}. ${missing.join(' ')}`;
}

// Which git action a shell command runs, if any: 'commit' for git commit, 'merge' for gh pr merge. Only a
// command at the start of a segment counts (after ;, &, &&, ||, |, ( or a newline, past env assignments and
// command/exec/env/time), so a message that mentions them doesn't. git commit-tree and commit-graph aren't commits.
export function gatedAction(command) {
  for (const seg of String(command ?? '').split(/&&|\|\||[;|&\n]/)) {
    const s = seg.trim().replace(/^(?:\(\s*|(?:command|exec|env|time)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '');
    if (/^git\s+(?:(?:-[Cc]\s+\S+|--?[A-Za-z][\w-]*(?:=\S*)?)\s+)*commit(?![\w-])/.test(s)) return 'commit';
    if (/^gh\s+pr\s+merge\b/.test(s)) return 'merge';
  }
  return null;
}

// One chore: re-check failing CI on this branch. Pure rules, no Node APIs.
// A round costs one unit of the budget. The unit is a round, not dollars: the rail does not
// show session cost. Two empty rounds, or a spent budget, stop the loop. Nothing here merges.
//
// A chore: { id, kind, title, repo, branch, head, worktree, window, windowNote, budget: { cap, unit },
//   spend, emptyRounds, status, stop, merge, autoMerge, rounds, createdAt, updatedAt }.
// A round: { n, at, dry, tried, empty, spend, note }.
// status is running, waiting, or blocked. stop is null, 'empty', 'budget', or 'review'.

export const KIND = 'ci';
export const TITLE = 'Re-run failing CI';
export const EMPTY_LIMIT = 2;
export const DEFAULT_CAP = 5;
export const UNIT = 'rounds';

// Off unless settings say so. Absent is off, unlike auto-compact.
export const choresOn = (settings) => settings?.chores === true;

// A positive integer cap, or the default when the caller left it unset. Never unlimited.
export function budgetCap(value) {
  if (value == null || value === '') return { ok: true, cap: DEFAULT_CAP };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    return { ok: false, message: 'The budget is a round cap from 1 to 100. There is no unlimited run.' };
  }
  return { ok: true, cap: n };
}

export function idFor(branch) {
  const slug = String(branch || 'detached').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'detached';
  return `ci-${slug}`;
}

export function freshChore({ id, branch, repo, head, worktree, cap, at }) {
  return {
    id,
    kind: KIND,
    title: TITLE,
    repo: repo || '',
    branch: branch || '',
    head: head || '',
    worktree: worktree || '',
    window: null,
    windowNote: '',
    budget: { cap, unit: UNIT },
    spend: 0,
    emptyRounds: 0,
    status: 'waiting',
    stop: null,
    merge: 'human',
    autoMerge: false,
    rounds: [],
    createdAt: at,
    updatedAt: at,
  };
}

// Why another round must not start, or { ok: true }. A refusal spends nothing.
export function mayRound(chore) {
  if (!chore || chore.kind !== KIND) return { ok: false, reason: 'not a chore' };
  if (chore.merge !== 'human' || chore.autoMerge !== false) return { ok: false, reason: 'a chore never merges on its own' };
  if (chore.stop === 'review') return { ok: false, reason: 'waiting for a person to review' };
  if (chore.stop === 'empty' || chore.emptyRounds >= EMPTY_LIMIT) return { ok: false, reason: 'two empty rounds; stopped without further spend' };
  if (chore.stop === 'budget' || chore.spend >= (chore.budget?.cap ?? 0)) return { ok: false, reason: 'budget spent; stopped without further spend' };
  return { ok: true };
}

// A gh statusCheckRollup list. No checks is empty. A failure or a check still running is work.
const FAILING = ['FAILURE', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ERROR'];
const PENDING = ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', ''];
export function signalFromChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  if (!list.length) return { work: false, note: 'no checks', tried: 'gh pr view' };
  const conclusion = (c) => String(c?.conclusion || c?.state || '').toUpperCase();
  const bad = list.filter((c) => FAILING.includes(conclusion(c)));
  if (bad.length) return { work: true, note: bad.map((c) => c.name || c.context || 'check').filter(Boolean).slice(0, 4).join(', '), tried: 'gh pr view' };
  if (list.some((c) => PENDING.includes(conclusion(c)))) return { work: true, note: 'checks still running', tried: 'gh pr view' };
  return { work: false, note: 'checks green', tried: 'gh pr view' };
}

// One round. `signal.work` means the check found something (failing or still running). No work is an empty round.
// A refused round returns the same chore and spent: false.
export function applyRound(chore, signal, { at, dry = false } = {}) {
  const gate = mayRound(chore);
  if (!gate.ok) return { chore, spent: false, refused: gate.reason };
  const work = signal?.work === true;
  const empty = !work;
  const spend = chore.spend + 1;
  const emptyRounds = empty ? chore.emptyRounds + 1 : 0;
  const note = String(signal?.note || (empty ? 'nothing failing' : 'checks failing')).slice(0, 200);
  const round = {
    n: chore.rounds.length + 1,
    at,
    dry: Boolean(dry),
    tried: String(signal?.tried || (dry ? 'dry run' : 'gh pr view')).slice(0, 80),
    empty,
    spend: 1,
    note,
  };
  let stop = null;
  let status = 'waiting';
  if (emptyRounds >= EMPTY_LIMIT) { stop = 'empty'; status = 'blocked'; }
  else if (spend >= chore.budget.cap) { stop = 'budget'; status = 'blocked'; }
  const next = {
    ...chore,
    spend,
    emptyRounds,
    rounds: [...chore.rounds, round],
    stop,
    status,
    merge: 'human',
    autoMerge: false,
    updatedAt: at,
  };
  return { chore: next, spent: true, refused: null };
}

// Mark the chore running before the check, so the rail can show busy. Does not spend.
export function beginRound(chore, at) {
  const gate = mayRound(chore);
  if (!gate.ok) return { chore, ok: false, reason: gate.reason };
  return { chore: { ...chore, status: 'running', updatedAt: at, merge: 'human', autoMerge: false }, ok: true };
}

// A person stops the loop. Does not spend. A budget or empty stop stays as it is.
export function stopForReview(chore, at) {
  if (!chore) return chore;
  if (chore.stop === 'empty' || chore.stop === 'budget') {
    return { ...chore, merge: 'human', autoMerge: false, updatedAt: at };
  }
  return { ...chore, status: 'waiting', stop: 'review', merge: 'human', autoMerge: false, updatedAt: at };
}

const RANK = { blocked: 0, waiting: 1, busy: 2, idle: 3 };

// The Sessions row. busy while a round runs, blocked once the loop has stopped itself, otherwise waiting.
export function sessionRow(chore) {
  const state = chore.status === 'running' ? 'busy'
    : (chore.stop === 'empty' || chore.stop === 'budget' || chore.status === 'blocked') ? 'blocked'
    : 'waiting';
  const spend = `${chore.spend}/${chore.budget?.cap ?? '?'}`;
  const why = chore.status === 'running' ? 're-checking CI'
    : chore.stop === 'empty' ? 'two empty rounds'
    : chore.stop === 'budget' ? 'budget spent'
    : 'for review';
  return {
    chore: true,
    sessionId: `chore:${chore.id}`,
    pid: null,
    tty: null,
    title: chore.title,
    state,
    doing: `${why} · ${spend}`,
    repo: chore.repo,
    branch: chore.branch,
    since: Date.parse(chore.updatedAt) || 0,
    current: false,
    host: 'chore',
  };
}

// Sessions first (the current one, then who needs the person), with chore rows in the same order.
export function placeChores(rows, chores) {
  const extra = (chores || []).filter((c) => c && c.kind === KIND).map(sessionRow);
  return [...(rows || []), ...extra].sort((a, b) =>
    (Number(b.current) - Number(a.current)) || ((RANK[a.state] ?? 9) - (RANK[b.state] ?? 9)) || ((b.since || 0) - (a.since || 0)));
}

export function summaryLines(chore) {
  const lines = [
    `${chore.title} on ${chore.branch || '(no branch)'}.`,
    `Worktree: ${chore.worktree || '(none)'}. Detached at ${(chore.head || '').slice(0, 7) || '?'}, so it does not share the checkout you have open.`,
    chore.window ? 'Window: open beside your session.' : `Window: ${chore.windowNote || 'not opened'}.`,
    `Spend: ${chore.spend} of ${chore.budget?.cap} ${chore.budget?.unit || UNIT}. Empty rounds in a row: ${chore.emptyRounds}.`,
    stopSentence(chore),
    'A person reviews this file and the branch. The chore does not merge, and it does not approve the brief.',
    'The brief gate and the review cadence still apply to any edit. This chore only re-checks CI.',
  ];
  if (!chore.rounds?.length) lines.push('No rounds yet.');
  for (const r of chore.rounds || []) {
    lines.push(`Round ${r.n}${r.dry ? ' (dry run)' : ''}: ${r.empty ? 'empty' : 'found work'} — ${r.note}. Tried ${r.tried}. Spend ${r.spend}.`);
  }
  return lines;
}

function stopSentence(chore) {
  if (chore.stop === 'empty') return 'Stopped: two empty rounds, and nothing further will be spent.';
  if (chore.stop === 'budget') return 'Stopped: the budget is spent, and nothing further will be spent.';
  if (chore.stop === 'review') return 'Stopped for review: a person decides what happens next. Nothing further will be spent until they start again.';
  if (chore.status === 'running') return 'Running one round. It stops after two empty rounds or when the budget is spent.';
  return 'Waiting. Another round can run until two empty rounds or the budget.';
}

// The file a person opens. The summary is the first field.
export function withSummary(chore) {
  const { summary: _drop, ...rest } = chore;
  return { summary: summaryLines(rest), ...rest, merge: 'human', autoMerge: false };
}

// The same merge the review gate refuses. A chore has no path that runs it.
export function choreMustNotRun(command, mergesPr) {
  if (typeof mergesPr === 'function' && mergesPr(command)) return 'a chore never runs gh pr merge; a person reviews first';
  return null;
}

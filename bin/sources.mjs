// Data sources for the session rail. Every exported function resolves to plain JSON and never throws.
import { execFile } from 'node:child_process';
import { readFile, readdir, lstat, stat, open } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseBrief, briefStatus, NO_BRIEF_BRANCHES } from './brief.mjs';

const HOME = homedir();
const CLAUDE = join(HOME, '.claude');

const run = (cmd, args, { cwd, timeout = 10_000 } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 4 << 20 }, (err, stdout) =>
      resolve(err ? null : stdout.toString()));
  });

const readJson = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
};

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export const tildify = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

// ── Environment ────────────────────────────────────────────────────────────────
export async function environment(cwd) {
  const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd }))?.trim();
  const [branch, porcelain, base] = top
    ? await Promise.all([
        run('git', ['branch', '--show-current'], { cwd }),
        run('git', ['status', '--porcelain'], { cwd }),
        defaultBranch(cwd),
      ])
    : [null, null, null];
  const root = top || cwd;
  const fork = base ? await forkPoint(cwd, base) : null;
  const [diff, commits] = fork ? await Promise.all([branchDiff(cwd, fork), branchCommits(cwd, fork)]) : [null, []];
  return {
    computer: hostname().replace(/\.local$/, ''),
    root,
    repo: basename(root),
    parent: tildify(dirname(root)),
    branch: branch?.trim() || null,
    dirty: porcelain ? porcelain.split('\n').filter(Boolean).length : 0,
    isGit: Boolean(top),
    added: diff?.added ?? 0,
    removed: diff?.removed ?? 0,
    base: base?.replace(/^origin\//, '') ?? null,
    commits,
  };
}

// This branch's commits since it forked (newest first, up to max), then the fork commit itself, marked fork.
// On the default branch the fork is HEAD, so that's the only one.
const LOG_FORMAT = '--format=%h%x1f%s%x1f%ct';
const parseLog = (out) => (out ?? '').split('\n').filter(Boolean).map((l) => {
  const [sha, subject, ct] = l.split('\x1f');
  return { sha, subject, at: +ct * 1000 };
});
async function branchCommits(cwd, fork, max = 8) {
  const [own, base] = await Promise.all([
    run('git', ['log', '-n', String(max), LOG_FORMAT, `${fork}..HEAD`], { cwd }),
    run('git', ['log', '-1', LOG_FORMAT, fork], { cwd }),
  ]);
  return [...parseLog(own), ...parseLog(base).map((c) => ({ ...c, fork: true }))];
}

// The default branch: origin/HEAD, else the first of main/master that exists (remote, then local).
async function defaultBranch(cwd) {
  const head = (await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd }))?.trim();
  for (const base of new Set([head, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)))
    if (await run('git', ['rev-parse', '--verify', '--quiet', base], { cwd })) return base;
  return null;
}

// The commit this branch forked from the default branch. On the default branch itself that's HEAD, so
// diffs against it show just the uncommitted changes. `base` saves looking the default branch up again.
export async function forkPoint(cwd, base) {
  base ??= await defaultBranch(cwd);
  return base ? (await run('git', ['merge-base', 'HEAD', base], { cwd }))?.trim() || null : null;
}

// Lines added/removed on this branch: the working tree against the fork point, so committed and
// uncommitted work both count (untracked files don't).
async function branchDiff(cwd, fork) {
  const stat = (await run('git', ['diff', '--shortstat', fork], { cwd })) ?? '';
  return { added: +(stat.match(/(\d+) insertion/)?.[1] ?? 0), removed: +(stat.match(/(\d+) deletion/)?.[1] ?? 0) };
}

// ── Branch changes, file by file (the review panel's Diff tab) ─────────────────
// Where the desk keeps this branch's code reviews: inside the shared git dir (so worktrees share it and it is
// never committed), one file per branch. null outside a repo. The desk polls this, so git is asked for the
// repo's dirs once and the branch is read from HEAD after that. A rebase reviews into the branch being
// rebased; any other detached HEAD shares one "detached" file rather than starting a new one per commit.
const gitDirs = new Map();
async function branchStore(cwd) {
  if (!gitDirs.has(cwd)) {
    const out = await run('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd });
    const [dir, common] = out?.trim().split('\n') ?? [];
    if (!dir || !common) return null; // not cached, so a folder that becomes a repo is noticed
    gitDirs.set(cwd, { dir, common });
  }
  const { dir, common } = gitDirs.get(cwd);
  const read = async (p) => { try { return (await readFile(join(dir, p), 'utf8')).trim(); } catch { return ''; } };
  const head = await read('HEAD'); // a detached HEAD holds a commit id, so only a "ref:" line names the branch
  const ref = head.startsWith('ref: ') ? head.slice(5) : (await read('rebase-merge/head-name')) || (await read('rebase-apply/head-name'));
  const branch = ref.startsWith('refs/heads/') ? ref.slice(11) : 'detached';
  // encodeURIComponent keeps feature/x and feature_x apart.
  return { branch, file: (kind, ext) => join(common, 'session-rail', kind, `${encodeURIComponent(branch)}.${ext}`) };
}
export async function reviewsPath(cwd) { return (await branchStore(cwd))?.file('reviews', 'json') ?? null; }

// ── Activity: what the session is doing right now (written by hooks/activity.ts and the desk) ─
// null when the session has no feed yet (its hooks haven't loaded this plugin version). The desk's review
// counts only while the desk that wrote it is alive.
export async function activity(sessionId) {
  if (!sessionId) return null;
  const dir = join(CLAUDE, 'session-rail', 'activity');
  const [feed, desk] = await Promise.all([readJson(join(dir, `${sessionId}.json`)), readJson(join(dir, `${sessionId}.desk.json`))]);
  const review = desk?.review && desk.pid && alive(desk.pid) ? desk.review : null;
  if (!feed?.claude) return review ? { claude: null, running: [], recent: [], desk: review } : null;
  return { claude: feed.claude, running: feed.running ?? [], recent: feed.recent ?? [], gate: feed.gate ?? null, compacted: feed.compacted ?? null, desk: review };
}

// ── Brief: the branch's goal, design and engineering chunks (see brief.mjs) ───
export { parseBrief } from './brief.mjs';
export async function readBrief(cwd) {
  const store = await branchStore(cwd);
  if (!store || NO_BRIEF_BRANCHES.includes(store.branch)) return null;
  const path = store.file('briefs', 'md'), approvedPath = store.file('briefs', 'approved.json');
  try {
    const [text, st, approval] = await Promise.all([readFile(path, 'utf8'), stat(path), readJson(approvedPath)]);
    const brief = parseBrief(text);
    return { branch: store.branch, path, approvedPath, text, mtime: st.mtimeMs, approval, status: briefStatus(brief, approval), ...brief };
  } catch { return { branch: store.branch, path, approvedPath, text: null }; }
}

// Every file changed since the fork point, plus untracked files (a file Claude just created isn't tracked
// yet, and would otherwise be missing). Paths are relative to the repo root.
export async function branchFiles(cwd) {
  const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd }))?.trim();
  const fork = top && (await forkPoint(top));
  if (!fork) return { root: top || null, files: [] };
  const [numstat, untracked] = await Promise.all([
    run('git', ['diff', '--numstat', '-z', fork], { cwd: top }),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: top }),
  ]);
  const files = [];
  // -z rows are "added\tremoved\tpath\0"; a rename is "added\tremoved\t\0old\0new\0".
  const parts = (numstat ?? '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    const path = m[3] || (i += 2, parts[i]);
    files.push({ path, added: m[1] === '-' ? 0 : +m[1], removed: m[2] === '-' ? 0 : +m[2], status: m[1] === '-' ? 'binary' : 'modified' });
  }
  const fresh = (untracked ?? '').split('\0').filter(Boolean);
  const counts = await Promise.all(fresh.map(async (f) => {
    try {
      const buf = await readFile(join(top, f));
      if (buf.includes(0)) return { added: 0, binary: true };
      const t = buf.toString('utf8');
      return { added: t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0 };
    } catch { return { added: 0 }; }
  }));
  fresh.forEach((path, i) => files.push({ path, added: counts[i].added, removed: 0, status: counts[i].binary ? 'binary' : 'new' }));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: top, files };
}

// One file's unified diff against the fork point (an untracked file shows as all added), capped in length.
export async function fileDiff(cwd, path, maxLines = 2000) {
  const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd }))?.trim();
  const fork = top && (await forkPoint(top));
  if (!fork) return [];
  let out = await run('git', ['diff', '--no-color', fork, '--', path], { cwd: top });
  // An untracked file has no diff against the fork; show it as all added. (Only untracked: a tracked file
  // with an empty diff has simply gone back to how it was.) --no-index exits 1 when the files differ,
  // which run() reads as failure, so it's run directly; it still printed the diff.
  const untracked = !out && (await run('git', ['ls-files', '--error-unmatch', '--', path], { cwd: top })) === null;
  if (untracked) out = await new Promise((resolve) => execFile('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', path],
    { cwd: top, timeout: 10_000, maxBuffer: 4 << 20 }, (err, stdout) => resolve(stdout?.toString() ?? '')));
  const lines = (out ?? '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`] : lines;
}

// ── Plan: the plan file plan mode writes (found in the transcript by TaskIndex) ─
export async function readPlan(path) {
  if (!path) return null;
  try {
    const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { path, text, mtime: st.mtimeMs };
  } catch { return null; }
}

// ── Account: who Claude is signed in as (the login record /status reads) ───────
export async function account() {
  const a = (await readJson(join(HOME, '.claude.json')))?.oauthAccount;
  return a?.emailAddress ? { email: a.emailAddress } : null;
}

// ── Usage: rate-limit windows, written by the plugin's session.measure hook ────
export async function usage() {
  const u = await readJson(join(CLAUDE, 'session-rail', 'usage.json'));
  return Array.isArray(u?.rateLimits) ? u.rateLimits : [];
}

// ── Active agents: every live Claude session on this Mac ───────────────────────
export async function sessions() {
  const dir = join(CLAUDE, 'sessions');
  let files = [];
  try { files = (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const rows = await Promise.all(files.map((f) => readJson(join(dir, f))));
  return rows
    .filter((s) => s && s.pid && alive(s.pid))
    .map((s) => ({
      pid: s.pid,
      sessionId: s.sessionId,
      name: s.name || basename(s.cwd || '') || `pid ${s.pid}`,
      cwd: s.cwd,
      repo: basename(s.cwd || ''),
      surface: s.entrypoint === 'cli' ? 'cli' : s.entrypoint?.includes('desktop') ? 'desktop' : s.entrypoint || 'other',
      status: s.status || 'unknown',
      statusSince: s.statusUpdatedAt || s.updatedAt || s.startedAt,
      updatedAt: s.updatedAt || s.startedAt,
      version: s.version,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Sessions: every session with what it's on and whether it needs the person ──
// A session is blocked when the brief gate refused an edit in the last 2 minutes, busy while Claude works,
// waiting when its turn ended in the last hour (it's the person's move), else idle.
const GATE_HOLD = 2 * 60_000, WAIT_FRESH = 60 * 60_000;
export function sessionState(s, act, now = Date.now()) {
  const rel = (p) => (p && s.cwd && p.startsWith(s.cwd + '/') ? p.slice(s.cwd.length + 1) : p ?? '');
  if (act?.gate && now - act.gate.at < GATE_HOLD) return { state: 'blocked', doing: `${act.gate.tool} ${rel(act.gate.file)}: brief not approved`, since: act.gate.at };
  const c = act?.claude;
  if (c && c.state !== 'waiting') {
    const call = act.running.find((r) => !r.agent);
    const doing = c.state === 'thinking' ? 'thinking' : call ? `${call.tool} ${rel(call.arg)}`.trim() : 'running a tool';
    return { state: 'busy', doing, since: c.since };
  }
  if (!c && s.status === 'busy') return { state: 'busy', doing: 'working', since: s.statusSince };
  const since = c?.since ?? s.statusSince;
  if (now - since < WAIT_FRESH) return { state: 'waiting', doing: 'waiting for you', since };
  return { state: 'idle', doing: 'idle', since };
}

// Every live session with its branch, brief title, tty and state. This session first, then the ones
// needing the person (blocked, waiting), then the rest; most recent first within each.
const RANK = { blocked: 0, waiting: 1, busy: 2, idle: 3 };
export async function sessionsOverview(list, currentPid) {
  const ttys = new Map(((await run('ps', ['-o', 'pid=,tty=', '-p', list.map((s) => s.pid).join(',') || '0'])) || '')
    .split('\n').map((l) => l.trim().split(/\s+/)).filter(([, t]) => t && t !== '??').map(([p, t]) => [Number(p), `/dev/${t}`]));
  const rows = await Promise.all(list.map(async (s) => {
    const [act, branch, brief] = await Promise.all([
      activity(s.sessionId),
      s.cwd ? run('git', ['branch', '--show-current'], { cwd: s.cwd }) : null,
      s.cwd ? readBrief(s.cwd) : null,
    ]);
    const b = branch?.trim() || null;
    return { ...s, ...sessionState(s, act), branch: b, title: brief?.title || b || s.name, tty: ttys.get(s.pid) ?? null, current: s.pid === currentPid };
  }));
  return rows.sort((a, b) => (b.current - a.current) || (RANK[a.state] - RANK[b.state]) || (b.since - a.since));
}

// ── New session: a worktree of the repo at the default branch, detached so /start makes the branch there ─
// It goes beside the main checkout in <repo>.worktrees/<slug>, named after the problem's first words.
export async function newWorktree(cwd, problem) {
  const common = (await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }))?.trim();
  if (!common) return { ok: false, message: 'Not a git repo' };
  const main = basename(common) === '.git' ? dirname(common) : common.replace(/\.git$/, '');
  await run('git', ['fetch', '--quiet', 'origin'], { cwd, timeout: 20_000 });
  const base = await defaultBranch(cwd);
  if (!base) return { ok: false, message: 'No main branch' };
  const slug = problem.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 4).join('-').slice(0, 40) || 'session';
  const root = join(dirname(main), `${basename(main)}.worktrees`);
  let dir = join(root, slug);
  for (let n = 2; await exists(dir); n++) dir = join(root, `${slug}-${n}`);
  const added = await run('git', ['worktree', 'add', '--detach', dir, base], { cwd, timeout: 30_000 });
  return added == null ? { ok: false, message: "Couldn't add the worktree" } : { ok: true, dir, base };
}

// ── Worktrees: every checkout of this repo with its branch, ahead/behind the default branch, and dirt ───
// Cards for the rail's Git tab. `merged`: a named branch with nothing ahead whose tip is behind the default
// branch (its work went in). The main checkout first, as git lists it; `current` is the one at cwd.
export async function worktrees(cwd) {
  const [list, top, base] = await Promise.all([
    run('git', ['worktree', 'list', '--porcelain'], { cwd }),
    run('git', ['rev-parse', '--show-toplevel'], { cwd }),
    defaultBranch(cwd),
  ]);
  if (list == null) return { ok: false, repo: null, base: null, items: [] };
  const blocks = list.split('\n\n').map((block) =>
    Object.fromEntries(block.split('\n').filter(Boolean).map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)])))
    .filter((kv) => kv.worktree);
  const entries = blocks.filter((kv) => !('bare' in kv) && !('prunable' in kv))
    .map((kv) => ({ path: kv.worktree, sha: kv.HEAD?.slice(0, 7) ?? null, branch: kv.branch?.replace(/^refs\/heads\//, '') ?? null }));
  const baseName = base?.replace(/^origin\//, '') ?? null;
  const items = await Promise.all(entries.map(async (w) => {
    const [counts, porcelain] = await Promise.all([
      base ? run('git', ['rev-list', '--left-right', '--count', `${base}...HEAD`], { cwd: w.path }) : null,
      run('git', ['status', '--porcelain'], { cwd: w.path }),
    ]);
    const [behind, ahead] = (counts ?? '').trim().split(/\s+/).map(Number);
    return {
      ...w, name: basename(w.path), current: w.path === top?.trim(),
      ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null,
      dirty: porcelain == null ? null : porcelain.split('\n').filter(Boolean).length, // null: git couldn't tell
      // nothing ahead: its tip is in the default branch (the default branch itself is just behind, not merged)
      merged: Boolean(w.branch) && w.branch !== baseName && ahead === 0 && behind > 0,
    };
  }));
  // The repo is named after the main checkout, git's first entry, even when it's bare and has no card.
  return { ok: true, repo: blocks[0] ? basename(blocks[0].worktree).replace(/\.git$/, '') : null, base: baseName, items };
}

// The session this rail belongs to: newest live CLI session in the rail's folder (or a parent/child of it).
export function currentSession(list, cwd) {
  const related = (p) => p && (p === cwd || cwd.startsWith(p + '/') || p.startsWith(cwd + '/'));
  return list.find((s) => s.surface === 'cli' && related(s.cwd)) || null;
}

// ── Where a session keeps its transcript and background task output ────────────
// Claude names a project folder after its cwd with every non-alphanumeric character as '-'.
const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export async function sessionFiles(session) {
  if (!session?.sessionId || !session.cwd) return { transcriptPath: null, tasksDir: null };
  const id = session.sessionId;
  let transcriptPath = join(CLAUDE, 'projects', slug(session.cwd), `${id}.jsonl`);
  if (!(await exists(transcriptPath))) {
    transcriptPath = null; // cwd changed since start: look the session up by id instead
    try {
      for (const d of await readdir(join(CLAUDE, 'projects'))) {
        const p = join(CLAUDE, 'projects', d, `${id}.jsonl`);
        if (await exists(p)) { transcriptPath = p; break; }
      }
    } catch {}
  }
  const project = transcriptPath ? basename(dirname(transcriptPath)) : slug(session.cwd);
  const tasksDir = `/private/tmp/claude-${process.getuid()}/${project}/${id}/tasks`;
  return { transcriptPath, tasksDir: (await exists(tasksDir)) ? tasksDir : null };
}

// The transcript records each reply's token usage but not the window size; Claude 5 models
// (and any "[1m]" model) run with a 1M window here, others 200k.
const windowFor = (model = '') => (/\[1m\]|^claude-[a-z]+-5(-|$)/.test(model) ? 1_000_000 : 200_000);
const MODEL_NAMES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
const prettyModel = (id = '') => {
  const m = id.match(/claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${MODEL_NAMES[m[1]] ?? m[1]} ${m[2]}.${m[3]}` : id || null;
};

// ── Connectors (MCP servers) ───────────────────────────────────────────────────
export async function connectors() {
  const out = await run('claude', ['mcp', 'list'], { timeout: 20_000 });
  if (out == null) return { ok: false, items: [] };
  const items = out.split('\n')
    .map((l) => l.match(/^(.+?):\s.*-\s(✔|✗|⚠)\s*(.*)$/))
    .filter(Boolean)
    .map(([, name, mark, state]) => ({ name: name.replace(/^claude\.ai\s+/, ''), ok: mark === '✔', state: state.trim() }));
  return { ok: true, items, connected: items.filter((i) => i.ok).length };
}

// ── Changes: your open PRs in this repo ────────────────────────────────────────
export async function prs(cwd, limit = 15) {
  const out = await run('gh', ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', String(limit),
    '--json', 'number,title,state,isDraft,url,headRefName,updatedAt,statusCheckRollup'], { cwd, timeout: 15_000 });
  if (out == null) return { ok: false, items: [] };
  try {
    return { ok: true, items: JSON.parse(out).map(({ statusCheckRollup, ...p }) => ({ ...p, checks: (statusCheckRollup ?? []).map(check) })) };
  } catch { return { ok: false, items: [] }; }
}

// One entry of a PR's statusCheckRollup (a CheckRun or a commit StatusContext) as { name, state, url },
// state pass, fail or pending.
const PASS = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
export function check(c) {
  if (c?.__typename === 'StatusContext' || c?.context != null)
    return { name: String(c.context ?? 'status'), url: c.targetUrl || null,
      state: c.state === 'SUCCESS' ? 'pass' : c.state === 'FAILURE' || c.state === 'ERROR' ? 'fail' : 'pending' };
  const state = c?.status && c.status !== 'COMPLETED' ? 'pending' : PASS.includes(c?.conclusion) ? 'pass' : c?.conclusion ? 'fail' : 'pending';
  return { name: String(c?.name ?? c?.workflowName ?? 'check'), url: c?.detailsUrl || null, state };
}

// ── Todo: open issues of this repo in a Todo column on a GitHub project linked to it ─
const TODO_QUERY = `query($o: String!, $r: String!) { repository(owner: $o, name: $r) { projectsV2(first: 5) { nodes {
  items(first: 100) { nodes { status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    content { ... on Issue { number title url state body repository { nameWithOwner } } } } } } } } }`;
const firstProse = (body) => ((body ?? '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '')
  .replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\*\*|__|`/g, '');
export async function todos(cwd) {
  const repo = (await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd, timeout: 15_000 }))?.trim();
  if (!repo) return [];
  const [o, r] = repo.split('/');
  const out = await run('gh', ['api', 'graphql', '-f', `query=${TODO_QUERY}`, '-f', `o=${o}`, '-f', `r=${r}`], { cwd, timeout: 15_000 });
  const seen = new Map();
  try {
    for (const p of JSON.parse(out).data.repository.projectsV2.nodes) for (const it of p.items.nodes) {
      const c = it.content;
      if (it.status?.name !== 'Todo' || c?.state !== 'OPEN' || c.repository?.nameWithOwner !== repo || seen.has(c.number)) continue;
      seen.set(c.number, { number: c.number, title: c.title, url: c.url, summary: firstProse(c.body) });
    }
  } catch {}
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

// ── Recent work: the last merged PRs, and the default branch's latest commits ─
// Merge commits are left out of the commits: the PRs already stand for them.
export async function recentWork(cwd, { prs = 5, commits = 8 } = {}) {
  const base = (await defaultBranch(cwd)) ?? 'HEAD';
  const [pr, log] = await Promise.all([
    run('gh', ['pr', 'list', '--state', 'merged', '--limit', String(prs), '--json', 'number,title,mergedAt,body'], { cwd, timeout: 15_000 }),
    run('git', ['log', '-n', String(commits), '--no-merges', '--format=%h%x1f%s%x1f%ct', base], { cwd }),
  ]);
  let items = [];
  try {
    items = JSON.parse(pr ?? '[]').map((p) => ({
      number: p.number, title: p.title, mergedAt: Date.parse(p.mergedAt),
      summary: firstProse(p.body), // the body's first line of prose: no headings, no blank lines
    }));
  } catch {}
  const list = (log ?? '').split('\n').filter(Boolean).map((l) => {
    const [hash, subject, at] = l.split('\x1f');
    return { hash, subject, at: +at * 1000 };
  });
  return { base: base.replace(/^origin\//, ''), prs: items, commits: list };
}

// ── Background tasks: indexed incrementally from the session transcript ───────
const KEYWORDS = ['run_in_background', 'backgroundTaskId', 'agentId', 'task-notification', '"name":"Agent"', '"name":"Task"', '"usage"', '/.claude/plans/'];
const PLANS = join(CLAUDE, 'plans') + '/';

export class TaskIndex {
  constructor() { this.path = null; this.offset = 0; this.partial = ''; this.reset(); }
  reset() { this.calls = new Map(); this.tasks = new Map(); this.done = new Map(); this.usage = null; this.model = null; this.planPath = null; }

  // Context from the latest main-thread reply: tokens in the prompt = input + cache read + cache write.
  context() {
    if (!this.usage) return null;
    const u = this.usage;
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const size = windowFor(this.model);
    return { model: prettyModel(this.model), contextTokens: tokens, contextSize: size,
      contextPct: Math.min(100, Math.round((tokens / size) * 100)) };
  }

  async update(transcriptPath) {
    if (!transcriptPath) return;
    if (transcriptPath !== this.path) { this.path = transcriptPath; this.offset = 0; this.partial = ''; this.reset(); }
    let fh;
    try {
      fh = await open(transcriptPath, 'r');
      const { size } = await fh.stat();
      if (size < this.offset) { this.offset = 0; this.partial = ''; this.reset(); }
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      await fh.read(buf, 0, buf.length, this.offset);
      this.offset = size;
      const lines = (this.partial + buf.toString('utf8')).split('\n');
      this.partial = lines.pop();
      for (const line of lines) if (KEYWORDS.some((k) => line.includes(k))) this.ingest(line);
    } catch { /* transcript missing or unreadable: keep what we have */ } finally { await fh?.close(); }
  }

  ingest(line) {
    let e; try { e = JSON.parse(line); } catch { return; }
    if (e.type === 'assistant' && !e.isSidechain && e.message?.usage && e.message.model !== '<synthetic>') {
      this.usage = e.message.usage;
      this.model = e.message.model;
    }
    for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (c.type === 'tool_use' && c.name === 'Bash' && c.input?.run_in_background)
        this.calls.set(c.id, { kind: 'shell', label: c.input.description || c.input.command?.slice(0, 60) || 'shell' });
      if (c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task'))
        this.calls.set(c.id, { kind: 'agent', label: c.input?.description || 'subagent', agentType: c.input?.subagent_type });
      // The plan file plan mode writes; watching the writes shows the plan while it's still being drafted.
      if (c.type === 'tool_use' && !e.isSidechain && (c.name === 'Write' || c.name === 'Edit') && c.input?.file_path?.startsWith(PLANS))
        this.planPath = c.input.file_path;
    }
    const r = e.toolUseResult;
    if (!e.isSidechain && typeof r?.filePath === 'string' && r.filePath.startsWith(PLANS) && 'plan' in r) this.planPath = r.filePath;
    const toolUseId = e.message?.content?.find?.((c) => c.tool_use_id)?.tool_use_id;
    if (r && typeof r === 'object' && toolUseId) {
      const id = r.backgroundTaskId || r.agentId;
      if (id) {
        this.tasks.set(id, { id, toolUseId, startedAt: Date.parse(e.timestamp) || null });
        if (r.agentId && r.status === 'completed') this.done.set(id, 'completed');
      }
    }
    const text = typeof e.attachment?.prompt === 'string' ? e.attachment.prompt : line;
    for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g)) this.done.set(m[1], m[2]);
  }

  async list(tasksDir) {
    let files = [];
    try { files = (await readdir(tasksDir)).filter((f) => f.endsWith('.output')); } catch { files = []; }
    const running = [];
    const done = [];
    for (const f of files) {
      const id = f.replace(/\.output$/, '');
      const t = this.tasks.get(id);
      if (!t) continue; // foreground commands leave short-lived files; ignore anything not launched in the background
      const call = this.calls.get(t.toolUseId) || { kind: 'shell', label: id };
      let state = this.done.get(id);
      if (!state && call.kind === 'shell') state = await exitMarker(join(tasksDir, f));
      let startedAt = t.startedAt;
      if (!startedAt) { try { startedAt = (await lstat(join(tasksDir, f))).birthtimeMs; } catch {} }
      const row = { id, kind: call.kind, label: call.label, agentType: call.agentType || null, startedAt,
        file: join(tasksDir, f), state: state || 'running' };
      (state ? done : running).push(row);
    }
    running.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    done.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return { running, finished: done.length, done };
  }
}

async function exitMarker(path) {
  let fh;
  try {
    fh = await open(path, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, 200);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const m = buf.toString('utf8').match(/\[(exited with code (\d+)|killed)\]\s*$/);
    return m ? (m[2] === '0' ? 'completed' : m[2] ? 'failed' : 'killed') : null;
  } catch { return null; } finally { await fh?.close(); }
}

export const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

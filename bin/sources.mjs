// Data sources for the session rail. Every exported function resolves to plain JSON and never throws.
import { execFile } from 'node:child_process';
import { readFile, readdir, lstat, stat, open } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
  const [branch, porcelain] = top
    ? await Promise.all([
        run('git', ['branch', '--show-current'], { cwd }),
        run('git', ['status', '--porcelain'], { cwd }),
      ])
    : [null, null];
  const root = top || cwd;
  const diff = top ? await branchDiff(cwd) : null;
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
  };
}

// The default branch: origin/HEAD, else the first of main/master that exists (remote, then local).
async function defaultBranch(cwd) {
  const head = (await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd }))?.trim();
  for (const base of new Set([head, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)))
    if (await run('git', ['rev-parse', '--verify', '--quiet', base], { cwd })) return base;
  return null;
}

// The commit this branch forked from the default branch. On the default branch itself that's HEAD, so
// diffs against it show just the uncommitted changes.
export async function forkPoint(cwd) {
  const base = await defaultBranch(cwd);
  return base ? (await run('git', ['merge-base', 'HEAD', base], { cwd }))?.trim() || null : null;
}

// Lines added/removed on this branch: the working tree against the fork point, so committed and
// uncommitted work both count (untracked files don't).
async function branchDiff(cwd) {
  const fork = await forkPoint(cwd);
  if (!fork) return null;
  const stat = (await run('git', ['diff', '--shortstat', fork], { cwd })) ?? '';
  return { added: +(stat.match(/(\d+) insertion/)?.[1] ?? 0), removed: +(stat.match(/(\d+) deletion/)?.[1] ?? 0) };
}

// ── Branch changes, file by file (the review panel's Diff tab) ─────────────────
// Where the desk keeps this branch's code reviews: inside the shared git dir (so worktrees share it and it is
// never committed), one file per branch. null outside a repo. The desk polls this, so git is asked for the
// repo's dirs once and the branch is read from HEAD after that. A rebase reviews into the branch being
// rebased; any other detached HEAD shares one "detached" file rather than starting a new one per commit.
const gitDirs = new Map();
export async function reviewsPath(cwd) {
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
  return join(common, 'session-rail', 'reviews', `${encodeURIComponent(branch)}.json`); // keeps feature/x and feature_x apart
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
    '--json', 'number,title,state,isDraft,url,headRefName,updatedAt'], { cwd, timeout: 15_000 });
  if (out == null) return { ok: false, items: [] };
  try { return { ok: true, items: JSON.parse(out) }; } catch { return { ok: false, items: [] }; }
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
      // The body's first line of prose: no headings, no blank lines.
      summary: ((p.body ?? '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '')
        .replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\*\*|__|`/g, ''),
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

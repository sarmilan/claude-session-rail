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

// Lines added/removed on this branch: the working tree against the point it forked from the default branch,
// so committed and uncommitted work both count (untracked files don't). On the default branch itself that
// fork point is HEAD, leaving just the uncommitted changes.
async function branchDiff(cwd) {
  const head = (await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd }))?.trim();
  for (const base of new Set([head, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean))) {
    const fork = (await run('git', ['merge-base', 'HEAD', base], { cwd }))?.trim();
    if (!fork) continue;
    const stat = (await run('git', ['diff', '--shortstat', fork], { cwd })) ?? '';
    return { added: +(stat.match(/(\d+) insertion/)?.[1] ?? 0), removed: +(stat.match(/(\d+) deletion/)?.[1] ?? 0) };
  }
  return null;
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

// ── Background tasks: indexed incrementally from the session transcript ───────
const KEYWORDS = ['run_in_background', 'backgroundTaskId', 'agentId', 'task-notification', '"name":"Agent"', '"name":"Task"', '"usage"'];

export class TaskIndex {
  constructor() { this.path = null; this.offset = 0; this.partial = ''; this.reset(); }
  reset() { this.calls = new Map(); this.tasks = new Map(); this.done = new Map(); this.usage = null; this.model = null; }

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
    }
    const r = e.toolUseResult;
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

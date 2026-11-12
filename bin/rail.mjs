#!/usr/bin/env node
// Session rail for iTerm: a Claude-desktop-style side panel.
//   node rail.mjs                 interactive panel (run it in a narrow iTerm pane)
//   node rail.mjs --json          print the collected state once
//   node rail.mjs --frame [W H]   print one rendered frame (for testing, no TTY needed)
//   --tab session|git             open on that tab (otherwise the session's saved tab, or Session)
//   --cwd DIR                     use DIR instead of the current folder
import { execFile, spawn } from 'node:child_process';
import { openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import * as src from './sources.mjs';
import { ESC, fg, dim, bold, C, charWidth, width, trunc, wrap, clean } from './term.mjs';
import { createMascot, creatureNames, stageFor, progressFor } from './mascot.mjs';
import { isApproved } from './brief.mjs';
import * as fontsize from './fontsize.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
// A numeric flag's value, or null when it's missing or not a number.
const numFlag = (name) => { const v = flag(name); return v?.trim() && Number.isFinite(+v) ? +v : null; };
const cwd = flag('--cwd') || process.cwd();
const pinnedPid = Number(flag('--pid')) || null; // the Claude process this rail belongs to
const taskIndex = new src.TaskIndex();

// ── Data ───────────────────────────────────────────────────────────────────────
const data = { env: null, brief: null, account: null, usage: [], agents: [], overview: null, current: null, stats: null, connectors: null, prs: null,
  worktrees: null, activity: null,
  tasks: { running: [], finished: 0, done: [] } };

const loaders = {
  async fast() {
    data.agents = await src.sessions();
    data.current = (pinnedPid && data.agents.find((a) => a.pid === pinnedPid)) || src.currentSession(data.agents, cwd);
    restoreTab(data.current?.sessionId);
    const files = await src.sessionFiles(data.current);
    await taskIndex.update(files.transcriptPath);
    data.stats = taskIndex.context();
    data.tasks = files.tasksDir ? await taskIndex.list(files.tasksDir) : { running: [], finished: 0, done: [] };
    data.activity = await src.activity(data.current?.sessionId);
  },
  async env() {
    const [env, brief] = await Promise.all([src.environment(cwd), src.readBrief(cwd)]);
    data.env = env; data.brief = brief?.status ? { status: brief.status, chunks: brief.chunks } : null; // what the pet needs
  },
  async sessions() { data.overview = await src.sessionsOverview(data.agents, data.current?.pid); },
  async account() { [data.account, data.usage] = await Promise.all([src.account(), src.usage()]); },
  // The PRs and worktree cards only show on Git: off it, load them once and leave them (setTab refreshes on arrival).
  async prs() { if (ui.tab !== 'git' && data.prs) return; data.prs = await src.prs(cwd); },
  async worktrees() { if (ui.tab !== 'git' && data.worktrees) return; data.worktrees = { ...(await src.worktrees(cwd)), at: Date.now() }; },
  async connectors() { data.connectors = await src.connectors(); },
};

export async function collect() {
  await loaders.fast(); // Sessions builds on its list of sessions
  await Promise.all(Object.entries(loaders).filter(([k]) => k !== 'fast').map(([, f]) => f()));
  return { cwd, ...data };
}

// ── Text helpers ──────────────────────────────────────────────────────────────
const ago = (ms) => {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const tokens = (n) => (n == null ? '?' : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const resetAt = (sec) => {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short' });
};
const bar = (pct, n = 8) => {
  const full = Math.round(((pct ?? 0) / 100) * n);
  const color = pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.blue;
  return fg(color, '▰'.repeat(full)) + dim('▱'.repeat(n - full));
};

// ── Actions ────────────────────────────────────────────────────────────────────
const TABS = ['session', 'git'];
const TAB_LABELS = { session: 'Session', git: 'Git' };
// Each rail remembers its own tab, in <session id>.rail.json beside the session's activity file, restored once
// the session is known. --frame (and --tab) open where they say, Session by default.
const isFrame = args.includes('--frame');
const startTab = flag('--tab');
const railFile = (sid) => join(homedir(), '.claude', 'session-rail', 'activity', `${sid}.rail.json`);
let tabRestored = isFrame || TABS.includes(startTab), tabSwitched = false;
const showTab = (t) => { ui.tab = t; ui.scroll = 0; ui.sel = null; }; // each tab starts at its top
const saveTab = (sid) => {
  if (!isFrame && sid) try { mkdirSync(dirname(railFile(sid)), { recursive: true }); writeFileSync(railFile(sid), JSON.stringify({ tab: ui.tab })); } catch {}
};
const restoreTab = (sid) => {
  if (tabRestored || !sid) return;
  tabRestored = true;
  if (tabSwitched) return saveTab(sid); // a switch before the session was known wins over the saved tab, and is kept
  try { const t = JSON.parse(readFileSync(railFile(sid), 'utf8')).tab; if (TABS.includes(t) && t !== ui.tab) showTab(t); } catch {}
};
const ui = { sel: null, open: { environment: true, context: false, connectors: false, more: false, settings: false }, scroll: 0, tick: 0,
  overlay: null, toast: null, input: null, tab: TABS.includes(startTab) ? startTab : 'session' };
// Switch tabs; --frame doesn't touch the saved one.
const setTab = (t) => {
  if (t === ui.tab) return;
  tabSwitched = true;
  showTab(t);
  saveTab(data.current?.sessionId);
  // The worktree cards and PR checks refresh every 60s, only on Git; arriving on Git brings them up to date (through the runner, so it
  // can't overlap a scheduled load), unless they loaded in the last 10s, so flipping tabs doesn't call GitHub each time.
  if (t === 'git' && !isFrame && Date.now() - (data.worktrees?.at ?? 0) > 10_000) { runners.worktrees(); runners.prs(); }
};
const stepTab = (d) => setTab(TABS[(TABS.indexOf(ui.tab) + TABS.length + d) % TABS.length]);
const otherTab = () => stepTab(1);
// The tab under screen column x (1-based; column 1 is the frame's left pad, tabs are two spaces apart), else null.
const tabAt = (x) => {
  let from = 2;
  for (const t of TABS) { const to = from + TAB_LABELS[t].length; if (x >= from && x < to) return t; from = to + 2; }
  return null;
};
// Inline images only in a live iTerm2 pane; --frame output (and other terminals) get text octants.
const iterm = process.env.TERM_PROGRAM === 'iTerm.app' || process.env.LC_TERMINAL === 'iTerm2';
// The chosen creature is remembered across rails; `c` cycles through them.
const MASCOT_FILE = join(homedir(), '.claude', 'session-rail', 'mascot.json');
const savedCreature = (() => {
  // By the name's last word, so a pick saved under an old name ("Claudey the snail", "Turtle") still loads.
  try { return Math.max(0, creatureNames.indexOf(String(JSON.parse(readFileSync(MASCOT_FILE, 'utf8')).creature).split(' ').pop().toLowerCase())); } catch { return 0; }
})();
const mascot = createMascot({ images: iterm && !args.includes('--frame') && Boolean(process.stdout.isTTY), creature: savedCreature });
const showMascot = (W, H) => H >= 24 && W >= mascot.width + 4;
const saveCreature = (name) => {
  try { mkdirSync(dirname(MASCOT_FILE), { recursive: true }); writeFileSync(MASCOT_FILE, JSON.stringify({ creature: name })); } catch {}
};
const nextCreature = (d = 1) => saveCreature(mascot.next(d));
// The pet grows with the branch's brief (--pet-stage N pins a stage for --frame).
const stageFlag = flag('--pet-stage');
const pinned = stageFlag != null && /^[0-3]$/.test(stageFlag) ? +stageFlag : null;
const petStage = () => pinned ?? stageFor(data.brief);
// And walks the branch's road, left to right as chunks get Done (--pet-progress F pins it for --frame).
const progressFlag = numFlag('--pet-progress');
const petProgress = () => progressFlag ?? progressFor(data.brief);
// A visitor for each running subagent: the main thread's Agent calls in flight, plus background subagents,
// whose Agent call returns at once but whose task keeps running (--visitors N pins it for --frame).
const visitorsFlag = numFlag('--visitors');
const subagents = () => visitorsFlag ?? ((data.activity?.running ?? []).filter((c) => (c.tool === 'Agent' || c.tool === 'Task') && !c.agent).length
  + data.tasks.running.filter((t) => t.kind === 'agent').length);
// A little one trails behind for each background shell task (background subagents are visitors).
const companionsFlag = numFlag('--companions');
const backgroundTasks = () => companionsFlag ?? data.tasks.running.filter((t) => t.kind === 'shell').length;
// It stands still with a ? while the brief gate holds edits (--held for --frame); any approval lets go (the gate
// keeps allowing edits once a brief is approved, even after it changes).
const petHeld = () => args.includes('--held') || (src.gateHeld(data.activity) && !isApproved(data.brief?.status));
// It flinches once at each new failed tool call; failures from before the rail started don't count, nor
// the gate's refusals (they count as failed calls), which show the ? instead.
let lastFailure = Date.now();
const checkFailure = () => {
  const at = data.activity?.recent?.find((r) => !r.ok)?.at ?? 0;
  if (at > lastFailure && !petHeld()) mascot.flinch();
  lastFailure = Math.max(lastFailure, at);
};
const feedPet = (W) => {
  mascot.setStage(petStage()); mascot.setProgress(petProgress()); mascot.setVisitors(subagents(), W);
  mascot.setCompanions(backgroundTasks()); mascot.setHeld(petHeld()); checkFailure();
};
const claudeBusy = () => data.tasks.running.length > 0 || data.current?.status === 'busy';

const toast = (text) => { ui.toast = { text, until: Date.now() + 2500 }; };
const launch = (cmd, argv, ok, fail = `Couldn't run ${cmd}`) =>
  execFile(cmd, argv, { cwd, timeout: 15_000 }, (err) => { toast(err ? fail : ok); draw(); });
const copy = (text, what) => {
  const p = spawn('pbcopy');
  p.on('error', () => { toast('Copy failed'); draw(); });
  p.on('close', (code) => { toast(code === 0 ? `Copied ${what}` : 'Copy failed'); draw(); });
  p.stdin.end(text);
};
const menu = (title, options, info = []) => {
  ui.overlay = { kind: 'menu', title, info, options, back: ui.sel };
  ui.sel = 'opt:0';
};
const viewLog = (task) => { ui.overlay = { kind: 'log', task, scroll: 0, back: ui.overlay?.back ?? ui.sel }; };
const closeOverlay = () => { if (ui.overlay) ui.sel = ui.overlay.back; ui.overlay = null; };

const prMenu = (p) => menu(`#${p.number} ${clean(p.title)}`, [
  { label: 'Open in browser', key: 'o', run: () => launch('open', [p.url], `Opened #${p.number}`) },
  { label: 'Copy link', key: 'y', run: () => copy(p.url, `link to #${p.number}`) },
  { label: 'Copy branch name', run: () => copy(p.headRefName, 'branch name') },
], [`${p.headRefName}${p.isDraft ? ' · draft' : ''} · updated ${ago(Date.parse(p.updatedAt))} ago`]);

const repoMenu = (env) => menu(env.repo, [
  { label: 'Open in Finder', run: () => launch('open', [env.root], 'Opened in Finder') },
  { label: 'Open in VS Code', run: () => launch('code', [env.root], 'Opened in VS Code', 'VS Code `code` command not found') },
  { label: 'Copy path', run: () => copy(env.root, 'path') },
], [src.tildify(env.root)]);

const branchMenu = (env) => menu(env.branch, [
  { label: 'Copy branch name', run: () => copy(env.branch, 'branch name') },
  { label: 'Open branch on GitHub', run: () => launch('gh', ['browse', '--branch', env.branch], 'Opened on GitHub', 'GitHub unavailable') },
], [`${env.dirty} uncommitted file${env.dirty === 1 ? '' : 's'}`]);

// pane.mjs prints one JSON line and always exits 0; hand its state to cb.
const PANE = new URL('./pane.mjs', import.meta.url).pathname;
const pane = (argv, cb) => execFile(process.execPath, [PANE, ...argv], { timeout: 15_000 }, (err, stdout) => {
  let state = 'error'; try { state = JSON.parse(stdout).state; } catch {}
  cb(state); draw();
});
// Bring a session's iTerm window (and tab) to the front; one without a terminal (the Claude app) gets its menu.
const goTo = (s) => {
  if (s.current) return toast('This is the current session');
  if (!s.tty) return agentMenu(s);
  pane(['focus', s.tty], (state) => { if (state !== 'focused') toast(state === 'not-found' ? 'Not an iTerm tab' : "Couldn't switch"); });
};

// + new: the problem typed on the bottom line becomes a worktree and a new window running claude "/start <problem>".
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const startSession = async (problem) => {
  toast('Adding a worktree…'); draw();
  const wt = await src.newWorktree(cwd, problem);
  if (!wt.ok) { toast(wt.message); return draw(); }
  const command = `cd ${sq(wt.dir)} && SESSION_RAIL_STARTED=1 claude ${sq(`/start ${problem}`)}`;
  openWindow(command, `Started in ${src.tildify(wt.dir)}`);
};
// A new iTerm window beside this session's, running command.
const openWindow = (command, ok) => pane(['window', data.overview?.find((s) => s.current)?.tty ?? 'none', command],
  (state) => toast(state === 'opened' ? ok : "Couldn't open a window"));
// A worktree card's menu: its session (or a new window running claude there), its PR and failing check, its branch.
const prFor = (branch) => (branch && data.prs?.ok ? data.prs.items.find((p) => p.headRefName === branch) : null);
const failing = (p) => p?.checks.find((c) => c.state === 'fail' && c.url);
const worktreeMenu = (w) => {
  // A session belongs to the deepest worktree holding its cwd (a worktree can sit inside another's folder).
  const inside = (dir, p) => dir === p || dir?.startsWith(p + '/');
  const owner = (dir) => (data.worktrees?.items ?? []).filter((x) => inside(dir, x.path)).sort((a, b) => b.path.length - a.path.length)[0]?.path;
  const s = data.overview?.find((o) => owner(o.cwd) === w.path);
  const p = prFor(w.branch), bad = failing(p), name = clean(w.name);
  menu(name, [
    s ? { label: s.current ? 'This session' : 'Go to session', run: () => goTo(s) }
      : { label: 'Open claude here', run: () => openWindow(`cd ${sq(w.path)} && claude`, `Opened claude in ${name}`) },
    ...(p ? [{ label: `Open PR #${p.number}`, key: 'o', run: () => launch('open', [p.url], `Opened #${p.number}`) }] : []),
    ...(bad ? [{ label: `Open failing check: ${clean(bad.name)}`, run: () => launch('open', [bad.url], 'Opened the check') }] : []),
    ...(w.branch ? [{ label: 'Copy branch name', key: 'y', run: () => copy(w.branch, 'branch name') }] : []),
  ], [clean(src.tildify(w.path)), clean(w.branch ?? `detached at ${w.sha}`)]);
};

const typeKey = (k) => {
  if (k === '\x1b') { ui.input = null; return; }
  if (k === '\r') {
    const problem = ui.input.text.trim();
    ui.input = null;
    if (problem) startSession(problem);
    return;
  }
  if (k.startsWith('\x1b')) return; // arrows and other escape sequences
  // Keys can arrive several to a read (fast typing, a paste): backspaces apply in order, a pasted newline is a space.
  for (const ch of k) {
    if (ch === '\x7f' || ch === '\b') ui.input.text = [...ui.input.text].slice(0, -1).join('');
    else ui.input.text += ch < ' ' ? ' ' : ch;
  }
};

const agentMenu = (a) => {
  const info = [`${a.status} for ${ago(a.statusSince)} · ${a.surface === 'desktop' ? 'Claude app' : 'terminal'}`,
    src.tildify(a.cwd), `v${a.version} · pid ${a.pid}`];
  const resume = `cd ${JSON.stringify(a.cwd)} && claude --resume ${a.sessionId}`;
  menu(a.name, [
    ...(a.surface === 'desktop' ? [{ label: 'Open Claude app', run: () => launch('open', ['-a', 'Claude'], 'Opened Claude') }]
      : [{ label: 'Copy resume command', run: () => copy(resume, 'resume command') }]),
    { label: 'Copy folder path', run: () => copy(a.cwd, 'folder path') },
    { label: 'Copy session ID', run: () => copy(a.sessionId, 'session ID') },
  ], info);
};

// Font size for all three panes. `font.size` is what's on screen (null until known), `font.base` the profile's own size.
const font = { size: fontsize.saved(), base: null, busy: false };
const fontInfo = () => [`Claude, desk and rail · ${font.size ? `${font.size}pt` : 'profile size'}`];
const setFont = async (size) => {
  if (font.busy || !size) return;
  font.busy = true; toast(`Font size ${size}pt…`); draw();
  const r = await fontsize.apply(pinnedPid, size);
  font.busy = false;
  if (r.ok) font.size = r.size;
  toast(r.ok ? `Font size ${r.size}pt` : r.message);
  if (ui.overlay?.kind === 'menu' && ui.overlay.font) ui.overlay.info = fontInfo();
  draw();
};
const stepFont = (d) => () => { const now = font.size ?? font.base; if (now) setFont(now + d); };
const fontMenu = () => {
  menu('Font size', [
    { label: 'Larger', key: '+', keep: true, run: stepFont(1) },
    { label: 'Smaller', key: '-', keep: true, run: stepFont(-1) },
    { label: `Reset${font.base ? ` to ${font.base}pt` : ''}`, key: '0', keep: true, run: () => setFont(font.base) },
  ], fontInfo());
  ui.overlay.font = true;
};

// Auto-compact (hooks/compact.ts reads the same file): on unless settings.json says autoCompact: false.
const SETTINGS_FILE = join(homedir(), '.claude', 'session-rail', 'settings.json');
const readSettings = () => { try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) ?? {}; } catch { return {}; } };
let autoCompact = readSettings().autoCompact !== false;
const toggleAutoCompact = () => {
  autoCompact = !autoCompact;
  try {
    mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), autoCompact }, null, 2));
    toast(autoCompact ? 'Auto-compact on: after each merged branch' : 'Auto-compact off');
  } catch { autoCompact = !autoCompact; toast("Couldn't save the setting"); }
};

const petMenu = () => menu('Pet', creatureNames.map((name, i) => ({
  label: name, hint: name === mascot.state.creature ? '✓' : '', run: () => saveCreature(mascot.pick(i)),
})));

const finishedMenu = () => menu(`${data.tasks.finished} finished`, data.tasks.done.map((t) => ({
  label: `${t.state === 'completed' ? '✔' : '✗'} ${t.label}`, hint: ago(t.startedAt), keep: true, run: () => viewLog(t),
})));

// Last ~64KB of a task's output, as plain lines. Subagent transcripts are summarised.
function readTail(file, bytes = 65536) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
function taskLines(task) {
  const raw = readTail(task.file, task.kind === 'agent' ? 262144 : 65536);
  if (raw == null) return ['(output not available)'];
  if (task.kind !== 'agent') return raw.split('\n').map(clean);
  const out = [];
  for (const l of raw.split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.message?.role !== 'assistant' || !Array.isArray(e.message.content)) continue;
    for (const c of e.message.content) {
      if (c.type === 'text' && c.text.trim()) out.push(...c.text.split('\n').map(clean), '');
      if (c.type === 'tool_use') out.push(`→ ${c.name} ${clean(String(c.input?.description || c.input?.command || c.input?.url || c.input?.file_path || c.input?.pattern || '')).slice(0, 200)}`);
    }
  }
  return out.length ? out : ['(no output yet)'];
}

// ── Main view ──────────────────────────────────────────────────────────────────
function buildMain(W) {
  const inner = W - 2;
  const rows = [];
  const items = [];
  const line = (text = '', id) => rows.push({ text, id });
  const pair = (left, right = '', id, { leftStyle = (s) => s, rightStyle = (s) => s } = {}) => {
    const rw = width(right);
    const l = trunc(left, inner - (rw ? rw + 1 : 0));
    const gap = Math.max(rw ? 1 : 0, inner - width(l) - rw);
    line(leftStyle(l) + ' '.repeat(gap) + rightStyle(right), id);
  };
  const item = (id, activate) => { items.push({ id, activate }); return id; };
  const rule = () => line(dim('─'.repeat(inner)));
  const heading = (t) => line(bold(t));
  const caret = (open) => (open ? '▾' : '▸');

  const env = data.env;

  // Git: worktree cards, this branch's commits, its PR's checks, then the open pull requests.
  // `spread` lays out pieces already truncated to fit: styled left, styled right, padded between.
  const spread = (left, right = '', id) => line(left + ' '.repeat(Math.max(right ? 1 : 0, inner - width(left) - width(right))) + right, id);
  const CHECK = { pass: [C.green, '✓'], fail: [C.red, '✗'], pending: [C.yellow, '◌'] };
  const badge = (p) => {
    if (!p) return '';
    const states = p.checks.map((c) => c.state);
    const st = states.includes('fail') ? 'fail' : states.includes('pending') ? 'pending' : states.length ? 'pass' : null;
    return `#${p.number}` + (st ? ' ' + fg(CHECK[st][0], CHECK[st][1]) : '');
  };
  const gitTab = () => {
    const wt = data.worktrees;
    // Header: the repo, its default branch, and how fresh the cards are.
    const repo = trunc(clean(wt?.repo ?? env?.repo ?? '…'), inner - 6);
    const baseName = wt?.base ? trunc(clean(wt.base), inner - 6 - width(repo) - 3) : '';
    spread(repo + (baseName ? ' · ' + dim(baseName) : ''), wt?.at ? dim(`↻ ${ago(wt.at)}`) : '');
    rule();

    // Worktrees: this one first, then git's order.
    const cards = [...(wt?.items ?? [])].sort((a, b) => b.current - a.current);
    heading(`Worktrees ${dim(wt ? String(cards.length) : '…')}`);
    if (wt && !wt.ok) line(dim('Not a git repo'));
    for (const w of cards) {
      const id = item(`wt:${w.path}`, () => worktreeMenu(w));
      const where = clean(w.branch ?? `detached ${w.sha}`);
      const right = trunc(where, Math.max(8, Math.floor(inner / 2)));
      const name = trunc(clean(w.name), inner - 4 - width(right) - 1);
      spread(`${w.current ? fg(C.accent, '▸ ●') : dim('  ○')} ${w.current ? bold(name) : name}`, dim(right), id);
      const p = prFor(w.branch);
      const sync = w.merged ? fg(C.green, '✓ merged')
        : w.ahead == null ? '' : !w.ahead && !w.behind ? 'up to date'
        : [w.ahead && fg(C.green, `↑${w.ahead}`), w.behind && fg(C.yellow, `↓${w.behind}`)].filter(Boolean).join(' ');
      // This worktree's dirt from the environment, which refreshes every 5s rather than every minute.
      const dirty = w.current && env?.isGit ? env.dirty : w.dirty;
      const dirt = dirty == null ? fg(C.red, 'missing') : dirty ? `${dirty} changed` : 'clean';
      const parts = [sync, dirt, badge(p)].filter(Boolean).join(dim(' · '));
      spread(`    ${width(parts) > inner - 4 ? dim(trunc(clean(parts), inner - 4)) : parts}`, '', id);
    }
    rule();

    // This branch: uncommitted work, its commits newest first, and the default-branch commit it forked from.
    if (env?.isGit) {
      const diff = env.added || env.removed ? `${fg(C.green, `+${env.added}`)} ${fg(C.red, `−${env.removed}`)}` : '';
      const label = trunc(clean(env.branch ?? '(detached)'), inner - 12 - (diff ? width(diff) + 1 : 0));
      spread(`${bold('This branch')} ${dim(label)}`, diff, env.branch ? item('branch', () => branchMenu(env)) : undefined);
      if (env.dirty) line(fg(C.yellow, '◌') + dim(` ${env.dirty} uncommitted`));
      for (const c of env.commits ?? []) {
        const age = dim(ago(c.at)), tag = c.fork && env.base ? `  ${fg(C.blue, trunc(clean(env.base), Math.floor(inner / 3)))}` : '';
        const subject = trunc(clean(c.subject), inner - 2 - width(c.sha) - 1 - width(tag) - width(age) - 1);
        if (c.fork && env.moreCommits) line(dim(`┆ ${env.moreCommits} more`));
        spread(`${c.fork ? fg(C.blue, '◆') : fg(C.accent, '●')} ${dim(c.sha)} ${subject}${tag}`, age);
      }
      rule();
    }

    // This branch's PR and its checks, failing first; Enter opens a check's run.
    const mine = prFor(env?.branch);
    if (mine) {
      heading(`PR #${mine.number} ${dim(`· ${mine.isDraft ? 'draft' : 'open'}`)}`);
      const order = { fail: 0, pending: 1, pass: 2 };
      const checks = [...mine.checks].sort((a, b) => order[a.state] - order[b.state]);
      if (!checks.length) line(dim('No checks'));
      const seen = {};
      checks.forEach((c) => {
        const [color, mark] = CHECK[c.state];
        const key = `${c.name}\x1f${c.url}`, n = (seen[key] = (seen[key] ?? 0) + 1); // ids must be unique or j/k sticks on the repeat
        const note = { fail: 'failing', pending: 'running', pass: '' }[c.state];
        spread(`${fg(color, mark)} ${trunc(clean(c.name), inner - 2 - (note ? width(note) + 1 : 0))}`, dim(note),
          c.url ? item(`check:${key}${n > 1 ? `#${n}` : ''}`, () => launch('open', [c.url], 'Opened the check')) : undefined); // names repeat across workflows; the run's url keeps the selection when the order changes
      });
      rule();
    }

    // Pull requests: yours, open in this repo
    heading('Pull requests');
    const pr = data.prs;
    if (!pr) line(dim('Loading…'));
    else if (!pr.ok) line(dim('GitHub unavailable'));
    else if (!pr.items.length) line(dim('No open pull requests'));
    else {
      for (const p of ui.open.more ? pr.items : pr.items.slice(0, 5)) {
        const id = item(`pr:${p.number}`, () => prMenu(p));
        pair(`⑂ ${clean(p.title)}`, '⋯', id, { leftStyle: (s) => fg(p.isDraft ? C.gray : C.purple, s[0]) + s.slice(1), rightStyle: dim });
        pair(`  ${clean(data.worktrees?.repo ?? env?.repo ?? '')} #${p.number}${p.isDraft ? ' · draft' : ''}`, '', id, { leftStyle: dim });
      }
      if (pr.items.length > 5) line(dim(ui.open.more ? 'Show less' : 'Show more'), item('more', () => { ui.open.more = !ui.open.more; }));
    }
    rule();
  };

  // Tabs: the active one bold and underlined in orange. Enter flips; a click picks by column (tabAt).
  const labels = TABS.map((t) => [t, TAB_LABELS[t]]);
  spread(labels.map(([t, l]) => (t === ui.tab ? bold(fg(C.accent, l)) : dim(l))).join('  '), dim('⇥'), item('tabs', otherTab));
  const under = labels.map(([t, l]) => (t === ui.tab ? fg(C.accent, '━'.repeat(l.length)) : dim('─'.repeat(l.length)))).join(dim('──'));
  line(under + dim('─'.repeat(Math.max(0, inner - width(labels.map(([, l]) => l).join('  '))))));

  if (ui.tab === 'git') { gitTab(); return { rows, items }; }

  // Sessions: every Claude on this Mac, this one first, then those needing you. Enter jumps to its tab.
  const list = data.overview ?? [];
  pair(`Sessions ${dim(list.length ? String(list.length) : '…')}`, '+ new', item('new-session', () => { ui.input = { text: '' }; }),
    { leftStyle: bold, rightStyle: (s) => fg(C.accent, s) });
  const STATE = {
    busy: [() => fg(C.accent, ui.tick % 2 ? '●' : '◉'), (s) => fg(C.accent, s)],
    waiting: [() => fg(C.yellow, '◆'), (s) => fg(C.yellow, s)],
    blocked: [() => fg(C.red, '⧗'), (s) => fg(C.red, s)],
    idle: [() => dim('○'), dim],
  };
  for (const s of list) {
    const id = item(`session:${s.pid}`, () => goTo(s));
    const [dot, paint] = STATE[s.state] ?? STATE.idle;
    const right = s.state;
    const l = trunc(clean(s.title), inner - 4 - width(right) - 1);
    const gap = Math.max(1, inner - 4 - width(l) - width(right));
    line(`${s.current ? '▸' : ' '} ${dot()} ${s.current ? bold(l) : l}${' '.repeat(gap)}${paint(right)}`, id);
    pair(`    ${[s.repo, s.branch, clean(s.doing)].filter(Boolean).join(' · ')}`, '', id, { leftStyle: dim });
  }

  // Environment
  rule();
  pair(`Environment ${caret(ui.open.environment)}`, '', item('environment', () => { ui.open.environment = !ui.open.environment; }),
    { leftStyle: bold });
  if (ui.open.environment) {
    pair(`▭  ${env?.computer ?? '…'}`);
    // Which login this Claude uses.
    if (data.account?.email) pair(`@  ${data.account.email}`, '', undefined, { leftStyle: (s) => s.slice(0, 3) + dim(s.slice(3)) });
    pair(`▢  ${env ? `${env.repo} · ${env.parent}` : '…'}`, '', env && item('repo', () => repoMenu(env)),
      { leftStyle: (s) => s.replace(/ · (.*)$/, (m, p) => ' · ' + dim(p)) });
    if (env?.isGit) {
      // +added −removed since the branch forked, then how many files are uncommitted.
      const diff = env.added || env.removed ? `+${env.added} −${env.removed}` : '';
      pair(`⎇  ${env.branch ?? '(detached)'}`, [diff, env.dirty && `${env.dirty} changed`].filter(Boolean).join(' · '),
        env.branch && item('branch', () => branchMenu(env)),
        { rightStyle: (s) => s.replace(/^\+(\d+) −(\d+)/, (m, a, r) => fg(C.green, `+${a}`) + ' ' + fg(C.red, `−${r}`))
          .replace(/( · )?(\d+ changed)$/, (m, sep = '', t) => dim(sep + t)) });
    }
    pair('◌  Remote Control', '/remote-control', item('remote', () => toast('Type /remote-control in your Claude session')),
      { leftStyle: dim, rightStyle: dim });
  }
  rule();

  // Context
  const st = data.stats;
  const pct = st?.contextPct;
  pair(`Context ${caret(ui.open.context)}`, pct != null ? `${pct}% ${'▰'.repeat(8)}` : '—',
    item('context', () => { ui.open.context = !ui.open.context; }),
    { leftStyle: bold, rightStyle: (s) => (pct != null ? dim(`${pct}% `) + bar(pct) : dim(s)) });
  if (ui.open.context) {
    const kv = (k, v) => line(`  ${dim(k.padEnd(9))}${trunc(v, inner - 11)}`);
    if (!st) line(dim('  No session data yet'));
    else {
      if (st.model) kv('Model', [st.model, st.effort].filter(Boolean).join(' · '));
      kv('Tokens', `${tokens(st.contextTokens)} / ${tokens(st.contextSize)}`);
      if (st.costUsd != null) kv('Cost', `$${st.costUsd.toFixed(2)}${st.apiMs ? ` · API ${Math.round(st.apiMs / 60000)}m` : ''}`);
      if (st.linesAdded != null) kv('Lines', `+${st.linesAdded} −${st.linesRemoved ?? 0}`);
      if (st.cacheWarm != null) kv('Cache', `${st.cacheWarm ? 'warm' : 'cold'}${st.cacheHit != null ? ` · ${Math.round(st.cacheHit * 100)}% hits` : ''}`);
    }
    // Account-wide, so shown even before this session has a transcript.
    for (const l of data.usage) {
      const label = { five_hour: '5h left', seven_day: '7d left' }[l.kind];
      if (!label) continue;
      const reset = l.resetsAt ? Date.parse(l.resetsAt) / 1000 : 0;
      // A window whose reset has passed is fresh again, even before the next reading arrives.
      const left = reset && reset * 1000 < Date.now() ? 100 : Math.max(0, Math.round(100 - l.percentUsed));
      kv(label, `${left}%${reset * 1000 > Date.now() ? ` · resets ${resetAt(reset)}` : ''}`);
    }
  }
  rule();

  // Connectors
  const cn = data.connectors;
  pair(`Connectors ${caret(ui.open.connectors)}`, !cn ? 'checking…' : !cn.ok ? 'unavailable' : `${cn.connected} connected`,
    item('connectors', () => { ui.open.connectors = !ui.open.connectors; }), { leftStyle: bold, rightStyle: dim });
  if (ui.open.connectors) for (const c of cn?.items ?? []) {
    pair(`  ${c.ok ? '✔' : '✗'} ${c.name}`, c.ok ? '' : c.state, undefined,
      { leftStyle: (s) => s.replace(/^( {2})(.)/, (m, sp, mark) => sp + fg(c.ok ? C.green : C.red, mark)), rightStyle: dim });
  }
  rule();

  // Now: who is doing what this second (hooks/activity.ts's feed, the desk's run, the session's background tasks)
  heading('Now');
  const act = data.activity, { running: tasks, finished } = data.tasks;
  if (!data.current) line(dim('No Claude session in this folder'));
  else {
    const spin = (on) => (on ? fg(C.accent, ui.tick % 2 ? '●' : '◉') : dim('○'));
    const rel = (p) => (p && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p ?? '');
    const model = (m) => (m ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
    // Claude itself, from the feed when there is one, else from the session's own status.
    // Claude's own call in flight, leaving out Agent calls: those are its subagents, shown under it.
    const main = act?.running?.filter((c) => !c.agent && c.tool !== 'Agent').at(-1);
    const waitingOn = (act?.running ?? []).filter((c) => !c.agent && c.tool === 'Agent').length;
    const [state, since, busy] = !act?.claude
      ? [data.current.status === 'busy' ? 'working' : 'waiting for you', data.current.statusSince, data.current.status === 'busy']
      : act.claude.state === 'waiting' ? ['waiting for you', act.claude.since, false]
      : main ? [`${main.tool} ${clean(rel(main.arg))}`, main.since, true]
      : waitingOn ? [`waiting on ${waitingOn} subagent${waitingOn === 1 ? '' : 's'}`, act.claude.since, true]
      : [`thinking${act.claude.model ? ` · ${model(act.claude.model)}` : ''}`, act.claude.since, true];
    const actor = (mark, name, what, at, opts = {}) => {
      const right = at ? ago(at) : '', l = trunc(name ? `${name}  ${what}` : what, inner - width(mark) - 1 - (right ? width(right) + 1 : 0));
      const gap = Math.max(right ? 1 : 0, inner - width(mark) - 1 - width(l) - width(right));
      line(`${mark} ${bold(l.slice(0, name.length))}${l.slice(name.length)}${' '.repeat(gap)}${dim(right)}`, opts.id);
    };
    actor(spin(busy), 'Claude', state, since);
    // Under Claude: subagents (its Agent calls, with what one is doing when only one runs) and background tasks.
    const agents = (act?.running ?? []).filter((c) => !c.agent && c.tool === 'Agent');
    const inside = (act?.running ?? []).filter((c) => c.agent).at(-1);
    const kids = [
      ...agents.map((c) => ({ mark: fg(C.accent, '◆'), what: clean(c.arg) + (agents.length === 1 && inside ? ` · ${inside.tool} ${clean(rel(inside.arg))}` : ''), at: c.since })),
      ...tasks.map((t) => ({ mark: fg(C.accent, t.kind === 'agent' ? '◆' : '◇'), what: t.label, at: t.startedAt, id: item(`task:${t.id}`, () => viewLog(t)) })),
    ];
    kids.forEach((k, i) => actor(dim(i === kids.length - 1 ? '  └' : '  ├') + ' ' + k.mark, '', k.what, k.at, { id: k.id }));
    if (act?.desk) actor(spin(true), 'Desk', act.desk.kind ?? 'running', act.desk.startedAt);
    // The gate's refusal, while it's recent.
    if (act?.gate && Date.now() - act.gate.at < 120_000) actor(fg(C.yellow, '⧗'), 'Gate', `held ${act.gate.tool} ${clean(rel(act.gate.file))}`, act.gate.at);
  }
  rule();

  // Just now: the last finished calls, and the session's finished background tasks
  const recent = (act?.recent ?? []).slice(0, 5);
  const compacted = act?.compacted && Date.now() - act.compacted.at < 3600_000 ? act.compacted : null;
  if (recent.length || finished || compacted) {
    heading('Just now');
    if (compacted) {
      const right = ago(compacted.at), l = trunc(`⟲ compacted after ${clean(compacted.after)}`, inner - width(right) - 1);
      line(fg(C.accent, l) + ' '.repeat(Math.max(1, inner - width(l) - width(right))) + dim(right));
    }
    const relp = (p) => (p && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p ?? '');
    for (const r of recent) {
      const right = ago(r.at), l = trunc(`${r.ok ? '✔' : '✗'} ${r.tool} ${clean(relp(r.arg))}`, inner - width(right) - 1);
      line(fg(r.ok ? C.green : C.red, l[0]) + dim(l.slice(1)) + ' '.repeat(Math.max(1, inner - width(l) - width(right))) + dim(right));
    }
    if (finished) line(dim(`◇ ${finished} background task${finished === 1 ? '' : 's'} finished`), item('finished', finishedMenu));
    rule();
  }

  return { rows, items };
}

// ── Overlays: menus and the task output viewer ─────────────────────────────────
function buildOverlay(W, bodyH) {
  const inner = W - 2;
  const o = ui.overlay;
  const rows = [];
  const items = [];
  const line = (text = '', id) => rows.push({ text, id });
  line(dim('‹ back'), 'back');
  items.push({ id: 'back', activate: closeOverlay });
  if (o.kind === 'menu') {
    for (const l of wrap(o.title, inner).slice(0, 3)) line(bold(l));
    for (const i of o.info) line(dim(trunc(i, inner)));
    line(dim('─'.repeat(inner)));
    if (!o.options.length) line(dim('Nothing here'));
    o.options.forEach((opt, i) => {
      const id = `opt:${i}`;
      items.push({ id, activate: () => { if (!opt.keep) closeOverlay(); opt.run(); } });
      const hint = opt.hint ?? (opt.key ? `[${opt.key}]` : '');
      const l = trunc(opt.label, inner - (hint ? width(hint) + 1 : 0));
      line(l + ' '.repeat(Math.max(hint ? 1 : 0, inner - width(l) - width(hint))) + dim(hint), id);
    });
    return { rows, items };
  }
  // log viewer: newest output at the bottom, live
  const t = o.task;
  const live = data.tasks.running.find((r) => r.id === t.id);
  const state = live ? `running · ${ago(t.startedAt)}` : (data.tasks.done.find((d) => d.id === t.id)?.state ?? t.state);
  line(bold(trunc(`${t.kind === 'agent' ? '◆' : '◇'} ${t.label}`, inner)));
  line(dim(trunc(state, inner)));
  line(dim('─'.repeat(inner)));
  const body = taskLines(t).flatMap((l) => wrap(l, inner));
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const room = bodyH - rows.length;
  o.scroll = Math.max(0, Math.min(o.scroll, body.length - room));
  const end = body.length - o.scroll;
  for (const l of body.slice(Math.max(0, end - room), end)) line(l);
  o.maxScroll = Math.max(0, body.length - room);
  return { rows, items };
}

// Settings: an orange selector on the bottom line, right-aligned where the old key legend was. Opened, its rows sit
// between the mascot and that line. ←/→ on Font size and Pet change them without opening their menus.
function buildSettings() {
  const rows = [];
  if (ui.open.settings) {
    const pt = font.size ?? font.base;
    rows.push({ id: 'font', activate: fontMenu, label: 'Aa Font size', value: pt ? `‹ ${pt}pt ›` : '—' });
    rows.push({ id: 'pet', activate: petMenu, label: '◐ Pet', value: `‹ ${mascot.state.creature} ›` });
    rows.push({ id: 'compact', activate: toggleAutoCompact, label: '⟲ Auto-compact', value: `‹ ${autoCompact ? 'on' : 'off'} ›` });
  }
  const toggle = { id: 'settings', activate: () => { ui.open.settings = !ui.open.settings; }, label: '⚙ settings' };
  return { rows, toggle };
}

function frame(W, H) {
  const withMascot = showMascot(W, H);
  const settings = ui.overlay ? null : buildSettings();
  const bodyH = H - 1 - (withMascot ? mascot.rows : 0) - (settings?.rows.length ?? 0);
  const { rows, items } = ui.overlay ? buildOverlay(W, bodyH) : buildMain(W);
  if (settings) items.push(...settings.rows, settings.toggle);
  // The first row, past a menu's ‹ back or the tab bar.
  if (!items.some((i) => i.id === ui.sel)) ui.sel = items[(ui.overlay?.kind === 'menu' || items[0]?.id === 'tabs') && items.length > 1 ? 1 : 0]?.id ?? null;
  const scroll = ui.overlay ? 0 : (() => {
    const first = rows.findIndex((r) => r.id === ui.sel);
    const last = rows.findLastIndex((r) => r.id === ui.sel);
    if (first >= 0) {
      if (first < ui.scroll) ui.scroll = first;
      if (last >= ui.scroll + bodyH) ui.scroll = last - bodyH + 1;
    }
    return (ui.scroll = Math.max(0, Math.min(ui.scroll, rows.length - bodyH)));
  })();
  const view = rows.slice(scroll, scroll + bodyH);
  const lines = view.map((r) => {
    const padded = ' ' + r.text + ' '.repeat(Math.max(0, W - 1 - width(r.text)));
    return r.id && r.id === ui.sel ? `${ESC}48;5;237m${padded}${ESC}49m` : padded;
  });
  while (lines.length < bodyH) lines.push('');
  const viewIds = view.map((r) => r.id);
  while (viewIds.length < bodyH) viewIds.push(null);
  const sel = (id, s) => (id === ui.sel ? `${ESC}48;5;237m${s}${ESC}49m` : s);
  const right = (text, id) => ' '.repeat(Math.max(0, W - 1 - width(text))) + sel(id, text) + ' ';
  // The mascot sits between the list and the bottom line.
  let image = null;
  if (withMascot) {
    const m = mascot.render(W);
    if (m.image) {
      const at = lines.length + m.image.row;
      image = { at, rows: m.image.rows, seq: `${ESC}${at + 1};${m.image.col + 1}H${m.image.data}` };
    }
    lines.push(...m.lines);
    viewIds.push(...m.lines.map(() => null));
  }
  for (const r of settings?.rows ?? []) { lines.push(right(`${r.label}  ${dim(r.value)}`, r.id)); viewIds.push(r.id); }
  // The bottom line: a toast on the left, the settings selector on the right. It also keeps the mascot's
  // image off the last row: drawing an image moves the cursor below it, which would scroll the screen there.
  if (ui.input) {
    // + new's prompt replaces the bottom line; long text scrolls so the cursor stays in view.
    const prompt = fg(C.accent, ' New session: ');
    const room = W - width(prompt) - 2;
    const t = clean(ui.input.text), shown = width(t) > room ? '…' + [...t].slice(-(room - 1)).join('') : t;
    lines.push(prompt + (t ? shown + '▌' : '▌' + dim(trunc(' the problem · esc cancel', room - 1))));
    viewIds.push(null);
    return { lines, items, viewIds, image };
  }
  const label = settings ? fg(C.accent, settings.toggle.label) : '';
  const toastText = ui.toast && ui.toast.until > Date.now() ? trunc(` ${ui.toast.text}`, W - width(label) - 2) : '';
  lines.push(fg(C.green, toastText) + (label ? right(label, 'settings').slice(width(toastText)) : ''));
  viewIds.push(settings ? 'settings' : null);
  return { lines, items, viewIds, image };
}

// ── Modes ──────────────────────────────────────────────────────────────────────
if (args.includes('--json')) {
  console.log(JSON.stringify(await collect(), null, 2));
  process.exit(0);
}

let draw = () => {};

if (args.includes('--frame')) {
  const i = args.indexOf('--frame');
  const W = +args[i + 1] || 42, H = +args[i + 2] || 60;
  for (const k of ['context', 'connectors', 'settings']) if (args.includes(`--open-${k}`)) ui.open[k] = true;
  await collect();
  feedPet(W); mascot.setHeld(false);
  // let it walk to its spot on the road (at a past time, so no blink is left on the frame), then hold it there
  for (let n = 0, t = Date.now() - 1000; n < W * 2; n++) mascot.step(W, false, t);
  mascot.setHeld(petHeld());
  if (args.includes('--flinch')) mascot.flinch();
  // e.g. --activate pr:8  or  --activate finished,opt:0  (a chain of clicks)
  for (const id of (flag('--activate') || '').split(',').filter(Boolean)) frame(W, H).items.find((it) => it.id === id)?.activate();
  console.log(frame(W, H).lines.join('\n'));
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('rail needs a terminal. Try --json or --frame for non-interactive output.');
  process.exit(1);
}

// Interactive panel
const out = process.stdout;
let current = { lines: [], items: [], viewIds: [] };
let shownImage = ''; // the mascot image on screen; while it's unchanged its rows aren't touched
draw = () => {
  current = frame(out.columns || 40, out.rows || 40);
  const img = current.image;
  const key = img ? `${img.at}|${img.seq}` : '';
  const keep = key !== '' && key === shownImage;
  const body = current.lines.map((l, i) => (keep && i >= img.at && i < img.at + img.rows ? '' : l + `${ESC}K`));
  // Synchronized update: iTerm2 shows the finished frame, never the moment the image's rows are blank.
  out.write(`${ESC}?2026h${ESC}H${body.join('\r\n')}${ESC}J${img && !keep ? img.seq : ''}${ESC}?2026l`);
  shownImage = key;
};
const MOUSE_ON = `${ESC}?1000h${ESC}?1006h`, MOUSE_OFF = `${ESC}?1000l${ESC}?1006l`;
const restore = () => { out.write(`${MOUSE_OFF}${ESC}?25h${ESC}?1049l`); try { process.stdin.setRawMode(false); } catch {} };
const quit = (code = 0) => { restore(); process.exit(code); };
process.on('SIGINT', () => quit());
process.on('SIGTERM', () => quit());
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

out.write(`${ESC}?1049h${ESC}?25l${MOUSE_ON}${ESC}16t`); // 16t: ask for the cell size (for the mascot strip)
out.on('resize', () => { shownImage = ''; draw(); });

const refresh = (name) => {
  let busy = false;
  return async () => { if (busy) return; busy = true; try { await loaders[name](); } catch {} busy = false; draw(); };
};
const schedule = { fast: 1000, sessions: 3000, env: 5000, account: 5000, prs: 60_000, worktrees: 60_000, connectors: 300_000 };
const runners = Object.fromEntries(Object.keys(schedule).map((k) => [k, refresh(k)]));
for (const [k, ms] of Object.entries(schedule)) { runners[k](); setInterval(runners[k], ms); }
setInterval(() => { ui.tick++; draw(); }, 1000);
fontsize.baseSize(pinnedPid).then((b) => { font.base = b; draw(); });
// Put the panes on the saved font size once the layout has settled (pane.mjs sizes the splits after opening them).
if (font.size) setTimeout(() => setFont(font.size), 3000);
setInterval(() => { feedPet(out.columns || 40); mascot.step(out.columns || 40, claudeBusy()); draw(); }, 200);
draw();

// A rail pinned to a Claude process quits (closing its pane) once that process is gone for 3s.
if (pinnedPid) {
  let missing = 0;
  setInterval(() => {
    try { process.kill(pinnedPid, 0); missing = 0; } catch (e) { missing = e.code === 'EPERM' ? 0 : missing + 1; }
    if (missing >= 3) quit();
  }, 1000);
}

const move = (d) => {
  if (ui.overlay?.kind === 'log') { ui.overlay.scroll = Math.max(0, Math.min(ui.overlay.maxScroll ?? 0, ui.overlay.scroll - d * 3)); return; }
  const ids = current.items.map((i) => i.id);
  const at = ids.indexOf(ui.sel);
  ui.sel = ids[Math.max(0, Math.min(ids.length - 1, (at < 0 ? 0 : at) + d))] ?? null;
};
const activate = (id) => current.items.find((i) => i.id === id)?.activate();
const selectedPr = () => {
  const n = /^pr:(\d+)$/.exec(ui.sel ?? '')?.[1];
  return n && data.prs?.items.find((p) => String(p.number) === n);
};

const handleKey = (k) => {
  if (k === '\x03') return quit();
  if (ui.input) return typeKey(k);
  if (ui.overlay) {
    if (k === '\x1b' || k === 'q' || k === '\x1b[D' || k === 'h') return closeOverlay();
    if (ui.overlay.kind === 'log') {
      if (k === 'g') ui.overlay.scroll = ui.overlay.maxScroll ?? 0;
      if (k === 'G') ui.overlay.scroll = 0;
    }
    const opt = ui.overlay.kind === 'menu' && ui.overlay.options.find((o) => o.key === k);
    if (opt) { if (!opt.keep) closeOverlay(); return opt.run(); }
  } else {
    if (k === 'q') return quit();
    if (k === 'r') { Object.values(runners).forEach((f) => f()); return toast('Refreshing…'); }
    if (k === 'c') return nextCreature();
    if (k === '\t' || k === ']') return stepTab(1);
    if (k === '\x1b[Z' || k === '[') return stepTab(-1);
    if (ui.sel === 'font' && (k === '\x1b[D' || k === 'h')) return stepFont(-1)();
    if (ui.sel === 'font' && (k === '\x1b[C' || k === 'l')) return stepFont(1)();
    if (ui.sel === 'pet' && (k === '\x1b[D' || k === 'h')) return nextCreature(-1);
    if (ui.sel === 'pet' && (k === '\x1b[C' || k === 'l')) return nextCreature(1);
    if (ui.sel === 'compact' && ['\x1b[D', 'h', '\x1b[C', 'l'].includes(k)) return toggleAutoCompact();
    const p = selectedPr();
    if (p && k === 'o') return launch('open', [p.url], `Opened #${p.number}`);
    if (p && k === 'y') return copy(p.url, `link to #${p.number}`);
  }
  if (k === '\x1b[A' || k === 'k') return move(-1);
  if (k === '\x1b[B' || k === 'j') return move(1);
  if (k === '\r' || k === ' ' || k === '\x1b[C' || k === 'l') return activate(ui.sel);
};

const handleMouse = (b, x, y) => {
  if (b === 64) return move(-1);           // wheel up
  if (b === 65) return move(1);            // wheel down
  if (b !== 0) return;                     // left click only
  const id = current.viewIds[y - 1];
  if (!id) return;
  if (id === 'tabs') { const t = tabAt(x); return t ? setTab(t) : otherTab(); } // a label picks its tab, the ⇥ flips
  ui.sel = id;
  activate(id);
};

process.stdin.setRawMode(true);
process.stdin.on('data', (buf) => {
  // The terminal's reply to 16t: ESC [ 6 ; height ; width t (in pixels).
  const cell = /\x1b\[6;(\d+);(\d+)t/.exec(buf.toString());
  if (cell) mascot.setCellAspect(+cell[2] / +cell[1]);
  const s = buf.toString().replace(/\x1b\[6;\d+;\d+t/g, '');
  if (!s) return draw();
  const mouse = [...s.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)];
  if (mouse.length) { for (const m of mouse) if (m[4] === 'M') handleMouse(+m[1], +m[2], +m[3]); }
  else handleKey(s);
  draw();
});

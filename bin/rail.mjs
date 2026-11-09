#!/usr/bin/env node
// Session rail for iTerm: a Claude-desktop-style side panel.
//   node rail.mjs                 interactive panel (run it in a narrow iTerm pane)
//   node rail.mjs --json          print the collected state once
//   node rail.mjs --frame [W H]   print one rendered frame (for testing, no TTY needed)
//   --cwd DIR                     use DIR instead of the current folder
import { execFile, spawn } from 'node:child_process';
import { openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import * as src from './sources.mjs';
import { createMascot, creatureNames } from './mascot.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cwd = flag('--cwd') || process.cwd();
const pinnedPid = Number(flag('--pid')) || null; // the Claude process this rail belongs to
const taskIndex = new src.TaskIndex();

// ── Data ───────────────────────────────────────────────────────────────────────
const data = { env: null, agents: [], current: null, stats: null, connectors: null, prs: null,
  tasks: { running: [], finished: 0, done: [] } };

const loaders = {
  async fast() {
    data.agents = await src.sessions();
    data.current = (pinnedPid && data.agents.find((a) => a.pid === pinnedPid)) || src.currentSession(data.agents, cwd);
    const files = await src.sessionFiles(data.current);
    await taskIndex.update(files.transcriptPath);
    data.stats = taskIndex.context();
    data.tasks = files.tasksDir ? await taskIndex.list(files.tasksDir) : { running: [], finished: 0, done: [] };
  },
  async env() { data.env = await src.environment(cwd); },
  async prs() { data.prs = await src.prs(cwd); },
  async connectors() { data.connectors = await src.connectors(); },
};

export async function collect() {
  await Promise.all(Object.values(loaders).map((f) => f()));
  return { cwd, ...data };
}

// ── Text helpers (display width aware, so emoji and CJK titles don't break layout) ──
const ESC = '\x1b[';
const fg = (n, s) => `${ESC}38;5;${n}m${s}${ESC}39m`;
const dim = (s) => `${ESC}2m${s}${ESC}22m`;
const bold = (s) => `${ESC}1m${s}${ESC}22m`;
const C = { accent: 173, purple: 141, green: 71, red: 167, yellow: 179, blue: 75, gray: 245 };

const charWidth = (cp) => {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
};
const width = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].reduce((w, ch) => w + charWidth(ch.codePointAt(0)), 0);
const trunc = (s, w) => {
  if (w <= 0) return '';
  if (width(s) <= w) return s;
  let out = '', used = 0;
  for (const ch of s) { const cw = charWidth(ch.codePointAt(0)); if (used + cw > w - 1) break; out += ch; used += cw; }
  return out + '…';
};
// Word wrap; words longer than the line are split.
const wrap = (s, w) => {
  const out = [];
  let cur = '';
  for (const word of s.split(/(\s+)/)) {
    if (width(cur + word) <= w) { cur += word; continue; }
    if (cur.trim()) out.push(cur.trimEnd());
    cur = word.trimStart();
    while (width(cur) > w) {
      let piece = '', used = 0;
      for (const ch of cur) { const cw = charWidth(ch.codePointAt(0)); if (used + cw > w) break; piece += ch; used += cw; }
      out.push(piece); cur = cur.slice(piece.length);
    }
  }
  out.push(cur);
  return out;
};
// Task output can contain any escape sequence; strip them so it can't disturb the panel.
const clean = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b./g, '')
  .replace(/\t/g, '  ')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

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
const ui = { sel: null, open: { context: false, connectors: false, more: false }, scroll: 0, tick: 0,
  overlay: null, toast: null };
// Inline images only in a live iTerm2 pane; --frame output (and other terminals) get text octants.
const iterm = process.env.TERM_PROGRAM === 'iTerm.app' || process.env.LC_TERMINAL === 'iTerm2';
// The chosen creature is remembered across rails; `c` cycles through them.
const MASCOT_FILE = join(homedir(), '.claude', 'session-rail', 'mascot.json');
const savedCreature = (() => {
  try { return Math.max(0, creatureNames.indexOf(JSON.parse(readFileSync(MASCOT_FILE, 'utf8')).creature)); } catch { return 0; }
})();
const mascot = createMascot({ images: iterm && !args.includes('--frame') && Boolean(process.stdout.isTTY), creature: savedCreature });
const showMascot = (W, H) => H >= 24 && W >= mascot.width + 4;
const nextCreature = () => {
  const name = mascot.next();
  try { mkdirSync(dirname(MASCOT_FILE), { recursive: true }); writeFileSync(MASCOT_FILE, JSON.stringify({ creature: name })); } catch {}
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

const prMenu = (p) => menu(`#${p.number} ${p.title}`, [
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

  // Environment
  const env = data.env;
  heading('Environment');
  pair(`▭  ${env?.computer ?? '…'}`);
  pair(`▢  ${env ? `${env.repo} · ${env.parent}` : '…'}`, '', env && item('repo', () => repoMenu(env)),
    { leftStyle: (s) => s.replace(/ · (.*)$/, (m, p) => ' · ' + dim(p)) });
  if (env?.isGit) pair(`⎇  ${env.branch ?? '(detached)'}`, env.dirty ? `${env.dirty} changed` : '',
    env.branch && item('branch', () => branchMenu(env)), { rightStyle: dim });
  pair('◌  Remote Control', '/remote-control', item('remote', () => toast('Type /remote-control in your Claude session')),
    { leftStyle: dim, rightStyle: dim });
  rule();

  // Context
  const st = data.stats;
  const pct = st?.contextPct;
  pair(`Context ${caret(ui.open.context)}`, pct != null ? `${pct}% ${'▰'.repeat(8)}` : '—',
    item('context', () => { ui.open.context = !ui.open.context; }),
    { leftStyle: bold, rightStyle: (s) => (pct != null ? dim(`${pct}% `) + bar(pct) : dim(s)) });
  if (ui.open.context) {
    if (!st) line(dim('  No session data yet'));
    else {
      const kv = (k, v) => line(`  ${dim(k.padEnd(9))}${trunc(v, inner - 11)}`);
      if (st.model) kv('Model', [st.model, st.effort].filter(Boolean).join(' · '));
      kv('Tokens', `${tokens(st.contextTokens)} / ${tokens(st.contextSize)}`);
      if (st.costUsd != null) kv('Cost', `$${st.costUsd.toFixed(2)}${st.apiMs ? ` · API ${Math.round(st.apiMs / 60000)}m` : ''}`);
      if (st.linesAdded != null) kv('Lines', `+${st.linesAdded} −${st.linesRemoved ?? 0}`);
      if (st.cacheWarm != null) kv('Cache', `${st.cacheWarm ? 'warm' : 'cold'}${st.cacheHit != null ? ` · ${Math.round(st.cacheHit * 100)}% hits` : ''}`);
      if (st.limit5h) kv('5h limit', `${st.limit5h.used_percentage}% · resets ${resetAt(st.limit5h.resets_at)}`);
      if (st.limit7d) kv('7d limit', `${st.limit7d.used_percentage}% · resets ${resetAt(st.limit7d.resets_at)}`);
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

  // Changes (open PRs)
  heading('Changes');
  const pr = data.prs;
  if (!pr) line(dim('Loading…'));
  else if (!pr.ok) line(dim('GitHub unavailable'));
  else if (!pr.items.length) line(dim('No open pull requests'));
  else {
    for (const p of ui.open.more ? pr.items : pr.items.slice(0, 5)) {
      const id = item(`pr:${p.number}`, () => prMenu(p));
      pair(`⑂ ${p.title}`, '⋯', id, { leftStyle: (s) => fg(p.isDraft ? C.gray : C.purple, s[0]) + s.slice(1), rightStyle: dim });
      pair(`  ${data.env?.repo ?? ''} #${p.number}${p.isDraft ? ' · draft' : ''}`, '', id, { leftStyle: dim });
    }
    if (pr.items.length > 5) line(dim(ui.open.more ? 'Show less' : 'Show more'), item('more', () => { ui.open.more = !ui.open.more; }));
  }
  rule();

  // Background tasks
  heading('Background tasks');
  const { running, finished } = data.tasks;
  if (!running.length && !finished) line(dim(data.current ? 'None yet' : 'No Claude session in this folder'));
  for (const t of running) {
    pair(`${t.kind === 'agent' ? '◆' : '◇'} ${t.label}`, `${ago(t.startedAt)}  ■`, item(`task:${t.id}`, () => viewLog(t)),
      { leftStyle: (s) => fg(C.accent, s[0]) + s.slice(1), rightStyle: (s) => dim(s.slice(0, -1)) + s.slice(-1) });
  }
  if (finished) line(dim(`◇ ${finished} finished`), item('finished', finishedMenu));
  rule();

  // Active agents
  heading(`Active agents${data.agents.length ? dim(`  ${data.agents.length}`) : ''}`);
  if (!data.agents.length) line(dim('No Claude sessions running'));
  for (const a of data.agents) {
    const id = item(`agent:${a.pid}`, () => agentMenu(a));
    const busy = a.status === 'busy';
    const dot = busy ? fg(C.accent, ui.tick % 2 ? '●' : '◉') : dim('○');
    const isMe = a.pid === data.current?.pid;
    const surface = a.surface === 'desktop' ? 'app' : a.surface;
    const right = `${a.status}  ${surface}`;
    const l = trunc(a.name, inner - 2 - width(right) - 1);
    const gap = Math.max(1, inner - 2 - width(l) - width(right));
    line(`${dot} ${isMe ? bold(l) : l}${' '.repeat(gap)}${busy ? fg(C.accent, a.status) : dim(a.status)}  ${dim(surface)}`, id);
    pair(`  ${a.repo} · ${ago(a.statusSince)}${isMe ? ' · here' : ''}`, '', id, { leftStyle: dim });
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

function frame(W, H) {
  const withMascot = showMascot(W, H);
  const bodyH = H - 1 - (withMascot ? mascot.rows : 0);
  const { rows, items } = ui.overlay ? buildOverlay(W, bodyH) : buildMain(W);
  if (!items.some((i) => i.id === ui.sel)) ui.sel = items[ui.overlay?.kind === 'menu' && items.length > 1 ? 1 : 0]?.id ?? null;
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
  const hints = ui.overlay?.kind === 'log' ? '↑↓ scroll · esc back'
    : ui.overlay ? '↑↓ move · ⏎ select · esc back'
    : `${rows.length > scroll + bodyH ? '↓ more · ' : ''}↑↓ move · ⏎ open · c pet · q quit`;
  const footer = ui.toast && ui.toast.until > Date.now() ? fg(C.green, ` ${ui.toast.text}`) : dim(` ${hints}`);
  // The mascot sits between the list and the legend, which stays on the bottom line.
  let image = null;
  if (withMascot) {
    const m = mascot.render(W);
    if (m.image) {
      const at = lines.length + m.image.row;
      image = { at, rows: m.image.rows, seq: `${ESC}${at + 1};${m.image.col + 1}H${m.image.data}` };
    }
    lines.push(...m.lines);
  }
  lines.push(trunc(footer, W + 20));
  return { lines, items, viewIds: view.map((r) => r.id), image };
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
  for (const k of ['context', 'connectors']) if (args.includes(`--open-${k}`)) ui.open[k] = true;
  await collect();
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
const schedule = { fast: 1000, env: 5000, prs: 60_000, connectors: 300_000 };
const runners = Object.fromEntries(Object.keys(schedule).map((k) => [k, refresh(k)]));
for (const [k, ms] of Object.entries(schedule)) { runners[k](); setInterval(runners[k], ms); }
setInterval(() => { ui.tick++; draw(); }, 1000);
setInterval(() => { mascot.step(out.columns || 40, claudeBusy()); draw(); }, 200);
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
  if (ui.overlay) {
    if (k === '\x1b' || k === 'q' || k === '\x1b[D' || k === 'h') return closeOverlay();
    if (ui.overlay.kind === 'log') {
      if (k === 'g') ui.overlay.scroll = ui.overlay.maxScroll ?? 0;
      if (k === 'G') ui.overlay.scroll = 0;
    }
    const opt = ui.overlay.kind === 'menu' && ui.overlay.options.find((o) => o.key === k);
    if (opt) { closeOverlay(); return opt.run(); }
  } else {
    if (k === 'q') return quit();
    if (k === 'r') { Object.values(runners).forEach((f) => f()); return toast('Refreshing…'); }
    if (k === 'c') return nextCreature();
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

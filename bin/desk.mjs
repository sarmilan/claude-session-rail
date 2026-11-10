#!/usr/bin/env node
// The desk: a wider iTerm panel between Claude and the rail, with tabs for the work itself.
//   Plan  the plan plan mode is writing (live, from the session's transcript)
//   Diff  every file changed since the branch forked from the default branch, and each file's diff
//   Review  a code review of those changes by a headless Claude, with findings you can send to Claude
// It follows what Claude is doing: a new or edited plan brings up Plan, changed files bring up Diff, a
// finished review brings up Review.
// Switching tabs yourself turns that off until you press `a`.
//   node desk.mjs                                   interactive panel
//   node desk.mjs --json                            print the collected state once
//   node desk.mjs --frame [W H] [--tab plan|diff|review] [--file N]   print one rendered frame (no TTY needed)
//   --cwd DIR / --pid PID                           the folder and Claude process this desk belongs to
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as src from './sources.mjs';
import { reviewBranch } from './reviewer.mjs';
import { ESC, fg, dim, bold, C, charWidth, width, trunc, clean } from './term.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cwd = flag('--cwd') || process.cwd();
const pinnedPid = Number(flag('--pid')) || null;
const taskIndex = new src.TaskIndex();

// ── Data ───────────────────────────────────────────────────────────────────────
const data = { plan: null, root: null, files: [], diff: null, claude: null, // diff: { path, lines } of the open file
  review: { running: null, result: null, sig: null } };                       // result: what reviewBranch resolved
const TABS = ['plan', 'diff', 'review'];
const ui = { tab: 'plan', auto: true, scroll: { plan: 0, diff: 0, review: 0 }, sel: 0, open: null, toast: null,
  jump: null, rsel: 0, marked: new Set(), autoReview: false, autoSend: false };
const seen = { plan: undefined, diff: undefined }; // last signatures, to notice changes
const toast = (text) => { ui.toast = { text, until: Date.now() + 2500 }; };
let draw = () => {}; // replaced by the interactive panel

// Notice when a tab's content changes (not on the first load, which only records where things stand).
const changed = (tab, sig) => {
  const c = seen[tab] !== undefined && seen[tab] !== sig;
  seen[tab] = sig;
  return c;
};
let planChangedAt = 0;

// A changed plan brings up Plan and changed files bring up Diff, unless the person picked a tab themselves.
// Plan wins a near-tie, so a file save right after the plan doesn't pull the view away from it.
const loaders = {
  async plan() {
    const agents = await src.sessions();
    const current = (pinnedPid && agents.find((a) => a.pid === pinnedPid)) || src.currentSession(agents, cwd);
    // Claude finishing its turn (busy → idle) is when iTerm's Workgroup asks for a review; so does the desk.
    const wasBusy = data.claude?.status === 'busy';
    data.claude = current;
    if (wasBusy && current?.status === 'idle') onIdle();
    await taskIndex.update((await src.sessionFiles(current)).transcriptPath);
    data.plan = await src.readPlan(taskIndex.planPath);
    if (changed('plan', data.plan ? `${data.plan.path}:${data.plan.mtime}` : '')) {
      planChangedAt = Date.now();
      ui.scroll.plan = 0;
      if (ui.auto) ui.tab = 'plan';
    }
  },
  async diff() {
    ({ root: data.root, files: data.files } = await src.branchFiles(cwd));
    if (changed('diff', JSON.stringify(data.files)) && ui.auto && Date.now() - planChangedAt > 3000) ui.tab = 'diff';
    ui.sel = Math.min(ui.sel, Math.max(0, data.files.length - 1));
    if (ui.open) await loadFile(ui.open);
  },
};

// ── Review ─────────────────────────────────────────────────────────────────────
const diffSig = () => JSON.stringify(data.files);
// Returns why it couldn't start, or null when it started.
function startReview() {
  if (data.review.running) return 'A review is already running';
  if (!data.root) return 'Not a git repository';
  if (!data.files.length) return 'Nothing to review';
  const controller = new AbortController(), sig = diffSig();
  data.review.running = { controller, startedAt: Date.now() };
  reviewBranch(cwd, { signal: controller.signal }).then((result) => {
    data.review = { running: null, result, sig: result.error ? null : sig }; // a failed review can be retried
    ui.rsel = 0; ui.marked.clear(); ui.scroll.review = 0;
    if (ui.auto && !result.error) ui.tab = 'review';
    if (ui.autoSend && !result.error && result.findings.length && data.claude?.status === 'idle') sendFindings(result.findings, true);
    draw();
  });
  return null;
}
const cancelReview = () => data.review.running?.controller.abort();
function onIdle() {
  if (ui.autoReview && data.files.length && diffSig() !== data.review.sig) startReview();
}

// Type the findings into Claude's pane as one pasted message (bracketed paste keeps the line breaks
// from submitting early), then press return. The pane is found by the Claude process's terminal.
const SEND = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then
            tell s to write text ((ASCII character 27) & "[200~" & (item 2 of argv) & (ASCII character 27) & "[201~") newline no
            delay 0.3
            tell s to write text "" newline yes
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;
function sendFindings(findings, auto = false) {
  const pid = data.claude?.pid;
  if (!pid || !findings.length) return toast("Couldn't find this desk's Claude session");
  const text = [`Code review findings on this branch${auto ? ' (sent automatically by the desk)' : ''}. Check each one and fix the real problems:`,
    ...findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.title}${f.detail ? `\n   ${f.detail}` : ''}`)].join('\n');
  execFile('ps', ['-o', 'tty=', '-p', String(pid)], (err, tty) => {
    tty = tty?.toString().trim();
    if (err || !tty || tty === '??') { toast("Claude's pane isn't a terminal"); return draw(); }
    execFile('osascript', ['-e', SEND, `/dev/${tty}`, clean(text)], { timeout: 10_000 }, (e, out) => {
      toast(e || out.toString().trim() !== 'ok' ? "Couldn't reach Claude's pane in iTerm" : `Sent ${findings.length} finding${findings.length === 1 ? '' : 's'} to Claude`);
      draw();
    });
  });
}

async function loadFile(path) {
  data.diff = { path, lines: data.root ? await src.fileDiff(data.root, path) : [] };
}

async function collect() {
  await Promise.all(Object.values(loaders).map((f) => f()));
  return { cwd, ...data };
}

// ── Plan: light Markdown, wrapped to the panel ─────────────────────────────────
// Inline **bold** and `code` become styled runs; wrapping works on the runs so styles survive line breaks.
const STYLE = { text: (s) => s, bold, code: (s) => fg(C.yellow, s), head: (s) => bold(fg(C.accent, s)) };
function runs(text, base = 'text') {
  const out = [];
  for (const part of clean(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) out.push({ t: part.slice(2, -2), s: base === 'head' ? 'head' : 'bold' });
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) out.push({ t: part.slice(1, -1), s: 'code' });
    else out.push({ t: part, s: base });
  }
  return out;
}
function wrapRuns(rs, w, first = '', rest = first) {
  const lines = [];
  let cur = first, used = width(first);
  const words = rs.flatMap((r) => r.t.split(/(\s+)/).filter(Boolean).map((t) => ({ t, s: r.s })));
  for (const { t, s } of words) {
    const tw = width(t);
    if (used + tw > w && /\S/.test(t) && used > width(rest)) { lines.push(cur); cur = rest; used = width(rest); }
    if (!/\S/.test(t) && used === width(rest)) continue; // no leading spaces on a wrapped line
    let left = t;
    while (width(left) > w - used) { // a word longer than the line: split it across as many lines as it needs
      let piece = '', pw = 0;
      for (const ch of left) { const cw = charWidth(ch.codePointAt(0)); if (pw + cw > w - used) break; piece += ch; pw += cw; }
      if (!piece) break; // not even one character fits next to the indent
      cur += STYLE[s](piece); lines.push(cur); cur = rest; used = width(rest);
      left = left.slice(piece.length);
    }
    if (left) { cur += STYLE[s](left); used += width(left); }
  }
  lines.push(cur);
  return lines;
}
function planLines(w) {
  if (!data.plan) return [dim('No plan yet: plan mode output shows up here.')];
  const out = [dim(src.tildify(data.plan.path))], src_ = data.plan.text.split('\n');
  out.push('');
  let fence = false;
  for (const raw of src_) {
    const line = clean(raw);
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) { out.push(dim('  ' + trunc(line, w - 2))); continue; }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) { out.push(...wrapRuns(runs(head[2], 'head'), w, head[1].length <= 2 ? '' : ' ')); continue; }
    if (/^\s*\|/.test(line)) { out.push(trunc(line, w)); continue; } // tables: keep the grid, cut at the edge
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(dim('─'.repeat(w))); continue; }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const indent = ' '.repeat(Math.min(item[1].length, 8));
      const mark = /\d/.test(item[2]) ? item[2] + ' ' : '• ';
      out.push(...wrapRuns(runs(item[3]), w, indent + dim(mark), indent + ' '.repeat(width(mark))));
      continue;
    }
    if (!line.trim()) { out.push(''); continue; }
    const lead = /^\s*/.exec(line)[0];
    out.push(...wrapRuns(runs(line.trim()), w, lead, lead));
  }
  return out;
}

// ── Diff: the file list, and one file's diff ───────────────────────────────────
const totals = () => data.files.reduce((t, f) => ({ a: t.a + f.added, r: t.r + f.removed }), { a: 0, r: 0 });
const counts = (a, r) => fg(C.green, `+${a}`) + ' ' + fg(C.red, `−${r}`);

function listLines(w) {
  if (!data.root) return { lines: [dim('Not a git repository.')], ids: [] };
  if (!data.files.length) return { lines: [dim('No changes since this branch forked.')], ids: [] };
  const { a, r } = totals();
  const lines = [dim(`${data.files.length} file${data.files.length === 1 ? '' : 's'} since the branch forked  `) + counts(a, r), ''];
  const ids = [null, null];
  data.files.forEach((f, i) => {
    const tag = f.status === 'new' ? fg(C.blue, 'new ') : f.status === 'binary' ? dim('bin ') : '    ';
    const right = f.status === 'binary' ? dim('binary') : counts(f.added, f.removed);
    const path = clean(f.path), slash = path.lastIndexOf('/');
    const room = w - 2 - width(tag) - width(right);
    const name = trunc(path, room);
    const styled = slash >= 0 && name === path ? dim(path.slice(0, slash + 1)) + path.slice(slash + 1) : name;
    lines.push(tag + styled + ' '.repeat(Math.max(1, room - width(name) + 2)) + right);
    ids.push(i);
  });
  return { lines, ids };
}

function fileLines(w) {
  const f = data.files.find((x) => x.path === ui.open);
  const head = bold(trunc(clean(ui.open), w - 16)) + '  ' + (f ? counts(f.added, f.removed) : dim('no longer changed'));
  const body = [];
  let newLine = 0, target = -1, inHunk = false; // new-file line numbers, to find a review finding's line
  for (const raw of data.diff?.path === ui.open ? data.diff.lines : []) {
    // The file header comes before the first hunk; after that, '--- x' is a removed line '-- x'.
    if (raw.startsWith('@@')) inHunk = true;
    if (!inHunk) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) newLine = +hunk[1] - 1;
    else if (!raw.startsWith('-') && !raw.startsWith('\\')) newLine++;
    if (ui.jump && target < 0 && !hunk && newLine >= ui.jump) target = body.length;
    const line = trunc(clean(raw), w);
    body.push(raw.startsWith('@@') ? fg(C.purple, line) : raw.startsWith('+') ? fg(C.green, line)
      : raw.startsWith('-') ? fg(C.red, line) : raw.startsWith('\\') || raw.startsWith('…') ? dim(line) : line);
  }
  if (!body.length) body.push(dim(data.diff?.path === ui.open ? 'No textual changes.' : 'Loading…'));
  if (target >= 0) body[target] = `${ESC}48;5;236m` + body[target] + ' '.repeat(Math.max(0, w - width(body[target]))) + `${ESC}49m`;
  return { lines: [head, '', ...body], target: target >= 0 ? target + 2 : -1 };
}

// ── Review: the findings, each a selectable block ──────────────────────────────
const SEV = { high: C.red, medium: C.yellow, low: C.gray };
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
function reviewLines(w) {
  const { running, result } = data.review;
  const lines = [], ids = [];
  const push = (l, id = null) => { lines.push(l); ids.push(id); };
  if (running) push(fg(C.accent, `◌ Reviewing ${data.files.length} file${data.files.length === 1 ? '' : 's'}… ${Math.round((Date.now() - running.startedAt) / 1000)}s`) + dim('  x cancel'));
  else if (result?.error) push(fg(C.red, `✗ ${trunc(clean(result.error), w - 20)}`) + dim('  r retry'));
  else if (result) {
    const n = result.findings.length;
    push(bold(n ? `${n} finding${n === 1 ? '' : 's'}` : fg(C.green, '✓ No problems found')) + dim(`  · reviewed ${ago(result.finishedAt)}`)
      + (data.review.sig !== diffSig() ? fg(C.yellow, '  · changed since · r re-run') : ''));
  } else push(dim(data.files.length ? "No review yet. Press r to review this branch's changes (about a minute)." : 'Nothing to review yet.'));
  push(dim(`auto-review when Claude finishes: ${ui.autoReview ? fg(C.green, 'on') : 'off'} (i) · auto-send: ${ui.autoSend ? fg(C.green, 'on') : 'off'} (S)`));
  (result?.findings ?? []).forEach((f, i) => {
    push('', null);
    const box = ui.marked.has(i) ? fg(C.accent, '[x]') : dim('[ ]');
    const where = f.file ? clean(f.file) + (f.line ? `:${f.line}` : '') : '';
    push(`${box} ${fg(SEV[f.severity], `● ${f.severity}`)}  ${dim(trunc(where, w - 16))}`, i);
    for (const l of wrapRuns(runs(f.title, 'text').map((r) => ({ ...r, s: r.s === 'text' ? 'bold' : r.s })), w, '    ')) push(l, i);
    for (const l of wrapRuns([{ t: clean(f.detail), s: 'text' }], w, '    ')) push(dim(l), i);
  });
  return { lines, ids };
}

// ── Frame ──────────────────────────────────────────────────────────────────────
let layout = { tabs: [], body: 2, ids: [], scroll: 0 };
function frame(W, H) {
  const w = W - 2, bodyH = H - 3;
  // Tab bar: each tab's span is remembered for mouse clicks.
  const { a, r } = totals();
  const nf = data.review.result?.findings?.length;
  const labels = { plan: 'Plan', diff: `Diff ${data.files.length ? `+${a} −${r}` : ''}`.trim(),
    review: data.review.running ? 'Review ◌' : nf ? `Review ${nf}` : 'Review' };
  let x = 1, bar = '';
  const tabs = TABS.map((t) => {
    const text = ` ${labels[t]} `;
    const span = { tab: t, from: x, to: x + width(text) };
    bar += (t === ui.tab ? `${ESC}48;5;237m` + bold(fg(C.accent, text)) + `${ESC}49m` : dim(text)) + ' ';
    x += width(text) + 1;
    return span;
  });
  // The auto-switch state on the right, shortened (then dropped) when the panel is narrow.
  const mode = [ui.auto ? dim('follows Claude') : fg(C.yellow, 'auto off'), ui.auto ? dim('auto') : fg(C.yellow, 'off')]
    .find((m) => width(bar) + width(m) <= w);
  if (mode) bar += ' '.repeat(w - width(bar) - width(mode)) + mode;

  let body, ids = [], target = -1;
  if (ui.tab === 'plan') body = planLines(w);
  else if (ui.tab === 'review') ({ lines: body, ids } = reviewLines(w));
  else if (ui.open) ({ lines: body, target } = fileLines(w));
  else ({ lines: body, ids } = listLines(w));
  const selected = ui.tab === 'review' ? ui.rsel : ui.sel;

  // Lists scroll to keep the selection in view; a jump to a finding's line puts it near the top.
  const key = ui.tab === 'diff' && ui.open ? 'file' : ui.tab;
  let scroll = ui.scroll[key] ?? 0;
  if (target >= 0) scroll = target - 3;
  if (ui.jump && ui.open && data.diff?.path === ui.open) ui.jump = null; // one try per jump, found or not
  const first = ids.indexOf(selected), last = ids.lastIndexOf(selected);
  if (first >= 0) {
    if (last >= scroll + bodyH) scroll = last - bodyH + 1;
    if (first < scroll) scroll = first;
  }
  scroll = ui.scroll[key] = Math.max(0, Math.min(scroll, body.length - bodyH));
  const view = body.slice(scroll, scroll + bodyH).map((l, i) => {
    const padded = ' ' + l + ' '.repeat(Math.max(0, W - 1 - width(l)));
    return ids.length && ids[scroll + i] === selected ? `${ESC}48;5;237m${padded}${ESC}49m` : padded;
  });
  while (view.length < bodyH) view.push('');

  const more = body.length > scroll + bodyH ? '↓ more · ' : '';
  const hints = ui.tab === 'plan' ? `${more}↑↓ scroll · tab switch · a auto · q quit`
    : ui.tab === 'review' ? `↑↓ move · ⏎ go to line · space mark · s send to Claude · r review`
    : ui.open ? `${more}↑↓ scroll · n/p file · esc back · q quit`
    : `↑↓ move · ⏎ open · tab switch · a auto · q quit`;
  // Cut the plain text before styling: a line past the last column would scroll the screen.
  const footer = ui.toast && ui.toast.until > Date.now() ? fg(C.green, trunc(` ${ui.toast.text}`, W - 1)) : dim(trunc(` ${hints}`, W - 1));
  layout = { tabs, body: 2, ids: ids.slice(scroll, scroll + bodyH), scroll, bodyH };
  return [' ' + bar, ' ' + dim('─'.repeat(w)), ...view, footer];
}

// ── Modes ──────────────────────────────────────────────────────────────────────
if (args.includes('--json')) {
  const d = await collect();
  console.log(JSON.stringify({ ...d, plan: d.plan && { ...d.plan, text: `${d.plan.text.slice(0, 200)}…` } }, null, 2));
  process.exit(0);
}

const pick = (tab) => { if (TABS.includes(tab)) ui.tab = tab; };
const openFile = async (i) => {
  const f = data.files[i];
  if (!f) return;
  ui.sel = i; ui.open = f.path; ui.scroll.file = 0;
  await loadFile(f.path);
};

// Open a finding's file in the Diff tab, scrolled to its line.
async function jumpTo(i) {
  const f = data.review.result?.findings?.[i];
  const at = data.files.findIndex((x) => x.path === f?.file);
  if (at < 0) return toast(f?.file ? `${clean(f.file)} isn't in the diff any more` : 'That finding has no file');
  ui.tab = 'diff';
  ui.jump = f.line;
  await openFile(at);
}

if (args.includes('--frame')) {
  const i = args.indexOf('--frame');
  const W = +args[i + 1] || 80, H = +args[i + 2] || 40;
  await collect();
  pick(flag('--tab') ?? (data.plan ? 'plan' : 'diff'));
  if (flag('--file') != null) { ui.tab = 'diff'; await openFile(+flag('--file')); }
  // A saved review result (reviewBranch's JSON), for testing the Review tab without running a review.
  if (flag('--review-json')) { data.review = { running: null, result: JSON.parse(readFileSync(flag('--review-json'), 'utf8')), sig: diffSig() }; ui.tab = 'review'; }
  for (const i of (flag('--mark') ?? '').split(',').filter(Boolean)) ui.marked.add(+i);
  if (flag('--select') != null) ui.rsel = +flag('--select');
  if (flag('--jump') != null) await jumpTo(+flag('--jump'));
  console.log(frame(W, H).join('\n'));
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('desk needs a terminal. Try --json or --frame for non-interactive output.');
  process.exit(1);
}

// Interactive panel
const out = process.stdout;
draw = () => {
  const lines = frame(out.columns || 80, out.rows || 40);
  out.write(`${ESC}?2026h${ESC}H${lines.map((l) => l + `${ESC}K`).join('\r\n')}${ESC}J${ESC}?2026l`);
};
const MOUSE_ON = `${ESC}?1000h${ESC}?1006h`, MOUSE_OFF = `${ESC}?1000l${ESC}?1006l`;
const restore = () => { out.write(`${MOUSE_OFF}${ESC}?25h${ESC}?1049l`); try { process.stdin.setRawMode(false); } catch {} };
const quit = (code = 0) => { cancelReview(); restore(); process.exit(code); };
process.on('SIGINT', () => quit());
process.on('SIGTERM', () => quit());
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });
out.write(`${ESC}?1049h${ESC}?25l${MOUSE_ON}`);
out.on('resize', draw);

const refresh = (name) => {
  let busy = false;
  return async () => { if (busy) return; busy = true; try { await loaders[name](); } catch {} busy = false; draw(); };
};
const schedule = { plan: 1000, diff: 3000 };
const runners = Object.fromEntries(Object.keys(schedule).map((k) => [k, refresh(k)]));
// The first load picks the starting tab (the plan if there is one), then changes take over.
await collect();
pick(data.plan ? 'plan' : 'diff');
for (const [k, ms] of Object.entries(schedule)) setInterval(runners[k], ms);
setInterval(draw, 1000);
draw();

// A desk pinned to a Claude process quits (closing its pane) once that process is gone for 3s.
if (pinnedPid) {
  let missing = 0;
  setInterval(() => {
    try { process.kill(pinnedPid, 0); missing = 0; } catch (e) { missing = e.code === 'EPERM' ? 0 : missing + 1; }
    if (missing >= 3) quit();
  }, 1000);
}

const manual = (tab) => { if (tab !== ui.tab) { ui.tab = tab; if (ui.auto) { ui.auto = false; toast('Auto-switch off · a to turn it back on'); } } };
const scrollBy = (d) => { const key = ui.tab === 'diff' && ui.open ? 'file' : ui.tab; ui.scroll[key] = (ui.scroll[key] ?? 0) + d; };
const move = (d) => {
  const n = data.review.result?.findings?.length ?? 0;
  if (ui.tab === 'review') { if (n) ui.rsel = Math.max(0, Math.min(n - 1, ui.rsel + d)); else scrollBy(d); return; }
  if (ui.tab === 'diff' && !ui.open && data.files.length) ui.sel = Math.max(0, Math.min(data.files.length - 1, ui.sel + d));
  else scrollBy(d);
};
const page = () => Math.max(1, (layout.bodyH ?? 10) - 2);

const handleKey = async (k) => {
  if (k === '\x03' || k === 'q') return quit();
  if (k === '\t') return manual(TABS[(TABS.indexOf(ui.tab) + 1) % TABS.length]);
  if (k === '\x1b[Z') return manual(TABS[(TABS.indexOf(ui.tab) + TABS.length - 1) % TABS.length]);
  if (k === '1' || k === '2' || k === '3') return manual(TABS[+k - 1]);
  if (ui.tab === 'review') {
    const findings = data.review.result?.findings ?? [];
    if (k === 'r') return toast(startReview() ?? 'Reviewing…');
    if (k === 'x') { cancelReview(); return; }
    if (k === 'i') { ui.autoReview = !ui.autoReview; return toast(ui.autoReview ? 'Reviews when Claude finishes a turn' : 'Auto-review off'); }
    if (k === 'S') { ui.autoSend = !ui.autoSend; return toast(ui.autoSend ? 'Auto-review findings go straight to Claude' : 'Auto-send off'); }
    if (k === ' ' && findings.length) { ui.marked.has(ui.rsel) ? ui.marked.delete(ui.rsel) : ui.marked.add(ui.rsel); return move(1); }
    if (k === 's' && findings.length) return sendFindings(ui.marked.size ? findings.filter((_, i) => ui.marked.has(i)) : [findings[ui.rsel]].filter(Boolean));
    if ((k === '\r' || k === 'l' || k === '\x1b[C') && findings.length) return jumpTo(ui.rsel);
  }
  if (k === 'a') { ui.auto = !ui.auto; return toast(ui.auto ? 'Following Claude again' : 'Auto-switch off'); }
  if (k === 'r') { Object.values(runners).forEach((f) => f()); return toast('Refreshing…'); }
  if (k === '\x1b[A' || k === 'k') return move(-1);
  if (k === '\x1b[B' || k === 'j') return move(1);
  if (k === '\x1b[5~' || k === 'b') return scrollBy(-page());
  if (k === '\x1b[6~' || k === ' ') return scrollBy(page());
  if (k === 'g') { const key = ui.tab === 'diff' && ui.open ? 'file' : ui.tab; ui.scroll[key] = 0; if (!ui.open) ui.sel = 0; return; }
  if (k === 'G') { const key = ui.tab === 'diff' && ui.open ? 'file' : ui.tab; ui.scroll[key] = 1e9; if (!ui.open) ui.sel = Math.max(0, data.files.length - 1); return; }
  if (ui.tab !== 'diff') return;
  if (ui.open) {
    if (k === '\x1b' || k === 'h' || k === '\x1b[D') { ui.open = null; ui.jump = null; data.diff = null; return; }
    if (k === 'n') return openFile(Math.min(data.files.length - 1, ui.sel + 1));
    if (k === 'p') return openFile(Math.max(0, ui.sel - 1));
  } else if (k === '\r' || k === 'l' || k === '\x1b[C') return openFile(ui.sel);
};

const handleMouse = async (b, x, y) => {
  if (b === 64) return move(-3);
  if (b === 65) return move(3);
  if (b !== 0) return;
  if (y === 1) { const t = layout.tabs.find((s) => x - 1 >= s.from && x - 1 < s.to); if (t) manual(t.tab); return; }
  const i = layout.ids[y - 1 - layout.body];
  if (ui.tab === 'diff' && !ui.open && i != null) return openFile(i);
  if (ui.tab === 'review' && i != null) { if (ui.rsel === i) return jumpTo(i); ui.rsel = i; }
};

process.stdin.setRawMode(true);
process.stdin.on('data', async (buf) => {
  const s = buf.toString();
  const mouse = [...s.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)];
  if (mouse.length) { for (const m of mouse) if (m[4] === 'M') await handleMouse(+m[1], +m[2], +m[3]); }
  else await handleKey(s);
  draw();
});

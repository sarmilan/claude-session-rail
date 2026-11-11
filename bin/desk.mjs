#!/usr/bin/env node
// The desk: a wider iTerm panel between Claude and the rail, with tabs for the work itself.
//   Plan  the plan plan mode is writing (live, from the session's transcript)
//   Diff  every file changed since the branch forked from the default branch, and each file's diff
//   Review  runs the code-review skill on those changes, keeps its findings per branch, and hands the ones
//           you accept to Claude to fix
// It follows what Claude is doing: a new or edited plan brings up Plan, changed files bring up Diff, a
// finished review brings up Review.
// Switching tabs yourself turns that off until you press `a`.
//   node desk.mjs                                   interactive panel
//   node desk.mjs --json                            print the collected state once
//   node desk.mjs --frame [W H] [--tab plan|diff|review] [--file N]   print one rendered frame (no TTY needed)
//     [--review-json F --select N --jump N]          …with a saved review record (reviewer.mjs's store shape)
//   --cwd DIR / --pid PID                           the folder and Claude process this desk belongs to
import { execFile } from 'node:child_process';
import * as src from './sources.mjs';
import { reviewBranch, loadReviews, saveReviews } from './reviewer.mjs';
import { ESC, fg, dim, bold, C, charWidth, width, trunc, clean } from './term.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cwd = flag('--cwd') || process.cwd();
const pinnedPid = Number(flag('--pid')) || null;
const taskIndex = new src.TaskIndex();

// ── Data ───────────────────────────────────────────────────────────────────────
const data = { plan: null, recent: null, root: null, files: [], diff: null, claude: null, // diff: { path, lines } of the open file
  review: { running: null, runs: [], path: undefined } };                    // runs: the branch's saved reviews, newest first
const TABS = ['plan', 'diff', 'review'];
const ui = { tab: 'plan', auto: true, scroll: { plan: 0, diff: 0, review: 0 }, sel: 0, open: null, toast: null,
  jump: null, rsel: 0 };
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
    data.claude = current;
    await taskIndex.update((await src.sessionFiles(current)).transcriptPath);
    data.plan = await src.readPlan(taskIndex.planPath);
    if (changed('plan', data.plan ? `${data.plan.path}:${data.plan.mtime}` : '')) {
      planChangedAt = Date.now();
      ui.scroll.plan = 0;
      if (ui.auto) ui.tab = 'plan';
    }
  },
  // What landed lately, for the Plan tab before there's a plan. gh is slow, so this refreshes rarely.
  async recent() { if (!data.plan || !data.recent) data.recent = await src.recentWork(cwd); },
  async diff() {
    ({ root: data.root, files: data.files } = await src.branchFiles(cwd));
    if (changed('diff', JSON.stringify(data.files)) && ui.auto && Date.now() - planChangedAt > 3000) ui.tab = 'diff';
    ui.sel = Math.min(ui.sel, Math.max(0, data.files.length - 1));
    if (ui.open) await loadFile(ui.open);
  },
  // The branch's review record, read again when the branch changes (a running review keeps running and
  // saves to the branch it started on).
  async reviews() {
    const path = await src.reviewsPath(cwd);
    if (path === data.review.path) return;
    data.review = { ...data.review, runs: await loadReviews(path), path };
    ui.rsel = 0; ui.scroll.review = 0;
  },
};

// ── Review ─────────────────────────────────────────────────────────────────────
const diffSig = () => JSON.stringify(data.files);
// The tab shows the newest successful review. A failed run is only kept as the newest entry, to say why it
// failed: it never hides the review before it, and failures can't push real reviews out of the history.
const latest = () => data.review.runs.find((r) => !r.error) ?? null;
const failed = () => (data.review.runs[0]?.error ? data.review.runs[0] : null);
const pending = () => (latest()?.findings ?? []).map((f, i) => (f.acceptedAt ? -1 : i)).filter((i) => i >= 0);
const record = (run, runs) => [run, ...runs.filter((r) => !r.error)];
// Returns why it couldn't start, or null when it started.
function startReview() {
  if (data.review.running) return 'A review is already running';
  if (!data.root) return 'Not a git repository';
  if (!data.files.length) return 'Nothing to review';
  if (!data.review.path) return 'Still loading this branch’s reviews';
  const controller = new AbortController(), sig = diffSig(), path = data.review.path;
  data.review.running = { controller, startedAt: Date.now() };
  reviewBranch(cwd, { signal: controller.signal }).then(async (run) => {
    data.review.running = null;
    // A cancelled run leaves the record alone; a failed one is kept so the tab says why.
    if (run.error !== 'Review cancelled') {
      run = { ...run, sig };
      if (path === data.review.path) {
        data.review.runs = record(run, data.review.runs);
        await saveReviews(path, data.review.runs);
        ui.rsel = 0; ui.scroll.review = 0;
        if (ui.auto) ui.tab = 'review';
      } else await saveReviews(path, record(run, await loadReviews(path))); // the branch changed meanwhile
    }
    draw();
  });
  return null;
}
const cancelReview = () => data.review.running?.controller.abort();

// Hand the latest review's findings at `indices` to Claude; once they're delivered, mark them accepted.
// Findings on their way are held in `sending`, so a second press during the send can't paste them twice.
const sending = new Set();
function acceptFindings(indices) {
  const run = latest();
  const picked = indices.filter((i) => run?.findings[i] && !run.findings[i].acceptedAt && !sending.has(run.findings[i]));
  if (!picked.length) return toast(!run?.findings.length ? 'No findings to accept' : sending.size ? 'Sending to Claude…' : 'Already accepted');
  const path = data.review.path;
  for (const i of picked) sending.add(run.findings[i]);
  sendFindings(picked.map((i) => run.findings[i]), async (ok) => {
    for (const i of picked) sending.delete(run.findings[i]);
    if (!ok) return draw();
    // Mark the run in the list as it is now: a branch switch during the send may have reloaded it from disk.
    const runs = path === data.review.path ? data.review.runs : await loadReviews(path);
    const target = runs.find((r) => r.startedAt === run.startedAt);
    if (target) {
      const at = Date.now();
      for (const i of picked) if (target.findings[i]) target.findings[i].acceptedAt = at;
      await saveReviews(path, runs);
    }
    draw();
  });
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
// `onDone(ok)`: ok is true only when the text reached Claude's pane.
function sendFindings(findings, onDone) {
  const pid = data.claude?.pid;
  if (!pid) { toast("Couldn't find this desk's Claude session"); return onDone(false); }
  const text = ['Code review findings on this branch, accepted. Fix each one:',
    ...findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.title}${f.detail ? `\n   ${f.detail}` : ''}`)].join('\n');
  execFile('ps', ['-o', 'tty=', '-p', String(pid)], (err, tty) => {
    tty = tty?.toString().trim();
    if (err || !tty || tty === '??') { toast("Claude's pane isn't a terminal"); return onDone(false); }
    execFile('osascript', ['-e', SEND, `/dev/${tty}`, clean(text)], { timeout: 10_000 }, (e, out) => {
      const ok = !e && out.toString().trim() === 'ok';
      toast(ok ? `Sent ${findings.length} finding${findings.length === 1 ? '' : 's'} to Claude` : "Couldn't reach Claude's pane in iTerm");
      onDone(ok);
    });
  });
}

async function loadFile(path) {
  data.diff = { path, lines: data.root ? await src.fileDiff(data.root, path) : [] };
}

// `skip` leaves out slow loaders the interactive panel fills in after its first draw.
async function collect(skip = []) {
  await Promise.all(Object.entries(loaders).filter(([k]) => !skip.includes(k)).map(([, f]) => f()));
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
// With no plan yet, Plan shows what landed lately: merged PRs (title, first line of the body), then commits.
function recentLines(w) {
  const out = [dim('No plan yet: plan mode output shows up here.')];
  const { base, prs = [], commits = [] } = data.recent ?? {};
  // A tag (PR number, commit hash) and a title, cut to fit before styling, with the age on the right.
  const row = (tag, style, text, right) => {
    const l = trunc(`${tag} ${clean(text)}`, w - width(right) - 2);
    return style(l.slice(0, tag.length)) + l.slice(tag.length) + ' '.repeat(Math.max(2, w - width(l) - width(right))) + dim(right);
  };
  if (prs.length) {
    out.push('', bold(fg(C.accent, 'Recent work')), '');
    for (const p of prs) {
      out.push(row(`#${p.number}`, dim, p.title, ago(p.mergedAt)));
      if (p.summary) out.push(dim('    ' + trunc(clean(p.summary), w - 4)));
    }
  }
  if (commits.length) {
    out.push('', bold(fg(C.accent, `Commits on ${clean(base)}`)), '');
    for (const c of commits) out.push(row(c.hash, (t) => fg(C.yellow, t), c.subject, ago(c.at)));
  }
  return out;
}
function planLines(w) {
  if (!data.plan) return recentLines(w);
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
const ago = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1410 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
// A clickable button: its text, styled, and remembered as a span on the current line for mouse clicks.
const button = (label, colour) => `${ESC}48;5;237m` + bold(fg(colour, ` ${label} `)) + `${ESC}49m`;
const when = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function reviewLines(w) {
  const { running } = data.review, run = latest(), fail = failed(), open = pending();
  const lines = [], ids = [], buttons = [];
  const push = (l, id = null) => { lines.push(l); ids.push(id); };
  // Lay out a row of buttons and trailing text; each button's columns are kept for clicks.
  const row = (parts, id = null) => {
    let l = '', x = 0;
    for (const p of parts) {
      if (p.action) { buttons.push({ row: lines.length, from: x, to: x + width(p.label) + 2, action: p.action }); l += button(p.label, p.colour); x += width(p.label) + 2; }
      else { l += p.text; x += width(p.plain ?? p.text); }
    }
    push(l, id);
  };

  // The action row: Run (or the running review), Accept all, and where the latest review stands.
  const parts = [
    running ? { action: 'cancel', label: `◌ Reviewing… ${Math.round((Date.now() - running.startedAt) / 1000)}s · x cancel`, colour: C.accent }
      : { action: 'run', label: fail ? '↻ Retry review' : run ? '↻ Run again' : '▶ Run review', colour: C.accent },
    ...(open.length && !running ? [{ text: '  ' }, { action: 'acceptAll', label: `✓ Accept all ${open.length}`, colour: C.green }] : []),
  ];
  // Where the latest review stands, only when it fits whole: the buttons matter more.
  const used = parts.reduce((n, p) => n + (p.action ? width(p.label) + 2 : width(p.text)), 0);
  const status = [run && `reviewed ${ago(run.finishedAt)}`, run && run.sig !== diffSig() && 'changed since'].filter(Boolean);
  while (status.length && used + 2 + width(status.join(' · ')) > w) status.pop();
  if (status.length && !running) parts.push({ text: '  ' + dim(status.join(' · ')), plain: '  ' + status.join(' · ') });
  row(parts);
  push('');
  if (fail) { for (const l of wrapRuns([{ t: `✗ The last review failed: ${clean(fail.error)}`, s: 'text' }], w)) push(fg(C.red, l)); if (run) push(''); }
  if (!run && !fail) {
    const text = data.files.length ? "No review on this branch yet. Run one to check this branch's changes with the code-review skill (a minute or more)." : 'Nothing to review yet.';
    for (const l of wrapRuns([{ t: text, s: 'text' }], w)) push(dim(l));
  }
  else if (run && !run.findings.length) push(fg(C.green, '✓ No problems found'));

  (run?.findings ?? []).forEach((f, i) => {
    const where = f.file ? clean(f.file) + (f.line ? `:${f.line}` : '') : '';
    if (f.acceptedAt) {
      push(`${fg(C.green, '✓ accepted')}  ${dim(trunc(where, w - 14))}`, i);
      for (const l of wrapRuns([{ t: clean(f.title), s: 'text' }], w, '    ')) push(dim(l), i);
    } else {
      const head = `● ${f.severity}  `, room = w - width(head) - 12;
      const shown = trunc(where, Math.max(4, room));
      row([{ text: fg(SEV[f.severity], `● ${f.severity}`) + '  ' + dim(shown), plain: head + shown },
        { text: ' '.repeat(Math.max(1, w - width(head) - width(shown) - 10)) }, { action: `accept:${i}`, label: 'accept', colour: C.green }], i);
      for (const l of wrapRuns(runs(f.title, 'text').map((r) => ({ ...r, s: r.s === 'text' ? 'bold' : r.s })), w, '    ')) push(l, i);
      for (const l of wrapRuns([{ t: clean(f.detail), s: 'text' }], w, '    ')) push(dim(l), i);
    }
    push('');
  });

  const earlier = data.review.runs.filter((r) => !r.error && r !== run);
  if (earlier.length) {
    push(dim('── Earlier reviews ' + '─'.repeat(Math.max(0, w - 19))));
    for (const r of earlier) {
      const n = r.findings.length, ok = r.findings.filter((f) => f.acceptedAt).length;
      push(dim(trunc(`${when(r.startedAt)} · ${n} finding${n === 1 ? '' : 's'} · ${ok} accepted`, w)));
    }
  }
  return { lines, ids, buttons };
}

// ── Frame ──────────────────────────────────────────────────────────────────────
let layout = { tabs: [], tabRow: 2, body: 3, ids: [], scroll: 0 };
function frame(W, H) {
  const w = W - 2, bodyH = H - 4;
  // Tab bar, between two rules: each tab's span is remembered for mouse clicks.
  const { a, r } = totals();
  const nf = pending().length;
  const labels = { plan: 'Plan', diff: `Diff ${data.files.length ? `+${a} −${r}` : ''}`.trim(),
    review: `Review${nf ? ` ${nf}` : ''}${data.review.running ? ' ◌' : ''}` };
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

  let body, ids = [], buttons = [], target = -1;
  if (ui.tab === 'plan') body = planLines(w);
  else if (ui.tab === 'review') ({ lines: body, ids, buttons } = reviewLines(w));
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
    : ui.tab === 'review' ? `${more}↑↓ move · ⏎ go to line · y accept · A accept all · r run review · x cancel`
    : ui.open ? `${more}↑↓ scroll · n/p file · esc back · q quit`
    : `↑↓ move · ⏎ open · tab switch · a auto · q quit`;
  // Cut the plain text before styling: a line past the last column would scroll the screen.
  const footer = ui.toast && ui.toast.until > Date.now() ? fg(C.green, trunc(` ${ui.toast.text}`, W - 1)) : dim(trunc(` ${hints}`, W - 1));
  layout = { tabs, tabRow: 2, body: 3, ids: ids.slice(scroll, scroll + bodyH), scroll, bodyH,
    buttons: buttons.filter((b) => b.row >= scroll && b.row < scroll + bodyH).map((b) => ({ ...b, row: b.row - scroll })) };
  const rule = ' ' + dim('─'.repeat(w));
  return [rule, ' ' + bar, rule, ...view, footer];
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
  const f = latest()?.findings?.[i];
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
  pick(flag('--tab') ?? 'plan');
  if (flag('--file') != null) { ui.tab = 'diff'; await openFile(+flag('--file')); }
  // A saved review record (reviewer.mjs's store), for testing the Review tab without running a review.
  if (flag('--review-json')) { data.review = { running: null, runs: await loadReviews(flag('--review-json')) }; ui.tab = 'review'; }
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
const schedule = { plan: 1000, diff: 3000, reviews: 3000, recent: 60_000 };
const runners = Object.fromEntries(Object.keys(schedule).map((k) => [k, refresh(k)]));
// The desk opens on Plan (recent work until there's a plan); after the first load, changes take over.
// Recent work asks gh, which can take seconds, so it arrives after the first draw.
await collect(['recent']);
void runners.recent();
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

// The Review tab's actions, shared by keys and button clicks.
const review = (action) => {
  if (action === 'run') return toast(startReview() ?? 'Reviewing…');
  if (action === 'cancel') return cancelReview();
  if (action === 'acceptAll') return acceptFindings(pending());
  if (action.startsWith('accept:')) { ui.rsel = +action.slice(7); return acceptFindings([ui.rsel]); }
};
const manual = (tab) => { if (tab !== ui.tab) { ui.tab = tab; if (ui.auto) { ui.auto = false; toast('Auto-switch off · a to turn it back on'); } } };
const scrollBy = (d) => { const key = ui.tab === 'diff' && ui.open ? 'file' : ui.tab; ui.scroll[key] = (ui.scroll[key] ?? 0) + d; };
const move = (d) => {
  const n = latest()?.findings?.length ?? 0;
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
    const findings = latest()?.findings ?? [];
    if (k === 'r') return review('run');
    if (k === 'x') return review('cancel');
    if (k === 'y') return review(`accept:${ui.rsel}`);
    if (k === 'A') return review('acceptAll');
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
  if (y === layout.tabRow) { const t = layout.tabs.find((s) => x - 1 >= s.from && x - 1 < s.to); if (t) manual(t.tab); return; }
  const i = layout.ids[y - 1 - layout.body];
  if (ui.tab === 'diff' && !ui.open && i != null) return openFile(i);
  if (ui.tab === 'review') {
    const b = layout.buttons.find((s) => s.row === y - 1 - layout.body && x - 2 >= s.from && x - 2 < s.to);
    if (b) return review(b.action);
    if (i != null) { if (ui.rsel === i) return jumpTo(i); ui.rsel = i; }
  }
};

process.stdin.setRawMode(true);
process.stdin.on('data', async (buf) => {
  const s = buf.toString();
  const mouse = [...s.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)];
  if (mouse.length) { for (const m of mouse) if (m[4] === 'M') await handleMouse(+m[1], +m[2], +m[3]); }
  else await handleKey(s);
  draw();
});

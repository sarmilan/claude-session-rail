#!/usr/bin/env node
// The desk: a wider iTerm panel between Claude and the rail, with tabs for the work itself.
//   Plan  the branch's brief (brief.mjs) with its Approve button; without one, the board's Todo issues, then
//         the plan plan mode is writing (live, from the session's transcript) or recent work
//   Diff  every file changed since the branch forked from the default branch, grouped by the brief's chunks,
//         and each file's diff
//   Review  the branch's review record: the approach reviews (reviewer.mjs) Claude runs before each commit, or
//           you run on demand, and the code reviews the hooks record, each finding open, applied or declined
// It opens on Plan; tabs change only when you switch them (Tab, 1 2 3, or a click).
//   node desk.mjs                                   interactive panel
//   node desk.mjs --json                            print the collected state once
//   node desk.mjs --frame [W H] [--tab plan|diff|review] [--file N]   print one rendered frame (no TTY needed)
//     [--review-json F --select N --jump N]          …with a saved review record (reviewer.mjs's store shape)
//   --cwd DIR / --pid PID                           the folder and Claude process this desk belongs to
import * as src from './sources.mjs';
import { reviewAndSave, loadReviews } from './reviewer.mjs';
import { ESC, fg, dim, bold, C, charWidth, width, trunc, clean } from './term.mjs';
import { applySaved } from './fontsize.mjs';
import { approvalRecord } from './brief.mjs';
import { codeFindings, runType } from './cadence.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cwd = flag('--cwd') || process.cwd();
const pinnedPid = Number(flag('--pid')) || null;
const taskIndex = new src.TaskIndex();

// ── Data ───────────────────────────────────────────────────────────────────────
const data = { plan: null, brief: null, recent: null, todos: null, root: null, files: [], diff: null, claude: null, // diff: { path, lines } of the open file
  review: { running: null, runs: [], path: undefined } };                    // runs: the branch's saved reviews, newest first
const TABS = ['plan', 'diff', 'review'];
const ui = { tab: 'plan', scroll: { plan: 0, diff: 0, review: 0 }, sel: 0, open: null, toast: null,
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

// A changed plan brings up Plan and changed files bring up Diff, unless the person picked a tab themselves.
// Plan wins a near-tie, so a file save right after the plan doesn't pull the view away from it.
const loaders = {
  async plan() {
    const agents = await src.sessions();
    const current = (pinnedPid && agents.find((a) => a.pid === pinnedPid)) || src.currentSession(agents, cwd);
    data.claude = current;
    await taskIndex.update((await src.sessionFiles(current)).transcriptPath);
    [data.plan, data.brief] = await Promise.all([src.readPlan(taskIndex.planPath), src.readBrief(cwd)]);
    if (changed('plan', `${data.plan ? `${data.plan.path}:${data.plan.mtime}` : ''}|${data.brief?.mtime ?? ''}`)) {
      ui.scroll.plan = 0;
    }
  },
  // What landed lately, for the Plan tab before there's a plan. gh is slow, so this refreshes rarely.
  // And the Todo issues on the repo's board, shown until the branch has a brief.
  async recent() {
    if (!data.plan || !data.recent) data.recent = await src.recentWork(cwd);
    if (!data.brief?.text || !data.todos) data.todos = await src.todos(cwd);
  },
  async diff() {
    ({ root: data.root, files: data.files } = await src.branchFiles(cwd));
    // Until the person moves it, the selection starts on the first file shown (the list is grouped by chunk).
    if (!ui.picked || !data.files[ui.sel]) ui.sel = diffOrder()[0] ?? 0;
    if (ui.open) await loadFile(ui.open);
  },
  // The branch's review record, read again on each refresh: Claude's reviews and the hooks' code reviews
  // land in it from outside. The selection resets only when the branch changes.
  async reviews() {
    const path = await src.reviewsPath(cwd), runs = await loadReviews(path);
    if (path === data.review.path && JSON.stringify(runs) === JSON.stringify(data.review.runs)) return;
    // On the same branch the list can grow or reorder under the selection: keep it on the same finding.
    const id = path === data.review.path ? listedAll()[ui.rsel]?.id : undefined;
    if (path !== data.review.path) { ui.rsel = 0; ui.scroll.review = 0; }
    data.review = { ...data.review, runs, path };
    if (id !== undefined) { const all = listedAll(), at = all.findIndex((f) => f.id === id); ui.rsel = at >= 0 ? at : Math.max(0, Math.min(ui.rsel, all.length - 1)); }
  },
};

// ── Review: the branch's approach reviews and code reviews ───────────────────────
// The tab shows the newest successful approach review and the newest code review (type 'code', recorded by
// the hooks). A failed run is only kept as the newest entry, to say why it failed: it never hides the review
// before it, and failures can't push real reviews out of the history.
const approachRuns = () => data.review.runs.filter((r) => runType(r) === 'approach');
const latest = () => approachRuns().find((r) => !r.error) ?? null;
const failed = () => (approachRuns()[0]?.error ? approachRuns()[0] : null);
// What the tab lists, in order: the newest approach review's findings, then earlier approach findings that
// are still open or were raised on the same commit (this chunk's, with how they were settled), then the
// newest code review's. Selection and Enter (jump to the file) index into this list.
const codeRun = () => data.review.runs.find((r) => !r.error && runType(r) === 'code') ?? null;
function listed() {
  const run = latest();
  const earlier = approachRuns().filter((r) => !r.error && r !== run)
    .flatMap((r) => r.findings.filter((f) => f.status === 'open' || (f.status && run?.head && r.head === run.head)));
  return { approach: [...(run?.findings ?? []), ...earlier], code: codeFindings(data.review.runs) };
}
const listedAll = () => { const l = listed(); return [...l.approach, ...l.code]; };
// Returns why it couldn't start, or null when it started.
function startReview() {
  if (data.review.running) return 'A review is already running';
  if (!data.root) return 'Not a git repository';
  if (!data.brief?.text) return 'No brief to review yet';
  if (data.brief.status === 'draft') return `The brief is missing ${data.brief.missing.join(', ')}`;
  if (!data.review.path) return 'Still loading this branch’s reviews';
  const controller = new AbortController(), path = data.review.path;
  data.review.running = { controller, startedAt: Date.now() };
  void reportDesk({ kind: 'approach review', startedAt: data.review.running.startedAt });
  reviewAndSave(cwd, { brief: data.brief, files: data.files, manual: true, signal: controller.signal }).then((run) => {
    data.review.running = null;
    void reportDesk(null);
    // A cancelled run leaves the record alone; a saved one (failed too, so the tab says why) is shown if the
    // branch is still the one it reviewed.
    if (run.runs && path === data.review.path) { data.review.runs = run.runs; ui.rsel = 0; ui.scroll.review = 0; }
    draw();
  });
  return null;
}
const cancelReview = () => data.review.running?.controller.abort();

// The desk's own headless run, for the rail's Now section: <session id>.desk.json beside the hooks' activity
// file. It carries this desk's pid, so a desk that quits mid-review doesn't leave a review "running" forever.
const ACTIVITY = join(homedir(), '.claude', 'session-rail', 'activity');
async function reportDesk(review) {
  const id = data.claude?.sessionId;
  if (!id) return;
  try {
    await mkdir(ACTIVITY, { recursive: true });
    await writeFile(join(ACTIVITY, `${id}.desk.json`), JSON.stringify({ pid: process.pid, review, updatedAt: Date.now() }));
  } catch {}
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
// The Plan tab: the branch's brief when it has one, else plan mode's plan, else recent work.
function planLines(w) {
  const b = data.brief;
  if (b?.text != null) {
    const status = {
      draft: fg(C.yellow, `draft · missing: ${b.missing.join(', ')}`),
      ready: fg(C.accent, 'ready for your approval'),
      approved: fg(C.green, 'approved'),
      changed: fg(C.yellow, 'approved · changed since'),
    }[b.status];
    const approve = ['ready', 'changed'].includes(b.status) ? [button(b.status === 'ready' ? 'Approve' : 'Approve again', C.green) + dim('  or A'), ''] : [];
    return [bold('Brief') + dim(' · ') + status, ...approve, dim(trunc(src.tildify(b.path), w)), '', ...markdownLines(b.text, w, { brief: true })];
  }
  const note = [...(b ? [dim(trunc(`No brief for ${clean(b.branch)} yet: Claude writes one before editing code.`, w)), ''] : []), ...todoLines(w)];
  if (!data.plan) return [...note, ...recentLines(w)];
  return [...note, dim(src.tildify(data.plan.path)), '', ...markdownLines(data.plan.text, w)];
}
// Todo issues from the repo's project board, first thing at the start of a session.
function todoLines(w) {
  if (!data.todos?.length) return [];
  const out = [bold(fg(C.accent, 'Todo')) + dim(`  ${data.todos.length} · tell Claude which to take`), ''];
  for (const t of data.todos) {
    out.push(trunc(`${dim(`#${t.number}`)} ${clean(t.title)}`, w + 20));
    if (t.summary) out.push(dim('    ' + trunc(clean(t.summary), w - 4)));
  }
  return [...out, ''];
}
// Markdown as terminal lines. In a brief, code blocks (the mockups) keep full colour, a chunk's "Done:"
// line gets a tick and its "Files:" line is dimmed.
function markdownLines(text, w, { brief = false } = {}) {
  const out = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    const line = clean(raw);
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) { out.push((brief ? (s) => s : dim)('  ' + trunc(line, w - 2))); continue; }
    if (brief && /^Done:\s*/i.test(line)) { out.push(...wrapRuns(runs(line.replace(/^Done:\s*/i, '')), w, fg(C.green, '✔ '), '  ')); continue; }
    if (brief && /^Files:\s*/i.test(line)) { out.push(dim(trunc('  ' + line, w))); continue; }
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

// The changed files grouped by the brief's chunks, in chunk order, then "Not in a chunk yet". A file is
// selectable under the first chunk whose Files line lists it; a later chunk that lists it too shows it dimmed
// (`shared`), so every chunk stays visible. With no brief (or no chunk listing a changed file), one group of
// every file, as before. `files` and `shared` hold indices into data.files.
function diffGroups() {
  const placed = new Map(), groups = []; // file index → the chunk it's selectable under
  for (const c of data.brief?.text ? data.brief.chunks : []) {
    const listed = data.files.map((f, i) => (c.files.includes(f.path) ? i : -1)).filter((i) => i >= 0);
    if (!listed.length) continue;
    const files = listed.filter((i) => !placed.has(i)), shared = listed.filter((i) => placed.has(i));
    files.forEach((i) => placed.set(i, c.n));
    groups.push({ chunk: c, files, shared, placed });
  }
  const rest = data.files.map((_, i) => i).filter((i) => !placed.has(i));
  if (rest.length) groups.push({ chunk: null, files: rest, shared: [], placed });
  return groups;
}
// The files in the order the list shows them, for moving the selection.
const diffOrder = () => diffGroups().flatMap((g) => g.files);
const stepFile = (d) => { ui.picked = true; const o = diffOrder(), at = o.indexOf(ui.sel); return o[Math.max(0, Math.min(o.length - 1, (at < 0 ? 0 : at) + d))] ?? 0; };

function listLines(w) {
  if (!data.root) return { lines: [dim('Not a git repository.')], ids: [] };
  if (!data.files.length) return { lines: [dim('No changes since this branch forked.')], ids: [] };
  const { a, r } = totals();
  const lines = [dim(`${data.files.length} file${data.files.length === 1 ? '' : 's'} since the branch forked  `) + counts(a, r), ''];
  const ids = [null, null];
  const groups = diffGroups(), grouped = groups.some((g) => g.chunk);
  const fileRow = (i, indent, seeChunk) => {
    const f = data.files[i];
    const tag = f.status === 'new' ? fg(C.blue, 'new ') : f.status === 'binary' ? dim('bin ') : '    ';
    if (seeChunk) { // listed here too, selectable under an earlier chunk
      const right = `in chunk ${seeChunk}`, name = trunc(clean(f.path), w - 2 - indent - width(tag) - width(right));
      lines.push(dim(' '.repeat(indent) + tag + name + ' '.repeat(Math.max(1, w - indent - width(tag) - width(name) - width(right))) + right));
      ids.push(null);
      return;
    }
    const right = f.status === 'binary' ? dim('binary') : counts(f.added, f.removed);
    const path = clean(f.path), slash = path.lastIndexOf('/');
    const room = w - 2 - indent - width(tag) - width(right);
    const name = trunc(path, room);
    const styled = slash >= 0 && name === path ? dim(path.slice(0, slash + 1)) + path.slice(slash + 1) : name;
    lines.push(' '.repeat(indent) + tag + styled + ' '.repeat(Math.max(1, room - width(name) + 2)) + right);
    ids.push(i);
  };
  for (const g of groups) {
    if (grouped) {
      // The chunk's heading with its lines changed, then its Done summary.
      // Lines changed in the files selectable here; a shared file counts once, under its first chunk.
      const sum = g.files.reduce((t, i) => ({ a: t.a + data.files[i].added, r: t.r + data.files[i].removed }), { a: 0, r: 0 });
      const right = g.files.length ? counts(sum.a, sum.r) : '', title = g.chunk ? `Chunk ${g.chunk.n}: ${clean(g.chunk.name)}` : 'Not in a chunk yet';
      const head = trunc(title, w - width(right) - 2);
      lines.push((g.chunk ? bold(fg(C.accent, head)) : bold(dim(head))) + ' '.repeat(Math.max(2, w - width(head) - width(right))) + right);
      ids.push(null);
      if (g.chunk?.done) for (const l of wrapRuns(runs(g.chunk.done), w, fg(C.green, '✔ '), '  ')) { lines.push(dim(l)); ids.push(null); }
      else if (g.chunk) { lines.push(dim('  in progress')); ids.push(null); }
    }
    for (const i of g.files) fileRow(i, grouped ? 2 : 0);
    for (const i of g.shared) fileRow(i, 2, g.placed.get(i));
    if (grouped) { lines.push(''); ids.push(null); }
  }
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
// A finding's status label: open, applied or declined (fixed / no change for a code review's); a finding
// saved before the cadence shows its severity, or accepted.
// A code finding whose fixer settled it but the approach review hasn't judged yet: still pending for the gate.
const toCheck = (f, code) => code && !f.checked && (f.status === 'applied' || f.status === 'declined');
function statusLabel(f, code) {
  if (toCheck(f, code))
    return [`◌ ${f.status === 'applied' ? 'fixed' : f.outcome === 'skipped' ? 'skipped' : 'no change'} · to check`, C.yellow];
  if (f.status === 'applied') return [code ? '✓ fixed' : '✓ applied', C.green];
  if (f.status === 'declined') return [code ? (f.outcome === 'skipped' ? '✓ skipped' : '✓ no change') : '✗ declined', C.gray];
  if (f.status === 'open') return ['● open', C.yellow];
  return f.acceptedAt ? ['✓ accepted', C.green] : [`● ${f.severity}`, SEV[f.severity] ?? C.gray];
}
function reviewLines(w) {
  const { running } = data.review, run = latest(), fail = failed(), code = codeRun(), list = listed();
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

  // The action row: Run (or the running review), and when each kind of review last ran, as far as it fits.
  const parts = [running ? { action: 'cancel', label: `◌ Reviewing… ${Math.round((Date.now() - running.startedAt) / 1000)}s · x cancel`, colour: C.accent }
    : { action: 'run', label: fail ? '↻ Retry review' : run ? '↻ Run again' : '▶ Run review', colour: C.accent }];
  const used = width(parts[0].label) + 2;
  const status = [run && `approach ${ago(run.finishedAt)}`, code && `code ${ago(code.finishedAt)}`].filter(Boolean);
  while (status.length && used + 2 + width(status.join(' · ')) > w) status.pop();
  if (status.length && !running) parts.push({ text: '  ' + dim(status.join(' · ')), plain: '  ' + status.join(' · ') });
  row(parts);
  push('');
  if (fail) { for (const l of wrapRuns([{ t: `✗ The last review failed: ${clean(fail.error)}`, s: 'text' }], w)) push(fg(C.red, l)); push(''); }
  if (!run && !code && !fail) {
    const text = data.brief?.text
      ? 'No reviews yet. Claude runs the approach review (the brief and its finished chunks, judged by a staff engineer) on the plan and after each chunk, and /code-review over the whole branch before the merge. Run review checks the approach now (under a minute).'
      : 'Reviews follow the branch\'s brief: an approach review on the plan and after each chunk, and a code review of the whole branch before the merge. This branch has no brief yet.';
    for (const l of wrapRuns([{ t: text, s: 'text' }], w)) push(dim(l));
  }

  // One finding: its status and where it is, the title, the detail, and a declined one's reason.
  let n = 0;
  const finding = (f, isCode) => {
    const i = n++, [label, colour] = statusLabel(f, isCode);
    const where = isCode ? `${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} · ` : ''}${f.kind}` : `${f.chunk ? `chunk ${f.chunk} · ` : 'whole plan · '}${f.kind}`;
    push(fg(colour, label) + '  ' + dim(trunc(clean(where), Math.max(4, w - width(label) - 2))), i);
    const settled = ((f.status === 'applied' || f.status === 'declined') && !toCheck(f, isCode)) || f.acceptedAt;
    for (const l of wrapRuns(runs(f.title, 'text').map((r) => ({ ...r, s: r.s === 'text' && !settled ? 'bold' : r.s })), w, '    ')) push(settled ? dim(l) : l, i);
    if (f.detail && !settled) for (const l of wrapRuns([{ t: clean(f.detail), s: 'text' }], w, '    ')) push(dim(l), i);
    if (f.note) for (const l of wrapRuns([{ t: `“${clean(f.note)}”`, s: 'text' }], w, '    ')) push(dim(l), i);
    push('');
  };
  const openCount = (l) => l.filter((f) => f.status === 'open').length;
  const heading = (t) => push(bold(t) + ' ' + dim('─'.repeat(Math.max(0, w - width(t) - 1))));
  if (run || list.approach.length) {
    const o = openCount(list.approach);
    heading(`Approach${o ? ` · ${o} open` : ''}`);
    if (run) {
      const [label, colour] = { 'on-track': ['✓ On track', C.green], 'simpler-path': ['◆ A simpler path exists', C.yellow], 'off-goal': ['✗ Off the goal', C.red] }[run.verdict] ?? ['◆ Reviewed', C.gray];
      push(bold(fg(colour, label)) + (run.final ? dim('  final') : ''));
      if (run.summary) for (const l of wrapRuns([{ t: clean(run.summary), s: 'text' }], w)) push(l);
      push('');
    }
    for (const f of list.approach) finding(f, false);
  }
  if (code) {
    const o = openCount(list.code);
    heading(`Code review · ${list.code.length ? `${list.code.length} finding${list.code.length === 1 ? '' : 's'}${o ? `, ${o} open` : ''}` : 'no findings'}`);
    push('');
    for (const f of list.code) finding(f, true);
  }

  // Earlier runs of either kind, one line each.
  const earlier = data.review.runs.filter((r) => !r.error && r !== run && r !== code);
  if (earlier.length) {
    push(dim('── Earlier reviews ' + '─'.repeat(Math.max(0, w - 19))));
    for (const r of earlier) {
      const t = r.findings.length, count = (st) => r.findings.filter((f) => f.status === st).length;
      const tally = r.findings.some((f) => f.status) ? [count('applied') && `${count('applied')} applied`, count('declined') && `${count('declined')} declined`, count('open') && `${count('open')} open`].filter(Boolean).join(', ') : '';
      push(dim(trunc(`${when(r.startedAt)} · ${r.type === 'code' ? 'code' : 'approach'} · ${t} finding${t === 1 ? '' : 's'}${tally ? ` · ${tally}` : ''}`, w)));
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
  const nf = listedAll().filter((f) => f.status === 'open').length;
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

  let body, ids = [], buttons = [], target = -1;
  if (ui.tab === 'plan') {
    body = planLines(w);
    // The Approve button, when the brief has one: the second line, at the left edge.
    if (['ready', 'changed'].includes(data.brief?.status)) buttons = [{ row: 1, from: 0, to: data.brief.status === 'ready' ? 9 : 15, action: 'approve' }];
  }
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

  // The bottom line: a toast on the left, how to get around on the right (iTerm's own pane keys, and the
  // tab keys), dropped when the toast needs the room. Cut the plain text before styling: a line past the
  // last column would scroll the screen.
  const keys = '⌘[ ⌘] panels · tab or 1 2 3 tabs';
  const toastText = ui.toast && ui.toast.until > Date.now() ? trunc(` ${ui.toast.text}`, W - 1) : '';
  const room = W - 1 - width(toastText) - width(keys);
  const footer = fg(C.green, toastText) + (room >= (toastText ? 2 : 0) ? ' '.repeat(room) + dim(keys) : '');
  layout = { tabs, tabRow: 2, body: 3, ids: ids.slice(scroll, scroll + bodyH), scroll, bodyH,
    buttons: buttons.filter((b) => b.row >= scroll && b.row < scroll + bodyH).map((b) => ({ ...b, row: b.row - scroll })) };
  const rule = ' ' + dim('─'.repeat(w));
  return [rule, ' ' + bar, rule, ...view, footer];
}

// ── Modes ──────────────────────────────────────────────────────────────────────
if (args.includes('--json')) {
  const d = await collect();
  const cut = (x) => x?.text && { ...x, text: `${x.text.slice(0, 200)}…` };
  console.log(JSON.stringify({ ...d, plan: cut(d.plan) ?? d.plan, brief: cut(d.brief) ?? d.brief }, null, 2));
  process.exit(0);
}

const pick = (tab) => { if (TABS.includes(tab)) ui.tab = tab; };
const openFile = async (i) => {
  const f = data.files[i];
  if (!f) return;
  ui.sel = i; ui.picked = true; ui.open = f.path; ui.scroll.file = 0;
  await loadFile(f.path);
};

// Open a finding's file in the Diff tab, scrolled to its line.
async function jumpTo(i) {
  const f = listedAll()[i];
  // A code review may name the file absolutely or with ./ in front; the diff's paths are repo-relative.
  const rel = f?.file && data.root && f.file.startsWith(`${data.root}/`) ? f.file.slice(data.root.length + 1) : f?.file?.replace(/^\.\//, '');
  const at = data.files.findIndex((x) => x.path === rel);
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
// A desk opened after a font size was chosen in the rail joins it (after pane.mjs has sized the splits).
setTimeout(() => applySaved(pinnedPid), 3000);

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
};
const manual = (tab) => { ui.tab = tab; };
const scrollBy = (d) => { const key = ui.tab === 'diff' && ui.open ? 'file' : ui.tab; ui.scroll[key] = (ui.scroll[key] ?? 0) + d; };
const move = (d) => {
  const n = listedAll().length;
  if (ui.tab === 'review') { if (n) ui.rsel = Math.max(0, Math.min(n - 1, ui.rsel + d)); else scrollBy(d); return; }
  if (ui.tab === 'diff' && !ui.open && data.files.length) ui.sel = stepFile(d);
  else scrollBy(d);
};
const page = () => Math.max(1, (layout.bodyH ?? 10) - 2);

// A on the Plan tab: the same as /approve-brief. Approval opens code edits on this branch (see hooks/register.ts).
const approveBrief = async () => {
  const b = data.brief;
  if (!b?.text) return toast('No brief to approve');
  if (b.status === 'draft') return toast(`Can't approve yet: missing ${b.missing.join(', ')}`);
  if (b.status === 'approved') return toast('Already approved');
  try { await writeFile(b.approvedPath, approvalRecord(b, Date.now())); } catch { return toast("Couldn't save the approval"); }
  await runners.plan();
  // The hooks notice the approval and tell Claude (hooks/goahead.ts).
  toast(b.status === 'changed' ? 'Change approved: Claude will carry on' : 'Brief approved: Claude is starting on chunk 1');
};

const handleKey = async (k) => {
  if (k === '\x03' || k === 'q') return quit();
  if (k === '\t') return manual(TABS[(TABS.indexOf(ui.tab) + 1) % TABS.length]);
  if (k === '\x1b[Z') return manual(TABS[(TABS.indexOf(ui.tab) + TABS.length - 1) % TABS.length]);
  if (k === '1' || k === '2' || k === '3') return manual(TABS[+k - 1]);
  if (ui.tab === 'review') {
    const findings = listedAll();
    if (k === 'r') return review('run');
    if (k === 'x') return review('cancel');
    if ((k === '\r' || k === 'l' || k === '\x1b[C') && findings[ui.rsel]?.file) return jumpTo(ui.rsel);
  }
  if (ui.tab === 'plan' && k === 'A') return approveBrief();
  if (k === 'r') { Object.values(runners).forEach((f) => f()); return toast('Refreshing…'); }
  if (k === '\x1b[A' || k === 'k') return move(-1);
  if (k === '\x1b[B' || k === 'j') return move(1);
  if (k === '\x1b[5~' || k === 'b') return scrollBy(-page());
  if (k === '\x1b[6~' || k === ' ') return scrollBy(page());
  if (k === 'g') { const key = ui.tab === 'diff' && ui.open ? 'file' : ui.tab; ui.scroll[key] = 0; if (!ui.open) ui.sel = diffOrder()[0] ?? 0; return; }
  if (k === 'G') { const key = ui.tab === 'diff' && ui.open ? 'file' : ui.tab; ui.scroll[key] = 1e9; if (!ui.open) ui.sel = diffOrder().at(-1) ?? 0; return; }
  if (ui.tab !== 'diff') return;
  if (ui.open) {
    if (k === '\x1b' || k === 'h' || k === '\x1b[D') { ui.open = null; ui.jump = null; data.diff = null; return; }
    if (k === 'n') return openFile(stepFile(1));
    if (k === 'p') return openFile(stepFile(-1));
  } else if (k === '\r' || k === 'l' || k === '\x1b[C') return openFile(ui.sel);
};

const handleMouse = async (b, x, y) => {
  if (b === 64) return move(-3);
  if (b === 65) return move(3);
  if (b !== 0) return;
  if (y === layout.tabRow) { const t = layout.tabs.find((s) => x - 1 >= s.from && x - 1 < s.to); if (t) manual(t.tab); return; }
  const i = layout.ids[y - 1 - layout.body];
  if (ui.tab === 'diff' && !ui.open && i != null) return openFile(i);
  if (ui.tab === 'plan' && layout.buttons.some((s) => s.row === y - 1 - layout.body && x - 2 >= s.from && x - 2 < s.to)) return approveBrief();
  if (ui.tab === 'review') {
    const b = layout.buttons.find((s) => s.row === y - 1 - layout.body && x - 2 >= s.from && x - 2 < s.to);
    if (b) return review(b.action);
    if (i != null) { if (ui.rsel === i && listedAll()[i]?.file) return jumpTo(i); ui.rsel = i; }
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

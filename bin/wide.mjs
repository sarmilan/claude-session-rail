// Optional wide review: a large diff can fan out cheap file-level reviewers, then one skeptic that
// declines weak findings, and the survivors are one report in the branch's review record (cadence.mjs).
// Off unless settings.wideReview is true. Pure, no Node APIs: shared by the runner, the desk and the rail.
import { clean } from './term.mjs';

// A diff is wide at either of these. Both are inclusive: 8 files is wide, and so is 400 changed lines.
export const WIDE_FILES = 8;
export const WIDE_LINES = 400;
// Four slices is a fan-out. Past that, files share a slice instead of starting another reviewer.
export const MAX_SLICES = 4;
export const MAX_FINDINGS_PER_SLICE = 8;

const oneLine = (s, max) => clean(String(s ?? '')).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const block = (s, max) => clean(String(s ?? '')).trim().slice(0, max);

export function diffSize(files) {
  const list = Array.isArray(files) ? files : [];
  let lines = 0;
  for (const f of list) lines += (Number(f?.added) || 0) + (Number(f?.removed) || 0);
  return { files: list.length, lines };
}

// `limits` overrides the constants in tests. A diff is wide when either count is reached.
export function isWide(files, limits = {}) {
  const size = diffSize(files);
  const filesAt = Number.isInteger(limits.files) && limits.files > 0 ? limits.files : WIDE_FILES;
  const linesAt = Number.isInteger(limits.lines) && limits.lines > 0 ? limits.lines : WIDE_LINES;
  return size.files >= filesAt || size.lines >= linesAt;
}

// Missing or false stays off. Only an explicit true turns the desk's Wide review on.
export const wideEnabled = (settings) => settings?.wideReview === true;

// A model name the runner may pass through. Anything else is ignored and the usual model is used.
export function wideModel(settings) {
  const name = settings?.wideModel;
  return typeof name === 'string' && /^[\w.:-]{1,80}$/.test(name) ? name : null;
}

export function thresholdReason(files) {
  const size = diffSize(files);
  return `This diff is under the wide-review threshold (${WIDE_FILES} files or ${WIDE_LINES} lines; this one is ${size.files} files, ${size.lines} lines).`;
}

// The desk offers the action only when it can actually run: the setting, a wide diff, and a brief
// that is past draft (the same bar as Run review).
export function offerWide(settings, files, brief) {
  return wideEnabled(settings) && isWide(files) && Boolean(brief?.text) && brief.status !== 'draft';
}

// Short label for a reviewer's row on the rail: the first file, and how many more share the slice.
export function sliceLabel(files) {
  const paths = (files ?? []).map((f) => f?.path).filter(Boolean);
  if (!paths.length) return 'files';
  const base = paths[0].split('/').pop();
  return paths.length === 1 ? base : `${base} +${paths.length - 1}`;
}

// At most `max` slices. The largest files are placed first, each into the lightest slice, so one
// huge file does not share a reviewer with the rest of the diff. Every path appears once.
export function sliceFiles(files, max = MAX_SLICES) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && f.path);
  if (!list.length || max < 1) return [];
  const bins = Array.from({ length: Math.min(max, list.length) }, () => ({ files: [], lines: 0 }));
  const ranked = [...list].sort((a, b) => ((b.added || 0) + (b.removed || 0)) - ((a.added || 0) + (a.removed || 0)) || String(a.path).localeCompare(String(b.path)));
  for (const f of ranked) {
    let at = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].lines < bins[at].lines || (bins[i].lines === bins[at].lines && bins[i].files.length < bins[at].files.length)) at = i;
    }
    bins[at].files.push(f);
    bins[at].lines += (f.added || 0) + (f.removed || 0);
  }
  return bins
    .map((b) => ({ files: b.files.sort((a, c) => String(a.path).localeCompare(String(c.path))), lines: b.lines }))
    .sort((a, b) => String(a.files[0]?.path).localeCompare(String(b.files[0]?.path)));
}

export function goalExcerpt(brief, max = 600) {
  return block([brief?.sections?.problem, brief?.sections?.solution].filter(Boolean).join('\n\n'), max);
}

export function filePrompt({ files, diff, goal }) {
  const names = (files ?? []).map((f) => f.path).filter(Boolean);
  return [
    'You are a file reviewer on one slice of a wide diff. Report only concrete bugs: correctness, security, or a broken edge case.',
    'Do not report style, naming, or refactors. If nothing is wrong, return an empty findings list.',
    goal ? `\nThe branch goal:\n${goal}` : '',
    `\nFiles in this slice:\n${names.join('\n') || '(none)'}`,
    `\nDiff:\n${diff || '(no diff text)'}`,
  ].filter(Boolean).join('\n');
}

export function skepticPrompt({ findings, goal }) {
  const list = (findings ?? []).map((f, i) => `${i}. ${f.file || 'file'}${Number.isInteger(f.line) ? `:${f.line}` : ''} ${f.title}${f.detail ? `\n${f.detail}` : ''}`).join('\n');
  return [
    'You are the skeptic on a wide review. Other reviewers reported the findings below.',
    'Kill any finding that is style, a duplicate, speculative, or not grounded in the diff. Keep a finding only when it names a real bug.',
    'Return the indexes you kill and a short note for each. Leave a finding out of the killed list to keep it.',
    goal ? `\nThe branch goal:\n${goal}` : '',
    `\nFindings:\n${list || '(none)'}`,
  ].filter(Boolean).join('\n');
}

const RANK = { high: 0, medium: 1, low: 2 };
// The file reviewer's JSON, or null when it has no findings list. High severity is kept when the list is capped.
export function findingsFromPayload(payload, slicePaths = []) {
  const list = Array.isArray(payload?.findings) ? payload.findings : null;
  if (!list) return null;
  const fallback = slicePaths.length === 1 ? slicePaths[0] : null;
  return list.filter((f) => f && typeof f.title === 'string' && f.title.trim()).map((f) => ({
    file: typeof f.file === 'string' && f.file.trim() ? oneLine(f.file, 200) : fallback,
    line: Number.isInteger(f.line) ? f.line : null,
    severity: RANK[f.severity] != null ? f.severity : 'medium',
    title: oneLine(f.title, 160),
    detail: block(typeof f.detail === 'string' ? f.detail : '', 500),
  })).sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, MAX_FINDINGS_PER_SLICE);
}

// The skeptic's JSON, or null when it is not a verdict. An empty killed list keeps every finding.
export function killedFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Array.isArray(payload.killed) && typeof payload.summary !== 'string') return null;
  const killed = (Array.isArray(payload.killed) ? payload.killed : []).filter((k) => k && Number.isInteger(k.index)).map((k) => ({
    index: k.index,
    note: oneLine(typeof k.note === 'string' && k.note.trim() ? k.note : 'The skeptic dropped this.', 240),
  }));
  return { summary: oneLine(typeof payload.summary === 'string' ? payload.summary : '', 300), killed };
}

// One wide run. A killed finding is declined with the skeptic's note; the rest stay open. Indexes the
// skeptic didn't name are kept. The runs list is newest first, and only this newest wide run counts.
export function settleWide(candidates, killed, { at = 0, head = null, dirty = false, summary } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const notes = new Map();
  for (const k of killed ?? []) {
    if (!k || !Number.isInteger(k.index) || k.index < 0 || k.index >= list.length || notes.has(k.index)) continue;
    notes.set(k.index, oneLine(k.note || 'The skeptic dropped this.', 240));
  }
  const findings = list.map((c, i) => {
    const dropped = notes.has(i);
    return {
      id: `w${Number(at).toString(36)}-${i}`,
      kind: 'correctness',
      title: oneLine(c?.title || 'Finding', 160),
      detail: block(c?.detail || '', 500),
      severity: RANK[c?.severity] != null ? c.severity : 'medium',
      file: typeof c?.file === 'string' && c.file ? oneLine(c.file, 200) : null,
      line: Number.isInteger(c?.line) ? c.line : null,
      status: dropped ? 'declined' : 'open',
      ...(dropped ? { note: notes.get(i) } : {}),
    };
  });
  const open = findings.filter((f) => f.status === 'open').length;
  const dropped = findings.length - open;
  return {
    type: 'wide', manual: true, wide: true, startedAt: at, finishedAt: at, head, dirty,
    verdict: open ? 'open-findings' : 'clean',
    summary: oneLine(summary || (findings.length ? `${open} kept, ${dropped} declined by the skeptic` : 'No findings'), 300),
    findings,
  };
}

// Reviewers the desk wrote beside its own row, folded into the activity file's agents so the rail
// draws them as named subagents (and a visitor each) without a second record. A session agent with
// the same id wins. Ended reviewers stay in the list so the finished ones remain under the live ones.
export function mergeReviewerAgents(agents, reviewers) {
  const out = { ...(agents ?? {}) };
  for (const r of reviewers ?? []) {
    if (!r?.id || out[r.id]) continue;
    const name = oneLine(r.name, 40);
    if (!name) continue;
    const row = {
      name,
      colour: typeof r.colour === 'number' || (Array.isArray(r.colour) && r.colour.length === 3) ? r.colour : null,
      what: oneLine(r.what, 80),
      since: Number.isFinite(r.since) ? r.since : 0,
      background: true,
      prompt: oneLine(r.prompt, 500),
      reply: oneLine(r.reply, 500),
    };
    if (Number.isFinite(r.endedAt)) row.endedAt = r.endedAt;
    out[r.id] = row;
  }
  return out;
}

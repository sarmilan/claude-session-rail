// The session brief: the branch's goal, design and engineering chunks, written by Claude before it edits
// code. Pure functions only (no Node APIs), so the desk (through sources.mjs) and the hooks module read it
// the same way.
//
// The brief lives inside the repo's shared git dir, so it's never committed:
//   <git common dir>/session-rail/briefs/<branch>.md             the brief
//   <git common dir>/session-rail/briefs/<branch>.approved.json  { approvedAt, core } once the person approves
// Its sections are fixed headings (## Problem, Solution, Design, Mockups, Engineering). Engineering holds
// "### Chunk N: name" blocks, each an outline plus, once built, "Done: summary" and "Files: a, b".
// main/master and a detached HEAD have no brief.

export const BRIEF_SECTIONS = ['problem', 'solution', 'design', 'mockups', 'engineering'];
export const NO_BRIEF_BRANCHES = ['main', 'master', 'HEAD', 'detached'];
const REQUIRED = { problem: 'problem', solution: 'user story', engineering: 'engineering outline' };

/** @param {string} common the git common dir @param {string} branch @param {'md' | 'approved.json'} ext */
export const briefFile = (common, branch, ext) => `${common}/session-rail/briefs/${encodeURIComponent(branch)}.${ext}`;

/**
 * @param {string} text
 * @returns {{ title: string, sections: Record<string, string>, missing: string[],
 *   chunks: { n: number, name: string, outline: string, done: string, files: string[] }[] }}
 */
export function parseBrief(text) {
  /** @type {Record<string, string[]>} */
  const lines = {};
  let title = '', at = null, fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h1 = !fence && /^#\s+(.*)$/.exec(line), h2 = !fence && /^##\s+(.*)$/.exec(line);
    if (h1 && !title) { title = h1[1].trim(); continue; }
    if (h2) { const key = h2[1].trim().toLowerCase(); at = BRIEF_SECTIONS.includes(key) ? key : null; if (at) lines[at] = []; continue; }
    if (at) lines[at].push(line);
  }
  /** @type {Record<string, string>} */
  const sections = Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.join('\n').trim()]));
  /** @type {{ n: number, name: string, outline: any, done: string, files: string[] }[]} */
  const chunks = [];
  fence = false;
  for (const line of (sections.engineering ?? '').split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^###\s+(?:Chunk\s+)?(\d+)\s*[:.\-–]?\s*(.*)$/i.exec(line);
    if (h) { chunks.push({ n: +h[1], name: h[2].trim(), outline: [], done: '', files: [] }); continue; }
    const c = chunks.at(-1);
    if (!c) continue;
    const done = /^Done:\s*(.*)$/i.exec(line), files = /^Files:\s*(.*)$/i.exec(line);
    if (done) c.done = done[1].trim();
    else if (files) c.files = files[1].split(',').map((f) => f.trim().replace(/^`|`$/g, '')).filter(Boolean);
    else c.outline.push(line);
  }
  for (const c of chunks) c.outline = c.outline.join('\n').trim();
  const missing = Object.entries(REQUIRED)
    .filter(([k]) => !sections[k] || (k === 'engineering' && !chunks.some((c) => c.outline)))
    .map(([, label]) => label);
  return { title, sections, chunks, missing };
}

/**
 * What approval covers: the problem, the solution and each chunk's outline. Claude adding Done/Files lines
 * as it works leaves this unchanged; rewriting the goal or the plan changes it.
 * @param {ReturnType<typeof parseBrief>} brief
 */
export const briefCore = (brief) => JSON.stringify({
  problem: brief.sections.problem ?? '', solution: brief.sections.solution ?? '',
  chunks: brief.chunks.map((c) => `${c.n}: ${c.name}\n${c.outline}`),
});

/** The approval record to save. @param {ReturnType<typeof parseBrief>} brief @param {number} now */
export const approvalRecord = (brief, now) => JSON.stringify({ approvedAt: now, core: briefCore(brief) });

/**
 * @param {ReturnType<typeof parseBrief>} brief
 * @param {{ approvedAt?: number, core?: string } | null} approval
 * @returns {'draft' | 'ready' | 'approved' | 'changed'}
 */
export function briefStatus(brief, approval) {
  if (approval?.approvedAt) return approval.core === briefCore(brief) ? 'approved' : 'changed';
  return brief.missing.length ? 'draft' : 'ready';
}

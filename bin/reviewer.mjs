// The desk's approach reviewer: a headless `claude -p` playing a staff engineer who judges whether the branch
// takes the simplest, most elegant and least costly way to the goal in its brief. It reads the brief, each
// chunk's Done/Files record and the diff size per file; it doesn't review code line by line (the code review
// in /end does that). It saves no session and loads no MCP servers. Reviews are kept per branch so the Review
// tab is a record of what was found and accepted.
// Every export resolves (never throws); a failed review comes back as { error }.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { briefCore } from './brief.mjs';
import { KEEP_RUNS, STATUSES, applyChecks, openFindings, staffCheck, trackFindings, uncheckedFixes } from './cadence.mjs';
import { branchFiles, readBrief, reviewsPath, run as exec } from './sources.mjs';

export const KINDS = ['simpler', 'scope', 'cost', 'goal-gap', 'elegance'];
export const VERDICTS = ['on-track', 'simpler-path', 'off-goal'];
// `--json-schema` makes claude end with a StructuredOutput call matching this.
const SCHEMA = JSON.stringify({
  type: 'object', required: ['verdict', 'summary', 'findings', 'checks'],
  properties: {
    verdict: { enum: VERDICTS }, summary: { type: 'string' },
    checks: { type: 'array', items: {
      type: 'object', required: ['id', 'status', 'note'],
      properties: { id: { type: 'string' }, status: { enum: STATUSES }, note: { type: 'string' } } } },
    findings: { type: 'array', items: {
      type: 'object', required: ['kind', 'chunk', 'severity', 'title', 'detail'],
      properties: {
        kind: { enum: KINDS }, chunk: { type: ['integer', 'null'] },
        severity: { enum: ['high', 'medium', 'low'] }, title: { type: 'string' }, detail: { type: 'string' },
      } } },
  },
});

const RANK = { high: 0, medium: 1, low: 2 };
function normalise(list) {
  if (!Array.isArray(list)) return null;
  return list.filter((f) => f && typeof f.title === 'string').map((f) => ({
    kind: KINDS.includes(f.kind) ? f.kind : 'simpler',
    chunk: Number.isInteger(f.chunk) && f.chunk > 0 ? f.chunk : null,
    severity: RANK[f.severity] != null ? f.severity : 'medium',
    title: f.title,
    detail: typeof f.detail === 'string' ? f.detail : '',
  })).sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

// The changed files with their size, and which chunks list each, for the reviewer's prompt.
function fileTable(brief, files) {
  if (!files.length) return 'No files changed yet.';
  return files.map((f) => {
    const chunks = brief.chunks.filter((c) => c.files.includes(f.path)).map((c) => c.n);
    return `${f.path}  +${f.added} −${f.removed}  ${chunks.length ? `(chunk ${chunks.join(', ')})` : '(no chunk)'}`;
  }).join('\n');
}

// What a review covered: the brief's goal and plan, and which chunks were done. The desk compares it with
// the brief as it is now to decide whether there's anything new to review.
export const reviewedState = (brief) => ({ core: briefCore(brief), done: brief.chunks.filter((c) => c.done).length });

// The earlier findings still open, for the reviewer to check, with Claude's reply where it gave one.
function earlierList(earlier) {
  return earlier.map((f) => `- id ${f.id} · ${f.kind}${f.chunk ? ` · chunk ${f.chunk}` : ''}: ${f.title}${f.detail ? `\n  ${f.detail}` : ''}`
    + (f.reply ? `\n  Claude's reply: ${f.reply}` : '')).join('\n');
}
const OUTCOME = { fixed: 'says it fixed this', skipped: 'skipped this', no_change_needed: 'says no change is needed' };
// The code review's findings, with what its fixer did about each one.
function codeList(code) {
  return code.map((f) => `- id ${f.id} · ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'code'}: ${f.title}${f.detail ? `\n  ${f.detail}` : ''}`
    + `\n  The fixer ${OUTCOME[f.outcome] ?? (f.status === 'open' ? 'left this open' : 'marked this ' + f.status)}.`
    + (f.checked && f.status === 'open' ? ' You reopened it earlier: check whether it is fixed now.' : '')
    + (f.reply ? `\n  Claude's reply: ${f.reply}` : '')).join('\n');
}

// Review the approach. `brief` is a parsed brief with its text (sources.readBrief), `files` the Diff tab's
// list, `earlier` the open findings of earlier reviews to check, `final` the review before the merge.
// Resolves { verdict, summary, findings, checks, core, done, startedAt, finishedAt, error? }. `signal` aborts it.
export async function reviewApproach(cwd, { brief, files = [], earlier = [], codeFindings = [], final = false, signal, timeoutMs = 540_000 } = {}) {
  const startedAt = Date.now();
  const result = { startedAt, ...reviewedState(brief), findings: [] };
  const prompt = `You are a staff engineer reviewing the approach this branch takes. You are not reviewing its code line by line: `
    + 'a separate code review checks correctness at the end of the session. The branch\'s brief states its goal and its plan '
    + 'in chunks; as each chunk is finished, a "Done:" line says what changed and why and a "Files:" line lists the files it touched.\n\n'
    + 'Judge whether this is the simplest, most elegant and least costly way to reach the goal in the Problem and Solution. Raise:\n'
    + '- simpler: a simpler design, an existing pattern or tool in the codebase, or fewer moving parts for the same result\n'
    + '- scope: work beyond what the goal needs, or a chunk that doesn\'t serve the goal\n'
    + '- cost: effort, runtime cost (model calls, processes, polling) or upkeep that a cheaper path avoids\n'
    + '- goal-gap: part of the Problem or Solution that the plan or the finished chunks don\'t cover\n'
    + '- elegance: an approach that will be hard to understand, change or extend\n'
    + 'Only raise what would change the approach; leave style and line-level bugs to the code review. Read code (Read, Grep, '
    + 'git diff) only to check a claim before making it. With no finished chunks yet, review the plan alone. Say on-track with '
    + 'no findings when the approach is sound: don\'t invent findings.\n\n'
    + `The brief:\n<brief>\n${brief.text}\n</brief>\n\n`
    + `Files changed since the branch forked (lines added and removed), and the chunk that lists each:\n${fileTable(brief, files)}\n\n`
    + (final ? 'This is the final review before the branch merges: judge the whole branch, as finished, against the Problem and Solution.\n\n' : '')
    + (earlier.length ? 'Earlier reviews raised these findings, and Claude was asked to apply each one. Check each against the code and the '
      + 'brief and return a check for it: applied (the work now does it), declined (Claude\'s reply gives a sound reason not to; say '
      + 'why you accept it) or open (not done, and no sound reason). Don\'t raise them again as new findings.\n'
      + `${earlierList(earlier)}\n\n` : '')
    + (codeFindings.length ? 'The code review (/code-review --fix) raised these findings. As the staff engineer, judge what its fixer did about each '
      + 'and return a check for it: applied (a claimed fix really landed in the code), declined (a skip or "no change needed" is sound; '
      + 'say why) or open (the fix didn\'t land, or it should be fixed after all; say why). Read the code to check. Don\'t raise them again as new findings.\n'
      + `${codeList(codeFindings)}\n\n` : '')
    + (earlier.length || codeFindings.length ? '' : 'There are no earlier findings to check: return an empty checks list.\n\n')
    + 'Return a verdict (on-track, simpler-path or off-goal), a summary of at most two sentences, and the findings, most '
    + 'important first, each with its chunk number (null when it is about the whole plan).';
  // Read-only whatever the user's settings say: no Edit/Write at all, Bash only for git, and dontAsk denies
  // anything else instead of waiting on a prompt nobody can answer (or allowing it under bypass settings).
  const argv = ['-p', prompt, '--output-format', 'json', '--json-schema', SCHEMA,
    '--no-session-persistence', '--strict-mcp-config', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Grep,Glob,Bash', '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git *)'];
  return new Promise((resolve) => {
    let out = '', err = '', settled = false, timer;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...result, finishedAt: Date.now(), ...r }); } };
    let child;
    try { child = spawn('claude', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal }); }
    catch (e) { return done({ error: `Couldn't start claude: ${e.message}` }); }
    timer = setTimeout(() => { child.kill(); done({ error: 'Review timed out' }); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => done({ error: e.name === 'AbortError' ? 'Review cancelled' : `Couldn't start claude: ${e.message}` }));
    child.on('close', (code) => {
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (j?.is_error) return done({ error: String(j.result || 'Review failed').slice(0, 200) });
      const o = j?.structured_output, findings = normalise(o?.findings);
      if (findings) {
        const ids = new Set([...earlier, ...codeFindings].map((f) => f.id));
        const checks = (Array.isArray(o.checks) ? o.checks : []).filter((c) => c && ids.has(c.id) && STATUSES.includes(c.status))
          .map((c) => ({ id: c.id, status: c.status, note: typeof c.note === 'string' ? c.note : '' }));
        return done({ findings, checks, verdict: VERDICTS.includes(o.verdict) ? o.verdict : findings.length ? 'simpler-path' : 'on-track',
          summary: typeof o.summary === 'string' ? o.summary : '' });
      }
      done({ error: code ? (err.trim().split('\n').pop() || `claude exited with ${code}`).slice(0, 200) : 'The reviewer replied without a findings list' });
    });
  });
}

// ── The branch's review record ────────────────────────────────────────────────
// A branch's file (sources.reviewsPath) holds { runs: [...] }, newest first: approach runs saved here and code
// runs the hooks record, in the shape cadence.mjs describes. Runs with no verdict (an old code review's) are
// dropped on load. Callers pass the path, so a review that finishes after a branch switch still lands in the
// file of the branch it reviewed.
export async function loadReviews(path) {
  try {
    // A hand-edited, older or half-written file must not break the tab: keep only well-formed runs.
    const runs = JSON.parse(await readFile(path, 'utf8'))?.runs;
    if (!Array.isArray(runs)) return [];
    return runs.filter((r) => r && Number.isFinite(r.startedAt) && Array.isArray(r.findings) && (r.verdict || r.error)).map((r) => ({
      ...r, findings: r.findings.filter((f) => f && typeof f.title === 'string'),
    }));
  } catch { return []; }
}
// Resolves true when written.
export async function saveReviews(path, runs) {
  try {
    if (!path) return false;
    await mkdir(dirname(path), { recursive: true });
    // Written beside it and renamed over it, so a reader never gets half a file.
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ runs: runs.slice(0, KEEP_RUNS) }, null, 1));
    await rename(tmp, path);
    return true;
  } catch { return false; }
}

// ── A review that's part of the cadence (bin/cadence.mjs) ─────────────────────
// Run an approach review of the branch in `cwd` and save it: the run records the commit it reviewed and
// whether the tree was dirty, its findings start open, and its checks mark the earlier findings. `notes`
// ([{ id, note }]) are Claude's replies to earlier findings it chose not to apply. The desk passes the brief
// and files it already has. Resolves the saved run with the branch's runs, or { error }.
export async function reviewAndSave(cwd, { final = false, notes = [], brief, files, signal } = {}) {
  const path = await reviewsPath(cwd);
  brief ??= await readBrief(cwd);
  if (!path || !brief?.text) return { error: 'This branch has no brief to review' };
  files ??= (await branchFiles(cwd)).files;
  const [head, status] = await Promise.all([exec('git', ['rev-parse', 'HEAD'], { cwd }), exec('git', ['status', '--porcelain'], { cwd })]);
  const replies = new Map((Array.isArray(notes) ? notes : []).filter((n) => n && typeof n.note === 'string').map((n) => [n.id, n.note]));
  const withReplies = (runs) => runs.map((r) => ({ ...r, findings: r.findings.map((f) => (replies.has(f.id) ? { ...f, reply: replies.get(f.id) } : f)) }));
  const prior = withReplies(await loadReviews(path));
  const earlier = openFindings(prior).approach, codeFindings = staffCheck(prior);
  const run = await reviewApproach(cwd, { brief, files, earlier, codeFindings, final, signal });
  if (run.error === 'Review cancelled') return run;
  const { checks = [], ...rest } = run;
  const saved = { ...rest, type: 'approach', final, head: head?.trim() ?? null, dirty: status === null || Boolean(status.trim()), // unknown counts as dirty
    findings: run.error ? [] : trackFindings(run.findings, run.startedAt) };
  // Read the file again: the review took a while, and the hooks may have recorded a code review meanwhile.
  // A failed run is kept only as the newest, to say why; it never pushes real reviews out.
  const runs = [saved, ...applyChecks(withReplies(await loadReviews(path)), checks).filter((r) => !r.error)];
  await saveReviews(path, runs);
  return { ...saved, checks, runs };
}

// What Claude reads back from review_approach: the verdict, the earlier findings checked, the new ones, and
// what's still open across the branch.
export function reviewText(result) {
  if (result.error) return `The approach review failed: ${result.error}`;
  const lines = [`Approach review: ${result.verdict}. ${result.summary}`.trim()];
  const all = new Map(result.runs.flatMap((r) => r.findings).map((f) => [f.id, f]));
  if (result.checks.length) {
    lines.push('', 'Earlier findings checked:');
    for (const c of result.checks) lines.push(`- ${c.id} ${c.status}: ${all.get(c.id)?.title ?? ''}${c.note ? ` (${c.note})` : ''}`);
  }
  if (result.findings.length) {
    lines.push('', 'New findings:');
    for (const f of result.findings) lines.push(`- ${f.id} [${f.severity}] ${f.kind}${f.chunk ? ` · chunk ${f.chunk}` : ''}: ${f.title}${f.detail ? `\n  ${f.detail}` : ''}`);
  }
  const { approach, code } = openFindings(result.runs), open = [...approach, ...code];
  const unchecked = uncheckedFixes(result.runs);
  if (unchecked.length) lines.push('', `${unchecked.length} code review finding${unchecked.length === 1 ? '' : 's'} still need${unchecked.length === 1 ? 's' : ''} a check (${unchecked.map((f) => f.id).join(', ')}): call review_approach again.`);
  if (!open.length && unchecked.length) return lines.join('\n');
  lines.push('', open.length
    ? `${open.length} finding${open.length === 1 ? '' : 's'} open (${open.map((f) => f.id).join(', ')}). Apply each one and update the brief to match; for one you shouldn't apply, give your reason in notes. Then call review_approach again so it checks them.`
    : 'Nothing open: the approach review is clear for this commit.');
  return lines.join('\n');
}

// node reviewer.mjs --run [--final] [--notes '[{"id":"…","note":"…"}]']: review the branch in the current
// directory, save it, and print what Claude reads. Always exits 0.
// realpath: Node resolves the main module's symlinks in import.meta.url but not in argv[1].
const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && process.argv.includes('--run') && isMain()) {
  const at = process.argv.indexOf('--notes');
  let notes = [];
  try { notes = at > 0 ? JSON.parse(process.argv[at + 1]) : []; } catch {}
  reviewAndSave(process.cwd(), { final: process.argv.includes('--final'), notes })
    .then((r) => process.stdout.write(reviewText(r) + '\n'));
}

// The desk's approach reviewer: a headless `claude -p` playing a staff engineer who judges whether the branch
// takes the simplest, most elegant and least costly way to the goal in its brief. It reads the brief, each
// chunk's Done/Files record and the diff size per file; it doesn't review code line by line (the code review
// in /end does that). It saves no session and loads no MCP servers. Reviews are kept per branch so the Review
// tab is a record of what was found and accepted.
// Every export resolves (never throws); a failed review comes back as { error }.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { briefCore } from './brief.mjs';

export const KINDS = ['simpler', 'scope', 'cost', 'goal-gap', 'elegance'];
export const VERDICTS = ['on-track', 'simpler-path', 'off-goal'];
// `--json-schema` makes claude end with a StructuredOutput call matching this.
const SCHEMA = JSON.stringify({
  type: 'object', required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { enum: VERDICTS }, summary: { type: 'string' },
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
    acceptedAt: null,
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

// Review the approach. `brief` is a parsed brief with its text (sources.readBrief), `files` the Diff tab's
// list. Resolves { verdict, summary, findings, core, done, startedAt, finishedAt, error? }. `signal` aborts it.
export async function reviewApproach(cwd, { brief, files = [], signal, timeoutMs = 600_000 } = {}) {
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
        return done({ findings, verdict: VERDICTS.includes(o.verdict) ? o.verdict : findings.length ? 'simpler-path' : 'on-track',
          summary: typeof o.summary === 'string' ? o.summary : '' });
      }
      done({ error: code ? (err.trim().split('\n').pop() || `claude exited with ${code}`).slice(0, 200) : 'The reviewer replied without a findings list' });
    });
  });
}

// ── The branch's review record ────────────────────────────────────────────────
// A branch's file (sources.reviewsPath) holds { runs: [{ startedAt, finishedAt, verdict, summary, core, done,
// error?, findings: [{ kind, chunk, severity, title, detail, acceptedAt }] }] }, newest first. Runs saved by
// the old code review (findings with file and line, no verdict) are dropped on load. Callers pass the path, so a review that finishes after a
// branch switch still lands in the file of the branch it reviewed.
const KEEP = 10;
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
    await writeFile(path, JSON.stringify({ runs: runs.slice(0, KEEP) }, null, 1));
    return true;
  } catch { return false; }
}

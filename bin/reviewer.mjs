// The desk's code reviewer: a headless `claude -p` that runs the code-review skill (the same review /end
// expects) on the branch's changes and returns its findings as typed JSON. It saves no session and loads
// no MCP servers. Reviews are kept per branch so the Review tab is a record of what was found and accepted.
// Every export resolves (never throws); a failed review comes back as { error }.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { forkPoint } from './sources.mjs';

// `--json-schema` makes claude end with a StructuredOutput call matching this. (A bare `/code-review` prompt
// runs as a local command and drops its output when a schema is set, so the prompt asks for the skill.)
const SCHEMA = JSON.stringify({
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', required: ['file', 'line', 'severity', 'title', 'detail'],
    properties: {
      file: { type: 'string' }, line: { type: ['integer', 'null'] },
      severity: { enum: ['high', 'medium', 'low'] }, title: { type: 'string' }, detail: { type: 'string' },
    } } } },
});

const RANK = { high: 0, medium: 1, low: 2 };
function normalise(list) {
  if (!Array.isArray(list)) return null;
  return list.filter((f) => f && typeof f.title === 'string').map((f) => ({
    file: typeof f.file === 'string' && f.file ? f.file : null,
    line: Number.isInteger(f.line) && f.line > 0 ? f.line : null,
    severity: RANK[f.severity] != null ? f.severity : 'medium',
    title: f.title,
    detail: typeof f.detail === 'string' ? f.detail : '',
    acceptedAt: null,
  })).sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

// Review the branch: everything since it forked from the default branch, committed or not, like the Diff tab.
// Resolves { findings, startedAt, finishedAt, base, error? }. `signal` aborts the run.
export async function reviewBranch(cwd, { level = 'medium', signal, timeoutMs = 900_000 } = {}) {
  const startedAt = Date.now();
  const base = await forkPoint(cwd);
  const result = { startedAt, base, findings: [] };
  if (!base) return { ...result, finishedAt: Date.now(), error: 'Not a git repository with a default branch' };
  // The base goes in the skill's args so it diffs from the fork point (what the Diff tab shows), not its own default.
  const prompt = `Run the code-review skill (Skill tool, skill: code-review, args: ${level} ${base}) on this branch's changes: `
    + `everything since commit ${base}, including uncommitted and untracked files. Then return its verified findings, `
    + 'ranked most severe first, with each line number in the new file (null when there is none). If the skill hands back '
    + 'no review of its own, do the review yourself by its rules on that same range; never report no findings without having reviewed the diff.';
  // Read-only whatever the user's settings say: no Edit/Write at all, Bash only for git, and dontAsk denies
  // anything else instead of waiting on a prompt nobody can answer (or allowing it under bypass settings).
  const argv = ['-p', prompt, '--output-format', 'json', '--json-schema', SCHEMA,
    '--no-session-persistence', '--strict-mcp-config', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Grep,Glob,Skill,Bash', '--allowedTools', 'Read', 'Grep', 'Glob', 'Skill', 'Bash(git *)'];
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
      const findings = normalise(j?.structured_output?.findings);
      if (findings) return done({ findings });
      done({ error: code ? (err.trim().split('\n').pop() || `claude exited with ${code}`).slice(0, 200) : 'The reviewer replied without a findings list' });
    });
  });
}

// ── The branch's review record ────────────────────────────────────────────────
// A branch's file (sources.reviewsPath) holds { runs: [{ startedAt, finishedAt, base, sig, error?,
// findings: [{ …, acceptedAt }] }] }, newest first. Callers pass the path, so a review that finishes after a
// branch switch still lands in the file of the branch it reviewed.
const KEEP = 10;
export async function loadReviews(path) {
  try {
    // A hand-edited, older or half-written file must not break the tab: keep only well-formed runs.
    const runs = JSON.parse(await readFile(path, 'utf8'))?.runs;
    if (!Array.isArray(runs)) return [];
    return runs.filter((r) => r && Number.isFinite(r.startedAt) && Array.isArray(r.findings)).map((r) => ({
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

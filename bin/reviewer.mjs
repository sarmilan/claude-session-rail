// The desk's code reviewer: a headless `claude -p` that reads the branch's changes and returns findings.
// It runs in the repo with read-only tools (so it can look past the diff), saves no session, and loads no
// MCP servers. Every export resolves (never throws); a failed review comes back as { error }.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { branchFiles, fileDiff } from './sources.mjs';

const SYSTEM = `You are reviewing the changes on a git branch before they are merged. The full diff is in the
user message; you may Read, Grep and Glob the repository for context. Report only high-signal problems:
bugs and definite logic errors, crashes, security issues, data loss, broken edge cases, and code that
won't run or compile. Skip style, naming, formatting and speculative nitpicks. If nothing is wrong, say so
with an empty list.

Reply with ONLY a JSON array, no prose and no code fence. Each item:
{"file": "<path relative to the repo root>", "line": <line number in the new file, or null>,
 "severity": "high" | "medium" | "low", "title": "<one short sentence>",
 "detail": "<what goes wrong, under which input, and how to fix it; two or three sentences>"}`;

// The branch's whole patch (untracked files as all-added), capped so a huge branch can't blow the prompt.
export async function branchPatch(cwd, maxChars = 200_000) {
  const { root, files } = await branchFiles(cwd);
  if (!root) return { root: null, patch: '', files: [] };
  let patch = '';
  for (const f of files) {
    if (f.status === 'binary') continue;
    const part = (await fileDiff(root, f.path, 4000)).join('\n') + '\n';
    if (patch.length + part.length > maxChars) { patch += `\n[… diff cut: ${files.length} files in all, the rest left out]\n`; break; }
    patch += part;
  }
  return { root, patch, files };
}

// The model may wrap the array in prose or a fence despite being asked not to; take the first JSON array.
function parseFindings(text) {
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end < start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    const rank = { high: 0, medium: 1, low: 2 };
    return arr.filter((f) => f && typeof f.title === 'string').map((f) => ({
      file: typeof f.file === 'string' ? f.file : null,
      line: Number.isInteger(f.line) && f.line > 0 ? f.line : null,
      severity: rank[f.severity] != null ? f.severity : 'medium',
      title: f.title,
      detail: typeof f.detail === 'string' ? f.detail : '',
    })).sort((a, b) => rank[a.severity] - rank[b.severity]);
  } catch { return null; }
}

// Review the branch. `focus` is an optional extra instruction ("look at the auth changes").
// Resolves { findings, startedAt, finishedAt, files, error? }. `signal` aborts the run.
export async function reviewBranch(cwd, { focus = '', signal, timeoutMs = 600_000 } = {}) {
  const startedAt = Date.now();
  const { root, patch, files } = await branchPatch(cwd);
  const base = { startedAt, files: files.length, findings: [] };
  if (!root) return { ...base, finishedAt: Date.now(), error: 'Not a git repository' };
  if (!patch.trim()) return { ...base, finishedAt: Date.now() };
  const prompt = `${focus ? `Focus: ${focus}\n\n` : ''}Review this diff:\n\n${patch}`;
  const argv = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config',
    '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--append-system-prompt', SYSTEM];
  return new Promise((resolve) => {
    let out = '', err = '', settled = false, timer;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...base, finishedAt: Date.now(), ...r }); } };
    let child;
    try { child = spawn('claude', argv, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], signal }); }
    catch (e) { return done({ error: `Couldn't start claude: ${e.message}` }); }
    timer = setTimeout(() => { child.kill(); done({ error: 'Review timed out' }); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => done({ error: e.name === 'AbortError' ? 'Review cancelled' : `Couldn't start claude: ${e.message}` }));
    child.on('close', (code) => {
      let result = out;
      try { const j = JSON.parse(out); if (j.is_error) return done({ error: String(j.result || 'Review failed').slice(0, 200) }); result = j.result ?? ''; } catch {}
      const findings = parseFindings(String(result));
      if (findings) return done({ findings });
      done({ error: code ? (err.trim().split('\n').pop() || `claude exited with ${code}`).slice(0, 200) : 'The reviewer replied without a findings list' });
    });
    child.stdin.on('error', () => {}); // claude exited before reading it all; 'close' reports why
    child.stdin.end(prompt);
  });
}

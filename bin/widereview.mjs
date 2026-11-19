// Runs the optional wide review and saves one run in the branch's review record (reviewer.mjs).
// File reviewers each get a throwaway worktree so the fan-out is not a second checkout of the
// person's tree. A skeptic then declines findings. Nothing here runs unless the setting is on.
// Every export resolves (never throws); a failed review comes back as { error }.
import { readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pickColour, pickName } from './names.mjs';
import { reviewPayload, loadReviews, saveReviews } from './reviewer.mjs';
import { branchFiles, fileDiff, readBrief, reviewsPath, run } from './sources.mjs';
import {
  filePrompt, findingsFromPayload, goalExcerpt, isWide, killedFromPayload, skepticPrompt, settleWide,
  sliceFiles, sliceLabel, thresholdReason, wideEnabled, wideModel,
} from './wide.mjs';

const SLICE_TIMEOUT = 180_000;
const FILE_SCHEMA = JSON.stringify({
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'object', required: ['title', 'detail', 'severity'], properties: {
    file: { type: 'string' }, line: { type: ['integer', 'null'] },
    severity: { enum: ['high', 'medium', 'low'] }, title: { type: 'string' }, detail: { type: 'string' },
  } } } },
});
const SKEPTIC_SCHEMA = JSON.stringify({
  type: 'object', required: ['summary', 'killed'],
  properties: {
    summary: { type: 'string' },
    killed: { type: 'array', items: { type: 'object', required: ['index', 'note'], properties: {
      index: { type: 'integer' }, note: { type: 'string' },
    } } },
  },
});

const looseJson = (out) => {
  const text = String(out ?? '');
  try { return JSON.parse(text); } catch { /* a log line before the object */ }
  const nl = text.lastIndexOf('\n{');
  const at = nl >= 0 ? nl + 1 : text.indexOf('{');
  if (at < 0) return null;
  try { return JSON.parse(text.slice(at)); } catch { return null; }
};

// Claude's structured_output, or the object itself when a stand-in prints the schema's JSON.
function payloadOf(out) {
  const reply = looseJson(out);
  if (!reply || typeof reply !== 'object') return null;
  if (reply.is_error) return { error: String(reply.result || 'Review failed').slice(0, 200) };
  return reviewPayload(reply) ?? reply;
}

async function readSettings() {
  try {
    const parsed = JSON.parse(await readFile(join(homedir(), '.claude', 'session-rail', 'settings.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function ask(command, argv, { cwd, signal, timeoutMs, env, detached }) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false, timer, child;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    try {
      child = spawn(command[0], [...command.slice(1), ...argv], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], signal, env: env ?? process.env, detached: Boolean(detached),
      });
    } catch (e) {
      return done({ error: e?.name === 'AbortError' ? 'Review cancelled' : `Couldn't start ${command[0]}: ${e.message}` });
    }
    timer = setTimeout(() => { child.kill(); done({ error: 'Review timed out' }); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => done({ error: e?.name === 'AbortError' ? 'Review cancelled' : `Couldn't start ${command[0]}: ${e.message}` }));
    child.on('close', () => done(signal?.aborted ? { error: 'Review cancelled' } : { out, err }));
  });
}

function argvFor(host, prompt, schema, model) {
  const grok = host === 'grok';
  const argv = grok
    ? ['-p', prompt, '--output-format', 'json', '--json-schema', schema, '--always-approve', '--max-turns', '4',
      '--tools', 'read_file,grep', '--disallowed-tools', 'write,search_replace,run_terminal_command,web_search,web_fetch']
    : ['-p', prompt, '--output-format', 'json', '--json-schema', schema, '--max-turns', '4',
      '--no-session-persistence', '--strict-mcp-config', '--permission-mode', 'dontAsk',
      '--tools', 'Read,Grep', '--allowedTools', 'Read', 'Grep'];
  if (model) argv.push('--model', model);
  return argv;
}

async function sliceDiff(repo, slice) {
  const parts = [];
  for (const f of slice.files) {
    const lines = await fileDiff(repo, f.path, 200);
    parts.push(lines.length ? lines.join('\n') : `(no text diff for ${f.path})`);
  }
  return parts.join('\n');
}

async function addWorktree(repo) {
  const dir = join(tmpdir(), `session-rail-wide-${process.pid}-${randomBytes(4).toString('hex')}`);
  const added = await run('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: repo, timeout: 30_000 });
  return added == null ? null : dir;
}

async function removeWorktree(repo, dir) {
  await run('git', ['worktree', 'remove', '--force', dir], { cwd: repo, timeout: 30_000 });
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await run('git', ['worktree', 'prune'], { cwd: repo, timeout: 15_000 });
}

function cast(count) {
  const people = [];
  for (let i = 0; i < count; i++) {
    const name = pickName(people.map((p) => p.name));
    people.push({ name, colour: pickColour(people.map((p) => p.colour)) });
  }
  return people;
}

// Review the wide diff in `cwd` and save one wide run. `settings` defaults to the rail's settings file,
// which leaves this off. `runSlice` and `runSkeptic` replace the headless model (tests, the demo).
// `onProgress` receives the named reviewers, file reviewers first and the skeptic once they finish.
// Resolves the saved run with the branch's runs, or { error }. A cancelled review writes nothing.
export async function wideReviewAndSave(cwd, {
  brief, files, settings, signal, host = 'claude', onProgress, runSlice, runSkeptic, command, env,
} = {}) {
  if (settings === undefined) settings = await readSettings();
  if (!wideEnabled(settings)) return { error: 'Wide review is off. Turn it on in the rail\'s settings.' };
  brief ??= await readBrief(cwd);
  if (!brief?.text) return { error: 'This branch has no brief to review' };
  files ??= (await branchFiles(cwd)).files;
  if (!isWide(files)) return { error: thresholdReason(files) };
  const path = await reviewsPath(cwd);
  if (!path) return { error: 'Not a git repository' };
  const [headOut, status] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd }),
    run('git', ['status', '--porcelain'], { cwd }),
  ]);
  const head = headOut?.trim() ?? null;
  const dirty = status === null || Boolean(status.trim());
  const startedAt = Date.now();
  const goal = goalExcerpt(brief);
  const model = wideModel(settings);
  const slices = sliceFiles(files);
  if (!slices.length) return { error: thresholdReason(files) };
  const names = cast(slices.length + 1);
  const people = slices.map((slice, i) => ({
    id: `wide-${i}`, name: names[i].name, colour: names[i].colour, role: 'file',
    what: sliceLabel(slice.files), since: startedAt,
    prompt: `Review ${slice.files.map((f) => f.path).join(', ')} for concrete bugs.`,
    reply: '',
  }));
  const publish = () => { try { onProgress?.(people.map((p) => ({ ...p }))); } catch { /* a listener must not stop the review */ } };
  publish();

  const dirs = [];
  const finishError = async (error) => {
    if (error === 'Review cancelled') return { error };
    const saved = {
      type: 'wide', manual: true, wide: true, startedAt, finishedAt: Date.now(), head, dirty,
      error: String(error).slice(0, 200), findings: [], verdict: null,
    };
    const prior = await loadReviews(path);
    const runs = [saved, ...prior.filter((r) => !r.error)];
    await saveReviews(path, runs);
    return { ...saved, runs };
  };
  try {
    if (signal?.aborted) return { error: 'Review cancelled' };
    for (let i = 0; i < slices.length; i++) {
      if (signal?.aborted) return { error: 'Review cancelled' };
      const dir = await addWorktree(cwd);
      if (!dir) return await finishError(`Couldn't add a worktree for ${people[i].what}`);
      dirs.push(dir);
    }
    const groups = await Promise.all(slices.map(async (slice, i) => {
      const diff = await sliceDiff(cwd, slice);
      const prompt = filePrompt({ files: slice.files, diff, goal });
      const paths = slice.files.map((f) => f.path);
      let result;
      try {
        result = runSlice
          ? await runSlice({ cwd: dirs[i], slice, diff, prompt, signal, host })
          : await askModel(host, prompt, FILE_SCHEMA, { cwd: dirs[i], signal, model, command, env });
      } catch (e) {
        result = { error: e?.name === 'AbortError' ? 'Review cancelled' : String(e?.message || e) };
      }
      if (result?.error) {
        people[i].endedAt = Date.now();
        people[i].reply = result.error;
        publish();
        return result;
      }
      const findings = Array.isArray(result) ? result : findingsFromPayload(result, paths);
      if (!findings) {
        people[i].endedAt = Date.now();
        people[i].reply = 'no findings list';
        publish();
        return { error: `${people[i].name} replied without a findings list` };
      }
      people[i].endedAt = Date.now();
      people[i].reply = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
      publish();
      return { findings };
    }));
    const failed = groups.find((g) => g?.error);
    if (failed) return await finishError(failed.error === 'Review cancelled' || signal?.aborted ? 'Review cancelled' : failed.error);
    const candidates = groups.flatMap((g) => g.findings);
    const skepticName = names[slices.length];
    const skeptic = {
      id: 'wide-skeptic', name: skepticName.name, colour: skepticName.colour, role: 'skeptic',
      what: 'skeptic', since: Date.now(), prompt: 'Drop findings that are style, duplicates, or not grounded in the diff.', reply: '',
    };
    people.push(skeptic);
    publish();
    const prompt = skepticPrompt({ findings: candidates, goal });
    let verdict;
    try {
      verdict = runSkeptic
        ? await runSkeptic({ cwd, candidates, prompt, signal, host })
        : await askModel(host, prompt, SKEPTIC_SCHEMA, { cwd, signal, model, command, env });
    } catch (e) {
      verdict = { error: e?.name === 'AbortError' ? 'Review cancelled' : String(e?.message || e) };
    }
    if (verdict?.error || signal?.aborted) {
      skeptic.endedAt = Date.now();
      skeptic.reply = verdict?.error || 'cancelled';
      publish();
      return await finishError(verdict?.error === 'Review cancelled' || signal?.aborted ? 'Review cancelled' : verdict.error);
    }
    const killed = Array.isArray(verdict?.killed) ? verdict : killedFromPayload(verdict);
    if (!killed) return await finishError('The skeptic replied without a verdict');
    skeptic.endedAt = Date.now();
    skeptic.reply = killed.summary || 'checked the findings';
    publish();
    const saved = { ...settleWide(candidates, killed.killed, { at: startedAt, head, dirty, summary: killed.summary }), finishedAt: Date.now() };
    const prior = await loadReviews(path);
    const runs = [saved, ...prior.filter((r) => !r.error)];
    await saveReviews(path, runs);
    return { ...saved, runs };
  } finally {
    for (const dir of dirs) await removeWorktree(cwd, dir);
  }
}

async function askModel(host, prompt, schema, { cwd, signal, model, command, env }) {
  const program = command?.length ? command : [host === 'grok' ? 'grok' : 'claude'];
  const childEnv = { ...(env ?? process.env) };
  if (host === 'grok' && !command?.length) childEnv.SESSION_RAIL_HEADLESS = '1';
  const asked = await ask(program, argvFor(host, prompt, schema, model), {
    cwd, signal, timeoutMs: SLICE_TIMEOUT, env: childEnv, detached: host === 'grok' && !command?.length,
  });
  if (asked.error) return asked;
  const payload = payloadOf(asked.out);
  if (payload?.error) return payload;
  if (!payload) {
    const line = (asked.err || '').trim().split('\n').pop();
    return { error: (line || 'The reviewer replied without JSON').slice(0, 200) };
  }
  return payload;
}

export function wideReviewText(result) {
  if (result?.error) return `Wide review failed: ${result.error}`;
  const findings = result?.findings ?? [];
  const lines = [`Wide review: ${result.summary || result.verdict || 'done'}`];
  for (const f of findings) lines.push(`- ${f.status} ${f.file || ''}${f.line ? `:${f.line}` : ''} ${f.title}${f.note ? ` (${f.note})` : ''}`);
  const open = findings.filter((f) => f.status === 'open').length;
  lines.push(open ? `${open} open. The skeptic left ${open} in the report.` : 'Nothing open: the skeptic left no findings.');
  return lines.join('\n');
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) {
  const hostAt = process.argv.indexOf('--host');
  wideReviewAndSave(process.cwd(), { host: hostAt > 0 ? process.argv[hostAt + 1] : 'claude' })
    .then((r) => process.stdout.write(wideReviewText(r) + '\n'));
}

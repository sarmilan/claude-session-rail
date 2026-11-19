#!/usr/bin/env node
// The CI chore runner. The rules are in chore.mjs.
//   node chore-run.mjs start [--cwd DIR] [--budget N] [--no-window]
//   node chore-run.mjs round [--cwd DIR] [--id ID] [--dry-run] [--failing TEXT | --green]
//   node chore-run.mjs stop  [--cwd DIR] [--id ID]
//   node chore-run.mjs show  [--cwd DIR] [--id ID]
// Off unless ~/.claude/session-rail/settings.json has "chores": true
// (or SESSION_RAIL_SETTINGS points at a file that does). Prints the summary. Exit 1 when it could not start.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergesPr } from './cadence.mjs';
import {
  KIND, applyRound, beginRound, budgetCap, choreMustNotRun, choresOn, freshChore, idFor, signalFromChecks, stopForReview, withSummary,
} from './chore.mjs';

const run = (cmd, args, { cwd, timeout = 15_000 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
});

export const settingsPath = () => process.env.SESSION_RAIL_SETTINGS || join(homedir(), '.claude', 'session-rail', 'settings.json');

export async function readSettings(file = settingsPath()) {
  try { return JSON.parse(await readFile(file, 'utf8')) ?? {}; } catch { return {}; }
}

async function gitInfo(cwd) {
  const out = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir', '--abbrev-ref', 'HEAD', '--show-toplevel'], { cwd });
  if (!out) return null;
  const [common, branch, top] = out.trim().split('\n');
  if (!common || !top) return null;
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd }))?.trim() || '';
  const name = branch && branch !== 'HEAD' ? branch : 'detached';
  return { common, branch: name, top, head, repo: basename(top) };
}

const statePath = (common, id) => join(common, 'session-rail', 'chores', `${id}.json`);

async function writeChore(common, chore) {
  const file = statePath(common, chore.id);
  await mkdir(dirname(file), { recursive: true });
  const body = withSummary(chore);
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
  return { file, chore: body };
}

export async function readChore(cwd, id) {
  const git = await gitInfo(cwd);
  if (!git) return null;
  try {
    const chore = JSON.parse(await readFile(statePath(git.common, id), 'utf8'));
    return chore?.kind === KIND ? chore : null;
  } catch { return null; }
}

// Every chore in this repo. A bad file is skipped. Never throws.
export async function listChores(cwd) {
  const git = await gitInfo(cwd);
  if (!git) return [];
  const dir = join(git.common, 'session-rail', 'chores');
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const rows = await Promise.all(names.map(async (n) => {
    try {
      const chore = JSON.parse(await readFile(join(dir, n), 'utf8'));
      return chore?.kind === KIND ? chore : null;
    } catch { return null; }
  }));
  return rows.filter(Boolean);
}

function worktreePath(git, id) {
  const main = basename(git.common) === '.git' ? dirname(git.common) : git.common.replace(/\.git$/, '');
  return join(dirname(main), `${basename(main)}.worktrees`, `chore-${id}`);
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Ask pane.mjs for a window. It exits without launching iTerm when iTerm is not already running.
async function openWindow(dir, branch) {
  const command = `cd ${shQuote(dir)} && printf '%s\\n' ${shQuote(`CI chore for ${branch}. Do not merge. A person reviews the state file.`)}`;
  const pane = new URL('./pane.mjs', import.meta.url).pathname;
  const out = await run(process.execPath, [pane, 'window', 'none', command], { timeout: 20_000 });
  let state = 'error';
  try { state = JSON.parse(out || '{}').state || 'error'; } catch { /* pane prints one JSON line */ }
  if (state === 'opened') return { window: 'opened', windowNote: 'opened in its own window' };
  return { window: null, windowNote: 'no iTerm window (iTerm is not running); the worktree is the sandbox' };
}

async function ensureWorktree(git, id, opener) {
  const dir = worktreePath(git, id);
  const listed = await run('git', ['worktree', 'list', '--porcelain'], { cwd: git.top });
  if ((listed || '').split('\n').includes(`worktree ${dir}`)) return { ok: true, dir };
  await mkdir(dirname(dir), { recursive: true });
  const added = await run('git', ['worktree', 'add', '--detach', dir, git.head], { cwd: git.top, timeout: 30_000 });
  if (added == null) return { ok: false, message: "Couldn't add the worktree" };
  return { ok: true, dir };
}

/**
 * Start the CI chore for the checkout at `cwd`, or return the one already recorded for this branch.
 * @param {{ cwd?: string, budget?: number|string, settings?: object, openWindow?: boolean, at?: string }} opts
 */
export async function startChore(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const settings = opts.settings ?? await readSettings();
  if (!choresOn(settings)) {
    return { ok: false, message: 'Chores are off. Turn them on in the rail settings (chores: true). Nothing was started.' };
  }
  const cap = budgetCap(opts.budget);
  if (!cap.ok) return { ok: false, message: cap.message };
  const git = await gitInfo(cwd);
  if (!git) return { ok: false, message: 'Not a git repo' };
  if (!git.head) return { ok: false, message: 'The repo has no commit to check out' };
  const id = idFor(git.branch);
  const existing = await readChore(cwd, id);
  if (existing?.worktree) {
    return { ok: true, chore: existing, file: statePath(git.common, id), reused: true };
  }
  const wt = await ensureWorktree(git, id);
  if (!wt.ok) return wt;
  const at = opts.at || new Date().toISOString();
  let chore = freshChore({ id, branch: git.branch, repo: git.repo, head: git.head, worktree: wt.dir, cap: cap.cap, at });
  if (opts.openWindow) Object.assign(chore, await openWindow(wt.dir, git.branch));
  else chore.windowNote = 'not opened';
  const saved = await writeChore(git.common, chore);
  return { ok: true, ...saved, reused: false };
}

// Checks for a live round. No pull request, no checks, or green is an empty round.
export async function liveSignal(cwd) {
  const out = await run('gh', ['pr', 'view', '--json', 'statusCheckRollup'], { cwd, timeout: 20_000 });
  if (!out) return { work: false, note: 'no pull request', tried: 'gh pr view' };
  try { return signalFromChecks(JSON.parse(out).statusCheckRollup); }
  catch { return { work: false, note: 'could not read checks', tried: 'gh pr view' }; }
}

/**
 * One round. Dry runs take `failing` (a note) or green. A live round asks `gh` unless `probe` is passed.
 * Writes status running before the check. A refusal leaves spend unchanged.
 */
export async function runRound(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const settings = opts.settings ?? await readSettings();
  if (!choresOn(settings)) {
    return { ok: false, message: 'Chores are off. Turn them on in the rail settings (chores: true). Nothing was spent.' };
  }
  const git = await gitInfo(cwd);
  if (!git) return { ok: false, message: 'Not a git repo' };
  const id = opts.id || idFor(git.branch);
  const chore = await readChore(cwd, id);
  if (!chore) return { ok: false, message: 'No chore yet. Start one first.' };
  if (opts.dry && !opts.green && !opts.failing) return { ok: false, message: 'A dry run needs a failing note or green: true.' };
  const at = opts.at || new Date().toISOString();
  const begun = beginRound(chore, at);
  if (!begun.ok) {
    return { ok: true, chore, file: statePath(git.common, id), spent: false, refused: begun.reason };
  }
  await writeChore(git.common, begun.chore);
  let signal;
  try {
    signal = opts.dry
      ? { work: !opts.green, note: opts.green ? 'checks green' : String(opts.failing), tried: 'dry run' }
      : await (opts.probe || liveSignal)(cwd);
  } catch {
    await writeChore(git.common, { ...chore, status: chore.status === 'running' ? 'waiting' : chore.status, updatedAt: at });
    return { ok: false, message: 'The check failed before it could spend.' };
  }
  const refusedMerge = choreMustNotRun(signal?.command, mergesPr);
  if (refusedMerge) {
    const saved = await writeChore(git.common, { ...chore, updatedAt: at });
    return { ok: true, ...saved, spent: false, refused: refusedMerge };
  }
  const applied = applyRound(begun.chore, signal, { at, dry: Boolean(opts.dry) });
  const saved = await writeChore(git.common, applied.chore);
  return { ok: true, ...saved, spent: applied.spent, refused: applied.refused };
}

export async function stopChore(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const git = await gitInfo(cwd);
  if (!git) return { ok: false, message: 'Not a git repo' };
  const id = opts.id || idFor(git.branch);
  const chore = await readChore(cwd, id);
  if (!chore) return { ok: false, message: 'No chore yet. Start one first.' };
  const saved = await writeChore(git.common, stopForReview(chore, opts.at || new Date().toISOString()));
  return { ok: true, ...saved, spent: false };
}

export async function showChore(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const git = await gitInfo(cwd);
  if (!git) return { ok: false, message: 'Not a git repo' };
  const id = opts.id || idFor(git.branch);
  const chore = await readChore(cwd, id);
  if (!chore) return { ok: false, message: 'No chore yet. Start one first.' };
  return { ok: true, chore: withSummary(chore), file: statePath(git.common, id) };
}

function printResult(result) {
  if (!result.ok) {
    console.log(result.message);
    return;
  }
  const chore = result.chore;
  if (result.reused) console.log('Already started. The same state file is in use.');
  if (result.refused) console.log(`Stopped without further spend: ${result.refused}`);
  for (const line of chore.summary || []) console.log(line);
  if (result.file) console.log(`State file: ${result.file}`);
}

async function cli() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const cwd = flag('--cwd') || process.cwd();
  const id = flag('--id');
  const at = flag('--at');
  if (cmd === 'start') {
    const result = await startChore({
      cwd, id, at, budget: flag('--budget'), openWindow: !args.includes('--no-window'),
    });
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  }
  if (cmd === 'round') {
    const dry = args.includes('--dry-run');
    const green = args.includes('--green');
    const failing = flag('--failing');
    if (dry && !green && (!failing || failing.startsWith('-'))) {
      console.log('A dry run needs --failing <note> or --green.');
      process.exit(1);
    }
    const result = await runRound({ cwd, id, at, dry, green, failing: green ? '' : failing });
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  }
  if (cmd === 'stop' || cmd === 'show') {
    const result = cmd === 'stop' ? await stopChore({ cwd, id, at }) : await showChore({ cwd, id });
    printResult(result);
    process.exit(result.ok ? 0 : 1);
  }
  console.log('Usage: chore-run.mjs start|round|stop|show [--cwd DIR] [--budget N] [--dry-run --failing NOTE|--green] [--no-window]');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli();

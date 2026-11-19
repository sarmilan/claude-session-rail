#!/usr/bin/env node
// Stop hook for both hosts. Claude Code runs it from hooks/hooks.json and blocks when this
// process exits 2 (the reason is stderr). Grok runs the same file and reads a block decision
// on stdout, with exit 0. The rules live in bin/stopgate.mjs. Activity for an interactive Grok
// still goes through bin/grok-hook.mjs; the test result is recorded after that, for the rail.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as act from './activity.mjs';
import { handle } from './grok-hook.mjs';
import { findAgent, railHome } from './host.mjs';
import {
  RUN_TIMEOUT_MS, hostReply, lockPath, performGate, projectCommand, runInProgress,
  sessionIdOf, shellLine, reuseDecision,
} from './stopgate.mjs';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, p);
};
const git = (cwd, args) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; }
};

// The project the stop is in, and the command that gates it. `root` is the git toplevel, or cwd.
export function loadProject(cwd) {
  const dir = cwd || process.cwd();
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  const root = top && top.startsWith('/') ? top.split('\n')[0] : dir;
  const commonLine = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = commonLine && commonLine.startsWith('/') ? commonLine.split('\n')[0] : null;
  const project = readJson(join(root, 'session-rail.json'));
  const local = common ? readJson(join(common, 'session-rail', 'tests.json')) : null;
  const agentsText = readText(join(root, 'AGENTS.md'));
  const pkg = readJson(join(root, 'package.json'));
  const plugin = readJson(join(root, '.claude-plugin', 'plugin.json'));
  const hasRail = existsSync(join(root, 'bin', 'rail.mjs'));
  const resolved = projectCommand({
    project, local, agentsText,
    packageScript: pkg?.scripts?.test,
    pluginName: plugin?.name, hasRail,
  });
  return { root, command: resolved.command, source: resolved.source };
}

function runCommand(command, root) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', shellLine(root, command)], {
      timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const output = `${stdout || ''}\n${stderr || ''}`;
      const timedOut = Boolean(err && (err.killed || err.code === 'ETIMEDOUT'));
      const exitCode = timedOut ? 124 : err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const spawnError = err && typeof err.code === 'string' ? String(err.message || err.code) : null;
      resolve({ exitCode, output, timedOut, spawnError });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function activityId(id) {
  const s = String(id || '');
  if (!s || s.length > 200 || s.includes('/') || s.includes('..')) return '';
  return s;
}

// The rail reads this off the same activity file the rest of the session writes.
export function noteActivity(sessionId, decision) {
  const id = activityId(sessionId);
  if (!id || !decision || decision.quiet || decision.ok == null) return;
  const file = join(railHome(), 'activity', `${id}.json`);
  const current = readJson(file);
  const base = current?.claude ? current : act.fresh(decision.at || Date.now());
  writeJson(file, act.noteTests(base, decision, decision.at || Date.now()));
}

function gateIo(cwd, sessionId) {
  const home = process.env.HOME || '';
  const path = home ? lockPath(home, sessionId) : '';
  return {
    now: () => Date.now(),
    load: async () => loadProject(cwd),
    readLock: async () => (path ? readJson(path) : null),
    writeLock: async (record) => { if (path) writeJson(path, record); },
    wait: async (waitKey) => {
      if (!path) return null;
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(200);
        const record = readJson(path);
        // The runner stamps `at` when it finishes, so the short reuse window is enough.
        const decision = reuseDecision(record, waitKey, Date.now());
        if (decision) return decision;
        if (!runInProgress(record, waitKey, Date.now())) return null;
      }
      return null;
    },
    run: (command, root) => runCommand(command, root),
  };
}

// `host` is `grok` or `claude` and only changes the reply shape. The decision is the same.
export async function runStop(event, { host = 'claude', cwd, grokAgent = null } = {}) {
  if (process.env.SESSION_RAIL_HEADLESS) {
    if (grokAgent) { try { handle(event, grokAgent); } catch { /* activity is best-effort */ } }
    return hostReply(host, { action: 'allow' });
  }
  const dir = cwd || event?.cwd || event?.workspaceRoot || process.cwd();
  // End the turn in the feed before the suite runs, so the rail is not stuck on the last call.
  if (grokAgent) { try { handle(event, grokAgent); } catch { /* activity is best-effort */ } }
  let decision;
  try { decision = await performGate(event, gateIo(dir, sessionIdOf(event))); } catch { decision = { action: 'allow', quiet: true }; }
  try { noteActivity(sessionIdOf(event), decision); } catch { /* the reply still stands */ }
  return hostReply(host, decision);
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invoked) {
  try {
    const raw = readFileSync(0, 'utf8');
    const event = raw.trim() ? JSON.parse(raw) : {};
    const agent = findAgent();
    const testHost = process.env.SESSION_RAIL_TEST === '1' ? process.env.SESSION_RAIL_STOP_HOST : '';
    const host = testHost === 'grok' || testHost === 'claude' ? testHost : (agent?.host === 'grok' ? 'grok' : 'claude');
    const grokAgent = agent?.host === 'grok' ? agent : null;
    const reply = await runStop(event, { host, cwd: event.cwd || event.workspaceRoot, grokAgent });
    if (reply.stderr) process.stderr.write(reply.stderr.endsWith('\n') ? reply.stderr : `${reply.stderr}\n`);
    if (reply.stdout) console.log(reply.stdout);
    process.exit(reply.exitCode);
  } catch {
    // A broken hook stays out of the way: the stop is allowed.
    process.exit(0);
  }
}

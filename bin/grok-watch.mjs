#!/usr/bin/env node
// The bit a Grok hook can't do itself: type into the live session. Claude's plugin submits a prompt and
// compacts through the engine; Grok has neither, so this process polls every 2s and, when Grok is waiting,
// asks iTerm to type the go-ahead, /compact, or /start. It exits when its Grok process does.
// Its own state file keeps it from clobbering the hook's state.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compacted as markCompacted } from './activity.mjs';
import { briefFile, NO_BRIEF_BRANCHES, parseBrief } from './brief.mjs';
import { railHome } from './host.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RAIL = railHome();
const HOME = homedir();
const WAIT_MS = 800;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, p);
};
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Same rule as hooks/goahead.ts. `prev` is the last approval this watcher saw (null on the first poll).
export function goAhead(prev, now, firstChunk) {
  if (!prev || prev.branch !== now.branch || now.approvedAt == null) return null;
  if (prev.approvedAt != null && now.approvedAt <= prev.approvedAt) return null;
  if (prev.approvedAt == null)
    return `The brief for ${now.branch} is approved. Start on chunk 1${firstChunk ? ` (${firstChunk})` : ''} and work through the chunks, finishing each one as the brief's procedure says.`;
  return `The change to the brief for ${now.branch} is approved. Carry on with the plan as it stands now.`;
}

// Type /start only into a session that has not started talking, and only when the person has a /start of their own.
export function startWanted({ envStarted, startRan, messages, hasStart }) {
  if (envStarted || startRan || !hasStart) return false;
  if (messages == null) return false;
  return messages === 0;
}

const START_FILES = [
  join(HOME, '.agents', 'skills', 'start', 'SKILL.md'),
  join(HOME, '.grok', 'commands', 'start.md'),
  join(HOME, '.claude', 'commands', 'start.md'),
  join(HOME, '.grok', 'skills', 'start', 'SKILL.md'),
  join(HOME, '.claude', 'skills', 'start', 'SKILL.md'),
];

function ttyOf(p) {
  try {
    const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(p)], { encoding: 'utf8', timeout: 2_000 }).trim();
    if (!tty || tty === '??') return null;
    return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  } catch { return null; }
}

function cwdOf(pid, sessionId) {
  const active = readJson(join(HOME, '.grok', 'active_sessions.json'));
  if (!Array.isArray(active)) return null;
  return (active.find((s) => s.session_id === sessionId) || active.find((s) => s.pid === pid))?.cwd || null;
}

function summaryOf(cwd, sessionId) {
  if (!cwd) return null;
  return readJson(join(HOME, '.grok', 'sessions', encodeURIComponent(cwd), sessionId, 'summary.json'));
}

function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5_000 }).trim(); } catch { return null; }
}

function merged(cwd, branch) {
  for (const base of ['origin/HEAD', 'main', 'master']) {
    try {
      execFileSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', branch, base], { timeout: 5_000, stdio: 'ignore' });
      return true;
    } catch { /* not an ancestor, or that base doesn't exist */ }
  }
  return false;
}

function typeInto(tty, text) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'bin', 'pane.mjs'), 'type', tty, text], { encoding: 'utf8', timeout: 10_000 });
    return JSON.parse(out).state === 'typed';
  } catch { return false; }
}

function waiting(act) {
  return act?.claude?.state === 'waiting' && Date.now() - (act.claude.since || 0) >= WAIT_MS;
}

// One pass. Types at most once. `io` is the filesystem and the typer, so tests can stand in.
export function step(ctx, io) {
  const { pid, sessionId, activity, cwd, tty, envStarted } = ctx;
  const next = { ...(ctx.watch || {}) };
  let typed = null;
  const canType = () => Boolean(tty && waiting(activity) && !typed);
  const say = (text) => canType() && io.type(tty, text) && (typed = text);

  const summary = cwd ? io.summary(cwd, sessionId) : null;
  const messages = summary && Number.isFinite(summary.num_chat_messages) ? summary.num_chat_messages : null;
  if (messages > 0 || io.hookStartRan) next.startRan = true;
  if (!next.startRan && startWanted({ envStarted, startRan: next.startRan, messages, hasStart: io.hasStart() })) {
    if (say('/start')) next.startRan = true;
  }

  const branch = cwd ? io.branch(cwd) : null;
  if (branch && !NO_BRIEF_BRANCHES.includes(branch)) {
    const seen = { branch, approvedAt: io.approval(cwd, branch)?.approvedAt ?? null };
    const first = !next.approval || next.approval.branch !== seen.branch;
    const text = first ? null : goAhead(next.approval, seen, io.firstChunk(cwd, branch));
    if (text) { if (say(text)) next.approval = seen; }
    else next.approval = seen;
  }

  if (next.branch && branch && next.branch !== branch && !NO_BRIEF_BRANCHES.includes(next.branch)) {
    next.compactAfter = next.branch;
    next.compactTries = 0;
  }
  if (branch) next.branch = branch;
  if (next.compactAfter && cwd) {
    const brief = io.brief(cwd, next.compactAfter);
    const done = brief ? parseBrief(brief).chunks.some((c) => c.done) : false;
    if (!io.autoCompact() || !done || !io.merged(cwd, next.compactAfter)) next.compactAfter = null;
    else if ((next.compactTries || 0) >= 3) next.compactAfter = null;
    else if (canType()) {
      if (say('/compact')) {
        next.compactedAfter = next.compactAfter;
        next.compactAfter = null;
        next.compactTries = 0;
      } else next.compactTries = (next.compactTries || 0) + 1;
    }
  }
  return { watch: next, typed, pid, sessionId, activity };
}

function loop(pid, sessionId) {
  const watchFile = join(RAIL, 'state', `${sessionId}.watch.json`);
  const hookFile = join(RAIL, 'state', `${sessionId}.json`);
  const activityFile = join(RAIL, 'activity', `${sessionId}.json`);
  const tick = () => {
    if (!alive(pid)) process.exit(0);
    const cwd = cwdOf(pid, sessionId);
    const watch = readJson(watchFile) || {};
    const activity = readJson(activityFile);
    const io = {
      type: typeInto,
      summary: summaryOf,
      hasStart: () => START_FILES.some((p) => existsSync(p)),
      hookStartRan: Boolean(readJson(hookFile)?.startRan) || Boolean(process.env.SESSION_RAIL_STARTED),
      branch: (dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      approval: (dir, branch) => {
        const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        return common ? readJson(briefFile(common, branch, 'approved.json')) : null;
      },
      firstChunk: (dir, branch) => {
        const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        if (!common) return undefined;
        const path = briefFile(common, branch, 'md');
        if (!existsSync(path)) return undefined;
        return parseBrief(readFileSync(path, 'utf8')).chunks[0]?.name;
      },
      brief: (dir, branch) => {
        const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        if (!common) return null;
        const path = briefFile(common, branch, 'md');
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      },
      merged,
      autoCompact: () => readJson(join(RAIL, 'settings.json'))?.autoCompact !== false,
    };
    const result = step({ pid, sessionId, watch, activity, cwd, tty: ttyOf(pid), envStarted: Boolean(process.env.SESSION_RAIL_STARTED) }, io);
    if (result.typed === '/compact' && result.watch.compactedAfter) {
      const after = result.watch.compactedAfter;
      delete result.watch.compactedAfter;
      writeJson(activityFile, markCompacted(activity?.claude ? activity : { claude: { state: 'waiting', since: Date.now() }, running: [], recent: [] }, after, Date.now()));
    } else delete result.watch.compactedAfter;
    writeJson(watchFile, result.watch);
    setTimeout(tick, 2_000);
  };
  tick();
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const pid = Number(process.argv[2]);
  const sessionId = process.argv[3];
  if (pid && sessionId) loop(pid, sessionId);
}

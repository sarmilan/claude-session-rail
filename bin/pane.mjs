#!/usr/bin/env node
// Opens/closes the session rail as an iTerm split beside the Claude pane that runs this.
//   node pane.mjs open | close | toggle | status
// Prints one JSON line: { state, ... }. Always exits 0 so callers never break.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANES = join(homedir(), '.claude', 'session-rail', 'panes');
const RAIL_COLUMNS = 44;
const done = (state, extra = {}) => { console.log(JSON.stringify({ state, ...extra })); process.exit(0); };

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000 }).trim(); } catch { return null; } };
const osa = (script, ...argv) => sh('osascript', ['-e', script, ...argv]);

// Walk up from this process to the `claude` process; its TTY identifies the iTerm pane.
function findClaude() {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const row = sh('ps', ['-o', 'ppid=,tty=,comm=', '-p', String(pid)]);
    if (!row) return null;
    const [ppid, tty, ...comm] = row.trim().split(/\s+/);
    // Stop at the nearest Claude: one with no terminal (claude -p, the desktop app) owns no pane,
    // and walking past it would act on an unrelated outer session.
    if (comm.join(' ').split('/').pop() === 'claude') return tty && tty !== '??' ? { pid, tty: `/dev/${tty}` } : null;
    pid = Number(ppid);
  }
  return null;
}

const FIND_BY_TTY = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then return id of s
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;

const EXISTS = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s is (item 1 of argv) then return "yes"
        end repeat
      end repeat
    end repeat
  end tell
  return "no"
end run`;

// Split the Claude pane, size the new pane, and give focus back to Claude.
const OPEN = `on run argv
  set target to item 1 of argv
  set cmd to item 2 of argv
  set cols to (item 3 of argv) as integer
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s is target then
            tell s to set r to (split vertically with same profile command cmd)
            try
              set columns of r to cols
            end try
            tell s to select
            return id of r
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;

// Ask the rail to quit (it reads "q"); its pane then closes by itself, with no "close session?" prompt.
const QUIT = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s is (item 1 of argv) then
            tell s to write text "q" newline no
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;

const action = process.argv[2] || 'status';
if (!['open', 'close', 'toggle', 'status'].includes(action)) done('error', { message: `unknown action ${action}` });

const claude = findClaude();
if (!claude) done('no-claude');
// Never launch iTerm by accident: only talk to it if it's already running. (pgrep can't see it from
// inside Claude's sandboxed shells, so read the process list instead.)
if (!(sh('ps', ['-axo', 'comm=']) || '').split('\n').some((c) => c.endsWith('/MacOS/iTerm2'))) done('not-iterm');
const claudePane = osa(FIND_BY_TTY, claude.tty);
if (!claudePane) done('not-iterm');

const recordPath = join(PANES, `${claude.pid}.json`);
let record = null;
try { record = JSON.parse(readFileSync(recordPath, 'utf8')); } catch {}
const isOpen = Boolean(record?.railPane) && osa(EXISTS, record.railPane) === 'yes';
if (record && !isOpen) rmSync(recordPath, { force: true }); // stale: the rail was quit or its pane closed

const open = () => {
  if (isOpen) done('already-open', { railPane: record.railPane });
  const q = (s) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  const cmd = [process.execPath, join(HERE, 'rail.mjs'), '--pid', String(claude.pid), '--cwd', process.cwd()].map(q).join(' ');
  const railPane = osa(OPEN, claudePane, cmd, String(RAIL_COLUMNS));
  if (!railPane) done('error', { message: 'iTerm did not create the split' });
  mkdirSync(PANES, { recursive: true });
  writeFileSync(recordPath, JSON.stringify({ railPane, claudePane, claudePid: claude.pid, openedAt: Date.now() }));
  done('opened', { railPane });
};
const close = () => {
  if (!isOpen) done('already-closed');
  osa(QUIT, record.railPane);
  rmSync(recordPath, { force: true });
  done('closed');
};

if (action === 'status') done(isOpen ? 'open' : 'closed', { claudePid: claude.pid, claudePane, railPane: isOpen ? record.railPane : null });
if (action === 'open') open();
if (action === 'close') close();
if (action === 'toggle') isOpen ? close() : open();

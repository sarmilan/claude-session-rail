#!/usr/bin/env node
// Opens/closes the session rail and the desk as iTerm splits beside the Claude pane that runs this.
//   node pane.mjs open | close | toggle | status [rail | desk]      (rail if not given)
// The layout is Claude │ desk │ rail: the desk splits off Claude (landing left of an open rail), and the
// rail splits off the desk when the desk is already open.
// Prints one JSON line: { state, ... }. Always exits 0 so callers never break.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANES = join(homedir(), '.claude', 'session-rail', 'panes');
// Each panel: its script, its width, the narrowest Claude's pane may get when the window can't grow and the
// panel takes Claude's width (Claude keeps room to work beside the wide desk), the narrowest the panel may
// get when another panel takes its width, and its fields in the per-Claude record.
const PANELS = {
  rail: { script: 'rail.mjs', columns: 44, keep: 20, floor: 30, pane: 'railPane', grew: 'grew' },
  desk: { script: 'desk.mjs', columns: 80, keep: 60, floor: 50, pane: 'deskPane', grew: 'deskGrew' },
};
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

// Returns "<session id>,<window left edge>".
const FIND_BY_TTY = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then
            set b to bounds of w
            return (id of s) & "," & (item 1 of b)
          end if
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

// Split the Claude pane and give focus back to Claude. Setting a pane's columns makes iTerm resize the
// window to fit, so: keep Claude at its old width and let the window grow by the rail's width; if that
// pushes it past the screen's right edge, put the window back and take the rail's width from Claude.
// Returns "<rail session id>,<window id>,<points the window grew>".
const OPEN = `on run argv
  set target to item 1 of argv
  set cmd to item 2 of argv
  set cols to (item 3 of argv) as integer
  set screenRight to (item 4 of argv) as integer
  set keep to (item 5 of argv) as integer
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s is target then
            set b0 to bounds of w
            set c0 to columns of s
            tell s to set r to (split vertically with same profile command cmd)
            set grew to 0
            try
              set columns of r to cols
              set columns of s to c0
              set b1 to bounds of w
              set grew to (item 3 of b1) - (item 3 of b0)
              if grew is less than or equal to 0 or (item 3 of b1) > screenRight then
                set grew to 0
                set bounds of w to b0
                set narrower to c0 - cols - 1
                set newCols to cols
                if narrower < keep then
                  set narrower to keep
                  set newCols to c0 - keep - 1
                end if
                -- Not enough room for both: still give the new pane something usable.
                if newCols < 20 then
                  set newCols to 20
                  set narrower to c0 - 21
                  if narrower < 10 then set narrower to 10
                end if
                set columns of s to narrower
                set columns of r to newCols
                set bounds of w to b0
              end if
            end try
            tell s to select
            return (id of r) & "," & (id of w) & "," & grew
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;

// Shrink a window back by the width the rail added.
const SHRINK = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      if (id of w as text) is (item 1 of argv) then
        set b to bounds of w
        set item 3 of b to (item 3 of b) - ((item 2 of argv) as integer)
        set bounds of w to b
        return "ok"
      end if
    end repeat
  end tell
  return ""
end run`;

// The right edge (in points) of the visible area of the screen holding x, for the window-grow check.
const SCREEN_RIGHT = `ObjC.import('AppKit');
function run(argv) {
  const x = Number(argv[0]), screens = $.NSScreen.screens;
  for (let i = 0; i < screens.count; i++) {
    const f = screens.objectAtIndex(i).visibleFrame;
    if (x >= f.origin.x && x < f.origin.x + f.size.width) return String(f.origin.x + f.size.width);
  }
  const f = $.NSScreen.mainScreen.visibleFrame;
  return String(f.origin.x + f.size.width);
}`;

// Ask the panel to quit (it reads "q"); its pane then closes by itself, with no "close session?" prompt.
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
const which = process.argv[3] || 'rail';
if (!['open', 'close', 'toggle', 'status'].includes(action)) done('error', { message: `unknown action ${action}` });
if (!PANELS[which]) done('error', { message: `unknown panel ${which}` });
const panel = PANELS[which];

const claude = findClaude();
if (!claude) done('no-claude');
// Never launch iTerm by accident: only talk to it if it's already running. (pgrep can't see it from
// inside Claude's sandboxed shells, so read the process list instead.)
if (!(sh('ps', ['-axo', 'comm=']) || '').split('\n').some((c) => c.endsWith('/MacOS/iTerm2'))) done('not-iterm');
const [claudePane, windowLeft] = (osa(FIND_BY_TTY, claude.tty) || '').split(',');
if (!claudePane) done('not-iterm');

// One record per Claude holds both panels. A panel whose pane is gone (quit, or closed by hand) is dropped.
const recordPath = join(PANES, `${claude.pid}.json`);
let record = {};
try { record = JSON.parse(readFileSync(recordPath, 'utf8')); } catch {}
const live = (p) => Boolean(record[p.pane]) && osa(EXISTS, record[p.pane]) === 'yes';
for (const p of Object.values(PANELS)) if (record[p.pane] && !live(p)) { delete record[p.pane]; delete record[p.grew]; }
const save = () => {
  if (!Object.values(PANELS).some((p) => record[p.pane])) return rmSync(recordPath, { force: true });
  mkdirSync(PANES, { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record));
};
save();
const isOpen = Boolean(record[panel.pane]);

const open = () => {
  if (isOpen) done('already-open', { [panel.pane]: record[panel.pane] });
  const q = (s) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  const cmd = [process.execPath, join(HERE, panel.script), '--pid', String(claude.pid), '--cwd', process.cwd()].map(q).join(' ');
  const screenRight = sh('osascript', ['-l', 'JavaScript', '-e', SCREEN_RIGHT, String(windowLeft ?? 0)]) || '100000';
  // The rail splits off the desk (so it stays on the far right); everything else splits off Claude.
  const from = which === 'rail' && record.deskPane ? record.deskPane : claudePane;
  const keep = from === claudePane ? panel.keep : PANELS.desk.floor;
  const [paneId, windowId, grew] = (osa(OPEN, from, cmd, String(panel.columns), String(Math.floor(+screenRight)), String(keep)) || '').split(',');
  if (!paneId) done('error', { message: 'iTerm did not create the split' });
  Object.assign(record, { claudePane, claudePid: claude.pid, windowId, [panel.pane]: paneId, [panel.grew]: +grew || 0 });
  save();
  done('opened', { [panel.pane]: paneId, grew: +grew || 0 });
};
const close = () => {
  if (!isOpen) done('already-closed');
  const paneId = record[panel.pane], grew = record[panel.grew];
  osa(QUIT, paneId);
  delete record[panel.pane]; delete record[panel.grew];
  save();
  // If opening widened the window, narrow it again once the panel's pane has gone (so Claude gets its
  // width back instead of the window creeping wider with every toggle).
  if (grew > 0 && record.windowId) {
    for (let i = 0; i < 30 && osa(EXISTS, paneId) === 'yes'; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    osa(SHRINK, record.windowId, String(grew));
  }
  done('closed');
};

if (action === 'status') done(isOpen ? 'open' : 'closed', { panel: which, claudePid: claude.pid, claudePane, [panel.pane]: isOpen ? record[panel.pane] : null });
if (action === 'open') open();
if (action === 'close') close();
if (action === 'toggle') isOpen ? close() : open();

#!/usr/bin/env node
// Opens/closes the session rail and the desk as iTerm splits beside the Claude or Grok pane that runs this.
//   node pane.mjs layout                                            (fill the screen, open both panels)
//   node pane.mjs open | close | toggle | status [rail | desk]      (rail if not given)
//   node pane.mjs focus <tty>                                       (bring the iTerm session on that tty to the front)
//   node pane.mjs window <tty> <command>                            (a new window over that session's, running command)
//   node pane.mjs type <tty> <text>                                 (type text into that session and submit it)
// The layout is agent │ desk │ rail: the desk splits off the agent (landing left of an open rail), and the
// rail splits off the desk when the desk is already open. Panels take a fixed share of the window's
// columns, always from the agent's pane; the window itself never grows.
// Prints one JSON line: { state, ... }. Always exits 0 so callers never break.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAgent } from './host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANES = join(homedir(), '.claude', 'session-rail', 'panes');
// Each panel: its script, its share of the window's columns (per mille), and its field in the per-Claude record.
const PANELS = {
  rail: { script: 'rail.mjs', share: 185, pane: 'railPane' },
  desk: { script: 'desk.mjs', share: 280, pane: 'deskPane' },
};
const done = (state, extra = {}) => { console.log(JSON.stringify({ state, ...extra })); process.exit(0); };

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000 }).trim(); } catch { return null; } };
const osa = (script, ...argv) => sh('osascript', ['-e', script, ...argv]);

// Returns "<session id>,<window id>,<window left edge>".
const FIND_BY_TTY = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then
            set b to bounds of w
            return (id of s) & "," & (id of w) & "," & (item 1 of b)
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

// The visible area (no menu bar or Dock) of the screen holding x, as AppleScript bounds "left,top,right,bottom".
// AppKit measures from the bottom of the main screen; AppleScript bounds measure from its top.
const SCREEN_BOUNDS = `ObjC.import('AppKit');
function run(argv) {
  const x = Number(argv[0]), screens = $.NSScreen.screens, mainH = screens.objectAtIndex(0).frame.size.height;
  let f = $.NSScreen.mainScreen.visibleFrame;
  for (let i = 0; i < screens.count; i++) {
    const s = screens.objectAtIndex(i), r = s.frame;
    if (x >= r.origin.x && x < r.origin.x + r.size.width) { f = s.visibleFrame; break; }
  }
  return [f.origin.x, mainH - f.origin.y - f.size.height, f.origin.x + f.size.width, mainH - f.origin.y].map(Math.round).join(',');
}`;

// Make a window fill the given bounds.
const FILL = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      if (id of w as text) is (item 1 of argv) then
        set bounds of w to {(item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer}
        return "ok"
      end if
    end repeat
  end tell
  return ""
end run`;

// Split a pane vertically, running a command in the new pane. Returns the new pane's id.
const SPLIT = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s is (item 1 of argv) then
            tell s to set r to (split vertically with same profile command (item 2 of argv))
            return id of r
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;

// Give each open panel its share of the tab's columns and Claude the rest, then hand focus back to Claude.
// Setting a pane's columns makes iTerm resize the window, so shrink panes before growing them (the total
// never overshoots) and put the window back at its bounds afterwards.
// argv: claude id, desk id, rail id ("" when closed), desk share, rail share (per mille).
// Returns the final columns "claude,desk,rail" (0 for a closed panel).
const SIZE = `on run argv
  set ids to {item 1 of argv, item 2 of argv, item 3 of argv}
  set shares to {0, (item 4 of argv) as integer, (item 5 of argv) as integer}
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        set found to {missing value, missing value, missing value}
        repeat with n from 1 to (count of sessions of t)
          repeat with i from 1 to 3
            if (item i of ids) is not "" and id of (session n of t) is (item i of ids) then set item i of found to (session n of t)
          end repeat
        end repeat
        if item 1 of found is not missing value then
          set b0 to bounds of w
          set total to -1
          repeat with i from 1 to 3
            if item i of found is not missing value then set total to total + (columns of (item i of found)) + 1
          end repeat
          set targets to {0, 0, 0}
          set claudeCols to total
          repeat with i from 2 to 3
            if item i of found is not missing value then
              set c to (total * (item i of shares) + 500) div 1000
              set item i of targets to c
              set claudeCols to claudeCols - c - 1
            end if
          end repeat
          set item 1 of targets to claudeCols
          repeat with k from 1 to 2
            repeat with i from 1 to 3
              set p to item i of found
              if p is not missing value then
                set cur to columns of p
                if (k = 1 and cur > (item i of targets)) or (k = 2 and cur < (item i of targets)) then set columns of p to (item i of targets)
              end if
            end repeat
          end repeat
          set bounds of w to b0
          tell (item 1 of found) to select
          set out to {}
          repeat with i from 1 to 3
            if item i of found is missing value then
              set end of out to "0"
            else
              set end of out to (columns of (item i of found)) as text
            end if
          end repeat
          set AppleScript's text item delimiters to ","
          return out as text
        end if
      end repeat
    end repeat
  end tell
  return ""
end run`;

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

// Type into a session and submit it (write text's newline is the default). The watcher uses this for the
// go-ahead, /compact and /start, which the hook can't submit on its own.
const TYPE = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then
            tell s to write text (item 2 of argv)
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;

// Bring the session on a tty to the front: its window, its tab, then the pane itself.
const FOCUS = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then
            select w
            tell t to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;

// A new window exactly over the window of the session on a tty (else the current window), typing a command into
// its shell. One tab per window keeps iTerm's tab bar hidden: the rail's Sessions list is the switcher.
const NEW_WINDOW = `on run argv
  tell application "iTerm2"
    set target to missing value
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then set target to w
        end repeat
      end repeat
    end repeat
    if target is missing value then set target to current window
    set b to bounds of target
    set nw to (create window with default profile)
    set bounds of nw to b
    tell current session of nw to write text (item 2 of argv)
    return "ok"
  end tell
end run`;

const action = process.argv[2] || 'status';
const itermRunning = () => (sh('ps', ['-axo', 'comm=']) || '').split('\n').some((c) => c.endsWith('/MacOS/iTerm2'));
// focus, window and type act on any pane, so they don't need to run under the agent.
if (action === 'focus' || action === 'window' || action === 'type') {
  const [tty, command] = process.argv.slice(3);
  if (!tty || ((action === 'window' || action === 'type') && !command)) done('error', { message: `usage: pane.mjs ${action} <tty>${action === 'focus' ? '' : ' <text>'}` });
  if (!itermRunning()) done('not-iterm');
  if (action === 'focus') done(osa(FOCUS, tty) === 'ok' ? 'focused' : 'not-found');
  if (action === 'type') done(osa(TYPE, tty, command) === 'ok' ? 'typed' : 'not-found');
  done(osa(NEW_WINDOW, tty, command) === 'ok' ? 'opened' : 'error');
}
const which = process.argv[3] || 'rail';
if (!['layout', 'open', 'close', 'toggle', 'status'].includes(action)) done('error', { message: `unknown action ${action}` });
if (!PANELS[which]) done('error', { message: `unknown panel ${which}` });
const panel = PANELS[which];

// Stop at the nearest grok or claude. One with no terminal (a headless -p, or the desktop app) owns no pane,
// and walking past it would act on an unrelated outer session. The state stays `no-claude` so older callers
// still match.
const claude = findAgent();
if (!claude?.tty) done('no-claude');
// Never launch iTerm by accident: only talk to it if it's already running. (pgrep can't see it from
// inside Claude's sandboxed shells, so read the process list instead.)
if (!itermRunning()) done('not-iterm');
const [claudePane, windowId, windowLeft] = (osa(FIND_BY_TTY, claude.tty) || '').split(',');
if (!claudePane) done('not-iterm');

// Records of Claudes that have exited are left behind when a session isn't closed cleanly; drop them. When ps
// fails, keep everything: an empty list would read as every Claude gone. This Claude's own record always stays.
const alive = new Set((sh('ps', ['-axo', 'pid=']) || '').split('\n').map((p) => p.trim()).filter(Boolean));
alive.add(String(claude.pid));
if (alive.size > 1) try { for (const f of readdirSync(PANES)) if (f.endsWith('.json') && !alive.has(f.slice(0, -5))) rmSync(join(PANES, f), { force: true }); } catch {}

// One record per Claude holds both panels. A panel whose pane is gone (quit, or closed by hand) is dropped.
const recordPath = join(PANES, `${claude.pid}.json`);
let record = {};
try { record = JSON.parse(readFileSync(recordPath, 'utf8')); } catch {}
for (const p of Object.values(PANELS)) if (record[p.pane] && osa(EXISTS, record[p.pane]) !== 'yes') delete record[p.pane];
const save = () => {
  if (!Object.values(PANELS).some((p) => record[p.pane])) return rmSync(recordPath, { force: true });
  mkdirSync(PANES, { recursive: true });
  const sessionId = process.env.SESSION_RAIL_SESSION || record.sessionId || undefined;
  writeFileSync(recordPath, JSON.stringify({ claudePane, claudePid: claude.pid, deskPane: record.deskPane, railPane: record.railPane, host: claude.host, sessionId }));
};
save();

const q = (s) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
// Split a panel off its neighbour (the rail off an open desk, so it stays on the far right; the desk off Claude).
const split = (p) => {
  // iTerm starts the command with a bare system PATH; pass on Claude's so the panel finds gh, git and claude.
  const sessionId = process.env.SESSION_RAIL_SESSION || record.sessionId || '';
  const cmd = ['/usr/bin/env', `PATH=${process.env.PATH ?? ''}`, process.execPath, join(HERE, p.script),
    '--pid', String(claude.pid), '--cwd', process.cwd(), '--host', claude.host,
    ...(sessionId ? ['--session', sessionId] : [])].map(q).join(' ');
  const from = p === PANELS.rail && record.deskPane ? record.deskPane : claudePane;
  const id = osa(SPLIT, from, cmd);
  if (id) { record[p.pane] = id; save(); }
  return id;
};
const size = () => {
  const [c, d, r] = (osa(SIZE, claudePane, record.deskPane || '', record.railPane || '', String(PANELS.desk.share), String(PANELS.rail.share)) || '').split(',').map(Number);
  return { claude: c || 0, desk: d || 0, rail: r || 0 };
};

// Session start: fill the screen first, then open whatever isn't open and size everything once.
// With both panels already open (session.start again after /clear) it leaves the window as the person has it.
const layout = () => {
  if (record.deskPane && record.railPane) done('already-open', { deskPane: record.deskPane, railPane: record.railPane });
  const bounds = sh('osascript', ['-l', 'JavaScript', '-e', SCREEN_BOUNDS, String(windowLeft ?? 0)]);
  if (bounds) osa(FILL, windowId, ...bounds.split(','));
  if (!record.deskPane) split(PANELS.desk);
  if (!record.railPane) split(PANELS.rail);
  if (!record.deskPane && !record.railPane) done('error', { message: 'iTerm did not create the split' });
  done('opened', { deskPane: record.deskPane, railPane: record.railPane, columns: size() });
};
const open = () => {
  if (record[panel.pane]) done('already-open', { [panel.pane]: record[panel.pane] });
  if (!split(panel)) done('error', { message: 'iTerm did not create the split' });
  done('opened', { [panel.pane]: record[panel.pane], columns: size() });
};
const close = () => {
  if (!record[panel.pane]) done('already-closed');
  osa(QUIT, record[panel.pane]);
  delete record[panel.pane];
  save();
  done('closed');
};

const isOpen = Boolean(record[panel.pane]);
if (action === 'status') done(isOpen ? 'open' : 'closed', { panel: which, claudePid: claude.pid, claudePane, [panel.pane]: isOpen ? record[panel.pane] : null });
if (action === 'layout') layout();
if (action === 'open') open();
if (action === 'close') close();
if (action === 'toggle') isOpen ? close() : open();

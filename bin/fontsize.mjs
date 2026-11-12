// One font size for the Claude pane, the desk and the rail.
// iTerm can't set a pane's font from outside it, but a pane switches profile when its terminal is sent
// OSC 1337;SetProfile=NAME. So each size gets an iTerm Dynamic Profile that inherits the panes' own profile
// and only changes the fonts, and every pane is switched to the same one. A pane that has switched keeps
// reporting its original profile name and iTerm ignores a switch back to that name, so the base size is a
// generated profile too.
// Every export resolves to plain values and never throws.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MIN = 8, MAX = 36;
const DYNAMIC = join(homedir(), 'Library', 'Application Support', 'iTerm2', 'DynamicProfiles', 'session-rail.json');
const PREFS = join(homedir(), 'Library', 'Preferences', 'com.googlecode.iterm2.plist');
const SETTINGS = join(homedir(), '.claude', 'session-rail', 'settings.json');
const PANES = join(homedir(), '.claude', 'session-rail', 'panes');
const LOAD_MS = 2000; // iTerm notices a changed Dynamic Profiles file within about a second
const nameFor = (size) => `session-rail ${size}pt`;

const run = (cmd, args) => new Promise((resolve) =>
  execFile(cmd, args, { encoding: 'utf8', timeout: 10_000 }, (e, out) => resolve(e ? null : out.trim())));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

// argv: this panel's tty, then pane ids. Returns "window id|left,top,right,bottom|profile of this panel|tty,tty,…"
// covering this panel and whichever of the panes are in its tab.
const PANES_INFO = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        set prof to ""
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then set prof to profile name of s
        end repeat
        if prof is not "" then
          set ttys to {}
          repeat with s in sessions of t
            if tty of s is (item 1 of argv) or (rest of argv) contains (id of s as text) then set end of ttys to (tty of s)
          end repeat
          set AppleScript's text item delimiters to ","
          return (id of w as text) & "|" & ((bounds of w) as text) & "|" & prof & "|" & (ttys as text)
        end if
      end repeat
    end repeat
  end tell
  return ""
end run`;

const SET_BOUNDS = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      if (id of w as text) is (item 1 of argv) then set bounds of w to {(item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer}
    end repeat
  end tell
end run`;

async function panes(pid) {
  const tty = await run('ps', ['-o', 'tty=', '-p', String(process.pid)]);
  if (!tty || tty === '??') return null;
  const rec = (pid && readJson(join(PANES, `${pid}.json`))) || {};
  const ids = [rec.claudePane, rec.deskPane, rec.railPane].filter(Boolean);
  const [windowId, bounds, profile, ttys] = ((await run('osascript', ['-e', PANES_INFO, `/dev/${tty}`, ...ids])) || '').split('|');
  return profile ? { windowId, bounds: bounds.split(','), profile, ttys: ttys.split(',') } : null;
}

// The profile the panes were opened with, from iTerm's preferences: its name and fonts.
async function baseProfile(name) {
  const all = JSON.parse((await run('plutil', ['-extract', 'New Bookmarks', 'json', '-o', '-', PREFS])) || '[]');
  const p = all.find((b) => b.Name === name);
  const split = (f) => { const m = /^(.*) ([\d.]+)$/.exec(f || ''); return m && { font: m[1], size: Number(m[2]) }; };
  const normal = split(p?.['Normal Font']);
  return normal && { name, normal, nonAscii: split(p['Non Ascii Font']) };
}

// Make sure a profile for `size` exists. Returns true when the file changed (iTerm then needs a moment).
function ensureProfile(base, size) {
  const file = readJson(DYNAMIC);
  const same = file?.base === base.name;
  const sizes = new Set([...(same ? file.sizes : []), size]);
  if (same && file.sizes.includes(size)) return false;
  const profile = (s) => ({
    Name: nameFor(s), Guid: `session-rail-${s}`, 'Dynamic Profile Parent Name': base.name,
    'Normal Font': `${base.normal.font} ${s}`,
    ...(base.nonAscii && { 'Non Ascii Font': `${base.nonAscii.font} ${Math.max(1, Math.round((base.nonAscii.size * s) / base.normal.size))}` }),
  });
  const list = [...sizes].sort((a, b) => a - b);
  try {
    mkdirSync(join(DYNAMIC, '..'), { recursive: true });
    writeFileSync(DYNAMIC, JSON.stringify({ base: base.name, sizes: list, Profiles: list.map(profile) }, null, 2));
  } catch { return false; }
  return true;
}

// The size chosen in the rail, or null.
export const saved = () => readJson(SETTINGS)?.fontSize ?? null;

// The size of the panes' own profile, or null when it can't be told.
export const baseSize = async (pid) => {
  const p = await panes(pid);
  return (p && (await baseProfile(p.profile)))?.normal.size ?? null;
};

// Switch every pane to `size`. Returns { ok, size } or { ok: false, message }.
export async function apply(pid, size) {
  size = Math.max(MIN, Math.min(MAX, Math.round(size)));
  const p = await panes(pid);
  if (!p) return { ok: false, message: 'Not in an iTerm pane' };
  const base = await baseProfile(p.profile);
  if (!base) return { ok: false, message: `Can't read the fonts of profile ${p.profile}` };
  if (ensureProfile(base, size)) await sleep(LOAD_MS);
  const seq = `\x1b]1337;SetProfile=${nameFor(size)}\x07`;
  for (const tty of p.ttys) try { writeFileSync(tty, seq); } catch {}
  // A smaller font makes iTerm shrink the window to fit; put it back.
  await sleep(400);
  await run('osascript', ['-e', SET_BOUNDS, p.windowId, ...p.bounds]);
  try { mkdirSync(join(SETTINGS, '..'), { recursive: true }); writeFileSync(SETTINGS, JSON.stringify({ ...readJson(SETTINGS), fontSize: size })); } catch {}
  return { ok: true, size };
}

// At startup: put the panes back on the saved size, if one was chosen.
export async function applySaved(pid) {
  const size = saved();
  return size ? apply(pid, size) : { ok: false, message: 'No saved size' };
}

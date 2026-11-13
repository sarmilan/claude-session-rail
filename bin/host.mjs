// Which coding agent this process belongs to. The rail, the desk and the pane controller sit beside
// either `grok` or `claude` in iTerm. A headless run (no TTY) owns no pane.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
// Settings, panes, activity and the mascot stay in one place so a Grok session and a Claude session
// share font size, the pet and auto-compact. The directory name is historical.
export const railHome = () => join(HOME, '.claude', 'session-rail');

const AGENTS = new Set(['grok', 'claude']);

// Nearest grok or claude process at or above `start`. `tty` is null when that process has no terminal
// (a headless `grok -p` / `claude -p`, or the desktop app).
export function findAgent(start = process.ppid) {
  let pid = Number(start) || 0;
  for (let i = 0; i < 16 && pid > 1; i++) {
    let row = '';
    try {
      row = execFileSync('ps', ['-o', 'ppid=,tty=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 }).trim();
    } catch {
      return null;
    }
    if (!row) return null;
    const [ppid, tty, ...comm] = row.split(/\s+/);
    const host = comm.join(' ').split('/').pop();
    if (AGENTS.has(host)) {
      const ok = tty && tty !== '??';
      return { host, pid, tty: ok ? (tty.startsWith('/dev/') ? tty : `/dev/${tty}`) : null };
    }
    pid = Number(ppid);
  }
  return null;
}

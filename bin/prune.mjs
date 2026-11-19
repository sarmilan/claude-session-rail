// What the rail may throw away. Pure: no Node APIs, so the rail and the tests share one decision.
// A finished worktree is a + new checkout (under <repo>.worktrees/) whose branch is merged, or a detached
// one that never left the default branch, that is clean, and whose session is gone. Dirty ones are listed
// and kept. Unmerged work is not offered. Activity files for a live session stay. A file just written stays
// through the grace period, unless that session's pid is already known to be dead.

export const ACTIVITY_GRACE_MS = 60_000;

const base = (p) => String(p ?? '').split(/[/\\]/).filter(Boolean).pop() ?? '';
const dirOf = (p) => {
  const s = String(p ?? '').replace(/[/\\]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return '';
  if (i === 0) return s.startsWith('/') ? '/' : '';
  return s.slice(0, i);
};

/** The folder + new creates beside the main checkout: `<repo>.worktrees`. */
export function sessionWorktreeRoot(mainPath) {
  const name = base(mainPath);
  const parent = dirOf(mainPath);
  if (!name || parent === '') return '';
  return parent === '/' ? `/${name}.worktrees` : `${parent}/${name}.worktrees`;
}

/** True when `path` is a checkout + new added under that folder, not the folder itself. */
export function isSessionWorktree(mainPath, path) {
  const root = sessionWorktreeRoot(mainPath);
  if (!root || !path || !path.startsWith(`${root}/`)) return false;
  return path.slice(root.length + 1).length > 0 && !path.slice(root.length + 1).includes('/');
}

/**
 * The main checkout among a worktree list. Git lists it first, and it is the path that is not itself
 * inside a `.worktrees` folder. When only session checkouts were returned, derive it from one of them.
 */
export function mainCheckout(items) {
  const paths = (items ?? []).map((i) => i?.path).filter(Boolean);
  const plain = paths.find((p) => !dirOf(p).endsWith('.worktrees'));
  if (plain) return plain;
  const folder = dirOf(paths[0] ?? '');
  if (!folder.endsWith('.worktrees')) return null;
  const name = base(folder).replace(/\.worktrees$/, '');
  const parent = dirOf(folder);
  if (!name || parent === '') return null;
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

const covers = (cwd, path) => cwd === path || (cwd && path && cwd.startsWith(`${path}/`));

/**
 * Split session worktrees with no live session into ones Remove may delete and ones it only lists.
 * `livePaths` are cwds of sessions whose process is still running. The current checkout is never either.
 * @returns {{ remove: object[], keep: object[] }}
 */
export function planWorktrees(items, { mainPath = null, livePaths = [] } = {}) {
  const main = mainPath || mainCheckout(items);
  const remove = [];
  const keep = [];
  for (const w of items ?? []) {
    if (!w?.path || !isSessionWorktree(main, w.path)) continue;
    if (w.current || livePaths.some((p) => covers(p, w.path))) continue;
    const row = { path: w.path, branch: w.branch ?? null, name: w.name || base(w.path), dirty: w.dirty ?? null };
    // Exactly 0 means git reported a clean tree. null means it could not tell: that stays.
    if (w.dirty !== 0) {
      keep.push({ ...row, reason: w.dirty == null ? 'unknown' : 'dirty' });
      continue;
    }
    // A named branch is finished only once it is merged. A detached + new that never left the
    // default branch (nothing ahead) has no unmerged work either.
    const finished = w.merged === true || (!w.branch && w.ahead === 0);
    if (finished) remove.push({ ...row, dirty: 0, reason: w.branch ? 'merged' : 'contained' });
  }
  return { remove, keep };
}

/** The Sessions / Git row. Null when there is nothing to show. `right` is `remove` or `kept`. */
export function pruneLabel(plan) {
  const remove = plan?.remove ?? [];
  const keep = plan?.keep ?? [];
  if (!remove.length && !keep.length) return null;
  if (remove.length === 1) return { left: `⌫ ${remove[0].branch || remove[0].name || 'worktree'}`, right: 'remove' };
  if (remove.length) return { left: `⌫ ${remove.length} finished`, right: 'remove' };
  const n = keep.length;
  return { left: `⌫ ${n} dirty`, right: 'kept' };
}

/**
 * The worktree to offer after a compact, when that branch is in the removable set. Null past an hour,
 * or when the branch is only listed as dirty.
 */
export function compactOffer(plan, compacted, now = Date.now()) {
  if (!compacted?.after || !Number.isFinite(compacted.at)) return null;
  if (now - compacted.at > 3_600_000 || now < compacted.at) return null;
  return plan?.remove?.find((r) => r.branch === compacted.after) ?? null;
}

/** Activity, desk, and rail-tab files for one session id, or nothing when the id is not a safe file name. */
export function activityNames(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(id)) return [];
  return [`${id}.json`, `${id}.desk.json`, `${id}.rail.json`];
}

/**
 * Names to delete. A live session id is kept whole. A file whose own pid is alive is kept.
 * A session id in `deadIds` (its process is already gone) is deleted even inside the grace window.
 * Anything else just written stays until `graceMs` has passed, so a session that is still starting is not caught.
 * `alive` is `(pid) => boolean`. It defaults to "not alive": pass the real check at the call.
 */
export function staleActivity(entries, { liveIds = [], deadIds = [], now = Date.now(), graceMs = ACTIVITY_GRACE_MS, alive = () => false } = {}) {
  const live = new Set(liveIds);
  const dead = new Set(deadIds);
  const remove = [];
  for (const e of entries ?? []) {
    if (!e?.name || !e.sessionId) continue;
    if (live.has(e.sessionId)) continue;
    if (Number.isInteger(e.pid) && e.pid > 0 && alive(e.pid)) continue;
    if (!dead.has(e.sessionId) && now - (e.mtimeMs || 0) < graceMs) continue;
    remove.push(e.name);
  }
  return remove;
}

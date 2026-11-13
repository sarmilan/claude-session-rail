// The Git tab's tree: open branches, the one line that says what lands next, and the rows it draws.
// Pure (no Node APIs). Git and gh stay in sources.mjs; the rail paints the segments this returns.
import { width, trunc, clean } from './term.mjs';

const show = (s) => clean(String(s ?? ''));
const textOf = (parts) => parts.map((p) => p.text).join('');
const wide = (parts) => width(textOf(parts));
const part = (text, style) => ({ text, style });

const byKey = (a, b) => (a.pr?.number ?? 1e9) - (b.pr?.number ?? 1e9) || a.name.localeCompare(b.name);
const tag = (b) => (b.pr ? `#${b.pr.number}` : b.name);
const checksOf = (b) => b.pr?.checks ?? [];
const passing = (b) => checksOf(b).every((c) => c.state === 'pass');
const failing = (b) => checksOf(b).some((c) => c.state === 'fail');
const pending = (b) => checksOf(b).some((c) => c.state === 'pending');
const dirty = (b) => b.pr?.mergeStateStatus === 'DIRTY';
const conflicted = (b) => Boolean(b.conflict) || (b.conflictFiles?.length ?? 0) > 0 || dirty(b);

// Files this branch changed that another open branch also changed. A branch with no checkout has no list.
function clashFiles(branch, branches) {
  if (!branch.files) return [];
  const own = new Set(branch.files);
  const hit = new Set();
  for (const other of branches) {
    if (other === branch || !other.files) continue;
    for (const file of other.files) if (own.has(file)) hit.add(file);
  }
  return [...hit].sort();
}

function clashWith(branch, branches) {
  if (!branch.files) return [];
  const own = new Set(branch.files);
  const hits = [];
  for (const other of branches) {
    if (other === branch || !other.files) continue;
    const shared = other.files.filter((file) => own.has(file)).sort();
    if (shared.length) hits.push({ other, file: shared[0] });
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || byKey(a.other, b.other));
}

// Parent is the trunk when it is the default branch (or unset). A child of an open branch is not.
const trunkChild = (b, base) => !b.parent || b.parent === base;

// The pull request the banner is about: this checkout if it is a trunk pull request, else the one
// that has been waiting longest. A clash or a dirty merge holds that one. Otherwise the first whose
// checks pass and whose merge state is clean. A child of a branch that is still open is not in this pool.
function bannerSubject(branches, base) {
  const pool = branches.filter((b) => b.pr && trunkChild(b, base)).sort((a, b) => (b.current - a.current) || ((a.pr.updatedAt || '').localeCompare(b.pr.updatedAt || '')));
  let ready = null;
  for (const b of pool) {
    const held = conflicted(b) || clashFiles(b, branches).length > 0;
    if (held) return { branch: b, held: true };
    if (!ready && !b.pr.isDraft && passing(b) && b.pr.mergeStateStatus === 'CLEAN') ready = b;
  }
  return ready ? { branch: ready, held: false } : null;
}

function link(branches, base) {
  const by = new Map(branches.map((b) => [b.name, { ...b, children: [] }]));
  const roots = [];
  for (const n of by.values()) {
    const parent = n.parent && n.parent !== base ? by.get(n.parent) : null;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  // A node is 1 while its descendants are being placed, then 2. A back edge is dropped so a cycle
  // cannot nest, and a node that nothing reaches from a root becomes a root itself.
  const color = new Map();
  const dfs = (n) => {
    color.set(n.name, 1);
    const kept = [];
    for (const c of n.children) {
      const seen = color.get(c.name);
      if (seen === 1) { c.parent = base; continue; }
      if (seen === 2) continue;
      dfs(c);
      kept.push(c);
    }
    n.children = kept;
    color.set(n.name, 2);
  };
  const start = (n) => {
    if (color.get(n.name)) return;
    if (!roots.includes(n)) roots.push(n);
    dfs(n);
  };
  for (const n of [...roots]) start(n);
  for (const n of by.values()) start(n);
  for (const n of by.values()) n.children.sort(byKey);
  roots.sort(byKey);
  return roots.filter((n, i) => roots.indexOf(n) === i);
}

const findNode = (list, name) => {
  for (const n of list) {
    if (n.name === name) return n;
    const found = findNode(n.children, name);
    if (found) return found;
  }
  return null;
};

/**
 * @param {{ base: string|null, onTrunk?: boolean, branches: object[], detached?: {sha: string}[] }} input
 * A branch is { name, parent, checkedOut, current, path, ahead, behind, files, conflict, conflictFiles, pr }.
 * `files` is null when the branch is not checked out. `conflictFiles` is the one merge-tree result.
 */
export function buildTree(input) {
  const base = input.base ?? null;
  const branches = (input.branches ?? []).map((b) => ({ ...b }));
  for (const b of branches) b.clashFiles = clashFiles(b, branches);
  const subject = bannerSubject(branches, base);
  for (const b of branches) {
    const fail = failing(b) || conflicted(b);
    b.tone = fail ? 'red' : b.clashFiles.length ? 'yellow' : subject && !subject.held && subject.branch === b ? 'green' : null;
  }
  const roots = link(branches, base);
  let banner = null;
  if (subject) {
    const b = subject.branch;
    const child = findNode(roots, b.name)?.children[0] ?? null;
    if (subject.held) {
      const hit = clashWith(b, branches)[0];
      const file = hit?.file || b.conflictFiles?.[0] || null;
      banner = { kind: 'held', tone: b.tone === 'red' ? 'red' : 'yellow', branch: b.name, other: hit?.other.name ?? null, file, child: null };
    } else banner = { kind: 'next', tone: 'green', branch: b.name, other: null, file: null, child: child?.name ?? null };
  }
  return { base, onTrunk: Boolean(input.onTrunk), banner, roots, detached: input.detached ?? [], branches };
}

function syncText(b) {
  if (!b.checkedOut || (b.ahead == null && b.behind == null)) return null;
  return `${b.ahead ? `↑${b.ahead}` : ''}${b.behind ? `↓${b.behind}` : ''}`;
}

function columns(nodes) {
  let syncW = 0, prW = 0, any = false, anyPr = false;
  for (const b of nodes) {
    if (!b.checkedOut) continue;
    any = true;
    const s = syncText(b);
    if (s != null) syncW = Math.max(syncW, [...s].length);
    if (b.pr) { anyPr = true; prW = Math.max(prW, `#${b.pr.number}`.length); }
  }
  return { syncW, prW, any, anyPr };
}

function rightParts(b, col) {
  if (!b.checkedOut) return [part('not checked out', 'gray')];
  const parts = [];
  const sync = syncText(b) ?? '';
  if (col.syncW) {
    const bits = [];
    if (b.ahead) bits.push(part(`↑${b.ahead}`, 'green'));
    if (b.behind) bits.push(part(`↓${b.behind}`, 'yellow'));
    const w = bits.reduce((n, p) => n + [...p.text].length, 0);
    if (w < col.syncW) bits.unshift(part(' '.repeat(col.syncW - w), 'plain'));
    parts.push(...bits);
  }
  if (col.anyPr) {
    if (parts.length) parts.push(part(' ', 'plain'));
    const num = b.pr ? `#${b.pr.number}` : '';
    const style = b.pr ? (b.pr.isDraft ? 'gray' : 'purple') : 'plain';
    if (num.length < col.prW) parts.push(part(' '.repeat(col.prW - num.length), 'plain'));
    if (num) parts.push(part(num, style));
  }
  if (col.any) {
    if (parts.length) parts.push(part(' ', 'plain'));
    const lamp = (!b.checkedOut) ? null
      : (failing(b) || conflicted(b)) ? ['✗', 'red']
      : (b.pr?.isDraft || pending(b)) ? ['◌', 'yellow']
      : ['✓', 'green'];
    if (lamp) parts.push(part(lamp[0], lamp[1]));
  }
  return parts;
}

const NAME_COL = 5;

function gutter(node, { last, prefix, open }) {
  const tone = node.tone;
  const style = tone || 'dim';
  const heavy = Boolean(tone);
  const corner = heavy ? (last ? '┗' : '┣') : (last ? '└' : '├');
  const caret = open ? '▾' : '▸';
  const parts = [...prefix, part(corner, style), part(caret, style)];
  let w = wide(parts);
  if (node.current) {
    if (w <= NAME_COL - 2) parts.push(part(' ', 'plain'));
    if (wide(parts) <= NAME_COL - 1) parts.push(part('●', 'accent'));
    w = wide(parts);
  }
  if (w < NAME_COL) parts.push(part(' '.repeat(NAME_COL - w), 'plain'));
  return parts;
}

function padTo(parts, col) {
  const w = wide(parts);
  return w >= col ? parts : [...parts, part(' '.repeat(col - w), 'plain')];
}

function fit(parts, inner) {
  const out = [];
  let used = 0;
  for (const p of parts) {
    const room = inner - used;
    if (room <= 0) break;
    if (width(p.text) <= room) { out.push(p); used += width(p.text); }
    else { out.push(part(trunc(p.text, room), p.style)); break; }
  }
  return out;
}

function bannerParts(tree) {
  const b = tree.banner;
  if (!b) return null;
  const by = new Map(tree.branches.map((n) => [n.name, n]));
  const subject = by.get(b.branch);
  const parts = [part('▌', b.tone), part(b.kind === 'next' ? ' Next' : ' Held', b.tone), part('  ', 'plain')];
  const mark = (node) => (node?.pr ? part(tag(node), node.pr.isDraft ? 'gray' : 'purple') : part(show(node?.name ?? ''), b.tone));
  if (b.kind === 'next') {
    parts.push(part('merge ', 'plain'), mark(subject));
    if (b.child) {
      const child = by.get(b.child);
      parts.push(part(' · rebase ', 'plain'), mark(child));
    }
  } else if (b.other) {
    parts.push(mark(subject), part(' and ', 'plain'), mark(by.get(b.other)), part(' · ', 'plain'), part(show(b.file ?? ''), b.tone));
  } else {
    parts.push(mark(subject));
    if (b.file) parts.push(part(' · ', 'plain'), part(show(b.file), b.tone));
  }
  return parts;
}

const checkOrder = { fail: 0, pending: 1, pass: 2 };
const LAMP = { fail: ['✗', 'red', 'failing'], pending: ['◌', 'yellow', 'running'], pass: ['✓', 'green', ''] };

function detailLead(prefix) {
  return padTo(prefix.map((p) => ({ ...p })), NAME_COL);
}

/**
 * Rows for one frame. `open` is { [branch]: true } for lanes expanded in place.
 * Diff stats are this checkout's, from the environment, so they move between the minute refreshes.
 */
export function layoutTree(tree, { inner = 40, open = {}, added = 0, removed = 0, dirty = 0, sessionLabel = () => 'Go to session' } = {}) {
  const nodes = [];
  const walkFlat = (n) => { nodes.push(n); n.children.forEach(walkFlat); };
  tree.roots.forEach(walkFlat);
  const col = columns(nodes);
  const rows = [];
  if (tree.base) {
    const here = !nodes.some((n) => n.current) && tree.onTrunk;
    rows.push({
      id: null, activate: null, branch: tree.base,
      left: [part('│ ', 'dim'), part(show(tree.base), here ? 'accent' : 'dim')],
      right: here ? [part('●', 'accent')] : [],
    });
  }
  const emit = (list, prefix) => {
    list.forEach((node, i) => {
      const last = i === list.length - 1;
      const isOpen = Boolean(open[node.name]);
      const tone = node.tone;
      const stroke = part(tone ? '┃' : '│', tone || 'dim');
      const gut = gutter(node, { last, prefix, open: isOpen });
      const right = rightParts(node, col);
      const room = inner - wide(gut) - (wide(right) ? wide(right) + 1 : 0);
      const left = [...gut, part(trunc(show(node.name), Math.max(1, room)), node.current ? 'accent' : (tone || 'plain'))];
      rows.push({
        id: `lane:${node.name}`, activate: 'toggle', branch: node.name, path: node.path, url: node.pr?.url ?? null, pr: node.pr?.number ?? null,
        left, right,
      });
      const childPrefix = isOpen
        ? (last ? [...prefix, stroke, part(' ', 'plain')] : [...prefix, part('│', 'dim'), stroke])
        : (last ? [...prefix, part('  ', 'plain')] : [...prefix, part('│', 'dim'), part(' ', 'plain')]);
      if (isOpen) {
        const lead = detailLead(last ? [...prefix, stroke] : [...prefix, part('│', 'dim'), stroke]);
        const push = (extra, activate, extraFields = {}) => rows.push({
          id: extraFields.id ?? null, activate, branch: node.name, path: node.path, url: extraFields.url ?? null, pr: node.pr?.number ?? null,
          left: fit([...lead, ...extra.left], inner - wide(extra.right ?? []) - (extra.right?.length ? 1 : 0)),
          right: extra.right ?? [],
        });
        if (node.current && (added || removed || dirty)) {
          const bits = [];
          if (added || removed) {
            if (added) bits.push(part(`+${added}`, 'green'));
            if (added && removed) bits.push(part(' ', 'plain'));
            if (removed) bits.push(part(`−${removed}`, 'red'));
          }
          if (dirty) bits.push(part(`${bits.length ? ' · ' : ''}${dirty} uncommitted`, 'yellow'));
          push({ left: bits }, null);
        }
        for (const file of node.clashFiles) push({ left: [part('clash  ', 'yellow'), part(show(file), 'yellow')] }, null);
        for (const file of node.conflictFiles ?? []) push({ left: [part('conflict  ', 'red'), part(show(file), 'red')] }, null);
        const checks = [...checksOf(node)].sort((a, b) => checkOrder[a.state] - checkOrder[b.state]);
        const seen = {};
        for (const c of checks) {
          const [mark, style, note] = LAMP[c.state] ?? LAMP.pending;
          const key = `${c.name}\x1f${c.url}`;
          const n = (seen[key] = (seen[key] ?? 0) + 1);
          push({
            left: [part(`${mark} `, style), part(show(c.name), 'plain')],
            right: note ? [part(note, 'dim')] : [],
          }, c.url ? 'check' : null, { id: `check:${node.name}:${key}${n > 1 ? `#${n}` : ''}`, url: c.url });
        }
        if (node.pr?.reviewDecision === 'CHANGES_REQUESTED') {
          push({ left: [part('changes requested', 'yellow')] }, null);
          if (node.reviewLine) push({ left: [part(show(node.reviewLine), 'plain')] }, null);
        }
        if (node.checkedOut && node.path) push({ left: [part(sessionLabel(node), 'plain')] }, 'session', { id: `act:${node.name}:session` });
        if (node.pr?.url) push({ left: [part(`Open PR #${node.pr.number}`, 'plain')] }, 'pr', { id: `act:${node.name}:pr`, url: node.pr.url });
        if (node.name) push({ left: [part('Copy branch name', 'plain')] }, 'copy', { id: `act:${node.name}:copy` });
      }
      emit(node.children, childPrefix);
    });
  };
  emit(tree.roots, []);
  for (const d of tree.detached ?? []) {
    rows.push({ id: null, activate: null, branch: null, left: [part(`detached at ${show(d.sha)}`, 'dim')], right: [] });
  }
  const banner = bannerParts(tree);
  return { banner: banner ? fit(banner, inner) : null, rows };
}

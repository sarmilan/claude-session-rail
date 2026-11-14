import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildTree, layoutTree, reviewLineFrom } from '../bin/branchmap.mjs';
import { branchMap, conflictNames, worktrees } from '../bin/sources.mjs';
import { width } from '../bin/term.mjs';

const text = (parts) => (parts ?? []).map((p) => p.text).join('');
const pull = (number, extra = {}) => ({
  number, isDraft: false, url: `https://example.test/${number}`,
  mergeStateStatus: 'CLEAN', updatedAt: `2020-01-${String(number).padStart(2, '0')}T00:00:00Z`,
  reviewDecision: '', checks: [{ name: 'test', state: 'pass', url: `https://example.test/c/${number}` }],
  ...extra,
});
const branch = (name, extra = {}) => ({
  name, parent: 'main', checkedOut: true, current: false, path: `/wt/${name}`,
  ahead: 1, behind: 0, files: [], conflict: false, conflictFiles: [], pr: null, ...extra,
});
const treeOf = (branches, extra = {}) => buildTree({ base: 'main', branches, ...extra });
const flat = (roots) => {
  const out = [];
  const walk = (n, depth) => { out.push({ name: n.name, depth }); n.children.forEach((c) => walk(c, depth + 1)); };
  roots.forEach((n) => walk(n, 1));
  return out;
};
const lineOf = (row, inner = 40) => {
  const left = text(row.left), right = text(row.right);
  const gap = Math.max(right ? 1 : 0, inner - width(left) - width(right));
  return left + ' '.repeat(gap) + right;
};
const lane = (view, name) => view.rows.find((r) => r.branch === name && r.activate === 'toggle');

test('Next names the trunk pull request and the child that rebases after it', () => {
  const tree = treeOf([
    branch('feature/35-branch-map', { current: true, ahead: 4, behind: 1, pr: pull(35) }),
    branch('feature/36-colours', { parent: 'feature/35-branch-map', ahead: 2, pr: pull(36, { isDraft: true, checks: [{ name: 'test', state: 'pending', url: 'u' }] }) }),
    branch('feature/40-pets', { pr: pull(40, { checks: [{ name: 'lint', state: 'fail', url: 'u' }] }) }),
    branch('feature/41-api', { checkedOut: false, path: null, ahead: 9, behind: 9, files: ['secret'], pr: pull(41) }),
  ]);
  assert.equal(tree.banner.kind, 'next');
  assert.equal(tree.banner.branch, 'feature/35-branch-map');
  assert.equal(tree.banner.child, 'feature/36-colours');
  assert.equal(text(layoutTree(tree).banner), '▌ Next  merge #35 · rebase #36');
  const child = flat(tree.roots).find((n) => n.name === 'feature/36-colours');
  assert.equal(child.depth, 2);
  assert.notEqual(tree.banner.branch, 'feature/36-colours');
});

test('a child whose parent is open does not take the banner', () => {
  const tree = treeOf([
    branch('parent', { pr: pull(35, { mergeStateStatus: 'BEHIND' }) }),
    branch('child', { parent: 'parent', current: true, pr: pull(36) }),
  ]);
  assert.equal(tree.banner, null);
});

test('the current trunk pull request is held before a cleaner sibling', () => {
  const tree = treeOf([
    branch('older', { pr: pull(10, { updatedAt: '2019-01-01T00:00:00Z' }) }),
    branch('mine', { current: true, pr: pull(35, { mergeStateStatus: 'DIRTY', updatedAt: '2024-06-01T00:00:00Z' }) }),
  ]);
  assert.equal(tree.banner.kind, 'held');
  assert.equal(tree.banner.branch, 'mine');
  assert.equal(tree.banner.tone, 'red');
});

test('a ready trunk pull request is not replaced by a later held sibling', () => {
  const current = treeOf([
    branch('older', { files: ['desk.mjs'], pr: pull(10, { mergeStateStatus: 'DIRTY', updatedAt: '2019-01-01T00:00:00Z' }) }),
    branch('mine', { current: true, files: ['rail.mjs'], pr: pull(35, { updatedAt: '2024-06-01T00:00:00Z' }) }),
  ]);
  assert.equal(current.banner.kind, 'next');
  assert.equal(current.banner.branch, 'mine');
  const waiting = treeOf([
    branch('old', { pr: pull(10, { updatedAt: '2019-01-01T00:00:00Z' }) }),
    branch('newer', { files: ['rail.mjs'], pr: pull(40, { mergeStateStatus: 'DIRTY', updatedAt: '2024-01-01T00:00:00Z' }) }),
  ]);
  assert.equal(waiting.banner.kind, 'next');
  assert.equal(waiting.banner.branch, 'old');
});

test('a child that keeps editing its parent does not hold the stack', () => {
  const tree = treeOf([
    branch('parent', { current: true, files: ['rail.mjs', 'desk.mjs'], pr: pull(35) }),
    branch('child', { parent: 'parent', files: ['rail.mjs'], pr: pull(36) }),
    branch('grandchild', { parent: 'child', files: ['rail.mjs'] }),
    branch('sibling', { files: ['desk.mjs'], pr: pull(40) }),
  ]);
  assert.equal(tree.banner.kind, 'held');
  assert.equal(tree.banner.other, 'sibling');
  assert.equal(tree.banner.file, 'desk.mjs');
  assert.deepEqual(tree.branches.find((b) => b.name === 'child').clashFiles, []);
  assert.deepEqual(tree.branches.find((b) => b.name === 'grandchild').clashFiles, []);
  const stacked = treeOf([
    branch('parent', { current: true, files: ['rail.mjs'], pr: pull(35) }),
    branch('child', { parent: 'parent', files: ['rail.mjs'], pr: pull(36) }),
  ]);
  assert.equal(stacked.banner.kind, 'next');
  assert.equal(stacked.banner.child, 'child');
  assert.deepEqual(stacked.branches.map((b) => b.clashFiles), [[], []]);
});

test('a shared file holds the banner, and a clean conflict list leaves that file in place', () => {
  const branches = [
    branch('feature/35-branch-map', { current: true, files: ['rail.mjs'], conflictFiles: [], pr: pull(35) }),
    branch('feature/40-pets', { files: ['rail.mjs', 'desk.mjs'], pr: pull(40) }),
  ];
  const tree = treeOf(branches);
  assert.equal(tree.banner.kind, 'held');
  assert.equal(tree.banner.tone, 'yellow');
  assert.equal(tree.banner.file, 'rail.mjs');
  assert.equal(text(layoutTree(tree).banner), '▌ Held  #35 and #40 · rail.mjs');
  const open = layoutTree(tree, { open: { 'feature/35-branch-map': true } });
  const rows = open.rows.map((r) => text(r.left));
  assert.ok(rows.some((r) => r.includes('clash  rail.mjs')));
  assert.equal(rows.some((r) => r.includes('conflict  ')), false);
  assert.deepEqual(branches[0].files, ['rail.mjs']);
});

test('a real conflict keeps the shared file and adds the conflict file beside it', () => {
  const tree = treeOf([
    branch('feature/35-branch-map', { current: true, files: ['rail.mjs'], conflict: true, conflictFiles: ['desk.mjs'], pr: pull(35) }),
    branch('feature/40-pets', { files: ['rail.mjs'], pr: pull(40, { checks: [{ name: 'lint', state: 'fail', url: 'u' }] }) }),
  ]);
  assert.equal(tree.banner.kind, 'held');
  assert.equal(tree.banner.file, 'rail.mjs');
  assert.equal(tree.banner.tone, 'red');
  const rows = layoutTree(tree, { open: { 'feature/35-branch-map': true } }).rows.map((r) => text(r.left));
  const clash = rows.findIndex((r) => r.includes('clash  rail.mjs'));
  const conflict = rows.findIndex((r) => r.includes('conflict  desk.mjs'));
  assert.ok(clash >= 0 && conflict === clash + 1);
});

test('red wins over yellow when a check fails and a file is shared', () => {
  const tree = treeOf([
    branch('a', { current: true, files: ['rail.mjs'], pr: pull(35, { checks: [{ name: 'lint', state: 'fail', url: 'u' }] }) }),
    branch('b', { files: ['rail.mjs'], pr: pull(40) }),
  ]);
  assert.equal(tree.banner.tone, 'red');
  assert.equal(tree.branches.find((b) => b.name === 'a').tone, 'red');
});

test('a failing, draft, or behind pull request is neither Next nor Held', () => {
  for (const pr of [
    pull(35, { checks: [{ name: 'lint', state: 'fail', url: 'u' }] }),
    pull(35, { isDraft: true }),
    pull(35, { mergeStateStatus: 'BEHIND' }),
    pull(35, { mergeStateStatus: 'BLOCKED' }),
    pull(35, { checks: [{ name: 'test', state: 'pending', url: 'u' }] }),
  ]) assert.equal(treeOf([branch('a', { pr })]).banner, null);
  const ready = treeOf([branch('a', { pr: pull(35, { checks: [] }) })]);
  assert.equal(ready.banner.kind, 'next');
  assert.equal(text(layoutTree(ready).banner), '▌ Next  merge #35');
});

test('names stay in one column and the right side lines up', () => {
  const tree = treeOf([
    branch('feature/35-branch-map', { current: true, ahead: 4, behind: 1, pr: pull(35) }),
    branch('feature/36-colours', { parent: 'feature/35-branch-map', ahead: 2, behind: 0, pr: pull(36, { isDraft: true, checks: [{ name: 'test', state: 'pending', url: 'u' }] }) }),
    branch('feature/40-pets', { ahead: 0, behind: 0, pr: pull(40, { checks: [{ name: 'lint', state: 'fail', url: 'u' }] }) }),
    branch('feature/41-api', { checkedOut: false, path: null, ahead: null, behind: null, files: null, pr: pull(41, { checks: [] }) }),
  ]);
  const view = layoutTree(tree);
  const lines = Object.fromEntries(view.rows.filter((r) => r.activate === 'toggle').map((r) => [r.branch, lineOf(r)]));
  for (const row of view.rows.filter((r) => r.activate === 'toggle')) assert.equal(text(row.left).indexOf(row.branch), 5, row.branch);
  assert.equal(text(lane(view, 'feature/35-branch-map').left).slice(0, 5), '┣▸ ● ');
  assert.equal(text(lane(view, 'feature/36-colours').left).slice(0, 5), '│ └▸ ');
  assert.equal(text(lane(view, 'feature/40-pets').left).slice(0, 5), '┣▸   ');
  assert.equal(text(lane(view, 'feature/41-api').left).slice(0, 5), '└▸   ');
  assert.equal(lines['feature/41-api'].trimEnd().endsWith('not checked out'), true);
  assert.equal(lines['feature/41-api'].includes('↑'), false);
  const hashAt = (name) => lines[name].indexOf('#');
  assert.equal(hashAt('feature/35-branch-map'), hashAt('feature/36-colours'));
  assert.equal(hashAt('feature/36-colours'), hashAt('feature/40-pets'));
  assert.equal(lane(view, 'feature/35-branch-map').left.find((p) => p.text === '●').style, 'accent');
  assert.equal(lane(view, 'feature/35-branch-map').left.at(-1).style, 'accent');
  assert.equal(lane(view, 'feature/35-branch-map').left.find((p) => p.text === '┣').style, 'green');
  assert.equal(lane(view, 'feature/40-pets').left.find((p) => p.text === '┣').style, 'red');
  assert.equal(lane(view, 'feature/40-pets').left.at(-1).style, 'red');
  const right = (name) => lane(view, name).right;
  assert.equal(right('feature/35-branch-map').find((p) => p.text.startsWith('↑')).style, 'green');
  assert.equal(right('feature/35-branch-map').find((p) => p.text.startsWith('↓')).style, 'yellow');
  assert.equal(right('feature/36-colours').find((p) => p.text.startsWith('#')).style, 'gray');
  assert.equal(right('feature/35-branch-map').find((p) => p.text.startsWith('#')).style, 'purple');
  assert.equal(right('feature/35-branch-map').at(-1).text, '✓');
  assert.equal(right('feature/40-pets').at(-1).text, '✗');
  assert.equal(right('feature/36-colours').at(-1).text, '◌');
  assert.equal(right('feature/41-api').map((p) => p.text).join(''), 'not checked out');
});

test('an open lane keeps its stroke and the child in the same column', () => {
  const tree = treeOf([
    branch('feature/35-branch-map', { current: true, ahead: 4, behind: 1, files: ['rail.mjs'], pr: pull(35, { reviewDecision: 'CHANGES_REQUESTED' }), reviewLine: 'the spine is not the stack' }),
    branch('feature/36-colours', { parent: 'feature/35-branch-map', ahead: 2, pr: pull(36, { isDraft: true, checks: [{ name: 'test', state: 'pending', url: 'u' }] }) }),
    branch('feature/40-pets', { pr: pull(40) }),
  ]);
  const view = layoutTree(tree, { open: { 'feature/35-branch-map': true }, added: 42, removed: 7, dirty: 3 });
  const body = view.rows.filter((r) => r.branch === 'feature/35-branch-map').map((r) => text(r.left));
  assert.equal(text(view.rows.find((r) => r.activate === 'toggle' && r.branch === 'feature/35-branch-map').left).slice(0, 5), '┣▾ ● ');
  assert.equal(body[1].slice(0, 5), '│┃   ');
  assert.match(body[1], /\+42 −7 · 3 uncommitted/);
  const child = view.rows.find((r) => r.branch === 'feature/36-colours' && r.activate === 'toggle');
  assert.equal(text(child.left).slice(0, 5), '│┃└▸ ');
  assert.equal(text(child.left).indexOf('feature/36-colours'), 5);
  const styles = view.rows.find((r) => text(r.left).includes('+42')).left.map((p) => [p.text, p.style]);
  assert.deepEqual(styles.filter(([, s]) => s !== 'plain').map((p) => p[1]), ['dim', 'green', 'green', 'red', 'yellow']);
  const check = view.rows.find((r) => r.activate === 'check');
  assert.equal(check.left.find((p) => p.text.trim() === '✓').style, 'green');
  assert.ok(text(check.left).includes('test'));
  const ordered = layoutTree(treeOf([branch('a', { pr: pull(35, { checks: [{ name: 'test', state: 'pass', url: 'u' }, { name: 'lint', state: 'fail', url: 'u' }] }) })]), { open: { a: true } });
  const orderedChecks = ordered.rows.filter((r) => r.activate === 'check');
  assert.match(text(orderedChecks[0].left), /lint/);
  assert.match(text(orderedChecks[1].left), /test/);
  assert.equal(view.rows.find((r) => text(r.left).includes('changes requested')).left.at(-1).style, 'yellow');
  assert.ok(view.rows.some((r) => text(r.left).includes('the spine is not the stack')));
  assert.deepEqual(view.rows.filter((r) => r.activate === 'session' || r.activate === 'pr' || r.activate === 'copy').map((r) => r.activate), ['session', 'pr', 'copy']);
  assert.equal(view.rows.some((r) => /rebase|restack/i.test(text(r.left) + text(r.right))), false);
});

test('a current child keeps the bullet in the gutter so the name stays put', () => {
  const tree = treeOf([
    branch('parent', { pr: pull(35) }),
    branch('child', { parent: 'parent', current: true, pr: pull(36) }),
    branch('later', { pr: pull(40) }),
  ]);
  const row = lane(layoutTree(tree), 'child');
  assert.equal(text(row.left).slice(0, 5), '│ └▸●');
  assert.equal(text(row.left).indexOf('child'), 5);
  assert.equal(row.left.find((p) => p.text === '●').style, 'accent');
  assert.equal(row.left.at(-1).style, 'accent');
});

test('the trunk is the default branch, and a cycle is not nested twice', () => {
  const onTrunk = layoutTree(treeOf([], { onTrunk: true }));
  assert.equal(text(onTrunk.rows[0].left), '│ main');
  assert.equal(onTrunk.rows[0].left.at(-1).style, 'accent');
  assert.equal(text(onTrunk.rows[0].right), '●');
  const off = treeOf([
    branch('child', { parent: 'parent', pr: pull(2) }),
    branch('parent', { pr: pull(1) }),
  ]);
  assert.deepEqual(flat(off.roots).map((n) => `${n.depth}:${n.name}`), ['1:parent', '2:child']);
  const cycle = treeOf([
    branch('a', { parent: 'b', pr: pull(1) }),
    branch('b', { parent: 'a', pr: pull(2) }),
  ]);
  const seen = flat(cycle.roots);
  assert.equal(seen.length, 2);
  assert.equal(new Set(seen.map((n) => n.name)).size, 2);
  const detached = layoutTree(treeOf([], { detached: [{ sha: 'abc1234' }] }));
  assert.equal(text(detached.rows.at(-1).left), 'detached at abc1234');
  assert.equal(detached.rows.at(-1).activate, null);
});

test('a child with no pull request is named, not numbered', () => {
  const tree = treeOf([
    branch('feature/35-branch-map', { pr: pull(35) }),
    branch('colours', { parent: 'feature/35-branch-map' }),
  ]);
  assert.equal(text(layoutTree(tree).banner), '▌ Next  merge #35 · rebase colours');
});

test('the review line is the first line of the latest changes request, under the checks', () => {
  assert.equal(reviewLineFrom([
    { state: 'APPROVED', body: 'ship it', submittedAt: '2024-01-02T00:00:00Z' },
    { state: 'CHANGES_REQUESTED', body: 'the spine is not the stack\nmore', submittedAt: '2024-01-01T00:00:00Z' },
    { state: 'CHANGES_REQUESTED', body: '\n  newer line\n', submittedAt: '2024-02-01T00:00:00Z' },
  ]), 'newer line');
  assert.equal(reviewLineFrom([]), null);
  assert.equal(reviewLineFrom([{ state: 'COMMENTED', body: 'a note' }]), null);
  const tree = treeOf([branch('a', {
    pr: pull(35, { reviewDecision: 'CHANGES_REQUESTED', checks: [{ name: 'test', state: 'pass', url: 'u' }, { name: 'lint', state: 'fail', url: 'u' }] }),
    reviewLine: 'the spine is not the stack',
  })]);
  const closed = text(lane(layoutTree(tree), 'a').left) + text(lane(layoutTree(tree), 'a').right);
  assert.equal(closed.includes('changes'), false);
  const rows = layoutTree(tree, { open: { a: true } }).rows.filter((r) => r.branch === 'a');
  const labels = rows.map((r) => text(r.left));
  const at = (s) => labels.findIndex((l) => l.includes(s));
  assert.ok(at('lint') < at('test') && at('test') < at('changes requested') && at('changes requested') < at('the spine is not the stack'));
  assert.equal(rows.find((r) => text(r.left).includes('the spine is not the stack')).left.at(-1).style, 'plain');
  assert.equal(rows.find((r) => text(r.left).includes('changes requested')).left.at(-1).style, 'yellow');
});

test('conflict names are the file list after the tree id', () => {
  assert.deepEqual(conflictNames('abc123\nrail.mjs\ndesk.mjs\n\nCONFLICT (content): Merge conflict in rail.mjs\n'), ['rail.mjs', 'desk.mjs']);
  assert.deepEqual(conflictNames('abc123\n'), []);
  assert.deepEqual(conflictNames(''), []);
});

const git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd }, (err, stdout) => (err ? reject(err) : resolve(stdout.toString())));
});

test('two branches at the same commit both hang from the trunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'branchmap-same-'));
  const repo = join(root, 'repo');
  const wtA = join(root, 'wt-a');
  const wtB = join(root, 'wt-b');
  try {
    await mkdir(repo);
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'dev@example.com']);
    await git(repo, ['config', 'user.name', 'Dev']);
    await writeFile(join(repo, 'file.txt'), 'm\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base']);
    await git(repo, ['branch', 'feature-a']);
    await git(repo, ['branch', 'feature-b']);
    await git(repo, ['worktree', 'add', wtA, 'feature-a']);
    await git(repo, ['worktree', 'add', wtB, 'feature-b']);
    const map = await branchMap(repo, await worktrees(repo), { ok: true, items: [] });
    const by = Object.fromEntries(map.branches.map((b) => [b.name, b]));
    assert.equal(by['feature-a'].parent, 'main');
    assert.equal(by['feature-b'].parent, 'main');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a real repo parents a branch on its ancestor and keeps both file lists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'branchmap-'));
  const repo = join(root, 'repo');
  const wtA = join(root, 'wt-a');
  const wtB = join(root, 'wt-b');
  try {
    await mkdir(repo);
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'dev@example.com']);
    await git(repo, ['config', 'user.name', 'Dev']);
    await writeFile(join(repo, 'file.txt'), 'm\n');
    await writeFile(join(repo, 'shared.txt'), 'm\n');
    await writeFile(join(repo, 'unique-a.txt'), 'm\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base']);
    await git(repo, ['branch', 'feature-a']);
    await git(repo, ['worktree', 'add', wtA, 'feature-a']);
    await writeFile(join(wtA, 'shared.txt'), 'a\n');
    await writeFile(join(wtA, 'unique-a.txt'), 'a\n');
    await git(wtA, ['add', '.']);
    await git(wtA, ['commit', '-m', 'a']);
    await git(repo, ['branch', 'feature-b', 'feature-a']);
    await git(repo, ['worktree', 'add', wtB, 'feature-b']);
    await writeFile(join(wtB, 'shared.txt'), 'b\n');
    await git(wtB, ['add', '.']);
    await git(wtB, ['commit', '-m', 'b']);
    await writeFile(join(repo, 'unique-a.txt'), 'm2\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'main moves']);
    const merged = await new Promise((resolve) => {
      execFile('git', ['merge-tree', '--write-tree', '--name-only', 'main', 'feature-a'], { cwd: repo }, (err, stdout) => {
        resolve({ code: err ? err.code : 0, out: stdout?.toString() ?? '' });
      });
    });
    assert.equal(merged.code, 1);
    assert.deepEqual(conflictNames(merged.out), ['unique-a.txt']);
    const prs = { ok: true, items: [
      { ...pull(35), headRefName: 'feature-a', baseRefName: 'main', title: 'a' },
      { ...pull(41), headRefName: 'feature-ghost', baseRefName: 'feature-missing', title: 'ghost', checks: [] },
    ] };
    const map = await branchMap(wtB, await worktrees(wtB), prs);
    assert.equal(map.ok, true);
    assert.equal(map.base, 'main');
    const by = Object.fromEntries(map.branches.map((b) => [b.name, b]));
    assert.equal(by.main, undefined);
    assert.equal(by['feature-b'].parent, 'feature-a');
    assert.equal(by['feature-b'].current, true);
    assert.equal(by['feature-b'].ahead, 1);
    assert.equal(by['feature-b'].behind, 0);
    assert.deepEqual(by['feature-b'].files, ['shared.txt']);
    assert.ok(by['feature-a'].files.includes('shared.txt'));
    assert.ok(by['feature-a'].files.includes('unique-a.txt'));
    assert.deepEqual(by['feature-a'].conflictFiles, ['unique-a.txt']);
    assert.equal(by['feature-a'].conflict, true);
    assert.equal(by['feature-missing'].checkedOut, false);
    assert.equal(by['feature-missing'].parent, 'main');
    assert.equal(by['feature-ghost'].parent, 'feature-missing');
    assert.equal(by['feature-ghost'].checkedOut, false);
    assert.equal(by['feature-ghost'].ahead, null);
    assert.equal(by['feature-ghost'].files, null);
    const view = layoutTree(buildTree({ base: map.base, branches: map.branches, detached: map.detached }), { open: { 'feature-a': true } });
    assert.equal(view.banner.find((p) => p.text === ' Held').style, 'red');
    assert.equal(text(view.banner).includes('unique-a.txt'), true);
    const rows = view.rows.filter((r) => r.branch === 'feature-a').map((r) => text(r.left));
    assert.equal(rows.some((r) => r.includes('clash  ')), false);
    assert.ok(rows.some((r) => r.includes('conflict  unique-a.txt')));
    const ghost = view.rows.find((r) => r.branch === 'feature-ghost');
    assert.equal(text(ghost.right), 'not checked out');
    assert.equal(view.rows.some((r) => r.branch === 'feature-ghost' && r.activate === 'session'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  activityNames, compactOffer, isSessionWorktree, mainCheckout, planWorktrees, pruneLabel, sessionWorktreeRoot, staleActivity,
} from '../bin/prune.mjs';
import { forgetSession, pruneActivity, removeWorktree, worktrees } from '../bin/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' } }, (err, stdout, stderr) => {
    if (err) reject(new Error(`${args.join(' ')}\n${stderr?.toString() ?? err.message}`));
    else resolve(stdout.toString());
  });
});

const wt = (path, extra = {}) => ({
  path, branch: 'feature/x', name: path.split('/').pop(), current: false, dirty: 0, merged: true, ahead: 0, behind: 2, ...extra,
});

test('a session worktree is a checkout directly under <repo>.worktrees', () => {
  assert.equal(sessionWorktreeRoot('/work/repo'), '/work/repo.worktrees');
  assert.equal(isSessionWorktree('/work/repo', '/work/repo.worktrees/login'), true);
  assert.equal(isSessionWorktree('/work/repo', '/work/repo'), false);
  assert.equal(isSessionWorktree('/work/repo', '/work/repo.worktrees'), false);
  assert.equal(isSessionWorktree('/work/repo', '/work/elsewhere'), false);
  assert.equal(isSessionWorktree('/work/repo', '/work/repo.worktrees/login/nested'), false);
  assert.equal(mainCheckout([{ path: '/work/repo' }, { path: '/work/repo.worktrees/login' }]), '/work/repo');
  assert.equal(mainCheckout([{ path: '/work/repo.worktrees/login' }]), '/work/repo');
});

test('only a merged clean worktree whose session is gone can be removed', () => {
  const main = '/work/repo';
  const items = [
    wt('/work/repo', { branch: 'main', name: 'repo', current: true, merged: false, ahead: 0, behind: 0 }),
    wt('/work/repo.worktrees/done', { branch: 'feature/done' }),
    wt('/work/repo.worktrees/dirty', { branch: 'feature/dirty', dirty: 2 }),
    wt('/work/repo.worktrees/unknown', { branch: 'feature/unknown', dirty: null }),
    wt('/work/repo.worktrees/open', { branch: 'feature/open', merged: false, ahead: 3, behind: 0 }),
    wt('/work/repo.worktrees/empty', { branch: 'feature/empty', merged: false, ahead: 0, behind: 0 }),
    wt('/work/repo.worktrees/live', { branch: 'feature/live' }),
    wt('/work/repo.worktrees/fresh', { branch: null, merged: false, ahead: 0, behind: 0 }),
    wt('/work/repo.worktrees/commits', { branch: null, merged: false, ahead: 1, behind: 0 }),
    wt('/work/elsewhere', { branch: 'feature/side' }),
  ];
  const plan = planWorktrees(items, { mainPath: main, livePaths: ['/work/repo.worktrees/live'] });
  assert.deepEqual(plan.remove.map((r) => r.path), ['/work/repo.worktrees/done', '/work/repo.worktrees/fresh']);
  assert.deepEqual(plan.keep.map((r) => [r.branch, r.reason]), [
    ['feature/dirty', 'dirty'],
    ['feature/unknown', 'unknown'],
  ]);
  assert.equal(plan.remove.some((r) => r.path.endsWith('/live')), false);
  assert.equal(plan.remove.some((r) => r.branch === 'feature/open'), false);
  assert.equal(plan.remove.some((r) => r.branch === 'feature/empty'), false);
  assert.equal(pruneLabel(plan).right, 'remove');
  assert.equal(pruneLabel({ remove: [], keep: plan.keep }).right, 'kept');
  assert.equal(pruneLabel({ remove: [], keep: [] }), null);
});

test('a compact offers the removable worktree for that branch, for an hour', () => {
  const plan = planWorktrees([
    wt('/work/repo.worktrees/done', { branch: 'feature/done' }),
    wt('/work/repo.worktrees/dirty', { branch: 'feature/dirty', dirty: 1 }),
  ], { mainPath: '/work/repo' });
  assert.equal(compactOffer(plan, { after: 'feature/done', at: 1_000 }, 2_000)?.path, '/work/repo.worktrees/done');
  assert.equal(compactOffer(plan, { after: 'feature/dirty', at: 1_000 }, 2_000), null);
  assert.equal(compactOffer(plan, { after: 'feature/done', at: 1_000 }, 1_000 + 3_600_001), null);
  assert.equal(compactOffer(plan, null, 2_000), null);
});

test('stale activity files go, and a live or just-written session stays', () => {
  const now = 1_000_000;
  const old = now - 120_000;
  const fresh = now - 1_000;
  const entries = [
    { name: 'live.json', sessionId: 'live', mtimeMs: old },
    { name: 'live.desk.json', sessionId: 'live', mtimeMs: old, pid: 9 },
    { name: 'dead.json', sessionId: 'dead', mtimeMs: fresh },
    { name: 'dead.desk.json', sessionId: 'dead', mtimeMs: fresh, pid: 4 },
    { name: 'dead.rail.json', sessionId: 'dead', mtimeMs: fresh },
    { name: 'starting.json', sessionId: 'starting', mtimeMs: fresh },
    { name: 'ancient.json', sessionId: 'ancient', mtimeMs: old },
    { name: 'busy.json', sessionId: 'busy', mtimeMs: old, pid: 7 },
    { name: 'notes.txt', sessionId: '', mtimeMs: old },
  ];
  const gone = staleActivity(entries, {
    liveIds: ['live'], deadIds: ['dead'], now, alive: (pid) => pid === 7,
  });
  assert.deepEqual(gone.sort(), ['ancient.json', 'dead.desk.json', 'dead.json', 'dead.rail.json']);
  assert.equal(activityNames('live').join(','), 'live.json,live.desk.json,live.rail.json');
  assert.deepEqual(activityNames('../etc/passwd'), []);
  assert.deepEqual(activityNames(''), []);
});

test('pruneActivity deletes the dead session and leaves the live one and a file just written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prune-act-'));
  const dir = join(root, 'activity');
  await mkdir(dir);
  const now = Date.now();
  await writeFile(join(dir, 'live.json'), JSON.stringify({ claude: { state: 'waiting' }, pid: 1 }));
  await writeFile(join(dir, 'live.desk.json'), JSON.stringify({ pid: 1 }));
  await writeFile(join(dir, 'dead.json'), JSON.stringify({ claude: { state: 'waiting' }, pid: 4 }));
  await writeFile(join(dir, 'dead.desk.json'), JSON.stringify({ pid: 4, review: { kind: 'approach review' } }));
  await writeFile(join(dir, 'dead.rail.json'), JSON.stringify({ tab: 'git' }));
  await writeFile(join(dir, 'starting.json'), JSON.stringify({ claude: { state: 'thinking' } }));
  await writeFile(join(dir, 'ancient.json'), JSON.stringify({ claude: { state: 'waiting' } }));
  await writeFile(join(dir, 'notes.txt'), 'leave me');
  const old = new Date(now - 120_000);
  await utimes(join(dir, 'ancient.json'), old, old);
  await utimes(join(dir, 'dead.json'), old, old);
  try {
    const swept = await pruneActivity({
      liveIds: ['live'], deadIds: ['dead'], dir, now, scan: false, alive: () => false,
    });
    assert.equal(swept.ok, true);
    assert.ok(swept.removed.includes('dead.json'));
    assert.ok(swept.removed.includes('dead.desk.json'));
    assert.ok(swept.removed.includes('dead.rail.json'));
    assert.ok(swept.removed.includes('ancient.json'));
    assert.equal(JSON.parse(await readFile(join(dir, 'live.json'), 'utf8')).pid, 1);
    assert.equal(JSON.parse(await readFile(join(dir, 'live.desk.json'), 'utf8')).pid, 1);
    assert.equal(JSON.parse(await readFile(join(dir, 'starting.json'), 'utf8')).claude.state, 'thinking');
    assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'leave me');
    const forgot = await forgetSession('live', dir);
    assert.deepEqual(forgot.removed.sort(), ['live.desk.json', 'live.json']);
    await assert.rejects(readFile(join(dir, 'live.json')));
    assert.equal((await forgetSession('../x', dir)).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A real repo: + new's layout, one merged clean worktree, one merged dirty, one merged with a live
// session, and one unmerged. Removal has to go through removeWorktree, which refuses the unsafe ones.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'prune-wt-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'dev@example.com']);
  await git(repo, ['config', 'user.name', 'Dev']);
  await writeFile(join(repo, 'file.txt'), 'm\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);
  const add = async (slug, branch) => {
    const dir = join(root, 'repo.worktrees', slug);
    await git(repo, ['worktree', 'add', '-b', branch, dir]);
    await writeFile(join(dir, `${slug}.txt`), `${slug}\n`);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', slug]);
    return dir;
  };
  const done = await add('done', 'feature-prune-done');
  const dirty = await add('dirty', 'feature-prune-dirty');
  const live = await add('live', 'feature-prune-live');
  const open = await add('open', 'feature-prune-open');
  for (const branch of ['feature-prune-done', 'feature-prune-dirty', 'feature-prune-live']) {
    await git(repo, ['merge', '--no-ff', '-m', `merge ${branch}`, branch]);
  }
  await writeFile(join(dirty, 'notes.txt'), 'still working\n');
  return { root, repo, home, done, dirty, live, open };
}

test('a dirty or unmerged worktree is not removed, and a merged clean one is, once confirmed', async () => {
  const fx = await fixture();
  try {
    const list = await worktrees(fx.repo);
    const plan = planWorktrees(list.items, { livePaths: [fx.live] });
    assert.deepEqual(plan.remove.map((r) => r.branch), ['feature-prune-done']);
    assert.ok(plan.keep.some((r) => r.branch === 'feature-prune-dirty' && r.reason === 'dirty'));
    assert.equal(plan.remove.some((r) => r.branch === 'feature-prune-open'), false);
    assert.equal(plan.keep.some((r) => r.branch === 'feature-prune-open'), false);
    assert.equal(plan.remove.some((r) => r.path === fx.live), false);

    const no = await removeWorktree(fx.repo, fx.done, { confirm: false });
    assert.equal(no.reason, 'confirm');
    assert.match(await git(fx.repo, ['worktree', 'list']), /feature-prune-done/);

    const dirt = await removeWorktree(fx.repo, fx.dirty, { confirm: true });
    assert.equal(dirt.ok, false);
    assert.equal(dirt.reason, 'dirty');
    assert.equal(await readFile(join(fx.dirty, 'notes.txt'), 'utf8'), 'still working\n');

    const unmerged = await removeWorktree(fx.repo, fx.open, { confirm: true });
    assert.equal(unmerged.ok, false);
    assert.equal(unmerged.reason, 'unmerged');

    const current = await removeWorktree(fx.repo, fx.repo, { confirm: true });
    assert.equal(current.ok, false);
    assert.equal(current.reason, 'current');

    const busy = await removeWorktree(fx.repo, fx.live, { confirm: true, livePaths: [fx.live] });
    assert.equal(busy.ok, false);
    assert.equal(busy.reason, 'live');

    const gone = await removeWorktree(fx.repo, fx.done, { confirm: true });
    assert.equal(gone.ok, true, gone.message || gone.reason);
    const after = await git(fx.repo, ['worktree', 'list']);
    assert.doesNotMatch(after, /repo\.worktrees\/done/);
    assert.match(after, /repo\.worktrees\/dirty/);
    assert.match(after, /repo\.worktrees\/live/);
    assert.match(after, /repo\.worktrees\/open/);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');

test('the rail removes a finished worktree on one confirm and sweeps stale activity', async () => {
  const fx = await fixture();
  const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' });
  try {
    const pid = sleeper.pid;
    assert.ok(pid > 1);
    const activity = join(fx.home, '.claude', 'session-rail', 'activity');
    const sessions = join(fx.home, '.claude', 'sessions');
    await mkdir(activity, { recursive: true });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${pid}.json`), JSON.stringify({
      pid, sessionId: 'live-session', cwd: fx.live, status: 'idle', entrypoint: 'cli',
      startedAt: 1, updatedAt: 1, version: '0',
    }));
    await writeFile(join(sessions, '999999.json'), JSON.stringify({
      pid: 999999, sessionId: 'dead-session', cwd: '/nowhere', status: 'idle', entrypoint: 'cli',
      startedAt: 1, updatedAt: 1,
    }));
    await writeFile(join(activity, 'live-session.json'), JSON.stringify({ claude: { state: 'waiting', since: 1 }, pid }));
    await writeFile(join(activity, 'live-session.desk.json'), JSON.stringify({ pid, review: null }));
    await writeFile(join(activity, 'dead-session.json'), JSON.stringify({ claude: { state: 'waiting', since: 1 }, pid: 999999 }));
    await writeFile(join(activity, 'dead-session.desk.json'), JSON.stringify({ pid: 999999 }));
    await writeFile(join(activity, 'dead-session.rail.json'), JSON.stringify({ tab: 'session' }));
    await writeFile(join(activity, 'starting.json'), JSON.stringify({ claude: { state: 'thinking', since: Date.now() } }));
    const env = { ...process.env, HOME: fx.home, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', TERM: 'xterm-256color' };
    delete env.CLAUDE_CONFIG_DIR;
    const frame = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, 'bin/rail.mjs'), '--cwd', fx.repo, '--frame', '72', '36', '--tab', 'git', ...args], { env });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, out: strip(out), err }));
    });
    const before = await frame([]);
    assert.equal(before.code, 0, before.err);
    assert.match(before.out, /feature-prune-done/);
    assert.match(before.out, /remove/);
    await assert.rejects(readFile(join(activity, 'dead-session.json')));
    await assert.rejects(readFile(join(activity, 'dead-session.desk.json')));
    await assert.rejects(readFile(join(activity, 'dead-session.rail.json')));
    assert.equal(JSON.parse(await readFile(join(activity, 'live-session.json'), 'utf8')).pid, pid);
    assert.equal(JSON.parse(await readFile(join(activity, 'live-session.desk.json'), 'utf8')).pid, pid);
    assert.equal(JSON.parse(await readFile(join(activity, 'starting.json'), 'utf8')).claude.state, 'thinking');

    const menu = await frame(['--activate', 'prune']);
    assert.equal(menu.code, 0, menu.err);
    assert.match(menu.out, /Remove feature-prune-done/);
    assert.match(menu.out, /uncommitted · kept/);
    assert.match(await git(fx.repo, ['worktree', 'list']), /repo\.worktrees\/done/);

    const after = await frame(['--activate', 'prune,opt:0']);
    assert.equal(after.code, 0, after.err);
    assert.match(after.out, /Removed feature-prune-done/);
    const listed = await git(fx.repo, ['worktree', 'list']);
    assert.doesNotMatch(listed, /repo\.worktrees\/done/);
    assert.match(listed, /repo\.worktrees\/dirty/);
    assert.match(listed, /repo\.worktrees\/live/);
    assert.match(listed, /repo\.worktrees\/open/);
    assert.equal(await readFile(join(fx.dirty, 'notes.txt'), 'utf8'), 'still working\n');
  } finally {
    sleeper.kill();
    await rm(fx.root, { recursive: true, force: true });
  }
});

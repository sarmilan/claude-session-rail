import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergesPr } from '../bin/cadence.mjs';
import {
  applyRound, budgetCap, choreMustNotRun, choresOn, freshChore, idFor, mayRound, placeChores,
  sessionRow, signalFromChecks, stopForReview, withSummary,
} from '../bin/chore.mjs';
import { listChores, runRound, startChore, stopChore } from '../bin/chore-run.mjs';

const at = (n) => `2026-11-18T12:00:0${n}.000Z`;
const on = { chores: true };

const chore = (cap = 5) => freshChore({
  id: 'ci-feature-login', branch: 'feature/login', repo: 'app', head: 'abc1234fff',
  worktree: '/tmp/app.worktrees/chore-ci-feature-login', cap, at: at(0),
});

test('chores stay off until the setting says so, and the budget is a round cap', () => {
  assert.equal(choresOn(undefined), false);
  assert.equal(choresOn({}), false);
  assert.equal(choresOn({ chores: false }), false);
  assert.equal(choresOn({ chores: true }), true);
  assert.equal(budgetCap(undefined).cap, 5);
  assert.equal(budgetCap('5').cap, 5);
  assert.equal(budgetCap(0).ok, false);
  assert.equal(budgetCap('unlimited').ok, false);
  assert.equal(idFor('feature/login'), 'ci-feature-login');
});

test('three dry runs stay under the budget and leave a summary a person can read', () => {
  let c = chore(5);
  for (const note of ['lint', 'test', 'typecheck']) {
    const step = applyRound(c, { work: true, note, tried: 'dry run' }, { at: at(1), dry: true });
    assert.equal(step.spent, true);
    assert.equal(step.refused, null);
    c = step.chore;
  }
  assert.equal(c.spend, 3);
  assert.ok(c.spend < c.budget.cap);
  assert.equal(c.emptyRounds, 0);
  assert.equal(c.stop, null);
  assert.equal(c.status, 'waiting');
  assert.equal(c.merge, 'human');
  assert.equal(c.autoMerge, false);
  const text = JSON.stringify(withSummary(c), null, 2);
  assert.match(text, /"summary": \[/);
  assert.match(text, /Spend: 3 of 5 rounds/);
  assert.match(text, /Empty rounds in a row: 0/);
  assert.match(text, /does not merge/);
  assert.match(text, /does not approve the brief/);
  assert.match(text, /Round 1 \(dry run\): found work — lint/);
  assert.match(text, /Round 3 \(dry run\): found work — typecheck/);
  assert.ok(text.length < 4000);
});

test('two empty rounds stop the loop and a third round spends nothing', () => {
  let c = chore(5);
  c = applyRound(c, { work: false, note: 'checks green', tried: 'dry run' }, { at: at(1), dry: true }).chore;
  assert.equal(c.emptyRounds, 1);
  assert.equal(c.stop, null);
  assert.equal(c.spend, 1);
  c = applyRound(c, { work: false, note: 'checks green', tried: 'dry run' }, { at: at(2), dry: true }).chore;
  assert.equal(c.stop, 'empty');
  assert.equal(c.status, 'blocked');
  assert.equal(c.spend, 2);
  const third = applyRound(c, { work: true, note: 'lint', tried: 'dry run' }, { at: at(3), dry: true });
  assert.equal(third.spent, false);
  assert.match(third.refused, /two empty rounds/);
  assert.equal(third.chore.spend, 2);
  assert.equal(third.chore.rounds.length, 2);
});

test('a spent budget refuses the next round without spending', () => {
  let c = chore(1);
  const first = applyRound(c, { work: true, note: 'lint', tried: 'dry run' }, { at: at(1), dry: true });
  c = first.chore;
  assert.equal(c.spend, 1);
  assert.equal(c.stop, 'budget');
  assert.equal(c.status, 'blocked');
  const second = applyRound(c, { work: true, note: 'test', tried: 'dry run' }, { at: at(2), dry: true });
  assert.equal(second.spent, false);
  assert.match(second.refused, /budget spent/);
  assert.equal(second.chore.spend, 1);
});

test('a chore never merges, and a merge command is refused before it can spend', () => {
  const c = chore(5);
  c.autoMerge = true;
  const tampered = applyRound(c, { work: true, note: 'lint' }, { at: at(1), dry: true });
  assert.equal(tampered.spent, false);
  assert.match(tampered.refused, /never merges/);
  assert.equal(mayRound({ ...chore(5), merge: 'auto' }).ok, false);
  assert.equal(choreMustNotRun('git status', mergesPr), null);
  assert.match(choreMustNotRun('gh pr merge 12', mergesPr), /never runs gh pr merge/);
  assert.match(choreMustNotRun('cd repo && gh pr merge 12', mergesPr), /never runs gh pr merge/);
  const held = stopForReview(chore(5), at(2));
  assert.equal(held.stop, 'review');
  assert.equal(held.status, 'waiting');
  assert.equal(applyRound(held, { work: true, note: 'lint' }, { at: at(3) }).spent, false);
});

test('the sessions row is busy, waiting, or blocked', () => {
  const running = sessionRow({ ...chore(5), status: 'running', updatedAt: at(1) });
  assert.equal(running.state, 'busy');
  assert.match(running.doing, /re-checking CI/);
  const review = sessionRow(stopForReview(chore(5), at(2)));
  assert.equal(review.state, 'waiting');
  const budget = sessionRow(applyRound(chore(1), { work: true, note: 'lint' }, { at: at(1), dry: true }).chore);
  assert.equal(budget.state, 'blocked');
  assert.match(budget.doing, /budget spent/);
  const empty = sessionRow(applyRound(applyRound(chore(5), { work: false }, { at: at(1), dry: true }).chore, { work: false }, { at: at(2), dry: true }).chore);
  assert.equal(empty.state, 'blocked');
  const placed = placeChores(
    [{ title: 'Mine', state: 'idle', current: true, since: 1 }, { title: 'Other', state: 'idle', current: false, since: 5 }],
    [applyRound(chore(1), { work: true, note: 'lint' }, { at: at(3), dry: true }).chore],
  );
  assert.equal(placed[0].title, 'Mine');
  assert.equal(placed[1].title, 'Re-run failing CI');
  assert.equal(placed[1].state, 'blocked');
  assert.equal(placed[2].title, 'Other');
});

test('checks: failing and still-running are work, green and missing are empty', () => {
  assert.equal(signalFromChecks([]).work, false);
  assert.equal(signalFromChecks([{ name: 'lint', conclusion: 'SUCCESS' }]).work, false);
  assert.equal(signalFromChecks([{ name: 'lint', conclusion: 'FAILURE' }]).note, 'lint');
  assert.equal(signalFromChecks([{ name: 'test', status: 'IN_PROGRESS', conclusion: null }]).note, 'checks still running');
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
};

async function tempRepo() {
  const cwd = await mkdtemp(join(tmpdir(), 'chore-'));
  const git = (args) => execFileSync('git', args, { cwd, env: gitEnv });
  git(['init', '-b', 'feature/login']);
  git(['commit', '--allow-empty', '-m', 'init']);
  return cwd;
}

test('a start gets its own worktree and state file; rounds obey the cap and the setting', async () => {
  const cwd = await tempRepo();
  try {
    const off = await startChore({ cwd, settings: {}, openWindow: false, budget: 5 });
    assert.equal(off.ok, false);
    assert.match(off.message, /Chores are off/);
    assert.equal((await listChores(cwd)).length, 0);

    const started = await startChore({ cwd, settings: on, openWindow: false, budget: 5, at: at(0) });
    assert.equal(started.ok, true);
    assert.equal(started.reused, false);
    assert.match(started.chore.worktree, /chore-ci-feature-login$/);
    assert.equal(started.chore.merge, 'human');
    const again = await startChore({ cwd, settings: on, openWindow: false, budget: 1 });
    assert.equal(again.reused, true);
    assert.equal(again.chore.budget.cap, 5);

    const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' });
    assert.ok(listed.includes(started.chore.worktree));
    const detached = execFileSync('git', ['status', '--porcelain=v1', '-b'], { cwd: started.chore.worktree, encoding: 'utf8' });
    assert.match(detached, /## HEAD \(no branch\)/);

    let sawRunning = false;
    const round = await runRound({
      cwd, settings: on, at: at(1),
      probe: async () => {
        const mid = (await listChores(cwd))[0];
        sawRunning = mid.status === 'running';
        assert.equal(sessionRow(mid).state, 'busy');
        return { work: true, note: 'lint', tried: 'gh pr view' };
      },
    });
    assert.equal(sawRunning, true);
    assert.equal(round.spent, true);
    assert.equal(round.chore.spend, 1);
    assert.equal(round.chore.stop, null);

    const file = await readFile(started.file, 'utf8');
    assert.match(file, /Spend: 1 of 5 rounds/);
    assert.match(file, /found work — lint/);
    assert.match(file, /does not merge/);

    const merge = await runRound({
      cwd, settings: on, at: at(2),
      probe: async () => ({ work: true, note: 'lint', tried: 'gh pr view', command: 'gh pr merge 1' }),
    });
    assert.equal(merge.spent, false);
    assert.match(merge.refused, /gh pr merge/);
    assert.equal((await listChores(cwd))[0].spend, 1);

    const stopped = await stopChore({ cwd, at: at(3) });
    assert.equal(stopped.chore.stop, 'review');
    assert.equal(stopped.chore.spend, 1);
    assert.equal(sessionRow(stopped.chore).state, 'waiting');
    const after = await runRound({ cwd, settings: on, dry: true, failing: 'test', at: at(4) });
    assert.equal(after.spent, false);
    assert.equal(after.chore.spend, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(`${cwd}.worktrees`, { recursive: true, force: true });
  }
});

test('the documented three dry runs stay under the budget', async () => {
  const cwd = await tempRepo();
  const home = await mkdtemp(join(tmpdir(), 'chore-settings-'));
  const settings = join(home, 'settings.json');
  await writeFile(settings, JSON.stringify({ chores: true }));
  const bin = new URL('../bin/chore-run.mjs', import.meta.url).pathname;
  const env = { ...gitEnv, SESSION_RAIL_SETTINGS: settings };
  const cli = (args) => execFileSync(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8' });
  try {
    cli(['start', '--cwd', cwd, '--budget', '5', '--no-window']);
    for (const note of ['lint', 'test', 'typecheck']) cli(['round', '--cwd', cwd, '--dry-run', '--failing', note]);
    const shown = cli(['show', '--cwd', cwd]);
    assert.match(shown, /Spend: 3 of 5 rounds/);
    assert.match(shown, /Empty rounds in a row: 0/);
    assert.match(shown, /does not merge/);
    assert.match(shown, /Round 3 \(dry run\): found work — typecheck/);
    const blocked = cli(['round', '--cwd', cwd, '--dry-run', '--green']);
    assert.match(blocked, /Spend: 4 of 5 rounds/);
    const second = cli(['round', '--cwd', cwd, '--dry-run', '--green']);
    assert.match(second, /two empty rounds/);
    assert.match(second, /Spend: 5 of 5 rounds|Spend: 4 of 5 rounds/);
    // The second green spends (it is the second empty). A further round must not.
    const third = cli(['round', '--cwd', cwd, '--dry-run', '--failing', 'lint']);
    assert.match(third, /without further spend/);
    const file = cli(['show', '--cwd', cwd]);
    const spend = file.match(/Spend: (\d+) of 5/)[1];
    assert.ok(Number(spend) <= 5);
    assert.match(file, /nothing further will be spent|without further spend|Stopped: two empty rounds/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(`${cwd}.worktrees`, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('the rail shows the chore when chores are on and hides it when they are off', async () => {
  const cwd = await tempRepo();
  const bin = new URL('../bin/chore-run.mjs', import.meta.url).pathname;
  const rail = new URL('../bin/rail.mjs', import.meta.url).pathname;
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  try {
    await startChore({ cwd, settings: on, openWindow: false, budget: 1, at: at(0) });
    await runRound({ cwd, settings: on, dry: true, failing: 'lint', at: at(1) });
    const onFrame = plain(execFileSync(process.execPath, [rail, '--frame', '72', '20', '--cwd', cwd, '--chores', 'on'], { encoding: 'utf8' }));
    assert.match(onFrame, /Re-run failing CI/);
    assert.match(onFrame, /blocked/);
    assert.match(onFrame, /budget spent/);
    const offFrame = plain(execFileSync(process.execPath, [rail, '--frame', '42', '16', '--cwd', cwd, '--chores', 'off'], { encoding: 'utf8' }));
    assert.doesNotMatch(offFrame, /Re-run failing CI/);
    const settings = plain(execFileSync(process.execPath, [rail, '--frame', '42', '28', '--cwd', cwd, '--open-settings', '--chores', 'on'], { encoding: 'utf8' }));
    assert.match(settings, /↻ Chores/);
    assert.match(settings, /‹ on ›/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(`${cwd}.worktrees`, { recursive: true, force: true });
  }
});

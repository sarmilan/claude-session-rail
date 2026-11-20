import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gateReason, openFindings, runType } from '../bin/cadence.mjs';
import { visitorsFor } from '../bin/mascot.mjs';
import { reviewText } from '../bin/reviewer.mjs';
import { buildStory, layoutStory } from '../bin/sessionstory.mjs';
import { wideReviewAndSave } from '../bin/widereview.mjs';
import {
  diffSize, findingsFromPayload, filePrompt, isWide, killedFromPayload, mergeReviewerAgents, offerWide,
  settleWide, skepticPrompt, sliceFiles, sliceLabel, thresholdReason, wideEnabled, wideModel, WIDE_FILES, WIDE_LINES,
} from '../bin/wide.mjs';

const plugin = new URL('..', import.meta.url).pathname;
const strip = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b./g, '');
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
};
const BRIEF = `# Wide

## Problem
Login drops the token.

## Solution
As a user, I should stay signed in so I can come back.

## Engineering
### Chunk 1: Token
Keep the token after login.
`;
const ready = { text: BRIEF, status: 'ready', sections: { problem: 'Login drops the token.', solution: 'Stay signed in.' } };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
}

async function makeRepo({ files = 8, lines = 12, brief = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wide-'));
  git(dir, ['init', '-b', 'main']);
  await writeFile(join(dir, 'README.md'), 'base\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'base']);
  git(dir, ['checkout', '-b', 'feature/wide']);
  for (let i = 0; i < files; i++) {
    const name = i === 0 ? 'auth.js' : i === 1 ? 'style.js' : `file${i}.js`;
    await writeFile(join(dir, name), Array.from({ length: lines }, (_, n) => `export const n${i}_${n} = ${n};\n`).join(''));
  }
  if (files) {
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'wide']);
  }
  if (brief) {
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const path = join(common, 'session-rail', 'briefs', `${encodeURIComponent('feature/wide')}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, BRIEF);
  }
  return dir;
}

function childEnv(home) {
  const env = { ...process.env, HOME: home, GH_CONFIG_DIR: join(home, 'gh') };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function desk(repo, home, args = []) {
  return strip(execFileSync(process.execPath, [join(plugin, 'bin/desk.mjs'), '--frame', '96', '40', '--tab', 'review', '--cwd', repo, ...args], {
    env: childEnv(home), encoding: 'utf8', timeout: 40_000,
  }));
}

async function homeWith(settings) {
  const home = await mkdtemp(join(tmpdir(), 'wide-home-'));
  await mkdir(join(home, '.claude', 'session-rail'), { recursive: true });
  if (settings) await writeFile(join(home, '.claude', 'session-rail', 'settings.json'), JSON.stringify(settings));
  return home;
}

const filesOf = (n, lines = 10) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.js`, added: lines, removed: 0 }));

test('wide review is off unless the setting is exactly true, and a diff is wide at 8 files or 400 lines', () => {
  assert.equal(wideEnabled(undefined), false);
  assert.equal(wideEnabled({}), false);
  assert.equal(wideEnabled({ wideReview: false }), false);
  assert.equal(wideEnabled({ wideReview: true }), true);
  assert.equal(wideModel({}), null);
  assert.equal(wideModel({ wideModel: 'claude-haiku' }), 'claude-haiku');
  assert.equal(wideModel({ wideModel: 'not a model' }), null);
  assert.equal(isWide(filesOf(7, 10)), false);
  assert.equal(isWide(filesOf(WIDE_FILES, 1)), true);
  assert.equal(isWide([{ path: 'a.js', added: WIDE_LINES - 1, removed: 0 }, { path: 'b.js', added: 0, removed: 0 }]), false);
  assert.equal(isWide([{ path: 'a.js', added: 200, removed: 200 }]), true);
  assert.deepEqual(diffSize([{ path: 'a.js', added: 2, removed: 3 }]), { files: 1, lines: 5 });
  assert.equal(offerWide({ wideReview: true }, filesOf(8), ready), true);
  assert.equal(offerWide({ wideReview: true }, filesOf(8), { text: 'x', status: 'draft' }), false);
  assert.equal(offerWide({ wideReview: false }, filesOf(8), ready), false);
  assert.equal(offerWide({ wideReview: true }, filesOf(2), ready), false);
  assert.match(thresholdReason(filesOf(2)), /2 files/);
});

test('slices cover every file once, and never more than four reviewers', () => {
  const eight = filesOf(8, 10);
  eight[3].added = 500;
  const slices = sliceFiles(eight);
  assert.equal(slices.length, 4);
  const paths = slices.flatMap((s) => s.files.map((f) => f.path));
  assert.deepEqual([...paths].sort(), eight.map((f) => f.path).sort());
  assert.equal(new Set(paths).size, 8);
  assert.equal(sliceFiles(filesOf(3)).length, 3);
  assert.equal(sliceFiles([]).length, 0);
  assert.equal(sliceLabel([{ path: 'src/auth.js' }]), 'auth.js');
  assert.equal(sliceLabel([{ path: 'src/auth.js' }, { path: 'src/b.js' }]), 'auth.js +1');
  const heavy = slices.find((s) => s.files.some((f) => f.path === 'f3.js'));
  assert.equal(heavy.files.length, 1);
});

test('the file prompt stays on its slice, and the skeptic is asked to kill weak findings', () => {
  const prompt = filePrompt({ files: [{ path: 'auth.js' }], diff: '+ token', goal: 'Stay signed in' });
  assert.match(prompt, /auth\.js/);
  assert.match(prompt, /Do not report style/);
  assert.doesNotMatch(prompt, /style\.js/);
  const skeptic = skepticPrompt({ findings: [{ file: 'style.js', line: 2, title: 'Rename the loop index for clarity', detail: 'named x' }], goal: 'Stay signed in' });
  assert.match(skeptic, /Kill/);
  assert.match(skeptic, /^0\. style\.js:2 Rename/m);
});

test('the skeptic declines what it kills and leaves the rest open in one run', () => {
  const raw = findingsFromPayload({
    findings: [
      { title: 'Rename x', severity: 'low', detail: 'style', file: 'style.js', line: 2 },
      { title: '  The session token is ignored\n', severity: 'high', detail: 'drops it', file: 'auth.js', line: 4 },
      { title: '   ', severity: 'high' },
    ],
  });
  assert.equal(raw.length, 2);
  assert.equal(raw[0].title, 'The session token is ignored');
  const killed = killedFromPayload({ summary: 'Kept the bug.', killed: [{ index: 1, note: 'Style only.' }, { index: 9, note: 'no' }, { index: 1, note: 'again' }] });
  const run = settleWide(raw, killed.killed, { at: 36, head: 'abc', dirty: false, summary: killed.summary });
  assert.equal(run.type, 'wide');
  assert.equal(run.manual, true);
  assert.equal(runType(run), 'wide');
  assert.deepEqual(run.findings.map((f) => f.status), ['open', 'declined']);
  assert.equal(run.findings[1].note, 'Style only.');
  assert.equal(run.findings[0].id, `w${(36).toString(36)}-0`);
  assert.match(run.summary, /Kept the bug/);
  assert.equal(killedFromPayload({ findings: [] }), null);
  assert.deepEqual(findingsFromPayload({ summary: 'no' }, ['only.js']), null);
});

test('a wide run does not change the cadence unless it left something open', () => {
  const chunk = { type: 'approach', startedAt: 10, finishedAt: 10, head: 'h1', dirty: false, verdict: 'on-track', findings: [] };
  const code = { type: 'code', startedAt: 20, finishedAt: 20, head: 'h2', dirty: false, verdict: 'clean', findings: [] };
  const final = { type: 'approach', final: true, startedAt: 40, finishedAt: 40, head: 'h2', dirty: false, verdict: 'on-track', findings: [] };
  const clean = settleWide([], [], { at: 30, head: 'h2', dirty: false });
  assert.equal(gateReason([final, clean, code, chunk], { head: 'h2' }), null);
  const open = settleWide([{ title: 'The session token is ignored', file: 'auth.js', line: 4 }], [], { at: 30, head: 'h2', dirty: false });
  const reason = gateReason([final, open, code, chunk], { head: 'h2' });
  assert.match(reason, /wide review has 1 open finding/);
  assert.match(reason, /session token is ignored/);
  const declined = settleWide(
    [{ title: 'Rename the loop index for clarity' }],
    [{ index: 0, note: 'Style only.' }],
    { at: 30, head: 'h2', dirty: false },
  );
  assert.equal(gateReason([final, declined, code, chunk], { head: 'h2' }), null);
  // A wide run is not a code review and not a chunk review, so the merge still waits for both.
  assert.match(gateReason([open, chunk], { head: 'h2' }), /\/code-review hasn't run/);
  const older = settleWide([{ title: 'old bug' }], [], { at: 5, head: 'h0', dirty: false });
  assert.deepEqual(openFindings([declined, older]).wide, []);
  assert.equal(openFindings([open, older]).wide[0].title, 'The session token is ignored');
  const told = reviewText({ verdict: 'on-track', summary: 'ok', checks: [], findings: [], runs: [open, chunk] });
  assert.match(told, new RegExp(open.findings[0].id));
  const quiet = reviewText({ verdict: 'on-track', summary: 'ok', checks: [], findings: [], runs: [final, code, chunk] });
  assert.doesNotMatch(quiet, /wide review/i);
  assert.match(quiet, /Nothing open/);
});

test('named reviewers join the rail as subagents, and a visitor follows each one still running', () => {
  const reviewers = [
    { id: 'wide-0', name: 'Wren', colour: 80, what: 'auth.js', since: 1_000, prompt: 'Review auth.js for concrete bugs.' },
    { id: 'wide-1', name: 'Otto', colour: 141, what: 'skeptic', since: 2_000, endedAt: 3_000, reply: 'Kept the bug.' },
  ];
  const kept = mergeReviewerAgents({ 'wide-0': { name: 'Real', what: 'already here' } }, reviewers);
  assert.equal(kept['wide-0'].name, 'Real');
  const agents = mergeReviewerAgents({}, reviewers);
  assert.equal(agents['wide-0'].name, 'Wren');
  assert.equal(agents['wide-1'].endedAt, 3_000);
  assert.equal(visitorsFor({ agents }).length, 1);
  const story = buildStory({
    host: 'Claude', now: 10_000, claude: { state: 'waiting', since: 1 },
    agents, desk: { kind: 'wide review' },
  });
  assert.deepEqual(story.cast.map((a) => a.name), ['Wren']);
  assert.deepEqual(story.history.map((a) => a.name), ['Otto']);
  const view = layoutStory(story, { inner: 64 });
  const banner = (view.banner ?? []).map((p) => p.text).join('');
  const rows = view.rows.map((row) => (row.left ?? []).map((p) => p.text).join('')).join('\n');
  assert.match(banner, /Wren · auth\.js/);
  assert.match(rows, /Otto/);
  assert.match(rows, /skeptic/);
  assert.match(rows, /wide review/);
});

test('file reviewers run in worktrees, and a cancelled review writes nothing', async () => {
  const dir = await makeRepo();
  try {
    const seen = [];
    const ac = new AbortController();
    ac.abort();
    const cancelled = await wideReviewAndSave(dir, {
      settings: { wideReview: true }, brief: ready, signal: ac.signal,
      runSlice: () => { seen.push('slice'); return []; },
    });
    assert.equal(cancelled.error, 'Review cancelled');
    assert.deepEqual(seen, []);
    const off = await wideReviewAndSave(dir, {
      settings: {}, brief: ready,
      runSlice: () => { seen.push('off'); return []; },
    });
    assert.match(off.error, /off/);
    const small = await wideReviewAndSave(dir, {
      settings: { wideReview: true }, brief: ready, files: filesOf(2, 10),
      runSlice: () => { seen.push('small'); return []; },
    });
    assert.match(small.error, /threshold/);
    assert.deepEqual(seen, []);
    await wideReviewAndSave(dir, {
      settings: { wideReview: true }, brief: ready,
      runSlice: ({ cwd }) => {
        seen.push(cwd);
        assert.match(git(cwd, ['rev-parse', '--git-dir']), /worktrees/);
        assert.notEqual(cwd, dir);
        return [];
      },
      runSkeptic: () => ({ summary: 'No findings', killed: [] }),
    });
    assert.equal(seen.length, 4);
    const left = git(dir, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));
    assert.equal(left.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a wide diff produces one report the skeptic did not kill, and a small diff does not offer it', async () => {
  const wide = await makeRepo();
  const small = await makeRepo({ files: 1, lines: 8 });
  const bare = await makeRepo({ brief: false });
  const homeOff = await homeWith(null);
  const homeOn = await homeWith({ wideReview: true });
  try {
    const off = desk(wide, homeOff);
    assert.match(off, /Run review/);
    assert.doesNotMatch(off, /Wide review/);
    const on = desk(wide, homeOn);
    assert.match(on, /Run review/);
    assert.match(on, /Wide review/);
    assert.match(on, /skeptic keeps one/);
    assert.doesNotMatch(desk(small, homeOn), /Wide review/);
    assert.doesNotMatch(desk(bare, homeOn), /Wide review/);

    const names = [];
    let skepticTrees = 0;
    const saved = await wideReviewAndSave(wide, {
      settings: { wideReview: true },
      command: [process.execPath, join(plugin, 'scripts/wide-fixture-model.mjs')],
      env: { ...process.env, WIDE_FIXTURE_MS: '0' },
      onProgress: (list) => {
        names.push(...list.map((r) => r.name));
        if (list.some((r) => r.role === 'skeptic' && r.endedAt)) {
          skepticTrees = git(wide, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
        }
      },
    });
    assert.equal(saved.error, undefined);
    // Four file worktrees, the skeptic's worktree, and this checkout. The skeptic does not run here.
    assert.equal(skepticTrees, 6);
    assert.equal(saved.type, 'wide');
    assert.equal(saved.findings.filter((f) => f.status === 'open').map((f) => f.title).join(''), 'The session token is ignored');
    const dropped = saved.findings.find((f) => f.status === 'declined');
    assert.match(dropped.title, /Rename the loop index/);
    assert.match(dropped.note, /Style only/);
    assert.ok(names.length >= 2);
    const shown = desk(wide, homeOn);
    assert.match(shown, /The session token is ignored/);
    assert.match(shown, /● open/);
    assert.match(shown, /✗ declined/);
    assert.match(shown, /Style only/);
    const left = git(wide, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));
    assert.equal(left.length, 1);
    const record = JSON.parse(await readFile(join(git(wide, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'session-rail', 'reviews', `${encodeURIComponent('feature/wide')}.json`), 'utf8'));
    assert.equal(record.runs.filter((r) => r.type === 'wide').length, 1);
  } finally {
    await Promise.all([wide, small, bare, homeOff, homeOn].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test('the rail setting shows wide review off until it is turned on', async () => {
  const home = await homeWith({ autoCompact: true });
  try {
    const frame = () => strip(execFileSync(process.execPath, [join(plugin, 'bin/rail.mjs'), '--frame', '48', '36', '--open-settings', '--cwd', plugin], {
      env: childEnv(home), encoding: 'utf8', timeout: 40_000,
    }));
    assert.match(frame(), /Wide review +‹ off ›/);
    const on = await homeWith({ wideReview: true });
    const turned = strip(execFileSync(process.execPath, [join(plugin, 'bin/rail.mjs'), '--frame', '48', '36', '--open-settings', '--cwd', plugin], {
      env: childEnv(on), encoding: 'utf8', timeout: 40_000,
    }));
    assert.match(turned, /Wide review +‹ on ›/);
    await rm(on, { recursive: true, force: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { publishReview, requireReview } from '../bin/publish.mjs';
import {
  COMMENT_MARKER, STATUS_CONTEXT, commentBody, commitSha, mergeWarning, openTitles, repoSlug, requireVerdict,
  reviewStatus, statusRequest,
} from '../bin/reviewstatus.mjs';

const exec = promisify(execFile);
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const chunk = { type: 'approach', startedAt: 5, finishedAt: 6, head: 'older', dirty: true, verdict: 'on-track', summary: 'chunk', findings: [] };
const code = { type: 'code', startedAt: 10, finishedAt: 10, head: SHA, dirty: true, verdict: 'clean', summary: 'No findings', findings: [] };
const final = { type: 'approach', startedAt: 20, finishedAt: 21, head: SHA, dirty: false, final: true, verdict: 'on-track', summary: 'The prose says success', findings: [] };
const cleanRuns = [final, code, chunk];
const openRun = {
  ...final, verdict: 'simpler-path', summary: 'success — all clear',
  findings: [{ id: 'a-0', kind: 'simpler', title: 'drop the extra layer', detail: '', severity: 'medium', status: 'open' }],
};

test('a clean cadence is success, and prose that says success is not', () => {
  const ok = reviewStatus(cleanRuns, { head: SHA });
  assert.equal(ok.state, 'success');
  assert.equal(ok.clean, true);
  assert.equal(ok.context, STATUS_CONTEXT);
  assert.match(ok.description, /^Reviewed\./);
  assert.equal(ok.description.length <= 140, true);

  const open = reviewStatus([openRun, code, chunk], { head: SHA });
  assert.equal(open.state, 'failure');
  assert.equal(open.clean, false);
  assert.match(open.description, /Open findings: 1 approach, 0 code/);
  assert.equal(open.description.includes('Reviewed'), false);
  assert.equal(open.description.includes('all clear'), false);

  const unfinished = reviewStatus([chunk], { head: SHA });
  assert.equal(unfinished.state, 'failure');
  assert.match(unfinished.description, /code-review/);
  assert.equal(reviewStatus([], { head: '' }).state, 'failure');
  assert.equal(reviewStatus(cleanRuns, { head: OTHER }).state, 'failure');
});

test('a huge finding title cannot make a passing description or a long one', () => {
  const title = `${'x'.repeat(500)}\x1b[31m`;
  const run = { ...openRun, findings: [{ ...openRun.findings[0], title }] };
  const status = reviewStatus([run], { head: SHA });
  assert.equal(status.state, 'failure');
  assert.equal(status.description.length <= 140, true);
  assert.equal(status.description.includes('\x1b'), false);
});

test('the status body is failure unless the record itself is clean', () => {
  const forged = statusRequest({ state: 'success', clean: false, description: 'Reviewed. The code review and the final approach review are clean.' });
  assert.equal(forged.state, 'failure');
  assert.equal(forged.context, STATUS_CONTEXT);
  assert.equal(forged.description.startsWith('Reviewed.'), false);
  const real = statusRequest(reviewStatus(cleanRuns, { head: SHA }), { targetUrl: 'https://github.com/demo/app/pull/7' });
  assert.equal(real.state, 'success');
  assert.equal(real.target_url, 'https://github.com/demo/app/pull/7');
  assert.equal(statusRequest(real, { targetUrl: 'http://evil.example/x' }).target_url, undefined);
  assert.equal(real.description.length <= 140, true);
});

test('the comment names the open finding and does not claim a pass', () => {
  const status = reviewStatus([openRun], { head: SHA });
  const body = commentBody(status, { findings: openTitles([openRun]) });
  assert.match(body, new RegExp(`^${COMMENT_MARKER}`));
  assert.match(body, /\*\*failure\*\*/);
  assert.match(body, /drop the extra layer/);
  assert.match(body, /not a required check/);
  assert.match(body, /does not invent a passing review/);
  assert.equal(body.includes('\x1b'), false);
  const titled = { ...openRun, findings: [{ ...openRun.findings[0], title: `keep\x1b[2J${COMMENT_MARKER} it` }] };
  const escaped = commentBody(reviewStatus([titled], { head: SHA }), { findings: openTitles([titled]) });
  assert.equal(escaped.includes('\x1b'), false);
  assert.equal(escaped.split(COMMENT_MARKER).length, 2);
});

test('the desk warns when a merge would land, or already did, without a clean record', () => {
  const open = [openRun];
  assert.equal(mergeWarning(open, { head: SHA, pr: null }), null);
  assert.equal(mergeWarning(cleanRuns, { head: SHA, pr: { state: 'MERGED', head: SHA } }), null);
  assert.match(mergeWarning(open, { head: SHA, pr: { state: 'MERGED', head: SHA } }).text, /merged/);
  assert.equal(mergeWarning(open, { head: SHA, pr: { state: 'MERGED', head: SHA } }).tone, 'bad');
  const soon = mergeWarning(open, { head: SHA, pr: { state: 'OPEN', mergeable: true, draft: false, mergeStateStatus: 'CLEAN', head: SHA } });
  assert.match(soon.text, /will let a person merge/);
  assert.equal(soon.tone, 'warn');
  assert.equal(mergeWarning(open, { head: SHA, pr: { state: 'OPEN', mergeable: false, mergeStateStatus: 'BLOCKED', head: SHA } }), null);
  assert.equal(mergeWarning(open, { head: SHA, pr: { state: 'OPEN', mergeable: true, draft: true, head: SHA } }), null);
  assert.equal(mergeWarning(open, { head: SHA, pr: { state: 'OPEN', mergeStateStatus: 'DIRTY', head: SHA } }), null);
  // The pull request's commit is the one a merge would use, not an older local head.
  assert.match(mergeWarning(cleanRuns, { head: SHA, pr: { state: 'OPEN', mergeable: true, head: OTHER } }).text, /not clean/);
  assert.equal(mergeWarning(cleanRuns, { head: OTHER, pr: { state: 'OPEN', mergeable: true, head: SHA } }), null);
});

test('a slug and a commit id are the only targets, and a missing status is not success', () => {
  assert.equal(repoSlug('demo/app'), 'demo/app');
  assert.equal(repoSlug('"demo/app"'), 'demo/app');
  assert.equal(repoSlug('demo/app/extra'), null);
  assert.equal(repoSlug('demo/../app'), null);
  assert.equal(commitSha(SHA), SHA);
  assert.equal(commitSha('abc'), null);
  assert.deepEqual(requireVerdict([]), { ok: false, state: 'missing' });
  assert.deepEqual(requireVerdict([{ context: STATUS_CONTEXT, state: 'failure' }]), { ok: false, state: 'failure' });
  assert.deepEqual(requireVerdict([{ context: 'ci', state: 'success' }]), { ok: false, state: 'missing' });
  assert.deepEqual(requireVerdict([
    { context: STATUS_CONTEXT, state: 'failure' },
    { context: STATUS_CONTEXT, state: 'success' },
  ]), { ok: false, state: 'failure' });
  assert.deepEqual(requireVerdict([{ context: STATUS_CONTEXT, state: 'success' }]), { ok: true, state: 'success' });
  assert.deepEqual(requireVerdict({ statuses: 'nope' }), { ok: false, state: 'missing' });
});

test('publishing posts the record and will not post when it is turned off or the head is not a commit', async () => {
  const calls = [];
  const gh = async (args, opts = {}) => {
    calls.push({ args, input: opts.input });
    const line = args.join(' ');
    if (line.includes('nameWithOwner')) return { ok: true, out: 'demo/app\n' };
    if (line.includes('pr') && line.includes('view')) return { ok: true, out: JSON.stringify({ number: 7, url: 'https://github.com/demo/app/pull/7', state: 'OPEN' }) };
    if (line.includes('comments') && line.includes('select')) return { ok: true, out: '' };
    return { ok: true, out: '{}\n' };
  };
  const off = await publishReview({ runs: cleanRuns, head: SHA, cwd: '/repo', gh, env: { SESSION_RAIL_PUBLISH: '0' } });
  assert.equal(off.published, false);
  assert.equal(calls.length, 0);
  const bad = await publishReview({ runs: cleanRuns, head: 'h2', cwd: '/repo', gh, env: {} });
  assert.equal(bad.published, false);
  assert.equal(bad.reason, 'no commit');
  const posted = await publishReview({ runs: [openRun], head: SHA, cwd: '/repo', gh, env: {} });
  assert.equal(posted.published, true);
  assert.equal(posted.comment, true);
  const statusCall = calls.find((c) => c.args.some((a) => String(a).includes('/statuses/')));
  assert.equal(JSON.parse(statusCall.input).state, 'failure');
  assert.equal(JSON.parse(statusCall.input).context, STATUS_CONTEXT);
  calls.length = 0;
  const gh2 = async (args, opts = {}) => {
    calls.push({ args, input: opts.input });
    const line = args.join(' ');
    if (line.includes('nameWithOwner')) return { ok: true, out: 'demo/app\n' };
    if (line.includes('pr') && line.includes('view')) return { ok: true, out: JSON.stringify({ number: 7, url: 'https://github.com/demo/app/pull/7' }) };
    if (line.includes('select')) return { ok: true, out: '101\n' };
    return { ok: true, out: '{}\n' };
  };
  await publishReview({ runs: cleanRuns, head: SHA, cwd: '/repo', gh: gh2, env: {} });
  const update = calls.find((c) => c.args.includes('PATCH'));
  assert.ok(update);
  assert.match(update.args.join(' '), /comments\/101$/);
  assert.equal(JSON.parse(calls.find((c) => c.args.some((a) => String(a).includes('/statuses/'))).input).state, 'success');
});

test('require reads the status and does not post one', async () => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(' '));
    if (args.includes('--json')) return { ok: true, out: 'demo/app\n' };
    return { ok: true, out: JSON.stringify([{ context: STATUS_CONTEXT, state: 'failure' }]) };
  };
  const missing = await requireReview({ cwd: '/repo', gh, sha: SHA, repo: 'demo/app' });
  assert.deepEqual(missing, { ok: false, state: 'failure' });
  assert.equal(calls.some((c) => c.includes('POST')), false);
  const none = await requireReview({ cwd: '/repo', gh: async () => ({ ok: false, out: '' }), sha: 'nope', repo: 'demo/app' });
  assert.deepEqual(none, { ok: false, state: 'missing' });
});

test('the optional workflow is not installed, and it fails closed', async () => {
  await assert.rejects(readFile('.github/workflows/session-rail-review.yml', 'utf8'));
  const yml = await readFile('docs/session-rail-review.yml', 'utf8');
  assert.match(yml, /session-rail\/review/);
  assert.match(yml, /exit 1/);
  assert.match(yml, /does not create a passing status/);
  assert.equal(yml.includes('--method POST'), false);
  assert.equal(yml.includes('state=success'), false);
});

test('the desk says a merged pull request has no clean review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-desk-'));
  const review = join(dir, 'review.json');
  const pr = join(dir, 'pr.json');
  await writeFile(review, JSON.stringify({ runs: [openRun] }));
  await writeFile(pr, JSON.stringify({ state: 'MERGED', mergeable: false, draft: false, head: SHA }));
  const { stdout } = await exec(process.execPath, [
    'bin/desk.mjs', '--frame', '80', '28', '--tab', 'review', '--cwd', process.cwd(),
    '--review-json', review, '--pr-json', pr, '--head', SHA,
  ], { cwd: process.cwd() });
  assert.match(stdout, /merged/);
  assert.match(stdout, /not clean/);
  await writeFile(pr, JSON.stringify({ state: 'OPEN', mergeable: true, draft: false, mergeStateStatus: 'CLEAN', head: SHA }));
  const open = await exec(process.execPath, [
    'bin/desk.mjs', '--frame', '90', '28', '--tab', 'review', '--cwd', process.cwd(),
    '--review-json', review, '--pr-json', pr, '--head', SHA,
  ], { cwd: process.cwd() });
  assert.match(open.stdout, /will let a person merge/);
  await writeFile(review, JSON.stringify({ runs: cleanRuns }));
  const clean = await exec(process.execPath, [
    'bin/desk.mjs', '--frame', '80', '24', '--tab', 'review', '--cwd', process.cwd(),
    '--review-json', review, '--pr-json', pr, '--head', SHA,
  ], { cwd: process.cwd() });
  assert.equal(clean.stdout.includes('not clean'), false);
  await rm(dir, { recursive: true, force: true });
});

test('the CLI posts a failure, then a success, on a mock repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-cli-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const log = join(dir, 'gh.log');
  const state = join(dir, 'gh-state.json');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2).join(' ');
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(process.env.GH_LOG, JSON.stringify({ args, stdin }) + '\\n');
const read = () => { try { return JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8')); } catch { return {}; } };
const save = (v) => fs.writeFileSync(process.env.GH_STATE, JSON.stringify(v));
if (args.includes('nameWithOwner')) { process.stdout.write('demo/app\\n'); process.exit(0); }
if (args.includes('pr') && args.includes('view')) {
  process.stdout.write(JSON.stringify({ number: 7, url: 'https://github.com/demo/app/pull/7', state: 'OPEN', headRefOid: process.env.DEMO_SHA }) + '\\n');
  process.exit(0);
}
if (args.includes('/statuses') && args.includes('POST')) {
  const cur = read(); cur.status = JSON.parse(stdin); save(cur);
  process.stdout.write('{"id":1}\\n'); process.exit(0);
}
if (args.includes('/statuses')) {
  const cur = read();
  process.stdout.write(JSON.stringify(cur.status ? [cur.status] : []) + '\\n');
  process.exit(0);
}
if (args.includes('/comments') && args.includes('select')) {
  const cur = read(); if (cur.commentId) process.stdout.write(String(cur.commentId) + '\\n');
  process.exit(0);
}
if (args.includes('PATCH') && args.includes('/comments/')) {
  const cur = read(); cur.comment = JSON.parse(stdin).body; save(cur);
  process.stdout.write('{"id":' + cur.commentId + '}\\n'); process.exit(0);
}
if (args.includes('POST') && args.includes('/comments')) {
  const cur = read(); cur.commentId = 101; cur.comment = JSON.parse(stdin).body; save(cur);
  process.stdout.write('{"id":101}\\n'); process.exit(0);
}
process.stderr.write('unexpected gh: ' + args + '\\n');
process.exit(1);
`);
  await exec('chmod', ['+x', join(bin, 'gh')]);
  await exec('git', ['init', '-b', 'main'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'demo\n');
  await exec('git', ['add', 'README.md'], { cwd: dir });
  await exec('git', ['commit', '-m', 'init'], { cwd: dir });
  await exec('git', ['checkout', '-b', 'feature/x'], { cwd: dir });
  const sha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  const runsPath = join(dir, '.git', 'session-rail', 'reviews');
  await mkdir(runsPath, { recursive: true });
  const record = join(runsPath, 'feature%2Fx.json');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, GH_STATE: state, DEMO_SHA: sha };
  const runPublish = async (extra = []) => {
    const out = await exec(process.execPath, [join(process.cwd(), 'bin', 'publish.mjs'), '--cwd', dir, ...extra], { cwd: dir, env });
    return out;
  };
  await writeFile(record, JSON.stringify({ runs: [{ ...openRun, head: sha }] }));
  const failed = JSON.parse((await runPublish()).stdout);
  assert.equal(failed.published, true);
  assert.equal(failed.state, 'failure');
  assert.equal(failed.comment, true);
  assert.match(failed.description, /Open findings/);
  const posted = JSON.parse((await readFile(state, 'utf8')));
  assert.equal(posted.status.state, 'failure');
  assert.equal(posted.status.context, STATUS_CONTEXT);
  assert.match(posted.comment, /drop the extra layer/);
  await assert.rejects(runPublish(['--require']));
  await writeFile(record, JSON.stringify({
    runs: [
      { ...final, head: sha },
      { ...code, head: sha },
      chunk,
    ],
  }));
  const passed = JSON.parse((await runPublish()).stdout);
  assert.equal(passed.state, 'success');
  assert.match(passed.description, /^Reviewed\./);
  const updated = JSON.parse(await readFile(state, 'utf8'));
  assert.equal(updated.status.state, 'success');
  assert.equal(updated.commentId, 101);
  assert.match(updated.comment, /\*\*success\*\*/);
  const required = await runPublish(['--require']);
  assert.match(required.stderr, /session-rail\/review: success/);
  await rm(dir, { recursive: true, force: true });
});

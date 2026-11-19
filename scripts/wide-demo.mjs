// A terminal demo of optional wide review. The desk, the rail, the worktrees and the skeptic
// merge are the real ones. The headless model is scripts/wide-fixture-model.mjs, because this
// machine has no Claude or Grok login. Record with asciinema; agg turns the cast into a gif.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { wideReviewAndSave } from '../bin/widereview.mjs';

const plugin = new URL('..', import.meta.url).pathname;
const hold = Number(process.env.DEMO_HOLD || 2800);
const modelMs = Number(process.env.WIDE_FIXTURE_MS || 7000);
const pid = process.pid;
const sessionId = 'wide-demo';
const home = join(tmpdir(), `wide-demo-home-${pid}`);
const repo = join(tmpdir(), `wide-demo-repo-${pid}`);
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com',
};

const BRIEF = `# Keep the session token

## Problem
Login checks the password and then drops the token, so the next request is signed out.

## Solution
As a user, I should stay signed in so I can come back without typing the password again.

## Engineering
### Chunk 1: Token
Keep the token after a successful login.
`;

function git(args) {
  execFileSync('git', args, { cwd: repo, env: gitEnv, stdio: 'ignore' });
}

function setupRepo() {
  mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'base']);
  git(['checkout', '-b', 'feature/wide-login']);
  const files = ['auth.js', 'style.js', 'session.js', 'login.js', 'token.js', 'cookie.js', 'route.js', 'user.js'];
  for (const name of files) {
    const lines = Array.from({ length: 12 }, (_, i) => `export const ${name.slice(0, 3)}_${i} = ${i};\n`).join('');
    writeFileSync(join(repo, name), name === 'auth.js'
      ? 'export function login(user, password, token) {\n  if (!password) return null;\n  return { user };\n}\n' + lines
      : lines);
  }
  git(['add', '.']);
  git(['commit', '-m', 'login drops the token']);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  const briefPath = join(common, 'session-rail', 'briefs', `${encodeURIComponent('feature/wide-login')}.md`);
  mkdirSync(dirname(briefPath), { recursive: true });
  writeFileSync(briefPath, BRIEF);
}

function setupHome(wideReview) {
  rmSync(home, { recursive: true, force: true });
  const activity = join(home, '.claude', 'session-rail', 'activity');
  mkdirSync(activity, { recursive: true });
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
  mkdirSync(join(home, 'gh'), { recursive: true });
  writeFileSync(join(home, '.claude', 'session-rail', 'settings.json'), JSON.stringify({ wideReview }));
  writeFileSync(join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({
    pid, sessionId, name: 'Wide login', cwd: repo, status: 'idle',
    statusUpdatedAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now() - 60_000,
  }));
  writeFileSync(join(activity, `${sessionId}.json`), JSON.stringify({
    claude: { state: 'waiting', since: Date.now() - 5_000 },
    running: [], recent: [], agents: {}, turns: [],
  }));
}

function envFor() {
  const env = { ...process.env, HOME: home, GH_CONFIG_DIR: join(home, 'gh') };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function frame(script, args) {
  return execFileSync(process.execPath, [join(plugin, 'bin', script), ...args], {
    env: envFor(), encoding: 'utf8', timeout: 40_000,
  });
}

function desk() {
  return frame('desk.mjs', ['--frame', '96', '32', '--tab', 'review', '--cwd', repo, '--pid', String(pid), '--session', sessionId]);
}

function rail() {
  return frame('rail.mjs', ['--frame', '78', '36', '--cwd', repo, '--pid', String(pid), '--session', sessionId]);
}

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '');

function show(caption, body) {
  process.stdout.write('\x1b[2J\x1b[H\x1b[0m');
  process.stdout.write(`\x1b[1m${caption}\x1b[0m\n`);
  process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (pred, ms) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for the wide review');
    await sleep(100);
  }
};

function writeDesk(review, reviewers) {
  const path = join(home, '.claude', 'session-rail', 'activity', `${sessionId}.desk.json`);
  writeFileSync(path, JSON.stringify({ pid, review, reviewers, updatedAt: Date.now() }));
}

setupRepo();
setupHome(false);
show('Wide review is off. This pull request changes 8 files, and the desk does not offer it.', desk());
await sleep(hold);

setupHome(true);
show('Wide review is on. The same diff now offers Wide review.', desk());
await sleep(hold);

let phase = 'start';
const startedAt = Date.now();
const run = wideReviewAndSave(repo, {
  settings: { wideReview: true },
  command: [process.execPath, join(plugin, 'scripts/wide-fixture-model.mjs')],
  env: { ...process.env, WIDE_FIXTURE_MS: String(modelMs) },
  onProgress(list) {
    phase = list.some((r) => r.role === 'skeptic' && !r.endedAt) ? 'skeptic'
      : list.some((r) => r.role === 'file' && !r.endedAt) ? 'files' : phase;
    writeDesk({ kind: 'wide review', startedAt }, list);
  },
});

await waitFor(() => phase === 'files', 10_000);
show('File reviewers fan out in worktrees. Each one is a named subagent on the rail.', rail());
await sleep(hold);
await waitFor(() => phase === 'skeptic', modelMs + 20_000);
show('The skeptic checks their findings. Finished reviewers stay listed.', rail());
await sleep(Math.min(hold, 2000));
const result = await run;
writeDesk(null, []);
if (result.error || !result.findings?.some((f) => f.status === 'open' && /token/i.test(f.title))) {
  process.stderr.write(`wide review failed: ${result.error || 'missing finding'}\n`);
  process.exit(1);
}
const report = desk();
if (!/session token is ignored/i.test(plain(report)) || !/✗ declined/.test(plain(report)) || !/Style only/.test(plain(report))) {
  process.stderr.write('the desk did not show the skeptic report\n');
  process.exit(1);
}
show('One report. The skeptic kept the bug and declined the style note.', report);
await sleep(hold + 800);
rmSync(home, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });

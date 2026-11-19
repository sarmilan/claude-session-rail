import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { noteTests, fresh } from '../bin/activity.mjs';
import { droopFor } from '../bin/mascot.mjs';
import { loadProject, runStop } from '../bin/stop-hook.mjs';
import {
  commandFromAgents, gateDecision, hostReply, packageTestCommand, performGate, projectCommand,
  resolveTestCommand, settingFrom, stopHookActive, wasInterrupted,
} from '../bin/stopgate.mjs';

const HOOK = new URL('../bin/stop-hook.mjs', import.meta.url).pathname;

test('the command resolves setting, then AGENTS.md, then package script, then this repo, and off wins', () => {
  assert.equal(commandFromAgents('## Tests\n\nnpm test\n'), 'npm test');
  assert.equal(commandFromAgents('Tests: npm test\n'), 'npm test');
  assert.equal(commandFromAgents('- Run tests: `pnpm test`\n'), 'pnpm test');
  assert.equal(commandFromAgents('**Test command:** `make -C src check`\n'), 'make -C src check');
  assert.equal(commandFromAgents('run npm test'), null);
  assert.equal(commandFromAgents('## Setup\n\n```bash\nnpm install\n```\n'), null);
  assert.equal(commandFromAgents('## Testing\n\nSee CLAUDE.md for the deeper notes.\n'), null);
  assert.equal(commandFromAgents('```js\nTests: npm test\n```\n'), null);
  assert.equal(commandFromAgents('## Tests\n\n```test\nclaude plugin validate .\nclaude plugin test .\n```\n'), 'claude plugin validate . && claude plugin test .');
  assert.equal(commandFromAgents('```test\nnpm test\n```\n\nTests: make lint\n'), 'npm test');
  assert.equal(commandFromAgents('## Tests\n\nRun the suite.\n\nnpm test\n'), 'npm test');
  assert.equal(commandFromAgents('## Tests\n\n```ts\nconst x = 1\n```\n\nnpm test\n'), 'npm test');
  assert.equal(commandFromAgents('<!--\n```test\nnpm test\n```\n-->\nHello.\n'), null);
  assert.equal(commandFromAgents('## Tests\r\n\r\nnpm test\r\n'), 'npm test');
  assert.equal(commandFromAgents(null), null);
  assert.equal(commandFromAgents(''), null);
  assert.equal(packageTestCommand('echo "Error: no test specified" && exit 1'), null);
  assert.equal(packageTestCommand('node --test'), 'npm test');
  assert.deepEqual(resolveTestCommand({ setting: false, agentsText: '## Tests\n\nnpm test\n', packageScript: 'node --test', repoDefault: 'make test' }), { command: null, source: 'off' });
  assert.deepEqual(resolveTestCommand({ setting: 'make check', agentsText: '## Tests\n\nnpm test\n' }), { command: 'make check', source: 'setting' });
  assert.deepEqual(resolveTestCommand({ agentsText: '## Tests\n\nnpm test\n', packageScript: 'node --test', repoDefault: 'make test' }), { command: 'npm test', source: 'agents' });
  assert.deepEqual(resolveTestCommand({ agentsText: 'run npm test', packageScript: 'node --test' }), { command: 'npm test', source: 'package' });
  assert.deepEqual(resolveTestCommand({}), { command: null, source: null });
  assert.equal(settingFrom({ testCommand: 'make test' }, { command: false }), false);
  assert.equal(settingFrom({ testCommand: 'make test' }, {}), 'make test');
  const here = projectCommand({ pluginName: 'session-rail', hasRail: true });
  assert.equal(here.source, 'default');
  assert.match(here.command, /claude plugin test/);
  assert.equal(projectCommand({ pluginName: 'session-rail', hasRail: false }).command, null);
});

test('a failure blocks and a pass, a timeout, an interrupt, and stop_hook_active do not loop', () => {
  const fail = gateDecision({ command: 'npm test', exitCode: 1, output: 'ok\nnot ok 1\n' });
  assert.equal(fail.action, 'block');
  assert.match(fail.reason, /tests failed \(npm test\)/);
  assert.match(fail.reason, /not ok 1/);
  assert.equal(gateDecision({ command: 'npm test', exitCode: 0, output: '' }).action, 'allow');
  assert.equal(gateDecision({ command: 'npm test', exitCode: 1, timedOut: true, output: '' }).why, 'timeout');
  assert.equal(stopHookActive({ stop_hook_active: true }), true);
  assert.equal(stopHookActive({ stop_hook_active: 'false' }), false);
  assert.equal(wasInterrupted({ interrupted: true }), true);
  assert.equal(wasInterrupted({ reason: 'interrupt' }), true);
  assert.equal(wasInterrupted({ stop_hook_active: true }), false);
});

test('Claude exits 2 and Grok prints a block decision', () => {
  const decision = { action: 'block', reason: 'session-rail: tests failed (npm test). The stop is held.' };
  const claude = hostReply('claude', decision);
  assert.equal(claude.exitCode, 2);
  assert.match(claude.stderr, /tests failed/);
  assert.equal(JSON.parse(claude.stdout).decision, 'block');
  assert.equal(claude.stdout.includes('continue'), false);
  const grok = hostReply('grok', decision);
  assert.equal(grok.exitCode, 0);
  assert.equal(grok.stderr, '');
  assert.equal(JSON.parse(grok.stdout).decision, 'block');
  assert.equal(JSON.parse(grok.stdout).reason, decision.reason);
  assert.deepEqual(hostReply('claude', { action: 'allow' }), { exitCode: 0, stdout: '', stderr: '' });
  assert.deepEqual(hostReply('grok', { action: 'allow' }), { exitCode: 0, stdout: '', stderr: '' });
});

test('one stop runs the command once, and stop_hook_active does not run it again', async () => {
  let runs = 0;
  const lock = { value: null };
  const io = {
    now: () => 5_000,
    load: async () => ({ command: 'npm test', root: '/repo' }),
    readLock: async () => lock.value,
    writeLock: async (record) => { lock.value = record; },
    run: async () => {
      runs += 1;
      return { exitCode: 1, output: 'not ok', timedOut: false };
    },
  };
  const event = { hook_event_name: 'Stop', session_id: 's', cwd: '/repo', last_assistant_message: 'done' };
  const first = await performGate(event, io);
  assert.equal(first.action, 'block');
  const again = await performGate(event, io);
  assert.equal(again.action, 'block');
  assert.equal(again.reason, first.reason);
  const active = await performGate({ ...event, stop_hook_active: true }, io);
  assert.equal(active.why, 'stop_hook_active');
  assert.equal(runs, 1);
  const passed = await performGate({ ...event, last_assistant_message: 'fixed' }, {
    ...io,
    run: async () => ({ exitCode: 0, output: 'ok', timedOut: false }),
  });
  assert.equal(passed.action, 'allow');
  assert.equal(passed.ok, true);
});

test('a failed test droops the pet until a later pass', () => {
  const failed = noteTests(fresh(1), { at: 10, ok: false, command: 'npm test', detail: 'not ok' }, 10);
  assert.equal(droopFor(failed), true);
  assert.equal(failed.tests.ok, false);
  const passed = noteTests(failed, { at: 20, ok: true, command: 'npm test', detail: '' }, 20);
  assert.equal(droopFor(passed), false);
  assert.equal(passed.tests.ok, true);
  const twice = noteTests(failed, { at: 10, ok: false, command: 'npm test', detail: 'not ok' }, 11);
  assert.equal(twice.recent.filter((r) => r.tool === 'test').length, 1);
});

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'stop-gate-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

test('the project files are read in order, and AGENTS.md supplies the command', () => {
  const dir = fixture({
    'session-rail.json': '{"testCommand":"make check"}\n',
    'package.json': '{"scripts":{"test":"node --test"}}\n',
    'AGENTS.md': 'Tests: npm test\n',
    '.claude-plugin/plugin.json': '{"name":"session-rail"}\n',
    'bin/rail.mjs': '',
  });
  try {
    assert.deepEqual(loadProject(dir), { root: dir, command: 'make check', source: 'setting' });
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(dir, '.git', 'session-rail'), { recursive: true });
    writeFileSync(join(dir, '.git', 'session-rail', 'tests.json'), '{"command":false}\n');
    assert.equal(loadProject(dir).command, null);
    assert.equal(loadProject(dir).source, 'off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const agents = fixture({
    'AGENTS.md': '## Tests\n\nnpm test\n',
    'package.json': '{"scripts":{"test":"node --test"}}\n',
  });
  try {
    assert.deepEqual(loadProject(agents), { root: agents, command: 'npm test', source: 'agents' });
  } finally {
    rmSync(agents, { recursive: true, force: true });
  }
  const prose = fixture({
    'AGENTS.md': 'run npm test\n',
    'package.json': '{"scripts":{"test":"node --test"}}\n',
  });
  try {
    assert.deepEqual(loadProject(prose), { root: prose, command: 'npm test', source: 'package' });
  } finally {
    rmSync(prose, { recursive: true, force: true });
  }
  const pkg = fixture({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}\n' });
  try {
    assert.equal(loadProject(pkg).command, null);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

function runHook(dir, event, host) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: join(dir, 'home'),
      SESSION_RAIL_TEST: '1',
      SESSION_RAIL_STOP_HOST: host,
    };
    delete env.SESSION_RAIL_HEADLESS;
    const child = spawn(process.execPath, [HOOK], { cwd: dir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ cwd: dir, session_id: 'demo', hook_event_name: 'Stop', ...event }));
  });
}

test('a fixture repo blocks a red stop and allows a green one, on both hosts', async () => {
  const dir = fixture({
    'session-rail.json': '{"testCommand":"node marker.mjs"}\n',
    'marker.mjs': "import { writeFileSync, readFileSync } from 'node:fs';\nwriteFileSync('ran', '1');\nprocess.exit(Number(readFileSync('code.txt', 'utf8')));\n",
    'code.txt': '1\n',
  });
  try {
    for (const host of ['claude', 'grok']) {
      rmSync(join(dir, 'ran'), { force: true });
      const red = await runHook(dir, { last_assistant_message: `red ${host}` }, host);
      assert.equal(existsSync(join(dir, 'ran')), true, `${host} ran the tests`);
      if (host === 'claude') {
        assert.equal(red.code, 2);
        assert.match(red.stderr, /tests failed/);
      } else {
        assert.equal(red.code, 0);
        assert.equal(red.stderr, '');
        assert.equal(JSON.parse(red.stdout).decision, 'block');
      }
      const activity = JSON.parse(readFileSync(join(dir, 'home', '.claude', 'session-rail', 'activity', 'demo.json'), 'utf8'));
      assert.equal(activity.tests.ok, false);
      assert.equal(activity.recent[0].tool, 'test');

      rmSync(join(dir, 'ran'), { force: true });
      const held = await runHook(dir, { stop_hook_active: true, last_assistant_message: `held ${host}` }, host);
      assert.equal(held.code, 0);
      assert.equal(held.stderr, '');
      assert.equal(existsSync(join(dir, 'ran')), false, `${host} did not run tests while stop_hook_active`);

      writeFileSync(join(dir, 'code.txt'), '0\n');
      const green = await runHook(dir, { last_assistant_message: `green ${host}` }, host);
      assert.equal(green.code, 0);
      assert.equal(green.stderr, '');
      assert.equal(green.stdout, '');
      const after = JSON.parse(readFileSync(join(dir, 'home', '.claude', 'session-rail', 'activity', 'demo.json'), 'utf8'));
      assert.equal(after.tests.ok, true);
      writeFileSync(join(dir, 'code.txt'), '1\n');
    }
    rmSync(join(dir, 'ran'), { force: true });
    const interrupted = await runHook(dir, { interrupted: true, last_assistant_message: 'stopped' }, 'claude');
    assert.equal(interrupted.code, 0);
    assert.equal(existsSync(join(dir, 'ran')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stop hook runs the command named in AGENTS.md', async () => {
  const dir = fixture({
    'AGENTS.md': '# Map\n\n## Tests\n\n```test\nnode check.mjs\n```\n',
    'package.json': '{"scripts":{"test":"node from-package.mjs"}}\n',
    'check.mjs': "import { writeFileSync, readFileSync } from 'node:fs';\nwriteFileSync('ran', 'agents');\nprocess.exit(Number(readFileSync('code.txt', 'utf8')));\n",
    'code.txt': '1\n',
  });
  try {
    assert.deepEqual(loadProject(dir), { root: dir, command: 'node check.mjs', source: 'agents' });
    const red = await runHook(dir, { last_assistant_message: 'red agents' }, 'claude');
    assert.equal(red.code, 2);
    assert.match(red.stderr, /tests failed \(node check\.mjs\)/);
    assert.equal(readFileSync(join(dir, 'ran'), 'utf8'), 'agents');
    writeFileSync(join(dir, 'code.txt'), '0\n');
    const green = await runHook(dir, { last_assistant_message: 'green agents' }, 'grok');
    assert.equal(green.code, 0);
    assert.equal(green.stderr, '');
    assert.equal(green.stdout, '');
    const activity = JSON.parse(readFileSync(join(dir, 'home', '.claude', 'session-rail', 'activity', 'demo.json'), 'utf8'));
    assert.equal(activity.tests.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const REPO_TEST_COMMAND = [
  'claude plugin validate .',
  'claude plugin test .',
  'node bin/rail.mjs --frame 42 40',
  'node bin/rail.mjs --frame 42 40 --tab git',
  'node bin/desk.mjs --frame 80 40 --tab diff',
].join(' && ');

test('this repo takes its test command from AGENTS.md', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(text.split('\n').length < 80, 'AGENTS.md stays short');
  assert.match(text, /CLAUDE\.md/);
  assert.equal(text.includes('Say the plan is in the Plan tab'), false);
  assert.equal(commandFromAgents(text), REPO_TEST_COMMAND);
  const loaded = loadProject(root);
  assert.equal(loaded.source, 'agents');
  assert.equal(loaded.command, REPO_TEST_COMMAND);
});

test('runStop agrees with the process for a pass and a headless skip', async () => {
  const dir = fixture({
    'session-rail.json': '{"testCommand":"node -e \\"process.exit(1)\\""}\n',
  });
  const previous = process.env.SESSION_RAIL_HEADLESS;
  process.env.SESSION_RAIL_HEADLESS = '1';
  try {
    const skipped = await runStop({ hook_event_name: 'Stop', cwd: dir, session_id: 'h' }, { host: 'grok', cwd: dir });
    assert.equal(skipped.exitCode, 0);
    assert.equal(skipped.stdout, '');
  } finally {
    if (previous == null) delete process.env.SESSION_RAIL_HEADLESS;
    else process.env.SESSION_RAIL_HEADLESS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

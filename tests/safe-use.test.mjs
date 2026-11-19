// The permissions starter must stay a starting point: Manual / ask, no bypass, no auto-allow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (/\.(mjs|js|ts|json|md)$/.test(name)) out.push(path);
  }
  return out;
}

test('Claude starter keeps prompts and turns the sandbox on without auto-allow', () => {
  const settings = JSON.parse(read('docs/safe-use/claude.settings.json'));
  assert.equal(settings.permissions.defaultMode, 'default');
  assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.autoAllowBashIfSandboxed, false);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.ok(settings.permissions.ask.includes('Bash(git push *)'));
  assert.ok(settings.permissions.ask.includes('Bash(gh pr merge *)'));
  assert.ok(settings.permissions.deny.includes('Bash(curl *)'));
  assert.ok(settings.permissions.deny.includes('Bash(rm -rf *)'));
  assert.ok(settings.permissions.deny.includes('Read(~/.ssh/**)'));
  assert.deepEqual(settings.sandbox.filesystem.denyRead, ['~/.ssh', '~/.aws']);
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  assert.equal(settings.permissions.allow, undefined);
  const blob = JSON.stringify(settings);
  assert.equal(blob.includes('bypassPermissions'), false);
  assert.equal(blob.includes('dangerously-skip-permissions'), false);
  assert.equal(blob.includes('acceptEdits'), false);
  assert.equal(blob.includes('"auto"'), false);
});

test('Grok starter stays on ask and does not auto-allow bash', () => {
  const project = read('docs/safe-use/grok.config.toml');
  const user = read('docs/safe-use/grok.user.toml');
  const sandbox = read('docs/safe-use/grok.sandbox.toml');
  for (const text of [project, user, sandbox]) {
    assert.match(text, /Starting point, not a guarantee/);
    assert.doesNotMatch(text, /always-approve|\byolo\b/);
  }
  assert.match(user, /permission_mode = "ask"/);
  assert.match(user, /auto_allow_bash = false/);
  assert.match(user, /profile = "workbench"/);
  assert.match(sandbox, /extends = "workspace"/);
  assert.match(sandbox, /restrict_network = true/);
  assert.match(project, /Bash\(curl \*\)/);
  assert.match(project, /Bash\(git push \*\)/);
});

test('Safe use docs state the host-Mac risk, the pending shell-write PR, and the official docs', () => {
  const page = read('docs/safe-use.md');
  const readme = read('README.md');
  for (const text of [page, readme]) {
    assert.match(text, /starting point, not a guarantee/);
    assert.match(text, /https:\/\/code\.claude\.com\/docs\/en\/permissions/);
    assert.match(text, /https:\/\/code\.claude\.com\/docs\/en\/sandboxing/);
    assert.match(text, /https:\/\/docs\.x\.ai\/build\/features\/permissions/);
    assert.match(text, /https:\/\/docs\.x\.ai\/build\/features\/sandbox/);
    assert.match(text, /github\.com\/sarmilan\/workbench\/pull\/61/);
    assert.match(text, /not merged/);
  }
  assert.match(page, /host Mac/);
  assert.match(readme, /your Mac/);
  assert.match(page, /bin\/pane\.mjs/);
  assert.match(page, /OpenHands/);
  assert.match(readme, /docs\/safe-use\.md/);
});

test('plugin source does not enable dangerously-skip-permissions or bypass mode', () => {
  const roots = ['bin', 'hooks', 'commands'].map((d) => join(root, d));
  const files = roots.flatMap((d) => walk(d));
  const offenders = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (text.includes('dangerously-skip-permissions') || text.includes('bypassPermissions')) offenders.push(path);
    if (text.includes('--always-approve') && !path.endsWith(`${join('bin', 'reviewer.mjs')}`)) offenders.push(path);
    if (text.includes('--permission-mode') && !text.includes("dontAsk")) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
  const reviewer = read('bin/reviewer.mjs');
  assert.match(reviewer, /--permission-mode', 'dontAsk'/);
  assert.match(reviewer, /--always-approve/);
  assert.match(reviewer, /--disallowed-tools', 'write,search_replace,run_terminal_command,web_search,web_fetch'/);
});

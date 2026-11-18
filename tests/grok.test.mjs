import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { callFinished, callStarted, fresh, heard, noteReply, replied, trackTasks, turnEnded, turnStarted } from '../bin/activity.mjs';
import { attentionFor } from '../bin/mascot.mjs';
import { approvalRecord, briefFile, checkoutName, inWorkTree, mainCheckoutNote, parseBrief } from '../bin/brief.mjs';
import { armTurn, editReason, handle, procedure, readBrief, slashCommand, takeProcedure } from '../bin/grok-hook.mjs';
import { briefInstructions, deskOutsideNote, outsideRepoNote } from '../bin/brief-instructions.mjs';
import { C, fg, paneBgOff, paneBgOn, usePalette } from '../bin/term.mjs';
import { connectorsFrom, contextFrom, eventsFromText, rowFromActive, usageFromBilling } from '../bin/sources.mjs';
import { reviewPayload } from '../bin/reviewer.mjs';
import { goAhead, startWanted, step } from '../bin/grok-watch.mjs';
import { buildStory } from '../bin/sessionstory.mjs';

const brief = {
  branch: 'feature/x', path: '/repo/.git/session-rail/briefs/x.md',
  approvedPath: '/repo/.git/session-rail/briefs/x.approved.json', dir: '/repo/.git/session-rail/',
  text: null, approval: null,
};

test('a Grok review verdict in the message text is the payload', () => {
  const verdict = { verdict: 'on-track', summary: 'ok', findings: [], checks: [] };
  assert.deepEqual(reviewPayload({ structured_output: verdict }), verdict);
  assert.deepEqual(reviewPayload({ structuredOutput: verdict }), verdict);
  assert.deepEqual(reviewPayload({ text: JSON.stringify(verdict) }), verdict);
  assert.equal(reviewPayload({ text: 'no verdict here' }), null);
});

test('edits under the brief dir and an empty brief are told apart', () => {
  assert.equal(editReason(null, '/repo/a.js'), null);
  assert.match(editReason(brief, brief.approvedPath), /only the person approves/);
  assert.equal(editReason(brief, '/repo/.git/session-rail/briefs/x.md'), null);
  assert.match(editReason(brief, '/repo/a.js'), /wait for the session brief/);
  assert.equal(editReason({ ...brief, approval: { approvedAt: 1 } }, '/repo/a.js'), null);
});

test('a rebase names the branch, and the work tree is the toplevel', () => {
  assert.equal(checkoutName('feature/x', ''), 'feature/x');
  assert.equal(checkoutName('HEAD', 'refs/heads/feature/x'), 'feature/x');
  assert.equal(checkoutName('HEAD', ''), 'HEAD');
  assert.equal(inWorkTree('/repo', '/repo/src/a.ts'), true);
  assert.equal(inWorkTree('/repo', '/tmp/plan.md'), false);
  assert.equal(inWorkTree('/repo', 'bin/rail.mjs'), true);
});

test('a Claude transcript line is read when its type sits past the first 96 characters', () => {
  const user = JSON.stringify({
    parentUuid: 'u'.repeat(80), cwd: '/repo', type: 'user',
    message: { role: 'user', content: 'show the session' },
  });
  const assistant = JSON.stringify({
    parentUuid: 'a'.repeat(80), type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'The tab lists tools' }] },
  });
  assert.ok(user.indexOf('"type":"user"') > 96);
  assert.equal(assistant.slice(0, 96).includes('"role":"assistant"'), false);
  const events = eventsFromText(`${user}\n${assistant}\nnot a story line\n`);
  assert.deepEqual(events.map((e) => e.text), ['show the session', 'The tab lists tools']);
});

test('on main a repo edit is refused and names the branch and the brief', () => {
  const main = { branch: 'main', cwd: '/repo' };
  const reason = editReason(null, '/repo/bin/rail.mjs', main);
  assert.match(reason, /No brief for main/);
  assert.match(reason, /brief/);
  assert.match(reason, /Plan tab/);
  assert.equal(editReason(null, '/Users/me/.grok/sessions/x/plan.md', main), null);
  assert.match(editReason(null, 'bin/rail.mjs', main), /No brief for main/);
  assert.match(editReason(null, '/repo/a.js', { branch: 'master', cwd: '/repo' }), /No brief for master/);
  assert.match(editReason(null, '/repo/a.js', { branch: 'HEAD', cwd: '/repo' }), /detached HEAD/);
  assert.match(mainCheckoutNote('detached'), /detached HEAD/);
  assert.match(editReason(brief, '/repo/a.js'), /wait for the session brief/);
  assert.equal(editReason({ ...brief, approval: { approvedAt: 1 } }, '/repo/a.js'), null);
});

test('outside a repo the agent is told the desk cannot see a brief in another folder', () => {
  const state = {};
  const text = procedure('/not-a-repo', state);
  assert.match(text, /not a git repo/);
  assert.match(text, /\/not-a-repo/);
  assert.match(text, /Plan tab/);
  assert.match(text, /desk\.mjs --frame 72 24 --tab plan/);
  assert.equal(text, outsideRepoNote('/not-a-repo'));
  assert.equal(procedure('/not-a-repo', state), null);
  assert.match(deskOutsideNote('~/workspace'), /not a git repo/);
  assert.match(deskOutsideNote('~/workspace'), /started in/);
});

test('the brief procedure waits for this session desk frame', () => {
  const text = briefInstructions({ branch: 'feature/x', path: '/repo/.git/session-rail/briefs/x.md' });
  assert.match(text, /Don't wait to be asked/);
  assert.match(text, /desk\.mjs --frame 72 24 --tab plan/);
  assert.match(text, /If that frame does not show this brief/);
  assert.match(text, /do not write one in place of the brief/);
  assert.match(text, /shell command that writes a file/);
  assert.match(text, /git log still runs/);
  assert.equal(text.includes("say it's in the desk's Plan tab"), false);
});

test('a second user prompt hears the procedure again', () => {
  const state = {};
  assert.equal(takeProcedure(state, 'write the brief'), 'write the brief');
  assert.equal(takeProcedure(state, 'write the brief'), null);
  assert.equal(state.briefSent, true);
  armTurn(state);
  assert.equal(state.briefSent, false);
  assert.equal(takeProcedure(state, 'write the brief'), 'write the brief');
});

test('slash commands are the rail, the desk and approve', () => {
  assert.equal(slashCommand('/rail'), 'rail');
  assert.equal(slashCommand('  /desk now'), 'desk');
  assert.equal(slashCommand('/approve-brief'), 'approve-brief');
  assert.equal(slashCommand('session-rail-command: rail'), 'rail');
  assert.equal(slashCommand('/session-rail:desk'), 'desk');
  assert.equal(slashCommand('please /rail later'), null);
});

test('a grok session draws GrokNight and a claude session keeps its palette', () => {
  usePalette('grok');
  assert.deepEqual(C.accent, [187, 154, 247]);
  assert.deepEqual(C.select, [36, 36, 36]);
  assert.deepEqual(C.bg, [20, 20, 20]);
  assert.match(fg(C.accent, 'x'), /\x1b\[38;2;187;154;247mx/);
  assert.equal(paneBgOn(), '\x1b]11;#141414\x07');
  assert.equal(paneBgOff(), '\x1b]111\x07');
  usePalette('claude');
  assert.equal(C.accent, 173);
  assert.equal(C.select, 237);
  assert.equal(C.bg, null);
  assert.equal(paneBgOn(), '');
  assert.equal(paneBgOff(), '');
  assert.match(fg(C.accent, 'x'), /\x1b\[38;5;173mx/);
});

test('a turn ending clears the main call and leaves a background agent', () => {
  let a = turnStarted(fresh(1), 'grok-4.7', 2);
  a = callStarted(a, { id: 't', tool: 'read_file', arg: 'a.js', since: 3 });
  a = callFinished(a, 't', true, 4);
  assert.equal(a.claude.state, 'thinking');
  assert.equal(a.recent[0].tool, 'read_file');
  a = turnEnded(a, 5);
  assert.equal(a.claude.state, 'waiting');
  assert.equal(a.running.length, 0);
});

test('Grok never reports busy, so the pet follows the activity feed', () => {
  const session = { status: 'unknown', statusSince: 1_000, host: 'grok' };
  const tool = { claude: { state: 'tool', since: 4_000 }, running: [{ id: 'c', tool: 'read_file' }] };
  assert.equal(attentionFor({ activity: tool, session, now: 5_000 }), 'busy');
  assert.equal(attentionFor({ activity: { claude: { state: 'waiting', since: 4_000 } }, session, now: 5_000 }), 'waiting');
  assert.equal(attentionFor({ activity: null, session, now: 1_000 + 2 * 60 * 60 * 1000 }), 'idle');
  const shell = [{ id: 'sh', kind: 'shell' }];
  assert.equal(attentionFor({ activity: { claude: { state: 'waiting', since: 4_000 } }, tasks: shell, session, now: 5_000 }), 'busy');
});

test('a stop keeps the shells and subagents that are still running', () => {
  const a = trackTasks(fresh(1), [
    { id: 's1', type: 'shell', command: 'npm test' },
    { id: 'a1', type: 'subagent', description: 'review the diff', agentType: 'general' },
    { id: 'm1', type: 'monitor', description: 'watch the build' },
  ], 10);
  assert.deepEqual(a.tasks.map((t) => [t.id, t.kind, t.label]), [
    ['s1', 'shell', 'npm test'],
    ['a1', 'agent', 'review the diff'],
    ['m1', 'monitor', 'watch the build'],
  ]);
  assert.equal(a.tasks[0].startedAt, 10);
  const kept = trackTasks(a, [{ id: 's1', type: 'shell', command: 'npm test' }], 20);
  assert.equal(kept.tasks.length, 1);
  assert.equal(kept.tasks[0].startedAt, 10);
  assert.deepEqual(trackTasks(a, [], 30).tasks, []);
  assert.equal(trackTasks(a, undefined, 30), a);
});

test('a turn remembers what was asked and what was answered', () => {
  let a = heard(fresh(1), '  bring the attitude  ', 2);
  a = heard(a, '', 3);
  a = replied(a, 'the tab now opens each handoff', 4);
  assert.deepEqual(a.turns.map((t) => t.role), ['you', 'main']);
  assert.equal(a.turns[0].text, 'bring the attitude');
  a = noteReply(a, 'missing', 'nope', 5);
  assert.equal(a.agents, undefined);
  a = { ...a, agents: { w: { name: 'Wren', what: 'look', since: 1, background: false } } };
  a = noteReply(a, 'w', 'names come from names.mjs', 6);
  assert.equal(a.agents.w.reply, 'names come from names.mjs');
  for (let i = 0; i < 40; i++) a = heard(a, `ask ${i}`, 10 + i);
  assert.equal(a.turns.length, 30);
  assert.equal(a.turns[0].text, 'ask 10');
});

test('go-ahead waits for an approval newer than the one already seen', () => {
  const seen = { branch: 'feature/x', approvedAt: null };
  assert.equal(goAhead(null, { ...seen, approvedAt: 5 }, 'one'), null);
  assert.match(goAhead(seen, { ...seen, approvedAt: 5 }, 'one'), /chunk 1 \(one\)/);
  assert.equal(goAhead({ ...seen, approvedAt: 5 }, { ...seen, approvedAt: 5 }), null);
  assert.match(goAhead({ ...seen, approvedAt: 5 }, { ...seen, approvedAt: 9 }), /Carry on/);
  assert.equal(goAhead(seen, { branch: 'feature/y', approvedAt: 9 }), null);
});

test('/start only goes to a session that has not spoken yet', () => {
  assert.equal(startWanted({ envStarted: false, startRan: false, messages: 0, hasStart: true }), true);
  assert.equal(startWanted({ envStarted: true, startRan: false, messages: 0, hasStart: true }), false);
  assert.equal(startWanted({ envStarted: false, startRan: false, messages: 3, hasStart: true }), false);
  assert.equal(startWanted({ envStarted: false, startRan: false, messages: null, hasStart: true }), false);
  assert.equal(startWanted({ envStarted: false, startRan: false, messages: 0, hasStart: false }), false);
});

test('the watcher types /start once, then a new approval, and not an old one', () => {
  const waiting = { claude: { state: 'waiting', since: Date.now() - 2_000 } };
  const at = { activity: waiting, cwd: '/repo', tty: '/dev/ttys000', envStarted: false, sessionId: 's' };
  const quiet = {
    type: () => true, summary: () => ({ num_chat_messages: 0 }), hasStart: () => true, hookStartRan: false,
    branch: () => 'main', approval: () => null, firstChunk: () => undefined, brief: () => null, merged: () => false, autoCompact: () => true,
  };
  const started = step({ ...at, watch: {} }, quiet);
  assert.equal(started.typed, '/start');
  assert.equal(step({ ...at, watch: started.watch }, quiet).typed, null);

  const io = { ...quiet, summary: () => ({ num_chat_messages: 4 }), hasStart: () => false, hookStartRan: true,
    branch: () => 'feature/x', approval: () => ({ approvedAt: 10 }), firstChunk: () => 'ships' };
  const seen = step({ ...at, watch: { startRan: true, approval: { branch: 'feature/x', approvedAt: null } } }, io);
  assert.match(seen.typed, /chunk 1 \(ships\)/);
  assert.equal(step({ ...at, watch: seen.watch }, io).typed, null);
});

test('a grok session row and its context come from the live files', () => {
  const row = rowFromActive(
    { pid: 7, session_id: 'abc', cwd: '/repo/app', opened_at: '2026-01-01T00:00:00Z' },
    { generated_title: 'Fix the rail', current_model_id: 'grok-4.7', updated_at: '2026-01-02T00:00:00Z' },
  );
  assert.equal(row.host, 'grok');
  assert.equal(row.name, 'Fix the rail');
  assert.equal(row.sessionId, 'abc');
  const ctx = contextFrom({ contextWindowUsage: 27, contextTokensUsed: 70_000, contextWindowTokens: 256_000 }, { current_model_id: 'grok-4.7', reasoning_effort: 'high' });
  assert.equal(ctx.contextPct, 27);
  assert.equal(ctx.model, 'Grok 4.7');
  assert.equal(ctx.effort, 'high');
  const fraction = contextFrom({ contextWindowUsage: 0.28, contextTokensUsed: 71_680, contextWindowTokens: 256_000 }, {});
  assert.equal(fraction.contextPct, 28);
  const priced = contextFrom({ contextWindowUsage: 10 }, {}, { session: { costUsdTicks: 802300000 } });
  assert.equal(priced.costUsd, 0.08023);
});

test('grok billing becomes a week row, and a month row only when the plan has a limit', () => {
  const end = '2026-11-19T21:29:20.498+00:00';
  const week = usageFromBilling({
    config: {
      creditUsagePercent: 2,
      currentPeriod: { end },
      productUsage: [{ product: 'GrokBuild', usagePercent: 2 }, { product: 'OtherProduct', usagePercent: 40 }],
    },
  }, { config: { monthlyLimit: { val: 0 }, used: { val: 124 } } });
  assert.deepEqual(week.map((r) => r.kind), ['week', 'week']);
  assert.equal(week[0].percentUsed, 2);
  assert.equal(week[0].resetsAt, end);
  assert.equal(week[1].label, 'Other Product');
  assert.equal(week[1].percentUsed, 40);
  const month = usageFromBilling(null, { config: { monthlyLimit: { val: 200 }, used: { val: 50 }, billingPeriodEnd: '2026-12-01' } });
  assert.deepEqual(month, [{ kind: 'month', percentUsed: 25, resetsAt: '2026-12-01' }]);
  assert.deepEqual(usageFromBilling(null, null), []);
});

test('grok connectors are its own servers plus Twitter and GitHub, without the Claude account', () => {
  const built = connectorsFrom({
    mcp: [{ name: 'claude.ai Gmail', source: 'claude' }, { name: 'tasks', status: 'connected' }],
    catalog: [{ displayName: 'Drive', status: 'disconnected' }],
    user: { xUserId: '363' },
    github: { ok: true },
  });
  assert.deepEqual(built.items.map((i) => i.name), ['tasks', 'Drive', 'Twitter', 'GitHub']);
  assert.equal(built.items.find((i) => i.name === 'Drive').ok, false);
  assert.equal(built.connected, 3);
  const bare = connectorsFrom({ user: {}, github: null });
  assert.deepEqual(bare.items, []);
});

// ── Shell writes and the brief gate ──────────────────────────────────────────
const agent = { host: 'grok', tty: '/dev/ttys001', pid: process.pid };
const BRIEF = `# T
## Problem
Currently it's A; we need B to solve A.
## Solution
As a dev, I should be able to Y so I can Z.
## Engineering
### Chunk 1: first
Do the first thing.
`;

function initRepo(branch) {
  const cwd = mkdtempSync(join(tmpdir(), 'rail-shell-'));
  execFileSync('git', ['init', '-q', '-b', branch], { cwd });
  // An empty repo has no HEAD commit, and `rev-parse HEAD` then fails, so the hook cannot see the branch.
  writeFileSync(join(cwd, 'README.md'), 'x\n');
  const git = ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=Test'];
  execFileSync('git', [...git, 'add', 'README.md']);
  execFileSync('git', [...git, 'commit', '-q', '-m', 'init']);
  return cwd;
}

function approveRepo(cwd, branch) {
  const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const path = briefFile(common, branch, 'md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, BRIEF);
  writeFileSync(briefFile(common, branch, 'approved.json'), approvalRecord(parseBrief(BRIEF), 1));
  return path;
}

function pre(cwd, command, tool, id) {
  return handle({
    hook_event_name: 'PreToolUse', session_id: id, cwd, tool_name: tool, tool_input: { command },
  }, agent);
}

test('a shell write is denied until the brief is approved, and git log is not', () => {
  const prev = process.env.SESSION_RAIL_HEADLESS;
  delete process.env.SESSION_RAIL_HEADLESS;
  const cwd = initRepo('feature/x');
  const id = `shell-${process.pid}-${Date.now()}`;
  try {
    const denied = pre(cwd, 'cat > src/a.ts', 'run_terminal_command', id);
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.reason, editReason(readBrief(cwd), join(cwd, 'src/a.ts')));
    const tee = pre(cwd, 'tee src/a.ts', 'Bash', `${id}-tee`);
    assert.equal(tee.decision, 'deny');
    assert.match(tee.reason, /wait for the session brief/);
    const logged = pre(cwd, 'git log', 'run_terminal_command', `${id}-log`);
    assert.notEqual(logged?.decision, 'deny');
    const act = JSON.parse(readFileSync(join(homedir(), '.claude', 'session-rail', 'activity', `${id}.json`), 'utf8'));
    const story = buildStory({ gate: act.gate, now: Date.now() });
    assert.equal(story.banner.kind, 'held');
    assert.match(story.banner.text, /brief stopped run_terminal_command/);
    assert.match(story.banner.text, /a\.ts/);

    approveRepo(cwd, 'feature/x');
    const allowed = pre(cwd, 'cat > src/a.ts', 'run_terminal_command', `${id}-ok`);
    assert.notEqual(allowed?.decision, 'deny');
    const merge = pre(cwd, 'gh pr merge 25 --merge', 'run_terminal_command', `${id}-merge`);
    assert.equal(merge.decision, 'deny');
    assert.match(merge.reason, /merge after a final review/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SESSION_RAIL_HEADLESS;
    else process.env.SESSION_RAIL_HEADLESS = prev;
  }
});

test('on main a shell write in the repo is denied, the brief file can be written, and its approval file cannot', () => {
  const prev = process.env.SESSION_RAIL_HEADLESS;
  delete process.env.SESSION_RAIL_HEADLESS;
  const cwd = initRepo('main');
  const id = `shell-main-${process.pid}-${Date.now()}`;
  try {
    const denied = pre(cwd, 'echo hi > src/a.ts', 'Bash', id);
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason, /No brief for main/);
    assert.match(denied.reason, /Plan tab/);
    const outside = pre(cwd, 'echo hi > /tmp/plan.md', 'Bash', `${id}-out`);
    assert.notEqual(outside?.decision, 'deny');
    const logged = pre(cwd, 'git log', 'Bash', `${id}-log`);
    assert.notEqual(logged?.decision, 'deny');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SESSION_RAIL_HEADLESS;
    else process.env.SESSION_RAIL_HEADLESS = prev;
  }

  const feature = initRepo('feature/x');
  const fid = `shell-brief-${process.pid}-${Date.now()}`;
  try {
    const common = execFileSync('git', ['-C', feature, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    const briefPath = briefFile(common, 'feature/x', 'md');
    const approved = briefFile(common, 'feature/x', 'approved.json');
    const wrote = pre(feature, `cat > ${briefPath}`, 'run_terminal_command', fid);
    assert.notEqual(wrote?.decision, 'deny');
    const blocked = pre(feature, `echo '{}' > ${approved}`, 'run_terminal_command', `${fid}-no`);
    assert.equal(blocked.decision, 'deny');
    assert.match(blocked.reason, /only the person approves/);
  } finally {
    rmSync(feature, { recursive: true, force: true });
  }
});

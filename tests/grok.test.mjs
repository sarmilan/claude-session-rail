import assert from 'node:assert/strict';
import test from 'node:test';
import { callFinished, callStarted, fresh, turnEnded, turnStarted } from '../bin/activity.mjs';
import { editReason, slashCommand } from '../bin/grok-hook.mjs';
import { C, fg, paneBgOff, paneBgOn, usePalette } from '../bin/term.mjs';
import { connectorsFrom, contextFrom, rowFromActive, usageFromBilling } from '../bin/sources.mjs';
import { goAhead, startWanted, step } from '../bin/grok-watch.mjs';

const brief = {
  branch: 'feature/x', path: '/repo/.git/session-rail/briefs/x.md',
  approvedPath: '/repo/.git/session-rail/briefs/x.approved.json', dir: '/repo/.git/session-rail/',
  text: null, approval: null,
};

test('edits under the brief dir and an empty brief are told apart', () => {
  assert.equal(editReason(null, '/repo/a.js'), null);
  assert.match(editReason(brief, brief.approvedPath), /only the person approves/);
  assert.equal(editReason(brief, '/repo/.git/session-rail/briefs/x.md'), null);
  assert.match(editReason(brief, '/repo/a.js'), /wait for the session brief/);
  assert.equal(editReason({ ...brief, approval: { approvedAt: 1 } }, '/repo/a.js'), null);
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

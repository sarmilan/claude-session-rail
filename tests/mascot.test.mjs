import assert from 'node:assert/strict';
import test from 'node:test';
import { attentionFor, createMascot, doneFor, droopFor, flinchAt, progressFor, stageFor, visitorsFor } from '../bin/mascot.mjs';

const brief = (status, chunks) => ({ status, chunks });
const chunk = (done) => ({ done: done ? 'built' : '' });

test('stage and progress follow the brief', () => {
  assert.equal(stageFor(null), 0);
  assert.equal(stageFor(brief('ready', [chunk(false), chunk(false)])), 0);
  assert.equal(stageFor(brief('approved', [chunk(false), chunk(false)])), 1);
  assert.equal(stageFor(brief('approved', [chunk(true), chunk(false)])), 2);
  assert.equal(stageFor(brief('changed', [chunk(true), chunk(true)])), 3);
  assert.equal(progressFor(null), null);
  assert.equal(progressFor(brief('ready', [chunk(false)])), 0);
  assert.equal(progressFor(brief('approved', [chunk(true), chunk(false)])), 0.5);
  assert.deepEqual(doneFor(brief('approved', [chunk(true), chunk(false), chunk(true)])), { done: 2, total: 3 });
  assert.deepEqual(doneFor(brief('draft', [chunk(true)])), { done: 0, total: 1 });
});

test('waiting fidgets toward the agent and does not sleep', () => {
  const pet = createMascot({ now: 0 });
  pet.step(40, 'waiting', 0);
  assert.equal(pet.state.mode, 'wait');
  assert.equal(pet.state.dir, -1);
  assert.equal(pet.state.fidget, true);
  const x = pet.state.x;
  pet.step(40, 'waiting', 120_000);
  assert.equal(pet.state.mode, 'wait');
  assert.equal(pet.state.x, x);
});

test('idle sleeps, and waking stretches', () => {
  const pet = createMascot({ now: 0 });
  pet.step(40, 'idle', 70_000);
  assert.equal(pet.state.mode, 'sleep');
  pet.step(40, 'busy', 70_000);
  assert.equal(pet.state.mode, 'busy');
  assert.ok(pet.state.wake > 0 || pet.state.fidget);
  assert.ok(pet.state.party);
});

test('an unapproved brief holds the pet still', () => {
  const pet = createMascot({ now: 0 });
  pet.setHeld(true);
  const x = pet.state.x;
  for (let i = 0; i < 20; i++) pet.step(40, 'busy', 1000 + i);
  assert.equal(pet.state.x, x);
  assert.equal(pet.state.phase, 0);
});

test('a failure droops and scatters visitors until it is cleared', () => {
  const pet = createMascot({ now: 0 });
  pet.setVisitors([{ id: 'a', colour: 80 }, { id: 'b', colour: 141 }], 40);
  for (let i = 0; i < 40; i++) pet.step(40, 'idle', i * 200);
  pet.flinch(10_000);
  assert.equal(pet.state.droop, true);
  const before = pet.state.x;
  pet.step(40, 'idle', 10_200);
  assert.notEqual(pet.render(40, 10_200).lines.join(''), '');
  pet.setDroop(false);
  assert.equal(pet.state.droop, false);
  assert.equal(typeof before, 'number');
});

test('a finished chunk celebrates, and extra helpers are counted', () => {
  const pet = createMascot({ now: 0 });
  pet.setStage(2);
  pet.setTrail(2, 4);
  pet.celebrate(5_000);
  assert.ok(pet.state.spark > 5_000);
  pet.step(40, 'idle', 5_000);
  assert.ok(pet.state.lift > 0);
  pet.setVisitors(Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, colour: 80 })), 40);
  pet.setCompanions(5);
  assert.equal(pet.state.overflow, 2);
  assert.equal(pet.state.shells, 2);
  const frame = pet.render(42, 5_000);
  assert.equal(frame.lines.length, pet.rows);
  assert.ok(frame.lines.every((l) => l.length >= 42));
});

const claude = (over) => ({
  claude: { state: 'waiting', since: 1_000 },
  running: [], recent: [], agents: {}, ...over,
});

test('Claude: a session file that still says busy does not hide waiting', () => {
  const session = { status: 'busy', statusSince: 1_000 };
  const waiting = claude({});
  assert.equal(attentionFor({ activity: waiting, session, now: 5_000 }), 'waiting');
  assert.equal(attentionFor({ activity: claude({ claude: { state: 'thinking', since: 4_000 } }), session, now: 5_000 }), 'busy');
  assert.equal(attentionFor({ activity: waiting, tasks: [{ id: 'sh', kind: 'shell' }], session, now: 5_000 }), 'busy');
  assert.equal(attentionFor({ activity: null, session, now: 5_000 }), 'busy');
  assert.equal(attentionFor({ activity: null, session: { status: 'idle', statusSince: 4_000 }, now: 5_000 }), 'waiting');
  assert.equal(attentionFor({ activity: claude({ claude: { state: 'waiting', since: 1_000 } }), session, now: 1_000 + 2 * 60 * 60 * 1000 }), 'idle');
  // The turn ended, and a background subagent is still in the feed. Its task file may not be indexed yet.
  const background = claude({ agents: { ag: { name: 'Bo', colour: 141, what: 'tests', since: 1, background: true } } });
  assert.equal(attentionFor({ activity: background, session, now: 5_000 }), 'busy');
  const ended = claude({ agents: { ag: { name: 'Bo', colour: 141, what: 'tests', since: 1, background: true, endedAt: 4_000 } } });
  assert.equal(attentionFor({ activity: ended, session, now: 5_000 }), 'waiting');
});

test('Claude: a subagent with a name, a call and a task file is one flier', () => {
  const activity = claude({
    claude: { state: 'tool', since: 1 },
    running: [
      { id: 'c1', tool: 'Agent', arg: 'explore', since: 1 },
      { id: 'c2', tool: 'Task', arg: 'review', since: 2 },
      { id: 'c3', tool: 'Read', arg: 'a.js', since: 3, agent: 'ag1' },
    ],
    agents: {
      ag1: { name: 'Ada', colour: 80, what: 'explore', since: 1, background: false },
      ag2: { name: 'Bo', colour: 141, what: 'tests', since: 2, background: true },
      old: { name: 'Cy', colour: 75, what: 'done', since: 0, background: false, endedAt: 9 },
    },
  });
  const tasks = [
    { id: 'ag1', kind: 'agent' },
    { id: 'ag2', kind: 'agent' },
    { id: 'sh', kind: 'shell' },
    { id: 'loose', kind: 'agent' },
  ];
  const visitors = visitorsFor(activity, tasks);
  assert.deepEqual(visitors.map((v) => v.id), ['ag1', 'ag2', 'c2', 'task:loose']);
  assert.equal(visitors.find((v) => v.id === 'ag1').colour, 80);
  assert.equal(visitors.find((v) => v.id === 'ag2').colour, 141);
  assert.equal(visitors.find((v) => v.id === 'c2').colour, null);
});

test('Claude: the brief gate is not a droop, and a failed Bash is', () => {
  const gate = { at: 100, tool: 'Edit', file: 'a.js' };
  assert.equal(droopFor(claude({ recent: [{ tool: 'Edit', ok: false, at: 100 }], gate })), false);
  assert.equal(droopFor(claude({ recent: [{ tool: 'Bash', ok: false, at: 200 }, { tool: 'Edit', ok: false, at: 100 }], gate })), true);
  assert.equal(droopFor(claude({ recent: [{ tool: 'Bash', ok: true, at: 300 }, { tool: 'Bash', ok: false, at: 200 }] })), false);
  const held = { at: 150, tool: 'Edit', file: 'a.js' };
  assert.equal(flinchAt(claude({ recent: [{ tool: 'Edit', ok: false, at: 150 }, { tool: 'Bash', ok: false, at: 100 }], gate: held }), 0), 100);
  assert.equal(flinchAt(claude({ recent: [{ tool: 'Edit', ok: false, at: 150 }], gate: held }), 0), 0);
  assert.equal(flinchAt(claude({ recent: [{ tool: 'Bash', ok: false, at: 100, agent: 'ag1' }] }), 100), 0);
});

test('every creature renders each stage, awake and fidgeting', () => {
  for (const creature of [0, 1, 2]) {
    const pet = createMascot({ creature, now: 0 });
    for (const stage of [0, 1, 2, 3]) {
      pet.setStage(stage);
      pet.step(42, 'waiting', 1000);
      const frame = pet.render(42, 1000);
      assert.equal(frame.lines.length, pet.rows);
      pet.step(42, 'idle', 1000);
      pet.render(42, 1000);
    }
  }
});

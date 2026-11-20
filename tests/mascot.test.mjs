import assert from 'node:assert/strict';
import test from 'node:test';
import { attentionFor, briefHolds, createMascot, doneFor, droopFor, flinchAt, heldAnchor, progressFor, stageFor, visitorsFor } from '../bin/mascot.mjs';
import { bangBright, buildingOf, heldPhase, latchContext, markKind, queryMotion, reactionHint, stompArc } from '../bin/petreact.mjs';
import { CREATURES, applyBuilding } from '../bin/creatures.mjs';

const brief = (status, chunks) => ({ status, chunks });
const chunk = (done) => ({ done: done ? 'built' : '' });

test('stage and progress follow the brief', () => {
  assert.equal(stageFor(null), 0);
  assert.equal(stageFor(brief('ready', [chunk(false), chunk(false)])), 0);
  assert.equal(stageFor(brief('approved', [chunk(false), chunk(false)])), 1);
  assert.equal(stageFor(brief('approved', [chunk(true), chunk(false)])), 2);
  assert.equal(stageFor(brief('changed', [chunk(true), chunk(true)])), 3);
  assert.equal(progressFor(null), null);
  assert.equal(stageFor(null, 3), 0);
  assert.equal(stageFor(null, 12), 1);
  assert.equal(stageFor(null, 33), 2);
  assert.equal(stageFor(brief('ready', [chunk(false)]), 90), 0);
  assert.equal(stageFor(null, 100), 2); // a full window stays adult
  assert.equal(stageFor(brief('approved', [chunk(true), chunk(false)]), 100), 2);
  assert.equal(stageFor(brief('changed', [chunk(true), chunk(true)]), 40), 3);
  assert.equal(briefHolds('changed'), false);
  assert.equal(briefHolds('approved'), false);
  assert.equal(briefHolds('draft'), true);
  assert.equal(briefHolds('ready'), true);
  assert.equal(briefHolds(undefined), false);
  assert.equal(progressFor(null, 33), 0.33);
  assert.equal(progressFor(brief('ready', [chunk(false)]), 90), 0);
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
  for (let i = 0; i < 6; i++) pet.step(40, 'idle', 800 + i); // the stage-up pop finishes first
  assert.equal(pet.state.grow, null);
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
  const shellGate = { at: 200, tool: 'Bash', file: '/repo/src/a.ts' };
  assert.equal(droopFor(claude({ recent: [{ tool: 'Bash', ok: false, at: 200 }], gate: shellGate })), false);
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

// Blue (75) is only the prompt cache: the hourglass, the snowflake and the warm compact's swirl.
const blue = (out) => out.lines.join('').includes('38;5;75m');
const look = (pet, mood, t) => { pet.step(40, mood, t); return pet.render(40, t); };
test('the cache: an hourglass in its last stretch, a snowflake and a shiver once cold, a swirl after a warm compact', () => {
  const pet = createMascot({ now: 0 });
  pet.step(40, 'waiting', 0);
  assert.equal(blue(look(pet, 'waiting', 200)), false);
  pet.setCache('low');
  assert.equal(pet.state.cache, 'low');
  assert.equal(blue(look(pet, 'waiting', 400)), true);
  assert.equal(pet.state.shake, 0);
  pet.setCache('cold');
  assert.equal(pet.state.shake, 4); // it shivers once going cold
  assert.equal(blue(look(pet, 'waiting', 600)), true);
  pet.setCache('cold');
  pet.setCache(null);
  assert.equal(blue(look(pet, 'waiting', 800)), false);
  pet.swirl(1000);
  assert.equal(pet.state.swirl, 1000 + 1600);
  assert.equal(blue(look(pet, 'waiting', 1100)), true);
  assert.equal(blue(look(pet, 'waiting', 3000)), false); // the swirl is gone
});

test('no creature draws in the cache blue itself', () => {
  for (let i = 0; i < 3; i++) assert.equal(blue(look(createMascot({ now: 0, creature: i }), 'waiting', 0)), false);
});

test('asleep, a cold cache shows the snowflake in place of the Zs', () => {
  const pet = createMascot({ now: 0 });
  for (let t = 0; t < 70_000; t += 5_000) pet.step(40, 'idle', t);
  assert.equal(pet.state.mode, 'sleep');
  assert.equal(blue(look(pet, 'idle', 75_000)), false);
  pet.setCache('cold');
  pet.step(40, 'idle', 80_000);
  const out = pet.render(40, 80_000);
  assert.equal(pet.state.mode, 'sleep');
  assert.equal(blue(out), true);
});

test('clearing a finished worktree hops without a new mark, and wakes a sleeper', () => {
  const pet = createMascot({ now: 0 });
  for (let t = 0; t < 70_000; t += 5_000) pet.step(40, 'idle', t);
  assert.equal(pet.state.mode, 'sleep');
  const stage = pet.stage;
  pet.tidy(80_000);
  assert.equal(pet.state.mode, 'walk');
  assert.equal(pet.stage, stage);
  assert.ok(pet.state.lift > 0);
  assert.equal(pet.state.spark, 0);
  assert.equal(pet.state.swirl, 0);
});

const settle = (pet, t0 = 1_000) => { for (let i = 0; i < 6; i++) pet.step(40, 'idle', t0 + i * 200); };
const pngSize = (frame) => {
  const b64 = frame.image.data.slice(frame.image.data.lastIndexOf(':') + 1).replace(/\x07$/, '');
  const buf = Buffer.from(b64, 'base64');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
};

test('context latch: [!!!] 84 off, 85 on, 82 still on, 79 off; brow 50/45', () => {
  let s = { bang: false, brow: false, pct: null };
  s = latchContext(s, 84);
  assert.equal(s.bang, false);
  assert.equal(buildingOf(s), 'stomp');
  s = latchContext(s, 85);
  assert.equal(s.bang, true);
  assert.equal(buildingOf(s), 'bulk');
  s = latchContext(s, 82);
  assert.equal(s.bang, true);
  assert.equal(buildingOf(s), 'stomp');
  s = latchContext(s, 79);
  assert.equal(s.bang, false);
  assert.equal(buildingOf(s), 'brow');
  s = latchContext(s, 46);
  assert.equal(buildingOf(s), 'brow');
  s = latchContext(s, 44);
  assert.equal(buildingOf(s), 'none');
  s = latchContext(s, 49);
  assert.equal(buildingOf(s), 'none');
  s = latchContext(s, 50);
  assert.equal(buildingOf(s), 'brow');
  const kept = latchContext(s, null);
  assert.equal(kept.bang, s.bang);
  assert.equal(kept.brow, true);
});

test('mark priority: sleep, puff, pop, ?, droop, spark, [!!!], cache, gold; swirl hides [!!!]', () => {
  assert.equal(markKind({ sleep: true, cold: true, puff: true, bang: true }), 'frost');
  assert.equal(markKind({ sleep: true, puff: true }), null);
  assert.equal(markKind({ puff: true, grow: true, held: true, bang: true }), 'puff');
  assert.equal(markKind({ grow: true, held: true, bang: true, ready: true }), 'grow');
  assert.equal(markKind({ shrink: true, held: true, bang: true }), 'shrink');
  assert.equal(markKind({ held: true, droop: true, bang: true, ready: true }), 'query');
  assert.equal(markKind({ droop: true, bang: true, ready: true }), 'droop');
  assert.equal(markKind({ spark: true, bang: true, ready: true }), 'spark');
  assert.equal(markKind({ bang: true, swirl: true, ready: true }), 'swirl');
  assert.equal(markKind({ bang: true, low: true, ready: true }), 'bang');
  assert.equal(markKind({ low: true, ready: true }), 'hourglass');
  assert.equal(markKind({ ready: true }), 'ready');
  assert.equal(markKind({ swirl: true }), 'swirl');
  assert.equal(markKind({}), null);
});

test('the held ? grows, then vanishes, and waiting with no brief never shows one', () => {
  assert.equal(heldPhase(0, false), 'quiet');
  assert.equal(heldPhase(7_999, false), 'quiet');
  assert.equal(heldPhase(8_000, false), 'annoy');
  assert.equal(heldPhase(11_999, false), 'annoy');
  assert.equal(heldPhase(12_000, false), 'pushy');
  assert.equal(heldPhase(1_000, true), 'release');
  assert.equal(queryMotion('quiet', 1_000, 0, 0).mul, 1);
  assert.ok(queryMotion('annoy', 10_000, 0, 0).mul > 1 && queryMotion('annoy', 10_000, 0, 0).mul < 2);
  assert.equal(queryMotion('pushy', 13_000, 0, 0).mul, 2);
  assert.equal(queryMotion('pushy', 13_000, 0, 0).glow, true);
  assert.ok(queryMotion('release', 13_000, 0, 2).mul < 0.2);
  assert.equal(heldAnchor(10_000, 2_000), 2_000);
  assert.equal(heldAnchor(2_000, 10_000), 2_000);
  assert.equal(reactionHint({ held: true, bang: true, pct: 90 }), 'brief waiting for approval');
  assert.match(reactionHint({ bang: true, pct: 91 }), /91%/);
  assert.equal(reactionHint({ building: 'brow', pct: 55 }), null);

  const pet = createMascot({ now: 0 });
  pet.step(40, 'waiting', 1_000);
  assert.equal(pet.state.mark, null);
  assert.equal(pet.render(40, 1_000).lines.join('').includes('?'), false);
  pet.setHeld(true, 10_000);
  pet.setHeld(true, 1_000); // a gate refusal earlier than we noticed
  pet.step(40, 'busy', 10_000);
  assert.equal(pet.state.heldPhase, 'annoy');
  assert.equal(pet.state.mark, 'query');
  pet.step(40, 'busy', 14_000);
  assert.equal(pet.state.heldPhase, 'pushy');
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const pushy = plain(pet.render(30, 14_000).lines.join(''));
  assert.ok(pushy.includes('??'));
  pet.setHeld(false, 15_000);
  pet.step(40, 'waiting', 15_200);
  assert.equal(pet.state.heldPhase, 'release');
  assert.equal(pet.state.mark, 'query');
  for (let i = 0; i < 3; i++) pet.step(40, 'waiting', 15_400 + i * 200);
  assert.equal(pet.state.held, false);
  assert.equal(pet.state.mark, null);
  assert.equal(pet.state.mode, 'wait');
});

test('a stage-up pops once at the final stage and skips the Done sparkle; a compact shrinks, then swirls', () => {
  const pet = createMascot({ now: 0 });
  pet.setStage(1);
  pet.setStage(2); // two ups in the same moment: one pop, on the adult
  assert.equal(pet.stage, 2);
  assert.equal(pet.state.grow, 'up');
  pet.celebrate(2_000);
  assert.equal(pet.state.spark, 0);
  assert.equal(pet.state.mark, 'grow');
  assert.ok(pet.render(30, 2_000).lines.join('').includes('*'));
  settle(pet, 2_000);
  assert.equal(pet.state.grow, null);
  assert.equal(pet.stage, 2);
  pet.setContextPct(92);
  assert.equal(pet.state.bang, true);
  pet.setContextPct(10); // the window dropped; [!!!] ends before the shrink
  assert.equal(pet.state.bang, false);
  pet.setStage(0);
  assert.equal(pet.stage, 2);
  assert.equal(pet.state.mark, 'shrink');
  pet.swirl(8_000);
  assert.equal(pet.state.swirl, 0);
  for (let i = 0; i < 5; i++) pet.step(40, 'waiting', 8_000 + i * 200);
  assert.equal(pet.stage, 0);
  assert.ok(pet.state.swirl > 8_000);
  assert.equal(pet.state.mark, 'swirl');
});

test('brief-heavy at 40% is gold READY; an adult at 90% is [!!!] and bulk, and stays adult', () => {
  const heavy = createMascot({ now: 0 });
  heavy.setStage(3);
  settle(heavy);
  heavy.setContextPct(40);
  assert.equal(heavy.stage, 3);
  assert.equal(heavy.state.bang, false);
  let ready = false;
  for (let i = 0; i < 24; i++) {
    heavy.step(40, 'idle', 4_000 + i * 200);
    if (heavy.state.mark === 'ready') ready = true;
    assert.notEqual(heavy.state.mark, 'bang');
  }
  assert.equal(ready, true);

  for (const creature of [0, 1, 2]) {
    const pet = createMascot({ creature, now: 0 });
    pet.setStage(2);
    settle(pet);
    pet.setContextPct(90);
    assert.equal(pet.stage, 2);
    assert.equal(pet.state.building, 'bulk');
    assert.equal(pet.state.bang, true);
    let bang = false, gold = false;
    for (let i = 0; i < 6; i++) {
      pet.step(26, 'waiting', 6_000 + i * 200);
      const text = pet.render(26, 6_000 + i * 200).lines.join('');
      assert.equal(text.includes('undefined'), false);
      if (text.includes('!')) bang = true;
      if (text.includes('38;5;220m')) gold = true;
      assert.equal(pet.state.mark, 'bang');
    }
    assert.equal(bang, true);
    assert.equal(gold, false);
  }
});

test('each pet stomps in its own way, and a high-context wait stays in place', () => {
  assert.deepEqual(stompArc('turtle', 82).slice(0, 4), [1, 2, 3, 3]);
  assert.ok(Math.max(...stompArc('turtle', 92)) >= 4);
  assert.ok(Math.max(...stompArc('snail', 92)) <= 2);
  assert.ok(Math.min(...stompArc('crab', 82)) < 0);
  const names = ['snail', 'turtle', 'crab'];
  for (const creature of [0, 1, 2]) {
    const pet = createMascot({ creature, now: 0 });
    pet.setStage(2);
    settle(pet);
    pet.setContextPct(82);
    pet.step(40, 'waiting', 5_000);
    const x = pet.state.x;
    let extreme = 0;
    for (let i = 0; i < 24; i++) {
      pet.step(40, 'waiting', 5_200 + i * 200);
      extreme = creature === 2 ? Math.min(extreme, pet.state.lift) : Math.max(extreme, pet.state.lift);
      assert.equal(pet.state.x, x);
      assert.equal(pet.state.fidget, false);
      if (creature === 2) assert.equal(pet.state.dir, 1);
      else assert.equal(pet.state.dir, -1);
    }
    if (creature === 2) assert.ok(extreme < 0, names[creature]);
    else assert.ok(extreme > 0, names[creature]);
    if (creature === 0) assert.ok(extreme <= 2, 'snail bounce');
    if (creature === 1) assert.ok(extreme >= 3, 'turtle hop');
  }
});

test('snail stalks look up, and context-bulk is not a gold crown', () => {
  const pose = { frame: 0, blink: false, sleep: false, fidget: false };
  const hatch = CREATURES[0].stages[0];
  assert.notEqual(hatch.draw(pose).join(''), hatch.draw({ ...pose, lookUp: true }).join(''));
  const adult = CREATURES[0].stages[1];
  assert.notEqual(adult.draw(pose).join(''), adult.draw({ ...pose, lookUp: true }).join(''));
  for (const kind of ['snail', 'turtle', 'crab']) {
    const drawn = CREATURES[kind === 'snail' ? 0 : kind === 'turtle' ? 1 : 2].stages[2]
      .draw({ frame: 1, blink: false, sleep: false });
    const bulk = applyBuilding(drawn, 'bulk', kind);
    assert.notEqual(drawn.join(''), bulk.join(''));
    assert.equal(bulk.some((row) => row.includes('G')), false);
  }
  const crab = CREATURES[2].stages[2].draw({ frame: 0, blink: false, sleep: false, snap: true });
  const shut = CREATURES[2].stages[2].draw({ frame: 0, blink: false, sleep: false, snap: false });
  assert.notEqual(crab.join(''), shut.join(''));
});

test('reactions fit a W=26 strip: image mode uses 3 or 4 rows, octant glyphs stay readable', () => {
  assert.equal(bangBright(0, 90), true);
  assert.equal(bangBright(2, 90), false);
  assert.equal(bangBright(3, 85), false); // dim half of the 3-and-3 pulse
  for (const creature of [0, 1, 2]) {
    const text = createMascot({ creature, now: 0 });
    text.setStage(2);
    settle(text);
    text.setHeld(true, 0);
    const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    let quiet = text.render(26, 1_000);
    for (let i = 0; i < 8 && !plain(quiet.lines.join('')).includes('?'); i++) {
      text.step(26, 'busy', 1_000 + i * 200);
      quiet = text.render(26, 1_000 + i * 200);
    }
    const shown = plain(quiet.lines.join(''));
    assert.equal(quiet.lines.length, text.rows);
    assert.ok(shown.includes('?'));
    assert.equal(shown.includes('??'), false);
    const picture = createMascot({ images: true, creature, now: 0 });
    picture.setCellAspect(0.5);
    picture.setStage(2);
    settle(picture);
    picture.setContextPct(55);
    picture.step(26, 'busy', 4_000);
    const brow = picture.render(26, 4_000);
    assert.equal(picture.rows, 3);
    assert.equal(brow.lines.length, 3);
    assert.equal(pngSize(brow).h, 3 * 34);
    picture.setContextPct(90);
    picture.step(26, 'waiting', 5_000);
    const bang = picture.render(26, 5_000);
    assert.equal(picture.state.mark, 'bang');
    assert.equal(picture.rows, 4);
    assert.equal(pngSize(bang).h, 4 * 34);
    picture.setContextPct(10);
    picture.setHeld(true, 0);
    const annoy = picture.render(26, 9_000);
    assert.equal(picture.state.heldPhase, 'annoy');
    assert.equal(picture.rows, 4);
    assert.equal(annoy.lines.length, picture.rows);
    picture.setStage(1); // down from adult: shrink wants the fourth row too
    const shrink = picture.render(26, 10_200);
    assert.equal(picture.state.mark, 'shrink'); // shrink outranks the ?
    assert.equal(pngSize(shrink).h, 4 * 34);
  }
});

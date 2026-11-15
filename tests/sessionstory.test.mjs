import assert from 'node:assert/strict';
import test from 'node:test';
import { width } from '../bin/term.mjs';
import {
  buildStory, chaptersFrom, eventsFromRecord, humanAsk, layoutStory, mergeAgents, mergeEvents, splitAsk,
} from '../bin/sessionstory.mjs';

const text = (parts) => (parts ?? []).map((p) => p.text).join('');
const line = (row, inner = 42) => {
  const left = text(row.left);
  const right = text(row.right);
  const gap = Math.max(right ? 1 : 0, inner - width(left) - width(right));
  return left + ' '.repeat(gap) + right;
};
const viewOf = (story, open = {}, inner = 42) => layoutStory(story, { inner, open });
const joined = (view, inner = 42) => [text(view.banner), ...view.rows.map((r) => line(r, inner))];

const agent = (id, extra = {}) => ({ id, name: id, what: '', prompt: '', reply: '', since: 1, ...extra });

test('the banner names the one live agent and the ask it was given', () => {
  const story = buildStory({
    host: 'Grok', now: 10_000,
    claude: { state: 'thinking', since: 9_000 },
    agents: { a: { name: 'Wren', colour: 80, what: 'how names get picked', since: 9_000, background: false } },
  });
  assert.equal(text(viewOf(story).banner), '▌ Now  Wren · how names get picked');
});

test('two live agents share the banner, and a child hangs under the agent that asked it', () => {
  const story = buildStory({
    host: 'Grok', now: 20_000,
    claude: { state: 'tool', since: 9_000 },
    agents: [
      agent('otto', { name: 'Otto', what: 'run the tests', since: 1_000 }),
      agent('wren', { name: 'Wren', what: 'how names get picked', parent: 'otto', since: 2_000 }),
    ],
  });
  assert.equal(text(viewOf(story).banner), '▌ Now  Otto and Wren');
  const rows = joined(viewOf(story, { 'who:wren': true }), 64);
  const wren = rows.find((r) => r.includes('◆ Wren'));
  const otto = rows.find((r) => r.includes('◆ Otto'));
  assert.match(otto, /^ {2}└/);
  assert.match(wren, /^ {4}└/);
  assert.match(rows.join('\n'), /asked +how names get picked/);
});

test('the latest reply sits under the host, and there is no Story heading', () => {
  const story = buildStory({
    host: 'Grok', now: 5_000, claude: { state: 'waiting', since: 1_000 },
    events: [
      { kind: 'you', text: 'how is the pet growing' },
      { kind: 'main', text: 'It stays a hatchling until the brief is approved.' },
    ],
  });
  const rows = joined(viewOf(story));
  const body = rows.join('\n');
  const host = rows.find((r) => r.includes('● Grok'));
  assert.doesNotMatch(body, /^Story$/m);
  assert.doesNotMatch(host, /waiting/);
  assert.match(body, /It stays a hatchling/);
  assert.equal(body.split('\n').filter((r) => r.includes('It stays a hatchling')).length, 1);
});

test('a quiet turn says it is waiting, and a file read says what is being read', () => {
  const waiting = buildStory({ host: 'Claude', now: 5_000, claude: { state: 'waiting', since: 1_000 } });
  assert.equal(text(viewOf(waiting).banner), '▌ Now  waiting for you');
  const reading = buildStory({
    host: 'Grok', now: 5_000, claude: { state: 'tool', since: 4_000 },
    running: [{ id: 'c', tool: 'read_file', arg: '/repo/bin/rail.mjs', since: 4_000 }],
  });
  assert.equal(text(viewOf(reading).banner), '▌ Now  reading rail.mjs');
});

test('the brief stopping an edit holds the banner', () => {
  const story = buildStory({
    host: 'Grok', now: 10_000, claude: { state: 'waiting', since: 1 },
    gate: { at: 9_000, tool: 'Write', file: '/repo/bin/rail.mjs' },
  });
  assert.equal(text(viewOf(story).banner), '▌ Held  brief stopped Write rail.mjs');
});

test('a chapter keeps why the work was handed off, the prompt, and what came back', () => {
  const prompt = 'Read rail.mjs and say what the session tab shows the person';
  const story = buildStory({
    host: 'Grok', now: 100_000,
    claude: { state: 'waiting', since: 90_000 },
    events: [
      { kind: 'you', text: 'bring the git attitude to sessions' },
      { kind: 'main', text: 'I will look at the session tab first' },
      { kind: 'handoff', what: 'how the tab is drawn', prompt, name: 'Wren' },
      { kind: 'main', text: 'The tab lists tools. It does not show the ask.' },
      { kind: 'you', text: 'show me the prompt' },
    ],
    fileAgents: [agent('a1', { name: 'Wren', what: 'how the tab is drawn', prompt, reply: 'The session tab lists tool calls.', since: 50, endedAt: 80 })],
  });
  const open = { 'you:0': true, 'past:a1': true };
  const rows = joined(viewOf(story, open, 96), 96);
  const body = rows.join('\n');
  assert.match(rows[0], /waiting for you/);
  assert.match(body, /show me the prompt/);
  assert.match(body, /bring the git attitude/);
  assert.match(body, /why +I will look at the session tab first/);
  assert.match(body, /prompt +Read rail\.mjs/);
  assert.match(body, /said +The session tab lists tool calls/);
  assert.match(body, /The tab lists tools/);
  assert.equal(body.split('\n').filter((r) => r.includes('The tab lists tools')).length, 1);
  const chapter = story.chapters.find((c) => c.you === 'show me the prompt');
  assert.equal(chapter.handoffs.length, 0);
});

test('a finished subagent stays in the list with the task it was given', () => {
  const story = buildStory({
    host: 'Grok', now: 200_000_000_000,
    agents: { live: { name: 'Wren', what: 'find the callers', since: 190_000_000_000 } },
    fileAgents: [
      agent('otto', { name: 'Otto', what: 'run the tests', since: 150_000_000_000, endedAt: 160_000_000_000 }),
      agent('ada', { name: 'Ada', what: 'explore the hooks', since: 100_000_000_000, endedAt: 110_000_000_000 }),
    ],
  });
  const body = joined(viewOf(story, { 'past:otto': true }, 64), 64).join('\n');
  assert.match(body, /◆ Wren/);
  assert.match(body, /◆ Otto {2}run the tests/);
  assert.match(body, /◆ Ada {2}explore the hooks/);
  assert.ok(body.indexOf('◆ Otto') < body.indexOf('◆ Ada'));
  assert.match(body, /asked +run the tests/);
  assert.ok(body.indexOf('◆ Wren') < body.indexOf('◆ Otto'));
});

test('a handoff stays in the chapter it was asked in', () => {
  const events = [
    { kind: 'you', text: 'first' },
    { kind: 'handoff', what: 'read the hooks', prompt: 'Read the hooks and say how a name is picked' },
    { kind: 'you', text: 'second' },
  ];
  const chapters = chaptersFrom(mergeEvents(events, []), [agent('a', { name: 'Wren', what: 'read the hooks', reply: 'from names.mjs' })]);
  assert.equal(chapters[0].you, 'second');
  assert.equal(chapters[1].you, 'first');
  assert.equal(chapters[1].handoffs[0].name, 'Wren');
  assert.equal(chapters[0].handoffs.length, 0);
});

test('the same ask from the file and the live feed is one agent, and a repeat of the last line is dropped', () => {
  const prompt = 'Read the hooks and explain the names';
  const merged = mergeAgents(
    [agent('file', { name: 'Wren', what: 'explain the names', prompt, reply: 'names.mjs', endedAt: 5 })],
    { live: { name: 'Wren', what: 'explain the names', prompt, since: 4, colour: 80 } },
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].reply, 'names.mjs');
  assert.equal(merged[0].endedAt, undefined);
  assert.equal(merged[0].colour, 80);
  const events = mergeEvents([{ kind: 'you', text: 'hello' }], [{ role: 'you', text: 'hello', at: 9 }]);
  assert.equal(events.length, 1);
});

test('a transcript row keeps the person\'s ask and the spawn prompt', () => {
  assert.equal(humanAsk('before <user_query>bring the attitude</user_query> after'), 'bring the attitude');
  assert.equal(humanAsk('<user_info>os</user_info><rules>x</rules>'), '');
  assert.equal(humanAsk('hello'), 'hello');
  assert.deepEqual(splitAsk('Wren: how names get picked'), { name: 'Wren', what: 'how names get picked' });
  const events = eventsFromRecord({
    type: 'assistant',
    content: 'I will ask Wren.',
    tool_calls: [{ name: 'spawn_subagent', arguments: JSON.stringify({ description: 'how the tab is drawn', prompt: 'Read rail.mjs and say what a person can learn' }) }],
  });
  assert.deepEqual(events.map((e) => e.kind), ['main', 'handoff']);
  assert.equal(events[1].prompt, 'Read rail.mjs and say what a person can learn');
  const claude = eventsFromRecord({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input: { description: 'Otto: run the tests', prompt: 'Run the plugin tests and report failures' } }] },
  });
  assert.equal(claude[0].name, 'Otto');
  assert.equal(claude[0].what, 'run the tests');
});

test('every row fits the column', () => {
  const story = buildStory({
    host: 'Grok', now: 10_000, claude: { state: 'thinking', since: 9_000 },
    agents: { a: { name: 'Wren', colour: 80, what: 'how the session tab decides what to show a person who was not watching', prompt: 'A long prompt '.repeat(40), reply: 'A long reply '.repeat(20), since: 9_000 } },
    events: [{ kind: 'you', text: 'bring the git attitude to the session tab and keep the prompt' }, { kind: 'main', text: 'I will open the handoff' }],
    running: [{ tool: 'read_file', arg: '/repo/bin/rail.mjs', since: 9_000, agent: 'a' }],
    recent: [{ tool: 'grep', arg: 'agent.spawn', ok: true, at: 8_000, agent: 'a' }],
  });
  const view = viewOf(story, { 'who:main': true, 'who:a': true, 'you:0': true }, 42);
  for (const row of [ { left: view.banner, right: [] }, ...view.rows ]) {
    assert.ok(width(text(row.left)) + (text(row.right) ? width(text(row.right)) + 1 : 0) <= 42, line(row));
  }
});

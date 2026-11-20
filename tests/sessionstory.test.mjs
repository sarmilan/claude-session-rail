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
  const view = viewOf(story, { 'who:wren': true }, 64);
  const rows = joined(view, 64);
  const wren = rows.find((r) => r.includes('└ Wren'));
  const otto = rows.find((r) => r.includes('└ Otto'));
  assert.match(otto, /^ {2}└ Otto/);
  assert.match(wren, /^ {4}└ Wren/);
  assert.doesNotMatch(rows.join('\n'), /◆|├▸|└▸/);
  assert.equal(view.rows.find((r) => text(r.left).includes('Wren')).left.find((p) => p.text === 'Wren').style, 'purple');
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
  const view = viewOf(story, { 'past:otto': true }, 64);
  const body = joined(view, 64).join('\n');
  assert.match(text(view.banner), /Wren · find the callers/);
  assert.match(body, /└ Wren/);
  assert.match(body, /◆ Otto {2}run the tests/);
  assert.match(body, /◆ Ada {2}explore the hooks/);
  assert.ok(body.indexOf('◆ Otto') < body.indexOf('◆ Ada'));
  assert.match(body, /asked +run the tests/);
  assert.ok(body.indexOf('Wren') < body.indexOf('◆ Otto'));
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

test('two subagents that share a prompt preamble stay two rows', () => {
  const head = 'You are a meticulous code reviewer. Review code and produce structured review notes in a file.';
  const merged = mergeAgents([
    agent('rue', { name: 'Rue', what: 'review the diff', prompt: `${head} Target one.` }),
    agent('sage', { name: 'Sage', what: 'review the branch', prompt: `${head} Target two.` }),
  ], {});
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((a) => a.name).sort(), ['Rue', 'Sage']);
});

test('turns already in the transcript are not a second copy of the chapter', () => {
  const events = [
    { kind: 'you', text: 'first' },
    { kind: 'main', text: 'why the handoff' },
    { kind: 'handoff', what: 'read the hooks' },
    { kind: 'main', text: 'the answer' },
    { kind: 'you', text: 'second' },
  ];
  const turns = [
    { role: 'you', text: 'first' },
    { role: 'main', text: 'the answer' },
    { role: 'you', text: 'second' },
  ];
  const merged = mergeEvents(events, turns);
  assert.equal(merged.filter((e) => e.kind === 'you').length, 2);
  assert.deepEqual(chaptersFrom(merged, []).map((c) => c.you), ['second', 'first']);
  const ahead = mergeEvents(
    [{ kind: 'you', text: 'first' }, { kind: 'main', text: 'the answer' }],
    [{ role: 'you', text: 'first' }, { role: 'main', text: 'the answer' }, { role: 'you', text: 'second' }],
  );
  assert.equal(ahead.at(-1).text, 'second');
  assert.equal(ahead.filter((e) => e.text === 'first').length, 1);
});

test('a reply cannot carry an escape sequence into the row', () => {
  const story = buildStory({
    host: 'Grok', now: 10_000,
    events: [{ kind: 'main', text: 'hello \x1b[2J\x1b]0;pwn\x07there' }],
  });
  const body = joined(viewOf(story)).join('\n');
  assert.equal(body.includes('\x1b'), false);
  assert.match(body, /hello there/);
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

test('a failed test gate is one line, and a pass is not', () => {
  const failed = buildStory({
    host: 'Claude', now: 5_000, claude: { state: 'waiting', since: 1_000 },
    tests: { at: 4_000, ok: false, command: 'npm test', detail: 'not ok' },
  });
  const rows = joined(viewOf(failed));
  assert.match(rows[1], /✗ tests failed +npm test/);
  const passed = buildStory({
    host: 'Claude', now: 5_000, claude: { state: 'waiting', since: 1_000 },
    tests: { at: 4_000, ok: true, command: 'npm test', detail: '' },
  });
  assert.equal(joined(viewOf(passed)).some((r) => r.includes('tests failed')), false);
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

const NOW = 1_700_000_000_000;
const marketing = () => buildStory({
  host: 'Claude', now: NOW,
  claude: { state: 'tool', since: NOW - 20_000 },
  agents: [
    agent('rue', { name: 'Rue', what: 'scan capture shortcuts', since: NOW - 120_000, background: true }),
    agent('wren', { name: 'Wren', what: 'keybinding helpers', since: NOW - 38_000, background: false }),
    agent('otto', { name: 'Otto', what: 'inbox store tests', since: NOW - 20_000, background: false }),
  ],
  running: [{ id: 'b', tool: 'Bash', arg: 'bun test src/inbox', since: NOW - 2_000, agent: 'otto' }],
  tasks: [{ id: 'sh', kind: 'shell', label: 'bun test src/inbox', startedAt: NOW - 12_000 }],
  events: [
    { kind: 'you', text: 'add a quick-capture inbox', at: NOW - 180_000 },
    { kind: 'main', text: 'start on chunk 2' },
    { kind: 'handoff', name: 'Wren', what: 'keybinding helpers' },
    { kind: 'handoff', name: 'Otto', what: 'inbox store tests' },
    { kind: 'main', text: 'wiring the shortcut into the capture flow' },
  ],
});

test('the Now tree matches the rail mock: banner, purple names, yellow running, Rue as a sibling', () => {
  const story = marketing();
  const view = viewOf(story, {}, 64);
  const rows = joined(view, 64);
  const body = rows.join('\n');
  assert.equal(text(view.banner), '▌ Now  Wren and Otto');
  assert.doesNotMatch(text(view.banner), /Rue/);
  const wren = view.rows.find((r) => text(r.left).includes('Wren') && r.key === 'who:wren');
  const otto = view.rows.find((r) => text(r.left).includes('Otto') && r.key === 'who:otto');
  const rue = view.rows.find((r) => r.key === 'who:rue');
  assert.equal(wren.left.find((p) => p.text === 'Wren').style, 'purple');
  assert.equal(otto.left.find((p) => p.text === 'Otto').style, 'purple');
  assert.equal(rue.left.find((p) => p.text === 'Rue').style, 'purple');
  assert.equal(wren.right[0].text, '38s');
  assert.equal(wren.right[0].style, 'dim');
  assert.equal(otto.right[0].text, 'running');
  assert.equal(otto.right[0].style, 'yellow');
  assert.match(rows.find((r) => r.includes('Wren') && r.includes('keybinding')), /^ {2}├ Wren/);
  assert.match(rows.find((r) => r.includes('Otto') && r.includes('inbox')), /^ {2}└ Otto/);
  assert.match(text(rue.left), /^▸ Rue {2}scan capture shortcuts/);
  assert.ok(body.indexOf('└ Otto') < body.indexOf('▸ Rue'));
  assert.doesNotMatch(body, /◆|├▸|└▸/);
  const shell = rows.find((r) => r.includes('bun test'));
  assert.match(shell, /^◇ bun test src\/inbox/);
  assert.doesNotMatch(shell, /└/);
});

test('a background agent parented under Claude is still drawn as a sibling', () => {
  const story = buildStory({
    host: 'Claude', now: NOW,
    agents: [
      agent('wren', { name: 'Wren', what: 'keybinding helpers', since: NOW - 38_000 }),
      agent('rue', { name: 'Rue', what: 'scan capture shortcuts', parent: 'wren', since: NOW - 120_000, background: true }),
    ],
  });
  assert.equal(text(viewOf(story).banner), '▌ Now  Wren · keybinding helpers');
  const rows = joined(viewOf(story, {}, 64), 64);
  assert.match(rows.find((r) => r.includes('Rue')), /^▸ Rue/);
  assert.doesNotMatch(rows.join('\n'), /└ Rue|├ Rue/);
});

test('an expanded you chapter draws that turn\'s handoffs, and a collapsed one stays one line', () => {
  const story = marketing();
  const closed = joined(viewOf(story));
  const you = closed.find((r) => r.includes('you  add a quick-capture inbox'));
  assert.match(you, /^▸ you/);
  const youAt = closed.indexOf(you);
  assert.ok(!closed[youAt + 1] || !/why|├ Wren|└ Otto/.test(closed[youAt + 1]));
  const open = joined(viewOf(story, { 'you:0': true }, 72), 72);
  const body = open.join('\n');
  const at = open.findIndex((r) => r.includes('you  add a quick-capture inbox'));
  assert.match(open[at], /^▾ you/);
  assert.match(open[at + 1], /^│ {3}why {2}start on chunk 2/);
  assert.doesNotMatch(open[at + 1], /why {4}/);
  assert.match(open[at + 2], /^│ ├ Wren {2}keybinding helpers/);
  assert.match(open[at + 3], /^│ └ Otto {2}inbox store tests/);
  assert.equal(story.chapters.find((c) => c.you === 'add a quick-capture inbox').handoffs.length, 2);
  assert.equal(body.split('\n').filter((r) => r.includes('wiring the shortcut')).length, 1);
});

test('a shell that is not the last one keeps the gutter open, and neither is a second └', () => {
  const story = buildStory({
    host: 'Claude', now: NOW,
    agents: [agent('wren', { name: 'Wren', what: 'keybinding helpers', since: NOW - 38_000 })],
    tasks: [
      { id: 'a', kind: 'shell', label: 'first command', startedAt: NOW - 5_000 },
      { id: 'b', kind: 'shell', label: 'second command', startedAt: NOW - 1_000 },
    ],
  });
  const rows = joined(viewOf(story, {}, 64), 64);
  const shells = rows.filter((r) => r.includes('command'));
  assert.equal(shells.length, 2);
  assert.match(shells[0], /^│ ◇ first command/);
  assert.match(shells[1], /^◇ second command/);
  assert.equal(shells.some((r) => r.includes('└')), false);
  assert.match(rows.find((r) => r.includes('└ Wren')), /^ {2}└ Wren/);
});

test('a narrow Now tree still fits the column', () => {
  const view = viewOf(marketing(), { 'you:0': true }, 28);
  for (const row of [{ left: view.banner, right: [] }, ...view.rows]) {
    assert.ok(width(text(row.left)) + (text(row.right) ? width(text(row.right)) + 1 : 0) <= 28, line(row, 28));
  }
});

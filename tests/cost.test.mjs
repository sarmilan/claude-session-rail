// Session cost: the host's own figure, or a dash. Tokens are never priced.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyRecordedCost, costText, nextCost, usdFromTicks } from '../bin/cost.mjs';
import { contextFrom, TaskIndex } from '../bin/sources.mjs';
import { clean } from '../bin/term.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const usage = { input_tokens: 1_000, cache_read_input_tokens: 65_000, cache_creation_input_tokens: 0, output_tokens: 20 };

test('dollars come from ticks, and a bad count is not a figure', () => {
  assert.equal(usdFromTicks(802_300_000), 0.08023);
  assert.equal(usdFromTicks(0), 0);
  assert.equal(usdFromTicks(-1), null);
  assert.equal(usdFromTicks('802300000'), null);
  assert.equal(usdFromTicks(undefined), null);
});

test('a later host total is the turn, a repeat is not, and a lower total is a new ledger', () => {
  const first = nextCost(undefined, 0.1, 5);
  assert.deepEqual(first, { usd: 0.1, at: 5 });
  assert.equal(nextCost(first, 0.1, 9), first);
  const next = nextCost(first, 0.14, 9);
  assert.equal(next.usd, 0.14);
  assert.ok(Math.abs(next.turnUsd - 0.04) < 1e-12);
  const reset = nextCost(next, 0.01, 12);
  assert.deepEqual(reset, { usd: 0.01, at: 12 });
  assert.equal(nextCost(first, Number.NaN, 1), first);
  assert.equal(nextCost(undefined, -1, 1), undefined);
});

test('the row is the host total, the turn when it rose, or a dash', () => {
  assert.equal(costText(null), '—');
  assert.equal(costText({}), '—');
  assert.equal(costText({ costUsd: -1 }), '—');
  assert.equal(costText({ contextTokens: 66_000 }), '—');
  assert.equal(costText({ costUsd: 0 }), '$0.00');
  assert.equal(costText({ costUsd: 0.55, turnUsd: 0.04 }), '$0.55 · turn $0.04');
  assert.equal(costText({ costUsd: 0.0042 }), '$0.0042');
  assert.equal(costText({ costUsd: 0.08, turnUsd: 0, apiMs: 1_000 }), '$0.08');
  assert.equal(costText({ costUsd: 0.08, apiMs: 90_000 }), '$0.08 · API 2m');
});

test('a recorded ledger replaces a transcript total and does not keep the transcript turn', () => {
  const logged = { model: 'Opus 4.6', costUsd: 9, turnUsd: 9 };
  const booked = applyRecordedCost(logged, { usd: 0.55, at: 1, turnUsd: 0.04 });
  assert.equal(booked.costUsd, 0.55);
  assert.equal(booked.turnUsd, 0.04);
  assert.equal(booked.model, 'Opus 4.6');
  const totalOnly = applyRecordedCost(logged, { usd: 0.55, at: 1 });
  assert.equal(totalOnly.costUsd, 0.55);
  assert.equal(totalOnly.turnUsd, undefined);
  assert.equal(applyRecordedCost(logged, undefined), logged);
  assert.equal(applyRecordedCost(null, { usd: 1, at: 1 }), null);
});

test('grok context uses the session ticks and the latest turn that has them', () => {
  const priced = contextFrom(
    { contextWindowUsage: 10, contextTokensUsed: 70_000, contextWindowTokens: 256_000 },
    { current_model_id: 'grok-4.7' },
    { session: { costUsdTicks: 802_300_000, apiDurationMs: 90_000 }, turns: [{ usage: { costUsdTicks: 100 } }, { costUsdTicks: 200_000_000 }] },
  );
  assert.equal(priced.costUsd, 0.08023);
  assert.equal(priced.turnUsd, 0.02);
  assert.equal(priced.apiMs, 90_000);
  assert.equal(costText(priced), '$0.08 · turn $0.02 · API 2m');

  const bare = contextFrom({ contextWindowUsage: 27, contextTokensUsed: 70_000, contextWindowTokens: 256_000 }, {}, { session: { totalTokens: 70_000 }, turns: [{ usage: { costUsdTicks: 5_000_000_000 } }] });
  assert.equal(bare.costUsd, undefined);
  assert.equal(bare.contextTokens, 70_000);
  assert.equal(costText(bare), '—');

  const zero = contextFrom({ contextWindowUsage: 1 }, {}, { session: { costUsdTicks: 0 } });
  assert.equal(zero.costUsd, 0);
  assert.equal(costText(zero), '$0.00');
  const negative = contextFrom({ contextWindowUsage: 1 }, {}, { session: { costUsdTicks: -5 } });
  assert.equal(negative.costUsd, undefined);
});

test('a transcript contributes a host total only, never a price of its tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rail-cost-'));
  const write = (name, rows) => writeFile(join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const read = async (name) => {
    const idx = new TaskIndex();
    await idx.update(join(dir, name));
    return idx.context();
  };
  await write('gap.jsonl', [
    { type: 'assistant', message: { model: 'claude-opus-4-6', usage } },
    { type: 'assistant', message: { model: 'claude-opus-4-6', usage }, costUSD: 0.02 },
  ]);
  const gap = await read('gap.jsonl');
  assert.equal(gap.contextTokens, 66_000);
  assert.equal(gap.costUsd, undefined);

  await write('sum.jsonl', [
    { type: 'assistant', message: { model: 'claude-opus-4-6', usage }, costUSD: 0.2 },
    { type: 'assistant', message: { model: 'claude-opus-4-6', usage }, costUSD: 0.05 },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5', usage }, costUSD: 9 },
  ]);
  const sum = await read('sum.jsonl');
  assert.equal(sum.costUsd, 0.25);
  assert.equal(sum.turnUsd, 0.05);

  await write('total.jsonl', [
    { type: 'assistant', message: { model: 'claude-opus-4-6', usage }, costUSD: 0.2 },
    { type: 'result', total_cost_usd: 1.25 },
  ]);
  const total = await read('total.jsonl');
  assert.equal(total.costUsd, 1.25);
  assert.equal(total.turnUsd, undefined);
  await rm(dir, { recursive: true, force: true });
});

const frame = (home, args) => new Promise((resolve, reject) => {
  const env = { ...process.env, HOME: home, TERM: 'dumb' };
  delete env.CLAUDE_CONFIG_DIR;
  const child = spawn(process.execPath, [join(root, 'bin/rail.mjs'), '--frame', '72', '48', '--cwd', root, ...args], { env, cwd: root });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => (code === 0 ? resolve(clean(out)) : reject(new Error(`frame ${code}\n${err}\n${out}`))));
});

const row = (text, label) => text.split('\n').find((l) => l.includes(label));

async function claudeHome(id, { cost } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'rail-home-'));
  const cwd = root;
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
  await mkdir(join(home, '.claude', 'projects', slug), { recursive: true });
  await mkdir(join(home, '.claude', 'session-rail', 'activity'), { recursive: true });
  const now = Date.now();
  await writeFile(join(home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: id, cwd, entrypoint: 'cli', status: 'idle', name: 'Cost',
    startedAt: now, updatedAt: now, statusUpdatedAt: now,
  }));
  await writeFile(join(home, '.claude', 'projects', slug, `${id}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-6', usage } })}\n`);
  await writeFile(join(home, '.claude', 'session-rail', 'activity', `${id}.json`), JSON.stringify({
    claude: { state: 'waiting', since: now }, running: [], recent: [],
    cache: { at: now, ttl: '1h', plan: true, tokens: 90_000 },
    ...(cost ? { cost } : {}),
  }));
  return home;
}

async function grokHome(id, ledger) {
  const home = await mkdtemp(join(tmpdir(), 'rail-home-'));
  const cwd = root;
  const dir = join(home, '.grok', 'sessions', encodeURIComponent(cwd), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(home, '.grok', 'active_sessions.json'), JSON.stringify([
    { pid: process.pid, session_id: id, cwd, opened_at: new Date().toISOString() },
  ]));
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ current_model_id: 'grok-4.7', reasoning_effort: 'high' }));
  await writeFile(join(dir, 'signals.json'), JSON.stringify({ contextWindowUsage: 27, contextTokensUsed: 70_000, contextWindowTokens: 256_000 }));
  if (ledger) await writeFile(join(dir, 'usage.json'), JSON.stringify(ledger));
  return home;
}

test('--frame shows a host cost beside tokens and cache, and a dash when the host gave none', async () => {
  const priced = await claudeHome('priced', { cost: { usd: 0.55, at: 1, turnUsd: 0.04 } });
  const bare = await claudeHome('bare');
  const grokPriced = await grokHome('g-priced', { session: { costUsdTicks: 802_300_000 }, turns: [{ usage: { costUsdTicks: 200_000_000 } }] });
  const grokBare = await grokHome('g-bare', { session: { totalTokens: 70_000 } });
  try {
    const shown = await frame(priced, ['--session', 'priced']);
    assert.match(row(shown, 'Tokens'), /66k \/ 200k/);
    assert.match(row(shown, 'Cost'), /\$0\.55 · turn \$0\.04/);
    assert.doesNotMatch(row(shown, 'Cost'), /session/);
    assert.match(row(shown, 'Cache'), /plan · 1h · warm/);

    const missing = await frame(bare, ['--session', 'bare']);
    assert.match(row(missing, 'Tokens'), /66k \/ 200k/);
    assert.match(row(missing, 'Cost'), /—/);
    assert.doesNotMatch(row(missing, 'Cost'), /\$/);
    assert.match(row(missing, 'Cache'), /plan · 1h · warm/);

    const grokShown = await frame(grokPriced, ['--session', 'g-priced']);
    assert.match(row(grokShown, 'Cost'), /\$0\.08 · turn \$0\.02/);
    assert.doesNotMatch(row(grokShown, 'Cost'), /session/);
    assert.match(row(grokShown, 'Cache'), /—/);

    const grokMissing = await frame(grokBare, ['--session', 'g-bare']);
    assert.match(row(grokMissing, 'Tokens'), /70k \/ 256k/);
    assert.match(row(grokMissing, 'Cost'), /—/);
    assert.doesNotMatch(row(grokMissing, 'Cost'), /\$/);
  } finally {
    await Promise.all([priced, bare, grokPriced, grokBare].map((d) => rm(d, { recursive: true, force: true })));
  }
});

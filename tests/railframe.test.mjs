// The marketing fixture, painted by `node bin/rail.mjs --frame`. No iTerm and no Claude login.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { clean, width } from '../bin/term.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'tests/fixtures/marketing-rail.json');

const frame = (args, { cols }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'bin/rail.mjs'), '--frame', String(cols), '90', '--cwd', root, '--fixture', fixture, ...args], {
    cwd: root,
    env: { ...process.env, HOME: home, TERM: 'dumb', LANG: 'en_US.UTF-8' },
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`frame ${code}\n${err}\n${out}`))));
});

let home;
test.before(async () => { home = await mkdtemp(join(tmpdir(), 'rail-marketing-')); });
test.after(async () => { if (home) await rm(home, { recursive: true, force: true }); });

test('a 42-column marketing frame matches the rail shot', { timeout: 60_000 }, async () => {
  const raw = await frame(['--busy', '--pet-stage', '2'], { cols: 42 });
  const text = clean(raw);
  assert.match(text, /Now {2}Wren and Otto/);
  assert.doesNotMatch(text, /Rue, Wren|Wren, Otto, Rue|Now {2}Rue/);
  assert.match(text, /├ Wren {2}keybinding helpers/);
  assert.match(text, /└ Otto {2}inbox store tests/);
  assert.match(text, /running/);
  assert.match(text, /▸ Rue {2}scan capture shortcuts/);
  assert.match(text, /^ ◇ bun test src\/inbox/m);
  assert.doesNotMatch(text, /├▸|└▸|⚙|▭|▢|⎇/);
  assert.match(text, /▾ you {2}add a quick-capture inbox/);
  assert.match(text, /why {2}start on chunk 2/);
  assert.match(text, /│ ├ Wren {2}keybinding helpers/);
  assert.match(text, /│ └ Otto {2}inbox store tests/);
  assert.match(text, /host studio-1/);
  assert.match(text, /repo fieldnotes · ~\/src\/fieldnotes/);
  assert.match(text, /git feature/);
  assert.match(text, /\+86/);
  assert.match(text, /−12/);
  assert.match(text, /3 changed/);
  assert.match(text, /71%/);
  assert.match(text, /▰{6}▱{2}/);
  assert.match(text, /\$1\.87 · API 24m/);
  assert.doesNotMatch(text, /\$1\.87 session/);
  assert.match(text, /plan · 1h · warm 42m left/);
  assert.match(text, /5h left {2}38%/);
  assert.match(text, /resets 5:00 PM/);
  assert.match(text, /7d left {2}61%/);
  assert.match(text, /resets Sat/);
  assert.match(text, /Connectors ▸/);
  assert.match(text, /4 connected/);
  assert.match(text, /Sessions 3/);
  assert.match(text, /Quick capture inbox/);
  assert.match(text, /settings/);
  assert.match(raw, /\x1b\[38;5;141mWren/);
  assert.match(raw, /\x1b\[38;5;179mrunning/);
  const last = text.split('\n').filter((l) => l.trim()).at(-1);
  assert.match(last, /settings/);
  assert.doesNotMatch(last, /⚙/);
});

test('a narrower marketing frame still fits, and settings still opens', { timeout: 60_000 }, async () => {
  const narrow = clean(await frame([], { cols: 28 }));
  for (const line of narrow.split('\n')) assert.ok(width(line) <= 28, line);
  assert.match(narrow, /Wren and Otto/);
  assert.match(narrow, /host studio-1/);
  assert.match(narrow, /why {2}start/);
  const open = clean(await frame(['--open-settings'], { cols: 42 }));
  assert.match(open, /Font size/);
  assert.match(open, /Pet/);
  assert.match(open, /settings/);
  assert.doesNotMatch(open, /⚙/);
});

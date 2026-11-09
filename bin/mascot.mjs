// The rail's mascot: a little pixel creature (see creatures.mjs) wandering along a floor line under the
// legend. It walks, turns at the edges, blinks, hurries when Claude is busy, and falls asleep after a
// minute of nothing happening.
//
// Sprites are 34×16 pixel maps. In iTerm2 the creature and its floor are one inline PNG strip, two rows
// tall and as wide as the rail, so each sprite pixel is a ~2pt square and the floor is a ~1pt line along
// the very bottom. Elsewhere (and in --frame output) it falls back to Unicode octants: 2×4 pixels per
// character, 17×4 characters, over a text floor.
import { deflateSync } from 'node:zlib';
import { CREATURES, SPR_W, SPR_H } from './creatures.mjs';

const ESC = '\x1b[';
const IDLE_MS = 60_000;  // nothing busy for this long → sleep
const ZED_COLOR = 245;
const ZED = ['ZZZZ', '..Z.', '.Z..', 'ZZZZ'];

export const creatureNames = CREATURES.map((c) => c.name);

// Pose → pixel rows, facing `dir`, with sleeping z's drawn after mirroring so they still read as z.
function pixels(c, { frame, blink, sleep, dir, z }) {
  let rows = c.draw({ frame, blink, sleep });
  const flip = dir < 0 && !c.sideways;
  if (flip) rows = rows.map((r) => [...r].reverse().join(''));
  if (z) {
    const g = rows.map((r) => [...r]);
    c.zAt.slice(0, z).forEach(([x0, y0]) => ZED.forEach((row, y) => [...row].forEach((ch, x) => {
      const X = flip ? SPR_W - 4 - x0 + x : x0 + x;
      if (ch !== '.' && g[y0 + y]?.[X] !== undefined) g[y0 + y][X] = 'Z';
    })));
    rows = g.map((r) => r.join(''));
  }
  return rows;
}
const colorOf = (c, key) => (key === 'Z' ? ZED_COLOR : c.palette[key]);

const xtermRgb = (n) => {
  if (n >= 232) { const v = 8 + 10 * (n - 232); return [v, v, v]; }
  const i = n - 16, L = [0, 95, 135, 175, 215, 255];
  return [L[Math.floor(i / 36)], L[Math.floor(i / 6) % 6], L[i % 6]];
};

// ── Inline image (iTerm2) ──────────────────────────────────────────────────────
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
const pngEncode = (w, h, raw) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
};
// The strip is drawn at 4 image pixels per sprite pixel (crisp on Retina): 64 rows of creature, then a
// 2-pixel floor line. `colPx` is image pixels per terminal column; `x` is the creature's left edge.
const SCALE = 4, STRIP_H = SPR_H * SCALE + 2, FLOOR_RGB = xtermRgb(240);
function stripImage(c, rows, cols, colPx, x) {
  const w = Math.max(1, Math.round(cols * colPx)), stride = w * 4 + 1;
  const raw = Buffer.alloc(STRIP_H * stride);
  for (let y = 0; y < SPR_H * SCALE; y++) for (let px = 0; px < SPR_W * SCALE; px++) {
    const key = rows[Math.floor(y / SCALE)][Math.floor(px / SCALE)];
    if (key !== '.' && x + px < w) raw.set([...xtermRgb(colorOf(c, key)), 255], y * stride + 1 + (x + px) * 4);
  }
  for (let y = SPR_H * SCALE; y < STRIP_H; y++) for (let px = 0; px < w; px++) raw.set([...FLOOR_RGB, 255], y * stride + 1 + px * 4);
  // Stretched to exactly `cols` × 2 cells; with the right cell aspect the pixels come out square.
  return `\x1b]1337;File=inline=1;width=${cols};height=2;preserveAspectRatio=0:${pngEncode(w, STRIP_H, raw).toString('base64')}\x07`;
}

// ── Octant fallback ────────────────────────────────────────────────────────────
// GLYPH[mask] draws a 2×4 cell; bit i is pixel i in reading order (left→right, top→bottom).
const GLYPH = [...' 𜺨𜺫🮂𜴀▘𜴁𜴂𜴃𜴄▝𜴅𜴆𜴇𜴈▀𜴉𜴊𜴋𜴌🯦𜴍𜴎𜴏𜴐𜴑𜴒𜴓𜴔𜴕𜴖𜴗𜴘𜴙𜴚𜴛𜴜𜴝𜴞𜴟🯧𜴠𜴡𜴢𜴣𜴤𜴥𜴦𜴧𜴨𜴩𜴪𜴫𜴬𜴭𜴮𜴯𜴰𜴱𜴲𜴳𜴴𜴵🮅𜺣𜴶𜴷𜴸𜴹𜴺𜴻𜴼𜴽𜴾𜴿𜵀𜵁𜵂𜵃𜵄▖𜵅𜵆𜵇𜵈▌𜵉𜵊𜵋𜵌▞𜵍𜵎𜵏𜵐▛𜵑𜵒𜵓𜵔𜵕𜵖𜵗𜵘𜵙𜵚𜵛𜵜𜵝𜵞𜵟𜵠𜵡𜵢𜵣𜵤𜵥𜵦𜵧𜵨𜵩𜵪𜵫𜵬𜵭𜵮𜵯𜵰𜺠𜵱𜵲𜵳𜵴𜵵𜵶𜵷𜵸𜵹𜵺𜵻𜵼𜵽𜵾𜵿𜶀𜶁𜶂𜶃𜶄𜶅𜶆𜶇𜶈𜶉𜶊𜶋𜶌𜶍𜶎𜶏▗𜶐𜶑𜶒𜶓▚𜶔𜶕𜶖𜶗▐𜶘𜶙𜶚𜶛▜𜶜𜶝𜶞𜶟𜶠𜶡𜶢𜶣𜶤𜶥𜶦𜶧𜶨𜶩𜶪𜶫▂𜶬𜶭𜶮𜶯𜶰𜶱𜶲𜶳𜶴𜶵𜶶𜶷𜶸𜶹𜶺𜶻𜶼𜶽𜶾𜶿𜷀𜷁𜷂𜷃𜷄𜷅𜷆𜷇𜷈𜷉𜷊𜷋𜷌𜷍𜷎𜷏𜷐𜷑𜷒𜷓𜷔𜷕𜷖𜷗𜷘𜷙𜷚▄𜷛𜷜𜷝𜷞▙𜷟𜷠𜷡𜷢▟𜷣▆𜷤𜷥█'];
function octantRows(c, rows) {
  const out = [];
  for (let cy = 0; cy < SPR_H / 4; cy++) {
    const cells = [];
    for (let cx = 0; cx < SPR_W / 2; cx++) {
      const px = [];
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) px.push(rows[cy * 4 + dy][cx * 2 + dx]);
      const count = {};
      for (const p of px) count[p] = (count[p] || 0) + 1;
      // A cell shows two colours at most (fg + bg); keep eyes, then the commonest.
      const [a, b] = Object.keys(count).sort((p, q) => ('PE'.includes(q) - 'PE'.includes(p)) || count[q] - count[p]);
      const [fg, bg] = a === '.' || (b && b !== '.' && count[a] > count[b]) ? [b, a] : [a, b];
      if (!fg) { cells.push(null); continue; }
      let mask = 0;
      px.forEach((p, i) => { if (p === fg) mask |= 1 << i; });
      cells.push({ ch: GLYPH[mask], fg: colorOf(c, fg), bg: bg && bg !== '.' ? colorOf(c, bg) : null });
    }
    out.push(cells);
  }
  return out;
}

// ── The mascot ─────────────────────────────────────────────────────────────────
export function createMascot({ images = false, creature = 0, now = Date.now() } = {}) {
  let aspect = 0.5; // terminal cell width ÷ height, until the terminal tells us (setCellAspect)
  const colPx = () => (aspect * STRIP_H) / 2;
  const width = () => (images ? Math.ceil((SPR_W * SCALE) / colPx()) : SPR_W / 2); // columns it occupies
  let index = ((creature % CREATURES.length) + CREATURES.length) % CREATURES.length;
  const s = { x: 2, dir: 1, phase: 0, tick: 0, mode: 'walk', lastActive: now, blinkUntil: 0 };
  const cache = new Map();
  const cached = (key, make) => {
    if (!cache.has(key)) { if (cache.size > 200) cache.clear(); cache.set(key, make()); }
    return cache.get(key);
  };
  const bounds = (W) => [1, W - 1 - width()];

  return {
    get width() { return width(); },
    // a blank spacer, then the strip (image) or the sprite and a floor row (text)
    rows: images ? 3 : SPR_H / 4 + 2,
    get index() { return index; },
    get name() { return CREATURES[index].name; },

    // Switch to the next creature; returns its name.
    next() { index = (index + 1) % CREATURES.length; s.phase = 0; return CREATURES[index].name; },

    // The terminal's cell size, so the strip's pixels come out square.
    setCellAspect(r) { if (r > 0.2 && r < 1.5) { aspect = r; cache.clear(); } },

    // Advance one animation tick (the rail calls this ~5×/s).
    step(W, busy, t = Date.now()) {
      const c = CREATURES[index];
      s.tick++;
      if (busy) s.lastActive = t;
      s.mode = busy ? 'busy' : t - s.lastActive > IDLE_MS ? 'sleep' : 'walk';
      const [lo, hi] = bounds(W);
      s.x = Math.max(lo, Math.min(s.x, hi));
      if (s.mode === 'sleep') { s.phase = 0; return; }
      if (s.blinkUntil < t && Math.random() < 0.04) s.blinkUntil = t + 250;
      if (s.tick % (busy ? 1 : c.speed)) return;
      const next = 1 - s.phase;
      if (c.advance[next]) {
        if (s.x + s.dir < lo || s.x + s.dir > hi) { s.dir = -s.dir; return; } // turn at the edge
        s.x += s.dir;
      }
      s.phase = next;
    },

    // `lines`: `rows` text lines, each exactly W columns. `image`: in image mode, an escape sequence
    // to write with the cursor at (image.row within these lines, image.col), after the lines; it covers
    // `image.rows` lines, which are left blank.
    render(W, t = Date.now()) {
      const rowsOut = this.rows, blankLine = ' '.repeat(W);
      const [lo, hi] = bounds(W);
      if (hi < lo) return { lines: Array(rowsOut).fill(blankLine), image: null };
      const c = CREATURES[index];
      const sleep = s.mode === 'sleep';
      const pose = { frame: sleep ? 0 : s.phase, blink: !sleep && s.blinkUntil > t, sleep, dir: s.dir,
        z: sleep ? Math.floor(s.tick / 5) % 3 : 0 };
      const poseKey = `${index}:${JSON.stringify(pose)}`;
      if (images) {
        const cols = W - 2, x = Math.round((s.x - 1) * colPx());
        const data = cached(`${poseKey}|${cols}|${x}|${aspect}`, () => stripImage(c, pixels(c, pose), cols, colPx(), x));
        return { lines: Array(rowsOut).fill(blankLine), image: { row: 1, rows: 2, col: 1, data } };
      }
      const grid = Array.from({ length: SPR_H / 4 + 1 }, () => Array.from({ length: W }, () => ' '));
      for (let col = 1; col < W - 1; col++) grid[SPR_H / 4][col] = `${ESC}2m▔${ESC}22m`;
      cached(poseKey, () => octantRows(c, pixels(c, pose))).forEach((cells, r) => cells.forEach((cell, col) => {
        if (!cell) return;
        const bg = cell.bg != null ? `${ESC}48;5;${cell.bg}m` : '';
        grid[r][s.x + col] = `${ESC}38;5;${cell.fg}m${bg}${cell.ch}${ESC}0m`;
      }));
      return { lines: [blankLine, ...grid.map((row) => row.join(''))], image: null };
    },

    get state() { return { ...s, creature: CREATURES[index].name }; },
  };
}

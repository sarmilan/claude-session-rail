// The rail's mascot: a little pixel creature (see creatures.mjs) wandering along a floor line at the
// bottom of the rail. It walks, turns at the edges, blinks, hurries when Claude is busy, and falls asleep after a
// minute of nothing happening. It grows through four stages as the branch's brief heads toward its
// compaction (`setStage`, `stageFor`), moving faster and angrier at each: hopping from the adult on,
// shaking and fuming when heavy.
//
// Sprites are 34×16 pixel maps. In iTerm2 the creature and its floor are one inline PNG strip, three rows
// tall (four for a stage drawn bigger) and as wide as the rail, so each sprite pixel is a ~2pt square and
// the floor is a ~1pt line through the middle of the last row. Elsewhere (and in --frame output) it falls back to Unicode octants: 2×4 pixels per
// character, 17×4 characters, over a text floor.
import { deflateSync } from 'node:zlib';
import { CREATURES, SPR_W, SPR_H } from './creatures.mjs';
import { foliage } from './habitats.mjs';
import { createVisitors } from './visitors.mjs';
import { isApproved } from './brief.mjs';

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
// The marks over the pet keep their own letters: A the anger mark and the failure puff's red, U the puff's
// orange, Q the gate's yellow question mark.
const MARK_COLORS = { Z: ZED_COLOR, A: 196, U: 208, Q: 220 };
const colorOf = (c, key) => MARK_COLORS[key] ?? c.palette[key];

// How each growth stage behaves: `dSpeed` adjusts ticks per frame for creatures without their own stage
// drawings; from the adult on it hops every `hopEvery` ticks (`hop`: lift in sprite pixels per tick),
// and the heavy one shakes now and then and flashes an anger mark.
const MOOD = [
  { dSpeed: 1 },
  { dSpeed: 0 },
  { dSpeed: -1, hopEvery: 16, hop: [1, 2, 2, 1] },
  { dSpeed: -9, hopEvery: 8, hop: [1, 2, 3, 3, 2, 1], shake: 0.12, rage: true },
];
// Stage from the branch's brief (sources.readBrief): a hatchling until it's approved, a juvenile once it is,
// an adult after its first Done chunk, and heavy when every chunk is Done (ready to merge and compact).
// After the compaction the next branch has no approved brief, so the pet hatches again.
// The share of Done chunks of an approved (or approved, then edited) brief, else null.
const doneShare = (brief) => {
  if (!isApproved(brief?.status)) return null; // an edited plan keeps its growth
  return brief.chunks?.length ? brief.chunks.filter((c) => c.done).length / brief.chunks.length : 0;
};
export const stageFor = (brief) => {
  const f = doneShare(brief);
  return f == null ? 0 : f === 0 ? 1 : f < 1 ? 2 : 3;
};
// How far along the branch's road the pet lives (0 left … 1 right): the share of Done chunks of an approved
// (or approved, then edited) brief, 0 before approval, and null with no brief, to pace the whole strip.
export const progressFor = (brief) => (brief?.status ? doneShare(brief) ?? 0 : null);
const PACE = 4; // columns it wanders either side of its spot on the road
const ANGER = ['.A.A.', 'AA.AA', '.....', 'AA.AA', '.A.A.']; // a popping vein, drawn up by a claw
const PUFF = ['U.A.U', '.AUA.', 'AUUUA', '.AUA.', 'U.A.U']; // a failed tool call
const QUERY = ['.QQQ.', 'Q...Q', '...Q.', '..Q..', '.....', '..Q..']; // held by the brief gate
const PUFF_MS = 1500, MAX_COMPANIONS = 3;

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
// The strip is `stripRows` terminal rows of ROW_PX image pixels, drawn at `scale` image pixels per sprite
// pixel (4, or 5 for a stage drawn bigger; crisp on Retina). The 2-pixel floor runs through the middle of
// the last row, where a `─` sits, so it lines up with Claude's own input-bar rule in the pane beside it;
// the creature stands on it (`lift` sprite pixels above it mid-hop), with transparent space above.
// Behind it grows `ground`, the habitat's foliage ([x, up, colour] sprite pixels, always at SCALE so the
// scenery holds still when the pet is drawn bigger).
// `colPx` is image pixels per terminal column; `x` is the creature's left edge.
const SCALE = 4, STRIP_ROWS = 3, ROW_PX = 34, FLOOR_RGB = xtermRgb(240);
const SWAY = [0, 1, 0, -1]; // the foliage's lean, a step a second (5 ticks)
function stripImage(c, rows, cols, colPx, x, { scale = SCALE, stripRows = STRIP_ROWS, lift = 0, mark = null, flip = false, ground = [], sprites = [] } = {}) {
  const h = stripRows * ROW_PX, floorY = h - ROW_PX / 2 - 1, top = floorY - (SPR_H + lift) * scale;
  const w = Math.max(1, Math.round(cols * colPx)), stride = w * 4 + 1;
  const raw = Buffer.alloc(h * stride);
  const putRgb = (px, py, rgb) => { if (px >= 0 && px < w && py >= 0 && py < h) raw.set([...rgb, 255], py * stride + 1 + px * 4); };
  const put = (px, py, key) => putRgb(px, py, xtermRgb(colorOf(c, key)));
  for (const [gx, up, colour] of ground) { // a sprite pixel each; below the floor they start under its line
    const rgb = xtermRgb(colour), gy = up > 0 ? floorY - up * SCALE : floorY + 2 + (-up - 1) * SCALE;
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) putRgb(gx * SCALE + dx, gy + dy, rgb);
  }
  for (const v of sprites) { // visitors and companions: over the foliage, behind the creature, `up` pixels up
    const vy = floorY - (v.up + v.rows.length) * SCALE;
    v.rows.forEach((row, ry) => [...row].forEach((k, rx) => {
      if (k === '.') return;
      const rgb = xtermRgb(v.palette[k]);
      for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) putRgb(v.px + rx * SCALE + dx, vy + ry * SCALE + dy, rgb);
    }));
  }
  for (let y = 0; y < SPR_H * scale; y++) for (let px = 0; px < SPR_W * scale; px++) {
    const key = rows[Math.floor(y / scale)][Math.floor(px / scale)];
    if (key !== '.') put(x + px, top + y, key);
  }
  if (mark) { // anger, a puff or a ?, a sprite pixel a dot, above the front (the right claw, or the head turned left)
    const ax = x + Math.round(SPR_W * scale * (flip ? 0.2 : 0.8)) - (flip ? mark[0].length * scale : 0), ay = Math.max(0, top - mark.length * scale - 2);
    mark.forEach((row, ry) => [...row].forEach((k, rx) => {
      if (k !== '.') for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(ax + rx * scale + dx, ay + ry * scale + dy, k);
    }));
  }
  for (let y = floorY; y < floorY + 2; y++) for (let px = 0; px < w; px++) raw.set([...FLOOR_RGB, 255], y * stride + 1 + px * 4);
  // Stretched to exactly `cols` × `stripRows` cells; with the right cell aspect the pixels come out square.
  return `\x1b]1337;File=inline=1;width=${cols};height=${stripRows};preserveAspectRatio=0:${pngEncode(w, h, raw).toString('base64')}\x07`;
}

// ── Octant fallback ────────────────────────────────────────────────────────────
// GLYPH[mask] draws a 2×4 cell; bit i is pixel i in reading order (left→right, top→bottom).
const GLYPH = [...' 𜺨𜺫🮂𜴀▘𜴁𜴂𜴃𜴄▝𜴅𜴆𜴇𜴈▀𜴉𜴊𜴋𜴌🯦𜴍𜴎𜴏𜴐𜴑𜴒𜴓𜴔𜴕𜴖𜴗𜴘𜴙𜴚𜴛𜴜𜴝𜴞𜴟🯧𜴠𜴡𜴢𜴣𜴤𜴥𜴦𜴧𜴨𜴩𜴪𜴫𜴬𜴭𜴮𜴯𜴰𜴱𜴲𜴳𜴴𜴵🮅𜺣𜴶𜴷𜴸𜴹𜴺𜴻𜴼𜴽𜴾𜴿𜵀𜵁𜵂𜵃𜵄▖𜵅𜵆𜵇𜵈▌𜵉𜵊𜵋𜵌▞𜵍𜵎𜵏𜵐▛𜵑𜵒𜵓𜵔𜵕𜵖𜵗𜵘𜵙𜵚𜵛𜵜𜵝𜵞𜵟𜵠𜵡𜵢𜵣𜵤𜵥𜵦𜵧𜵨𜵩𜵪𜵫𜵬𜵭𜵮𜵯𜵰𜺠𜵱𜵲𜵳𜵴𜵵𜵶𜵷𜵸𜵹𜵺𜵻𜵼𜵽𜵾𜵿𜶀𜶁𜶂𜶃𜶄𜶅𜶆𜶇𜶈𜶉𜶊𜶋𜶌𜶍𜶎𜶏▗𜶐𜶑𜶒𜶓▚𜶔𜶕𜶖𜶗▐𜶘𜶙𜶚𜶛▜𜶜𜶝𜶞𜶟𜶠𜶡𜶢𜶣𜶤𜶥𜶦𜶧𜶨𜶩𜶪𜶫▂𜶬𜶭𜶮𜶯𜶰𜶱𜶲𜶳𜶴𜶵𜶶𜶷𜶸𜶹𜶺𜶻𜶼𜶽𜶾𜶿𜷀𜷁𜷂𜷃𜷄𜷅𜷆𜷇𜷈𜷉𜷊𜷋𜷌𜷍𜷎𜷏𜷐𜷑𜷒𜷓𜷔𜷕𜷖𜷗𜷘𜷙𜷚▄𜷛𜷜𜷝𜷞▙𜷟𜷠𜷡𜷢▟𜷣▆𜷤𜷥█'];
function octantRows(c, rows) {
  const out = [];
  for (let cy = 0; cy < rows.length / 4; cy++) {
    const cells = [];
    for (let cx = 0; cx < rows[0].length / 2; cx++) {
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
  const colPx = () => aspect * ROW_PX;
  let index = ((creature % CREATURES.length) + CREATURES.length) % CREATURES.length;
  let stage = 0, progress = null;
  const flock = createVisitors(); // a flier for each running subagent (visitors.mjs)
  const companions = []; // the x of each one trailing behind, a running background task each
  let held = false, puffUntil = 0;
  let lastStrip = { key: '', data: '' }; // the last strip drawn with visitors
  // The drawing for this stage: the creature's own stage form, or the creature itself.
  const form = () => CREATURES[index].stages?.[stage] ?? CREATURES[index];
  const width = () => (images ? Math.ceil((SPR_W * (form().scale ?? SCALE)) / colPx()) : SPR_W / 2); // columns it occupies
  const s = { x: 2, dir: 1, phase: 0, tick: 0, mode: 'walk', lastActive: now, blinkUntil: 0, hopI: -1, lift: 0, shake: 0 };
  const cache = new Map();
  const cached = (key, make) => {
    if (!cache.has(key)) { if (cache.size > 200) cache.clear(); cache.set(key, make()); }
    return cache.get(key);
  };
  const bounds = (W) => [1, W - 1 - width()];
  // The mark over its head: a failure's puff, else the gate's ?, else the heavy stage's flickering anger.
  const markFor = (t) => {
    if (s.mode === 'sleep') return null;
    if (t < puffUntil) return PUFF;
    if (held) return QUERY;
    return MOOD[stage].rage && s.lift === 0 && Math.floor(s.tick / 3) % 2 ? ANGER : null;
  };
  // The companions to draw: the creature's baby, facing the way it walks, bobbing out of step.
  const littleOnes = (sleep) => {
    const cr = CREATURES[index], flip = s.dir < 0 && !cr.sideways;
    const rows = flip ? cr.baby.map((r) => [...r].reverse().join('')) : cr.baby;
    return companions.map((x, i) => ({ x, rows, palette: cr.palette, bob: !sleep && !held && (s.tick + i * 2) % 4 < 2 ? 1 : 0 }));
  };
  const companionWidth = () => (images ? Math.ceil((6 * SCALE) / colPx()) : 3); // columns a little one takes

  return {
    get width() { return width(); },
    // the strip (image, its own space above built in) or a blank spacer, the sprite and a floor row (text)
    get rows() { return images ? form().rows ?? STRIP_ROWS : SPR_H / 4 + 2; },
    get stage() { return stage; },
    // Grow or shrink to a stage (0 hatchling … 3 heavy); a hop in progress lands.
    setStage(n) { if (n !== stage && n >= 0 && n < MOOD.length) { stage = n; s.hopI = -1; s.lift = 0; s.shake = 0; } },
    // Its spot on the road, 0 … 1 (progressFor), or null to pace the whole strip.
    setProgress(f) { progress = f == null ? null : Math.max(0, Math.min(1, f)); },
    // How many subagents are running: a visitor each, up to 4; one flies off as each finishes.
    setVisitors(n, W = 42) { flock.want(n, W); },
    // How many background tasks are running: a little one trails behind for each, up to 3.
    setCompanions(n) {
      n = Math.max(0, Math.min(MAX_COMPANIONS, n | 0));
      while (companions.length < n) companions.push(companions.at(-1) ?? s.x);
      companions.length = n;
    },
    // A tool call failed: it flinches, and a red puff pops over it for a moment.
    flinch(t = Date.now()) { s.shake = 4; puffUntil = t + PUFF_MS; },
    // The brief gate is holding edits: it stands still, awake, with a ? over its head.
    setHeld(on) { held = Boolean(on); },
    get index() { return index; },
    get name() { return CREATURES[index].name; },

    // Switch to the next creature (or the previous one, d = -1); returns its name.
    next(d = 1) { index = (index + d + CREATURES.length) % CREATURES.length; s.phase = 0; return CREATURES[index].name; },
    // Switch to creature i; returns its name.
    pick(i) { index = ((i % CREATURES.length) + CREATURES.length) % CREATURES.length; s.phase = 0; return CREATURES[index].name; },

    // The terminal's cell size, so the strip's pixels come out square.
    setCellAspect(r) { if (r > 0.2 && r < 1.5) { aspect = r; cache.clear(); } },

    // Advance one animation tick (the rail calls this ~5×/s).
    step(W, busy, t = Date.now()) {
      const c = form(), mood = MOOD[stage];
      s.tick++;
      flock.step(s.x + width() / 2, W, s.tick, width() / 2, images ? Math.ceil((7 * SCALE) / colPx()) : 4);
      if (busy || held) s.lastActive = t;
      s.mode = busy ? 'busy' : t - s.lastActive > IDLE_MS ? 'sleep' : 'walk';
      const [lo, hi] = bounds(W);
      s.x = Math.max(lo, Math.min(s.x, hi));
      const home = progress == null ? null : Math.round(lo + progress * (hi - lo)); // its spot on the road
      if (s.mode !== 'sleep') { // the little ones keep a column apart behind it, a column a tick at most
        const cw = companionWidth(), span = companions.length * (cw + 1);
        // on the road, the way it came; the side with more room when that one has too little. On the road the
        // room is judged from its spot, not where it paces, so they don't swing round it at every step.
        const ref = home ?? s.x, roomL = ref - lo, roomR = W - 1 - (ref + width());
        let left = progress != null || s.dir > 0;
        if ((left ? roomL : roomR) < span) left = roomL >= roomR;
        companions.forEach((x, i) => {
          const target = left ? s.x - (i + 1) * (cw + 1) : s.x + width() + 1 + i * (cw + 1);
          companions[i] = x + Math.sign(target - x);
        });
      }
      if (s.mode === 'sleep') { s.phase = 0; s.hopI = -1; s.lift = 0; s.shake = 0; return; }
      if (s.blinkUntil < t && Math.random() < 0.04) s.blinkUntil = t + 250;
      if (held) { s.phase = 0; s.hopI = -1; s.lift = 0; if (s.shake > 0) s.shake--; return; } // stands still; a flinch still wears off
      // hops and shakes, as the stage's mood has them
      if (mood.hop) {
        if (s.hopI < 0 && s.tick % mood.hopEvery === 0) s.hopI = 0;
        if (s.hopI >= 0) { s.lift = mood.hop[s.hopI++] ?? 0; if (s.hopI > mood.hop.length) s.hopI = -1; }
      }
      if (s.shake > 0) s.shake--;
      else if (mood.shake && s.hopI < 0 && Math.random() < mood.shake) s.shake = 4;
      // On the road it paces around its spot, and heads straight there when it's further off.
      let a = lo, b = hi, heading = false;
      if (home != null) {
        a = Math.max(lo, home - PACE); b = Math.min(hi, home + PACE);
        if (s.x < a || s.x > b) { heading = true; s.dir = s.x < a ? 1 : -1; }
      }
      const speed = Math.max(1, CREATURES[index].stages ? c.speed : c.speed + mood.dSpeed);
      const hurry = busy || heading; // a frame a tick, and a column every frame
      if (s.tick % (hurry ? 1 : speed)) return;
      const next = 1 - s.phase;
      if (hurry || c.advance[next]) {
        if (!heading && (s.x + s.dir < a || s.x + s.dir > b)) { s.dir = -s.dir; return; } // turn at the edge
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
      const c = form(), mood = MOOD[stage];
      const sleep = s.mode === 'sleep';
      const pose = { frame: sleep ? 0 : s.phase, blink: !sleep && s.blinkUntil > t, sleep, dir: s.dir,
        z: sleep ? Math.floor(s.tick / 5) % 3 : 0 };
      const poseKey = `${index}:${stage}:${JSON.stringify(pose)}`;
      if (images) {
        const scale = c.scale ?? SCALE, stripRows = c.rows ?? STRIP_ROWS;
        const jitter = s.shake ? (s.tick % 2 ? scale : -scale) : 0;
        const mark = markFor(t);
        const cols = W - 2, x = Math.round((s.x - 1) * colPx()) + jitter;
        const sway = SWAY[Math.floor(s.tick / 5) % SWAY.length];
        const sprites = [
          ...flock.sprites(s.tick).map((v) => ({ ...v, up: 7 + Math.round(v.alt * 8) })), // alt lifts them 7 … 15 pixels
          ...littleOnes(sleep).map((v) => ({ ...v, up: v.bob })),
        ].map((v) => ({ ...v, px: Math.round((v.x - 1) * colPx()) }));
        const extras = sprites.map((v) => `${v.px},${v.up},${v.rows.join('')}`).join(';'); // what stripImage draws
        const make = () => {
          const ground = foliage(CREATURES[index].habitat, Math.ceil((cols * colPx()) / SCALE), sway);
          return stripImage(c, pixels(c, pose), cols, colPx(), x, { scale, stripRows, lift: s.lift, mark, flip: s.dir < 0 && !c.sideways, ground, sprites });
        };
        // Visitors wobble every tick, so a strip with them is kept only until the next change (redraws between
        // ticks reuse it) rather than crowding out the cache.
        const key = `${poseKey}|${cols}|${x}|${aspect}|${s.lift}|${mark?.[0] ?? ''}|${sway}|${extras}`;
        if (flock.size && lastStrip.key !== key) lastStrip = { key, data: make() };
        const data = flock.size ? lastStrip.data : cached(key, make);
        return { lines: Array(rowsOut).fill(blankLine), image: { row: 0, rows: stripRows, col: 1, data } };
      }
      const grid = Array.from({ length: SPR_H / 4 + 1 }, () => Array.from({ length: W }, () => ' '));
      for (let col = 1; col < W - 1; col++) grid[SPR_H / 4][col] = `${ESC}2m▔${ESC}22m`;
      const sky = Array.from({ length: W }, () => ' '); // the blank line above, where high visitors fly
      // A small drawing as octant cells, its top on `line` (-1 the sky, 0… the sprite rows), clipped to the strip.
      const paint = (v, x, line) => {
        const w = Math.ceil(v.rows[0].length / 2) * 2, h = Math.ceil(v.rows.length / 4) * 4;
        const rows = Array.from({ length: h }, (_, y) => (v.rows[y] ?? '').padEnd(w, '.'));
        octantRows(v, rows).forEach((cells, r) => cells.forEach((cell, col) => {
          const X = Math.round(x) + col, row = line + r === -1 ? sky : grid[line + r];
          if (!cell || !row || X < 1 || X >= W - 1) return;
          row[X] = `${ESC}38;5;${cell.fg}m${cell.bg != null ? `${ESC}48;5;${cell.bg}m` : ''}${cell.ch}${ESC}0m`;
        }));
      };
      for (const v of flock.sprites(s.tick)) paint(v, v.x, v.alt > 0.5 ? -1 : 0); // 2 cells high, behind it
      for (const v of littleOnes(sleep)) paint(v, v.x, SPR_H / 4 - 1);
      // the mark before the creature, so its lower edge never blanks the creature's top cells
      const mark = markFor(t), flip = s.dir < 0 && !c.sideways;
      if (mark) paint({ rows: mark, palette: {} }, s.x + Math.round(width() * (flip ? 0.2 : 0.8)) - (flip ? 3 : 0), -1);
      cached(poseKey, () => octantRows(c, pixels(c, pose))).forEach((cells, r) => cells.forEach((cell, col) => {
        if (!cell) return;
        const bg = cell.bg != null ? `${ESC}48;5;${cell.bg}m` : '';
        grid[r][s.x + col] = `${ESC}38;5;${cell.fg}m${bg}${cell.ch}${ESC}0m`;
      }));
      return { lines: [sky.join(''), ...grid.map((row) => row.join(''))], image: null };
    },

    get state() { return { ...s, stage, creature: CREATURES[index].name }; },
  };
}

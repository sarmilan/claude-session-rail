// The rail's mascot: a little pixel creature (see creatures.mjs) wandering along a floor line at the
// bottom of the rail. It walks, turns at the edges, blinks, hurries while the agent is busy, looks left
// and fidgets while it waits for the person, and falls asleep after a minute of real quiet. It grows
// through four stages as the branch's brief heads toward its compaction (`setStage`, `stageFor`): hopping
// from the adult on, and shaking with a gold mark when heavy, which means the branch is ready to merge.
//
// Sprites are 34×16 pixel maps. In iTerm2 the creature and its floor are one inline PNG strip, three rows
// tall (four for a stage drawn bigger) and as wide as the rail, so each sprite pixel is a ~2pt square and
// the floor is a ~1pt line through the middle of the last row. Elsewhere (and in --frame output) it falls back to Unicode octants: 2×4 pixels per
// character, 17×4 characters, over a text floor.
import { deflateSync } from 'node:zlib';
import { CREATURES, SPR_W, SPR_H } from './creatures.mjs';
import { foliage, trail, dust } from './habitats.mjs';
import { createVisitors } from './visitors.mjs';
import { isApproved } from './brief.mjs';

const ESC = '\x1b[';
const IDLE_MS = 60_000;  // nothing busy for this long → sleep
const ZED_COLOR = 245;
const ZED = ['ZZZZ', '..Z.', '.Z..', 'ZZZZ'];

export const creatureNames = CREATURES.map((c) => c.name);

// Pose → pixel rows, facing `dir`, with sleeping z's drawn after mirroring so they still read as z.
function pixels(c, pose) {
  const { dir, z } = pose;
  let rows = c.draw(pose);
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
// The marks over the pet keep their own letters. A is red and only means a failed tool. U is the puff's
// orange. Q is the gate's yellow question mark. G is gold: the heavy stage's ready mark, and a Done sparkle.
const MARK_COLORS = { Z: ZED_COLOR, A: 196, U: 208, Q: 220, G: 220 };
const colorOf = (c, key) => MARK_COLORS[key] ?? c.palette[key];

// How each growth stage behaves: `dSpeed` adjusts ticks per frame for creatures without their own stage
// drawings; from the adult on it hops every `hopEvery` ticks (`hop`: lift in sprite pixels per tick),
// and the heavy one shakes now and then and flashes a gold ready mark.
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
// How many chunks are Done, for the trail of markers. Nothing is counted before approval.
export const doneFor = (brief) => {
  const chunks = brief?.chunks ?? [];
  if (!isApproved(brief?.status)) return { done: 0, total: chunks.length };
  return { done: chunks.filter((c) => c.done).length, total: chunks.length };
};
// How long a turn that has ended still counts as "waiting for you", matching the session list.
export const WAIT_FOR_YOU = 60 * 60 * 1000;
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
// Claude records a subagent as Agent or, in newer sessions, Task. Either way it is not the main agent's own call.
export const isSubagentCall = (c) => Boolean(c && SUBAGENT_TOOLS.has(c.tool) && !c.agent);
const liveAgents = (activity) => Object.values(activity?.agents ?? {}).some((g) => g && !g.endedAt);
// Busy, waiting, or idle. The activity feed (Claude's hooks and Grok's) wins over the session file:
// Claude's own status can still say busy after the turn has ended. A background shell, or a subagent
// the turn left running, keeps it busy. With no feed, the session file is all there is.
export function attentionFor({ activity, tasks = [], session, now = Date.now() } = {}) {
  const claude = activity?.claude;
  const working = tasks.length > 0 || liveAgents(activity);
  if (claude) {
    if (claude.state !== 'waiting' || working) return 'busy';
    if (now - (claude.since ?? 0) < WAIT_FOR_YOU) return 'waiting';
    return 'idle';
  }
  if (working || session?.status === 'busy') return 'busy';
  const since = session?.statusSince ?? 0;
  if (session && since && now - since < WAIT_FOR_YOU) return 'waiting';
  return 'idle';
}
// One flier per running subagent, in the colour the hooks gave it at spawn. A live named agent covers
// its task file and its Agent call, so a Claude subagent that has both is not drawn twice. Calls and
// task files with no named agent (the plugin was not loaded yet) still get a flier.
export function visitorsFor(activity, tasks = []) {
  const live = Object.entries(activity?.agents ?? {}).filter(([, g]) => g && !g.endedAt);
  const out = live.map(([id, g]) => ({ id, colour: g.colour ?? null }));
  const ids = new Set(live.map(([id]) => id));
  const foreground = live.filter(([, g]) => !g.background).length;
  const calls = (activity?.running ?? []).filter(isSubagentCall);
  calls.slice(foreground).forEach((c, i) => out.push({ id: c.id || `call${i}`, colour: null }));
  for (const t of tasks) if (t?.kind === 'agent' && !ids.has(t.id)) out.push({ id: `task:${t.id}`, colour: null });
  return out;
}
// The brief gate records its refusal as a failed tool call. That is the ?, not a flinch or a droop.
const isRefusal = (r, gate) => Boolean(!r.ok && gate && r.tool === gate.tool && Math.abs(r.at - gate.at) < 5000);
// A failed tool droops the pet until a later success. The brief gate's refusal is the ?, not a failure.
export function droopFor(activity) {
  const gate = activity?.gate;
  let fail = 0, okAt = 0;
  for (const r of activity?.recent ?? []) {
    if (isRefusal(r, gate)) continue;
    if (r.ok) okAt = Math.max(okAt, r.at);
    else fail = Math.max(fail, r.at);
  }
  return fail > okAt && fail > 0;
}
// When the newest failure is the gate's refusal, an older real failure in the same list still flinches.
// Returns that failure's time, or 0 when nothing new since `since` qualifies.
export function flinchAt(activity, since = 0) {
  const gate = activity?.gate;
  let at = 0;
  for (const r of activity?.recent ?? []) {
    if (r.ok || !(r.at > since) || isRefusal(r, gate)) continue;
    at = Math.max(at, r.at);
  }
  return at;
}
const PACE = 4; // columns it wanders either side of its spot on the road
const READY = ['.G.G.', 'GG.GG', '.....', 'GG.GG', '.G.G.']; // heavy: ready to merge, in gold
const PUFF = ['U.A.U', '.AUA.', 'AUUUA', '.AUA.', 'U.A.U']; // a failed tool call
const DROOP = ['.....', '.....', '..A..', '.A.A.', '.....']; // the failure, kept until the next success
const QUERY = ['.QQQ.', 'Q...Q', '..QQ.', '.....', '..Q..']; // the brief is not approved yet
const SPARK = [
  ['G.G.G', '.G.G.', '..G..', '.G.G.', 'G.G.G'],
  ['.G.G.', 'G...G', '.....', 'G...G', '.G.G.'],
];
const PUFF_MS = 1500, SPARK_MS = 1600, MAX_COMPANIONS = 3;
// A tiny "+n" for helpers the strip cannot draw. W is white.
const DIGIT = [
  ['WWW', 'W.W', 'W.W', 'W.W', 'WWW'], ['.W.', 'WW.', '.W.', '.W.', 'WWW'],
  ['WW.', '..W', '.W.', 'W..', 'WWW'], ['WWW', '..W', 'WW.', '..W', 'WWW'],
  ['W.W', 'W.W', 'WWW', '..W', '..W'], ['WWW', 'W..', 'WWW', '..W', 'WWW'],
  ['.WW', 'W..', 'WWW', 'W.W', 'WWW'], ['WWW', '..W', '.W.', '.W.', '.W.'],
  ['WWW', 'W.W', 'WWW', 'W.W', 'WWW'], ['WWW', 'W.W', 'WWW', '..W', '.WW'],
];
const badgeRows = (n) => {
  const d = DIGIT[Math.min(9, Math.max(0, n | 0))];
  return [0, 1, 2, 3, 4].map((y) => `${y === 0 || y === 2 ? '.W.' : y === 1 ? 'WWW' : '...'}.${d[y]}`);
};

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
  // A small drawing at (x0, y0), `sc` image pixels a dot, coloured by `rgbOf(key)`; '.' is transparent.
  const blit = (rows, x0, y0, sc, rgbOf) => rows.forEach((row, ry) => [...row].forEach((k, rx) => {
    if (k === '.') return;
    const rgb = rgbOf(k);
    for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) putRgb(x0 + rx * sc + dx, y0 + ry * sc + dy, rgb);
  }));
  for (const v of sprites) // visitors and companions: over the foliage, behind the creature, `up` pixels up
    blit(v.rows, v.px, floorY - (v.up + v.rows.length) * SCALE, SCALE, (k) => xtermRgb(v.palette[k]));
  for (let y = 0; y < SPR_H * scale; y++) for (let px = 0; px < SPR_W * scale; px++) {
    const key = rows[Math.floor(y / scale)][Math.floor(px / scale)];
    if (key !== '.') put(x + px, top + y, key);
  }
  if (mark) { // ready, a puff, a droop or a ?, a sprite pixel a dot, above the front (the right claw, or the head turned left)
    const ax = x + Math.round(SPR_W * scale * (flip ? 0.2 : 0.8)) - (flip ? mark[0].length * scale : 0), ay = Math.max(0, top - mark.length * scale - 2);
    blit(mark, ax, ay, scale, (k) => xtermRgb(colorOf(c, k)));
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
  let held = false, drooping = false, puffUntil = 0, sparkUntil = 0, doneN = 0, chunkN = 0, extraShells = 0;
  let lastStrip = { key: '', data: '' }; // the last strip drawn with visitors
  // The drawing for this stage: the creature's own stage form, or the creature itself.
  const form = () => CREATURES[index].stages?.[stage] ?? CREATURES[index];
  const width = () => (images ? Math.ceil((SPR_W * (form().scale ?? SCALE)) / colPx()) : SPR_W / 2); // columns it occupies
  const s = { x: 2, dir: 1, phase: 0, tick: 0, mode: 'walk', lastActive: now, blinkUntil: 0, hopI: -1, lift: 0, shake: 0, fidget: false, wake: 0, fidgetUntil: 0, party: null };
  const cache = new Map();
  const cached = (key, make) => {
    if (!cache.has(key)) { if (cache.size > 200) cache.clear(); cache.set(key, make()); }
    return cache.get(key);
  };
  const bounds = (W) => [1, W - 1 - width()];
  // The mark over its head. Red is only a failure. Gold is "ready" or a chunk just finished.
  const markFor = (t) => {
    if (s.mode === 'sleep') return null;
    if (t < puffUntil) return PUFF;
    if (held) return QUERY;
    if (drooping) return DROOP;
    if (t < sparkUntil) return SPARK[Math.floor(s.tick / 2) % 2];
    return MOOD[stage].rage && s.lift === 0 && Math.floor(s.tick / 3) % 2 ? READY : null;
  };
  const companionWidth = () => (images ? Math.ceil((6 * SCALE) / colPx()) : 3); // columns a little one takes
  // Babies copy the parent: tucked asleep, piled up when the gate holds, hidden behind it on a flinch.
  const littleOnes = (sleep, t) => {
    const cr = CREATURES[index], flip = s.dir < 0 && !cr.sideways;
    const hiding = s.shake > 0 || t < puffUntil;
    const body = sleep ? cr.baby.slice(1) : cr.baby;
    const rows = flip ? body.map((r) => [...r].reverse().join('')) : body;
    const cw = companionWidth();
    return companions.map((x, i) => ({
      x: hiding ? s.x + Math.max(0, Math.floor((width() - cw) / 2)) : x,
      rows, palette: cr.palette,
      bob: !sleep && !held && !hiding && (s.tick + i * 2) % 4 < 2 ? 1 : 0,
      stack: held && !hiding ? i * 3 : 0,
    }));
  };
  const columnPx = (col) => Math.round((col - 1) * colPx());
  // Gold either side of the pet for a moment after a chunk is marked Done.
  const sparks = (t) => (t < sparkUntil ? [s.x - 5, s.x + width() + 1] : []).map((x, i) => ({
    rows: SPARK[(Math.floor(s.tick / 2) + i) % 2], palette: { G: 220 }, x, up: 12 - i * 2,
  }));
  // A "+n" when more subagents or shells are running than the strip draws.
  const badges = (W) => {
    const out = [];
    if (flock.overflow) out.push({ rows: badgeRows(flock.overflow), palette: { W: 231 }, x: W - 8, up: 16 });
    if (extraShells) out.push({ rows: badgeRows(extraShells), palette: { W: 220 }, x: W - 8 - (flock.overflow ? 9 : 0), up: 16 });
    return out;
  };

  return {
    get width() { return width(); },
    // the strip (image, its own space above built in) or a blank spacer, the sprite and a floor row (text)
    get rows() { return images ? form().rows ?? STRIP_ROWS : SPR_H / 4 + 2; },
    get stage() { return stage; },
    // Grow or shrink to a stage (0 hatchling … 3 heavy); a hop in progress lands.
    setStage(n) { if (n !== stage && n >= 0 && n < MOOD.length) { stage = n; s.hopI = -1; s.lift = 0; s.shake = 0; } },
    // Its spot on the road, 0 … 1 (progressFor), or null to pace the whole strip.
    setProgress(f) { progress = f == null ? null : Math.max(0, Math.min(1, f)); },
    // Its Done chunks, drawn as a trail of markers along the road.
    setTrail(done, total) { doneN = Math.max(0, done | 0); chunkN = Math.max(0, total | 0); },
    // Subagents in flight: `{ id, colour }` each, so a flier keeps its agent. A count still works.
    setVisitors(n, W = 42) { flock.want(n, W); },
    // How many background shells are running: a little one trails behind for each, up to 3.
    setCompanions(n) {
      n = Math.max(0, n | 0);
      extraShells = Math.max(0, n - MAX_COMPANIONS);
      n = Math.min(MAX_COMPANIONS, n);
      while (companions.length < n) companions.push(companions.at(-1) ?? s.x);
      companions.length = n;
    },
    // A tool call failed: it flinches, a red puff pops, the fliers scatter, and it stays drooped.
    flinch(t = Date.now()) { s.shake = 4; puffUntil = t + PUFF_MS; drooping = true; flock.spook(s.tick); s.lastActive = t; },
    // The droop stays until a later tool call succeeds. The rail clears it.
    setDroop(on) { drooping = Boolean(on); },
    // A chunk was just marked Done: a hop and a short gold sparkle, then it walks to the new spot.
    celebrate(t = Date.now()) {
      sparkUntil = t + SPARK_MS; s.party = [1, 2, 3, 3, 2, 1]; s.hopI = 0; s.lastActive = t;
      if (s.mode === 'sleep') s.mode = 'walk';
    },
    // The brief is not approved: it stands still, awake, with a ? over its head.
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
    // `attention` is 'busy', 'waiting' or 'idle' (a boolean still means busy or idle).
    step(W, attention, t = Date.now()) {
      const want = attention === true || attention === 'busy' ? 'busy' : attention === 'waiting' ? 'wait' : 'idle';
      const c = form(), mood = MOOD[stage];
      const wasSleep = s.mode === 'sleep';
      s.tick++;
      if (want === 'busy' || want === 'wait' || held) s.lastActive = t;
      if (want === 'busy') s.mode = 'busy';
      else if (want === 'wait') s.mode = 'wait';
      else s.mode = t - s.lastActive > IDLE_MS ? 'sleep' : 'walk';
      if (wasSleep && s.mode !== 'sleep') { s.wake = 10; if (!s.party) { s.party = [1, 2, 2, 1]; s.hopI = 0; } }
      if (s.wake > 0 && s.mode !== 'sleep') s.wake--;
      flock.setCalm(s.mode !== 'busy');
      flock.step(s.x + width() / 2, W, s.tick, width() / 2, images ? Math.ceil((7 * SCALE) / colPx()) : 4);
      const [lo, hi] = bounds(W);
      s.x = Math.max(lo, Math.min(s.x, hi));
      const home = progress == null ? null : Math.round(lo + progress * (hi - lo)); // its spot on the road
      const cw = companionWidth(), hiding = s.shake > 0 || t < puffUntil;
      if (hiding || s.mode === 'sleep') {
        const cover = hiding ? s.x + Math.max(0, Math.floor((width() - cw) / 2)) : s.x - 1;
        companions.forEach((x, i) => { companions[i] = x + Math.sign((hiding ? cover : Math.max(1, cover - (i % 2))) - x); });
      } else if (held) { // piled on the heel, one spot, drawn stacked
        const heel = Math.max(1, Math.min(W - 1 - cw, s.dir < 0 ? s.x + width() + 1 : s.x - cw));
        companions.forEach((x, i) => { companions[i] = x + Math.sign(heel - x); });
      } else { // a column apart behind it, a column a tick at most
        const span = companions.length * (cw + 1);
        // on the road, the way it came; the side with more room when that one has too little. On the road the
        // room is judged from its spot, not where it paces, so they don't swing round it at every step.
        const ref = home ?? s.x, roomL = ref - lo, roomR = W - 1 - (ref + width());
        let left = progress != null || s.dir > 0;
        if ((left ? roomL : roomR) < span) left = roomL >= roomR;
        companions.forEach((x, i) => {
          const target = Math.max(1, Math.min(W - 1 - cw, left ? s.x - (i + 1) * (cw + 1) : s.x + width() + 1 + i * (cw + 1)));
          companions[i] = x + Math.sign(target - x);
        });
      }
      if (s.mode === 'sleep') { s.phase = 0; s.hopI = -1; s.lift = 0; s.shake = 0; s.fidget = false; s.party = null; return; }
      if (s.blinkUntil < t && Math.random() < 0.04) s.blinkUntil = t + 250;
      let a = lo, b = hi, heading = false;
      if (home != null) {
        a = Math.max(lo, home - PACE); b = Math.min(hi, home + PACE);
        if (s.x < a || s.x > b) { heading = true; s.dir = s.x < a ? 1 : -1; }
      }
      if (!held && s.mode === 'walk' && !heading && s.tick >= s.fidgetUntil && s.tick % 28 === 0) s.fidgetUntil = s.tick + 8;
      s.fidget = !held && (s.mode === 'wait' || s.wake > 0 || (s.mode === 'walk' && !heading && s.tick < s.fidgetUntil));
      if (held) { s.phase = 0; s.hopI = -1; s.lift = 0; s.fidget = false; if (s.shake > 0) s.shake--; return; }
      // Waiting looks toward the agent pane, which sits to the left of the rail. A crab has no face to turn.
      if (s.mode === 'wait' && !heading && !c.sideways) s.dir = -1;
      if (s.party) {
        if (s.hopI < 0) s.hopI = 0;
        s.lift = s.party[s.hopI++] ?? 0;
        if (s.hopI > s.party.length) { s.hopI = -1; s.party = null; }
      } else if (mood.hop) {
        if (s.hopI < 0 && s.tick % mood.hopEvery === 0) s.hopI = 0;
        if (s.hopI >= 0) { s.lift = mood.hop[s.hopI++] ?? 0; if (s.hopI > mood.hop.length) s.hopI = -1; }
      } else if (s.fidget) s.lift = [0, 1, 1, 0][s.tick % 4];
      else s.lift = 0;
      if (s.shake > 0) s.shake--;
      else if (mood.shake && s.hopI < 0 && Math.random() < mood.shake) s.shake = 4;
      if (s.fidget && !heading) { s.phase = 1 - s.phase; return; } // stretch, peek or snap, staying put
      const speed = Math.max(1, CREATURES[index].stages ? c.speed : c.speed + mood.dSpeed);
      const hurry = want === 'busy' || heading; // a frame a tick, and a column every frame
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
      const c = form();
      const sleep = s.mode === 'sleep';
      const pose = { frame: sleep ? 0 : s.phase, blink: !sleep && s.blinkUntil > t, sleep, dir: s.dir,
        z: sleep ? Math.floor(s.tick / 5) % 3 : 0, fidget: !sleep && s.fidget };
      const poseKey = `${index}:${stage}:${JSON.stringify(pose)}`;
      const habitat = CREATURES[index].habitat;
      const dustKind = sleep || held ? 'still' : s.lift > 0 ? 'hop' : (s.mode === 'busy' || s.mode === 'walk') && s.phase === 1 ? 'step' : 'still';
      if (images) {
        const scale = c.scale ?? SCALE, stripRows = c.rows ?? STRIP_ROWS;
        const jitter = s.shake ? (s.tick % 2 ? scale : -scale) : 0;
        const mark = markFor(t);
        const cols = W - 2, x = Math.round((s.x - 1) * colPx()) + jitter;
        const sway = SWAY[Math.floor(s.tick / 5) % SWAY.length] * (habitat === 'pond' && s.lift > 0 ? 2 : 1);
        const lift = s.lift - (drooping && s.lift <= 0 ? 1 : 0); // a failure sinks it until the next success
        const sprites = [
          ...flock.sprites(s.tick).map((v) => ({ ...v, up: 7 + Math.round(v.alt * 8), px: columnPx(v.x) })),
          ...littleOnes(sleep, t).map((v) => ({ ...v, up: v.bob + v.stack, px: columnPx(v.x) })),
          ...sparks(t).map((v) => ({ ...v, px: columnPx(v.x) })),
          ...badges(W).map((v) => ({ ...v, px: columnPx(v.x) })),
        ];
        const extras = sprites.map((v) => `${v.px},${v.up},${v.rows.join('')}`).join(';');
        const make = () => {
          const groundW = Math.ceil((cols * colPx()) / SCALE);
          const foot = Math.round(x / SCALE + (SPR_W * scale) / (2 * SCALE));
          const ground = [...foliage(habitat, groundW, sway), ...trail(habitat, doneN, chunkN, groundW), ...dust(habitat, foot, s.tick, dustKind)];
          return stripImage(c, pixels(c, pose), cols, colPx(), x, { scale, stripRows, lift, mark, flip: s.dir < 0 && !c.sideways, ground, sprites });
        };
        // Anything that moves every tick stays out of the long cache, so it isn't evicted by the walk.
        const key = `${poseKey}|${cols}|${x}|${aspect}|${lift}|${mark?.[0] ?? ''}|${sway}|${doneN}|${dustKind}|${extras}`;
        const live = flock.size || dustKind !== 'still' || t < sparkUntil || flock.overflow || extraShells;
        if (live && lastStrip.key !== key) lastStrip = { key, data: make() };
        const data = live ? lastStrip.data : cached(key, make);
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
      const marker = habitat === 'pond' ? { rows: ['NNNN', '.NN.'], palette: { N: 29 } }
        : habitat === 'beach' ? { rows: ['.SS.', 'S..S'], palette: { S: 181 } }
        : { rows: ['.RR.', '.S..'], palette: { R: 131, S: 187 } };
      for (let i = 0; i < Math.min(doneN, chunkN); i++) paint(marker, 1 + ((i + 0.5) / chunkN) * (W - 4), SPR_H / 4 - 1);
      for (const v of flock.sprites(s.tick)) paint(v, v.x, v.alt > 0.5 ? -1 : 0); // 2 cells high, behind it
      for (const v of littleOnes(sleep, t)) paint(v, v.x, SPR_H / 4 - 1 - (v.stack > 2 ? 1 : 0));
      for (const v of sparks(t)) paint(v, v.x, -1);
      for (const v of badges(W)) paint(v, v.x, -1);
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

    get state() {
      return { ...s, stage, creature: CREATURES[index].name, droop: drooping, spark: sparkUntil, overflow: flock.overflow, shells: extraShells };
    },
  };
}

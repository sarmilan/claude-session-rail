// The rail's mascots. Each one draws itself facing right on a 34×16 pixel canvas for a pose
//   { frame: 0 | 1, blink: boolean, sleep: boolean }
// Frames 0 and 1 alternate as it moves; `advance[i]` says whether entering frame i moves it a column.
// Palette letters map to xterm-256 colours ('.' is transparent). `zAt` is where sleeping z's float.
// `sideways` creatures (the crab) never turn round, they just walk the other way. `speed` is ticks per
// frame (a tick is ~200ms); busy creatures go at one frame a tick.
export const SPR_W = 34, SPR_H = 16;

function canvas(lift = 0) {
  const g = Array.from({ length: SPR_H }, () => Array(SPR_W).fill('.'));
  const set = (y, x, c) => {
    y = Math.round(y - lift); x = Math.round(x);
    if (x >= 0 && x < SPR_W && y >= 0 && y < SPR_H) g[y][x] = c;
  };
  const span = (y, a, b, c) => { for (let x = a; x <= b; x++) set(y, x, c); };
  const vline = (x, a, b, c) => { for (let y = a; y <= b; y++) set(y, x, c); };
  const ell = (cx, cy, rx, ry, c) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
        if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) set(y, x, c);
  };
  // 2×2 eye: white with the pupil at the front, or shut (a lid over a dark lash line).
  const eye = (x, y, shut, lid) => {
    if (shut) { span(y, x, x + 1, lid); span(y + 1, x, x + 1, 'K'); return; }
    span(y, x, x + 1, 'E'); set(y + 1, x, 'E'); set(y + 1, x + 1, 'P');
  };
  return { set, span, vline, ell, eye, rows: () => g.map((r) => r.join('')) };
}

// ── Claudey the snail ──────────────────────────────────────────────────────────
const SHELL = [[6, 11], [4, 13], [3, 14], [2, 15], [2, 16], [1, 16], [1, 16], [1, 16], [1, 16], [2, 15], [2, 15], [3, 14]];
const SPIRAL = { 3: [8, 9, 10, 11], 4: [6, 7, 12, 13], 5: [5, 9, 10, 14], 6: [5, 8, 11, 14], 7: [5, 8, 10, 14],
  8: [6, 9, 13], 9: [7, 8, 11, 12], 10: [9, 10] };
const SHINE = { 1: [6, 7], 2: [6], 4: [3], 5: [2] };

const snail = {
  speed: 3,
  name: 'Claudey the snail',
  palette: { S: 71, D: 28, W: 157, B: 114, E: 231, P: 233 },
  advance: [true, false], // stretch forward, then the shell catches up
  zAt: [[20, 8], [26, 2]],
  draw({ frame, blink, sleep }) {
    const { set, span, rows } = canvas();
    const s = frame && !sleep ? 2 : 0;
    if (sleep) { span(12, 2, 16, 'B'); span(13, 1, 17, 'B'); span(14, 1, 17, 'B'); span(15, 2, 16, 'B'); }
    else {
      span(12, 2, 30 + s, 'B'); span(13, 1, 30 + s, 'B'); span(14, 0, 29 + s, 'B'); span(15, 1, 29 + s, 'B');
      span(6, 26 + s, 29 + s, 'B'); span(7, 25 + s, 30 + s, 'B');
      span(8, 24 + s, 31 + s, 'B'); span(9, 24 + s, 31 + s, 'B'); span(10, 23 + s, 31 + s, 'B'); span(11, 23 + s, 30 + s, 'B');
      set(4, 25 + s, 'B'); set(4, 30 + s, 'B'); span(5, 25 + s, 26 + s, 'B'); span(5, 29 + s, 30 + s, 'B');
      for (const ex of [24 + s, 30 + s]) for (let y = 0; y < 4; y++) {
        const c = !blink ? 'E' : y === 3 ? 'B' : '.';
        set(y, ex, c); set(y, ex + 1, c);
      }
      if (!blink) { set(1, 25 + s, 'P'); set(1, 31 + s, 'P'); }
      set(10, 29 + s, 'P');
    }
    SHELL.forEach(([a, b], y) => span(y, a, b, 'S'));
    for (const [y, xs] of Object.entries(SPIRAL)) for (const x of xs) set(+y, x, 'D');
    for (const [y, xs] of Object.entries(SHINE)) for (const x of xs) set(+y, x, 'W');
    span(12, 4, 15, 'D');
    return rows();
  },
};

// ── Turtle ─────────────────────────────────────────────────────────────────────
const turtle = {
  speed: 4,
  name: 'Turtle',
  palette: { S: 65, H: 22, R: 58, W: 108, L: 149, l: 106, K: 22, E: 231, P: 233 },
  advance: [true, false],
  zAt: [[24, 7], [28, 1]],
  draw({ frame, blink, sleep }) {
    const { set, span, vline, ell, eye, rows } = canvas();
    const y0 = sleep ? 2 : 0; // tucked in, the shell rests on the ground
    // shell dome with plates
    ell(15, 11 + y0, 11, 9, 'S');
    for (let x = 4; x <= 26; x++) for (let y = 11 + y0; y < 16; y++) set(y, x, '.');
    span(11 + y0, 4, 26, 'R'); span(12 + y0, 6, 24, 'R');
    span(7 + y0, 7, 23, 'H');
    vline(11, 3 + y0, 7 + y0, 'H'); vline(19, 3 + y0, 7 + y0, 'H');
    vline(7, 7 + y0, 10 + y0, 'H'); vline(15, 7 + y0, 10 + y0, 'H'); vline(23, 7 + y0, 10 + y0, 'H');
    span(3 + y0, 13, 14, 'W'); span(4 + y0, 12, 12, 'W'); set(5 + y0, 6, 'W'); set(4 + y0, 8, 'W');
    if (!sleep) {
      // legs (behind the shell), swapping front/back reach each step
      const f = frame ? 2 : 0, b = frame ? -2 : 0;
      for (const x of [11 - b, 23 - f]) { vline(x, 13, 14, 'l'); vline(x + 1, 13, 14, 'l'); span(15, x, x + 2, 'l'); }
      for (const x of [6 + b, 19 + f]) { vline(x, 13, 14, 'L'); vline(x + 1, 13, 14, 'L'); vline(x + 2, 13, 14, 'L'); span(15, x - 1, x + 2, 'L'); }
      // tail, neck, head
      span(10, 2, 5, 'L'); set(11, 3, 'L');
      span(8, 24, 27, 'L'); span(9, 24, 28, 'L'); span(10, 24, 27, 'L');
      ell(29.5, 7.5, 3.5, 2.8, 'L');
      eye(29, 6, blink, 'L');
      span(9, 31, 32, 'K');
    }
    return rows();
  },
};

// ── Frog ───────────────────────────────────────────────────────────────────────
const frog = {
  speed: 3,
  name: 'Frog',
  palette: { G: 76, D: 28, Y: 193, K: 22, E: 231, P: 233, M: 22 },
  advance: [true, false], // frame 1 is the hop; it lands a column on
  zAt: [[30, 6], [31, 0]],
  draw({ frame, blink, sleep }) {
    const air = frame && !sleep;
    const { set, span, vline, ell, eye, rows } = canvas(air ? 3 : 0);
    if (air) { // legs trailing out behind mid-hop
      span(12, 1, 9, 'G'); span(13, 0, 6, 'D');
      span(14, 23, 26, 'G'); span(15, 25, 28, 'D');
    } else {
      ell(9, 12, 5, 3.2, 'G'); span(15, 3, 13, 'D'); set(14, 4, 'D'); // folded back leg
      vline(23, 12, 15, 'G'); vline(24, 12, 15, 'G'); span(15, 23, 27, 'D');
    }
    ell(16, 10, 9, 4.5, 'G');
    ell(24.5, 8, 6.5, 4, 'G');
    ell(17.5, 12.3, 6.5, 2.2, 'Y');
    ell(23, 4.5, 2.6, 2.6, 'G'); ell(28, 4.5, 2.6, 2.6, 'G');
    if (!sleep) set(9, 9, 'G');
    for (const [x, y] of [[11, 7], [14, 6], [17, 7], [9, 9], [20, 6]]) set(y, x, 'D');
    eye(22, 4, blink || sleep, 'G'); eye(27, 4, blink || sleep, 'G');
    span(9, 26, 30, 'M'); set(8, 31, 'M');
    return rows();
  },
};

// ── Bunny ──────────────────────────────────────────────────────────────────────
const bunny = {
  speed: 2,
  name: 'Bunny',
  palette: { W: 255, G: 250, N: 218, K: 238, P: 233, E: 233 },
  advance: [true, false],
  zAt: [[28, 7], [30, 1]],
  draw({ frame, blink, sleep }) {
    const air = frame && !sleep;
    const { set, span, vline, ell, rows } = canvas(air ? 3 : 0);
    // ears: up and alert; swept back mid-hop; laid flat asleep
    if (sleep) { span(7, 14, 21, 'W'); span(8, 13, 21, 'G'); span(7, 16, 19, 'N'); }
    else if (air) { ell(18, 3.5, 4, 1.2, 'W'); ell(19, 5, 4, 1.2, 'W'); span(5, 17, 20, 'N'); }
    else { ell(21.5, 3, 1.3, 3.6, 'W'); ell(24.5, 2.6, 1.3, 3.6, 'W'); vline(21, 1, 4, 'N'); vline(24, 1, 4, 'N'); }
    if (air) { span(13, 6, 12, 'G'); span(14, 2, 7, 'W'); span(13, 20, 23, 'W'); span(14, 22, 25, 'W'); }
    else { ell(11, 13, 4.5, 2.8, 'W'); span(15, 8, 16, 'W'); vline(19, 12, 15, 'W'); vline(20, 12, 15, 'W'); span(15, 19, 22, 'W'); }
    ell(14, 10.5, 8, 4.5, 'W');
    ell(12, 13, 6, 1.5, 'G');
    ell(23.5, 7.8, 4.6, 3.6, 'W');
    ell(5.5, 9, 2.2, 2.2, 'W'); set(10, 4, 'G');
    if (blink || sleep) { span(7, 24, 25, 'K'); } else { span(6, 25, 25, 'E'); span(7, 25, 26, 'P'); }
    set(8, 28, 'N'); set(9, 27, 'G');
    return rows();
  },
};

// ── Cat ────────────────────────────────────────────────────────────────────────
const cat = {
  speed: 2,
  name: 'Cat',
  palette: { O: 208, D: 166, W: 230, N: 211, K: 94, G: 148, P: 233, E: 148 },
  advance: [true, true], // trots: a column every step
  zAt: [[25, 6], [29, 0]],
  draw({ frame, blink, sleep }) {
    const { set, span, vline, ell, rows } = canvas();
    if (sleep) { // curled up loaf, tail wrapped round the front
      ell(17, 11.5, 11, 4.5, 'O');
      for (const x of [11, 15, 19]) { set(8, x, 'D'); set(9, x, 'D'); }
      ell(26, 11, 4.5, 3.5, 'O'); set(8, 24, 'O'); set(8, 28, 'O'); set(7, 24, 'O'); set(7, 28, 'O');
      span(11, 25, 26, 'K'); span(11, 28, 28, 'K'); set(12, 29, 'N');
      span(15, 8, 26, 'D'); span(14, 6, 7, 'D');
      return rows();
    }
    // tail up and curling, swishing between frames
    const t = frame ? 1 : 0;
    vline(4, 4, 8, 'O'); vline(5, 6, 9, 'O'); set(3 + t, 3, 'O'); set(2 + t, 2 + t, 'O'); set(3 - t, 4, 'D');
    // legs: diagonal pairs swap each step; white paws
    const legs = frame ? [8, 12, 20, 24] : [10, 9, 22, 21];
    legs.forEach((x, i) => { const back = i % 2; vline(x, 11, 14, back ? 'D' : 'O'); vline(x + 1, 11, 14, back ? 'D' : 'O'); span(15, x, x + 1, 'W'); });
    ell(15, 9, 10.5, 3.3, 'O');
    for (const x of [10, 13, 16, 19]) { set(6, x, 'D'); set(7, x, 'D'); }
    ell(27, 6.6, 4.4, 3.6, 'O');
    span(2, 24, 24, 'O'); span(3, 24, 25, 'O'); set(3, 25, 'N');
    span(2, 29, 29, 'O'); span(3, 28, 29, 'O'); set(3, 28, 'N');
    if (blink) span(6, 28, 29, 'K'); else { set(6, 28, 'G'); set(6, 29, 'P'); set(5, 28, 'G'); }
    set(7, 31, 'N'); span(9, 25, 26, 'W'); span(9, 30, 31, 'W'); span(8, 28, 30, 'W');
    return rows();
  },
};

// ── Crab ───────────────────────────────────────────────────────────────────────
const crab = {
  speed: 2,
  name: 'Crab',
  palette: { C: 209, D: 166, K: 88, E: 231, P: 233 },
  advance: [true, true],
  sideways: true,
  zAt: [[14, 3], [18, 0]],
  draw({ frame, blink, sleep }) {
    const { set, span, vline, ell, rows } = canvas();
    // legs: three a side, tips stepping in and out
    const k = frame && !sleep ? 1 : 0;
    for (const [i, x] of [[0, 10], [1, 12], [2, 14]]) {
      const lx = x - 4 - (i + k) % 2, rx = 33 - x + 4 + (i + k) % 2;
      span(12 + (i > 0 ? 1 : 0), lx, x, 'D'); set(14 + (i > 1 ? 1 : 0), lx, 'D'); set(15, lx - 1 + (i % 2), 'D');
      span(12 + (i > 0 ? 1 : 0), 33 - x, rx, 'D'); set(14 + (i > 1 ? 1 : 0), rx, 'D'); set(15, rx + 1 - (i % 2), 'D');
    }
    ell(17, 10, 8.5, 3.8, 'C');
    span(12, 10, 23, 'D');
    // arms and claws: open/closed with the step, tucked down asleep
    const open = frame && !sleep;
    const cy = sleep ? 8 : 4; // claw centre row
    for (const side of [-1, 1]) {
      const X = (x) => (side < 0 ? x : 33 - x); // draw the left claw, mirror for the right
      // arm: from the body's shoulder up to the claw
      set(10, X(9), 'C'); set(9, X(8), 'C'); set(9, X(7), 'C'); set(8, X(6), 'C'); if (!sleep) { set(7, X(6), 'C'); set(6, X(5), 'C'); }
      // claw: a fat lower pincer and a thinner upper one, gap between them
      for (const [dx, dy] of [[1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [1, 2], [2, 2], [3, 2], [4, 2]]) set(cy + dy, X(dx), 'C');
      const up = open ? -2 : -1;
      for (const [dx, dy] of [[1, up], [2, up], [3, up], [4, up + (open ? 1 : 0)], [0, up + 1]]) set(cy + dy, X(dx), 'C');
      if (!open) span(cy, Math.min(X(2), X(4)), Math.max(X(2), X(4)), 'D');
      set(cy + 1, X(1), 'D');
    }
    // eyes on stalks
    for (const x of [14, 19]) {
      if (sleep) { span(7, x, x + 1, 'C'); span(8, x, x + 1, 'K'); continue; }
      vline(x, 4, 7, 'D');
      span(2, x - 1 + 1, x + 1, 'E'); span(3, x, x + 1, blink ? 'C' : 'E');
      if (blink) span(2, x, x + 1, 'C'); else set(3, x + 1, 'P');
    }
    span(10, 16, 18, 'K');
    return rows();
  },
};

// ── Chinese zodiac ─────────────────────────────────────────────────────────────
// Shared bits for the four-legged walkers: diagonal leg pairs swap each step (far legs darker), and
// asleep they lie down: drawn 2px lower with no legs and eyes shut.
const legs4 = ({ vline, span }, frame, [a, b], top, near, far, paw = near, w = 2) => {
  (frame ? b : a).forEach((x, i) => {
    const c = i % 2 ? far : near;
    for (let k = 0; k < w; k++) vline(x + k, top, 14, c);
    span(15, x, x + w - 1, paw);
  });
};
const dot = ({ set, span }, x, y, shut) => (shut ? span(y, x, x + 1, 'K') : set(y, x, 'P'));

const rat = {
  speed: 2, name: 'Rat', palette: { G: 246, D: 243, N: 218, P: 233, K: 240 },
  advance: [true, true], zAt: [[26, 6], [29, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -1 : 0), { set, span, ell } = c;
    span(13, 2, 9, 'N'); set(12, 1, 'N'); set(11, 1, 'N'); set(10, 2, 'N'); // tail
    if (!sleep) legs4(c, frame, [[11, 19, 13, 21], [13, 21, 11, 19]], 13, 'N', 'N', 'N', 1);
    ell(16, 11.5, 7.5, 3.4, 'G'); ell(16, 13.3, 6, 1.4, 'D');
    ell(24, 10.8, 4.2, 2.7, 'G'); span(11, 27, 28, 'G'); set(11, 29, 'N');
    ell(22, 7.8, 1.9, 1.9, 'G'); set(8, 22, 'N');
    dot(c, 25, 10, blink || sleep);
    return c.rows();
  },
};

const ox = {
  speed: 4, name: 'Ox', palette: { B: 94, D: 52, H: 230, M: 180, P: 233, K: 52 },
  advance: [true, true], zAt: [[23, 4], [27, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -2 : 0), { set, span, vline, ell } = c;
    vline(5, 6, 11, 'B'); span(12, 4, 6, 'D'); // tail and tuft
    if (!sleep) legs4(c, frame, [[8, 20, 11, 23], [10, 22, 7, 19]], 12, 'B', 'D', 'D');
    ell(15, 8.5, 10, 4.5, 'B');
    ell(27, 7.5, 3.6, 3.4, 'B'); ell(29.5, 9.6, 2.3, 1.7, 'M'); set(9, 30, 'D');
    span(4, 24, 25, 'H'); set(3, 23, 'H'); span(4, 29, 30, 'H'); set(3, 31, 'H'); // horns
    set(5, 23, 'D'); dot(c, 27, 7, blink || sleep);
    return c.rows();
  },
};

const tiger = {
  speed: 2, name: 'Tiger', palette: { O: 208, S: 233, W: 231, P: 233, K: 233, N: 211 },
  advance: [true, true], zAt: [[25, 6], [29, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -2 : 0), { set, span, ell } = c;
    const t = frame ? 1 : 0; // tail swish
    span(7, 2, 5, 'O'); set(6, 1, 'O'); set(5 + t, 1, 'O'); set(4 + t, 1, 'S'); set(7, 3, 'S');
    if (!sleep) legs4(c, frame, [[8, 20, 11, 23], [10, 22, 7, 19]], 11, 'O', 'O', 'W');
    ell(15, 8.8, 10.5, 3.4, 'O');
    for (const x of [9, 12, 15, 18, 21]) { set(6, x, 'S'); set(7, x, 'S'); set(8, x + 1, 'S'); }
    ell(27, 6.8, 4.4, 3.8, 'O'); ell(28.8, 8.6, 2.4, 1.4, 'W');
    span(3, 24, 25, 'O'); span(3, 29, 30, 'O'); set(5, 25, 'S'); set(4, 27, 'S');
    set(8, 31, 'N'); dot(c, 28, 6, blink || sleep);
    return c.rows();
  },
};

const dragon = {
  speed: 2, name: 'Dragon', palette: { R: 160, D: 88, Y: 220, G: 214, P: 233, K: 88, E: 231 },
  advance: [true, true], zAt: [[27, 9], [30, 3]],
  draw({ frame, blink, sleep }) {
    const c = canvas(), { set, span, vline, ell } = c;
    // a long body rippling through a sine wave; the ripple travels as it walks
    const ph = sleep ? 0 : frame * Math.PI;
    const amp = sleep ? 1 : 2.4;
    for (let x = 1; x <= 25; x++) {
      const y = Math.round(9.5 + amp * Math.sin(x / 3.4 + ph));
      vline(x, y - 1, y + 1, 'R'); set(y + 2, x, 'Y'); if (x % 3 === 0) set(y - 2, x, 'G');
    }
    // little legs at the crests
    if (!sleep) for (const x of [7, 19]) { const y = Math.round(9.5 + amp * Math.sin(x / 3.4 + ph)); vline(x, y + 2, 15, 'D'); span(15, x, x + 1, 'Y'); }
    // head with gold mane and antlers
    const hy = Math.round(7 + (sleep ? 3 : 0));
    ell(28.5, hy, 4, 2.6, 'R'); span(hy + 1, 30, 32, 'D'); set(hy + 2, 32, 'Y');
    ell(25, hy + 1, 1.8, 2.6, 'G'); set(hy - 3, 27, 'Y'); set(hy - 4, 26, 'Y'); set(hy - 3, 30, 'Y'); set(hy - 4, 31, 'Y');
    if (blink || sleep) span(hy - 1, 29, 30, 'K'); else { set(hy - 1, 29, 'E'); set(hy - 1, 30, 'P'); }
    return c.rows();
  },
};

const snake = {
  speed: 2, name: 'Snake', palette: { G: 70, D: 22, Y: 185, R: 196, P: 233, K: 22 },
  advance: [true, true], zAt: [[22, 6], [26, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(), { set, span, vline, ell } = c;
    if (sleep) { // coiled up
      ell(15, 11.5, 9, 4, 'G'); ell(15, 11.5, 6, 2.4, 'D'); ell(15, 11.5, 3.5, 1.3, 'G');
      for (const x of [9, 13, 17, 21]) set(8, x, 'Y');
      ell(21, 8.5, 3, 2, 'G'); span(8, 22, 23, 'K');
      return c.rows();
    }
    const ph = frame * Math.PI;
    for (let x = 1; x <= 26; x++) {
      const y = Math.round(12.5 + 1.8 * Math.sin(x / 2.6 + ph));
      vline(x, y - 1, y, 'G'); if (x % 4 === 0) set(y - 1, x, 'Y'); set(y + 1, x, 'D');
    }
    ell(29.5, 11.5, 3, 2, 'G'); span(13, 27, 31, 'D');
    if (blink) span(11, 30, 30, 'K'); else set(10, 30, 'P');
    if (frame) { span(12, 33, 33, 'R'); set(11, 33, 'R'); } // tongue flick
    return c.rows();
  },
};

const horse = {
  speed: 2, name: 'Horse', palette: { B: 130, D: 52, W: 231, P: 233, K: 52 },
  advance: [true, true], zAt: [[24, 5], [28, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -3 : 0), { set, span, vline, ell } = c;
    vline(4, 5, 10, 'D'); vline(3, 7, 12, 'D'); set(4, 5, 'D'); // tail
    if (!sleep) legs4(c, frame, [[7, 19, 10, 22], [9, 21, 6, 18]], 10, 'B', 'D', 'D', 1);
    ell(13.5, 7.5, 9, 3.4, 'B');
    for (let i = 0; i < 5; i++) { span(6 - i, 20 + i, 23 + i, 'B'); set(5 - i, 20 + i, 'D'); } // neck + mane
    ell(28, 2.6, 3.8, 1.9, 'B'); span(3, 30, 31, 'B'); set(2, 31, 'W'); set(0, 25, 'B'); set(0, 26, 'D');
    dot(c, 27, 2, blink || sleep);
    return c.rows();
  },
};

const goat = {
  speed: 3, name: 'Goat', palette: { W: 254, G: 248, H: 137, P: 233, K: 243 },
  advance: [true, true], zAt: [[25, 6], [29, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -3 : 0), { set, span, ell } = c;
    span(6, 5, 6, 'W'); set(5, 5, 'W'); // tail
    if (!sleep) legs4(c, frame, [[9, 19, 11, 21], [11, 21, 8, 18]], 11, 'W', 'G', 'K', 1);
    ell(14.5, 8.8, 8.5, 3.3, 'W'); ell(14.5, 10.5, 6, 1.4, 'G');
    ell(25, 7, 3.2, 2.5, 'W'); span(8, 27, 28, 'W'); set(10, 26, 'G'); set(11, 26, 'G'); // muzzle + beard
    set(4, 24, 'H'); set(3, 23, 'H'); set(3, 22, 'H'); set(4, 21, 'H'); set(5, 21, 'H'); // horns curling back
    set(6, 22, 'G'); dot(c, 26, 6, blink || sleep);
    return c.rows();
  },
};

const monkey = {
  speed: 2, name: 'Monkey', palette: { B: 137, D: 94, F: 223, P: 233, K: 94 },
  advance: [true, true], zAt: [[26, 3], [29, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -3 : 0), { set, span, vline, ell } = c;
    // tail curling up behind
    vline(7, 4, 9, 'B'); set(3, 6, 'B'); set(2, 5, 'B'); set(3, 4, 'B'); set(4, 4, 'B');
    if (!sleep) legs4(c, frame, [[10, 19, 12, 21], [12, 21, 9, 18]], 10, 'B', 'D', 'D');
    ell(14.5, 8.5, 6.5, 3.6, 'B');
    ell(23, 6, 3.6, 3.6, 'B'); ell(24.3, 6.6, 2.3, 2.3, 'F'); ell(20.2, 5.6, 1.2, 1.3, 'F');
    dot(c, 24, 5, blink || sleep); dot(c, 26, 5, blink || sleep); span(8, 24, 25, 'D');
    return c.rows();
  },
};

const rooster = {
  speed: 2, name: 'Rooster', palette: { W: 255, G: 251, R: 196, Y: 220, T: 29, K: 236, P: 233 },
  advance: [true, true], zAt: [[25, 7], [28, 1]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -3 : 0), { set, span, vline, ell } = c;
    // tail feathers
    ell(7, 5, 3, 4, 'T'); ell(6.5, 6, 1.6, 3, 'K'); set(1, 8, 'T'); set(2, 4, 'T');
    if (!sleep) { // legs step alternately
      const [a, b] = frame ? [13, 18] : [15, 16];
      vline(a, 12, 15, 'Y'); vline(b, 12, 15, 'Y'); span(15, a, a + 1, 'Y'); span(15, b, b + 1, 'Y');
    }
    ell(15, 8.5, 6.5, 4, 'W'); ell(13, 9, 3.5, 2, 'G');
    const bob = frame && !sleep ? 1 : 0; // head bobs as it steps
    ell(21.5 + bob, 4.5 + bob, 2.6, 2.6, 'W'); span(7, 19, 21, 'W');
    span(1 + bob, 20 + bob, 22 + bob, 'R'); set(0 + bob, 21 + bob, 'R'); set(7 + bob, 23 + bob, 'R');
    span(5 + bob, 24 + bob, 25 + bob, 'Y');
    if (blink || sleep) span(4 + bob, 22 + bob, 22 + bob, 'K'); else set(4 + bob, 22 + bob, 'P');
    return c.rows();
  },
};

const dog = {
  speed: 2, name: 'Dog', palette: { T: 179, D: 137, W: 230, P: 233, K: 94, N: 233 },
  advance: [true, true], zAt: [[26, 5], [29, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -2 : 0), { set, span, ell } = c;
    // tail up, wagging
    if (frame) { set(7, 6, 'T'); set(6, 5, 'T'); set(5, 4, 'T'); set(4, 4, 'T'); }
    else { set(7, 6, 'T'); set(6, 6, 'T'); set(5, 6, 'T'); set(4, 7, 'T'); }
    if (!sleep) legs4(c, frame, [[9, 19, 12, 22], [11, 21, 8, 18]], 11, 'T', 'D', 'W');
    ell(15, 9, 8.5, 3.1, 'T'); ell(15, 10.6, 6, 1.4, 'W');
    ell(25, 6.6, 3.5, 3, 'T'); ell(28.5, 7.6, 2.1, 1.5, 'T'); set(7, 30, 'N');
    ell(23.3, 6.8, 1.1, 2.4, 'D');
    dot(c, 26, 5, blink || sleep);
    return c.rows();
  },
};

const pig = {
  speed: 3, name: 'Pig', palette: { N: 217, D: 175, S: 211, P: 233, K: 175 },
  advance: [true, true], zAt: [[26, 5], [29, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -2 : 0), { set, span, ell } = c;
    set(8, 5, 'D'); set(7, 4, 'D'); set(6, 5, 'D'); set(6, 6, 'D'); // curly tail
    if (!sleep) legs4(c, frame, [[9, 18, 11, 20], [11, 20, 8, 17]], 12, 'N', 'D', 'D');
    ell(15, 9.5, 9, 4.3, 'N');
    ell(25, 8.5, 3.6, 3.3, 'N'); ell(28.6, 9.2, 1.7, 1.6, 'S'); set(9, 28, 'D'); set(9, 29, 'D');
    set(5, 23, 'D'); set(5, 24, 'D'); set(6, 24, 'D'); // ear
    dot(c, 26, 7, blink || sleep);
    return c.rows();
  },
};

export const CREATURES = [snail, turtle, frog, cat, crab,
  rat, ox, tiger, bunny, dragon, snake, horse, goat, monkey, rooster, dog, pig];

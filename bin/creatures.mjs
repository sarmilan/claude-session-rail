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

export const CREATURES = [snail, turtle, crab];

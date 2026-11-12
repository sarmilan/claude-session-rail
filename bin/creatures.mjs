// The rail's mascots. Each one draws itself facing right on a 34×16 pixel canvas for a pose
//   { frame: 0 | 1, blink: boolean, sleep: boolean }
// Frames 0 and 1 alternate as it moves; `advance[i]` says whether entering frame i moves it a column.
// Palette letters map to xterm-256 colours ('.' is transparent). `zAt` is where sleeping z's float.
// `sideways` creatures (the crab) never turn round, they just walk the other way. `speed` is ticks per
// frame (a tick is ~200ms); busy creatures go at one frame a tick. `habitat` names the foliage it walks
// through (habitats.mjs).
// `stages` (optional): four forms, hatchling → heavy, that the mascot grows through as the branch's
// brief heads toward its compaction (stageFor in mascot.mjs); a stage form is drawn like a creature and
// may set `scale` (image pixels per sprite pixel, default 4) and `rows` (terminal rows, default 3) to be
// drawn bigger.
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
  // Copy the left half onto the right, so a symmetric creature only draws one side.
  const mirror = () => { for (const r of g) for (let x = 0; x < SPR_W / 2; x++) r[SPR_W - 1 - x] = r[x]; };
  return { set, span, vline, ell, eye, mirror, rows: () => g.map((r) => r.join('')) };
}

// ── Claudey the snail ──────────────────────────────────────────────────────────
const SHELL = [[6, 11], [4, 13], [3, 14], [2, 15], [2, 16], [1, 16], [1, 16], [1, 16], [1, 16], [2, 15], [2, 15], [3, 14]];
const SPIRAL = { 3: [8, 9, 10, 11], 4: [6, 7, 12, 13], 5: [5, 9, 10, 14], 6: [5, 8, 11, 14], 7: [5, 8, 10, 14],
  8: [6, 9, 13], 9: [7, 8, 11, 12], 10: [9, 10] };
const SHINE = { 1: [6, 7], 2: [6], 4: [3], 5: [2] };

const snail = {
  speed: 3,
  name: 'Claudey the snail',
  habitat: 'woodland',
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

// A coiled shell: rings of shell and dark line around a dark core, with a shine at the top left.
const shellRings = ({ ell, set }, cx, cy, rx, ry, shine) => {
  ell(cx, cy, rx, ry, 'S');
  ell(cx + rx * 0.06, cy, rx * 0.72, ry * 0.72, 'D'); ell(cx + rx * 0.06, cy, rx * 0.56, ry * 0.55, 'S');
  ell(cx + rx * 0.1, cy + ry * 0.05, rx * 0.34, ry * 0.32, 'D'); ell(cx + rx * 0.1, cy + ry * 0.05, rx * 0.18, ry * 0.15, 'S');
  for (const [y, x] of shine) set(y, x, 'W');
};

const snailHatchling = {
  speed: 4,
  palette: { S: 114, D: 71, W: 194, B: 157, K: 71, E: 231, P: 233 },
  advance: [true, false],
  zAt: [[19, 4], [24, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(), { set, span, vline, ell, eye, rows } = c;
    const s = frame && !sleep ? 1 : 0;
    if (sleep) { span(14, 10, 18, 'B'); span(15, 9, 19, 'B'); }
    else {
      span(14, 10, 24 + s, 'B'); span(15, 9, 24 + s, 'B');
      ell(23 + s, 11.6, 2.6, 2.3, 'B');
      vline(22 + s, 8, 9, 'B'); vline(25 + s, 8, 9, 'B');
      eye(21 + s, 6, blink, 'B'); eye(24 + s, 6, blink, 'B');
      set(12, 24 + s, 'P');
    }
    shellRings(c, 14, 10.6, 5, 4.4, [[7, 12], [8, 11]]);
    span(14, 11, 17, 'D');
    return rows();
  },
};

const snailAdult = {
  speed: 2,
  palette: { S: 35, D: 22, W: 121, B: 78, K: 22, E: 231, P: 233 },
  advance: [true, false],
  zAt: [[21, 6], [26, 1]],
  draw({ frame, blink, sleep }) {
    const c = canvas(), { span, vline, ell, eye, rows } = c;
    const s = frame && !sleep ? 2 : 0;
    if (sleep) { span(13, 2, 18, 'B'); span(14, 1, 19, 'B'); span(15, 1, 19, 'B'); }
    else {
      span(12, 8, 29 + s, 'B'); span(13, 1, 30 + s, 'B'); span(14, 0, 30 + s, 'B'); span(15, 1, 30 + s, 'B');
      ell(27.5 + s, 9.2, 3.8, 3.2, 'B');
      vline(26 + s, 3, 6, 'B'); vline(30 + s, 3, 6, 'B');
      eye(25 + s, 1, blink, 'B'); eye(30 + s, 1, blink, 'B');
      span(0, 24 + s, 26 + s, 'K'); span(0, 30 + s, 32 + s, 'K');                  // brows
      span(10, 29 + s, 30 + s, 'K');
    }
    shellRings(c, 10, 7, 9.6, 7.2, [[2, 5], [2, 6], [3, 4], [4, 3]]);
    span(13, 3, 17, 'D');
    return rows();
  },
};

const snailHeavy = {
  speed: 1,
  scale: 5, rows: 4, // drawn bigger, a row taller
  palette: { S: 29, D: 22, W: 72, B: 107, X: 223, K: 52, E: 231, P: 160 },
  advance: [true, false],
  zAt: [[22, 6], [27, 1]],
  draw({ frame, blink, sleep }) {
    const c = canvas(), { set, span, vline, ell, eye, rows } = c;
    const s = frame && !sleep ? 2 : 0;
    if (sleep) { span(13, 1, 20, 'B'); span(14, 0, 21, 'B'); span(15, 0, 21, 'B'); }
    else {
      span(12, 8, 30 + s, 'B'); span(13, 1, 31 + s, 'B'); span(14, 0, 31 + s, 'B'); span(15, 0, 31 + s, 'B');
      ell(27.5 + s, 9.6, 4.2, 3.4, 'B');
      vline(25 + s, 4, 7, 'B'); vline(26 + s, 4, 7, 'B'); vline(30 + s, 4, 7, 'B'); vline(31 + s, 4, 7, 'B');
      eye(25 + s, 2, blink, 'B'); eye(30 + s, 2, blink, 'B');                         // red-eyed
      span(1, 24 + s, 27 + s, 'K'); span(1, 29 + s, 32 + s, 'K'); set(2, 27 + s, 'K'); set(2, 29 + s, 'K'); // scowling brow
      span(11, 29 + s, 31 + s, 'K'); set(12, 28 + s, 'K'); set(12, 32 + s, 'K');     // frown
    }
    shellRings(c, 11, 9, 10.4, 6.8, [[4, 6], [4, 7], [5, 5], [6, 4]]);
    for (const [x, y] of [[11, 0], [5, 2], [17, 2]]) { set(y, x, 'X'); span(y + 1, x - 1, x + 1, 'X'); } // shell spikes
    span(15, 4, 18, 'D');
    return rows();
  },
};
snail.stages = [snailHatchling, snail, snailAdult, snailHeavy];

// ── Turtle ─────────────────────────────────────────────────────────────────────
const turtle = {
  speed: 4,
  name: 'Turtle',
  habitat: 'pond',
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

// A turtle's shell dome sitting on its rim at row `base`: the top half of an ellipse, two rim rows.
const turtleShell = ({ set, span, ell }, cx, base, rx, ry, rim) => {
  ell(cx, base, rx, ry, 'S');
  for (let x = 0; x < SPR_W; x++) for (let y = base; y < SPR_H; y++) set(y, x, '.');
  span(base, rim[0], rim[1], 'R'); span(base + 1, rim[0] + 2, rim[1] - 2, 'R');
};
// Legs behind the shell, front and back pairs swapping reach each step; `claw` tips the near feet.
const turtleLegs = ({ set, span, vline }, far, near, thick, claw) => {
  for (const x of far) { for (let i = 0; i < thick - 1; i++) vline(x + i, 13, 14, 'l'); span(15, x, x + thick, 'l'); }
  for (const x of near) { for (let i = 0; i < thick; i++) vline(x + i, 13, 14, 'L'); span(15, x - 1, x + thick, 'L'); if (claw) set(15, x + thick, 'K'); }
};

const turtleHatchling = {
  speed: 5,
  palette: { S: 108, H: 65, R: 143, W: 151, L: 193, l: 150, K: 65, E: 231, P: 233 },
  advance: [true, false],
  zAt: [[20, 5], [25, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(), { set, span, vline, ell, eye, rows } = c;
    const y0 = sleep ? 2 : 0;
    turtleShell(c, 13, 12 + y0, 6.6, 5.6, [7, 19]);
    span(9 + y0, 9, 17, 'H'); vline(11, 7 + y0, 9 + y0, 'H'); vline(15, 7 + y0, 9 + y0, 'H');
    set(8 + y0, 9, 'W'); set(7 + y0, 10, 'W');
    if (!sleep) {
      const f = frame ? 1 : 0;
      turtleLegs(c, [11 - f, 17 + f], [9 + f, 15 - f], 2, false);
      set(11, 6, 'L');
      span(10, 19, 21, 'L'); span(11, 19, 21, 'L');
      ell(23, 9.2, 3, 2.6, 'L');                                                      // a big baby head
      eye(23, 8, blink, 'L');
      set(10, 25, 'K');
    }
    return rows();
  },
};

const turtleAdult = {
  speed: 2,
  palette: { S: 29, H: 23, R: 94, W: 72, L: 112, l: 70, K: 22, E: 231, P: 233 },
  advance: [true, false],
  zAt: [[25, 6], [29, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(), { set, span, vline, ell, eye, rows } = c;
    const y0 = sleep ? 2 : 0;
    turtleShell(c, 15, 11 + y0, 12.6, 10.4, [2, 28]);
    span(7 + y0, 5, 25, 'H');
    vline(10, 2 + y0, 7 + y0, 'H'); vline(20, 2 + y0, 7 + y0, 'H');
    vline(6, 7 + y0, 10 + y0, 'H'); vline(15, 7 + y0, 10 + y0, 'H'); vline(24, 7 + y0, 10 + y0, 'H');
    for (const x of [12, 15, 18]) set(0 + y0, x, 'H');                              // ridge knobs
    span(3 + y0, 13, 14, 'W'); set(4 + y0, 12, 'W'); set(5 + y0, 6, 'W'); set(4 + y0, 8, 'W');
    if (!sleep) {
      const f = frame ? 2 : 0, b = frame ? -2 : 0;
      turtleLegs(c, [11 - b, 23 - f], [5 + b, 18 + f], 3, true);
      span(10, 0, 2, 'L'); set(11, 0, 'L');
      span(8, 26, 29, 'L'); span(9, 26, 29, 'L'); span(10, 26, 28, 'L');
      ell(30.5, 6.8, 3.3, 3, 'L');
      eye(30, 5, blink, 'L');
      span(4, 29, 32, 'K');                                                           // brow
      span(8, 32, 33, 'K');
    }
    return rows();
  },
};

const turtleHeavy = {
  speed: 1,
  scale: 5, rows: 4, // drawn bigger, a row taller
  palette: { S: 94, H: 52, R: 130, X: 223, W: 137, L: 101, l: 59, K: 52, E: 231, P: 160 },
  advance: [true, false],
  zAt: [[25, 6], [29, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(), { set, span, vline, ell, eye, rows } = c;
    const y0 = sleep ? 2 : 0;
    turtleShell(c, 15, 12 + y0, 13, 10, [2, 28]);
    span(8 + y0, 5, 25, 'H');
    vline(10, 3 + y0, 8 + y0, 'H'); vline(20, 3 + y0, 8 + y0, 'H');
    vline(6, 8 + y0, 11 + y0, 'H'); vline(15, 8 + y0, 11 + y0, 'H'); vline(24, 8 + y0, 11 + y0, 'H');
    for (const [x, y] of [[15, 0], [9, 1], [21, 1], [4, 4], [26, 4]]) { set(y + y0, x, 'X'); span(y + y0 + 1, x - 1, x + 1, 'X'); } // spiked ridge
    span(4 + y0, 13, 14, 'W'); set(5 + y0, 12, 'W');
    if (!sleep) {
      const f = frame ? 2 : 0, b = frame ? -2 : 0;
      turtleLegs(c, [11 - b, 22 - f], [5 + b, 18 + f], 3, true);
      span(11, 0, 2, 'L'); span(12, 0, 1, 'L'); set(10, 1, 'X');                    // spiked tail
      span(9, 26, 29, 'L'); span(10, 26, 29, 'L'); span(11, 26, 28, 'L');
      ell(30.5, 7.8, 3.4, 3.2, 'L');
      eye(30, 6, blink, 'L');                                                         // red-eyed
      span(5, 28, 32, 'K'); set(6, 32, 'K');                                          // heavy brow
      span(10, 31, 33, 'K'); set(9, 33, 'K'); set(11, 33, 'X');                       // hooked beak
    }
    return rows();
  },
};
turtle.stages = [turtleHatchling, turtle, turtleAdult, turtleHeavy];

// ── Crab ───────────────────────────────────────────────────────────────────────
// Four stages as the brief heads toward its compaction (see `stages` below): hatchling, this one, adult, heavy.
const crab = {
  speed: 2,
  name: 'Crab',
  habitat: 'beach',
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

// A crab's eyes on stalks: open (pupil to the front), or shut while blinking or asleep.
const crabEyes = ({ span, set, vline }, xs, top, stalk, { blink, sleep }, lid) => {
  for (const x of xs) {
    if (sleep) { span(top + 2, x, x + 1, lid); span(top + 3, x, x + 1, 'K'); continue; }
    vline(x, top + 2, top + 2 + stalk, 'D'); vline(x + 1, top + 2, top + 2 + stalk, 'D');
    if (blink) { span(top, x, x + 1, lid); span(top + 1, x, x + 1, 'K'); } else { span(top, x, x + 1, 'E'); set(top + 1, x, 'E'); set(top + 1, x + 1, 'P'); }
  }
};
// An inward-facing pincer: a round claw with a wedge cut from its inner side (wider while open).
const pincer = ({ ell, set, span }, cx, cy, rx, ry, open, line = 'D') => {
  ell(cx, cy, rx, ry, 'C');
  const gy = Math.round(cy - ry * 0.15);
  for (let k = 0; k < (open ? 3 : 2); k++) for (let x = Math.round(cx) + (k ? 0 : 1); x <= cx + rx + 1; x++) set(gy - k, x, '.');
  span(gy + 1, Math.round(cx) - 1, Math.round(cx + rx * 0.7), line);
};

const crabHatchling = {
  speed: 3,
  palette: { C: 216, D: 173, K: 95, E: 231, P: 233 },
  advance: [true, true],
  sideways: true,
  zAt: [[20, 3], [25, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -1 : 0), { set, span, ell, mirror, rows } = c;
    const k = frame && !sleep ? 1 : 0;
    set(14, 12, 'D'); set(15, 11 - k, 'D'); set(14, 14, 'D'); set(15, 13 + k, 'D'); // two little legs a side
    ell(17, 12.6, 4.8, 2.4, 'C');
    span(11, 11, 12, 'C'); set(12, 13, 'C');                                        // nub arm
    const cy = sleep ? 10 : 9 - k;                                                   // claws bob with the step
    span(cy, 10, 11, 'C'); span(cy + 1, 10, 12, 'C'); set(cy, 12, k ? '.' : 'D');
    mirror();
    crabEyes(c, [14, 18], 7, 1, { blink, sleep }, 'C');
    span(13, 16, 17, 'K');
    return rows();
  },
};

const crabAdult = {
  speed: 1,
  palette: { C: 202, D: 130, K: 88, E: 231, P: 233, S: 216 },
  advance: [true, true],
  sideways: true,
  zAt: [[15, 4], [19, 0]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -1 : 0), { set, span, ell, mirror, rows } = c;
    const k = frame && !sleep ? 1 : 0;
    for (const [i, x] of [[0, 9], [1, 11], [2, 13], [3, 15]]) {                     // four jointed legs a side
      const tip = x - 5 - (i + k) % 2, y = 12 + (i > 1 ? 1 : 0);
      span(y, tip + 1, x, 'D'); set(y + 1, tip, 'D'); set(Math.min(15, y + 2), tip, 'D'); set(15, tip - 1 + (i % 2), 'D');
    }
    ell(17, 9.6, 10, 4.3, 'C');
    span(13, 10, 16, 'D');
    set(7, 12, 'S'); set(8, 9, 'S'); set(6, 16, 'S'); set(9, 14, 'S');              // shell spots
    if (sleep) { set(10, 8, 'C'); set(9, 7, 'C'); pincer(c, 4.6, 7.6, 3.4, 2.6, false); }
    else { set(10, 8, 'C'); set(9, 7, 'C'); set(8, 6, 'C'); set(7, 5, 'C'); set(7, 6, 'C'); set(6, 4, 'C'); pincer(c, 3.6, 3.4 - k, 3.6, 2.9, k); }
    mirror();
    crabEyes(c, [13, 19], 1, 3, { blink, sleep }, 'C');
    if (!sleep) { span(0, 12, 14, 'D'); span(0, 19, 21, 'D'); }                    // brows
    span(11, 15, 18, 'K');
    return rows();
  },
};

const crabHeavy = {
  speed: 1,
  scale: 5, rows: 4, // drawn bigger, a row taller
  palette: { C: 160, D: 88, K: 52, E: 231, P: 233, G: 220, S: 203 },
  advance: [true, true],
  sideways: true,
  zAt: [[15, 6], [19, 1]],
  draw({ frame, blink, sleep }) {
    const c = canvas(sleep ? -1 : 0), { set, span, vline, ell, mirror, rows } = c;
    const k = frame && !sleep ? 1 : 0;
    for (const [i, x] of [[0, 8], [1, 10], [2, 12], [3, 14]]) {                     // thick legs
      const tip = x - 5 - (i + k) % 2, y = 12 + (i > 1 ? 1 : 0);
      span(y, tip + 1, x, 'D'); span(y + 1, tip, tip + 1, 'D'); set(Math.min(15, y + 2), tip, 'D'); set(15, tip - 1 + (i % 2), 'D');
    }
    ell(17, 10.2, 12, 4.5, 'C');
    span(13, 9, 16, 'D');
    span(8, 8, 9, 'S'); span(7, 11, 12, 'S'); span(6, 14, 16, 'S');                 // armour highlights
    vline(9, 4, 6, 'D'); vline(13, 3, 5, 'D');                                      // shell spikes
    if (sleep) { span(10, 5, 6, 'C'); span(9, 4, 5, 'C'); pincer(c, 4.4, 7, 4, 3, false, 'K'); }
    else {
      span(10, 5, 6, 'C'); span(9, 4, 5, 'C'); span(8, 4, 5, 'C'); span(7, 3, 4, 'C');
      pincer(c, 4.2, 3.4 - k, 4.4, 3.7, k, 'K'); set(4 - k, 2, 'S'); set(3 - k, 3, 'S');
    }
    mirror();
    crabEyes(c, [12, 20], 1, 4, { blink, sleep }, 'C');
    if (!sleep) { span(0, 11, 14, 'K'); span(0, 19, 22, 'K'); }                    // heavy brow
    span(5, 15, 18, 'G'); span(4, 15, 18, 'G'); span(3, 15, 18, 'G'); set(2, 15, 'G'); set(2, 18, 'G'); // crown
    set(4, 16, 'S'); set(4, 17, 'S');
    span(11, 14, 19, 'K'); set(10, 14, 'K'); set(10, 19, 'K');                     // scowl
    return rows();
  },
};
crab.stages = [crabHatchling, crab, crabAdult, crabHeavy];

export const CREATURES = [snail, turtle, crab];

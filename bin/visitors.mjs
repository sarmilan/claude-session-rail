// Visitors: a small flier over the pet's strip for each running subagent (the rail counts the main
// thread's Agent calls). Each is a 7×5 pixel sprite, facing right, with two wing frames, drawn like a
// creature: palette letters to xterm-256, '.' transparent, and not A, U, Q or Z, which the mascot keeps for its
// marks. They come in from an edge, drift in a wobbly path around the pet, and fly off the nearest edge
// when their subagent finishes.

export const FLIERS = [
  {
    name: 'bee', flap: 1, // ticks per wing frame
    palette: { Y: 220, K: 236, W: 195, H: 233 },
    frames: [
      ['.WW.WW.', '.WW.WW.', '.YKYKY.', 'KYKYKYH', '.YKYKY.'],
      ['.......', 'WW...WW', 'WYKYKYW', 'KYKYKYH', '.YKYKY.'],
    ],
  },
  {
    name: 'butterfly', flap: 2,
    palette: { F: 209, O: 230, B: 173, K: 236 },
    frames: [
      ['FF.K.FF', 'FOFKFOF', '.FFKFF.', '.BFKFB.', '..B.B..'],
      ['...K...', '.F.K.F.', '.FFKFF.', '..FKF..', '...K...'],
    ],
  },
  {
    name: 'dragonfly', flap: 1,
    palette: { T: 37, E: 45, W: 153 },
    frames: [
      ['.WW.WW.', '..WWW..', 'TTTTTTE', '..WWW..', '.WW.WW.'],
      ['.......', 'WWW.WWW', 'TTTTTTE', 'WWW.WWW', '.......'],
    ],
  },
  {
    name: 'ladybird', flap: 1,
    palette: { R: 160, K: 233, W: 252, H: 233 },
    frames: [
      ['WW...WW', '.WRRRW.', '.RKRKRK', 'RRKRRKH', '.RRRRR.'],
      ['.......', 'WWRRRWW', '.RKRKRK', 'RRKRRKH', '.RRRRR.'],
    ],
  },
];
export const MAX_VISITORS = 4;
const SPOTS = [-1, 1, -2, 2]; // where each one hovers: either side of the pet, the second pair further out

// The flock: `want(n)` adds or sends off visitors to match n, `step` moves them a tick, and `sprites`
// says where to draw them: `x` in columns from the strip's left, `alt` 0 (low) … 1 (high).
export function createVisitors() {
  let next = 0; // which flier comes next, in turn
  const flock = []; // { kind, x, alt, dir, seed, leaving, spot }
  return {
    want(n, W) {
      n = Math.max(0, Math.min(MAX_VISITORS, n | 0));
      const staying = flock.filter((v) => !v.leaving);
      for (let i = staying.length; i < n; i++) {
        const spot = SPOTS.find((o) => !staying.some((v) => v.spot === o)) ?? 0, from = next % 2 ? W + 2 : -8;
        const v = { kind: next++ % FLIERS.length, x: from, alt: 0.5, dir: from < 0 ? 1 : -1, seed: next * 2.3, leaving: false, spot };
        flock.push(v); staying.push(v);
      }
      staying.slice(0, Math.max(0, staying.length - n)).forEach((v) => { v.leaving = true; });
    },
    // `centre` and `half` are the pet's middle column and half its width; `vw` is a flier's width in columns.
    step(centre, W, tick, half, vw = 4) {
      for (const v of flock) {
        const wobble = 3 * Math.sin(tick * 0.09 + v.seed);
        const target = v.leaving ? (v.x < W / 2 ? -12 : W + 6) // no wobble, so it always clears the edge and goes
          : Math.max(1, Math.min(W - 1 - vw, centre + Math.sign(v.spot) * (half + 1 + (Math.abs(v.spot) - 1) * 9) - (v.spot < 0 ? vw : 0) + wobble));
        const dx = (target - v.x) * (v.leaving ? 0.12 : 0.08);
        v.x += Math.max(-1.5, Math.min(1.5, dx));
        if (Math.abs(dx) > 0.05) v.dir = dx > 0 ? 1 : -1;
        v.alt = 0.5 + 0.45 * Math.sin(tick * 0.17 + v.seed * 1.7);
      }
      for (let i = flock.length - 1; i >= 0; i--) if (flock[i].leaving && (flock[i].x < -10 || flock[i].x > W + 4)) flock.splice(i, 1);
    },
    sprites(tick) {
      return flock.map((v) => {
        const f = FLIERS[v.kind], frame = Math.floor(tick / f.flap) % 2;
        const rows = f.frames[frame].map((r) => (v.dir < 0 ? [...r].reverse().join('') : r));
        return { x: v.x, alt: v.alt, rows, palette: f.palette };
      });
    },
    get size() { return flock.length; },
  };
}

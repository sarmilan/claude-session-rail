// Visitors: a small flier over the pet's strip for each running subagent (the rail counts the main
// thread's Agent calls in flight and the background subagents). Each is a 7×5 pixel sprite, facing right,
// with two wing frames, drawn like a creature: palette letters to xterm-256, '.' transparent, and not A, U,
// Q or Z, which the mascot keeps for its marks. They come in from an edge, drift in a wobbly path around the pet, and fly off the nearest edge
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
// The body letter of each flier, swapped for its subagent's colour so the strip matches the Now list.
const TINT = { bee: 'Y', butterfly: 'F', dragonfly: 'T', ladybird: 'R' };

// The flock. `want` takes a count or a list of `{ id, colour }`. It draws at most four and remembers how
// many more there are (`overflow`). `spook` sends them off the pet for a moment; `calm` settles them low.
export function createVisitors() {
  let next = 0; // which flier comes next, in turn
  const flock = []; // { id, kind, colour, x, alt, dir, seed, leaving, spot, spook }
  let overflow = 0, calm = false;
  return {
    want(entries, W) {
      const list = Array.isArray(entries)
        ? entries.filter((e) => e && e.id != null)
        : Array.from({ length: Math.max(0, entries | 0) }, (_, i) => ({ id: `n${i}`, colour: null }));
      overflow = Math.max(0, list.length - MAX_VISITORS);
      const show = list.slice(0, MAX_VISITORS), ids = new Set(show.map((e) => e.id));
      const staying = flock.filter((v) => !v.leaving);
      for (const v of staying) if (!ids.has(v.id)) v.leaving = true;
      for (const e of show) {
        const have = flock.find((v) => v.id === e.id && !v.leaving);
        if (have) { have.colour = e.colour ?? null; continue; }
        const spot = SPOTS.find((o) => !staying.some((v) => v.spot === o)) ?? 0, from = next % 2 ? W + 2 : -8;
        const v = { id: e.id, kind: next++ % FLIERS.length, colour: e.colour ?? null, x: from, alt: 0.5, dir: from < 0 ? 1 : -1, seed: next * 2.3, leaving: false, spot, spook: 0 };
        flock.push(v); staying.push(v);
      }
    },
    spook(tick) { for (const v of flock) if (!v.leaving) v.spook = tick + 12; },
    setCalm(on) { calm = Boolean(on); },
    // `centre` and `half` are the pet's middle column and half its width; `vw` is a flier's width in columns.
    step(centre, W, tick, half, vw = 4) {
      for (const v of flock) {
        const spooked = v.spook > tick;
        const wobble = (calm && !spooked ? 1 : 3) * Math.sin(tick * 0.09 + v.seed);
        const hover = Math.max(1, Math.min(W - 1 - vw, centre + Math.sign(v.spot) * (half + 1 + (Math.abs(v.spot) - 1) * 9) - (v.spot < 0 ? vw : 0) + wobble));
        const target = v.leaving ? (v.x < W / 2 ? -12 : W + 6) // no wobble, so it always clears the edge and goes
          : spooked ? (v.x >= centre ? W + 4 : -8)
          : hover;
        const dx = (target - v.x) * (v.leaving || spooked ? 0.18 : calm ? 0.05 : 0.08);
        v.x += Math.max(-1.5, Math.min(1.5, dx));
        if (Math.abs(dx) > 0.05) v.dir = dx > 0 ? 1 : -1;
        v.alt = spooked ? 0.95
          : calm ? 0.22 + 0.12 * Math.sin(tick * 0.1 + v.seed)
          : 0.5 + 0.45 * Math.sin(tick * 0.17 + v.seed * 1.7);
      }
      for (let i = flock.length - 1; i >= 0; i--) if (flock[i].leaving && (flock[i].x < -10 || flock[i].x > W + 4)) flock.splice(i, 1);
    },
    sprites(tick) {
      return flock.map((v) => {
        const f = FLIERS[v.kind], frame = Math.floor(tick / f.flap) % 2;
        const rows = f.frames[frame].map((r) => (v.dir < 0 ? [...r].reverse().join('') : r));
        const key = TINT[f.name];
        const palette = v.colour == null || !key ? f.palette : { ...f.palette, [key]: v.colour };
        return { x: v.x, alt: v.alt, rows, palette };
      });
    },
    get size() { return flock.length; },
    get overflow() { return overflow; },
  };
}

// Background foliage for the mascot strip: each creature walks through its own habitat (see `habitat` in
// creatures.mjs). A habitat lays its plants out once per strip width from a fixed seed, so they stay put,
// and the tall ones sway with `phase` (-1, 0 or 1). Pixels come out as [x, up, colour] in sprite pixels:
// `up` counts rows above the floor line (negative is below it). Colours are xterm-256, kept dim so the
// pet stays in front.

// A tiny seeded generator, so a habitat looks the same every time at a given width.
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// Each element pushes [x, up, colour, bend]; `bend` is how far that pixel leans with the sway.
const tuft = (px, x, h, c) => {
  for (const [dx, lean, k] of [[-1, -1, 0.7], [0, 0, 1], [1, 1, 0.8]])
    for (let i = 0; i < Math.round(h * k); i++) px.push([x + dx + (i > h / 2 ? lean : 0), i + 1, c, i > h / 2 ? 1 : 0]);
};
const fern = (px, x, h, c) => {
  for (let i = 0; i < h; i++) {
    px.push([x, i + 1, c, 0]);
    if (i < 2 || i % 2) continue;
    const w = Math.max(1, Math.round((h - i) / 2.2));
    for (let k = 1; k <= w; k++) { const up = i + 1 - (k === w ? 1 : 0); px.push([x - k, up, c, 0], [x + k, up, c, 0]); }
  }
};
const mushroom = (px, x) => {
  for (let i = 1; i <= 3; i++) px.push([x, i, 187, 0], [x + 1, i, 187, 0]);
  for (const [dx, up] of [[-1, 4], [0, 4], [1, 4], [2, 4], [3, 4], [-2, 4], [0, 5], [1, 5], [2, 5], [-1, 5]]) px.push([x + dx, up, 131, 0]);
  px.push([x, 5, 180, 0], [x + 2, 4, 180, 0]);
};
const pebble = (px, x, w, c) => {
  for (let i = 0; i < w; i++) px.push([x + i, 1, c, 0]);
  for (let i = 1; i < w - 1; i++) px.push([x + i, 2, c, 0]);
};
const reed = (px, x, h) => {
  for (let i = 0; i < h; i++) px.push([x + (i > h * 0.7 ? 1 : 0), i + 1, 64, i > h * 0.5 ? 1 : 0]);
  for (let i = 0; i < 3; i++) px.push([x + 1, h - 1 + i, 94, 1], [x + 2, h - 1 + i, 94, 1]);
  px.push([x + 1, h + 2, 64, 1]);
};
const blade = (px, x, h, lean) => {
  for (let i = 0; i < h; i++) px.push([x + Math.round(lean * (i / h) ** 2 * 3), i + 1, 58, i > h / 2 ? 1 : 0]);
};
const rock = (px, x, w, h) => {
  for (let up = 1; up <= h; up++) {
    const half = (w / 2) * Math.sqrt(1 - ((up - 0.5) / (h + 0.5)) ** 2);
    for (let dx = -Math.round(half); dx <= Math.round(half); dx++) px.push([x + dx, up, 239, 0]);
  }
  px.push([Math.round(x - w / 4), h, 242, 0]);
};
const seaweed = (px, x, h) => {
  for (let i = 0; i < h; i++) px.push([x + (Math.floor(i / 3) % 2), i + 1, 30, i > h / 2 ? 1 : 0]);
};
const shell = (px, x, c) => {
  for (const [dx, up] of [[-1, 1], [0, 1], [1, 1], [-1, 2], [0, 2], [1, 2], [0, 3], [-2, 1], [2, 1]]) px.push([x + dx, up, c, 0]);
  px.push([x, 2, 174, 0], [x - 1, 1, 174, 0]);
};

// Specks below the floor line, the ground the creature walks on: sand, soil, mud.
const specks = (colours) => (px, x, r) => px.push([x, -1 - Math.floor(r() * 3), colours[Math.floor(r() * colours.length)], 0]);

// Habitats: plants per 100 sprite pixels of width, placed at random (but seeded) spots.
const HABITATS = {
  woodland: [
    [3, (px, x, r) => fern(px, x, 7 + Math.floor(r() * 6), 22)],
    [2, (px, x) => mushroom(px, x)],
    [4, (px, x, r) => pebble(px, x, 2 + Math.floor(r() * 2), 240)],
    [4, (px, x) => tuft(px, x, 2, 22)],
    [10, specks([94, 101])], // soil and leaf litter (last, so the plants keep their seeded spots)
  ],
  pond: [
    [3, (px, x, r) => reed(px, x, 10 + Math.floor(r() * 5))],
    [5, (px, x, r) => blade(px, x, 4 + Math.floor(r() * 6), r() < 0.5 ? 1 : -1)],
    [2, (px, x, r) => rock(px, x, 6 + r() * 4, 3 + Math.floor(r() * 2))],
    [10, specks([101, 30])], // mud and water
  ],
  beach: [
    [10, specks([137])], // sand
    [3, (px, x, r) => seaweed(px, x, 5 + Math.floor(r() * 7))],
    [3, (px, x, r) => shell(px, x, [181, 217, 224][Math.floor(r() * 3)])],
    [2, (px, x) => pebble(px, x, 2, 244)],
  ],
};

const layouts = new Map();
function layout(name, width) {
  const key = `${name}:${width}`;
  if (!layouts.has(key)) {
    if (layouts.size > 20) layouts.clear();
    const r = seeded([...name].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7) % 2147483646 + 1), px = [];
    for (const [per100, draw] of HABITATS[name] ?? []) {
      for (let i = 0; i < Math.round((per100 * width) / 100); i++) draw(px, Math.round(3 + r() * (width - 6)), r);
    }
    layouts.set(key, px);
  }
  return layouts.get(key);
}

// The habitat's pixels across `width` sprite pixels, leaning with `phase`.
export const foliage = (name, width, phase = 0) =>
  layout(name, width).map(([x, up, c, bend]) => [x + Math.round(bend * phase), up, c]);

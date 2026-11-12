// Names and colours for subagents, so the rail and the task notifications can say who is doing what.
// Pure, no Node APIs: the hooks pick them at spawn, the rail only draws what the activity file records.

export const NAMES = `
Ada Alba Alder Alma Amos Anya Arlo Asa Aspen Astra Atlas Aura Avi Axel Bea Bede Bell Benno Birch Blair
Bo Brio Bram Briar Bruno Cade Cal Cami Cass Cato Cedar Cleo Clem Coda Cole Cora Cosmo Cyra Dag Dahl
Dale Dara Dash Dell Demi Dex Dina Dot Drew Dune Eamon Echo Eden Edie Eli Elio Ella Elm Elsa Emil
Emmet Enzo Erin Esme Etta Evan Ezra Fable Faye Fen Fern Ferro Fia Finn Fitz Flora Flynn Ford Fox Frey
Gale Gene Gia Gil Glen Greer Gus Gwen Hal Halo Hana Hart Hazel Heath Hero Holly Hugo Ida Igor Ilsa
Indy Ines Ira Iris Isla Ivo Ivy Jade Jago Jay Jem Jess Jett Jo Joss Jude Jules Juno Kai Kaia
Kane Kara Kato Kay Keir Kenzo Kit Kiva Knox Koa Lark Lena Leo Lev Lia Lin Linus Lior Liv Lola
Lore Lotte Luca Lumi Luz Lyle Lyra Mabel Mace Mae Mako Mara Max Maya Mei Milo Mira Moss Muir Nell
Nemo Neve Nia Nico Nika Nils Nina Noa Nola Nova Oak Odile Odin Olaf Olive Omar Onyx Opal Orin Orla
Oscar Otis Otto Pax Pearl Pia Pike Pim Pip Poe Quill Quinn Rae Rafe Ravi Ray Reed Remy Rhea Rio
Ripley Roan Robin Romy Rook Rosa Rowan Roux Ruby Rue Rumi Rune Sable Sage Sami Saul Scout Sela Shay Silas
Sky Sol Sora Stellan Sue Suki Sven Tad Tali Tam Tara Tate Tess Theo Thea Tilde Timo Toby Tova Tuck
Uma Una Uri Ursa Vale Vera Vic Vida Vito Vivi Wade Wanda West Willa Wim Wolf Wren Xan Xia Yara
Yuki Yuri Zane Zara Zed Zeke Zia Ziggy Zoe Zola Zora Basil Briony Caspian Delphine Florian Imogen Lazlo Marlowe Octavia
Ansel Bexley Calla Dorian Emrys Fallon Greta Hollis Iver Juniper Kestrel Linnea Magnus Nadia Orson Perrin Rosalind Sorrel Tamsin Wilder
`.trim().split(/\s+/);

// Readable on a dark pane, and never red or green: those mean failure and success on the rail.
export const COLOURS = [80, 141, 75, 213, 179, 117, 183, 222, 110, 216];

// A name nobody in the record holds, starting from a random point in the list (rand() in [0, 1)).
// With every name taken (as many agents as names) it reuses one rather than fail.
export function pickName(taken, rand = Math.random) {
  const held = new Set(taken);
  const start = Math.floor(rand() * NAMES.length);
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[(start + i) % NAMES.length];
    if (!held.has(name)) return name;
  }
  return NAMES[start];
}

// The colour fewest live agents have, first in list order on a tie.
export function pickColour(live) {
  const uses = new Map(COLOURS.map((c) => [c, 0]));
  for (const c of live) if (uses.has(c)) uses.set(c, uses.get(c) + 1);
  return COLOURS.reduce((best, c) => (uses.get(c) < uses.get(best) ? c : best), COLOURS[0]);
}

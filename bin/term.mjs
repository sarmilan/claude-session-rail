// Terminal drawing helpers shared by the rail and the desk: colours, display width (emoji and CJK
// take two cells), truncation, word wrap, and stripping escape sequences from untrusted text.
export const ESC = '\x1b[';
// A palette entry is a 256-colour index or an RGB triple (truecolour). iTerm draws the triples as given.
const colour = (n) => (Array.isArray(n) ? `2;${n[0]};${n[1]};${n[2]}` : `5;${n}`);
export const fg = (n, s) => `${ESC}38;${colour(n)}m${s}${ESC}39m`;
export const bgOpen = (n) => `${ESC}48;${colour(n)}m`;
export const bg = (n, s) => `${bgOpen(n)}${s}${ESC}49m`;
export const dim = (s) => `${ESC}2m${s}${ESC}22m`;
export const bold = (s) => `${ESC}1m${s}${ESC}22m`;
// Claude's chrome, and GrokNight (the default Grok theme): magenta accent, Tokyo Night semantics,
// main background #141414, highlight #242424. `bg` is null for Claude so the pane keeps its iTerm profile.
const CLAUDE = { accent: 173, purple: 141, green: 71, red: 167, yellow: 179, blue: 75, gray: 245, select: 237, jump: 236, bg: null };
const GROK = {
  accent: [187, 154, 247], purple: [157, 124, 216], green: [158, 206, 106], red: [247, 118, 142],
  yellow: [224, 175, 104], blue: [122, 162, 247], gray: [108, 108, 108], select: [36, 36, 36], jump: [46, 46, 46],
  bg: [20, 20, 20],
};
export const C = { ...CLAUDE };
export const usePalette = (host) => Object.assign(C, host === 'grok' ? GROK : CLAUDE);
// OSC 11 sets this pane's default background, so clears and unpainted cells match too. OSC 111 puts the profile back.
const hex = (rgb) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
export const paneBgOn = () => (Array.isArray(C.bg) ? `\x1b]11;#${hex(C.bg)}\x07` : '');
export const paneBgOff = () => (Array.isArray(C.bg) ? '\x1b]111\x07' : '');

export const charWidth = (cp) => {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
};
export const width = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].reduce((w, ch) => w + charWidth(ch.codePointAt(0)), 0);
export const trunc = (s, w) => {
  if (w <= 0) return '';
  if (width(s) <= w) return s;
  let out = '', used = 0;
  for (const ch of s) { const cw = charWidth(ch.codePointAt(0)); if (used + cw > w - 1) break; out += ch; used += cw; }
  return out + '…';
};
// Word wrap; words longer than the line are split.
export const wrap = (s, w) => {
  const out = [];
  let cur = '';
  for (const word of s.split(/(\s+)/)) {
    if (width(cur + word) <= w) { cur += word; continue; }
    if (cur.trim()) out.push(cur.trimEnd());
    cur = word.trimStart();
    while (width(cur) > w) {
      let piece = '', used = 0;
      for (const ch of cur) { const cw = charWidth(ch.codePointAt(0)); if (used + cw > w) break; piece += ch; used += cw; }
      out.push(piece); cur = cur.slice(piece.length);
    }
  }
  out.push(cur);
  return out;
};
// Task output can contain any escape sequence; strip them so it can't disturb the panel.
export const clean = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b./g, '')
  .replace(/\t/g, '  ')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
// A tab bar for `w` columns: the active tab is a lit block in bold accent, the others are dim, one space
// apart. `under` is the rule below it, accent under the active tab. `spans` are 0-based content columns.
export const tabBar = (tabs, active, w) => {
  let x = 0, bar = '', under = '';
  const spans = tabs.map(([tab, label]) => {
    const text = ` ${label} `, n = width(text), on = tab === active;
    bar += (on ? bg(C.select, bold(fg(C.accent, text))) : dim(text)) + ' ';
    under += on ? fg(C.accent, '━'.repeat(n)) : dim('─'.repeat(n));
    const span = { tab, from: x, to: x + n };
    x += n;
    if (x < w) { under += dim('─'); x += 1; }
    return span;
  });
  return { bar, under: under + dim('─'.repeat(Math.max(0, w - x))), spans };
};

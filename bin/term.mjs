// Terminal drawing helpers shared by the rail and the desk: colours, display width (emoji and CJK
// take two cells), truncation, word wrap, and stripping escape sequences from untrusted text.
export const ESC = '\x1b[';
export const fg = (n, s) => `${ESC}38;5;${n}m${s}${ESC}39m`;
export const dim = (s) => `${ESC}2m${s}${ESC}22m`;
export const bold = (s) => `${ESC}1m${s}${ESC}22m`;
export const C = { accent: 173, purple: 141, green: 71, red: 167, yellow: 179, blue: 75, gray: 245 };

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

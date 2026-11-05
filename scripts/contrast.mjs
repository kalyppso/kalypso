// WCAG contrast check for the built-in themes (#106). Reads the theme tokens from
// src/styles.css and fails if a pairing the UI relies on is below its minimum.
//   node scripts/contrast.mjs
import fs from "node:fs";

const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const THEMES = ["black", "white", "blossom"];

function tokens(theme) {
  const m = css.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no [data-theme="${theme}"] block`);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[k] = v;
  return out;
}

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground, background, minimum, what it is]
const PAIRS = [
  ["text", "bg", 4.5, "body text"],
  ["text", "surface-2", 4.5, "text on the sidebar"],
  ["text-2", "bg", 4.5, "secondary text"],
  ["text-2", "surface-2", 4.5, "secondary text on the sidebar"],
  ["text-3", "bg", 3, "hints and labels"],
  ["text-3", "surface-2", 3, "hints on the sidebar"],
  ["#ffffff", "accent", 4.5, "primary button label"],
];

let failed = 0;
for (const theme of THEMES) {
  const t = tokens(theme);
  for (const [fg, bg, min, what] of PAIRS) {
    const a = fg.startsWith("#") ? fg : t[fg];
    const b = t[bg];
    if (!a || !b) { console.error(`${theme}: missing ${a ? bg : fg}`); failed++; continue; }
    const r = ratio(a, b);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${theme.padEnd(8)} ${what.padEnd(30)} ${fg} on ${bg}: ${r.toFixed(2)} (min ${min})`);
  }
}
if (failed) {
  console.error(`\n${failed} pairing(s) below WCAG AA.`);
  process.exit(1);
}

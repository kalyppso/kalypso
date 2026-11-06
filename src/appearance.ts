import type { Appearance } from "./types";

// Bundled fonts work offline. Anything else installed on the machine can be
// used by family name ("system:<family>").
export const FONTS: { id: string; label: string; family: string }[] = [
  { id: "geist", label: "Geist", family: '"Geist Variable"' },
  { id: "inter", label: "Inter", family: '"Inter Variable"' },
  { id: "manrope", label: "Manrope", family: '"Manrope Variable"' },
  { id: "dm-sans", label: "DM Sans", family: '"DM Sans Variable"' },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", family: '"IBM Plex Sans Variable"' },
  { id: "space-grotesk", label: "Space Grotesk", family: '"Space Grotesk Variable"' },
  { id: "jetbrains-mono", label: "JetBrains Mono", family: '"JetBrains Mono Variable"' },
];

export const ACCENTS = ["#dddedf", "#1a1a1a", "#5b2aaa", "#7c3aed", "#c2185b", "#9d174d", "#1d4ed8", "#047857", "#b45309", "#ffffff"];

const SIZES: Record<Appearance["size"], number> = { compact: 0.92, default: 1, large: 1.1 };

export function fontFamily(font: string) {
  if (font.startsWith("system:")) return `"${font.slice(7).replace(/"/g, "")}"`;
  return FONTS.find((f) => f.id === font)?.family ?? FONTS[0].family;
}

// WCAG relative luminance of a #rrggbb colour.
export function luminance(hex: string) {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Pick black or white text, whichever reads better on the accent.
export const inkFor = (bg: string) => (contrast(bg, "#000000") >= contrast(bg, "#ffffff") ? "#000000" : "#ffffff");

export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.style.setProperty("--accent", a.accent);
  root.style.setProperty("--accent-fg", inkFor(a.accent));
  root.style.setProperty("--font", `${fontFamily(a.font)}, system-ui, sans-serif`);
  if (a.theme === "custom") {
    root.style.setProperty("--bg", a.bg);
    root.style.setProperty("--text", a.text);
    root.style.colorScheme = luminance(a.bg) < 0.4 ? "dark" : "light";
  } else {
    root.style.removeProperty("--bg");
    root.style.removeProperty("--text");
    root.style.colorScheme = "";
  }
  root.style.setProperty("zoom", String(SIZES[a.size]));
}

export const isDark = (a: Appearance) => (a.theme === "custom" ? luminance(a.bg) < 0.4 : a.theme === "black");

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Keep only well-formed appearance fields from stored data, so a bad value can't break the theme. */
export function sanitizeAppearance(x: unknown): Partial<Appearance> {
  if (!x || typeof x !== "object") return {};
  const o = x as Record<string, unknown>;
  const out: Partial<Appearance> = {};
  if (o.theme === "black" || o.theme === "white" || o.theme === "blossom" || o.theme === "custom") out.theme = o.theme;
  for (const k of ["bg", "text", "accent"] as const) if (typeof o[k] === "string" && HEX.test(o[k] as string)) out[k] = (o[k] as string).toLowerCase();
  if (typeof o.font === "string" && o.font.length <= 80 && (o.font.startsWith("system:") || FONTS.some((f) => f.id === o.font))) out.font = o.font;
  if (o.size === "compact" || o.size === "default" || o.size === "large") out.size = o.size;
  return out;
}

// ---------- Contrast for the theme being picked (#106) ----------

const rgb = (hex: string) => {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: number[]) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

/** `color-mix(in srgb, a p%, b)`, as the stylesheet derives secondary colours. */
export function mix(a: string, b: string, p: number) {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v * p + y[i] * (1 - p)));
}

/** Background and text of each built-in theme (their tokens live in styles.css). */
const BUILT_IN: Record<string, { bg: string; text: string }> = {
  black: { bg: "#000000", text: "#ffffff" },
  white: { bg: "#ffffff", text: "#000000" },
  blossom: { bg: "#fdf1f5", text: "#3d1029" },
};

export interface ContrastCheck {
  id: "text" | "text-2" | "text-3" | "accent";
  label: string;
  ratio: number;
  min: number;
  ok: boolean;
}

/** WCAG AA checks for the theme as picked: text levels on the background (custom themes), and
 *  the accent against the background (any theme), which buttons, focus rings and selection use. */
export function themeChecks(a: Appearance): ContrastCheck[] {
  const custom = a.theme === "custom";
  const { bg, text } = custom ? { bg: a.bg, text: a.text } : BUILT_IN[a.theme] ?? BUILT_IN.black;
  const check = (id: ContrastCheck["id"], label: string, fg: string, min: number): ContrastCheck => {
    const ratio = contrast(fg, bg);
    return { id, label, ratio, min, ok: ratio >= min };
  };
  const out: ContrastCheck[] = [];
  if (custom) {
    out.push(check("text", "Body text", text, 4.5));
    out.push(check("text-2", "Secondary text", mix(text, bg, 0.66), 4.5));
    out.push(check("text-3", "Hints and labels", mix(text, bg, 0.42), 3));
  }
  out.push(check("accent", "Accent (buttons, focus, selection)", a.accent, 3));
  return out;
}

/** The text colour with the most contrast on `bg`: what "Fix" picks for failing text. */
export const bestText = (bg: string) => (contrast("#000000", bg) >= contrast("#ffffff", bg) ? "#111111" : "#f5f5f7");

/** The nearest accent that reaches 3:1 on `bg`: the same hue, lightened or darkened. */
export function fixAccent(accent: string, bg: string) {
  const toward = contrast("#ffffff", bg) > contrast("#000000", bg) ? "#ffffff" : "#000000";
  for (let p = 0.05; p <= 1.0001; p += 0.05) {
    const c = mix(toward, accent, p);
    if (contrast(c, bg) >= 3) return c;
  }
  return toward;
}

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

export const ACCENTS = ["#5b2aaa", "#301365", "#7c3aed", "#9d174d", "#1d4ed8", "#047857", "#b45309", "#ffffff"];

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

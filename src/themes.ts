import type { ThemeId } from "./types";

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  hint: string;
  swatch: [string, string, string];
  /** Accent applied when the theme is picked; the user can still change it after. */
  accent?: string;
}

// The tokens themselves live in styles.css under [data-theme="..."].
export const themes: ThemeMeta[] = [
  { id: "black", label: "Black", hint: "Black background, purple accent", swatch: ["#000000", "#ffffff", "#5b2aaa"] },
  { id: "white", label: "White", hint: "White background, purple accent", swatch: ["#ffffff", "#000000", "#5b2aaa"] },
  { id: "blossom", label: "Blossom", hint: "Soft pink background, rose accent", swatch: ["#fdf1f5", "#3d1029", "#c2185b"], accent: "#c2185b" },
];

/** What to change when a theme is picked: the theme, plus its own accent if it has one. */
export const themePatch = (id: ThemeId) => {
  const accent = themes.find((t) => t.id === id)?.accent;
  return accent ? { theme: id, accent } : { theme: id };
};

export const isTheme = (v: unknown): v is ThemeId => themes.some((t) => t.id === v);

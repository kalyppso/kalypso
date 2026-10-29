import type { ThemeId } from "./types";

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  hint: string;
  swatch: [string, string, string];
}

// The tokens themselves live in styles.css under [data-theme="..."].
export const themes: ThemeMeta[] = [
  { id: "black", label: "Black", hint: "Black background, purple accent", swatch: ["#000000", "#ffffff", "#5b2aaa"] },
  { id: "white", label: "White", hint: "White background, purple accent", swatch: ["#ffffff", "#000000", "#5b2aaa"] },
];

export const isTheme = (v: unknown): v is ThemeId => themes.some((t) => t.id === v);

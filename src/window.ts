// The desktop window has no native title bar: KALYPSO draws its own (drag regions and,
// off macOS, window controls). The window starts hidden and is shown here once the first
// frame is painted, so it opens on the finished UI instead of a blank or white frame.

import { isLive } from "./backend";

export type Os = "mac" | "windows" | "linux";

export const os: Os = /Mac/i.test(navigator.userAgent) ? "mac" : /Windows/i.test(navigator.userAgent) ? "windows" : "linux";

/** True in the desktop app, where KALYPSO draws the title bar itself. */
export const customChrome = isLive();

/** Mark the document so styles can make room for macOS traffic lights or window controls. */
export function markChrome() {
  if (!customChrome) return;
  document.documentElement.classList.add("chrome", `os-${os}`);
}

let shown = false;

/** Show the window after fonts load (or 400 ms, whichever comes first) and two frames. */
export async function revealWindow() {
  if (!customChrome || shown) return;
  shown = true;
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 400))]);
  await new Promise((r) => setTimeout(r, 16));
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  await win.show();
  await win.setFocus();
}

export async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

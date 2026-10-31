import type { ViewId } from "./types";

/** Per-user preferences. Kept in the store, and in the core's settings table in the desktop app. */
export interface Prefs {
  /** Page to open on launch; "last" reopens where you left off. */
  startView: ViewId | "last";
  /** Namespace to open on launch; "last" reopens the last one. */
  defaultNs: string;
  clock: "auto" | "12h" | "24h";
  /** IANA time zone, or "auto" for the system's. */
  timeZone: string;
  reduceMotion: boolean;
  /** Desktop notifications from the core. In-app notices always show. */
  notifyBudget: boolean;
  notifyApprovals: boolean;
  termFontSize: number;
  termCursor: "block" | "bar" | "underline";
  termScrollback: number;
  /** How long a held tool call waits for an answer before it is denied. */
  approvalTimeoutMin: number;
}

export const DEFAULT_PREFS: Prefs = {
  startView: "last",
  defaultNs: "last",
  clock: "auto",
  timeZone: "auto",
  reduceMotion: false,
  notifyBudget: true,
  notifyApprovals: true,
  termFontSize: 12.5,
  termCursor: "block",
  termScrollback: 5000,
  approvalTimeoutMin: 10,
};

export const TERM_FONT_SIZES = [11, 12, 12.5, 13, 14, 15, 16];
export const SCROLLBACK = [1000, 5000, 10000, 50000];
export const APPROVAL_TIMEOUTS = [1, 2, 5, 10, 15, 30, 60];

const VIEWS = ["last", "overview", "analytics", "agents", "tracker", "git", "sandboxes", "connections", "policies", "budget", "secrets", "integrations", "registry", "settings"];

export function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** Keep only well-formed fields from stored data, so a bad value can't break the app. */
export function sanitizePrefs(x: unknown): Partial<Prefs> {
  if (!x || typeof x !== "object") return {};
  const o = x as Record<string, unknown>;
  const out: Partial<Prefs> = {};
  if (typeof o.startView === "string" && VIEWS.includes(o.startView)) out.startView = o.startView as Prefs["startView"];
  if (typeof o.defaultNs === "string" && /^(last|[a-z0-9][a-z0-9-]{0,39})$/.test(o.defaultNs)) out.defaultNs = o.defaultNs;
  if (o.clock === "auto" || o.clock === "12h" || o.clock === "24h") out.clock = o.clock;
  if (typeof o.timeZone === "string" && (o.timeZone === "auto" || timeZones().includes(o.timeZone))) out.timeZone = o.timeZone;
  for (const k of ["reduceMotion", "notifyBudget", "notifyApprovals"] as const) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  if (typeof o.termFontSize === "number" && TERM_FONT_SIZES.includes(o.termFontSize)) out.termFontSize = o.termFontSize;
  if (o.termCursor === "block" || o.termCursor === "bar" || o.termCursor === "underline") out.termCursor = o.termCursor;
  if (typeof o.termScrollback === "number" && SCROLLBACK.includes(o.termScrollback)) out.termScrollback = o.termScrollback;
  if (typeof o.approvalTimeoutMin === "number" && APPROVAL_TIMEOUTS.includes(o.approvalTimeoutMin)) out.approvalTimeoutMin = o.approvalTimeoutMin;
  return out;
}

/** A time of day in the user's clock style and time zone. */
export function formatTime(d: Date, p: Pick<Prefs, "clock" | "timeZone">): string {
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: p.clock === "auto" ? undefined : p.clock === "12h",
    timeZone: p.timeZone === "auto" ? undefined : p.timeZone,
  });
}

/** Date and time, for logs. */
export function formatDateTime(d: Date, p: Pick<Prefs, "clock" | "timeZone">): string {
  return d.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: p.clock === "auto" ? undefined : p.clock === "12h",
    timeZone: p.timeZone === "auto" ? undefined : p.timeZone,
  });
}

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) as a Date. */
export const fromDb = (ts: string) => new Date(ts.replace(" ", "T") + "Z");

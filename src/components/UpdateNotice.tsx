import { useEffect, useState } from "react";
import { ArrowDownToLine, Loader2, X } from "lucide-react";
import { isLive, errorMessage } from "../backend";
import { useToast } from "../store";

// Auto-update (#95). The app checks the signed update manifest on the latest GitHub release a few
// seconds after it starts, and again when Settings asks. An update downloads, is verified against
// the public key built into the app, and installs on restart.

type Found = { version: string; notes: string; install: (onProgress: (pct: number | null) => void) => Promise<void> };

/** Ask for an update check from anywhere (Settings). Resolves to what was found. */
export const checkForUpdates = () => window.dispatchEvent(new Event("kalypso:check-updates"));

async function lookForUpdate(): Promise<Found | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body ?? "",
    install: async (onProgress) => {
      let total = 0, got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") { got += e.data.chunkLength; onProgress(total ? Math.round((got / total) * 100) : null); }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

export function UpdateNotice() {
  const toast = useToast();
  const [found, setFound] = useState<Found | null>(null);
  const [hidden, setHidden] = useState(false);
  const [notes, setNotes] = useState(false);
  const [progress, setProgress] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    if (!isLive()) return;
    const run = (asked: boolean) =>
      lookForUpdate()
        .then((f) => {
          if (f) { setFound(f); setHidden(false); }
          else if (asked) toast("KALYPSO is up to date", "info");
        })
        .catch((e) => { if (asked) toast(`Couldn't check for updates: ${errorMessage(e)}`, "err"); });
    const first = setTimeout(() => run(false), 5000);
    const onAsk = () => run(true);
    window.addEventListener("kalypso:check-updates", onAsk);
    return () => { clearTimeout(first); window.removeEventListener("kalypso:check-updates", onAsk); };
  }, []);

  if (!found || hidden) return null;
  const installing = progress !== undefined;
  const install = () => {
    setProgress(null);
    found.install(setProgress).catch((e) => { setProgress(undefined); toast(`The update didn't install: ${errorMessage(e)}`, "err"); });
  };
  return (
    <aside className="update-notice" role="status" aria-label="Update available">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <ArrowDownToLine size={15} style={{ marginTop: 2, flex: "none" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>KALYPSO {found.version} is available</div>
          {found.notes && (
            <button className="link-btn faint small" onClick={() => setNotes(!notes)}>{notes ? "Hide what's new" : "What's new"}</button>
          )}
        </div>
        {!installing && <button className="btn ghost sm icon" aria-label="Later" title="Later" onClick={() => setHidden(true)}><X size={14} /></button>}
      </div>
      {notes && <div className="update-notes small">{found.notes}</div>}
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        {installing ? (
          <span className="faint small"><Loader2 size={13} className="spin" /> {progress == null ? "Downloading…" : `Downloading ${progress}%`}</span>
        ) : (
          <>
            <button className="btn ghost sm" onClick={() => setHidden(true)}>Later</button>
            <button className="btn primary sm" onClick={install}>Install and restart</button>
          </>
        )}
      </div>
    </aside>
  );
}

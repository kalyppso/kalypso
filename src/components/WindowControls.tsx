import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { currentWindow, customChrome, os } from "../window";

/** Minimize, maximize and close, for Windows and Linux (macOS keeps its traffic lights). */
export function WindowControls() {
  const [max, setMax] = useState(false);

  useEffect(() => {
    if (!customChrome || os === "mac") return;
    let off: (() => void) | undefined;
    currentWindow().then(async (w) => {
      setMax(await w.isMaximized());
      off = await w.onResized(async () => setMax(await w.isMaximized()));
    });
    return () => off?.();
  }, []);

  if (!customChrome || os === "mac") return null;
  const run = (fn: "minimize" | "toggleMaximize" | "close") => currentWindow().then((w) => w[fn]());

  return (
    <div className="win-controls" role="group" aria-label="Window">
      <button className="win-btn" title="Minimize" aria-label="Minimize" onClick={() => run("minimize")}><Minus size={14} /></button>
      <button className="win-btn" title={max ? "Restore" : "Maximize"} aria-label={max ? "Restore" : "Maximize"} onClick={() => run("toggleMaximize")}>
        {max ? <Copy size={12} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} />}
      </button>
      <button className="win-btn close" title="Close" aria-label="Close" onClick={() => run("close")}><X size={15} /></button>
    </div>
  );
}

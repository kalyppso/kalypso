import { useState } from "react";
import { Boxes } from "lucide-react";
import { api, errorMessage, isLive } from "../backend";
import { useNamespaced, useStore, useToast } from "../store";

/**
 * Reach an app running inside any sandbox from the Browser or the Phone: pick the sandbox and
 * the port it listens on, and KALYPSO forwards that port to this machine and opens it.
 * Sandboxes have no other way in from here, whatever their network mode.
 */
export function SandboxTarget({ onOpen }: { onOpen: (url: string) => void }) {
  const { state } = useStore();
  const toast = useToast();
  const { sandboxes } = useNamespaced();
  const running = sandboxes.filter((s) => s.status === "running");
  const [id, setId] = useState(running[0]?.id ?? "");
  const [port, setPort] = useState("3000");
  const [busy, setBusy] = useState(false);
  const target = running.find((s) => s.id === id) ?? running[0];

  const open = async () => {
    const p = Number(port);
    if (!target) return toast(sandboxes.length ? "Start a sandbox first." : "Create a sandbox first.", "warn");
    if (!Number.isInteger(p) || p < 1 || p > 65535) return toast("Give the port the app listens on, for example 3000 or 5173.", "warn");
    if (!isLive()) return onOpen(`http://localhost:${p}`);
    setBusy(true);
    try {
      const fwd = await api.portForwardOpen(state.ns, target.id, p);
      onOpen(`http://localhost:${fwd.host_port}`);
      toast(`${target.name}:${p} is open here on localhost:${fwd.host_port}`);
    } catch (e) {
      toast(errorMessage(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sb-target" title="Open an app running inside a sandbox">
      <Boxes size={13} className="faint" />
      <select className="select" value={target?.id ?? ""} onChange={(e) => setId(e.target.value)} aria-label="Sandbox" disabled={!running.length}>
        {running.length === 0 && <option value="">No running sandbox</option>}
        {running.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <input className="input mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), open())} aria-label="Port" placeholder="port" />
      <button type="button" className="btn sm" onClick={open} disabled={busy || !running.length}>{busy ? "Opening…" : "Open"}</button>
    </div>
  );
}

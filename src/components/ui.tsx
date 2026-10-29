import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Code2, EyeOff, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { useStore } from "../store";

const tone: Record<string, "ok" | "warn" | "err" | ""> = {
  running: "ok", up: "ok", healthy: "ok", connected: "ok", approved: "ok",
  idle: "warn", paused: "warn", degraded: "warn", syncing: "warn", warned: "warn",
  error: "err", down: "err", offline: "err", blocked: "err", denied: "err",
  stopped: "",
};

export function Status({ value }: { value: string }) {
  const t = tone[value] ?? "";
  return (
    <span className={`badge ${t}`}>
      <span className={`dot ${t}`} />
      {value}
    </span>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} aria-pressed={on} aria-label={label} />;
}

export function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="dim small" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          <span className="spacer" />
          <button className="btn ghost icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ModalActions({ onCancel, onConfirm, confirm }: { onCancel: () => void; onConfirm: () => void; confirm: string }) {
  return (
    <div className="row" style={{ justifyContent: "flex-end", marginTop: 4 }}>
      <button className="btn ghost" onClick={onCancel}>Cancel</button>
      <PrimaryButton onClick={onConfirm}>{confirm}</PrimaryButton>
    </div>
  );
}

export function PrimaryButton({ children, onClick, icon }: { children: ReactNode; onClick: () => void; icon?: ReactNode }) {
  return (
    <button className="btn primary" onClick={onClick}>
      {icon}
      {children}
    </button>
  );
}

// Code is hidden by default. It shows when the global "Show code" switch is on,
// or when the user asks for this one block.
export function CodeReveal({ code, label = "configuration" }: { code: string; label?: string }) {
  const { state } = useStore();
  const [local, setLocal] = useState(false);
  const visible = state.showCode || local;

  if (!visible) {
    return (
      <div className="code-gate">
        <button className="btn ghost sm" style={{ marginLeft: -9 }} onClick={() => setLocal(true)}><Code2 size={13} /> Show {label}</button>
      </div>
    );
  }
  return (
    <div>
      {!state.showCode && (
        <div className="row" style={{ justifyContent: "flex-end", marginBottom: 6 }}>
          <button className="btn ghost sm" onClick={() => setLocal(false)}><EyeOff size={13} /> Hide</button>
        </div>
      )}
      <pre className="code"><code>{code}</code></pre>
    </div>
  );
}

export function PageHead({ title, subtitle, children }: { title: ReactNode; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

export function Toasts() {
  const { state, dispatch } = useStore();
  const icon = { ok: <CheckCircle2 size={16} color="var(--ok)" />, warn: <TriangleAlert size={16} color="var(--warn)" />, err: <XCircle size={16} color="var(--err)" />, info: <Info size={16} color="var(--accent-hi)" /> };
  return (
    <div className="toasts">
      {state.toasts.map((t) => (
        <div key={t.id} className="toast" onClick={() => dispatch({ type: "dismissToast", id: t.id })}>
          {icon[t.tone]}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return { open, setOpen, ref };
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
export const initials = (name: string) => name.slice(0, 2).toUpperCase();

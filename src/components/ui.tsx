import { Logo } from "./Logo";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CircleAlert, Code2, EyeOff, Info, TriangleAlert, X, XCircle, type LucideIcon } from "lucide-react";
import { useStore } from "../store";

// One status language for every page, the transcript and the Inbox (#106): the same word always
// gets the same colour. ok = working, warn = waiting or in between, err = stopped by a problem.
const tone: Record<string, "ok" | "warn" | "err" | ""> = {
  running: "ok", up: "ok", healthy: "ok", connected: "ok", approved: "ok", ok: "ok", open: "ok", merged: "ok", done: "ok", allowed: "ok",
  idle: "warn", paused: "warn", degraded: "warn", syncing: "warn", warned: "warn", starting: "warn", restarting: "warn",
  waiting: "warn", pending: "warn", queued: "warn", reconnect: "warn", draft: "warn",
  error: "err", down: "err", offline: "err", blocked: "err", denied: "err", failed: "err", crashed: "err",
  stopped: "", exited: "", closed: "", none: "",
};

/** The tone a status word gets everywhere. */
export const statusTone = (value: string) => tone[value] ?? "";

/** Just the dot, where a pill would be too much (graph nodes, dense rows). */
export function StatusDot({ value, label }: { value: string; label?: string }) {
  return <span className={`dot ${statusTone(value)}`} role="img" aria-label={label ?? value} title={label ?? value} />;
}

/** A placeholder in the shape of what's loading, instead of blank space or a spinner. */
export function Skeleton({ rows = 3, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton" role="status" aria-label="Loading" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => <span key={i} className="skeleton-row" style={{ height, opacity: 1 - i * 0.18 }} />)}
    </div>
  );
}

export function Status({ value }: { value: string }) {
  const t = statusTone(value);
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

export function Modal({ title, subtitle, onClose, children, wide }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Rendered on <body>: inside the page, the page's entrance animation (a transform)
  // would position the fixed overlay against the page instead of the window.
  return createPortal(
    <div className="overlay" onMouseDown={onClose}>
      <div className={`modal${wide ? " wide" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
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
    </div>,
    document.body,
  );
}

export type Errors = Partial<Record<string, string>>;

// Form errors for a modal. `check` runs on submit and returns true when the form
// is valid; editing a field calls `clear` so its message goes away as you type.
export function useErrors() {
  const [errors, setErrors] = useState<Errors>({});
  const check = (next: Errors) => {
    const found = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    setErrors(found);
    return Object.keys(found).length === 0;
  };
  const clear = (key: string) => setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  return { errors, check, clear };
}

// A labelled form control with an optional error under it.
export function Field({ label, error, hint, children }: { label: ReactNode; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className={`field ${error ? "invalid" : ""}`}>
      {label}
      {children}
      {error ? (
        <span className="field-error" role="alert"><CircleAlert size={12} /> {error}</span>
      ) : hint ? (
        <span className="faint small">{hint}</span>
      ) : null}
    </label>
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

/** What sits in an agent's avatar: the wireframe mark for the master agent, initials otherwise. */
export function AgentFace({ agent, size = 26 }: { agent: { name: string; master?: boolean }; size?: number }) {
  return agent.master ? <Logo size={size} /> : <>{initials(agent.name)}</>;
}

/**
 * For pages the core doesn't back yet: what you add is kept on this machine, but agents
 * don't act on it until the issue ships. Only shown in the desktop app.
 */
export function PreviewNote({ children, issue }: { children: ReactNode; issue: number }) {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  return (
    <p className="preview-note">
      {children}{" "}
      <a href={`https://github.com/kalyppso/kalypso/issues/${issue}`} target="_blank" rel="noreferrer">#{issue}</a>
    </p>
  );
}

/**
 * Keeps one page's crash from blanking the whole window: the sidebar, top bar and
 * other pages keep working, and the page says what went wrong.
 */
export class PageBoundary extends Component<{ children: ReactNode; page: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`The ${this.props.page} page crashed`, error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty-state" role="alert">
        <div className="empty-title">This page ran into a problem</div>
        <p className="faint">{this.state.error.message}</p>
        <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

/** What a page shows before it has anything: what goes here, and the first step. */
export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden><Icon size={18} /></span>
      <div className="empty-title">{title}</div>
      {children && <p className="faint">{children}</p>}
      {action}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  [`${modKey} K`, "Search and run any command"],
  [`${modKey} B`, "Collapse or expand the sidebar"],
  ["Ctrl `", "Open or close the terminal"],
  ["?", "Show these shortcuts"],
  ["Esc", "Close a dialog, panel or menu"],
  ["↑ ↓ Enter", "Move and choose in lists and the command palette"],
];

/** `?` (outside a text field) or the command palette opens this. */
export function ShortcutsSheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || !!t.closest(".xterm"));
      if (e.key === "?" && !typing && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setOpen((o) => !o); }
    };
    const show = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("kalypso:shortcuts", show);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("kalypso:shortcuts", show); };
  }, []);
  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)}>
      <dl className="shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys}><dt>{keys.split(" ").map((k) => <kbd key={k}>{k}</kbd>)}</dt><dd>{what}</dd></div>
        ))}
      </dl>
    </Modal>
  );
}

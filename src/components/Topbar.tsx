import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Code2, Layers, Palette, Plus, Search } from "lucide-react";
import { useStore, useToast } from "../store";
import { api, errorMessage, isLive, toNamespace } from "../backend";
import { themes } from "../themes";
import { viewLabel } from "./Sidebar";
import { Modal, ModalActions, Toggle } from "./ui";

function usePopover() {
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

export function Topbar() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const nsPop = usePopover();
  const themePop = usePopover();
  const [creating, setCreating] = useState(false);
  const [newNs, setNewNs] = useState("");
  const current = state.namespaces.find((n) => n.id === state.ns);

  const createNs = () => {
    const id = newNs.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!id || state.namespaces.some((n) => n.id === id)) return;
    const done = () => { toast(`Created namespace ${id}`); setNewNs(""); setCreating(false); };
    if (isLive()) {
      api.nsCreate(id, "New isolated namespace")
        .then((n) => { dispatch({ type: "addNamespace", ns: toNamespace(n) }); done(); })
        .catch((e) => toast(errorMessage(e), "err"));
      return;
    }
    dispatch({ type: "addNamespace", ns: { id, name: id, color: "#5b2aaa", description: "New isolated namespace" } });
    done();
  };

  return (
    <header className="topbar">
      <div className="pop-wrap" ref={nsPop.ref}>
        <button className="btn" onClick={() => nsPop.setOpen(!nsPop.open)} title="Switch namespace">
          <Layers size={14} />
          {current?.name}
          <ChevronDown size={13} className="faint" />
        </button>
        {nsPop.open && (
          <div className="popover" style={{ left: 0, right: "auto", transformOrigin: "top left" }}>
            <div className="pop-label">Namespaces</div>
            {state.namespaces.map((n) => (
              <button
                key={n.id}
                className={`pop-item ${n.id === state.ns ? "active" : ""}`}
                onClick={() => { dispatch({ type: "ns", ns: n.id }); nsPop.setOpen(false); }}
              >
                <div>
                  <div>{n.name}</div>
                  <div className="faint small">{n.description}</div>
                </div>
                {n.id === state.ns && <Check size={14} style={{ marginLeft: "auto", color: "var(--accent-hi)" }} />}
              </button>
            ))}
            <button className="pop-item" onClick={() => { setCreating(true); nsPop.setOpen(false); }}>
              <Plus size={14} /> New namespace
            </button>
          </div>
        )}
      </div>
      <div className="crumbs">
        <ChevronRight size={13} />
        <strong>{viewLabel(state.view)}</strong>
      </div>

      <span className="spacer" />

      <button className="btn ghost" style={{ minWidth: 200, justifyContent: "flex-start", color: "var(--text-3)" }} onClick={() => dispatch({ type: "palette", open: true })}>
        <Search size={14} /> Search
        <span className="spacer" />
        <kbd>Ctrl K</kbd>
      </button>

      <label className="btn ghost" style={{ cursor: "pointer" }} title="Code stays hidden until you ask for it">
        <Code2 size={14} />
        Show code
        <Toggle on={state.showCode} onChange={(v) => dispatch({ type: "showCode", value: v })} label="Show code" />
      </label>

      <div className="pop-wrap" ref={themePop.ref}>
        <button className="btn ghost icon" title={`Theme: ${themes.find((t) => t.id === state.appearance.theme)?.label ?? "Custom"}`} onClick={() => themePop.setOpen(!themePop.open)}>
          <Palette size={15} />
        </button>
        {themePop.open && (
          <div className="popover">
            <div className="pop-label">Theme</div>
            {themes.map((t) => (
              <button
                key={t.id}
                className={`pop-item ${t.id === state.appearance.theme ? "active" : ""}`}
                onClick={() => { dispatch({ type: "theme", theme: t.id }); themePop.setOpen(false); }}
              >
                <span className="swatch">{t.swatch.map((c) => <span key={c} style={{ background: c }} />)}</span>
                <div>
                  <div>{t.label}</div>
                  <div className="faint small">{t.hint}</div>
                </div>
                {t.id === state.appearance.theme && <Check size={14} style={{ marginLeft: "auto", color: "var(--accent-hi)" }} />}
              </button>
            ))}
            <button className="pop-item" onClick={() => { dispatch({ type: "view", view: "settings" }); themePop.setOpen(false); }}>
              <Palette size={14} /> Customize colours and font
            </button>
          </div>
        )}
      </div>

      {creating && (
        <Modal title="New namespace" subtitle="Gets its own network, secrets, budget, policies and browser profile." onClose={() => setCreating(false)}>
          <label className="field">
            Name
            <input className="input" autoFocus value={newNs} onChange={(e) => setNewNs(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createNs()} placeholder="e.g. client-acme" />
          </label>
          <ModalActions onCancel={() => setCreating(false)} onConfirm={createNs} confirm="Create namespace" />
        </Modal>
      )}
    </header>
  );
}

import { Check, Code2, Palette, PanelLeft, Search } from "lucide-react";
import { useStore } from "../store";
import { themePatch, themes } from "../themes";
import { viewLabel } from "./Sidebar";
import { Toggle, modKey, usePopover } from "./ui";

export function Topbar() {
  const { state, dispatch } = useStore();
  const themePop = usePopover();

  return (
    <header className="topbar">
      <button
        className="btn ghost icon"
        title={`${state.sidebarOpen ? "Close" : "Open"} sidebar (${modKey} B)`}
        aria-label={state.sidebarOpen ? "Close sidebar" : "Open sidebar"}
        aria-expanded={state.sidebarOpen}
        onClick={() => dispatch({ type: "sidebar", open: !state.sidebarOpen })}
      >
        <PanelLeft size={15} />
      </button>
      <div className="crumbs">
        <strong>{viewLabel(state.view)}</strong>
      </div>

      <span className="spacer" />

      <button className="btn ghost" style={{ minWidth: 200, justifyContent: "flex-start", color: "var(--text-3)" }} onClick={() => dispatch({ type: "palette", open: true })}>
        <Search size={14} /> Search
        <span className="spacer" />
        <kbd>{modKey} K</kbd>
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
                onClick={() => { dispatch({ type: "appearance", patch: themePatch(t.id) }); themePop.setOpen(false); }}
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

    </header>
  );
}

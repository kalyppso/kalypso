import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Code2, CornerDownLeft, Layers, Palette, Sparkles } from "lucide-react";
import { useStore } from "../store";
import { themes } from "../themes";
import { NAV } from "./Sidebar";

interface Command {
  id: string;
  group: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => dispatch({ type: "palette", open: false });

  const commands = useMemo<Command[]>(() => {
    const go = NAV.flatMap((g) => g.items).map(({ id, label, icon: Icon }) => ({
      id: `go-${id}`, group: "Go to", label, icon: <Icon size={16} />,
      run: () => dispatch({ type: "view", view: id }),
    }));
    const ns = state.namespaces.map((n) => ({
      id: `ns-${n.id}`, group: "Namespace", label: `Switch to ${n.name}`, icon: <Layers size={16} />,
      run: () => { dispatch({ type: "ns", ns: n.id }); close(); },
    }));
    const th = themes.map((t) => ({
      id: `th-${t.id}`, group: "Theme", label: `Theme: ${t.label}`, icon: <Palette size={16} />,
      run: () => { dispatch({ type: "theme", theme: t.id }); close(); },
    }));
    const misc = [
      { id: "code", group: "Preferences", label: state.showCode ? "Hide code" : "Show code", icon: <Code2 size={16} />, run: () => { dispatch({ type: "showCode", value: !state.showCode }); close(); } },
      { id: "ambient", group: "Preferences", label: state.ambient ? "Turn off ambient background" : "Turn on ambient background", icon: <Sparkles size={16} />, run: () => { dispatch({ type: "ambient", value: !state.ambient }); close(); } },
    ];
    return [...go, ...ns, ...th, ...misc];
  }, [state.namespaces, state.showCode, state.ambient, dispatch]);

  const filtered = commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter") filtered[index]?.run();
    if (e.key === "Escape") close();
  };

  let lastGroup = "";
  return (
    <div className="overlay palette-overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Type a command or search…" />
        <div className="palette-list">
          {filtered.length === 0 && <div className="faint" style={{ padding: 16 }}>No matches.</div>}
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header}
                <button className={`palette-item ${i === index ? "active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={c.run}>
                  {c.icon}
                  {c.label}
                  {i === index && <CornerDownLeft size={13} style={{ marginLeft: "auto", opacity: 0.6 }} />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

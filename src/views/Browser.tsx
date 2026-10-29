import { useState } from "react";
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from "lucide-react";
import { uid, useStore } from "../store";

interface Tab {
  id: string;
  url: string;
  history: string[];
  index: number;
  nonce: number; // bump to force reload
}

const HOME = "https://example.com";

function normalize(input: string) {
  const t = input.trim();
  if (!t) return HOME;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

const newTab = (url = HOME): Tab => ({ id: uid("t"), url, history: [url], index: 0, nonce: 0 });

// One browser pane in the tools layer: its own tabs, history and the namespace profile.
export function BrowserPane() {
  const { state } = useStore();
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()]);
  const [active, setActive] = useState(tabs[0].id);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  const [address, setAddress] = useState(tab.url);

  const update = (id: string, fn: (t: Tab) => Tab) => setTabs((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));

  const go = (raw: string) => {
    const url = normalize(raw);
    setAddress(url);
    update(tab.id, (t) => {
      const history = [...t.history.slice(0, t.index + 1), url];
      return { ...t, url, history, index: history.length - 1 };
    });
  };

  const step = (delta: number) => {
    const index = tab.index + delta;
    if (index < 0 || index >= tab.history.length) return;
    setAddress(tab.history[index]);
    update(tab.id, (t) => ({ ...t, index, url: t.history[index] }));
  };

  const select = (t: Tab) => {
    setActive(t.id);
    setAddress(t.url);
  };

  const close = (id: string) => {
    if (tabs.length === 1) return;
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (id === active) select(rest[0]);
  };

  const add = () => {
    const t = newTab();
    setTabs([...tabs, t]);
    select(t);
  };

  return (
    <div className="browser" title={`Profile ns-${state.ns}: cookies and storage are separate per namespace`}>
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={`tab ${t.id === tab.id ? "active" : ""}`} onClick={() => select(t)}>
              <Globe size={12} />
              <span>{new URL(t.url).hostname}</span>
              {tabs.length > 1 && <X size={12} onClick={(e) => { e.stopPropagation(); close(t.id); }} />}
            </button>
          ))}
          <button className="tab" onClick={add} aria-label="New tab"><Plus size={13} /></button>
        </div>
        <form className="urlbar" onSubmit={(e) => { e.preventDefault(); go(address); }}>
          <button type="button" className="btn ghost sm" onClick={() => step(-1)} disabled={tab.index === 0}><ArrowLeft size={14} /></button>
          <button type="button" className="btn ghost sm" onClick={() => step(1)} disabled={tab.index >= tab.history.length - 1}><ArrowRight size={14} /></button>
          <button type="button" className="btn ghost sm" onClick={() => update(tab.id, (t) => ({ ...t, nonce: t.nonce + 1 }))}><RotateCw size={14} /></button>
          <input className="input mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Search or enter address" />
        </form>
        {tabs.map((t) => (
          <iframe
            key={`${t.id}-${t.nonce}`}
            className="frame"
            src={t.url}
            title={t.url}
            style={{ display: t.id === tab.id ? "block" : "none" }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ))}
      {/* Prototype uses an iframe, so sites that forbid embedding show blank. The desktop build uses a native child webview (docs/ARCHITECTURE.md §4.8). */}
    </div>
  );
}

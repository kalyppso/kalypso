import { useEffect, useRef, useState } from "react";
import { api, errorMessage, isLive, onSandboxStatus, syncNamespace, toNamespace, type CoreInfo } from "./backend";
import { applyAppearance, sanitizeAppearance } from "./appearance";
import { NeuralWeb, Spider } from "./components/Ambient";
import { CommandPalette } from "./components/CommandPalette";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Toasts } from "./components/ui";
import { useNamespaced, useStore, useToast } from "./store";
import type { ViewId } from "./types";
import { Overview } from "./views/Overview";
import { Analytics } from "./views/Analytics";
import { Auth } from "./views/Auth";
import { Tracker } from "./views/Tracker";
import { Git } from "./views/Git";
import { Terminal } from "./views/Terminal";
import { Agents } from "./views/Agents";
import { Sandboxes } from "./views/Sandboxes";
import { Secrets } from "./views/Secrets";
import { Connections } from "./views/Connections";
import { Budget } from "./views/Budget";
import { Registry } from "./views/Registry";
import { Integrations } from "./views/Integrations";
import { Policies } from "./views/Policies";
import { Browser } from "./views/Browser";
import { Phone } from "./views/Phone";
import { SettingsView } from "./views/Settings";

const views: Record<ViewId, () => JSX.Element> = {
  overview: Overview,
  analytics: Analytics,
  agents: Agents,
  tracker: Tracker,
  git: Git,
  terminal: Terminal,
  sandboxes: Sandboxes,
  secrets: Secrets,
  connections: Connections,
  budget: Budget,
  registry: Registry,
  integrations: Integrations,
  policies: Policies,
  browser: Browser,
  phone: Phone,
  settings: SettingsView,
};

export function App() {
  const { state, dispatch } = useStore();
  const { agents, policies } = useNamespaced();

  useEffect(() => applyAppearance(state.appearance), [state.appearance]);

  // Desktop build: namespaces, secrets and sandboxes come from the Rust core.
  const toast = useToast();
  const [core, setCore] = useState<CoreInfo | null>(null);
  useEffect(() => {
    if (!isLive() || !state.session) return;
    api.coreInfo().then(setCore).catch(() => setCore(null));
    api.nsList()
      .then((list) => dispatch({ type: "hydrateNamespaces", namespaces: list.map(toNamespace) }))
      .catch((e) => toast(errorMessage(e), "err"));
  }, [state.session, dispatch, toast]);
  useEffect(() => {
    if (!isLive() || !state.session) return;
    syncNamespace(state.ns, dispatch).catch((e) => toast(errorMessage(e), "err"));
  }, [state.ns, state.session, dispatch, toast]);
  // Appearance and preferences live in the core's settings table.
  const prefsLoaded = useRef(false);
  useEffect(() => {
    if (!isLive() || !state.session) return;
    prefsLoaded.current = false;
    Promise.all([api.settingsGet("appearance"), api.settingsGet("preferences")])
      .then(([look, prefs]) => {
        const patch = sanitizeAppearance(look);
        if (Object.keys(patch).length) dispatch({ type: "appearance", patch });
        const p = (prefs ?? {}) as { showCode?: unknown; ambient?: unknown };
        if (typeof p.showCode === "boolean") dispatch({ type: "showCode", value: p.showCode });
        if (typeof p.ambient === "boolean") dispatch({ type: "ambient", value: p.ambient });
      })
      .catch((e) => toast(errorMessage(e), "err"))
      .finally(() => { prefsLoaded.current = true; });
  }, [state.session, dispatch, toast]);
  useEffect(() => {
    if (!isLive() || !state.session || !prefsLoaded.current) return;
    // Debounced so dragging a colour picker doesn't write on every frame.
    const t = setTimeout(() => api.settingsSet("appearance", state.appearance).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [state.appearance, state.session]);
  useEffect(() => {
    if (!isLive() || !state.session || !prefsLoaded.current) return;
    api.settingsSet("preferences", { showCode: state.showCode, ambient: state.ambient }).catch(() => {});
  }, [state.showCode, state.ambient, state.session]);

  // Containers changed outside KALYPSO (CLI, crash, engine restart) show up without a refresh.
  useEffect(() => {
    if (!isLive() || !state.session) return;
    const off = onSandboxStatus((e) => {
      if (e.ns === state.ns) syncNamespace(state.ns, dispatch).catch(() => {});
    });
    return () => void off.then((unlisten) => unlisten());
  }, [state.ns, state.session, dispatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!state.session || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        dispatch({ type: "palette", open: !state.paletteOpen });
      } else if (key === "b") {
        e.preventDefault();
        dispatch({ type: "sidebar", open: !state.sidebarOpen });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, state.paletteOpen, state.sidebarOpen, state.session]);

  if (!state.session) return <Auth />;

  const View = views[state.view];
  return (
    <>
      {state.ambient && <NeuralWeb theme={state.appearance.theme} active />}
      <div className={`shell ${state.sidebarOpen ? "" : "collapsed"}`}>
        <Sidebar />
        <div className="main">
          <Topbar />
          {state.ambient && <Spider />}
          <main className="content">
            {/* Remount on namespace or view change so per-view state never leaks across namespaces. */}
            <div className="page" key={`${state.ns}-${state.view}`}>
              <View />
            </div>
          </main>
          <footer className="statusbar">
            {core ? (
              <span title={`KALYPSO core ${core.version}`}>
                <span className={`dot ${core.runtime === "none" ? "warn" : "ok"}`} />
                {core.runtime === "none" ? "No container runtime" : `${core.runtime[0].toUpperCase()}${core.runtime.slice(1)} connected`}, keys in {core.key_source === "keychain" ? "OS keychain" : core.key_source === "file" ? "key file" : "memory"}
              </span>
            ) : (
              <span><span className="dot" /> Sample data</span>
            )}
            <span>{agents.filter((a) => a.status === "running").length} agents running</span>
            <span>{policies.filter((p) => p.enabled).length} policies active</span>
          </footer>
        </div>
      </div>
      {state.paletteOpen && <CommandPalette />}
      <Toasts />
    </>
  );
}

import { useEffect, useState } from "react";
import { Copy, Network, Pause, Play, Plus, Square, Trash2, X } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { api, errorMessage, isLive, syncNamespace } from "../backend";
import { Modal, ModalActions, PageHead, PrimaryButton, Status } from "../components/ui";
import type { Sandbox } from "../types";
import type { PortForward } from "../bindings/PortForward";
import type { ProviderInfo } from "../bindings/ProviderInfo";

export function Sandboxes() {
  const { state, dispatch } = useStore();
  const { sandboxes, agents } = useNamespaced();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ports, setPorts] = useState<Sandbox | null>(null);

  // Live: ask the core, then reload. Prototype: update the mock store.
  const act = (id: string, kind: "start" | "pause" | "stop" | "delete") => {
    if (!isLive()) {
      if (kind === "delete") return dispatch({ type: "removeSandbox", id });
      return dispatch({ type: "sandboxStatus", id, status: kind === "start" ? "running" : kind === "pause" ? "paused" : "stopped" });
    }
    const call = { start: api.sandboxStart, pause: api.sandboxPause, stop: api.sandboxStop, delete: api.sandboxDelete }[kind];
    setBusy(id);
    (call(state.ns, id) as Promise<unknown>)
      .then(() => syncNamespace(state.ns, dispatch))
      .catch((e) => toast(errorMessage(e), "err"))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <PageHead title="Sandboxes" subtitle={`Containers and micro-VMs on the ns-${state.ns} network. Nothing here can reach other namespaces.`}>
        <PrimaryButton onClick={() => setCreating(true)} icon={<Plus size={14} />}>New sandbox</PrimaryButton>
      </PageHead>

      <div className="card flush">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Runtime</th><th>Image</th><th>Resources</th><th>Network</th><th>Agents</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {sandboxes.map((s) => {
              const used = agents.filter((a) => a.sandboxId === s.id);
              return (
                <tr key={s.id}>
                  <td><strong style={{ fontWeight: 600 }}>{s.name}</strong><div className="faint" style={{ fontSize: 11 }}>created {s.createdAt}</div></td>
                  <td><span className="badge">{s.runtime}</span></td>
                  <td className="mono faint">{s.image}</td>
                  <td className="dim">{s.cpu} vCPU, {s.memMb / 1024} GB</td>
                  <td><span className="badge">{s.network}</span></td>
                  <td className="dim">{used.map((a) => a.name).join(", ") || "None"}</td>
                  <td><Status value={s.status} /></td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {s.status !== "running" && (
                        <button className="btn sm" title="Start" disabled={busy === s.id} onClick={() => act(s.id, "start")}><Play size={12} /></button>
                      )}
                      {s.status === "running" && isLive() && (
                        <button className="btn sm" title="Forward a port to this computer" onClick={() => setPorts(s)}><Network size={12} /></button>
                      )}
                      {s.status === "running" && (
                        <button className="btn sm" title="Pause" disabled={busy === s.id} onClick={() => act(s.id, "pause")}><Pause size={12} /></button>
                      )}
                      {s.status !== "stopped" && (
                        <button className="btn sm" title="Stop" disabled={busy === s.id} onClick={() => act(s.id, "stop")}><Square size={12} /></button>
                      )}
                      <button className="btn sm danger" title="Delete" disabled={busy === s.id} onClick={() => confirm(`Delete sandbox ${s.name}?`) && act(s.id, "delete")}><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sandboxes.length === 0 && <div className="empty" style={{ margin: 16 }}>No sandboxes in this namespace.</div>}
      </div>

      {creating && <NewSandbox onClose={() => setCreating(false)} />}
      {ports && <Ports sandbox={ports} onClose={() => setPorts(null)} />}
    </>
  );
}

function NewSandbox({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [form, setForm] = useState<Pick<Sandbox, "name" | "runtime" | "image" | "cpu" | "memMb" | "network">>({
    name: "", runtime: "docker", image: "docker.io/library/alpine:3.20", cpu: 2, memMb: 2048, network: "namespace",
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });

  const toast = useToast();
  const [saving, setSaving] = useState(false);
  // Only shown when there is a choice; with one engine the form stays as it was.
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<string>("");
  useEffect(() => {
    if (isLive()) api.sandboxProviders().then(setProviders).catch(() => {});
  }, []);
  const create = () => {
    if (!form.name.trim()) return;
    if (isLive()) {
      setSaving(true);
      api.sandboxCreate(state.ns, { name: form.name.trim(), image: form.image.trim(), cpu: form.cpu, mem_mb: form.memMb, network: form.network, provider: provider || undefined })
        .then(() => syncNamespace(state.ns, dispatch))
        .then(() => { toast(`Created ${form.name.trim()}`); onClose(); })
        .catch((e) => toast(errorMessage(e), "err"))
        .finally(() => setSaving(false));
      return;
    }
    dispatch({
      type: "addSandbox",
      sandbox: { ...form, name: form.name.trim(), id: uid("sb"), ns: state.ns, status: "stopped", createdAt: new Date().toISOString().slice(0, 10) },
    });
    onClose();
  };

  return (
    <Modal title="New sandbox" subtitle="Hardened by default: read-only root, all capabilities dropped." onClose={onClose}>
      <label className="field">Name<input className="input" autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} /></label>
      <div className="field-row">
        {providers.length > 1 && (
          <label className="field">Provider
            <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p, i) => <option key={p.kind} value={i === 0 ? "" : p.kind}>{p.label} ({p.isolation}{p.remote ? ", hosted" : ""})</option>)}
            </select>
          </label>
        )}
        {/* The desktop build uses the providers it detected (#47). */}
        {!isLive() && (
          <label className="field">Runtime
            <select className="select" value={form.runtime} onChange={(e) => set("runtime", e.target.value as Sandbox["runtime"])}>
              <option value="docker">Docker</option><option value="podman">Podman</option><option value="firecracker">Firecracker microVM</option>
            </select>
          </label>
        )}
        <label className="field">Network
          <select className="select" value={form.network} onChange={(e) => set("network", e.target.value as Sandbox["network"])}>
            <option value="isolated">Isolated (no network)</option><option value="namespace">Namespace only</option><option value="internet">Internet via egress proxy</option>
          </select>
        </label>
      </div>
      <label className="field">Image<input className="input mono" value={form.image} onChange={(e) => set("image", e.target.value)} /></label>
      <div className="field-row">
        <label className="field">vCPU<input className="input" type="number" min={1} max={16} value={form.cpu} onChange={(e) => set("cpu", +e.target.value)} /></label>
        <label className="field">Memory (MB)<input className="input" type="number" min={256} step={256} value={form.memMb} onChange={(e) => set("memMb", +e.target.value)} /></label>
      </div>
      <ModalActions onCancel={onClose} onConfirm={create} confirm={saving ? "Creating…" : "Create sandbox"} />
    </Modal>
  );
}

// Forward ports from a sandbox to 127.0.0.1 on this computer (src-tauri/src/forward.rs).
function Ports({ sandbox, onClose }: { sandbox: Sandbox; onClose: () => void }) {
  const { state } = useStore();
  const toast = useToast();
  const [port, setPort] = useState("3000");
  const [open, setOpen] = useState<PortForward[]>([]);
  const refresh = () => api.portForwardList(state.ns).then((all) => setOpen(all.filter((f) => f.sandbox === sandbox.id))).catch(() => {});
  useEffect(() => {
    refresh();
  }, []); // once, when the dialog opens

  const add = () => {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return toast("Use a port between 1 and 65535", "warn");
    api.portForwardOpen(state.ns, sandbox.id, n).then(refresh).catch((e) => toast(errorMessage(e), "err"));
  };
  const close = (p: number) => api.portForwardClose(state.ns, sandbox.id, p).then(refresh).catch((e) => toast(errorMessage(e), "err"));
  const url = (f: PortForward) => `http://127.0.0.1:${f.host_port}`;

  return (
    <Modal title={`Ports on ${sandbox.name}`} subtitle="Reach a service inside the sandbox from this computer only. Forwards close when the sandbox stops." onClose={onClose}>
      <div className="row">
        <input className="input mono" style={{ width: 120 }} value={port} onChange={(e) => setPort(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} aria-label="Port inside the sandbox" />
        <button className="btn" onClick={add}>Forward</button>
      </div>
      {open.length === 0 ? (
        <div className="faint small">No ports forwarded yet.</div>
      ) : (
        <div>
          {open.map((f) => (
            <div key={f.container_port} className="list-row">
              <span className="mono small">{f.container_port}</span>
              <span className="faint small">to</span>
              <span className="mono small clip" style={{ flex: 1 }}>{url(f)}</span>
              <button className="btn ghost sm icon" title="Copy address" onClick={() => navigator.clipboard?.writeText(url(f)).then(() => toast("Copied"))}><Copy size={12} /></button>
              <button className="btn ghost sm icon" title="Stop forwarding" onClick={() => close(f.container_port)}><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

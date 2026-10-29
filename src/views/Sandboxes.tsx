import { useState } from "react";
import { Pause, Play, Plus, Square, Trash2 } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { api, errorMessage, isLive, syncNamespace } from "../backend";
import { Modal, ModalActions, PageHead, PrimaryButton, Status } from "../components/ui";
import type { Sandbox } from "../types";

export function Sandboxes() {
  const { state, dispatch } = useStore();
  const { sandboxes, agents } = useNamespaced();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

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
  const create = () => {
    if (!form.name.trim()) return;
    if (isLive()) {
      setSaving(true);
      api.sandboxCreate(state.ns, { name: form.name.trim(), image: form.image.trim(), cpu: form.cpu, mem_mb: form.memMb, network: form.network })
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
        {/* The desktop build uses whichever engine it detected; Firecracker arrives in #35. */}
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

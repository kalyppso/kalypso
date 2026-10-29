import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AuditEntry } from "./bindings/AuditEntry";
import type { Namespace as NsRecord } from "./bindings/Namespace";
import type { NewSandbox } from "./bindings/NewSandbox";
import type { SandboxRecord } from "./bindings/SandboxRecord";
import type { SandboxStatusEvent } from "./bindings/SandboxStatusEvent";
import type { SecretMeta } from "./bindings/SecretMeta";
import type { Action } from "./store";
import type { Namespace, Sandbox, Secret } from "./types";

// Calls into the Rust core (src-tauri/src/ipc.rs). In a plain browser
// (`npm run dev`) there is no core, and the app runs on mock data instead.
export const isLive = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface CoreInfo {
  version: string;
  runtime: string;
  key_source: "keychain" | "file" | "memory";
}

export const api = {
  coreInfo: () => invoke<CoreInfo>("core_info"),
  auditList: (ns: string | null, action: string | null, limit = 200) => invoke<AuditEntry[]>("audit_list", { ns, action, limit }),
  nsList: () => invoke<NsRecord[]>("ns_list"),
  nsCreate: (id: string, description: string) => invoke<NsRecord>("ns_create", { id, description }),
  nsDelete: (ns: string) => invoke<void>("ns_delete", { ns }),
  secretList: (ns: string) => invoke<SecretMeta[]>("secret_list", { ns }),
  secretSet: (ns: string, key: string, value: string, scope: string) => invoke<SecretMeta>("secret_set", { ns, key, value, scope }),
  secretReveal: (ns: string, id: string) => invoke<string>("secret_reveal", { ns, id }),
  secretDelete: (ns: string, id: string) => invoke<void>("secret_delete", { ns, id }),
  sandboxList: (ns: string) => invoke<SandboxRecord[]>("sandbox_list", { ns }),
  sandboxCreate: (ns: string, spec: NewSandbox) => invoke<SandboxRecord>("sandbox_create", { ns, spec }),
  sandboxStart: (ns: string, id: string) => invoke<SandboxRecord>("sandbox_start", { ns, id }),
  sandboxPause: (ns: string, id: string) => invoke<SandboxRecord>("sandbox_pause", { ns, id }),
  sandboxStop: (ns: string, id: string) => invoke<SandboxRecord>("sandbox_stop", { ns, id }),
  sandboxDelete: (ns: string, id: string) => invoke<void>("sandbox_delete", { ns, id }),
};

/** Readable message from a core error ({ code, message }) or anything else thrown. */
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

const day = (ts: string) => ts.slice(0, 10);

export const toNamespace = (n: NsRecord): Namespace => ({ id: n.id, name: n.name, color: n.color, description: n.description });

export const toSecret = (m: SecretMeta): Secret => ({
  id: m.id, ns: m.ns, key: m.key, value: "", scope: m.scope as Secret["scope"], updatedAt: day(m.updated_at),
});

export const toSandbox = (r: SandboxRecord): Sandbox => ({
  id: r.id, ns: r.ns, name: r.name,
  runtime: (r.runtime === "podman" ? "podman" : "docker") as Sandbox["runtime"],
  image: r.image,
  status: (r.status === "running" || r.status === "paused" ? r.status : "stopped") as Sandbox["status"],
  cpu: r.cpu, memMb: Number(r.mem_mb), network: r.network as Sandbox["network"], createdAt: day(r.created_at),
});

/** Reload one namespace's secrets and sandboxes from the core into the store. */
export async function syncNamespace(ns: string, dispatch: (a: Action) => void) {
  const [secrets, sandboxes] = await Promise.all([api.secretList(ns), api.sandboxList(ns)]);
  dispatch({ type: "hydrateNs", ns, secrets: secrets.map(toSecret), sandboxes: sandboxes.map(toSandbox) });
}

/** Engine-reported sandbox changes (src-tauri/src/events.rs). Returns an unsubscribe function. */
export const onSandboxStatus = (fn: (e: SandboxStatusEvent) => void) => listen<SandboxStatusEvent>("sandbox://status", (e) => fn(e.payload));

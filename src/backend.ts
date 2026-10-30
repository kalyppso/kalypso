import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AuditEntry } from "./bindings/AuditEntry";
import type { Budget as BudgetRecord } from "./bindings/Budget";
import type { BudgetAlert } from "./bindings/BudgetAlert";
import type { BudgetOverview } from "./bindings/BudgetOverview";
import type { BudgetRule as BudgetRuleRecord } from "./bindings/BudgetRule";
import type { NewBudgetRule } from "./bindings/NewBudgetRule";
import type { GatewayInfo } from "./bindings/GatewayInfo";
import type { GatewayKey } from "./bindings/GatewayKey";
import type { MintedKey } from "./bindings/MintedKey";
import type { UsageEvent } from "./bindings/UsageEvent";
import type { UsageSummary } from "./bindings/UsageSummary";
import type { Namespace as NsRecord } from "./bindings/Namespace";
import type { PortForward } from "./bindings/PortForward";
import type { ProviderInfo } from "./bindings/ProviderInfo";
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
  settingsGet: (key: string) => invoke<unknown>("settings_get", { key }),
  settingsSet: (key: string, value: unknown) => invoke<void>("settings_set", { key, value }),
  nsList: () => invoke<NsRecord[]>("ns_list"),
  nsCreate: (id: string, description: string) => invoke<NsRecord>("ns_create", { id, description }),
  nsDelete: (ns: string) => invoke<void>("ns_delete", { ns }),
  secretList: (ns: string) => invoke<SecretMeta[]>("secret_list", { ns }),
  secretSet: (ns: string, key: string, value: string, scope: string) => invoke<SecretMeta>("secret_set", { ns, key, value, scope }),
  secretReveal: (ns: string, id: string) => invoke<string>("secret_reveal", { ns, id }),
  secretDelete: (ns: string, id: string) => invoke<void>("secret_delete", { ns, id }),
  gatewayInfo: () => invoke<GatewayInfo>("gateway_info"),
  gatewayKeyList: (ns: string) => invoke<GatewayKey[]>("gateway_key_list", { ns }),
  gatewayKeyCreate: (ns: string, label: string) => invoke<MintedKey>("gateway_key_create", { ns, label }),
  gatewayKeyRevoke: (ns: string, id: string) => invoke<void>("gateway_key_revoke", { ns, id }),
  pricingModels: () => invoke<string[]>("pricing_models"),
  budgetOverview: (ns: string) => invoke<BudgetOverview>("budget_overview", { ns }),
  budgetSet: (ns: string, monthlyLimit: number, alertAt: number) => invoke<BudgetRecord>("budget_set", { ns, monthlyLimit, alertAt }),
  budgetRuleCreate: (ns: string, rule: NewBudgetRule) => invoke<BudgetRuleRecord>("budget_rule_create", { ns, rule }),
  budgetRuleDelete: (ns: string, id: string) => invoke<void>("budget_rule_delete", { ns, id }),
  usageSummary: (ns: string | null, days: number) => invoke<UsageSummary>("usage_summary", { ns, days }),
  sandboxProviders: () => invoke<ProviderInfo[]>("sandbox_providers"),
  sandboxList: (ns: string) => invoke<SandboxRecord[]>("sandbox_list", { ns }),
  sandboxCreate: (ns: string, spec: NewSandbox) => invoke<SandboxRecord>("sandbox_create", { ns, spec }),
  sandboxStart: (ns: string, id: string) => invoke<SandboxRecord>("sandbox_start", { ns, id }),
  sandboxPause: (ns: string, id: string) => invoke<SandboxRecord>("sandbox_pause", { ns, id }),
  sandboxStop: (ns: string, id: string) => invoke<SandboxRecord>("sandbox_stop", { ns, id }),
  sandboxDelete: (ns: string, id: string) => invoke<void>("sandbox_delete", { ns, id }),
  portForwardOpen: (ns: string, id: string, port: number) => invoke<PortForward>("port_forward_open", { ns, id, port }),
  portForwardList: (ns: string) => invoke<PortForward[]>("port_forward_list", { ns }),
  portForwardClose: (ns: string, id: string, port: number) => invoke<boolean>("port_forward_close", { ns, id, port }),
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
  runtime: r.runtime,
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

/** Every model request metered by the gateway (src-tauri/src/events.rs). */
export const onUsage = (fn: (e: UsageEvent) => void) => listen<UsageEvent>("usage://event", (e) => fn(e.payload));

/** Budget caps reached or crossed (src-tauri/src/budget.rs). Also shown as desktop notifications. */
export const onBudgetAlert = (fn: (e: BudgetAlert) => void) => listen<BudgetAlert>("budget://alert", (e) => fn(e.payload));

/** The namespace's budget from the core, refreshed when spend or alerts arrive. Null outside the desktop app. */
export function useBudgetOverview(ns: string) {
  const [overview, setOverview] = useState<BudgetOverview | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isLive()) return;
    let gone = false;
    const load = () => api.budgetOverview(ns).then((o) => { if (!gone) setOverview(o); }).catch(() => {});
    load();
    const offs = [onUsage((e) => e.ns === ns && load()), onBudgetAlert((e) => e.ns === ns && load())];
    return () => { gone = true; offs.forEach((p) => p.then((f) => f())); };
  }, [ns, tick]);
  return { overview, reload: () => setTick((t) => t + 1) };
}

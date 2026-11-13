import { useEffect, useState } from "react";
import { Check, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, errorMessage, isLive, syncNamespace } from "../backend";
import type { ModelProvider } from "../bindings/ModelProvider";
import { useStore, useToast } from "../store";
import { Field, Skeleton } from "./ui";

/**
 * Model providers: connect any AI provider (Anthropic, OpenAI, Gemini, Mistral, DeepSeek, xAI,
 * Groq, OpenRouter, local Ollama, or anything OpenAI-compatible) and pick from its models.
 * Keys go to the vault with the gateway scope; agents never see them (src-tauri/src/providers.rs).
 */

/** Claude models offered for Anthropic: they run on the Claude runtime by bare id. */
export const CLAUDE_MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Fast, good for most work" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Stronger planning" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", note: "Most capable, costs more" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Cheapest" },
];

/** The namespace's providers, reloaded when its secrets change. */
export function useProviders() {
  const { state } = useStore();
  const [providers, setProviders] = useState<ModelProvider[] | null>(isLive() ? null : SAMPLE);
  const secretCount = state.secrets.filter((s) => s.ns === state.ns).length;
  const reload = () => { if (isLive()) api.providerList(state.ns).then(setProviders).catch(() => setProviders([])); };
  useEffect(reload, [state.ns, secretCount]);
  return { providers, connected: (providers ?? []).filter((p) => p.connected), reload };
}

// Model lists are asked of each provider once per session; "Check" asks again.
const modelCache = new Map<string, Promise<string[]>>();
export function providerModels(ns: string, id: string, fresh = false): Promise<string[]> {
  const k = `${ns}:${id}`;
  if (fresh || !modelCache.has(k)) {
    const p = id === "anthropic" && !isLive() ? Promise.resolve(CLAUDE_MODELS.map((m) => m.id)) : api.providerModels(ns, id);
    modelCache.set(k, p);
    p.catch(() => modelCache.delete(k));
  }
  return modelCache.get(k)!;
}

/** Each connected provider's models, as model ids an agent takes (`provider/model`, bare for Claude). */
export function useModelChoices(connected: ModelProvider[]) {
  const { state } = useStore();
  const [lists, setLists] = useState<Record<string, string[]>>({});
  const ids = connected.map((p) => p.id).join(",");
  useEffect(() => {
    let live = true;
    for (const p of connected) {
      if (p.id === "anthropic") continue;
      providerModels(state.ns, p.id).then((ms) => live && setLists((l) => ({ ...l, [p.id]: ms }))).catch(() => live && setLists((l) => ({ ...l, [p.id]: [] })));
    }
    return () => { live = false; };
  }, [state.ns, ids]);
  return connected.map((p) => ({
    provider: p,
    models: p.id === "anthropic"
      ? CLAUDE_MODELS.map((m) => ({ id: m.id, label: m.label }))
      : (lists[p.id] ?? []).map((m) => ({ id: `${p.id}/${m}`, label: m })),
    loading: p.id !== "anthropic" && !(p.id in lists),
  }));
}

/** What a model id is called, for toasts and labels. */
export const modelLabel = (id: string) => CLAUDE_MODELS.find((m) => m.id === id)?.label ?? id;

/** Connect one provider: pick it, paste its key (or its address for a local or custom one). */
export function ConnectProvider({ providers, onConnected, compact }: { providers: ModelProvider[]; onConnected?: (p: ModelProvider, models: string[]) => void; compact?: boolean }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const choices = providers.filter((p) => !p.custom);
  const [id, setId] = useState(choices.find((p) => !p.connected)?.id ?? "anthropic");
  const [customId, setCustomId] = useState("");
  const custom = id === "__custom";
  const preset = choices.find((p) => p.id === id);
  const [base, setBase] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setBase(preset?.local ? preset.base_url : ""); setKey(""); }, [id]);

  const save = async () => {
    const pid = custom ? customId.trim().toLowerCase() : id;
    setSaving(true);
    try {
      const p = await api.providerSave(state.ns, { id: pid, base_url: base.trim() || undefined, api_key: key.trim() || undefined });
      await syncNamespace(state.ns, dispatch);
      setKey("");
      // Listing its models proves the key and the address work.
      const models = await providerModels(state.ns, p.id, true).catch((e) => { toast(`${p.name} is saved, but: ${errorMessage(e)}`, "warn"); return null; });
      if (models) toast(`${p.name} connected${p.id === "anthropic" ? "" : `, ${models.length} model${models.length === 1 ? "" : "s"}`}`);
      onConnected?.(p, models ?? []);
    } catch (e) {
      toast(errorMessage(e), "err");
    } finally {
      setSaving(false);
    }
  };

  const needsKey = custom ? false : !!preset?.needs_key;
  const ready = custom ? /^[a-z0-9][a-z0-9-]*$/.test(customId.trim()) && /^https?:\/\//.test(base.trim()) : needsKey ? !!key.trim() || !!preset?.has_key : true;

  return (
    <div className={compact ? "provider-connect compact" : "provider-connect"}>
      <div className="field-row">
        <Field label="Provider" hint={custom ? "Anything that speaks the OpenAI chat API." : preset?.note}>
          <select className="select" value={id} onChange={(e) => setId(e.target.value)}>
            {choices.map((p) => <option key={p.id} value={p.id}>{p.name}{p.connected ? " (connected)" : ""}</option>)}
            <option value="__custom">Other (OpenAI-compatible)…</option>
          </select>
        </Field>
        {custom && (
          <Field label="Name" hint="Used in model names: name/model.">
            <input className="input mono" value={customId} onChange={(e) => setCustomId(e.target.value)} placeholder="my-llm" />
          </Field>
        )}
      </div>
      {(custom || preset?.local) && (
        <Field label="Base URL" hint={preset?.local ? "Where it listens on this machine. KALYPSO calls it from here, not from the sandbox." : "Ends before /chat/completions, often in /v1."}>
          <input className="input mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.example.com/v1" />
        </Field>
      )}
      {(needsKey || custom) && (
        <Field
          label={custom ? "API key (if it needs one)" : `${preset?.name} API key`}
          hint={preset?.keys_url ? <a href={preset.keys_url} target="_blank" rel="noreferrer" className="row" style={{ gap: 4, display: "inline-flex" }}>Get a key <ExternalLink size={11} /></a> : undefined}
        >
          <input className="input mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ready && save()} placeholder={preset?.has_key ? "Saved. Paste a new one to replace it." : "Paste the key"} />
        </Field>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" disabled={!ready || saving} onClick={save}>{saving ? "Checking…" : preset?.connected ? "Save" : "Connect"}</button>
      </div>
    </div>
  );
}

/** Settings → Models: every connected provider with its models, and a form to add another. */
export function ProvidersSection() {
  const { state } = useStore();
  const toast = useToast();
  const { providers, connected, reload } = useProviders();
  const [adding, setAdding] = useState(false);
  if (!providers) return <Skeleton rows={3} />;

  const remove = async (p: ModelProvider) => {
    if (!confirm(`Disconnect ${p.name}? Its key is removed from ${state.ns}, and agents on its models stop working until it is connected again.`)) return;
    try { await api.providerRemove(state.ns, p.id); reload(); toast(`${p.name} disconnected`, "warn"); } catch (e) { toast(errorMessage(e), "err"); }
  };

  return (
    <>
      <p className="dim" style={{ marginTop: 0 }}>
        The AI providers agents in <b>{state.ns}</b> can use. Keys stay in the vault; KALYPSO adds them to each call, so agents never see them, and every call is metered and checked against your budgets.
      </p>
      {connected.length === 0 && <p className="faint">No provider connected yet.</p>}
      <div className="provider-list">
        {connected.map((p) => <ProviderRow key={p.id} p={p} onRemove={() => remove(p)} />)}
      </div>
      {adding || connected.length === 0 ? (
        <div className="provider-add">
          <ConnectProvider providers={providers} onConnected={() => { reload(); setAdding(false); }} />
        </div>
      ) : (
        <button className="btn" onClick={() => setAdding(true)}><Plus size={14} /> Add a provider</button>
      )}
    </>
  );
}

function ProviderRow({ p, onRemove }: { p: ModelProvider; onRemove: () => void }) {
  const { state } = useStore();
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const load = (fresh = false) => {
    setError("");
    if (p.id === "anthropic" && !fresh && !isLive()) return setModels(CLAUDE_MODELS.map((m) => m.id));
    providerModels(state.ns, p.id, fresh).then(setModels).catch((e) => { setModels([]); setError(errorMessage(e)); });
  };
  useEffect(() => load(), [p.id, state.ns]);
  return (
    <div className="provider-row">
      <div className="row">
        <span className={`dot ${error ? "bad" : models ? "ok" : ""}`} style={{ background: error ? "var(--err)" : models ? "var(--ok)" : "var(--text-3)" }} />
        <b>{p.name}</b>
        <span className="faint small mono clip">{p.custom || p.local ? p.base_url : p.id}</span>
        <span className="spacer" />
        {models && !error && (
          <button className="btn ghost sm" onClick={() => setOpen(!open)}>{models.length} model{models.length === 1 ? "" : "s"}</button>
        )}
        <button className="btn ghost sm icon" title="Check the connection again" onClick={() => load(true)}><RefreshCw size={13} /></button>
        <button className="btn ghost sm icon danger" title={`Disconnect ${p.name}`} onClick={onRemove}><Trash2 size={13} /></button>
      </div>
      {error && <p className="small" style={{ color: "var(--err)", margin: "6px 0 0" }}>{error}</p>}
      {open && models && (
        <div className="provider-models mono small">
          {models.map((m) => <span key={m} className="badge">{m}</span>)}
        </div>
      )}
      {!error && models && p.id !== "anthropic" && <p className="faint small" style={{ margin: "6px 0 0" }}><Check size={11} /> Agents use these as <span className="mono">{p.id}/model</span>.</p>}
    </div>
  );
}

/** Browser preview: what a namespace with Anthropic and Ollama connected looks like. */
const SAMPLE: ModelProvider[] = [
  { id: "anthropic", name: "Anthropic", base_url: "https://api.anthropic.com", needs_key: true, keys_url: "https://console.anthropic.com/settings/keys", local: false, note: "Claude models, on the Claude runtime with prompt caching.", connected: true, has_key: true, custom: false, runtime: "claude-sdk" },
  { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", needs_key: true, keys_url: "https://platform.openai.com/api-keys", local: false, note: "GPT models.", connected: false, has_key: false, custom: false, runtime: "openai-compat" },
  { id: "google", name: "Google Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", needs_key: true, keys_url: "https://aistudio.google.com/apikey", local: false, note: "Gemini models, through Google's OpenAI-compatible endpoint.", connected: false, has_key: false, custom: false, runtime: "openai-compat" },
  { id: "ollama", name: "Ollama", base_url: "http://localhost:11434/v1", needs_key: false, keys_url: "", local: true, note: "Models on this machine. Free per token.", connected: false, has_key: false, custom: false, runtime: "openai-compat" },
];

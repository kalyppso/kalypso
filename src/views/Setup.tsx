import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { api, errorMessage, isLive, syncNamespace } from "../backend";
import { useNamespaced, useStore, useToast } from "../store";
import { Modal } from "../components/ui";
import { RUNNER_IMAGE } from "./Agents";
import type { EngineStatus } from "../bindings/EngineStatus";

// First-run setup (#94): engine, model key, first sandbox, first agent. It opens on the first
// launch, can be skipped, picks up where it left off (each step checks the real state), and
// Settings can open it again.

const SETTINGS_KEY = "setup";
type Mark = { done?: boolean; skipped?: boolean };
type StepId = "engine" | "key" | "sandbox" | "agent";
const STEPS: { id: StepId; title: string }[] = [
  { id: "engine", title: "Container engine" },
  { id: "key", title: "Model key" },
  { id: "sandbox", title: "First sandbox" },
  { id: "agent", title: "First agent" },
];
const AGENT_NAME = "scout";
const MODEL = "claude-sonnet-5-5";
const STARTER_TASK =
  "Look around your workspace in /work: list what's there, then write a short notes.md saying what you found. Keep it brief.";

/** Open the setup wizard from anywhere (Overview, Settings). */
export const openSetup = () => window.dispatchEvent(new Event("kalypso:setup"));

export function Setup() {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  // First launch: open, unless it was finished or skipped before.
  useEffect(() => {
    if (!isLive() || !state.session) return;
    api.settingsGet(SETTINGS_KEY)
      .then((v) => { const m = (v ?? {}) as Mark; if (!m.done && !m.skipped) setOpen(true); })
      .catch(() => {});
  }, [state.session]);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("kalypso:setup", on);
    return () => window.removeEventListener("kalypso:setup", on);
  }, []);
  if (!open || !isLive()) return null;
  return <Wizard onClose={(mark) => { if (mark) api.settingsSet(SETTINGS_KEY, mark).catch(() => {}); setOpen(false); }} />;
}

function Wizard({ onClose }: { onClose: (mark?: Mark) => void }) {
  const { state, dispatch } = useStore();
  const { secrets, sandboxes, agents } = useNamespaced();
  const ns = state.ns;
  const refresh = () => syncNamespace(ns, dispatch).catch(() => {});

  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [keyCheck, setKeyCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const box = sandboxes.find((s) => /agent-runner/.test(s.image));
  const agent = agents.find((a) => a.name === AGENT_NAME) ?? agents.find((a) => box && a.sandboxId === box.id);
  const hasKey = secrets.some((s) => s.key === "ANTHROPIC_API_KEY");

  const done: Record<StepId, boolean> = {
    engine: !!engine && engine.connected !== "none",
    key: keyCheck?.ok === true,
    sandbox: !!box && box.status === "running",
    agent: !!agent && ["running", "starting", "idle"].includes(agent.status),
  };
  const [step, setStep] = useState<StepId | "done" | null>(null);

  const checkEngine = () => api.setupEngine().then(setEngine).catch(() => setEngine({ connected: "none", found: null, os: "linux", podman_cli: false, docker_cli: false }));
  const checkKey = () => api.setupKeyCheck(ns).then(setKeyCheck).catch((e) => setKeyCheck({ ok: false, message: errorMessage(e) }));
  useEffect(() => { checkEngine(); refresh(); }, []);
  useEffect(() => { if (hasKey && !keyCheck) checkKey(); }, [hasKey]);
  // Resume: start at the first step that isn't done, once the engine and key are known.
  useEffect(() => {
    if (step !== null || !engine || (hasKey && !keyCheck)) return;
    setStep(STEPS.find((s) => !done[s.id])?.id ?? "done");
  }, [engine, keyCheck, hasKey]);

  const next = (from: StepId) => {
    const i = STEPS.findIndex((s) => s.id === from);
    setStep(STEPS.slice(i + 1).find((s) => !done[s.id])?.id ?? "done");
  };

  return (
    <Modal wide title="Set up KALYPSO" subtitle={`Four steps to a running agent, in the ${ns} namespace.`} onClose={() => onClose()}>
      <div className="setup">
        <ol className="setup-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button className={`setup-step${step === s.id ? " on" : ""}${done[s.id] ? " done" : ""}`} onClick={() => setStep(s.id)} aria-current={step === s.id ? "step" : undefined}>
                <span className="gs-mark" aria-hidden>{done[s.id] ? <Check size={13} /> : i + 1}</span>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
        <div className="setup-body">
          {step === null && <p className="faint"><Loader2 size={14} className="spin" /> Checking what's already set up…</p>}
          {step === "engine" && <EngineStep engine={engine} recheck={checkEngine} ok={done.engine} onNext={() => next("engine")} />}
          {step === "key" && <KeyStep ns={ns} hasKey={hasKey} check={keyCheck} recheck={checkKey} refresh={refresh} onNext={() => next("key")} />}
          {step === "sandbox" && <SandboxStep ns={ns} engineOk={done.engine} box={box} names={sandboxes.map((s) => s.name)} refresh={refresh} onNext={() => next("sandbox")} />}
          {step === "agent" && <AgentStep ns={ns} box={box} agent={agent} keyOk={done.key} refresh={refresh} onNext={() => next("agent")} />}
          {step === "done" && (
            <Panel title="You're set up." lead={`${agent ? `${agent.name} is` : "Your agent is"} working in its sandbox. Every tool call it makes is checked against your policies, and risky ones wait for you.`}>
              <div className="setup-actions">
                <button className="btn primary" onClick={() => { dispatch({ type: "view", view: "agents" }); onClose({ done: true }); }}>Watch it work <ChevronRight size={13} /></button>
                <button className="btn ghost" onClick={() => onClose({ done: true })}>Close</button>
              </div>
            </Panel>
          )}
        </div>
      </div>
      {step !== "done" && (
        <div className="setup-foot">
          <button className="btn ghost sm" onClick={() => onClose({ skipped: true })}>Skip for now</button>
          <span className="faint small">You can open this again from Settings.</span>
        </div>
      )}
    </Modal>
  );
}

function Panel({ title, lead, children }: { title: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <section className="setup-panel">
      <h3>{title}</h3>
      {lead && <p className="setup-lead">{lead}</p>}
      {children}
    </section>
  );
}

function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <p className={`setup-status ${ok ? "ok" : "bad"}`} role="status">{ok && <Check size={14} />}{children}</p>;
}

/** Something went wrong: what happened, and what to do about it. */
function Problem({ what, fix, detail }: { what: string; fix?: ReactNode; detail?: string }) {
  return (
    <div className="setup-problem" role="alert">
      <div>{what}</div>
      {fix && <div className="faint small">{fix}</div>}
      {detail && <details><summary className="faint small">Details</summary><code className="small">{detail}</code></details>}
    </div>
  );
}

function Cmd({ cmd }: { cmd: string }) {
  const toast = useToast();
  return (
    <div className="setup-cmd">
      <code>{cmd}</code>
      <button className="btn ghost sm icon" title="Copy" onClick={() => navigator.clipboard.writeText(cmd).then(() => toast("Copied", "info"))}><Copy size={13} /></button>
    </div>
  );
}

const pretty = (kind: string) => (kind === "podman" ? "Podman" : kind === "docker" ? "Docker" : kind);

function engineAdvice(e: EngineStatus): { text: string; cmd?: string; link?: string }[] {
  if (e.os === "linux") {
    if (e.podman_cli) return [{ text: "Podman is installed, but its API socket is off. Turn it on:", cmd: "systemctl --user enable --now podman.socket" }];
    if (e.docker_cli) return [{ text: "Docker is installed but not running. Start it:", cmd: "sudo systemctl enable --now docker" }];
    return [
      { text: "Install Podman with your package manager:", cmd: "sudo apt install podman    # Fedora: sudo dnf install podman" },
      { text: "Then turn on its API socket:", cmd: "systemctl --user enable --now podman.socket" },
    ];
  }
  if (e.podman_cli) return [{ text: "Podman is installed. Start its virtual machine:", cmd: "podman machine init; podman machine start" }];
  if (e.docker_cli) return [{ text: "Docker is installed but not running. Open Docker Desktop and wait until it says it's running." }];
  return [{ text: "Install Podman Desktop (or Docker Desktop), open it, and let it set up its machine.", link: "https://podman-desktop.io/downloads" }];
}

function EngineStep({ engine, recheck, ok, onNext }: { engine: EngineStatus | null; recheck: () => Promise<unknown>; ok: boolean; onNext: () => void }) {
  const [busy, setBusy] = useState(false);
  const again = () => { setBusy(true); recheck().finally(() => setBusy(false)); };
  return (
    <Panel title="Connect a container engine" lead="Every agent runs in its own container. KALYPSO uses Podman or Docker for that, and finds either on its own.">
      {!engine && <p className="faint"><Loader2 size={14} className="spin" /> Looking for Podman or Docker…</p>}
      {engine && ok && <Status ok>{pretty(engine.connected)} is connected.</Status>}
      {engine && !ok && engine.found && (
        <>
          <Status ok={false}>{pretty(engine.found)} is running now, but KALYPSO started before it.</Status>
          <p className="setup-lead">Restart KALYPSO to connect to it. This setup opens again where you left off.</p>
          <div className="setup-actions"><button className="btn primary" onClick={() => api.appRestart()}><RefreshCw size={13} /> Restart KALYPSO</button></div>
        </>
      )}
      {engine && !ok && !engine.found && (
        <>
          <Problem what="No container engine is running." fix="Do this, then check again:" />
          <ol className="setup-howto">
            {engineAdvice(engine).map((a) => (
              <li key={a.text}>
                {a.text}
                {a.cmd && <Cmd cmd={a.cmd} />}
                {a.link && <a className="btn sm" href={a.link} target="_blank" rel="noreferrer">Download <ExternalLink size={12} /></a>}
              </li>
            ))}
          </ol>
          <div className="setup-actions"><button className="btn" disabled={busy} onClick={again}>{busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Check again</button></div>
        </>
      )}
      {ok && <div className="setup-actions"><button className="btn primary" onClick={onNext}>Continue <ChevronRight size={13} /></button></div>}
    </Panel>
  );
}

function KeyStep({ ns, hasKey, check, recheck, refresh, onNext }: {
  ns: string; hasKey: boolean; check: { ok: boolean; message: string } | null; recheck: () => Promise<unknown>; refresh: () => Promise<unknown>; onNext: () => void;
}) {
  const [value, setValue] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = !hasKey || replace;
  const save = async () => {
    const v = value.trim();
    if (!v) { setError("Paste your key first."); return; }
    setBusy(true); setError(null);
    try {
      await api.secretSet(ns, "ANTHROPIC_API_KEY", v, "gateway");
      setValue(""); setReplace(false);
      await refresh();
      await recheck();
    } catch (e) { setError(errorMessage(e)); }
    setBusy(false);
  };
  const again = () => { setBusy(true); recheck().finally(() => setBusy(false)); };
  return (
    <Panel title="Add your Anthropic key" lead={<>It goes in the <b>{ns}</b> vault with the gateway scope: the gateway adds it to model calls, and agents never see it. It isn't shown again.</>}>
      {hasKey && check && <Status ok={check.ok}>{check.message}</Status>}
      {hasKey && !check && <p className="faint"><Loader2 size={14} className="spin" /> Testing the key…</p>}
      {hasKey && check && !check.ok && !replace && (
        <Problem what="The key didn't pass the test." fix="Test again, or replace the key with a new one." />
      )}
      {editing && (
        <>
          <label className="field">
            ANTHROPIC_API_KEY
            <input className="input mono" type="password" autoFocus autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={value}
              onChange={(e) => { setValue(e.target.value); setError(null); }} onKeyDown={(e) => e.key === "Enter" && save()} />
          </label>
          <p className="faint small">Create one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>. Using an OpenAI-compatible API or Ollama instead? Add it in Secrets and skip this step.</p>
          {error && <Problem what="The key couldn't be saved." detail={error} />}
        </>
      )}
      <div className="setup-actions">
        {editing && <button className="btn primary" disabled={busy} onClick={save}>{busy ? <Loader2 size={13} className="spin" /> : null} Save and test</button>}
        {!editing && check?.ok && <button className="btn primary" onClick={onNext}>Continue <ChevronRight size={13} /></button>}
        {!editing && <button className="btn" disabled={busy} onClick={again}>{busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Test again</button>}
        {!editing && <button className="btn ghost" onClick={() => setReplace(true)}>Replace key</button>}
        {editing && hasKey && <button className="btn ghost" onClick={() => { setReplace(false); setValue(""); }}>Cancel</button>}
        {!check?.ok && <button className="btn ghost" onClick={onNext}>Skip this step</button>}
      </div>
    </Panel>
  );
}

/** A sandbox error, said in plain words. */
function sandboxProblem(e: string): { what: string; fix: string } {
  if (/denied|unauthori[sz]ed|403|manifest unknown|not found|pull access/i.test(e))
    return { what: "The agent image couldn't be downloaded.", fix: `The registry refused ${RUNNER_IMAGE}. Check your connection and try again; if it keeps failing, report it on GitHub.` };
  if (/timeout|timed out|connection|network|dns|resolve/i.test(e))
    return { what: "The download stopped partway.", fix: "Check your internet connection, then try again." };
  if (/no Docker or Podman/i.test(e)) return { what: "No container engine is connected.", fix: "Go back to the first step." };
  return { what: "The sandbox couldn't be created.", fix: "Try again. If it keeps failing, the details below help when you report it." };
}

function SandboxStep({ ns, engineOk, box, names, refresh, onNext }: {
  ns: string; engineOk: boolean; box: ReturnType<typeof useNamespaced>["sandboxes"][number] | undefined; names: string[]; refresh: () => Promise<unknown>; onNext: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy("Downloading the agent image and starting the sandbox. The first time can take a minute or two."); setError(null);
    let name = "workspace";
    for (let i = 2; names.includes(name); i++) name = `workspace-${i}`;
    try {
      await api.sandboxCreate(ns, { name, image: RUNNER_IMAGE, cpu: 2, mem_mb: 2048, network: "namespace" });
      await refresh();
    } catch (e) { setError(errorMessage(e)); }
    setBusy(null);
  };
  const start = async () => {
    if (!box) return;
    setBusy("Starting the sandbox…"); setError(null);
    try { await api.sandboxStart(ns, box.id); await refresh(); } catch (e) { setError(errorMessage(e)); }
    setBusy(null);
  };
  const p = error ? sandboxProblem(error) : null;
  return (
    <Panel title="Create a sandbox" lead="A container with the KALYPSO agent runner: read-only root, no extra privileges, on this namespace's own network.">
      {!engineOk && <Problem what="Connect a container engine first." fix="The first step shows how." />}
      {box && <Status ok={box.status === "running"}>{box.name} is {box.status}.</Status>}
      {busy && <p className="faint"><Loader2 size={14} className="spin" /> {busy}</p>}
      {p && <Problem what={p.what} fix={p.fix} detail={error ?? undefined} />}
      <div className="setup-actions">
        {!box && <button className="btn primary" disabled={!engineOk || !!busy} onClick={create}>Create sandbox</button>}
        {box && box.status !== "running" && <button className="btn primary" disabled={!!busy} onClick={start}>Start it</button>}
        {box && box.status === "running" && <button className="btn primary" onClick={onNext}>Continue <ChevronRight size={13} /></button>}
      </div>
      <p className="faint small">Image: <code>{RUNNER_IMAGE}</code></p>
    </Panel>
  );
}

function AgentStep({ ns, box, agent, keyOk, refresh, onNext }: {
  ns: string; box: { id: string; name: string; status: string } | undefined; agent: { id: string; name: string; status: string; statusReason?: string | null } | undefined;
  keyOk: boolean; refresh: () => Promise<unknown>; onNext: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ what: string; detail: string } | null>(null);
  const [sent, setSent] = useState(false);

  // Start it, wait until it's running, then hand it the starter task.
  const run = async (id: string) => {
    setBusy("Starting the agent…");
    await api.agentStart(ns, id);
    for (let i = 0; i < 30; i++) {
      const a = (await api.agentList(ns)).find((x) => x.id === id);
      if (a?.status === "running") break;
      if (a && ["failed", "error", "stopped"].includes(a.status)) throw new Error(a.status_reason || `the agent ${a.status}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setBusy("Giving it a first task…");
    await api.agentSend(ns, id, STARTER_TASK);
    setSent(true);
  };
  const go = async () => {
    if (!box) return;
    setError(null);
    try {
      if (agent) await run(agent.id);
      else {
        setBusy("Creating the agent…");
        const rec = await api.agentCreate(ns, {
          name: AGENT_NAME, role: "Your first agent. It explores its workspace and reports back.", runtime: "claude-sdk", model: MODEL,
          sandbox_id: box.id, restart: "on-failure", max_restarts: 3, max_turns: 20,
        });
        await refresh();
        await run(rec.id);
      }
      await refresh();
    } catch (e) {
      const d = errorMessage(e);
      setError({ what: /runner/i.test(d) ? "The sandbox doesn't have the agent runner." : /key|401|ANTHROPIC/i.test(d) ? "The agent couldn't reach the model." : "The agent didn't start.", detail: d });
      await refresh();
    }
    setBusy(null);
  };
  const running = !!agent && ["running", "starting", "idle"].includes(agent.status);
  return (
    <Panel title="Start your first agent" lead={<>A Claude agent called <b>{AGENT_NAME}</b>, in {box ? <b>{box.name}</b> : "your sandbox"}. Its first task: look around its workspace and write a short note. At most 20 turns.</>}>
      {!box && <Problem what="Create the sandbox first." fix="The previous step does it." />}
      {!keyOk && <p className="faint small">Without a working model key the agent starts, but can't think. Add the key in step two.</p>}
      {agent && <Status ok={running}>{agent.name} is {agent.status}{agent.statusReason ? `: ${agent.statusReason}` : ""}.</Status>}
      {sent && <p className="setup-lead">It has its first task. Open Agents to watch it work; when it does something risky, you'll be asked first.</p>}
      {busy && <p className="faint"><Loader2 size={14} className="spin" /> {busy}</p>}
      {error && <Problem what={error.what} fix="Check the details, fix what they point at, and try again." detail={error.detail} />}
      <div className="setup-actions">
        {(!running || !sent) && <button className="btn primary" disabled={!box || !!busy} onClick={go}>{agent ? (running ? "Give it the first task" : "Start it") : "Create and start"}</button>}
        {running && <button className={sent ? "btn primary" : "btn"} onClick={onNext}>Continue <ChevronRight size={13} /></button>}
      </div>
    </Panel>
  );
}

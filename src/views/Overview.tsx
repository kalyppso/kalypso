import { useEffect, useState } from "react";
import { Bot, Boxes, Cable, Check, ChevronRight, KanbanSquare, KeyRound, ShieldCheck, SquareTerminal, type LucideIcon } from "lucide-react";
import { useNamespaced, useStore } from "../store";
import { PageHead } from "../components/ui";
import { ContributionGraph } from "../components/ContributionGraph";
import { api, isLive, useBudgetOverview } from "../backend";
import { BudgetBlocks } from "./Budget";
import type { ViewId } from "../types";

// Quick actions open the target page with its create form already showing.
const ACTIONS: { view: ViewId | "terminal"; label: string; hint: string; icon: LucideIcon; compose: boolean }[] = [
  { view: "agents", label: "New agent", hint: "Pick a model, sandbox and tools", icon: Bot, compose: true },
  { view: "tracker", label: "New task", hint: "Hand work to an agent", icon: KanbanSquare, compose: true },
  { view: "sandboxes", label: "New sandbox", hint: "An isolated container", icon: Boxes, compose: true },
  { view: "secrets", label: "Add secret", hint: "Encrypted, handed over as a file", icon: KeyRound, compose: true },
  { view: "policies", label: "New policy", hint: "A guardrail in plain language", icon: ShieldCheck, compose: true },
  { view: "connections", label: "New connection", hint: "Link agents and tools", icon: Cable, compose: true },
  { view: "terminal", label: "Open terminal", hint: "A shell inside a sandbox", icon: SquareTerminal, compose: false },
];

export function Overview() {
  const { state, dispatch } = useStore();
  const { namespace, repos } = useNamespaced();
  const repoIds = new Set(repos.map((r) => r.id));
  const nsCommits = state.commits.filter((c) => repoIds.has(c.repoId));
  const { overview: budget } = useBudgetOverview(state.ns);

  return (
    <>
      <PageHead title="Overview" subtitle={namespace?.description} />
      <BudgetBlocks overview={budget} />

      <div className="actions">
        {ACTIONS.map(({ view, label, hint, icon: Icon, compose }) => (
          <button key={label} className="action" onClick={() => dispatch(view === "terminal" ? { type: "openTool", tool: "terminal" } : { type: "view", view, compose })}>
            <span className="action-icon"><Icon size={16} /></span>
            <span style={{ minWidth: 0 }}>
              <span className="action-label">{label}</span>
              <span className="action-hint clip">{hint}</span>
            </span>
          </button>
        ))}
      </div>

      {isLive() && <GettingStarted />}
      {/* The desktop app shows the graph once real commits arrive (#29, #100). */}
      {(!isLive() || nsCommits.length > 0) && <ContributionGraph commits={nsCommits} seed={state.ns.length * 131 + 7} history={!isLive()} />}
    </>
  );
}

/** What a new namespace still needs before an agent can do real work. Hidden once it's all done. */
function GettingStarted() {
  const { state, dispatch } = useStore();
  const { sandboxes, agents, secrets, policies } = useNamespaced();
  const [engine, setEngine] = useState<string | null>(null);
  useEffect(() => { api.coreInfo().then((c) => setEngine(c?.runtime ?? "none")).catch(() => setEngine("none")); }, []);

  const steps: { done: boolean; title: string; hint: string; go: () => void; cta: string }[] = [
    {
      done: !!engine && engine !== "none",
      title: "Connect a container engine",
      hint: engine && engine !== "none" ? `${engine[0].toUpperCase()}${engine.slice(1)} is connected.` : "Install and start Docker or Podman. KALYPSO finds it on its own.",
      go: () => window.open("https://podman-desktop.io/downloads", "_blank"), cta: "Get Podman",
    },
    {
      done: secrets.some((s) => /_API_KEY$/.test(s.key)),
      title: "Add a model key",
      hint: "For example ANTHROPIC_API_KEY, with the gateway scope. Agents never see it.",
      go: () => dispatch({ type: "view", view: "secrets", compose: true }), cta: "Add secret",
    },
    {
      done: sandboxes.length > 0,
      title: "Create a sandbox",
      hint: "For Claude agents, use the image ghcr.io/kalyppso/agent-runner:latest.",
      go: () => dispatch({ type: "view", view: "sandboxes", compose: true }), cta: "New sandbox",
    },
    {
      done: agents.length > 0,
      title: "Create an agent",
      hint: "Give it a task, and it starts working in its sandbox.",
      go: () => dispatch({ type: "view", view: "agents", compose: true }), cta: "New agent",
    },
    {
      done: policies.length > 0,
      title: "Review your policies",
      hint: "Guardrails every tool call is checked against.",
      go: () => dispatch({ type: "view", view: "policies" }), cta: "Policies",
    },
  ];
  const left = steps.filter((s) => !s.done).length;
  if (engine === null || left === 0) return null;

  return (
    <section className="card getting-started" aria-label="Getting started">
      <div className="card-head">
        <span className="card-title">Getting started in {state.ns}</span>
        <span className="faint small">{steps.length - left} of {steps.length} done</span>
      </div>
      <ol className="gs-steps">
        {steps.map((s, i) => (
          <li key={s.title} className={s.done ? "done" : ""}>
            <span className="gs-mark" aria-hidden>{s.done ? <Check size={13} /> : i + 1}</span>
            <div className="gs-text">
              <div>{s.title}</div>
              <div className="faint small">{s.hint}</div>
            </div>
            {!s.done && <button className="btn sm" onClick={s.go}>{s.cta} <ChevronRight size={13} /></button>}
          </li>
        ))}
      </ol>
    </section>
  );
}

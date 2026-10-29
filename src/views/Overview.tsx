import { Bot, Boxes, Cable, KanbanSquare, KeyRound, ShieldCheck, SquareTerminal, type LucideIcon } from "lucide-react";
import { useNamespaced, useStore } from "../store";
import { PageHead } from "../components/ui";
import { ContributionGraph } from "../components/ContributionGraph";
import type { ViewId } from "../types";

// Quick actions open the target page with its create form already showing.
const ACTIONS: { view: ViewId; label: string; hint: string; icon: LucideIcon; compose: boolean }[] = [
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

  return (
    <>
      <PageHead title="Overview" subtitle={namespace?.description} />

      <div className="actions">
        {ACTIONS.map(({ view, label, hint, icon: Icon, compose }) => (
          <button key={label} className="action" onClick={() => dispatch({ type: "view", view, compose })}>
            <span className="action-icon"><Icon size={16} /></span>
            <span style={{ minWidth: 0 }}>
              <span className="action-label">{label}</span>
              <span className="action-hint clip">{hint}</span>
            </span>
          </button>
        ))}
      </div>

      <ContributionGraph commits={nsCommits} seed={state.ns.length * 131 + 7} />
    </>
  );
}

import { Plus } from "lucide-react";
import { monthSpend, useNamespaced, useStore } from "../store";
import { PageHead, PrimaryButton, Status, initials, usd } from "../components/ui";
import { ContributionGraph } from "../components/ContributionGraph";
import { MonitoringPanel } from "./Monitoring";
import type { ViewId } from "../types";

// Layout, top to bottom: headline numbers, a year of commits, three equal
// "what's happening" cards, then live monitoring. Each row is full width and
// its cards share one height, so nothing hangs off one side.
const LIST_MAX = 4;

export function Overview() {
  const { state, dispatch } = useStore();
  const { agents, sandboxes, connections, budget, namespace, policyEvents, activity, integrations, repos } = useNamespaced();
  const spend = monthSpend(state.usage, agents.map((a) => a.id));
  const limit = budget?.monthlyLimit ?? 0;
  const pct = limit ? spend / limit : 0;
  const running = agents.filter((a) => a.status === "running").length;
  const stops = policyEvents.filter((e) => e.outcome === "blocked" || e.outcome === "denied").length;
  const go = (view: ViewId) => dispatch({ type: "view", view });
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const repoIds = new Set(repos.map((r) => r.id));
  const nsCommits = state.commits.filter((c) => repoIds.has(c.repoId));

  const attention = [
    ...agents.filter((a) => a.status === "error").map((a) => ({ id: a.id, text: `${a.name} stopped with an error`, view: "agents" as const })),
    ...connections.filter((c) => c.status === "down").map((c) => ({ id: c.id, text: `Link ${agentName(c.from)} to ${agentName(c.to)} is down`, view: "connections" as const })),
    ...integrations.filter((i) => i.status === "error").map((i) => ({ id: i.id, text: `${i.name}: ${i.lastSync}`, view: "integrations" as const })),
    ...state.mcps.filter((m) => m.enabled && m.health !== "healthy").map((m) => ({ id: m.id, text: `MCP server ${m.name} is ${m.health}`, view: "registry" as const })),
    ...(pct >= (budget?.alertAt ?? 1) ? [{ id: "budget", text: `Spend is at ${Math.round(pct * 100)}% of the limit`, view: "budget" as const }] : []),
  ];

  return (
    <>
      <PageHead title="Overview" subtitle={namespace?.description}>
        <PrimaryButton onClick={() => go("agents")} icon={<Plus size={14} />}>New agent</PrimaryButton>
      </PageHead>

      <div className="stats">
        <Stat label="Agents running" value={`${running} / ${agents.length}`} sub={`${agents.length - running} idle or stopped`} onClick={() => go("agents")} />
        <Stat label="Sandboxes" value={String(sandboxes.length)} sub={`${sandboxes.filter((s) => s.status === "running").length} running`} onClick={() => go("sandboxes")} />
        <Stat label="Spend this month" value={usd(spend)} sub={`${Math.round(pct * 100)}% of ${usd(limit)}`} onClick={() => go("budget")} />
        <Stat label="Policy stops today" value={String(stops)} sub={`${policyEvents.length} events`} onClick={() => go("policies")} />
      </div>

      <ContributionGraph commits={nsCommits} seed={state.ns.length * 131 + 7} />

      <div className="cols-3 even" style={{ marginBottom: 32 }}>
        <ListCard title="Activity" count={activity.length} empty="Nothing has happened in this namespace yet.">
          {activity.slice().reverse().slice(0, LIST_MAX).map((a) => (
            <div key={a.id} className="list-row" title={`${agentName(a.agentId)} ${a.text}`}>
              <span className="avatar">{initials(agentName(a.agentId))}</span>
              <div className="clip" style={{ flex: 1 }}>
                <span style={{ fontWeight: 500 }}>{agentName(a.agentId)}</span> <span className="dim">{a.text}</span>
              </div>
              <span className="faint mono small">{a.at}</span>
            </div>
          ))}
        </ListCard>

        <ListCard title="Needs attention" count={attention.length} empty="Nothing needs you right now.">
          {attention.slice(0, LIST_MAX).map((a) => (
            <div key={a.id} className="list-row">
              <span className="clip" style={{ flex: 1 }} title={a.text}>{a.text}</span>
              <button className="btn sm" onClick={() => go(a.view)}>Open</button>
            </div>
          ))}
        </ListCard>

        <ListCard title="Policy events" count={policyEvents.length} empty="No policy events today." action={<button className="btn ghost sm" onClick={() => go("policies")}>View all</button>}>
          {policyEvents.slice(0, LIST_MAX).map((e) => (
            <div key={e.id} className="list-row">
              <Status value={e.outcome} />
              <span className="mono dim small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{e.detail}</span>
              <span className="faint mono small">{e.at}</span>
            </div>
          ))}
        </ListCard>
      </div>

      <MonitoringPanel />
    </>
  );
}

function ListCard({ title, count, empty, action, children }: { title: string; count: number; empty: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{title}</span>
        <span className="spacer" />
        {action ?? <span className="faint small">{count}</span>}
      </div>
      {count === 0 ? <div className="faint">{empty}</div> : children}
    </div>
  );
}

function Stat({ label, value, sub, onClick }: { label: string; value: string; sub: string; onClick?: () => void }) {
  return (
    <div className="stat" onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

import { useId, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { dailySeries, monthSpend, useNamespaced, useStore } from "../store";
import { PageHead, Status, initials, usd } from "../components/ui";
import { MonitoringPanel } from "./Monitoring";
import type { ViewId } from "../types";

// Layout, top to bottom: headline numbers that open their page, three equal
// "what's happening" cards, then live monitoring.
const LIST_MAX = 4;

export function Analytics() {
  const { state, dispatch } = useStore();
  const { agents, sandboxes, connections, budget, policyEvents, activity, integrations } = useNamespaced();
  const spend = monthSpend(state.usage, agents.map((a) => a.id));
  const limit = budget?.monthlyLimit ?? 0;
  const pct = limit ? spend / limit : 0;
  const running = agents.filter((a) => a.status === "running").length;
  const isStop = (o: string) => o === "blocked" || o === "denied";
  const stops = policyEvents.filter((e) => isStop(e.outcome)).length;
  const sandboxesUp = sandboxes.filter((s) => s.status === "running").length;
  const go = (view: ViewId) => dispatch({ type: "view", view });
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;

  const attention = [
    ...agents.filter((a) => a.status === "error").map((a) => ({ id: a.id, text: `${a.name} stopped with an error`, view: "agents" as const })),
    ...connections.filter((c) => c.status === "down").map((c) => ({ id: c.id, text: `Link ${agentName(c.from)} to ${agentName(c.to)} is down`, view: "connections" as const })),
    ...integrations.filter((i) => i.status === "error").map((i) => ({ id: i.id, text: `${i.name}: ${i.lastSync}`, view: "integrations" as const })),
    ...state.mcps.filter((m) => m.enabled && m.health !== "healthy").map((m) => ({ id: m.id, text: `MCP server ${m.name} is ${m.health}`, view: "registry" as const })),
    ...(pct >= (budget?.alertAt ?? 1) ? [{ id: "budget", text: `Spend is at ${Math.round(pct * 100)}% of the limit`, view: "budget" as const }] : []),
  ];

  return (
    <>
      <PageHead title="Analytics" subtitle="Activity, spend and health for this namespace, and what needs you." />

      <div className="stats">
        <Stat label="Agents running" value={`${running} / ${agents.length}`} sub={`${agents.length - running} idle or stopped`} onClick={() => go("agents")} art={<Ring value={running} total={agents.length} />} />
        <Stat label="Sandboxes" value={String(sandboxes.length)} sub={`${sandboxesUp} running`} onClick={() => go("sandboxes")} art={<Ring value={sandboxesUp} total={sandboxes.length} />} />
        <Stat label="Spend this month" value={usd(spend)} sub={`${Math.round(pct * 100)}% of ${usd(limit)}`} onClick={() => go("budget")} art={<Spark values={dailySeries(state.usage, agents.map((a) => a.id))} />} />
        <Stat label="Policy stops today" value={String(stops)} sub={`${policyEvents.length} events`} onClick={() => go("policies")} art={<Pips marks={policyEvents.map((e) => isStop(e.outcome))} />} />
      </div>

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

function Stat({ label, value, sub, art, onClick }: { label: string; value: string; sub: string; art: ReactNode; onClick: () => void }) {
  return (
    <button className="stat stat-link" onClick={onClick}>
      <div className="row">
        <span className="stat-label">{label}</span>
        <ArrowUpRight size={14} className="stat-arrow" />
      </div>
      <div className="stat-body">
        <div style={{ minWidth: 0 }}>
          <div className="stat-value">{value}</div>
          <div className="stat-sub">{sub}</div>
        </div>
        <div className="stat-art" aria-hidden>{art}</div>
      </div>
    </button>
  );
}

// Share of a whole, as a donut.
function Ring({ value, total }: { value: number; total: number }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const share = total ? value / total : 0;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44">
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="5" />
      <circle cx="22" cy="22" r={r} fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${c * share} ${c}`} transform="rotate(-90 22 22)" />
    </svg>
  );
}

// Trend line with a fading fill under it.
function Spark({ values }: { values: number[] }) {
  const id = useId();
  const w = 88, h = 40;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${((i / Math.max(values.length - 1, 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.35" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts.join(" ")} ${w},${h}`} fill={`url(#${id})`} />
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// One bar per event; the ones that stopped something are lit.
function Pips({ marks }: { marks: boolean[] }) {
  const shown = marks.slice(-12);
  const w = shown.length * 7.5;
  return (
    <svg width={w} height="40" viewBox={`0 0 ${w} 40`}>
      {shown.map((on, i) => (
        <rect key={i} x={i * 7.5} y={on ? 6 : 20} width="4.5" height={on ? 34 : 20} rx="2.25" fill={on ? "currentColor" : "var(--border-strong)"} />
      ))}
    </svg>
  );
}

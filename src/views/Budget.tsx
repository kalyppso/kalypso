import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { dailySeries, monthSpend, uid, useNamespaced, useStore, useToast } from "../store";
import { Modal, ModalActions, PageHead, PrimaryButton, usd } from "../components/ui";
import type { BudgetAction, BudgetPeriod, BudgetRule } from "../types";

// One accent for the biggest spender, then stepped neutrals. No rainbow.
const SERIES = ["var(--accent-hi)", "var(--text-2)", "var(--text-3)", "var(--border-strong)", "var(--border)"];
const ACTION_LABEL: Record<BudgetAction, string> = { pause: "Pause agent", alert: "Alert me", downgrade: "Downgrade model" };
const DAYS_IN_MONTH = 31;

export function Budget() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, budget, budgetRules } = useNamespaced();
  const [limitDraft, setLimitDraft] = useState(String(budget?.monthlyLimit ?? 0));
  const [alertDraft, setAlertDraft] = useState(Math.round((budget?.alertAt ?? 0.8) * 100));
  const [adding, setAdding] = useState<Partial<BudgetRule> | null>(null);

  const ids = agents.map((a) => a.id);
  const spend = monthSpend(state.usage, ids);
  const limit = budget?.monthlyLimit ?? 0;
  const pct = limit ? spend / limit : 0;
  const days = state.usage.length;
  const burn = spend / Math.max(days, 1);
  const projected = burn * DAYS_IN_MONTH;
  const daysLeft = burn > 0 ? Math.max(0, (limit - spend) / burn) : Infinity;
  const totals = dailySeries(state.usage, ids);
  const today = totals[totals.length - 1] ?? 0;

  const perAgent = agents.map((a) => ({ a, total: monthSpend(state.usage, [a.id]) })).sort((x, y) => y.total - x.total);
  const targetName = (t: string) => (t === "namespace" ? `All of ${state.ns}` : state.agents.find((a) => a.id === t)?.name ?? t);

  const ruleUsage = (r: BudgetRule) => {
    const pick = r.target === "namespace" ? ids : [r.target];
    const daily = dailySeries(state.usage, pick);
    if (r.period === "monthly") return monthSpend(state.usage, pick);
    if (r.period === "daily") return daily[daily.length - 1] ?? 0;
    return (daily[daily.length - 1] ?? 0) / 6; // per-run: mock average run cost today
  };

  const nsDaily = budgetRules.find((r) => r.target === "namespace" && r.period === "daily");
  const max = Math.max(1, ...totals, nsDaily?.limit ?? 0);
  const CW = 900, CH = 220, pad = { l: 40, b: 22, t: 10 };
  const bw = (CW - pad.l) / state.usage.length;
  const y = (v: number) => CH - pad.b - (v / max) * (CH - pad.b - pad.t);

  const save = () => {
    dispatch({ type: "setBudget", ns: state.ns, monthlyLimit: Math.max(0, +limitDraft || 0), alertAt: alertDraft / 100 });
    toast("Budget updated");
  };

  return (
    <>
      <PageHead title="Budget" subtitle="Every model call goes through the KALYPSO gateway, so these limits are enforced, not just reported.">
        <PrimaryButton onClick={() => setAdding({})} icon={<Plus size={14} />}>Add budget</PrimaryButton>
      </PageHead>

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Spent this month</div>
          <div className="stat-value">{usd(spend)}</div>
          <div className="stat-sub">{Math.round(pct * 100)}% of {usd(limit)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Today</div>
          <div className="stat-value">{usd(today)}</div>
          <div className="stat-sub">{usd(burn)} daily average</div>
        </div>
        <div className="stat">
          <div className="stat-label">Projected month end</div>
          <div className="stat-value" style={{ color: projected > limit ? "var(--err)" : undefined }}>{usd(projected)}</div>
          <div className="stat-sub">{Number.isFinite(daysLeft) ? `Limit reached in ${daysLeft.toFixed(0)} days at this pace` : "No spend yet"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Monthly limit</div>
          <div className="row" style={{ marginTop: 6 }}>
            <input className="input mono" type="number" min={0} value={limitDraft} onChange={(e) => setLimitDraft(e.target.value)} style={{ width: 90 }} />
            <button className="btn" onClick={save}>Save</button>
          </div>
          <label className="row stat-sub" style={{ marginTop: 8 }}>
            Alert at
            <input type="range" min={30} max={100} step={5} value={alertDraft} onChange={(e) => setAlertDraft(+e.target.value)} style={{ accentColor: "var(--accent-hi)", flex: 1, minWidth: 0 }} />
            <span className="mono">{alertDraft}%</span>
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">Daily spend, October</div>
          <span className="spacer" />
          {nsDaily && <span className="faint small">Dashed line: daily cap {usd(nsDaily.limit)}</span>}
        </div>
        <svg className="chart" viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="gridline" x1={pad.l} x2={CW} y1={y(max * f)} y2={y(max * f)} />
              <text className="axis" x={0} y={y(max * f) + 3}>{`$${(max * f).toFixed(0)}`}</text>
            </g>
          ))}
          {state.usage.map((d, i) => {
            let top = CH - pad.b;
            return (
              <g key={d.date}>
                {perAgent.map(({ a }, si) => {
                  const v = d.byAgent[a.id] ?? 0;
                  const h = (v / max) * (CH - pad.b - pad.t);
                  top -= h;
                  return <rect key={a.id} x={pad.l + i * bw + 2} y={top} width={bw - 4} height={Math.max(h - 1, 0)} fill={SERIES[si % SERIES.length]} rx={1.5}><title>{`${d.date}, ${a.name}: ${usd(v)}`}</title></rect>;
                })}
                {(i % 7 === 0 || i === state.usage.length - 1) && <text className="axis" x={pad.l + i * bw + (i === state.usage.length - 1 ? bw - 2 : 2)} y={CH - 5} textAnchor={i === state.usage.length - 1 ? "end" : "start"}>{d.date.slice(5)}</text>}
              </g>
            );
          })}
          {nsDaily && <line x1={pad.l} x2={CW} y1={y(nsDaily.limit)} y2={y(nsDaily.limit)} stroke="var(--text-3)" strokeDasharray="4 4" strokeWidth={1} />}
        </svg>
        <div className="legend">
          {perAgent.map(({ a }, i) => <span key={a.id}><i style={{ background: SERIES[i % SERIES.length] }} />{a.name}</span>)}
        </div>
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card flush">
          <div className="card-head" style={{ padding: "16px 16px 0" }}><span className="card-title">Budget rules</span></div>
          <table className="table">
            <thead><tr><th>Applies to</th><th>Cap</th><th style={{ width: "30%" }}>Used</th><th>When hit</th><th /></tr></thead>
            <tbody>
              {budgetRules.map((r) => {
                const used = ruleUsage(r);
                const ratio = r.limit ? used / r.limit : 0;
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 500 }}>{targetName(r.target)}</td>
                    <td className="mono">{usd(r.limit)}<span className="faint"> / {r.period === "per-run" ? "run" : r.period === "daily" ? "day" : "month"}</span></td>
                    <td>
                      <div className={`bar ${ratio > 1 ? "over" : ""}`}><span style={{ width: `${Math.min(ratio, 1) * 100}%` }} /></div>
                      <div className="faint small mono" style={{ marginTop: 4 }}>{usd(used)}</div>
                    </td>
                    <td className="dim">{ACTION_LABEL[r.action]}</td>
                    <td><button className="btn ghost icon danger" onClick={() => dispatch({ type: "removeBudgetRule", id: r.id })}><Trash2 size={13} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {budgetRules.length === 0 && <div className="empty" style={{ margin: 18 }}>Only the monthly limit applies. Add a budget for finer control.</div>}
        </div>

        <div className="card flush">
          <div className="card-head" style={{ padding: "16px 16px 0" }}><span className="card-title">By agent</span></div>
          <table className="table">
            <thead><tr><th>Agent</th><th>Month to date</th><th style={{ width: "34%" }}>Share</th><th /></tr></thead>
            <tbody>
              {perAgent.map(({ a, total }) => (
                <tr key={a.id}>
                  <td><div style={{ fontWeight: 500 }}>{a.name}</div><div className="faint mono small">{a.model}</div></td>
                  <td className="mono">{usd(total)}</td>
                  <td><div className="bar"><span style={{ width: `${spend ? (total / spend) * 100 : 0}%` }} /></div></td>
                  <td><button className="btn sm" onClick={() => setAdding({ target: a.id, period: "monthly", limit: Math.ceil(total * 1.2) })}>Set cap</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {adding && <AddBudget seed={adding} onClose={() => setAdding(null)} />}
    </>
  );
}

function AddBudget({ seed, onClose }: { seed: Partial<BudgetRule>; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents } = useNamespaced();
  const [target, setTarget] = useState(seed.target ?? "namespace");
  const [period, setPeriod] = useState<BudgetPeriod>(seed.period ?? "daily");
  const [limit, setLimit] = useState(String(seed.limit ?? 10));
  const [action, setAction] = useState<BudgetAction>(seed.action ?? "pause");

  const add = () => {
    const l = +limit;
    if (!(l > 0)) return;
    dispatch({ type: "addBudgetRule", rule: { id: uid("br"), ns: state.ns, target, period, limit: l, action } });
    toast("Budget added");
    onClose();
  };

  return (
    <Modal title="Add budget" subtitle="Caps stack: the tightest one that applies wins." onClose={onClose}>
      <label className="field">Applies to
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="namespace">Whole namespace ({state.ns})</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <div className="field-row">
        <label className="field">Cap (USD)<input className="input mono" type="number" min={0} step={0.5} value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
        <label className="field">Per
          <select className="select" value={period} onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}>
            <option value="per-run">Run</option><option value="daily">Day</option><option value="monthly">Month</option>
          </select>
        </label>
      </div>
      <div className="field">When it's hit
        <div className="segmented" style={{ alignSelf: "flex-start" }}>
          {(Object.keys(ACTION_LABEL) as BudgetAction[]).map((a) => (
            <button key={a} className={action === a ? "active" : ""} onClick={() => setAction(a)}>{ACTION_LABEL[a]}</button>
          ))}
        </div>
      </div>
      <ModalActions onCancel={onClose} onConfirm={add} confirm="Add budget" />
    </Modal>
  );
}

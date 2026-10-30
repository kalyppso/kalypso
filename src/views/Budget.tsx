import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { dailySeries, monthSpend, uid, useNamespaced, useStore, useToast } from "../store";
import { api, errorMessage, isLive, onUsage, useBudgetOverview } from "../backend";
import type { BudgetOverview } from "../bindings/BudgetOverview";
import { Field, Modal, ModalActions, PageHead, PrimaryButton, usd, useErrors } from "../components/ui";
import "../styles/pages.css";
import type { BudgetAction, BudgetPeriod, BudgetRule, UsageDay } from "../types";

// One accent for the biggest spender, then stepped neutrals. No rainbow.
const SERIES = ["var(--accent-hi)", "var(--text-2)", "var(--text-3)", "var(--border-strong)", "var(--border)"];
const ACTION_LABEL: Record<BudgetAction, string> = { pause: "Pause", alert: "Alert me", downgrade: "Downgrade model" };
const DAYS_IN_MONTH = 31;
// Core periods and the prototype's names, both shown as "/ run", "/ day", "/ month".
const PER: Record<string, string> = { run: "run", day: "day", month: "month", "per-run": "run", daily: "day", monthly: "month" };
const dollars = (micros: number) => micros / 1e6;
const micros = (usdAmount: number) => Math.round(usdAmount * 1e6);

/** Requests that budgets are refusing right now, and why. */
export function BudgetBlocks({ overview }: { overview: BudgetOverview | null }) {
  if (!overview?.blocks.length) return null;
  return (
    <div className="card" style={{ marginBottom: 16, boxShadow: "inset 0 0 0 1px var(--err)" }} role="status">
      <div className="card-title" style={{ marginBottom: 8 }}>Paused by budget</div>
      {overview.blocks.map((b) => (
        <div key={b.target} className="row small" style={{ gap: 8, padding: "4px 0" }}>
          <span className="dot" style={{ background: "var(--err)" }} />
          <span style={{ fontWeight: 500 }}>{b.label}</span>
          <span className="dim">{b.message}</span>
        </div>
      ))}
    </div>
  );
}

interface Spender { id: string; name: string; model: string }

/** Month-to-date spend from the gateway, by day and by source (sandbox or key). Null outside the desktop app. */
function useLiveSpend(ns: string) {
  const toast = useToast();
  const [live, setLive] = useState<{ usage: UsageDay[]; spenders: Spender[]; unpriced: string[] } | null>(null);
  useEffect(() => {
    if (!isLive()) return;
    let gone = false;
    const load = () => {
      const now = new Date();
      const days = now.getUTCDate();
      api.usageSummary(ns, days).then((s) => {
        if (gone) return;
        const dates = Array.from({ length: days }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), i + 1)).toISOString().slice(0, 10));
        const usage = dates.map((date) => ({ date, byAgent: {} as Record<string, number> }));
        for (const c of s.by_day_source) {
          const d = usage.find((u) => u.date === c.day);
          if (d) d.byAgent[c.source] = (d.byAgent[c.source] ?? 0) + c.cost_micros / 1e6;
        }
        const spenders = s.by_source.map((g) => ({ id: g.name, name: g.name, model: `${g.totals.requests} requests` }));
        setLive({ usage, spenders, unpriced: s.unpriced });
      }).catch((e) => toast(errorMessage(e), "err"));
    };
    load();
    const off = onUsage((e) => { if (e.ns === ns) load(); });
    return () => { gone = true; off.then((f) => f()); };
  }, [ns]);
  return live;
}

export function Budget() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, budget, budgetRules } = useNamespaced();
  const [limitDraft, setLimitDraft] = useState(String(budget?.monthlyLimit ?? 0));
  const [alertDraft, setAlertDraft] = useState(Math.round((budget?.alertAt ?? 0.8) * 100));
  const [adding, setAdding] = useState<Partial<BudgetRule> | null>(null);
  // In the desktop app the limit and rules live in the core and the gateway enforces them.
  const { overview, reload } = useBudgetOverview(state.ns);
  useEffect(() => {
    if (!overview) return;
    setLimitDraft(String(dollars(overview.budget.monthly_limit)));
    setAlertDraft(Math.round(overview.budget.alert_at * 100));
  }, [overview?.budget.monthly_limit, overview?.budget.alert_at]);

  // In the desktop app spend comes from the gateway, by sandbox or key; agents arrive with the supervisor.
  const live = useLiveSpend(state.ns);
  const usage = live?.usage ?? state.usage;
  const spenders: Spender[] = live?.spenders ?? agents;
  const ids = spenders.map((a) => a.id);
  const spend = monthSpend(usage, ids);
  const limit = overview ? dollars(overview.budget.monthly_limit) : budget?.monthlyLimit ?? 0;
  const pct = limit ? spend / limit : 0;
  const days = usage.length;
  const burn = spend / Math.max(days, 1);
  const projected = burn * DAYS_IN_MONTH;
  const daysLeft = burn > 0 ? Math.max(0, (limit - spend) / burn) : Infinity;
  const totals = dailySeries(usage, ids);
  const today = totals[totals.length - 1] ?? 0;

  const perAgent = spenders.map((a) => ({ a, total: monthSpend(usage, [a.id]) })).sort((x, y) => y.total - x.total);
  const month = new Date().toLocaleString("en", { month: "long" });
  const targetName = (t: string) => (t === "namespace" ? `All of ${state.ns}` : state.agents.find((a) => a.id === t)?.name ?? t);

  const ruleUsage = (r: BudgetRule) => {
    const pick = r.target === "namespace" ? ids : [r.target];
    const daily = dailySeries(usage, pick);
    if (r.period === "monthly") return monthSpend(usage, pick);
    if (r.period === "daily") return daily[daily.length - 1] ?? 0;
    return (daily[daily.length - 1] ?? 0) / 6; // per-run: mock average run cost today
  };

  const rows = overview
    ? overview.rules.map((s) => ({
        id: s.rule.id, label: s.label, cap: dollars(s.rule.cap), per: PER[s.rule.period], used: dollars(s.spent),
        action: s.rule.action === "downgrade" ? `Switch to ${s.rule.downgrade_to}` : ACTION_LABEL[s.rule.action as BudgetAction],
      }))
    : budgetRules.map((r) => ({ id: r.id, label: targetName(r.target), cap: r.limit, per: PER[r.period], used: ruleUsage(r), action: ACTION_LABEL[r.action] }));
  const nsDailyRule = overview
    ? overview.rules.find((s) => s.rule.target === "namespace" && s.rule.period === "day")
    : budgetRules.find((r) => r.target === "namespace" && r.period === "daily");
  const nsDaily = nsDailyRule && { limit: "rule" in nsDailyRule ? dollars(nsDailyRule.rule.cap) : nsDailyRule.limit };
  const removeRule = (id: string) => {
    if (!overview) return dispatch({ type: "removeBudgetRule", id });
    api.budgetRuleDelete(state.ns, id).then(reload).then(() => toast("Budget removed", "warn")).catch((e) => toast(errorMessage(e), "err"));
  };
  const max = Math.max(1, ...totals, nsDaily?.limit ?? 0);
  const CW = 900, CH = 220, pad = { l: 40, b: 22, t: 10 };
  const bw = (CW - pad.l) / Math.max(usage.length, 1);
  const y = (v: number) => CH - pad.b - (v / max) * (CH - pad.b - pad.t);

  const save = () => {
    const amount = Math.max(0, +limitDraft || 0);
    if (overview) {
      api.budgetSet(state.ns, micros(amount), alertDraft / 100).then(reload).then(() => toast("Budget updated")).catch((e) => toast(errorMessage(e), "err"));
      return;
    }
    dispatch({ type: "setBudget", ns: state.ns, monthlyLimit: amount, alertAt: alertDraft / 100 });
    toast("Budget updated");
  };

  return (
    <>
      <PageHead title="Budget" subtitle="Every model call goes through the KALYPSO gateway, so these limits are enforced, not just reported.">
        <PrimaryButton onClick={() => setAdding({})} icon={<Plus size={14} />}>Add budget</PrimaryButton>
      </PageHead>

      <BudgetBlocks overview={overview} />

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Spent this month</div>
          <div className="stat-value">{usd(spend)}</div>
          <div className="stat-sub">{limit ? `${Math.round(pct * 100)}% of ${usd(limit)}` : "No monthly limit"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Today</div>
          <div className="stat-value">{usd(today)}</div>
          <div className="stat-sub">{usd(burn)} daily average</div>
        </div>
        <div className="stat">
          <div className="stat-label">Projected month end</div>
          <div className="stat-value" style={{ color: limit && projected > limit ? "var(--err)" : undefined }}>{usd(projected)}</div>
          <div className="stat-sub">
            {!Number.isFinite(daysLeft) ? "No spend yet"
              : !limit ? "At this pace"
              : projected <= limit ? "Within the limit at this pace"
              : daysLeft < 1 ? "Over the limit"
              : `Limit reached in ${daysLeft.toFixed(0)} days at this pace`}
          </div>
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

      {live && live.unpriced.length > 0 && (
        <div className="empty" style={{ marginBottom: 16, textAlign: "left" }}>
          No price for {live.unpriced.join(", ")}, so those requests count as $0. Add them to pricing.toml.
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div className="card-title">Daily spend, {month}</div>
          <span className="spacer" />
          {nsDaily && <span className="faint small">Dashed line: daily cap {usd(nsDaily.limit)}</span>}
        </div>
        <svg className="chart" viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="gridline" x1={pad.l} x2={CW} y1={y(max * f)} y2={y(max * f)} />
              <text className="axis" x={0} y={y(max * f) + 3}>{`$${(max * f).toFixed(max < 10 ? 2 : 0)}`}</text>
            </g>
          ))}
          {usage.map((d, i) => {
            let top = CH - pad.b;
            return (
              <g key={d.date}>
                {perAgent.map(({ a }, si) => {
                  const v = d.byAgent[a.id] ?? 0;
                  const h = (v / max) * (CH - pad.b - pad.t);
                  top -= h;
                  return <rect key={a.id} x={pad.l + i * bw + 2} y={top} width={bw - 4} height={Math.max(h - 1, 0)} fill={SERIES[si % SERIES.length]} rx={1.5}><title>{`${d.date}, ${a.name}: ${usd(v)}`}</title></rect>;
                })}
                {((i % 7 === 0 && usage.length - 1 - i >= 4) || i === usage.length - 1) && <text className="axis" x={pad.l + i * bw + (i === usage.length - 1 ? bw - 2 : 2)} y={CH - 5} textAnchor={i === usage.length - 1 ? "end" : "start"}>{d.date.slice(5)}</text>}
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
              {rows.map((r) => {
                const ratio = r.cap ? r.used / r.cap : 0;
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 500 }}>{r.label}</td>
                    <td className="mono">{usd(r.cap)}<span className="faint"> / {r.per}</span></td>
                    <td>
                      <div className={`bar ${ratio >= 1 ? "over" : ""}`}><span style={{ width: `${Math.min(ratio, 1) * 100}%` }} /></div>
                      <div className="faint small mono" style={{ marginTop: 4 }}>{usd(r.used)}</div>
                    </td>
                    <td className="dim">{r.action}</td>
                    <td><button className="btn ghost icon danger" title="Remove" onClick={() => removeRule(r.id)}><Trash2 size={13} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty" style={{ margin: 18 }}>Only the monthly limit applies. Add a budget for finer control.</div>}
        </div>

        <div className="card flush">
          <div className="card-head" style={{ padding: "16px 16px 0" }}><span className="card-title">{live ? "By source" : "By agent"}</span></div>
          <table className="table">
            <thead><tr><th>{live ? "Sandbox or key" : "Agent"}</th><th>Month to date</th><th style={{ width: "34%" }}>Share</th><th /></tr></thead>
            <tbody>
              {perAgent.map(({ a, total }) => (
                <tr key={a.id}>
                  <td><div style={{ fontWeight: 500 }}>{a.name}</div><div className="faint mono small">{a.model}</div></td>
                  <td className="mono">{usd(total)}</td>
                  <td><div className="bar"><span style={{ width: `${spend ? (total / spend) * 100 : 0}%` }} /></div></td>
                  <td>{!live && <button className="btn sm" onClick={() => setAdding({ target: a.id, period: "monthly", limit: Math.ceil(total * 1.2) })}>Set cap</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {perAgent.length === 0 && <div className="empty" style={{ margin: 18 }}>No model requests this month. Sandboxes and gateway keys show up here once they call a model.</div>}
        </div>
      </div>

      {adding && (overview
        ? <AddLiveBudget overview={overview} onAdded={reload} onClose={() => setAdding(null)} />
        : <AddBudget seed={adding} onClose={() => setAdding(null)} />)}
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
  const { errors, check, clear } = useErrors();

  const add = () => {
    const l = +limit;
    const ok = check({
      limit: !limit.trim() ? "Enter a cap." : !(l > 0) ? "The cap has to be more than $0." : l > 100000 ? "That cap is higher than $100,000. Check for a typo." : undefined,
      target: state.budgetRules.some((r) => r.ns === state.ns && r.target === target && r.period === period) ? "There is already a cap for this with the same period. Edit or delete that one." : undefined,
    });
    if (!ok) return;
    dispatch({ type: "addBudgetRule", rule: { id: uid("br"), ns: state.ns, target, period, limit: l, action } });
    toast("Budget added");
    onClose();
  };

  return (
    <Modal title="Add budget" subtitle="Caps stack: the tightest one that applies wins." onClose={onClose}>
      <Field label="Applies to" error={errors.target}>
        <select className="select" value={target} onChange={(e) => { setTarget(e.target.value); clear("target"); }}>
          <option value="namespace">Whole namespace ({state.ns})</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      <div className="field-row">
        <Field label="Cap (USD)" error={errors.limit}>
          <input className="input mono" type="number" min={0} step={0.5} value={limit} onChange={(e) => { setLimit(e.target.value); clear("limit"); }} />
        </Field>
        <label className="field">Per
          <select className="select" value={period} onChange={(e) => { setPeriod(e.target.value as BudgetPeriod); clear("target"); }}>
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

/** The same form against the core: caps on the namespace, a sandbox or a gateway key. */
function AddLiveBudget({ overview, onAdded, onClose }: { overview: BudgetOverview; onAdded: () => void; onClose: () => void }) {
  const { state } = useStore();
  const toast = useToast();
  const [target, setTarget] = useState("namespace");
  const [period, setPeriod] = useState("day");
  const [limit, setLimit] = useState("10");
  const [action, setAction] = useState<BudgetAction>("pause");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const { errors, check, clear } = useErrors();
  useEffect(() => { api.pricingModels().then((m) => { setModels(m.filter((x) => !x.endsWith("*"))); }).catch(() => {}); }, []);
  const runOk = target !== "namespace";

  const add = () => {
    const l = +limit;
    const ok = check({
      limit: !limit.trim() ? "Enter a cap." : !(l > 0) ? "The cap has to be more than $0." : l > 100000 ? "That cap is higher than $100,000. Check for a typo." : undefined,
      period: period === "run" && !runOk ? "A whole namespace has no runs. Pick a day or a month." : undefined,
      model: action === "downgrade" && !model ? "Pick the model to switch to." : undefined,
      target: overview.rules.some((r) => r.rule.target === target && r.rule.period === period && r.rule.action === action)
        ? "There is already the same cap for this. Remove that one first." : undefined,
    });
    if (!ok) return;
    api.budgetRuleCreate(state.ns, { target, period, cap: micros(l), action, downgrade_to: action === "downgrade" ? model : undefined })
      .then(() => { onAdded(); toast("Budget added"); onClose(); })
      .catch((e) => toast(errorMessage(e), "err"));
  };

  return (
    <Modal title="Add budget" subtitle="The gateway checks every cap before a request goes out. The tightest one wins." onClose={onClose}>
      <Field label="Applies to" error={errors.target}>
        <select className="select" value={target} onChange={(e) => { setTarget(e.target.value); clear("target"); clear("period"); }}>
          {overview.targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </Field>
      <div className="field-row">
        <Field label="Cap (USD)" error={errors.limit}>
          <input className="input mono" type="number" min={0} step={0.5} value={limit} onChange={(e) => { setLimit(e.target.value); clear("limit"); }} />
        </Field>
        <Field label="Per" error={errors.period}>
          <select className="select" value={period} onChange={(e) => { setPeriod(e.target.value); clear("period"); clear("target"); }}>
            {runOk && <option value="run">Run (since the sandbox last started)</option>}
            <option value="day">Day</option><option value="month">Month</option>
          </select>
        </Field>
      </div>
      <div className="field">When it's hit
        <div className="segmented" style={{ alignSelf: "flex-start" }}>
          {(Object.keys(ACTION_LABEL) as BudgetAction[]).map((a) => (
            <button key={a} className={action === a ? "active" : ""} onClick={() => { setAction(a); clear("model"); }}>{ACTION_LABEL[a]}</button>
          ))}
        </div>
      </div>
      {action === "downgrade" && (
        <Field label="Switch to" error={errors.model} hint="Requests keep going, with this model, until the period resets.">
          <select className="select" value={model} onChange={(e) => { setModel(e.target.value); clear("model"); }}>
            <option value="">Pick a model</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      )}
      <ModalActions onCancel={onClose} onConfirm={add} confirm="Add budget" />
    </Modal>
  );
}

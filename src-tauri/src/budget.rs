//! Budgets: the namespace's monthly limit plus extra caps, enforced by the model
//! gateway before each request is forwarded.
//!
//! A cap applies to the whole namespace, one sandbox or one gateway key, over a
//! day, a month or a run. A sandbox's run is the time since it last started (each
//! start gets a fresh gateway key); a key's run is its whole life. When a cap is
//! reached the request is refused (pause), sent with a cheaper model (downgrade)
//! or let through with a notification (alert). Every hit notifies once per period.
//!
//! Checks happen before forwarding, so one request can take spend past a cap; the
//! next one is stopped.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{KalypsoError, Result};
use crate::store::Db;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Budget {
    pub ns: String,
    /// Millionths of a dollar; 0 means no monthly limit.
    #[ts(type = "number")]
    pub monthly_limit: i64,
    /// Fraction of the monthly limit that triggers a heads-up, 0..1.
    pub alert_at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct BudgetRule {
    pub id: String,
    pub ns: String,
    /// "namespace", "sandbox:<id>" or "key:<id>".
    pub target: String,
    /// "run", "day" or "month".
    pub period: String,
    #[ts(type = "number")]
    pub cap: i64,
    /// "pause", "alert" or "downgrade".
    pub action: String,
    pub downgrade_to: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct NewBudgetRule {
    pub target: String,
    pub period: String,
    #[ts(type = "number")]
    pub cap: i64,
    pub action: String,
    #[serde(default)]
    #[ts(optional)]
    pub downgrade_to: Option<String>,
}

/// Something a cap can apply to, for the rule form.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct BudgetTarget {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RuleState {
    pub rule: BudgetRule,
    pub label: String,
    #[ts(type = "number")]
    pub spent: i64,
    pub hit: bool,
}

/// A target whose requests are currently refused, and why.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct BudgetBlock {
    pub target: String,
    pub label: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct BudgetOverview {
    pub budget: Budget,
    #[ts(type = "number")]
    pub month_spent: i64,
    pub rules: Vec<RuleState>,
    pub blocks: Vec<BudgetBlock>,
    pub targets: Vec<BudgetTarget>,
}

/// What the gateway should do with one request.
#[derive(Debug, Default, PartialEq)]
pub struct Decision {
    /// Refuse with this message.
    pub block: Option<String>,
    /// Send the request with this model instead.
    pub downgrade: Option<String>,
    /// Notifications to show, each once per period.
    pub alerts: Vec<String>,
}

const NS_LIMIT: &str = "monthly-limit";

pub fn usd(micros: i64) -> String {
    format!("${:.2}", micros as f64 / 1e6)
}

fn period_name(period: &str) -> &'static str {
    match period {
        "day" => "daily",
        "month" => "monthly",
        _ => "per-run",
    }
}

fn resumes(period: &str) -> &'static str {
    match period {
        "day" => "Requests resume tomorrow (00:00 UTC)",
        "month" => "Requests resume on the 1st",
        _ => "Requests resume when the sandbox starts again",
    }
}

fn period_key(c: &Connection, period: &str, run: &str) -> rusqlite::Result<String> {
    match period {
        "day" => c.query_row("SELECT date('now')", [], |r| r.get(0)),
        "month" => c.query_row("SELECT strftime('%Y-%m', 'now')", [], |r| r.get(0)),
        _ => Ok(run.to_string()),
    }
}

/// Spend for `target` in the current `period`, in millionths of a dollar.
fn spent(c: &Connection, ns: &str, target: &str, period: &str) -> rusqlite::Result<i64> {
    let window = match period {
        "day" => "ts >= date('now')",
        "month" => "ts >= strftime('%Y-%m-01', 'now')",
        _ => "1",
    };
    // Every branch binds ?2 so one statement shape serves them all.
    let (who, id) = if target == "namespace" {
        ("?2 = ''", "")
    } else if let Some(sb) = target.strip_prefix("sandbox:") {
        if period == "run" {
            // The run in progress: spend under the sandbox's current key.
            (
                "key_id = (SELECT id FROM gateway_keys WHERE sandbox_id = ?2 AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1)",
                sb,
            )
        } else {
            ("key_id IN (SELECT id FROM gateway_keys WHERE sandbox_id = ?2)", sb)
        }
    } else if let Some(key) = target.strip_prefix("key:") {
        ("key_id = ?2", key)
    } else {
        return Ok(0);
    };
    c.query_row(&format!("SELECT coalesce(sum(cost_micros), 0) FROM usage_events WHERE ns = ?1 AND {window} AND {who}"), (ns, id), |r| {
        r.get(0)
    })
}

fn label(c: &Connection, ns: &str, target: &str) -> rusqlite::Result<String> {
    if let Some(sb) = target.strip_prefix("sandbox:") {
        let name: Option<String> = c.query_row("SELECT name FROM sandboxes WHERE id = ?1", [sb], |r| r.get(0)).optional()?;
        Ok(name.unwrap_or_else(|| sb.to_string()))
    } else if let Some(key) = target.strip_prefix("key:") {
        let name: Option<String> = c.query_row("SELECT label FROM gateway_keys WHERE id = ?1", [key], |r| r.get(0)).optional()?;
        Ok(format!("key {}", name.unwrap_or_else(|| key.to_string())))
    } else {
        Ok(format!("namespace {ns}"))
    }
}

pub fn get(db: &Db, ns: &str) -> Result<Budget> {
    db.with(|c| {
        let row =
            c.query_row("SELECT monthly_limit, alert_at FROM budgets WHERE ns = ?1", [ns], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let (monthly_limit, alert_at) = row.unwrap_or((0, 0.8));
        Ok(Budget { ns: ns.to_string(), monthly_limit, alert_at })
    })
}

pub fn set(db: &Db, ns: &str, monthly_limit: i64, alert_at: f64) -> Result<Budget> {
    if monthly_limit < 0 {
        return Err(KalypsoError::Invalid("the monthly limit can't be negative".into()));
    }
    if !(alert_at > 0.0 && alert_at <= 1.0) {
        return Err(KalypsoError::Invalid("alert threshold must be between 1% and 100%".into()));
    }
    db.with(|c| {
        c.execute(
            "INSERT INTO budgets (ns, monthly_limit, alert_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (ns) DO UPDATE SET monthly_limit = excluded.monthly_limit, alert_at = excluded.alert_at",
            (ns, monthly_limit, alert_at),
        )?;
        Ok(())
    })?;
    db.audit(Some(ns), "user", "budget.set", &usd(monthly_limit))?;
    get(db, ns)
}

pub fn list_rules(db: &Db, ns: &str) -> Result<Vec<BudgetRule>> {
    db.with(|c| {
        let mut st =
            c.prepare("SELECT id, ns, target, period, cap, action, downgrade_to FROM budget_rules WHERE ns = ?1 ORDER BY created_at, id")?;
        let rows = st.query_map([ns], |r| {
            Ok(BudgetRule {
                id: r.get(0)?,
                ns: r.get(1)?,
                target: r.get(2)?,
                period: r.get(3)?,
                cap: r.get(4)?,
                action: r.get(5)?,
                downgrade_to: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

pub fn create_rule(db: &Db, ns: &str, new: NewBudgetRule) -> Result<BudgetRule> {
    if !["run", "day", "month"].contains(&new.period.as_str()) {
        return Err(KalypsoError::Invalid(format!("unknown period {}", new.period)));
    }
    if !["pause", "alert", "downgrade"].contains(&new.action.as_str()) {
        return Err(KalypsoError::Invalid(format!("unknown action {}", new.action)));
    }
    if new.cap <= 0 {
        return Err(KalypsoError::Invalid("a cap must be more than $0".into()));
    }
    let downgrade_to = new.downgrade_to.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    if new.action == "downgrade" && downgrade_to.as_deref().is_none_or(|m| m.len() > 100) {
        return Err(KalypsoError::Invalid("pick the model to switch to".into()));
    }
    // The target must exist in this namespace.
    let target_ok = db.with(|c| {
        Ok(if new.target == "namespace" {
            new.period != "run"
        } else if let Some(sb) = new.target.strip_prefix("sandbox:") {
            c.query_row("SELECT 1 FROM sandboxes WHERE id = ?1 AND ns = ?2", (sb, ns), |_| Ok(())).optional()?.is_some()
        } else if let Some(key) = new.target.strip_prefix("key:") {
            c.query_row("SELECT 1 FROM gateway_keys WHERE id = ?1 AND ns = ?2", (key, ns), |_| Ok(())).optional()?.is_some()
        } else {
            false
        })
    })?;
    if !target_ok {
        let why = if new.target == "namespace" {
            "a whole namespace has no runs; use a day or a month"
        } else {
            "that sandbox or key isn't in this namespace"
        };
        return Err(KalypsoError::Invalid(why.into()));
    }
    let id = crate::vault::new_id("br");
    let downgrade_to = if new.action == "downgrade" { downgrade_to } else { None };
    db.with(|c| {
        c.execute(
            "INSERT INTO budget_rules (id, ns, target, period, cap, action, downgrade_to) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (&id, ns, &new.target, &new.period, new.cap, &new.action, &downgrade_to),
        )?;
        Ok(())
    })?;
    db.audit(
        Some(ns),
        "user",
        "budget.rule.create",
        &format!("{} {} {} {}", new.target, period_name(&new.period), usd(new.cap), new.action),
    )?;
    list_rules(db, ns)?.into_iter().find(|r| r.id == id).ok_or_else(|| KalypsoError::NotFound(id))
}

pub fn delete_rule(db: &Db, ns: &str, id: &str) -> Result<()> {
    let n = db.with(|c| Ok(c.execute("DELETE FROM budget_rules WHERE id = ?1 AND ns = ?2", (id, ns))?))?;
    if n == 0 {
        return Err(KalypsoError::NotFound(format!("budget rule {id} in {ns}")));
    }
    db.audit(Some(ns), "user", "budget.rule.delete", id)
}

/// Record that an alert fired; true the first time in this period.
fn first_alert(c: &Connection, rule_id: &str, key: &str) -> rusqlite::Result<bool> {
    Ok(c.execute("INSERT OR IGNORE INTO budget_alerts (rule_id, period_key) VALUES (?1, ?2)", (rule_id, key))? > 0)
}

/// Decide what to do with a request made with gateway key `key_id` in `ns`.
pub fn check(db: &Db, ns: &str, key_id: &str) -> Result<Decision> {
    let budget = get(db, ns)?;
    let rules = list_rules(db, ns)?;
    db.with(|c| {
        let sandbox: Option<String> =
            c.query_row("SELECT sandbox_id FROM gateway_keys WHERE id = ?1", [key_id], |r| r.get(0)).optional()?.flatten();
        let applies = |t: &str| {
            t == "namespace"
                || t.strip_prefix("key:") == Some(key_id)
                || (sandbox.is_some() && t.strip_prefix("sandbox:") == sandbox.as_deref())
        };
        let mut d = Decision::default();

        if budget.monthly_limit > 0 {
            let month = spent(c, ns, "namespace", "month")?;
            let key = period_key(c, "month", key_id)?;
            if month >= budget.monthly_limit {
                d.block = Some(format!(
                    "Budget reached: namespace {ns} spent {} of its {} monthly limit. Requests resume on the 1st, or raise the limit.",
                    usd(month),
                    usd(budget.monthly_limit)
                ));
                if first_alert(c, &format!("{NS_LIMIT}:{ns}:hit"), &key)? {
                    d.alerts.push(format!("{ns} reached its {} monthly limit. Model requests are paused.", usd(budget.monthly_limit)));
                }
            } else if month as f64 >= budget.alert_at * budget.monthly_limit as f64 && first_alert(c, &format!("{NS_LIMIT}:{ns}"), &key)? {
                d.alerts.push(format!(
                    "{ns} has used {}% of its {} monthly limit ({}).",
                    (month as f64 * 100.0 / budget.monthly_limit as f64).round(),
                    usd(budget.monthly_limit),
                    usd(month)
                ));
            }
        }

        // Tightest caps first, so the message names the one that matters.
        let mut hits = Vec::new();
        for r in rules.iter().filter(|r| applies(&r.target)) {
            let s = spent(c, ns, &r.target, &r.period)?;
            if s >= r.cap {
                hits.push((r, s));
            }
        }
        hits.sort_by_key(|(r, _)| r.cap);
        for (r, s) in hits {
            let who = label(c, ns, &r.target)?;
            let cap = format!("{} {} cap", usd(r.cap), period_name(&r.period));
            let first = first_alert(c, &r.id, &period_key(c, &r.period, key_id)?)?;
            match r.action.as_str() {
                "pause" => {
                    if d.block.is_none() {
                        d.block =
                            Some(format!("Budget reached: {who} spent {} of its {cap}. {}, or raise the cap.", usd(s), resumes(&r.period)));
                    }
                    if first {
                        d.alerts.push(format!("{who} reached its {cap}. Model requests are paused."));
                    }
                }
                "downgrade" => {
                    if d.downgrade.is_none() {
                        d.downgrade = r.downgrade_to.clone();
                    }
                    if first {
                        d.alerts.push(format!(
                            "{who} reached its {cap}. Switched to {}.",
                            r.downgrade_to.as_deref().unwrap_or("a cheaper model")
                        ));
                    }
                }
                _ => {
                    if first {
                        d.alerts.push(format!("{who} reached its {cap} ({} spent).", usd(s)));
                    }
                }
            }
        }
        Ok(d)
    })
}

/// Everything the Budget page and the Overview need.
pub fn overview(db: &Db, ns: &str) -> Result<BudgetOverview> {
    let budget = get(db, ns)?;
    let rules = list_rules(db, ns)?;
    db.with(|c| {
        let month_spent = spent(c, ns, "namespace", "month")?;
        let mut blocks = Vec::new();
        if budget.monthly_limit > 0 && month_spent >= budget.monthly_limit {
            blocks.push(BudgetBlock {
                target: "namespace".into(),
                label: format!("namespace {ns}"),
                message: format!(
                    "Spent {} of its {} monthly limit. Requests resume on the 1st.",
                    usd(month_spent),
                    usd(budget.monthly_limit)
                ),
            });
        }
        let mut states = Vec::new();
        for r in rules {
            let s = spent(c, ns, &r.target, &r.period)?;
            let hit = s >= r.cap;
            let lbl = label(c, ns, &r.target)?;
            if hit && r.action == "pause" && !blocks.iter().any(|b| b.target == r.target) {
                blocks.push(BudgetBlock {
                    target: r.target.clone(),
                    label: lbl.clone(),
                    message: format!("Spent {} of its {} {} cap. {}.", usd(s), usd(r.cap), period_name(&r.period), resumes(&r.period)),
                });
            }
            states.push(RuleState { rule: r, label: lbl, spent: s, hit });
        }
        let mut targets = vec![BudgetTarget { id: "namespace".into(), label: format!("Whole namespace ({ns})") }];
        let mut st = c.prepare("SELECT id, name FROM sandboxes WHERE ns = ?1 ORDER BY name")?;
        for row in st.query_map([ns], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, name) = row?;
            targets.push(BudgetTarget { id: format!("sandbox:{id}"), label: format!("Sandbox {name}") });
        }
        let mut st =
            c.prepare("SELECT id, label FROM gateway_keys WHERE ns = ?1 AND sandbox_id IS NULL AND revoked_at IS NULL ORDER BY label")?;
        for row in st.query_map([ns], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, name) = row?;
            targets.push(BudgetTarget { id: format!("key:{id}"), label: format!("Key {name}") });
        }
        Ok(BudgetOverview { budget, month_spent, rules: states, blocks, targets })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            Ok(c.execute_batch(
                "INSERT INTO namespaces (id, name) VALUES ('work','work'), ('lab','lab');
                 INSERT INTO sandboxes (id, ns, name, runtime, image, cpu, mem_mb, network) VALUES ('sb-1','work','box','docker','alpine',1,512,'isolated');
                 INSERT INTO gateway_keys (id, ns, sandbox_id, label, hash, created_at) VALUES ('k-old','work','sb-1','box',x'01','2026-01-01 00:00:00');
                 INSERT INTO gateway_keys (id, ns, sandbox_id, label, hash) VALUES ('k-run','work','sb-1','box',x'02');
                 INSERT INTO gateway_keys (id, ns, label, hash) VALUES ('k-cli','work','laptop',x'03');
                 UPDATE gateway_keys SET revoked_at = '2026-01-02 00:00:00' WHERE id = 'k-old';",
            )?)
        })
        .unwrap();
        db
    }

    /// Spend `micros` with `key`, `days_ago` days back.
    fn spend(db: &Db, key: &str, micros: i64, days_ago: i64) {
        db.with(|c| {
            c.execute(
                "INSERT INTO usage_events (ts, ns, key_id, source, provider, model, status, stream, input_tokens, output_tokens,
                   cache_write, cache_read, cost_micros, priced, latency_ms)
                 VALUES (datetime('now', ?1), 'work', ?2, 's', 'anthropic', 'm', 200, 0, 0, 0, 0, 0, ?3, 1, 1)",
                (format!("-{days_ago} days"), key, micros),
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn rule(target: &str, period: &str, cap: i64, action: &str) -> NewBudgetRule {
        NewBudgetRule { target: target.into(), period: period.into(), cap, action: action.into(), downgrade_to: None }
    }

    #[test]
    fn nothing_set_means_nothing_happens() {
        let db = db();
        spend(&db, "k-run", 50_000_000, 0);
        assert_eq!(check(&db, "work", "k-run").unwrap(), Decision::default());
    }

    #[test]
    fn monthly_limit_alerts_once_then_pauses() {
        let db = db();
        set(&db, "work", 10_000_000, 0.8).unwrap();
        spend(&db, "k-cli", 8_500_000, 0);
        let d = check(&db, "work", "k-cli").unwrap();
        assert!(d.block.is_none());
        assert_eq!(d.alerts.len(), 1, "{:?}", d.alerts);
        assert!(d.alerts[0].contains("85%"));
        assert!(check(&db, "work", "k-cli").unwrap().alerts.is_empty(), "alert fires once per month");

        spend(&db, "k-run", 2_000_000, 0);
        let d = check(&db, "work", "k-run").unwrap();
        assert!(d.block.as_deref().unwrap().contains("$10.50 of its $10.00 monthly limit"), "{:?}", d.block);
        assert_eq!(overview(&db, "work").unwrap().blocks.len(), 1);
    }

    #[test]
    fn sandbox_daily_cap_pauses_only_that_sandbox() {
        let db = db();
        create_rule(&db, "work", rule("sandbox:sb-1", "day", 5_000_000, "pause")).unwrap();
        spend(&db, "k-old", 4_000_000, 0);
        spend(&db, "k-run", 1_500_000, 0);
        spend(&db, "k-run", 9_000_000, 2); // yesterday's spend doesn't count
        let d = check(&db, "work", "k-run").unwrap();
        let msg = d.block.unwrap();
        assert!(msg.contains("box spent $5.50 of its $5.00 daily cap") && msg.contains("tomorrow"), "{msg}");
        assert_eq!(d.alerts.len(), 1);
        assert!(check(&db, "work", "k-cli").unwrap().block.is_none(), "other keys keep working");

        let o = overview(&db, "work").unwrap();
        assert_eq!((o.rules[0].spent, o.rules[0].hit), (5_500_000, true));
        assert_eq!(o.blocks[0].label, "box");
    }

    #[test]
    fn per_run_counts_only_the_current_key() {
        let db = db();
        create_rule(&db, "work", rule("sandbox:sb-1", "run", 1_000_000, "pause")).unwrap();
        spend(&db, "k-old", 5_000_000, 0);
        assert!(check(&db, "work", "k-run").unwrap().block.is_none(), "an earlier run doesn't count");
        spend(&db, "k-run", 1_000_000, 0);
        assert!(check(&db, "work", "k-run").unwrap().block.unwrap().contains("starts again"));
    }

    #[test]
    fn downgrade_and_alert_actions() {
        let db = db();
        let mut r = rule("key:k-cli", "month", 1_000_000, "downgrade");
        r.downgrade_to = Some("claude-haiku-5-5".into());
        create_rule(&db, "work", r).unwrap();
        create_rule(&db, "work", rule("namespace", "day", 500_000, "alert")).unwrap();
        spend(&db, "k-cli", 2_000_000, 0);
        let d = check(&db, "work", "k-cli").unwrap();
        assert_eq!(d.block, None);
        assert_eq!(d.downgrade.as_deref(), Some("claude-haiku-5-5"));
        assert_eq!(d.alerts.len(), 2, "{:?}", d.alerts);
        assert_eq!(check(&db, "work", "k-cli").unwrap().alerts.len(), 0);
        assert_eq!(check(&db, "work", "k-run").unwrap().downgrade, None, "the key's cap doesn't touch the sandbox");
    }

    #[test]
    fn rules_are_validated() {
        let db = db();
        let bad = |r: NewBudgetRule| create_rule(&db, "work", r).unwrap_err().code();
        assert_eq!(bad(rule("namespace", "run", 1, "pause")), "invalid");
        assert_eq!(bad(rule("namespace", "week", 1, "pause")), "invalid");
        assert_eq!(bad(rule("namespace", "day", 0, "pause")), "invalid");
        assert_eq!(bad(rule("namespace", "day", 1, "downgrade")), "invalid");
        assert_eq!(bad(rule("sandbox:sb-1", "day", 1, "explode")), "invalid");
        // Another namespace's sandbox.
        assert_eq!(create_rule(&db, "lab", rule("sandbox:sb-1", "day", 1, "pause")).unwrap_err().code(), "invalid");
        let r = create_rule(&db, "work", rule("namespace", "day", 1, "alert")).unwrap();
        assert_eq!(delete_rule(&db, "lab", &r.id).unwrap_err().code(), "not_found");
        delete_rule(&db, "work", &r.id).unwrap();
        assert_eq!(set(&db, "work", 1, 0.0).unwrap_err().code(), "invalid");
    }
}

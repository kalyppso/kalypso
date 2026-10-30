-- The namespace's monthly limit. 0 means no limit.
CREATE TABLE budgets (
  ns            TEXT PRIMARY KEY REFERENCES namespaces(id) ON DELETE CASCADE,
  monthly_limit INTEGER NOT NULL DEFAULT 0, -- millionths of a dollar
  alert_at      REAL NOT NULL DEFAULT 0.8 CHECK (alert_at > 0 AND alert_at <= 1)
);

-- Extra caps. target is 'namespace', 'sandbox:<id>' or 'key:<id>'.
CREATE TABLE budget_rules (
  id           TEXT PRIMARY KEY,
  ns           TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  target       TEXT NOT NULL,
  period       TEXT NOT NULL CHECK (period IN ('run', 'day', 'month')),
  cap          INTEGER NOT NULL CHECK (cap > 0), -- millionths of a dollar
  action       TEXT NOT NULL CHECK (action IN ('pause', 'alert', 'downgrade')),
  downgrade_to TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Alerts already sent, so each fires once per period.
CREATE TABLE budget_alerts (
  rule_id    TEXT NOT NULL,
  period_key TEXT NOT NULL,
  ts         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (rule_id, period_key)
);

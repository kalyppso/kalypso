-- Guardrails. ns is a namespace id, or '*' for every namespace (so no foreign key;
-- namespace deletion removes its rows explicitly).
CREATE TABLE policies (
  id          TEXT PRIMARY KEY,
  ns          TEXT NOT NULL,
  name        TEXT NOT NULL,
  rule        TEXT NOT NULL,
  category    TEXT NOT NULL,
  enforcement TEXT NOT NULL CHECK (enforcement IN ('block', 'approve', 'warn')),
  applies_to  TEXT,             -- JSON array of targets, NULL for all
  enabled     INTEGER NOT NULL DEFAULT 1,
  spec        TEXT NOT NULL,    -- JSON, see policy::Spec
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX policies_ns ON policies (ns);

-- Every decision other than a silent allow.
CREATE TABLE policy_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ns        TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL,
  policy    TEXT NOT NULL,      -- name at the time
  source    TEXT NOT NULL,      -- sandbox or key label
  action    TEXT NOT NULL,      -- what was attempted, one line
  outcome   TEXT NOT NULL CHECK (outcome IN ('blocked', 'warned', 'asked', 'approved', 'denied'))
);
CREATE INDEX policy_events_ns_ts ON policy_events (ns, ts);

-- Approvals the user gave "for the rest of the run" (a run is a gateway key's life).
CREATE TABLE policy_grants (
  key_id    TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  PRIMARY KEY (key_id, policy_id)
);

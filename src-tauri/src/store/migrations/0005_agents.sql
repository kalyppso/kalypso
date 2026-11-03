-- Agents: what to run, where, and how to keep it running.
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  ns            TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT '',
  runtime       TEXT NOT NULL CHECK (runtime IN ('command', 'claude-sdk', 'claude-code')),
  model         TEXT NOT NULL DEFAULT '',
  sandbox_id    TEXT REFERENCES sandboxes(id) ON DELETE SET NULL,
  command       TEXT NOT NULL DEFAULT '',
  max_turns     INTEGER NOT NULL DEFAULT 0,            -- 0: no limit
  restart       TEXT NOT NULL DEFAULT 'on-failure' CHECK (restart IN ('never', 'on-failure', 'always')),
  max_restarts  INTEGER NOT NULL DEFAULT 3,
  status        TEXT NOT NULL DEFAULT 'stopped',
  status_reason TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ns, name)
);

-- One row per process start, restarts included.
CREATE TABLE agent_runs (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ns         TEXT NOT NULL,
  attempt    INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at   TEXT,
  exit_code  INTEGER,
  outcome    TEXT NOT NULL DEFAULT 'running',  -- running, exited, crashed, stopped
  reason     TEXT NOT NULL DEFAULT '',
  turns      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX agent_runs_agent ON agent_runs (agent_id, started_at);

-- The transcript: what the agent printed, what it was sent, and lifecycle notes.
CREATE TABLE agent_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  ts     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind   TEXT NOT NULL CHECK (kind IN ('output', 'input', 'status')),
  text   TEXT NOT NULL
);
CREATE INDEX agent_events_run ON agent_events (run_id, id);

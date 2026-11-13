-- Board tasks (#20): work handed to one agent, moved along as the agent works.
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  ns           TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  priority     TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'review', 'done', 'failed')),
  -- Why it is where it is: the agent's closing line, an error, or a reviewer's notes.
  status_note  TEXT NOT NULL DEFAULT '',
  -- What the agent said when it finished, for the reviewer.
  result       TEXT NOT NULL DEFAULT '',
  -- Notes from the last "request changes", sent along when the task runs again.
  review_note  TEXT NOT NULL DEFAULT '',
  -- The run and the transcript line that handed the task over; its answer comes after it.
  run_id       TEXT NOT NULL DEFAULT '',
  input_event  INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  -- Time and metered cost of the attempts that have ended; the running one is added live.
  spent_secs   INTEGER NOT NULL DEFAULT 0,
  spent_micros INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX tasks_ns ON tasks (ns, status);
CREATE INDEX tasks_agent ON tasks (agent_id, status);

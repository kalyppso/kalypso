-- Agent SDK runs produce richer transcripts: the model's text, tool calls, results,
-- policy blocks and errors, besides plain output. SQLite cannot widen a CHECK in
-- place, so the table is rebuilt with the same rows.
CREATE TABLE agent_events_new (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  ts     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind   TEXT NOT NULL CHECK (kind IN ('output', 'input', 'status', 'text', 'tool', 'result', 'policy', 'error')),
  text   TEXT NOT NULL
);
INSERT INTO agent_events_new (id, run_id, ts, kind, text) SELECT id, run_id, ts, kind, text FROM agent_events;
DROP TABLE agent_events;
ALTER TABLE agent_events_new RENAME TO agent_events;
CREATE INDEX agent_events_run ON agent_events (run_id, id);

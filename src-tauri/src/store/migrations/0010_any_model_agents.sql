-- kalypso: foreign_keys off
-- Agents on any OpenAI-compatible model ('openai-compat'). SQLite can't widen a CHECK in place,
-- so the table is rebuilt with the same rows. Foreign keys are off for this one (SQLite's
-- documented way to rebuild a table), so dropping the old table doesn't cascade to the runs
-- and events that reference it; they're checked again afterwards.
CREATE TABLE agents_new (
  id            TEXT PRIMARY KEY,
  ns            TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT '',
  runtime       TEXT NOT NULL CHECK (runtime IN ('command', 'claude-sdk', 'claude-code', 'openai-compat')),
  model         TEXT NOT NULL DEFAULT '',
  sandbox_id    TEXT REFERENCES sandboxes(id) ON DELETE SET NULL,
  command       TEXT NOT NULL DEFAULT '',
  max_turns     INTEGER NOT NULL DEFAULT 0,
  restart       TEXT NOT NULL DEFAULT 'on-failure' CHECK (restart IN ('never', 'on-failure', 'always')),
  max_restarts  INTEGER NOT NULL DEFAULT 3,
  status        TEXT NOT NULL DEFAULT 'stopped',
  status_reason TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  repo          TEXT,
  repo_account  TEXT REFERENCES github_accounts(id) ON DELETE SET NULL,
  branch        TEXT,
  UNIQUE (ns, name)
);
INSERT INTO agents_new (id, ns, name, role, runtime, model, sandbox_id, command, max_turns, restart, max_restarts, status, status_reason, created_at, repo, repo_account, branch)
  SELECT id, ns, name, role, runtime, model, sandbox_id, command, max_turns, restart, max_restarts, status, status_reason, created_at, repo, repo_account, branch FROM agents;
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;

-- On-request secrets (#87): a fourth scope, never delivered at start, only to one
-- approved command at a time through the secret gateway. SQLite can't widen a CHECK
-- in place, so the table is rebuilt with the same rows.
CREATE TABLE secrets_new (
  id         TEXT PRIMARY KEY,
  ns         TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('namespace', 'agent', 'gateway', 'on-request')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ns, key)
);
INSERT INTO secrets_new SELECT id, ns, key, ciphertext, nonce, scope, updated_at FROM secrets;
DROP TABLE secrets;
ALTER TABLE secrets_new RENAME TO secrets;

-- One row per approved run. Values are never stored here.
CREATE TABLE secret_grants (
  id          TEXT PRIMARY KEY,
  ns          TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  sandbox_id  TEXT NOT NULL,
  secret      TEXT NOT NULL,
  command     TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  source      TEXT NOT NULL,
  uid         INTEGER NOT NULL,
  started_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TEXT NOT NULL,
  ended_at    TEXT,
  -- running, exited, expired, revoked, failed
  outcome     TEXT NOT NULL DEFAULT 'running',
  exit_code   INTEGER,
  -- files holding the value that were found and removed after the run
  leaks       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX secret_grants_ns ON secret_grants (ns, started_at);

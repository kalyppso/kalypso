-- Model keys get their own scope: the gateway reads them, sandboxes never receive them.
CREATE TABLE secrets_new (
  id         TEXT PRIMARY KEY,
  ns         TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('namespace', 'agent', 'gateway')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ns, key)
);
INSERT INTO secrets_new SELECT id, ns, key, ciphertext, nonce, scope, updated_at FROM secrets;
DROP TABLE secrets;
ALTER TABLE secrets_new RENAME TO secrets;

-- Virtual keys: what sandboxes and local tools present to the gateway. Only a hash is kept.
CREATE TABLE gateway_keys (
  id         TEXT PRIMARY KEY,
  ns         TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  sandbox_id TEXT REFERENCES sandboxes(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  hash       BLOB NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

-- One row per proxied request. Kept when sandboxes or keys go away, so history stays.
CREATE TABLE usage_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ns             TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  key_id         TEXT NOT NULL,
  source         TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  status         INTEGER NOT NULL,
  stream         INTEGER NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cache_write    INTEGER NOT NULL,
  cache_read     INTEGER NOT NULL,
  cost_micros    INTEGER NOT NULL,
  priced         INTEGER NOT NULL,
  latency_ms     INTEGER NOT NULL
);
CREATE INDEX usage_events_ns_ts ON usage_events (ns, ts);

CREATE TABLE namespaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#5b2aaa',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-namespace data key, wrapped by the master key (never stored in plaintext).
CREATE TABLE ns_keys (
  ns      TEXT PRIMARY KEY REFERENCES namespaces(id) ON DELETE CASCADE,
  wrapped BLOB NOT NULL,
  nonce   BLOB NOT NULL
);

CREATE TABLE secrets (
  id         TEXT PRIMARY KEY,
  ns         TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('namespace', 'agent')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ns, key)
);

CREATE TABLE sandboxes (
  id           TEXT PRIMARY KEY,
  ns           TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  runtime      TEXT NOT NULL,
  image        TEXT NOT NULL,
  cpu          REAL NOT NULL,
  mem_mb       INTEGER NOT NULL,
  network      TEXT NOT NULL CHECK (network IN ('isolated', 'namespace', 'internet')),
  status       TEXT NOT NULL DEFAULT 'stopped',
  container_id TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ns, name)
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ns     TEXT,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  ts     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

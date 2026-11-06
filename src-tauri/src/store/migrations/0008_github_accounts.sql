-- GitHub accounts (#100). Accounts belong to the user, not to a namespace, so their tokens
-- are sealed with the master key. Each namespace chooses which accounts it may use.
CREATE TABLE github_accounts (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  login              TEXT NOT NULL,
  avatar_url         TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('oauth', 'token')),
  token              BLOB NOT NULL,
  token_nonce        BLOB NOT NULL,
  refresh            BLOB,
  refresh_nonce      BLOB,
  expires_at         TEXT,
  refresh_expires_at TEXT,
  scopes             TEXT NOT NULL DEFAULT '',
  orgs               TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'reconnect')),
  status_reason      TEXT,
  checked_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ns_github_accounts (
  ns         TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES github_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (ns, account_id)
);

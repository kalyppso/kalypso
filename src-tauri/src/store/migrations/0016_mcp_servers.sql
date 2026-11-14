-- MCP servers (#25): tools agents use, per namespace.
CREATE TABLE mcp_servers (
  id         TEXT PRIMARY KEY,
  ns         TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- 'stdio': a command run inside the agent's sandbox; 'http' or 'sse': a URL.
  transport  TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
  command    TEXT NOT NULL DEFAULT '',
  args       TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  url        TEXT NOT NULL DEFAULT '',
  -- JSON object: environment variables (stdio) or headers (http, sse). A value of
  -- {"secret": "NAME"} is read from the agent's delivered secret NAME, never stored here.
  env        TEXT NOT NULL DEFAULT '{}',
  -- Who gets it: 'all' agents, 'chosen' agents (mcp_agents), or 'master' (kalypso only).
  scope      TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'chosen', 'master')),
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ns, name)
);
CREATE TABLE mcp_agents (
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, agent_id)
);

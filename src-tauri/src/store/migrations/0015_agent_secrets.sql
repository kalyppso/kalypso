-- Secrets granted to one agent (scope 'agent'): delivered to that agent's sandbox only.
CREATE TABLE agent_secrets (
  agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, secret_id)
);
CREATE INDEX agent_secrets_secret ON agent_secrets (secret_id);

-- Prompts you write once and give to agents: instructions, and personas (who the agent is).
CREATE TABLE prompts (
  id          TEXT PRIMARY KEY,
  ns          TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('instruction', 'persona')),
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ns, name)
);

CREATE TABLE agent_prompts (
  agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, prompt_id)
);

-- What the master agent remembers across chats: notes you add, and ones it saves itself.
CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  ns         TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'you',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX memories_ns ON memories (ns, created_at);

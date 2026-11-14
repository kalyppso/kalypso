-- Skills (#24): instructions (a SKILL.md) agents can use, per namespace.
CREATE TABLE skills (
  id          TEXT PRIMARY KEY,
  ns          TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT '',
  -- Who gets it: 'all' agents, 'chosen' agents (agent_skills), or 'master' (kalypso only).
  scope       TEXT NOT NULL DEFAULT 'chosen' CHECK (scope IN ('all', 'chosen', 'master')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ns, name)
);
CREATE TABLE agent_skills (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, agent_id)
);

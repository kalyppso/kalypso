-- The master agent: the one you talk to in Chat. It coordinates the namespace's other agents
-- through KALYPSO (create, start, message, stop). At most one per namespace.
ALTER TABLE agents ADD COLUMN master INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX agents_one_master ON agents (ns) WHERE master = 1;

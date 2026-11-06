-- Repository-linked agents (#100): the GitHub repository an agent works on, the account whose
-- access it uses, and the branch it works on (set the first time the repository is prepared).
ALTER TABLE agents ADD COLUMN repo TEXT;
ALTER TABLE agents ADD COLUMN repo_account TEXT REFERENCES github_accounts(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN branch TEXT;

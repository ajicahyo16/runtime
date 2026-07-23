CREATE TABLE cli_device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  interval_seconds INTEGER NOT NULL,
  approved_at INTEGER,
  consumed_at INTEGER,
  user_id TEXT,
  workspace_id TEXT,
  result_token_envelope TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES application_users(id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX cli_device_authorizations_expiry
ON cli_device_authorizations(expires_at, consumed_at);

CREATE TABLE cli_access_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES application_users(id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX cli_access_tokens_user
ON cli_access_tokens(user_id, revoked_at, expires_at);

ALTER TABLE projects ADD COLUMN authoring_source TEXT NOT NULL DEFAULT 'visual'
  CHECK (authoring_source IN ('visual', 'repository'));
ALTER TABLE projects ADD COLUMN source_fingerprint TEXT;
ALTER TABLE projects ADD COLUMN source_revision TEXT;

CREATE TABLE runtime_application_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL CHECK(environment IN ('dev', 'staging', 'production')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  capabilities TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_by_user_id TEXT REFERENCES application_users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, project_id, environment, name)
);

CREATE INDEX runtime_application_credentials_project_environment_idx
  ON runtime_application_credentials(project_id, environment, revoked_at, expires_at);

ALTER TABLE runtime_telemetry_events ADD COLUMN caller_identity_hash TEXT;

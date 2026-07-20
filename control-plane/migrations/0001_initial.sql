CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  token_envelope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  document TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL CHECK(environment IN ('dev', 'staging', 'production')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'planning', 'deploying', 'succeeded', 'failed')),
  release_checksum TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  deployment_id TEXT REFERENCES deployments(id),
  object_id TEXT,
  action TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_events_project_time_idx ON runtime_events(project_id, occurred_at DESC);

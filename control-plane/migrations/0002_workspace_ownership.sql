CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT REFERENCES projects(id),
  actor_account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_workspace_time_idx ON audit_events(workspace_id, occurred_at DESC);

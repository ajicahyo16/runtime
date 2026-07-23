CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  checksum TEXT NOT NULL,
  manifest TEXT NOT NULL,
  artifact TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('compiled', 'verified', 'blocked', 'archived')),
  created_by_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, checksum)
);

CREATE INDEX IF NOT EXISTS releases_project_time_idx ON releases(project_id, created_at DESC);

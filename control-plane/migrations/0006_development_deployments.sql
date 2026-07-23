CREATE TABLE IF NOT EXISTS deployment_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  environment TEXT NOT NULL CHECK(environment IN ('dev', 'staging', 'production')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'planning', 'provisioning', 'deploying', 'verifying', 'succeeded', 'failed', 'rolled_back', 'planned')),
  resource_plan TEXT NOT NULL,
  smoke_check TEXT,
  runtime_url TEXT,
  created_by_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, release_id, environment)
);

CREATE INDEX IF NOT EXISTS deployment_jobs_project_time_idx ON deployment_jobs(project_id, created_at DESC);

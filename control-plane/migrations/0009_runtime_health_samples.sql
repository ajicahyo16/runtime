CREATE TABLE IF NOT EXISTS runtime_health_samples (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  deployment_id TEXT NOT NULL REFERENCES deployment_jobs(id),
  environment TEXT NOT NULL CHECK(environment IN ('dev', 'staging', 'production')),
  layer TEXT NOT NULL CHECK(layer IN ('worker', 'durable_object', 'sqlite')),
  aggregate_type TEXT,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'unhealthy')),
  latency_ms INTEGER NOT NULL,
  status_code INTEGER,
  endpoint TEXT NOT NULL,
  message TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_health_samples_deployment_time_idx
  ON runtime_health_samples(deployment_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS runtime_health_samples_project_environment_time_idx
  ON runtime_health_samples(project_id, environment, checked_at DESC);

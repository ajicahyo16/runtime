-- Alert evaluation only needs the newest aggregate health result for each
-- deployment. Keeping that projection separate prevents every alert pass from
-- grouping the full retained health history.
CREATE TABLE IF NOT EXISTS runtime_health_latest (
  deployment_id TEXT PRIMARY KEY REFERENCES deployment_jobs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  environment TEXT NOT NULL CHECK(environment IN ('dev', 'staging', 'production')),
  layer TEXT NOT NULL CHECK(layer IN ('worker', 'durable_object', 'sqlite')),
  aggregate_type TEXT,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'unhealthy')),
  checked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_health_latest_project_status_time_idx
  ON runtime_health_latest(project_id, status, checked_at DESC);

INSERT OR REPLACE INTO runtime_health_latest (
  deployment_id, workspace_id, project_id, release_id, environment,
  layer, aggregate_type, status, checked_at
)
SELECT
  sample.deployment_id, sample.workspace_id, sample.project_id, sample.release_id,
  sample.environment, sample.layer, sample.aggregate_type, sample.status,
  sample.checked_at
FROM runtime_health_samples sample
WHERE sample.id = (
  SELECT candidate.id
  FROM runtime_health_samples candidate
  WHERE candidate.deployment_id = sample.deployment_id
  ORDER BY candidate.checked_at DESC,
    CASE candidate.status WHEN 'unhealthy' THEN 0 ELSE 1 END,
    candidate.id DESC
  LIMIT 1
);


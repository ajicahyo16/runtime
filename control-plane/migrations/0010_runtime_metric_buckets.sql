CREATE TABLE IF NOT EXISTS runtime_metric_buckets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  deployment_id TEXT NOT NULL REFERENCES deployment_jobs(id),
  environment TEXT NOT NULL CHECK(environment IN ('dev', 'staging', 'production')),
  aggregate_type TEXT NOT NULL,
  action TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  duration_sum_ms INTEGER NOT NULL,
  duration_min_ms INTEGER NOT NULL,
  duration_max_ms INTEGER NOT NULL,
  duration_b0 INTEGER NOT NULL DEFAULT 0,
  duration_b1 INTEGER NOT NULL DEFAULT 0,
  duration_b2 INTEGER NOT NULL DEFAULT 0,
  duration_b3 INTEGER NOT NULL DEFAULT 0,
  duration_b4 INTEGER NOT NULL DEFAULT 0,
  duration_b5 INTEGER NOT NULL DEFAULT 0,
  duration_b6 INTEGER NOT NULL DEFAULT 0,
  duration_b7 INTEGER NOT NULL DEFAULT 0,
  duration_b8 INTEGER NOT NULL DEFAULT 0,
  duration_b9 INTEGER NOT NULL DEFAULT 0,
  duration_b10 INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, project_id, release_id, deployment_id, environment, aggregate_type, action, bucket_start)
);

CREATE INDEX IF NOT EXISTS runtime_metric_buckets_project_time_idx
  ON runtime_metric_buckets(project_id, bucket_start DESC);

CREATE INDEX IF NOT EXISTS runtime_metric_buckets_deployment_time_idx
  ON runtime_metric_buckets(deployment_id, bucket_start DESC);

INSERT OR IGNORE INTO runtime_metric_buckets (
  workspace_id, project_id, release_id, deployment_id, environment, aggregate_type, action, bucket_start,
  request_count, success_count, error_count, duration_sum_ms, duration_min_ms, duration_max_ms,
  duration_b0, duration_b1, duration_b2, duration_b3, duration_b4, duration_b5,
  duration_b6, duration_b7, duration_b8, duration_b9, duration_b10, updated_at
)
SELECT
  workspace_id, project_id, release_id, deployment_id, environment, aggregate_type, action,
  CAST(occurred_at / 300000 AS INTEGER) * 300000,
  COUNT(*),
  SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END),
  SUM(CASE WHEN outcome = 'success' THEN 0 ELSE 1 END),
  SUM(duration_ms), MIN(duration_ms), MAX(duration_ms),
  SUM(CASE WHEN duration_ms < 10 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 10 AND duration_ms < 25 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 25 AND duration_ms < 50 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 50 AND duration_ms < 100 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 100 AND duration_ms < 250 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 250 AND duration_ms < 500 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 500 AND duration_ms < 1000 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 1000 AND duration_ms < 2500 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 2500 AND duration_ms < 5000 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 5000 AND duration_ms < 10000 THEN 1 ELSE 0 END),
  SUM(CASE WHEN duration_ms >= 10000 THEN 1 ELSE 0 END),
  MAX(received_at)
FROM runtime_telemetry_events
GROUP BY workspace_id, project_id, release_id, deployment_id, environment, aggregate_type, action, CAST(occurred_at / 300000 AS INTEGER);

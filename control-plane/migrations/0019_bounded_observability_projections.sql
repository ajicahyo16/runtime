-- Keep dashboard and scheduled cost queries proportional to the number of
-- summaries, never to the retained raw telemetry or storage sample history.
CREATE TABLE IF NOT EXISTS aggregate_storage_latest (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  storage_bytes INTEGER NOT NULL,
  previous_storage_bytes INTEGER,
  table_stats TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, project_id, environment, aggregate_type)
);

CREATE INDEX IF NOT EXISTS aggregate_storage_latest_project_time_idx
  ON aggregate_storage_latest(project_id, checked_at DESC);

WITH ordered AS (
  SELECT workspace_id, project_id, release_id, deployment_id, environment,
    aggregate_type, storage_bytes, table_stats, checked_at,
    LAG(storage_bytes) OVER (
      PARTITION BY workspace_id, project_id, environment, aggregate_type
      ORDER BY checked_at, id
    ) AS previous_storage_bytes,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, project_id, environment, aggregate_type
      ORDER BY checked_at DESC, id DESC
    ) AS row_number
  FROM aggregate_storage_samples
)
INSERT OR IGNORE INTO aggregate_storage_latest (
  workspace_id, project_id, release_id, deployment_id, environment,
  aggregate_type, storage_bytes, previous_storage_bytes, table_stats, checked_at
)
SELECT workspace_id, project_id, release_id, deployment_id, environment,
  aggregate_type, storage_bytes, previous_storage_bytes, table_stats, checked_at
FROM ordered
WHERE row_number = 1;

CREATE TABLE IF NOT EXISTS runtime_usage_monthly (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  sqlite_reads INTEGER NOT NULL,
  sqlite_writes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, project_id, environment, period_start)
);

CREATE INDEX IF NOT EXISTS runtime_usage_monthly_project_period_idx
  ON runtime_usage_monthly(project_id, period_start, environment);

WITH ranked AS (
  SELECT workspace_id, project_id, environment, period_start, observed_usage,
    calculated_at,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, project_id, environment, period_start
      ORDER BY calculated_at DESC
    ) AS row_number
  FROM usage_cost_estimates
)
INSERT OR IGNORE INTO runtime_usage_monthly (
  workspace_id, project_id, environment, period_start, requests,
  sqlite_reads, sqlite_writes, updated_at
)
SELECT workspace_id, project_id, environment, period_start,
  CAST(COALESCE(json_extract(observed_usage, '$.requests'), 0) AS INTEGER),
  CAST(COALESCE(json_extract(observed_usage, '$.sqliteReads'), 0) AS INTEGER),
  CAST(COALESCE(json_extract(observed_usage, '$.sqliteWrites'), 0) AS INTEGER),
  calculated_at
FROM ranked
WHERE row_number = 1;

CREATE TABLE IF NOT EXISTS runtime_partition_activity (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  partition_key_hash TEXT NOT NULL,
  requests INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  duration_sum_ms INTEGER NOT NULL,
  sqlite_reads INTEGER NOT NULL,
  sqlite_writes INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, project_id, environment, aggregate_type, partition_key_hash)
);

CREATE INDEX IF NOT EXISTS runtime_partition_activity_project_requests_idx
  ON runtime_partition_activity(project_id, requests DESC, last_seen_at);

CREATE INDEX IF NOT EXISTS runtime_partition_activity_workspace_time_idx
  ON runtime_partition_activity(workspace_id, last_seen_at);

INSERT OR IGNORE INTO runtime_partition_activity (
  workspace_id, project_id, environment, aggregate_type, partition_key_hash,
  requests, errors, duration_sum_ms, sqlite_reads, sqlite_writes, last_seen_at
)
SELECT workspace_id, project_id, environment, aggregate_type, partition_key_hash,
  COUNT(*),
  SUM(CASE WHEN outcome = 'success' THEN 0 ELSE 1 END),
  SUM(duration_ms), SUM(sqlite_reads), SUM(sqlite_writes), MAX(occurred_at)
FROM runtime_telemetry_events
WHERE occurred_at >= CAST(strftime('%s', 'now', '-7 days') AS INTEGER) * 1000
GROUP BY workspace_id, project_id, environment, aggregate_type, partition_key_hash;

CREATE TABLE IF NOT EXISTS telemetry_credentials (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployment_jobs(id),
  credential_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS telemetry_credentials_deployment_idx
  ON telemetry_credentials(deployment_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS runtime_event_batches (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES telemetry_credentials(id),
  deployment_id TEXT NOT NULL REFERENCES deployment_jobs(id),
  event_count INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(deployment_id, id)
);

CREATE INDEX IF NOT EXISTS runtime_event_batches_deployment_time_idx
  ON runtime_event_batches(deployment_id, received_at DESC);

-- Kept separate from the Phase 1 `runtime_events` table because that legacy
-- table references the retired `deployments` model. This table is scoped to
-- immutable releases and deployment jobs from the current control plane.
CREATE TABLE IF NOT EXISTS runtime_telemetry_events (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES runtime_event_batches(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  deployment_id TEXT NOT NULL REFERENCES deployment_jobs(id),
  environment TEXT NOT NULL CHECK(environment IN ('dev', 'staging', 'production')),
  aggregate_type TEXT NOT NULL,
  partition_key_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'client_error', 'runtime_error')),
  level TEXT NOT NULL CHECK(level IN ('info', 'warning', 'error')),
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  message TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_telemetry_events_project_time_idx
  ON runtime_telemetry_events(project_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS runtime_telemetry_events_deployment_time_idx
  ON runtime_telemetry_events(deployment_id, occurred_at DESC);

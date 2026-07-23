ALTER TABLE runtime_telemetry_events ADD COLUMN sqlite_reads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runtime_telemetry_events ADD COLUMN sqlite_writes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE aggregate_storage_samples (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, release_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL, environment TEXT NOT NULL, aggregate_type TEXT NOT NULL,
  storage_bytes INTEGER NOT NULL, table_stats TEXT NOT NULL, checked_at INTEGER NOT NULL
);
CREATE INDEX aggregate_storage_project_time_idx ON aggregate_storage_samples(project_id, checked_at DESC);

CREATE TABLE alert_rules (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('warning','critical')), threshold REAL NOT NULL,
  window_minutes INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX alert_rules_project_kind_idx ON alert_rules(project_id, kind);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, rule_id TEXT NOT NULL,
  deployment_id TEXT, release_id TEXT, environment TEXT, status TEXT NOT NULL CHECK(status IN ('open','acknowledged','resolved')),
  severity TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, opened_at INTEGER NOT NULL,
  acknowledged_at INTEGER, acknowledged_by TEXT, resolved_at INTEGER, resolved_by TEXT, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX incidents_active_rule_idx ON incidents(rule_id) WHERE status IN ('open','acknowledged');
CREATE INDEX incidents_project_time_idx ON incidents(project_id, opened_at DESC);

CREATE TABLE incident_events (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, event_type TEXT NOT NULL, message TEXT NOT NULL,
  actor_account_id TEXT, occurred_at INTEGER NOT NULL
);

CREATE TABLE pricing_versions (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, effective_at INTEGER NOT NULL, currency TEXT NOT NULL,
  source_url TEXT NOT NULL, prices TEXT NOT NULL, created_at INTEGER NOT NULL
);
INSERT INTO pricing_versions (id, provider, effective_at, currency, source_url, prices, created_at) VALUES
  ('cloudflare-2026-07-07', 'cloudflare', 1783382400000, 'USD', 'https://developers.cloudflare.com/workers/platform/pricing/',
   '{"workerRequestsPerMillion":0.30,"workerRequestsIncluded":10000000,"doRequestsPerMillion":0.15,"doRequestsIncluded":1000000,"doGbSecondsPerMillion":12.50,"doGbSecondsIncluded":400000,"sqliteReadsPerMillion":0.001,"sqliteReadsIncluded":25000000000,"sqliteWritesPerMillion":1.00,"sqliteWritesIncluded":50000000,"sqliteStorageGbMonth":0.20,"sqliteStorageIncludedGb":5}', 1783382400000);

CREATE TABLE usage_cost_estimates (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, environment TEXT,
  pricing_version_id TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
  observed_usage TEXT NOT NULL, estimated_cost TEXT NOT NULL, caveats TEXT NOT NULL, calculated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX usage_cost_project_period_idx ON usage_cost_estimates(project_id, environment, pricing_version_id, period_start, period_end);

CREATE TABLE observability_policies (
  workspace_id TEXT PRIMARY KEY, raw_event_days INTEGER NOT NULL DEFAULT 30, health_sample_days INTEGER NOT NULL DEFAULT 30,
  metric_bucket_days INTEGER NOT NULL DEFAULT 395, incident_days INTEGER NOT NULL DEFAULT 395,
  daily_event_quota INTEGER NOT NULL DEFAULT 100000, sampling_rate REAL NOT NULL DEFAULT 1.0, updated_at INTEGER NOT NULL
);

CREATE TABLE telemetry_daily_usage (
  workspace_id TEXT NOT NULL, day TEXT NOT NULL, accepted_events INTEGER NOT NULL, dropped_events INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id, day)
);

-- Retention jobs are scoped by workspace and time. Without these indexes D1
-- scans the full observability tables every time an old row is removed.
CREATE INDEX IF NOT EXISTS runtime_telemetry_events_workspace_time_idx
  ON runtime_telemetry_events(workspace_id, occurred_at);

CREATE INDEX IF NOT EXISTS runtime_telemetry_events_batch_idx
  ON runtime_telemetry_events(batch_id);

CREATE INDEX IF NOT EXISTS runtime_health_samples_workspace_time_idx
  ON runtime_health_samples(workspace_id, checked_at);

CREATE INDEX IF NOT EXISTS runtime_health_samples_project_time_deployment_idx
  ON runtime_health_samples(project_id, checked_at DESC, deployment_id, status);

CREATE INDEX IF NOT EXISTS aggregate_storage_samples_workspace_time_idx
  ON aggregate_storage_samples(workspace_id, checked_at);

CREATE INDEX IF NOT EXISTS runtime_metric_buckets_workspace_time_idx
  ON runtime_metric_buckets(workspace_id, bucket_start);

CREATE INDEX IF NOT EXISTS incidents_workspace_status_resolved_idx
  ON incidents(workspace_id, status, resolved_at);

CREATE INDEX IF NOT EXISTS incident_events_incident_idx
  ON incident_events(incident_id);

CREATE INDEX IF NOT EXISTS usage_cost_estimates_workspace_period_idx
  ON usage_cost_estimates(workspace_id, period_end);

CREATE INDEX IF NOT EXISTS runtime_event_batches_received_idx
  ON runtime_event_batches(received_at);

CREATE INDEX IF NOT EXISTS telemetry_daily_usage_updated_idx
  ON telemetry_daily_usage(updated_at);

CREATE INDEX IF NOT EXISTS authentication_rate_limits_last_failure_idx
  ON authentication_rate_limits(last_failure_at);

CREATE INDEX IF NOT EXISTS sensitive_action_usage_window_idx
  ON sensitive_action_usage(window_started_at);


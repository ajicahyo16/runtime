import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL('../migrations/0013_workspace_and_production_readiness.sql', import.meta.url), 'utf8')
const retentionMigration = readFileSync(new URL('../migrations/0017_observability_retention_indexes.sql', import.meta.url), 'utf8')
const latestHealthMigration = readFileSync(new URL('../migrations/0018_latest_runtime_health.sql', import.meta.url), 'utf8')
const boundedObservabilityMigration = readFileSync(new URL('../migrations/0019_bounded_observability_projections.sql', import.meta.url), 'utf8')
const control = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const controlConfig = readFileSync(new URL('../../wrangler.control-plane.toml', import.meta.url), 'utf8')
const hosting = readFileSync(new URL('../../hosting/worker.js', import.meta.url), 'utf8')

test('seeds bounded role capabilities and protects the final owner', () => {
  for (const role of ['owner', 'admin', 'developer', 'operator', 'viewer']) assert.match(migration, new RegExp(`\\('${role}','workspace\\.read'\\)`))
  assert.match(control, /final workspace Owner cannot be removed or demoted/i)
  assert.match(control, /UPDATE application_sessions SET revoked_at = \? WHERE user_id = \? AND workspace_id = \?/)
})

test('binds Production approval to change context and configuration revision', () => {
  assert.match(migration, /production_change_requests/)
  assert.match(migration, /ALTER TABLE release_approvals ADD COLUMN config_revision/)
  assert.match(control, /Production approval is stale because configuration or change context changed/)
  assert.match(control, /Resolve critical readiness incidents or create an audited emergency override/)
  assert.match(control, /A different member must verify this release/)
  assert.match(control, /A different member must deploy this approved Production release/)
})

test('enforces environment preflight, deployment windows, and deep health', () => {
  assert.match(control, /Record \$\{environment\} environment configuration before deployment/)
  assert.match(control, /Production deployment is outside the configured UTC window/)
  assert.match(control, /health\?deep=1/)
  assert.match(control, /A previously healthy Production rollback target is required/)
})

test('requires live runtime health, recent telemetry, and recovery evidence for readiness', () => {
  assert.match(control, /Runtime telemetry pipeline verified for current Production deployment/)
  assert.match(control, /Verified recovery bookmark/)
  assert.match(control, /AbortSignal\.timeout\(5_000\)/)
})

test('keeps scheduled monitoring shallow while retaining explicit deep health checks', () => {
  const scheduledHealth = control.slice(
    control.indexOf('async function persistRuntimeHealth'),
    control.indexOf('async function sampleRuntimeHealth'),
  )
  assert.match(scheduledHealth, /const endpoint = `\$\{deployment\.runtime_url\}\/health`/)
  assert.doesNotMatch(scheduledHealth, /deep=1/)
  assert.match(control, /fetch\(`\$\{runtimeUrl\}\/health\?deep=1`/)
})

test('runs indexed observability retention separately from five-minute monitoring', () => {
  assert.match(controlConfig, /crons = \["\*\/5 \* \* \* \*", "17 3 \* \* \*"\]/)
  assert.match(control, /controller\.cron === '17 3 \* \* \*'/)
  assert.match(retentionMigration, /runtime_telemetry_events_workspace_time_idx/)
  assert.match(retentionMigration, /runtime_health_samples_workspace_time_idx/)
  assert.match(retentionMigration, /runtime_telemetry_events_batch_idx/)
  assert.match(control, /NOT EXISTS \(SELECT 1 FROM runtime_telemetry_events event WHERE event\.batch_id = runtime_event_batches\.id\)/)
})

test('evaluates alerts every fifteen minutes from a bounded latest-health projection', () => {
  assert.match(latestHealthMigration, /CREATE TABLE IF NOT EXISTS runtime_health_latest/)
  assert.match(latestHealthMigration, /runtime_health_latest_project_status_time_idx/)
  assert.match(control, /ON CONFLICT\(deployment_id\) DO UPDATE SET/)
  assert.match(control, /FROM runtime_health_latest/)
  assert.match(control, /controller\.scheduledTime \/ 60_000\) % 15 === 0/)
  assert.doesNotMatch(control, /WITH latest AS \(\s*SELECT deployment_id, MAX\(checked_at\)/)
})

test('keeps cost, storage, and partition dashboards on bounded projections', () => {
  assert.match(boundedObservabilityMigration, /CREATE TABLE IF NOT EXISTS aggregate_storage_latest/)
  assert.match(boundedObservabilityMigration, /CREATE TABLE IF NOT EXISTS runtime_usage_monthly/)
  assert.match(boundedObservabilityMigration, /CREATE TABLE IF NOT EXISTS runtime_partition_activity/)
  assert.match(boundedObservabilityMigration, /aggregate_storage_latest_project_time_idx/)
  assert.match(boundedObservabilityMigration, /runtime_partition_activity_project_requests_idx/)

  const costRefresh = control.slice(
    control.indexOf('async function refreshCostEstimate'),
    control.indexOf('async function evaluateAlerts'),
  )
  assert.match(costRefresh, /FROM runtime_usage_monthly/)
  assert.match(costRefresh, /FROM aggregate_storage_latest/)
  assert.doesNotMatch(costRefresh, /FROM runtime_telemetry_events/)
  assert.doesNotMatch(costRefresh, /FROM aggregate_storage_samples/)

  const operationsRoute = control.slice(
    control.indexOf("if (url.pathname === '/api/aggregate-operations'"),
    control.indexOf("if (url.pathname === '/api/telemetry-export'"),
  )
  assert.match(operationsRoute, /FROM aggregate_storage_latest/)
  assert.match(operationsRoute, /FROM runtime_partition_activity/)
  assert.doesNotMatch(operationsRoute, /refreshCostEstimate/)
  assert.doesNotMatch(operationsRoute, /FROM runtime_telemetry_events/)
})

test('keeps encrypted secrets out of environment read responses', () => {
  assert.match(control, /SELECT environment, name, rotated_at FROM environment_secrets/)
  assert.doesNotMatch(control, /SELECT environment, name, value_envelope, rotated_at FROM environment_secrets/)
  assert.match(control, /environment\.secret\.rotated/)
})

test('uses workspace Uplink credentials for application and CLI deployments', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.equal(source.includes("session.kind === 'application' || session.kind === 'cli'"), true)
  assert.equal(source.includes('SELECT token_envelope FROM uplink_connections WHERE workspace_id = ? AND account_id = ?'), true)
})

test('adds a Durable Object migration when an existing Worker gains an Actor class', () => {
  assert.match(control, /deployment_jobs\.status = 'succeeded'/)
  assert.match(control, /existing\?\.status === 'succeeded'/)
  assert.match(control, /entry\.event === 'smoke_passed'/)
  assert.match(control, /const previousClasses = new Set/)
  assert.match(control, /classes\.filter\(\(className\) => !previousClasses\.has\(className\)\)/)
  assert.match(control, /tag: scriptExists \? `release_\$\{release\.checksum\.slice\(0, 16\)\}` : 'v1'/)
  assert.match(control, /new_sqlite_classes: newClasses/)
})

test('allows bounded workers.dev propagation before failing runtime smoke', () => {
  assert.equal(control.includes('attempt <= 14'), true)
  assert.equal(control.includes('Math.min(1_000 * attempt, 5_000)'), true)
  assert.match(control, /Probe for up to 60 seconds/)
  assert.match(control, /signal: AbortSignal\.timeout\(5_000\)/)
  assert.match(control, /existing\.runtime_url\}\/health\?deep=1/)
  assert.match(control, /Deep runtime health check passed after activation delay/)
  assert.match(control, /smokePayload\.deploymentId === deploymentId/)
  assert.match(control, /smokePayload\.releaseId === releaseId/)
  assert.match(control, /recoveredPayload\.deploymentId === existing\.id/)
})

test('serves browser security headers and redacted support diagnostics', () => {
  for (const header of ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'permissions-policy']) assert.match(hosting, new RegExp(header))
  assert.match(control, /Secrets, credentials, command payloads, and business records are excluded/)
})

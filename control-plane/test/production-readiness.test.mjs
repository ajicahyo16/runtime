import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL('../migrations/0013_workspace_and_production_readiness.sql', import.meta.url), 'utf8')
const control = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
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
  assert.equal(control.includes('attempt < 8'), true)
  assert.equal(control.includes('Math.min(1_000 * (attempt + 1), 5_000)'), true)
})

test('serves browser security headers and redacted support diagnostics', () => {
  for (const header of ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'permissions-policy']) assert.match(hosting, new RegExp(header))
  assert.match(control, /Secrets, credentials, command payloads, and business records are excluded/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { validateTelemetryEvent } from '../src/index.ts'

const now = Date.now()
const valid = {
  id: 'event_validation_123', occurredAt: now, aggregateType: 'Outlet', partitionKeyHash: 'a'.repeat(64),
  action: 'PlaceOrder', outcome: 'success', durationMs: 42, statusCode: 200,
  sqliteReads: 1, sqliteWrites: 4, storageBytes: 57344, tableStats: [{ name: 'outlet_order', rows: 1 }],
}

test('accepts safe bounded telemetry without command payloads', () => {
  const result = validateTelemetryEvent(valid, now)
  assert.equal(result.event?.sqliteReads, 1)
  assert.deepEqual(result.event?.tableStats, [{ name: 'outlet_order', rows: 1 }])
  assert.equal('payload' in result.event, false)
})

test('rejects delayed, future, malformed, and oversized storage telemetry', () => {
  assert.match(validateTelemetryEvent({ ...valid, occurredAt: now - 25 * 60 * 60 * 1000 }, now).message, /timestamp/)
  assert.match(validateTelemetryEvent({ ...valid, occurredAt: now + 6 * 60 * 1000 }, now).message, /timestamp/)
  assert.match(validateTelemetryEvent({ ...valid, partitionKeyHash: 'plaintext' }, now).message, /partition-key/)
  assert.match(validateTelemetryEvent({ ...valid, storageBytes: 11 * 1024 * 1024 * 1024 }, now).message, /storage size/)
  assert.match(validateTelemetryEvent({ ...valid, callerIdentityHash: 'plaintext' }, now).message, /caller-identity/)
})

test('accepts only a hashed caller identity and excludes caller payloads', () => {
  const result = validateTelemetryEvent({ ...valid, callerIdentityHash: 'b'.repeat(64), input: { secret: 'nope' } }, now)
  assert.equal(result.event?.callerIdentityHash, 'b'.repeat(64))
  assert.equal('input' in result.event, false)
})

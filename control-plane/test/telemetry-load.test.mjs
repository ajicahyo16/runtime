import assert from 'node:assert/strict'
import test from 'node:test'
import { validateTelemetryEvent } from '../src/index.ts'
import { durationBucket, summarizeMetricRows } from '../src/metrics.ts'

test('processes sustained maximum-size telemetry batches into bounded metric buckets', () => {
  const receivedAt = Date.now()
  const rows = []
  let accepted = 0

  for (let batch = 0; batch < 500; batch += 1) {
    for (let event = 0; event < 50; event += 1) {
      const durationMs = (batch + event) % 2_000
      const validated = validateTelemetryEvent({
        id: `load_${batch}_${event}`,
        occurredAt: receivedAt,
        aggregateType: 'Outlet',
        partitionKeyHash: 'a'.repeat(64),
        action: 'PlaceOrder',
        outcome: event % 20 === 0 ? 'runtime_error' : 'success',
        durationMs,
        statusCode: event % 20 === 0 ? 500 : 200,
        sqliteReads: event % 20 === 0 ? 0 : 1,
        sqliteWrites: event % 20 === 0 ? 0 : 4,
      }, receivedAt)
      assert.ok(validated.event)
      accepted += 1

      const histogram = Array.from({ length: 11 }, () => 0)
      histogram[durationBucket(durationMs)] = 1
      rows.push({
        request_count: 1,
        success_count: event % 20 === 0 ? 0 : 1,
        error_count: event % 20 === 0 ? 1 : 0,
        duration_sum_ms: durationMs,
        ...Object.fromEntries(histogram.map((count, index) => [`duration_b${index}`, count])),
      })
    }
  }

  const summary = summarizeMetricRows(rows)
  assert.equal(accepted, 25_000)
  assert.equal(summary.requests, 25_000)
  assert.equal(summary.successes + summary.errors, summary.requests)
  assert.equal(summary.errors, 1_500)
  assert.ok(summary.p95LatencyMs !== null)
})

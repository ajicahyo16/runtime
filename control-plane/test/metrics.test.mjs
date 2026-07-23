import assert from 'node:assert/strict'
import test from 'node:test'
import { durationBucket, metricBucketStart, percentileFromHistogram, summarizeMetricRows } from '../src/metrics.ts'

function row(overrides = {}) {
  return {
    bucket_start: 0,
    release_id: 'release_aaaaaaaaaaaaaaaaaaaaaaaa',
    deployment_id: 'deploy_aaaaaaaaaaaaaaaaaa_dev',
    environment: 'dev',
    aggregate_type: 'Outlet',
    action: 'PlaceOrder',
    request_count: 4,
    success_count: 3,
    error_count: 1,
    duration_sum_ms: 475,
    duration_min_ms: 5,
    duration_max_ms: 300,
    duration_b0: 1,
    duration_b1: 0,
    duration_b2: 1,
    duration_b3: 0,
    duration_b4: 1,
    duration_b5: 1,
    duration_b6: 0,
    duration_b7: 0,
    duration_b8: 0,
    duration_b9: 0,
    duration_b10: 0,
    ...overrides,
  }
}

test('assigns telemetry to fixed five-minute and bounded duration buckets', () => {
  assert.equal(metricBucketStart(300_123), 300_000)
  assert.equal(durationBucket(9), 0)
  assert.equal(durationBucket(10), 1)
  assert.equal(durationBucket(600_000), 10)
})

test('calculates scoped totals and bounded latency percentiles', () => {
  const summary = summarizeMetricRows([row(), row({ request_count: 1, success_count: 1, error_count: 0, duration_sum_ms: 20, duration_b0: 0, duration_b1: 1, duration_b2: 0, duration_b4: 0, duration_b5: 0 })])
  assert.equal(summary.requests, 5)
  assert.equal(summary.successes, 4)
  assert.equal(summary.errors, 1)
  assert.equal(summary.errorRate, 0.2)
  assert.equal(summary.averageLatencyMs, 99)
  assert.equal(summary.p50LatencyMs, 50)
  assert.equal(summary.p95LatencyMs, 500)
  assert.equal(percentileFromHistogram([], 0.95), null)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultFreeTierAssumptions, estimateCapacityBudget, evaluateCapacityScenario, percentile } from '../src/realtime-capacity.mjs'

test('capacity evidence calculates deterministic percentiles and free-tier-conscious estimates', () => {
  assert.equal(percentile([10, 40, 20, 30], 95), 40)
  assert.equal(percentile([], 95), null)
  const budget = estimateCapacityBudget({
    users: 300,
    reconnects: 30,
    inboundWebSocketMessages: 1_230,
    sqliteWritesPerCycle: 330,
    r2ClassAOperationsPerCycle: 30,
  }, { cyclesPerDay: 60 })
  assert.equal(budget.assumptions.sourceCheckedAt, defaultFreeTierAssumptions.sourceCheckedAt)
  assert.equal(budget.workerRequests.estimated, 2_100)
  assert.equal(budget.durableObjectRequests.estimated, 5_790)
  assert.equal(budget.sqliteRowsWritten.estimated, 20_100)
  assert.equal(budget.r2ClassAOperations.estimated, 54_000)
  assert.equal(budget.sqliteRowsWritten.withinAssumption, true)
})

test('capacity scenario fails closed when latency, errors, or storage evidence misses thresholds', () => {
  const healthy = {
    users: 30,
    rooms: 3,
    connections: { accepted: 30 },
    errors: [],
    latencyMs: { connectionP95: 20, immediateAckP95: 30, segmentedDurableP95: 40, reconnectP95: 20 },
    storage: { r2Segments: 3 },
  }
  assert.equal(evaluateCapacityScenario(healthy).passed, true)
  assert.equal(evaluateCapacityScenario({ ...healthy, errors: ['failure'] }).passed, false)
  assert.equal(evaluateCapacityScenario({ ...healthy, latencyMs: { ...healthy.latencyMs, immediateAckP95: 2_001 } }).passed, false)
})

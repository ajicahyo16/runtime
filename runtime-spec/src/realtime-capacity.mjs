export const defaultFreeTierAssumptions = Object.freeze({
  sourceCheckedAt: '2026-07-25',
  workerRequestsPerDay: 100_000,
  durableObjectRequestsPerDay: 100_000,
  sqliteRowsWrittenPerDay: 100_000,
  r2ClassAOperationsPerMonth: 1_000_000,
  websocketMessagesPerDurableObjectRequest: 20,
})

export function percentile(values, percentileValue) {
  if (!Array.isArray(values) || !values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1))
  return Number(sorted[index].toFixed(2))
}

function usage(value, limit) {
  const ratio = limit > 0 ? value / limit : 1
  return {
    estimated: Math.ceil(value),
    limit,
    utilizationPercent: Number((ratio * 100).toFixed(2)),
    headroom: Math.max(0, Math.floor(limit - value)),
    withinAssumption: value <= limit,
  }
}

export function estimateCapacityBudget(sample, options = {}) {
  const assumptions = { ...defaultFreeTierAssumptions, ...(options.assumptions || {}) }
  const cyclesPerDay = Number.isSafeInteger(options.cyclesPerDay) && options.cyclesPerDay > 0 ? options.cyclesPerDay : 60
  const reconnectsPerCycle = sample.reconnects
  const dailyConnections = sample.users + reconnectsPerCycle * cyclesPerDay
  const dailyMessages = sample.inboundWebSocketMessages * cyclesPerDay
  const dailyDurableObjectRequests = dailyConnections + Math.ceil(dailyMessages / assumptions.websocketMessagesPerDurableObjectRequest)
  const dailySqliteWrites = sample.sqliteWritesPerCycle * cyclesPerDay + sample.users
  const monthlyR2ClassA = sample.r2ClassAOperationsPerCycle * cyclesPerDay * 30
  return {
    model: 'local-behavioral-estimate/v1',
    cyclesPerDay,
    assumptions,
    importantLimit: 'Duration and provider-wide usage are not measurable from Miniflare and must be validated in Cloudflare staging.',
    workerRequests: usage(dailyConnections, assumptions.workerRequestsPerDay),
    durableObjectRequests: usage(dailyDurableObjectRequests, assumptions.durableObjectRequestsPerDay),
    sqliteRowsWritten: usage(dailySqliteWrites, assumptions.sqliteRowsWrittenPerDay),
    r2ClassAOperations: usage(monthlyR2ClassA, assumptions.r2ClassAOperationsPerMonth),
  }
}

export function evaluateCapacityScenario(result, thresholds = {}) {
  const limits = {
    connectionP95Ms: thresholds.connectionP95Ms || 2_000,
    immediateAckP95Ms: thresholds.immediateAckP95Ms || 2_000,
    segmentedDurableP95Ms: thresholds.segmentedDurableP95Ms || 3_000,
    reconnectP95Ms: thresholds.reconnectP95Ms || 2_000,
  }
  const checks = {
    allConnectionsAccepted: result.connections.accepted === result.users,
    noOperationErrors: result.errors.length === 0,
    connectionLatency: result.latencyMs.connectionP95 <= limits.connectionP95Ms,
    immediateLatency: result.latencyMs.immediateAckP95 <= limits.immediateAckP95Ms,
    segmentedDurability: result.latencyMs.segmentedDurableP95 <= limits.segmentedDurableP95Ms,
    reconnectLatency: result.latencyMs.reconnectP95 <= limits.reconnectP95Ms,
    segmentCount: result.storage.r2Segments === result.rooms,
  }
  return { passed: Object.values(checks).every(Boolean), limits, checks }
}

export const metricBucketMs = 5 * 60 * 1000
export const durationBucketUpperBounds = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 600_000] as const

export interface MetricBucketRow {
  bucket_start: number
  release_id: string
  deployment_id: string
  environment: string
  aggregate_type: string
  action: string
  request_count: number
  success_count: number
  error_count: number
  duration_sum_ms: number
  duration_min_ms: number
  duration_max_ms: number
  duration_b0: number
  duration_b1: number
  duration_b2: number
  duration_b3: number
  duration_b4: number
  duration_b5: number
  duration_b6: number
  duration_b7: number
  duration_b8: number
  duration_b9: number
  duration_b10: number
}

export function metricBucketStart(timestamp: number) {
  return Math.floor(timestamp / metricBucketMs) * metricBucketMs
}

export function durationBucket(durationMs: number) {
  const index = durationBucketUpperBounds.findIndex((upper) => durationMs < upper)
  return index === -1 ? durationBucketUpperBounds.length - 1 : index
}

export function rowHistogram(row: MetricBucketRow) {
  return Array.from({ length: durationBucketUpperBounds.length }, (_, index) => Number(row[`duration_b${index}` as keyof MetricBucketRow]) || 0)
}

export function percentileFromHistogram(histogram: number[], percentile: number) {
  const total = histogram.reduce((sum, count) => sum + count, 0)
  if (!total) return null
  const rank = Math.max(1, Math.ceil(total * percentile))
  let observed = 0
  for (let index = 0; index < histogram.length; index += 1) {
    observed += histogram[index]
    if (observed >= rank) return durationBucketUpperBounds[index]
  }
  return durationBucketUpperBounds[durationBucketUpperBounds.length - 1]
}

export function summarizeMetricRows(rows: MetricBucketRow[]) {
  const histogram = Array(durationBucketUpperBounds.length).fill(0) as number[]
  let requests = 0
  let successes = 0
  let errors = 0
  let durationSumMs = 0
  for (const row of rows) {
    requests += Number(row.request_count) || 0
    successes += Number(row.success_count) || 0
    errors += Number(row.error_count) || 0
    durationSumMs += Number(row.duration_sum_ms) || 0
    rowHistogram(row).forEach((count, index) => { histogram[index] += count })
  }
  return {
    requests,
    successes,
    errors,
    errorRate: requests ? errors / requests : null,
    averageLatencyMs: requests ? durationSumMs / requests : null,
    p50LatencyMs: percentileFromHistogram(histogram, 0.5),
    p95LatencyMs: percentileFromHistogram(histogram, 0.95),
    p99LatencyMs: percentileFromHistogram(histogram, 0.99),
  }
}

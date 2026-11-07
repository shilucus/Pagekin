export const PERFORMANCE_METRICS = [
  'import.inspect.calls', 'import.inspect.failed', 'import.inspect.cancelled', 'import.inspect.ms',
  'import.read.ms', 'import.read.utf8_bytes', 'import.read.archive_bytes', 'import.parse.ms', 'import.hash.ms', 'import.save.ms',
  'source.capture.calls', 'source.capture.failed', 'source.capture.ms',
  'source.read.ms', 'source.read.chapters', 'source.read.utf8_bytes',
  'source.select.ms', 'source.validate.ms', 'source.selected.utf8_bytes',
  'source.selected.global.chapters', 'source.selected.style.chapters', 'source.selected.blueprints.chapters',
  'generation.execute.calls', 'generation.execute.ms', 'generation.pending',
  'generation.dispatch.calls', 'generation.provider.ms', 'generation.provider.failed',
  'generation.notify.calls', 'generation.notify.durable_utf8_bytes',
  'generation.snapshot.calls', 'generation.snapshot.ms', 'generation.snapshot.utf8_bytes',
  'generation.snapshot.failed', 'generation.receipt.calls', 'generation.receipt.ms',
  'generation.publish.calls', 'generation.publish.utf8_bytes',
  'generation.visible.events', 'generation.reasoning.events',
  'generation.usage.known', 'generation.usage.unknown',
  'generation.usage.input_tokens', 'generation.usage.completion_tokens',
  'generation.usage.reasoning_tokens', 'generation.usage.total_tokens',
  'transport.sessions', 'transport.requests', 'transport.headers.ms', 'transport.first_response.ms',
  'transport.first_reasoning.ms', 'transport.first_visible.ms',
  'transport.visible.events', 'transport.reasoning.events',
  'transport.completed', 'transport.failed', 'transport.cancelled', 'transport.http_429',
  'ipc.snapshot.calls', 'ipc.snapshot.utf8_bytes',
  'renderer.snapshot.calls', 'renderer.snapshot.utf8_bytes',
  'renderer.snapshot.queue', 'renderer.snapshot.queue_ms', 'renderer.snapshot.hash_ms',
  'renderer.snapshot.processing_ms', 'renderer.snapshot.total_ms',
  'renderer.snapshot.duplicate', 'renderer.snapshot.accepted',
] as const

export type PerformanceMetric = typeof PERFORMANCE_METRICS[number]

// Fixed histograms retain the complete denominator without retaining per-event data.
const UPPER_BOUNDS = [0, ...Array.from({ length: 41 }, (_, index) => 2 ** index)]
const ALLOWED_METRICS: ReadonlySet<string> = new Set(PERFORMANCE_METRICS)

export interface PerformanceMetricSummary {
  count: number
  sum: number
  min: number
  max: number
  p50UpperBound: number
  p95UpperBound: number
}

export interface PerformanceBaselineSnapshot {
  schemaVersion: 1
  quantiles: 'fixed-histogram-upper-bounds'
  metrics: Partial<Record<PerformanceMetric, PerformanceMetricSummary>>
}

interface MutableSummary {
  count: number
  sum: number
  min: number
  max: number
  buckets: number[]
}

export function createPerformanceBaseline() {
  const summaries = new Map<PerformanceMetric, MutableSummary>()
  return {
    record(name: PerformanceMetric, value: number): void {
      if (!ALLOWED_METRICS.has(name) || !Number.isFinite(value) || value < 0) return
      const previous = summaries.get(name)
      if (previous && (!Number.isSafeInteger(previous.count + 1) || !Number.isFinite(previous.sum + value))) return
      const summary = previous ?? { count: 0, sum: 0, min: value, max: value, buckets: Array.from({ length: UPPER_BOUNDS.length + 1 }, () => 0) }
      summary.count++
      summary.sum += value
      summary.min = Math.min(summary.min, value)
      summary.max = Math.max(summary.max, value)
      const index = UPPER_BOUNDS.findIndex(bound => value <= bound)
      summary.buckets[index < 0 ? UPPER_BOUNDS.length : index]++
      summaries.set(name, summary)
    },
    snapshot(): PerformanceBaselineSnapshot {
      const metrics: PerformanceBaselineSnapshot['metrics'] = {}
      for (const name of PERFORMANCE_METRICS) {
        const summary = summaries.get(name)
        if (!summary) continue
        const quantile = (fraction: number) => {
          const target = Math.ceil(summary.count * fraction)
          let count = 0
          for (const [index, bucket] of summary.buckets.entries()) {
            count += bucket
            if (count >= target) return Math.min(UPPER_BOUNDS[index] ?? summary.max, summary.max)
          }
          return summary.max
        }
        metrics[name] = Object.freeze({ count: summary.count, sum: summary.sum, min: summary.min, max: summary.max,
          p50UpperBound: quantile(0.5), p95UpperBound: quantile(0.95) })
      }
      return Object.freeze({ schemaVersion: 1, quantiles: 'fixed-histogram-upper-bounds', metrics: Object.freeze(metrics) })
    },
  }
}

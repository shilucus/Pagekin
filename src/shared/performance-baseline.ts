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

export interface PerformanceProvenanceMetadata {
  corpusHash?: string
  sampleChapters?: number
  sampleBooks?: number
  sourceSha?: string
  environment?: string
  multiBookStatus?: Array<{ books: number; status: 'executed' | 'not_executed' }>
  attempted?: number
  failed?: number
}

export interface CreationCostAttribution {
  schemaVersion: 1
  localPreparation: {
    elapsedMs: number
    readUtf8Bytes: number
    readArchiveBytes: number
    inspectCalls: number
    inspectFailed: number
    inspectCancelled: number
  }
  queueWait: {
    queueMs: number
    pendingCount: number
    snapshotQueueCalls: number
  }
  modelExecution: {
    providerMs: number
    firstResponseMs: number | null
    firstVisibleMs: number | null
    firstReasoningMs: number | null
    visibleEvents: number
    reasoningEvents: number
    physicalRequests: number
    http429Count: number
    inputTokens: number
    completionTokens: number
    reasoningTokens: number
    totalTokens: number
    isNetworkWaiting: boolean
  }
  parsingComputation: {
    parseMs: number
    hashMs: number
    processingMs: number
  }
  persistenceSave: {
    saveMs: number
    snapshotMs: number
    receiptMs: number
    snapshotUtf8Bytes: number
    publishUtf8Bytes: number
    snapshotCalls: number
    snapshotFailed: number
  }
  provenance: PerformanceProvenanceMetadata
}

export function computeCreationCostAttribution(
  snapshot: PerformanceBaselineSnapshot,
  provenance?: Partial<PerformanceProvenanceMetadata>
): CreationCostAttribution {
  const getSum = (name: PerformanceMetric) => snapshot.metrics[name]?.sum ?? 0
  const getMin = (name: PerformanceMetric) => snapshot.metrics[name]?.min ?? null
  const getCount = (name: PerformanceMetric) => snapshot.metrics[name]?.count ?? 0

  const inspectMs = getSum('import.inspect.ms')
  const readMs = getSum('import.read.ms')
  const captureMs = getSum('source.capture.ms')
  const sourceReadMs = getSum('source.read.ms')
  const selectMs = getSum('source.select.ms')
  const validateMs = getSum('source.validate.ms')
  const localPrepMs = inspectMs + readMs + captureMs + sourceReadMs + selectMs + validateMs

  const queueMs = getSum('renderer.snapshot.queue_ms')
  const pendingCount = getSum('generation.pending')
  const snapshotQueueCalls = getCount('renderer.snapshot.queue')

  const providerMs = getSum('generation.provider.ms')
  const firstResponseMs = getMin('transport.first_response.ms')
  const firstVisibleMs = getMin('transport.first_visible.ms')
  const firstReasoningMs = getMin('transport.first_reasoning.ms')
  const visibleEvents = getSum('transport.visible.events') + getSum('generation.visible.events')
  const reasoningEvents = getSum('transport.reasoning.events') + getSum('generation.reasoning.events')
  const physicalRequests = getSum('transport.requests')
  const http429Count = getSum('transport.http_429')

  const inputTokens = getSum('generation.usage.input_tokens')
  const completionTokens = getSum('generation.usage.completion_tokens')
  const reasoningTokens = getSum('generation.usage.reasoning_tokens')
  const totalTokens = getSum('generation.usage.total_tokens')

  const isNetworkWaiting = physicalRequests > 0 && (firstVisibleMs === null || visibleEvents === 0)

  const parseMs = getSum('import.parse.ms')
  const hashMs = getSum('import.hash.ms') + getSum('renderer.snapshot.hash_ms')
  const processingMs = getSum('renderer.snapshot.processing_ms')

  const saveMs = getSum('import.save.ms')
  const snapshotMs = getSum('generation.snapshot.ms')
  const receiptMs = getSum('generation.receipt.ms')
  const snapshotUtf8Bytes = getSum('generation.snapshot.utf8_bytes')
  const publishUtf8Bytes = getSum('generation.publish.utf8_bytes')
  const snapshotCalls = getCount('generation.snapshot.calls')
  const snapshotFailed = getSum('generation.snapshot.failed')

  return Object.freeze({
    schemaVersion: 1,
    localPreparation: Object.freeze({
      elapsedMs: localPrepMs,
      readUtf8Bytes: getSum('import.read.utf8_bytes') + getSum('source.read.utf8_bytes'),
      readArchiveBytes: getSum('import.read.archive_bytes'),
      inspectCalls: getCount('import.inspect.calls'),
      inspectFailed: getSum('import.inspect.failed'),
      inspectCancelled: getSum('import.inspect.cancelled'),
    }),
    queueWait: Object.freeze({
      queueMs,
      pendingCount,
      snapshotQueueCalls,
    }),
    modelExecution: Object.freeze({
      providerMs,
      firstResponseMs,
      firstVisibleMs,
      firstReasoningMs,
      visibleEvents,
      reasoningEvents,
      physicalRequests,
      http429Count,
      inputTokens,
      completionTokens,
      reasoningTokens,
      totalTokens,
      isNetworkWaiting,
    }),
    parsingComputation: Object.freeze({
      parseMs,
      hashMs,
      processingMs,
    }),
    persistenceSave: Object.freeze({
      saveMs,
      snapshotMs,
      receiptMs,
      snapshotUtf8Bytes,
      publishUtf8Bytes,
      snapshotCalls,
      snapshotFailed,
    }),
    provenance: Object.freeze({
      corpusHash: provenance?.corpusHash,
      sampleChapters: provenance?.sampleChapters,
      sampleBooks: provenance?.sampleBooks ?? 1,
      sourceSha: provenance?.sourceSha,
      environment: provenance?.environment,
      multiBookStatus: provenance?.multiBookStatus ?? [
        { books: 2, status: 'not_executed' as const },
        { books: 4, status: 'not_executed' as const },
      ],
      attempted: provenance?.attempted,
      failed: provenance?.failed ?? 0,
    }),
  })
}

export function isNetworkWaitingVsUiFreeze(attribution: CreationCostAttribution): {
  isNetworkWaiting: boolean
  isUiFrozen: boolean
  explanation: string
} {
  const { modelExecution, queueWait } = attribution
  if (modelExecution.isNetworkWaiting || (modelExecution.physicalRequests > 0 && modelExecution.visibleEvents === 0)) {
    return {
      isNetworkWaiting: true,
      isUiFrozen: false,
      explanation: 'Network transport/model reasoning is in flight; client event loop is waiting on remote response, not frozen.',
    }
  }

  if (queueWait.queueMs > 500 && modelExecution.physicalRequests === 0) {
    return {
      isNetworkWaiting: false,
      isUiFrozen: true,
      explanation: 'Main thread/queue processing delay exceeded 500ms candidate threshold without active remote network request.',
    }
  }

  return {
    isNetworkWaiting: false,
    isUiFrozen: false,
    explanation: 'Normal execution cadence within candidate latency targets.',
  }
}

export interface CandidateTargetsEvaluation {
  p95CandidateTargetMs: 100
  mainThreadCandidateTargetMs: 500
  isCandidateTargetMet: boolean
  isHardThreshold: false
  observations: {
    rendererSnapshotProcessingP95: number | null
    rendererSnapshotQueueP95: number | null
    exceededTargets: readonly string[]
  }
  notice: string
}

export function evaluateCandidateTargets(snapshot: PerformanceBaselineSnapshot): CandidateTargetsEvaluation {
  const processingP95 = snapshot.metrics['renderer.snapshot.processing_ms']?.p95UpperBound ?? null
  const queueP95 = snapshot.metrics['renderer.snapshot.queue_ms']?.p95UpperBound ?? null

  const exceeded: string[] = []
  if (processingP95 !== null && processingP95 > 100) {
    exceeded.push(`renderer.snapshot.processing_ms p95 (${processingP95}ms > 100ms)`)
  }
  if (queueP95 !== null && queueP95 > 500) {
    exceeded.push(`renderer.snapshot.queue_ms p95 (${queueP95}ms > 500ms)`)
  }

  return Object.freeze({
    p95CandidateTargetMs: 100,
    mainThreadCandidateTargetMs: 500,
    isCandidateTargetMet: exceeded.length === 0,
    isHardThreshold: false,
    observations: Object.freeze({
      rendererSnapshotProcessingP95: processingP95,
      rendererSnapshotQueueP95: queueP95,
      exceededTargets: Object.freeze(exceeded),
    }),
    notice: 'p95 100ms and main-thread 500ms are candidate optimization goals, not hard gates or permanent prerequisites.',
  })
}

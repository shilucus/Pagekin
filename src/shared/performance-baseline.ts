export const PERFORMANCE_METRICS = [
  'import.inspect.calls', 'import.inspect.failed', 'import.inspect.cancelled', 'import.inspect.ms',
  'import.read.ms', 'import.read.utf8_bytes', 'import.read.archive_bytes', 'import.parse.ms', 'import.hash.ms', 'import.save.ms',
  'source.capture.calls', 'source.capture.failed', 'source.capture.ms',
  'source.read.ms', 'source.read.chapters', 'source.read.utf8_bytes',
  'source.select.ms', 'source.validate.ms', 'source.selected.utf8_bytes',
  'source.selected.global.chapters', 'source.selected.style.chapters', 'source.selected.blueprints.chapters',
  'scheduler.acquire.calls', 'scheduler.acquire.admitted', 'scheduler.acquire.rejected',
  'scheduler.queue', 'scheduler.wait.admitted_ms', 'scheduler.wait.rejected_ms',
  'workflow.import.knowledge.ms', 'workflow.import.global.ms', 'workflow.import.style.ms', 'workflow.import.blueprints.ms',
  'workflow.import.author-commit.ms', 'workflow.import.author-publish.ms', 'workflow.import.author-postprocess.ms', 'workflow.import.refresh.ms',
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

/** Duration fields are sample sums except named minima; they are not exclusive or wall-clock totals. */
export interface CreationCostAttribution {
  schemaVersion: 2
  localPreparation: {
    inspectMs: number | null
    importReadMs: number | null
    sourceCaptureMs: number | null
    sourceReadMs: number | null
    sourceSelectMs: number | null
    sourceValidateMs: number | null
    importReadUtf8Bytes: number | null
    sourceReadUtf8Bytes: number | null
    readArchiveBytes: number | null
    inspectCalls: number | null
    inspectFailed: number | null
    inspectCancelled: number | null
  }
  queueWait: {
    snapshotQueueMs: number | null
    pendingSamples: PerformanceMetricSummary | null
    snapshotQueueSamples: PerformanceMetricSummary | null
    schedulerAcquireCalls: number | null
    schedulerAdmitted: number | null
    schedulerRejected: number | null
    schedulerAdmittedWaitMs: number | null
    schedulerRejectedWaitMs: number | null
    schedulerQueueSamples: PerformanceMetricSummary | null
  }
  modelExecution: {
    providerMs: number | null
    firstResponseMinMs: number | null
    firstVisibleMinMs: number | null
    firstReasoningMinMs: number | null
    transportVisibleEvents: number | null
    generationVisibleEvents: number | null
    transportReasoningEvents: number | null
    generationReasoningEvents: number | null
    physicalRequests: number | null
    http429Count: number | null
    inputTokens: number | null
    completionTokens: number | null
    reasoningTokens: number | null
    totalTokens: number | null
  }
  parsingComputation: {
    parseMs: number | null
    importHashMs: number | null
    rendererSnapshotHashMs: number | null
    rendererSnapshotProcessingMs: number | null
  }
  persistenceSave: {
    saveMs: number | null
    snapshotMs: number | null
    receiptMs: number | null
    snapshotUtf8Bytes: number | null
    publishUtf8Bytes: number | null
    snapshotCalls: number | null
    snapshotFailed: number | null
  }
  provenance: PerformanceProvenanceMetadata
}

export function computeCreationCostAttribution(
  snapshot: PerformanceBaselineSnapshot,
  provenance?: Partial<PerformanceProvenanceMetadata>
): CreationCostAttribution {
  const getSum = (name: PerformanceMetric) => snapshot.metrics[name]?.sum ?? null
  const getMin = (name: PerformanceMetric) => snapshot.metrics[name]?.min ?? null

  return Object.freeze({
    schemaVersion: 2,
    localPreparation: Object.freeze({
      inspectMs: getSum('import.inspect.ms'),
      importReadMs: getSum('import.read.ms'),
      sourceCaptureMs: getSum('source.capture.ms'),
      sourceReadMs: getSum('source.read.ms'),
      sourceSelectMs: getSum('source.select.ms'),
      sourceValidateMs: getSum('source.validate.ms'),
      importReadUtf8Bytes: getSum('import.read.utf8_bytes'),
      sourceReadUtf8Bytes: getSum('source.read.utf8_bytes'),
      readArchiveBytes: getSum('import.read.archive_bytes'),
      inspectCalls: getSum('import.inspect.calls'),
      inspectFailed: getSum('import.inspect.failed'),
      inspectCancelled: getSum('import.inspect.cancelled'),
    }),
    queueWait: Object.freeze({
      snapshotQueueMs: getSum('renderer.snapshot.queue_ms'),
      pendingSamples: snapshot.metrics['generation.pending'] ?? null,
      snapshotQueueSamples: snapshot.metrics['renderer.snapshot.queue'] ?? null,
      schedulerAcquireCalls: getSum('scheduler.acquire.calls'),
      schedulerAdmitted: getSum('scheduler.acquire.admitted'),
      schedulerRejected: getSum('scheduler.acquire.rejected'),
      schedulerAdmittedWaitMs: getSum('scheduler.wait.admitted_ms'),
      schedulerRejectedWaitMs: getSum('scheduler.wait.rejected_ms'),
      schedulerQueueSamples: snapshot.metrics['scheduler.queue'] ?? null,
    }),
    modelExecution: Object.freeze({
      providerMs: getSum('generation.provider.ms'),
      firstResponseMinMs: getMin('transport.first_response.ms'),
      firstVisibleMinMs: getMin('transport.first_visible.ms'),
      firstReasoningMinMs: getMin('transport.first_reasoning.ms'),
      transportVisibleEvents: getSum('transport.visible.events'),
      generationVisibleEvents: getSum('generation.visible.events'),
      transportReasoningEvents: getSum('transport.reasoning.events'),
      generationReasoningEvents: getSum('generation.reasoning.events'),
      physicalRequests: getSum('transport.requests'),
      http429Count: getSum('transport.http_429'),
      inputTokens: getSum('generation.usage.input_tokens'),
      completionTokens: getSum('generation.usage.completion_tokens'),
      reasoningTokens: getSum('generation.usage.reasoning_tokens'),
      totalTokens: getSum('generation.usage.total_tokens'),
    }),
    parsingComputation: Object.freeze({
      parseMs: getSum('import.parse.ms'),
      importHashMs: getSum('import.hash.ms'),
      rendererSnapshotHashMs: getSum('renderer.snapshot.hash_ms'),
      rendererSnapshotProcessingMs: getSum('renderer.snapshot.processing_ms'),
    }),
    persistenceSave: Object.freeze({
      saveMs: getSum('import.save.ms'),
      snapshotMs: getSum('generation.snapshot.ms'),
      receiptMs: getSum('generation.receipt.ms'),
      snapshotUtf8Bytes: getSum('generation.snapshot.utf8_bytes'),
      publishUtf8Bytes: getSum('generation.publish.utf8_bytes'),
      snapshotCalls: getSum('generation.snapshot.calls'),
      snapshotFailed: getSum('generation.snapshot.failed'),
    }),
    provenance: Object.freeze({
      corpusHash: provenance?.corpusHash,
      sampleChapters: provenance?.sampleChapters,
      sampleBooks: provenance?.sampleBooks,
      sourceSha: provenance?.sourceSha,
      environment: provenance?.environment,
      multiBookStatus: provenance?.multiBookStatus,
      attempted: provenance?.attempted,
      failed: provenance?.failed,
    }),
  })
}

export function isNetworkWaitingVsUiFreeze(): {
  isNetworkWaiting: null
  isUiFrozen: null
  explanation: string
} {
  return {
    isNetworkWaiting: null,
    isUiFrozen: null,
    explanation: 'Aggregate counters and snapshot queue times do not establish current network activity or event-loop blocking.',
  }
}

export interface CandidateTargetsEvaluation {
  p95CandidateTargetMs: 100
  mainThreadCandidateTargetMs: 500
  isCandidateTargetMet: null
  isHardThreshold: false
  observations: {
    rendererSnapshotProcessingP95UpperBound: number | null
    rendererSnapshotQueueP95UpperBound: number | null
  }
  notice: string
}

export function evaluateCandidateTargets(snapshot: PerformanceBaselineSnapshot): CandidateTargetsEvaluation {
  const processingP95 = snapshot.metrics['renderer.snapshot.processing_ms']?.p95UpperBound ?? null
  const queueP95 = snapshot.metrics['renderer.snapshot.queue_ms']?.p95UpperBound ?? null

  return Object.freeze({
    p95CandidateTargetMs: 100,
    mainThreadCandidateTargetMs: 500,
    isCandidateTargetMet: null,
    isHardThreshold: false,
    observations: Object.freeze({
      rendererSnapshotProcessingP95UpperBound: processingP95,
      rendererSnapshotQueueP95UpperBound: queueP95,
    }),
    notice: 'Snapshot processing and queue metrics do not measure interaction p95 or main-thread blocking; candidate goals are not hard gates.',
  })
}

import type { GenerationSchedulingAdmission } from './generation-scheduler'
import type { SchedulerLane } from './main-process-scheduler'

/** Main-process dispatch context; projectKey is a captured runtime identity, not renderer input. */
export interface EmbeddingSchedulingContext {
  admission: Pick<GenerationSchedulingAdmission, 'acquireEmbedding'>
  projectKey: string
  lane: SchedulerLane
  assertActive: () => void
  signal?: AbortSignal
  /** Cancels queued siblings without aborting an already-dispatched transport. */
  queueSignal?: AbortSignal
  quarantineAfterMs?: number
}

/** Admission and authority failures must not become ordinary embedding fallback. */
export class EmbeddingSchedulingError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : 'GENERATION_REQUEST_FAILED')
    this.name = 'EmbeddingSchedulingError'
  }
}

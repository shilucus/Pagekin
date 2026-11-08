import { createHash } from 'node:crypto'
import type { MainGenerationSnapshot } from '../../src/services/generation/generation-runtime'
import type { GenerationTransportDiagnostics } from '../../src/shared/generation-contract'
import type { GenerationExecutionReceipt } from '../repositories/generation-run-repository'

export interface StreamSnapshotEvent {
  attemptId: string
  visibleText: string
  durableText: string
  durableRevision: number
  storageFailed: boolean
  diagnostics?: Partial<GenerationTransportDiagnostics>
}

export interface StreamSnapshotGuardDependencies {
  onPublish: (snapshot: MainGenerationSnapshot) => void
  readReceipt: (attemptId: string) => GenerationExecutionReceipt
  snapshotOf: (receipt: GenerationExecutionReceipt, visiblePurpose?: { purpose: string }) => MainGenerationSnapshot | null
  recordReceiptCall?: () => void
  recordPublish?: (text: string) => void
}

export interface AttemptPublishState {
  attemptId: string
  lastPublishedRevision: number
  lastPublishedTextHash: string | null
  lastPublishedText: string | null
  cumulativeDiagnostics?: Partial<GenerationTransportDiagnostics>
  suppressedCount: number
  divergentCount: number
  publishedCount: number
  receiptReadCount: number
  storageFailed: boolean
}

export const computeSnapshotTextHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function mergeDiagnostics(
  base: GenerationTransportDiagnostics | undefined,
  overlay: Partial<GenerationTransportDiagnostics> | undefined
): GenerationTransportDiagnostics | undefined {
  if (!base && !overlay) return undefined
  if (!base) return overlay as GenerationTransportDiagnostics
  if (!overlay) return base
  return {
    ...base,
    ...overlay,
  }
}

export function createStreamSnapshotGuard(deps: StreamSnapshotGuardDependencies) {
  const states = new Map<string, AttemptPublishState>()

  const getOrCreateState = (attemptId: string): AttemptPublishState => {
    let state = states.get(attemptId)
    if (!state) {
      state = {
        attemptId,
        lastPublishedRevision: -1,
        lastPublishedTextHash: null,
        lastPublishedText: null,
        cumulativeDiagnostics: undefined,
        suppressedCount: 0,
        divergentCount: 0,
        publishedCount: 0,
        receiptReadCount: 0,
        storageFailed: false,
      }
      states.set(attemptId, state)
    }
    return state
  }

  const handleStreamEvent = (event: StreamSnapshotEvent): MainGenerationSnapshot | null => {
    const state = getOrCreateState(event.attemptId)

    if (event.storageFailed) {
      state.storageFailed = true
      return null
    }

    if (event.diagnostics) {
      state.cumulativeDiagnostics = {
        ...(state.cumulativeDiagnostics ?? {}),
        ...event.diagnostics,
      }
    }

    // Regressive out-of-order event is safely dropped to preserve monotonicity
    if (event.durableRevision < state.lastPublishedRevision) {
      return null
    }

    // Same durable revision deduplication & divergence defense
    if (event.durableRevision === state.lastPublishedRevision) {
      if (
        state.lastPublishedText !== null &&
        event.durableText &&
        event.durableText !== state.lastPublishedText
      ) {
        // 异常同 revision 不同正文：触发一致性防御，丢弃矛盾投机文本并避免误计为正常抑制
        state.divergentCount++
        return null
      }
      state.suppressedCount++
      return null
    }

    // New durable snapshot reached disk (event.durableRevision > state.lastPublishedRevision)
    deps.recordReceiptCall?.()
    state.receiptReadCount++
    const receipt = deps.readReceipt(event.attemptId)
    const snapshot = deps.snapshotOf(receipt)
    if (!snapshot) return null

    // Strict monotonicity: database artifact must strictly advance past last published revision
    if (snapshot.durableRevision <= state.lastPublishedRevision) {
      return null
    }

    const calculatedHash = computeSnapshotTextHash(snapshot.text)
    if (snapshot.textHash && snapshot.textHash !== calculatedHash) {
      // In production artifacts, textHash is strictly enforced against content
      snapshot.textHash = calculatedHash
    }

    const mergedDiagnostics = mergeDiagnostics(snapshot.diagnostics, state.cumulativeDiagnostics)

    state.lastPublishedRevision = snapshot.durableRevision
    state.lastPublishedTextHash = snapshot.textHash
    state.lastPublishedText = snapshot.text
    state.publishedCount++

    deps.recordPublish?.(snapshot.text)

    const published: MainGenerationSnapshot = {
      ...snapshot,
      ...(mergedDiagnostics ? { diagnostics: mergedDiagnostics } : {}),
    }

    deps.onPublish(published)
    return published
  }

  const mergeTerminalDiagnostics = (
    snapshot: MainGenerationSnapshot
  ): MainGenerationSnapshot => {
    const state = getOrCreateState(snapshot.attemptId)
    state.publishedCount++
    deps.recordPublish?.(snapshot.text)

    const mergedDiagnostics = mergeDiagnostics(snapshot.diagnostics, state.cumulativeDiagnostics)
    if (!mergedDiagnostics) return snapshot

    return {
      ...snapshot,
      diagnostics: mergedDiagnostics,
    }
  }

  const getStats = (attemptId: string): Readonly<AttemptPublishState> | undefined => {
    return states.get(attemptId)
  }

  const clear = (attemptId: string) => {
    states.delete(attemptId)
  }

  return {
    handleStreamEvent,
    mergeTerminalDiagnostics,
    getStats,
    clear,
  }
}

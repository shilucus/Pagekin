import { createHash } from 'node:crypto'
import { knownAppErrorMessage } from '../../src/i18n/app-errors'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { PromptBudgetReport } from '../../src/services/generation/generation-harness'
import type { GenerationAttemptReceipt } from '../../src/services/generation/generation-harness'
import { createBoundedCompletionError } from '../../src/services/workflows/bounded-completion'
import { stripDraftThinkingTags } from '../../src/shared/draft-visible-text'
import { buildImportStyleMaterial, collectImportStyleAuthorInputs, collectImportStyleSamples } from '../../src/shared/import-style-materials'
import type { BeginGenerationRequest } from '../../src/shared/generation-owner-contract'
import type { ImportGenerationSlot } from '../../src/shared/import-generation'
import type { ImportRunEffectReceipt, ImportRunExecutionLease, ImportRunLocale } from '../../src/shared/import-run'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { GenerationRunRepository } from '../repositories/generation-run-repository'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { rootBudgetExhausted } from '../../src/shared/generation-contract'
import type { ProjectRuntime } from './project-runtime'
import type { ReferenceStyleLog, ReferenceStyleRequest, ReferenceStyleResult } from '../../src/shared/reference-style-contract'
import type { createMainGenerationOwner } from './main-generation-owner'

type Owner = ReturnType<typeof createMainGenerationOwner>
type Hooks = {
  opened(value: { handle: MainGenerationRunHandle; modelId: string }): Promise<void>
  commitReady(handle: MainGenerationRunHandle, writingStyle: string): Promise<void>
  committed(savedWritingStyle: string): void
  log(log: ReferenceStyleLog, count?: number): void
  progress(progress: 10 | 90 | 100): void
  promptBudget(report: PromptBudgetReport): void
  failureMessage(code: string, locale: ImportRunLocale): string
}

export class ReferenceStyleFailure extends Error {
  readonly secondaryErrors: string[] = []

  constructor(readonly errorCode: string, readonly displayMessage: string) {
    super(errorCode)
    this.name = 'ReferenceStyleFailure'
  }
}

type Options = {
  runtime: ProjectRuntime
  owner: Owner
  viewEpoch: string
  request: ReferenceStyleRequest
  signal: AbortSignal
  assertCurrent(): void
  hooks: Hooks
}

type RunLeaseRow = {
  purpose: string
  stage: string
  status: string
  cancel_requested: number
  execution_owner: string
  execution_epoch: number
  lease_expires_at: number
  locale: ImportRunLocale
}

const STYLE_SLOT = (runId: string): ImportGenerationSlot => ({ runId, stage: 'style', batchId: 'done' })
const STYLE_ATTEMPT_FAILURE_CODES = ['GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', 'GENERATION_CONTEXT_LENGTH_EXCEEDED',
  'ROOT_BUDGET_EXHAUSTED', 'GENERATION_STORAGE_FAILED'] as const satisfies readonly NonNullable<GenerationAttemptReceipt['failureCode']>[]
const INTERNAL_FAILURE_CODES = new Set([
  'GENERATION_ACTION_CANCELLED', 'GENERATION_IMPORT_CONTEXT_REQUIRED', 'GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED',
  'GENERATION_IMPORT_EFFECT_SEALED', 'GENERATION_IMPORT_EFFECT_SOURCE_CHANGED', 'GENERATION_IMPORT_EXECUTION_REQUIRED',
  'GENERATION_IMPORT_EXECUTION_STALE', 'GENERATION_IMPORT_MODEL_CHANGED', 'GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE',
  'GENERATION_IMPORT_PREVIOUS_EFFECT_REQUIRED', 'GENERATION_IMPORT_ROOT_CHANGED', 'GENERATION_IMPORT_SLOT_AMBIGUOUS',
  'GENERATION_IMPORT_SLOT_REQUIRED', 'GENERATION_IMPORT_STAGE_INVALID', 'GENERATION_FINALIZED_SOURCE_NOT_CURRENT',
  'IMPORT_RUN_CANCELLED', 'IMPORT_RUN_EFFECT_HANDLE_REQUIRED', 'IMPORT_RUN_EFFECT_HISTORY_UNKNOWN',
  'IMPORT_RUN_EXECUTION_STALE', 'IMPORT_RUN_NOT_FOUND', 'IMPORT_RUN_RECEIPT_PAYLOAD_INVALID', 'IMPORT_RUN_STAGE_MISMATCH',
])
const LEASE_POLL_MS = 25
const HEARTBEAT_MAX_MS = 60_000
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function safeFailureCode(code: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(code)
    && (knownAppErrorMessage('en-US', code) !== undefined
    || INTERNAL_FAILURE_CODES.has(code)
    || attemptFailureCode(code) !== undefined)
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'failureCode' in error
    && typeof error.failureCode === 'string' && safeFailureCode(error.failureCode)) return error.failureCode
  const code = error instanceof Error ? error.message : ''
  return safeFailureCode(code) ? code : 'GENERATION_REQUEST_FAILED'
}

function attemptFailureCode(value: unknown): NonNullable<GenerationAttemptReceipt['failureCode']> | undefined {
  return STYLE_ATTEMPT_FAILURE_CODES.find(code => code === value)
}

function noStyleFailure(locale: ImportRunLocale): ReferenceStyleFailure {
  return new ReferenceStyleFailure('GENERATION_REQUEST_FAILED', locale === 'zh-CN'
    ? '未提取到可用文风，无法继续建立仿写约束'
    : 'No usable writing style was extracted, so imitation guidance cannot be created.')
}

function readRunLease(runtime: ProjectRuntime, runId: string): RunLeaseRow {
  const row = runtime.database.prepare(`
    SELECT purpose,stage,status,cancel_requested,execution_owner,execution_epoch,lease_expires_at,locale
    FROM import_runs WHERE id=?
  `).get(runId) as RunLeaseRow | undefined
  if (!row) throw new Error('IMPORT_RUN_NOT_FOUND')
  return row
}

function assertRequestExecution(row: RunLeaseRow, request: ReferenceStyleRequest): void {
  if (row.execution_owner !== request.execution.owner || row.execution_epoch !== request.execution.epoch) {
    throw new Error('IMPORT_RUN_EXECUTION_STALE')
  }
  if (row.purpose !== 'reference') {
    throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
  }
}

function receiptStyle(receipt: ImportRunEffectReceipt): string {
  const effect = receipt.effectReceipt as { writingStyle?: unknown } | undefined
  const payload = receipt.payload as { writingStyle?: unknown } | undefined
  const value = receipt.state === 'committed' ? effect?.writingStyle : payload?.writingStyle
  if (typeof value !== 'string' || !value.trim()) throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
  return value
}

function receiptHandle(receipt: ImportRunEffectReceipt): MainGenerationRunHandle | null {
  const value = (receipt.payload as { generationRunHandle?: unknown }).generationRunHandle
  return value && typeof value === 'object' ? value as MainGenerationRunHandle : null
}

function fallbackFinalized(db: ProjectRuntime['database']): {
  samples: string[]
  selectedFinalizedDraftIds: number[]
  authorInputs: { id: string; text: string }[]
  maxChapter: number
} {
  const maxChapter = Number(db.prepare("SELECT MAX(chapter_number) FROM drafts WHERE status='finalized'").pluck().get() ?? 0)
  if (!Number.isSafeInteger(maxChapter) || maxChapter <= 0) return { samples: [], selectedFinalizedDraftIds: [], authorInputs: [], maxChapter: 0 }
  const rows = db.prepare(`
    SELECT d.id,d.chapter_number,c.body,o.finalization_id,o.chapter_number AS receipt_chapter,
           o.content_hash,o.content_snapshot,o.content_revision
    FROM drafts d
    JOIN contents c ON c.id=d.content_id
    LEFT JOIN finalization_outbox o ON o.draft_id=d.id
    WHERE d.status='finalized' AND d.chapter_number BETWEEN ? AND ?
    ORDER BY d.chapter_number DESC,d.version DESC,d.id DESC
  `).all(Math.max(1, maxChapter - 4), maxChapter) as {
    id: number; chapter_number: number; body: string; finalization_id: string | null; receipt_chapter: number | null
    content_hash: string | null; content_snapshot: string | null; content_revision: number | null
  }[]
  const latest = new Map<number, typeof rows[number]>()
  for (const row of rows) if (!latest.has(row.chapter_number)) latest.set(row.chapter_number, row)
  const selected: typeof rows = []
  for (let chapter = maxChapter; chapter >= Math.max(1, maxChapter - 4); chapter--) {
    const row = latest.get(chapter)
    if (!row || typeof row.body !== 'string' || !row.body.trim()) continue
    if (!row.finalization_id || row.receipt_chapter !== chapter || row.content_snapshot !== row.body
      || row.content_hash !== sha256(row.body) || !Number.isSafeInteger(row.content_revision) || row.content_revision! < 1) {
      throw new Error('GENERATION_FINALIZED_SOURCE_NOT_CURRENT')
    }
    selected.push(row)
  }
  return {
    samples: selected.map(row => row.body.trim().slice(0, 2000)),
    selectedFinalizedDraftIds: selected.map(row => row.id),
    authorInputs: selected.map(row => ({ id: `style:finalized:${row.chapter_number}:${row.id}`, text: row.body })),
    maxChapter,
  }
}

function boundFinalizedSamples(runtime: ProjectRuntime, handle: MainGenerationRunHandle, assertSources: () => void): string[] {
  assertSources()
  const encoded = runtime.database.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(handle.runId)
  if (typeof encoded !== 'string') throw new Error('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
  const binding = JSON.parse(encoded) as { sourceManifest?: { selectedFinalizedDraftIds?: unknown } }
  const ids = binding.sourceManifest?.selectedFinalizedDraftIds
  if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
  if (!ids.length) return []
  const marks = ids.map(() => '?').join(',')
  const rows = runtime.database.prepare(`SELECT d.id,d.chapter_number,c.body,o.finalization_id,o.chapter_number AS receipt_chapter,
      o.content_hash,o.content_snapshot,o.content_revision
    FROM drafts d JOIN contents c ON c.id=d.content_id LEFT JOIN finalization_outbox o ON o.draft_id=d.id
    WHERE d.id IN (${marks})`).all(...ids) as {
      id: number; chapter_number: number; body: string; finalization_id: string | null; receipt_chapter: number | null
      content_hash: string | null; content_snapshot: string | null; content_revision: number | null
    }[]
  const byId = new Map(rows.map(row => [row.id, row]))
  return ids.map(id => {
    const row = byId.get(id as number)
    if (!row || !row.finalization_id || row.receipt_chapter !== row.chapter_number || row.content_snapshot !== row.body
      || row.content_hash !== sha256(row.body) || !Number.isSafeInteger(row.content_revision) || row.content_revision! < 1) {
      throw new Error('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    }
    return row.body.trim().slice(0, 2000)
  }).filter(Boolean)
}

export async function executeReferenceStyle({ runtime, owner, viewEpoch, request, signal, assertCurrent, hooks }: Options): Promise<ReferenceStyleResult> {
  const context = { database: runtime.database, canonicalRoot: runtime.canonicalRoot, projectId: runtime.projectId }
  const slot = STYLE_SLOT(request.runId)
  let execution: ImportRunExecutionLease
  let executionCaptured = false
  let locale: ImportRunLocale = 'en-US'
  let handle: MainGenerationRunHandle | null = null
  let modelId: string | null = request.modelId
  let committed = false
  let terminalWritten = false
  let currentOperation: Promise<unknown> | undefined
  let monitorTimer: ReturnType<typeof setTimeout> | undefined
  let monitorStopped = false
  let interrupted: ReferenceStyleFailure | undefined
  let notifyInterrupted!: (error: ReferenceStyleFailure) => void
  const interruption = new Promise<never>((_resolve, reject) => { notifyInterrupted = reject })
  void interruption.catch(() => undefined)

  const stopWith = (error: ReferenceStyleFailure) => {
    if (interrupted) return
    interrupted = error
    notifyInterrupted(error)
    if (handle) {
      try { void owner.cancel(handle) } catch { /* The captured generation may already be terminal or stale. */ }
    }
  }
  const interruptible = async <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, interruption])
  const assertResources = () => {
    assertCurrent()
    if (signal.aborted) throw new Error('GENERATION_ACTION_CANCELLED')
  }
  const assertAuthorityCurrent = () => {
    const row = readRunLease(runtime, request.runId)
    if (row.execution_owner !== execution.owner || row.execution_epoch !== execution.epoch) throw new Error('IMPORT_RUN_EXECUTION_STALE')
    if (row.status !== 'running' || row.stage !== 'style' || row.purpose !== 'reference') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    if (row.cancel_requested) throw new Error('IMPORT_RUN_CANCELLED')
  }
  const check = () => {
    if (monitorStopped) return
    if (signal.aborted) {
      stopWith(new ReferenceStyleFailure('GENERATION_ACTION_CANCELLED', hooks.failureMessage('GENERATION_ACTION_CANCELLED', locale)))
      return
    }
    try {
      assertResources()
      assertAuthorityCurrent()
      if (execution.expiresAt - Date.now() <= Math.floor(HEARTBEAT_MAX_MS / 3)) {
        execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
      }
    } catch (error) {
      const code = failureCode(error)
      stopWith(new ReferenceStyleFailure(code, hooks.failureMessage(code, locale)))
      return
    }
    monitorTimer = setTimeout(check, LEASE_POLL_MS)
  }

  const settleOperation = async (operation: Promise<unknown>) => {
    const settled = await operation.then(value => ({ value }), error => ({ error }))
    await owner.whenPhysicalIdle()
    if ('error' in settled) throw settled.error
    const result = settled.value as { outcome?: { receipt?: { failureCode?: unknown } } }
    const code = attemptFailureCode(result.outcome?.receipt?.failureCode)
    if (code) throw new ReferenceStyleFailure(code, hooks.failureMessage(code, locale))
    return settled.value
  }

  const settleFailure = (error: unknown) => {
    const current = runtime.database.prepare(`SELECT execution_owner,execution_epoch,status,stage
      FROM import_runs WHERE id=?`).get(request.runId) as { execution_owner: string; execution_epoch: number; status: string; stage: string } | undefined
    if (!current || current.execution_owner !== execution.owner || current.execution_epoch !== execution.epoch
      || current.status !== 'running' || current.stage !== 'style') return
    const code = failureCode(error)
    const cancel = error instanceof ReferenceStyleFailure
      ? error.errorCode === 'GENERATION_ACTION_CANCELLED' || error.errorCode === 'IMPORT_RUN_CANCELLED'
      : code === 'GENERATION_ACTION_CANCELLED' || code === 'IMPORT_RUN_CANCELLED'
    if (cancel) {
      return ImportRunRepository.cancelAtBoundary(request.runId, execution, context)
    } else {
      const display = error instanceof ReferenceStyleFailure ? error.displayMessage : hooks.failureMessage(code, locale)
      return ImportRunRepository.fail(request.runId, 'style', display, execution, context)
    }
  }

  try {
    assertResources()
    const row = readRunLease(runtime, request.runId)
    locale = row.locale
    const existingReceipt = ImportRunRepository.getEffectReceipt(request.runId, 'style', 'done', context)
    if (existingReceipt?.state === 'committed' && row.purpose === 'reference'
      && row.status === 'completed' && row.stage === 'completed') {
      handle = receiptHandle(existingReceipt)
      const run = ImportRunRepository.get(request.runId, context)
      if (!run) throw new Error('IMPORT_RUN_NOT_FOUND')
      committed = true
      return { version: 1, run, execution: null, savedWritingStyle: receiptStyle(existingReceipt), handle, modelId: null, replayed: true }
    }
    if (existingReceipt?.state === 'committed' && ['blueprints', 'refresh'].includes(row.stage)) {
      assertRequestExecution(row, request)
      if (row.status !== 'running' || row.lease_expires_at <= Date.now()) {
        throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
      }
      handle = receiptHandle(existingReceipt)
      const run = ImportRunRepository.get(request.runId, context)
      if (!run) throw new Error('IMPORT_RUN_NOT_FOUND')
      execution = { owner: row.execution_owner, epoch: row.execution_epoch, expiresAt: row.lease_expires_at }
      const replayedStyle = receiptStyle(existingReceipt)
      committed = true
      hooks.committed(replayedStyle)
      return { version: 1, run, execution, savedWritingStyle: replayedStyle, handle, modelId: null, replayed: true }
    }
    assertRequestExecution(row, request)
    if (row.stage !== 'style' || row.status !== 'running') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    execution = ImportRunRepository.renewExecution(request.runId, {
      owner: row.execution_owner, epoch: row.execution_epoch, expiresAt: row.lease_expires_at,
    }, Date.now(), undefined, context)
    executionCaptured = true
    monitorTimer = setTimeout(check, LEASE_POLL_MS)

    let savedWritingStyle: string | undefined
    if (existingReceipt?.state === 'committed') {
      savedWritingStyle = receiptStyle(existingReceipt)
      handle = receiptHandle(existingReceipt)
      committed = true
    } else if (existingReceipt?.state === 'prepared') {
      handle = receiptHandle(existingReceipt)
      if (!handle) throw new Error('GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED')
      owner.assertImportGenerationSources(handle, slot)
      execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
      const committedReceipt = ImportRunRepository.commitEffectReceipt(request.runId, 'style', 'done', execution,
        Date.now(), owner.assertImportGenerationSources, context)
      savedWritingStyle = receiptStyle(committedReceipt.receipt)
      committed = true
      hooks.committed(savedWritingStyle)
    } else if (existingReceipt?.state === 'unknown') {
      throw new Error('IMPORT_RUN_EFFECT_HISTORY_UNKNOWN')
    } else {
      let recovery = owner.readImportGeneration(slot)
      let fallbackSamples: string[] | undefined
      if (!recovery) {
        const created = runtime.database.transaction(() => {
          const imported = ImportRunRepository.listRepresentativeChapters(request.runId, context)
          const importedOptions = { chapters: imported.map(chapter => ({ number: chapter.number, title: chapter.title, content: chapter.content })) }
          const writingLanguage = ProjectCoreRepository.get(runtime.database)?.writingLanguage ?? 'zh-CN'
          const importedSamples = collectImportStyleSamples(importedOptions, writingLanguage)
          let fallback: ReturnType<typeof fallbackFinalized> | undefined
          let fallbackReadFailed = false
          if (!importedSamples.length) {
            try { fallback = fallbackFinalized(runtime.database) }
            catch { fallbackReadFailed = true }
          }
          if (fallbackReadFailed) return { recovery: null, importedCount: 0, fallbackCount: 0,
            fallbackSamples: undefined, noFinalized: false, fallbackReadFailed: true }
          const samples = importedSamples.length ? importedSamples : fallback!.samples
          if (!samples.length) return { recovery: null, importedCount: importedSamples.length, fallbackCount: fallback?.samples.length ?? 0,
            fallbackSamples: undefined, noFinalized: fallback?.maxChapter === 0, fallbackReadFailed: false }
          const authorInputs = importedSamples.length ? collectImportStyleAuthorInputs(importedOptions) : fallback!.authorInputs
          const selectedFinalizedDraftIds = importedSamples.length ? [] : fallback!.selectedFinalizedDraftIds
          const rootRecovery = owner.readImportGeneration({ runId: request.runId, stage: 'global', batchId: 'done' })
          const selectedModelId = request.modelId ?? rootRecovery?.modelId
          if (!selectedModelId) throw new Error('GENERATION_IMPORT_MODEL_CHANGED')
          if (rootRecovery) {
            const budget = new GenerationRunRepository(() => runtime.database).budget(rootRecovery.view.handle.rootActionId)
            if (rootBudgetExhausted(budget.policy, budget.attempts, budget.activeElapsedMs, budget.auxiliaryRequestCount)) {
              throw new Error('ROOT_BUDGET_EXHAUSTED')
            }
          }
          const view = owner.begin({ operation: 'analyze-writing-style', uiActionNonce: `style:${request.runId}`,
            modelId: selectedModelId, selectedDraftIds: [], selectedFinalizedDraftIds, promptKeys: ['analyze_writing_style'],
            skillStages: [], authorInputs, output: 'visible-text', importSlot: slot, importExecution: request.execution,
            ...(rootRecovery ? { parentRootActionId: rootRecovery.view.handle.rootActionId } : {}),
          } as BeginGenerationRequest)
          const started = owner.readImportGeneration(slot, view.handle.runId)
          if (!started) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
          return { recovery: { ...started, view }, importedCount: importedSamples.length, fallbackCount: fallback?.samples.length ?? 0,
            fallbackSamples: importedSamples.length ? undefined : samples, noFinalized: false, fallbackReadFailed: false }
        }).immediate()
        fallbackSamples = created.fallbackSamples
        if (created.fallbackReadFailed) {
          hooks.log('sampling-finalized')
          hooks.log('read-finalized-failed')
          throw noStyleFailure(locale)
        }
        if (created.importedCount) hooks.log('imported-samples', created.importedCount)
        else {
          hooks.log('sampling-finalized')
          if (created.noFinalized) hooks.log('no-finalized')
          else hooks.log('sampled-finalized', created.fallbackCount)
        }
        if (!created.recovery) {
          if (!created.noFinalized) hooks.log('empty-samples')
          throw noStyleFailure(locale)
        }
        recovery = created.recovery
      } else if (recovery.view.handle.epoch !== viewEpoch) {
        const resumed = await owner.resume(recovery.view.handle)
        recovery = { ...recovery, view: resumed }
      }

      handle = recovery.view.handle
      modelId = recovery.modelId
      const frozen = recovery.frozenContext
      const importedSamples = collectImportStyleSamples({ chapters: frozen.chapters }, frozen.core.writingLanguage)
      const selectedSamples = importedSamples.length ? importedSamples
        : fallbackSamples ?? boundFinalizedSamples(runtime, handle, () => owner.assertImportGenerationSources(handle!, slot))
      if (!selectedSamples.length) {
        hooks.log('empty-samples')
        throw noStyleFailure(locale)
      }
      const material = buildImportStyleMaterial(frozen.prompts.analyze_writing_style, selectedSamples, frozen.core.writingLanguage)
      await interruptible(hooks.opened({ handle, modelId }))
      hooks.log('calling-ai')
      hooks.progress(10)
      const operation = owner.executeImportGeneration({ handle, ordinal: 0, task: material.task, execution: request.execution })
      currentOperation = operation
      let generated: Awaited<typeof operation>
      try {
        generated = await interruptible(operation)
      } catch (error) {
        if (interrupted) {
          try { owner.cancel(handle) } catch { /* Drain the captured attempt before terminal bookkeeping. */ }
          try { await settleOperation(operation) } catch (drainError) {
            if (failureCode(drainError) !== 'GENERATION_ACTION_CANCELLED' && failureCode(drainError) !== 'IMPORT_RUN_CANCELLED') throw drainError
          }
          throw error
        }
        throw error
      }
      await owner.whenPhysicalIdle()
      currentOperation = undefined
      if (generated.outcome.receipt.promptBudget) hooks.promptBudget(generated.outcome.receipt.promptBudget)
      const attemptFailure = attemptFailureCode(generated.outcome.receipt.failureCode)
      if (attemptFailure) throw new ReferenceStyleFailure(attemptFailure, hooks.failureMessage(attemptFailure, locale))
      if (generated.outcome.status !== 'completed' || generated.outcome.finishReason !== 'stop') {
        const reason = generated.outcome.finishReason
        throw createBoundedCompletionError(reason, locale)
      }
      const writingStyle = stripDraftThinkingTags(generated.outcome.content).trim()
      if (!writingStyle) {
        hooks.log('empty-result')
        throw noStyleFailure(locale)
      }
      owner.assertImportGenerationSources(handle, slot)
      await interruptible(hooks.commitReady(handle, writingStyle))
      hooks.progress(90)
      execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
      owner.assertImportGenerationSources(handle, slot)
      const requestEffect = { runId: request.runId, stage: 'style' as const, batchId: 'done', effectKey: 'writing-style',
        kind: 'project-writing-style' as const, payload: { writingStyle, generationRunHandle: handle } }
      ImportRunRepository.prepareEffectReceipt(requestEffect, execution, Date.now(), owner.assertImportGenerationSources, context)
      const committedEffect = ImportRunRepository.commitEffectReceipt(request.runId, 'style', 'done', execution,
        Date.now(), owner.assertImportGenerationSources, context)
      savedWritingStyle = receiptStyle(committedEffect.receipt)
      committed = true
      hooks.committed(savedWritingStyle)
      hooks.log('saved')
    }

    if (!savedWritingStyle) throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
    assertResources()
    execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
    const latest = ImportRunRepository.get(request.runId, context)
    const run = latest?.stage === 'style'
      ? ImportRunRepository.advanceStage(request.runId, 'style', 'blueprints', execution, context)
      : latest && ['blueprints', 'author-publish', 'author-postprocess', 'refresh', 'completed'].includes(latest.stage)
        ? latest : (() => { throw new Error('IMPORT_RUN_STAGE_MISMATCH') })()
    hooks.progress(100)
    return { version: 1, run, execution, savedWritingStyle, handle, modelId, replayed: Boolean(existingReceipt) }
  } catch (error) {
    let primaryError: unknown = error
    if (currentOperation) {
      try { await settleOperation(currentOperation) } catch (drainError) {
        if (!interrupted && failureCode(drainError) !== 'GENERATION_ACTION_CANCELLED' && failureCode(drainError) !== 'IMPORT_RUN_CANCELLED') primaryError = drainError
      }
    } else if (handle) {
      try { await owner.whenPhysicalIdle() } catch { /* Preserve the operation failure. */ }
    }
    if (executionCaptured && !committed && !terminalWritten) {
      try { settleFailure(primaryError); terminalWritten = true }
      catch (terminalError) {
        if (failureCode(terminalError) !== 'IMPORT_RUN_EXECUTION_STALE') {
          const failure = primaryError instanceof ReferenceStyleFailure ? primaryError : new ReferenceStyleFailure(
            failureCode(primaryError), hooks.failureMessage(failureCode(primaryError), locale!))
          failure.secondaryErrors.push(failureCode(terminalError))
          primaryError = failure
        }
      }
    }
    if (primaryError instanceof ReferenceStyleFailure) throw primaryError
    const code = failureCode(primaryError)
    throw new ReferenceStyleFailure(code, hooks.failureMessage(code, locale!))
  } finally {
    monitorStopped = true
    if (monitorTimer) clearTimeout(monitorTimer)
    if (currentOperation) {
      try { await settleOperation(currentOperation) } catch { /* The terminal path already retained its primary error. */ }
    }
    if (handle) {
      try { await owner.whenPhysicalIdle() } catch { /* Physical drain errors are reported by the operation path. */ }
    }
  }
}

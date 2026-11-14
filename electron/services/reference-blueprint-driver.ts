import { displayedErrorMessage, englishWithReason, importGenerationStopMessage, knownAppErrorMessage } from '../../src/i18n/app-errors'
import { TerminalProviderFailureError, throwIfTerminalProviderFailure, type GenerationAttemptReceipt, type GenerationSession, type GenerationTask, type PromptBudgetReport } from '../../src/services/generation/generation-harness'
import { BoundedCompletionFailure } from '../../src/services/workflows/bounded-completion'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../../src/services/workflows/structured-batch-executor'
import { injectWritingSkillPrompt } from '../../src/shared/writing-skill-task'
import { buildImportBlueprintTask } from '../../src/shared/import-blueprint-materials'
import { parseBlueprintSemanticResponseText, validateBlueprintSemanticItem } from '../../src/shared/blueprint-semantic-contract'
import { StructuredContractDiagnostic } from '../../src/shared/structured-contract-diagnostic'
import { isWorkflowCancellation } from '../../src/services/workflows/workflow-cancellation'
import { createImportRunChapterBatchCheckpointId, parseImportRunChapterBatchCheckpointId } from '../../src/shared/import-run'
import type { ImportRunEffectReceipt, ImportRunExecutionLease, ImportRunLocale, ImportRunChapterSnapshot } from '../../src/shared/import-run'
import type { ImportGenerationSlot } from '../../src/shared/import-generation'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { WritingLanguage } from '../../src/shared/writing-language'
import type { BlueprintData, BlueprintRangeCommitReceipt, BlueprintRangeCommitRequest, BlueprintCharacterSyncCompletionReceipt } from '../repositories/blueprint-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { GenerationRunRepository } from '../repositories/generation-run-repository'
import { rootBudgetExhausted } from '../../src/shared/generation-contract'
import type { ProjectRuntime } from './project-runtime'
import type { ReferenceBlueprintLog, ReferenceBlueprintRequest, ReferenceBlueprintResult } from '../../src/shared/reference-blueprint-contract'
import type { BeginGenerationRequest } from '../../src/shared/generation-owner-contract'
import type { createMainGenerationOwner } from './main-generation-owner'

type Owner = ReturnType<typeof createMainGenerationOwner>
type Hooks = {
  opened(value: { batchId: string; handle: MainGenerationRunHandle; modelId: string }): Promise<void>
  rangeCommitted(batchId: string): void
  rangeSynced(batchId: string): void
  log(value: ReferenceBlueprintLog): void
  progress(value: number): void
  promptBudget(report: PromptBudgetReport): void
  failureMessage(code: string, locale: ImportRunLocale): string
}
type Options = {
  runtime: ProjectRuntime
  owner: Owner
  viewEpoch: string
  request: ReferenceBlueprintRequest
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
type BlueprintRangePayload = Omit<BlueprintRangeCommitRequest, 'generationRunHandle'> & { generationRunHandle: MainGenerationRunHandle }

export class ReferenceBlueprintFailure extends Error {
  readonly secondaryErrors: string[] = []

  constructor(readonly errorCode: string, readonly displayMessage: string, readonly postCommitSyncBatchId?: string) {
    super(errorCode)
    this.name = 'ReferenceBlueprintFailure'
  }
}

const PAGE_SIZE = 100
const MAX_RANGE = 5
const HEARTBEAT_MAX_MS = 60_000
const LEASE_POLL_MS = 25
const ATTEMPT_FAILURE_CODES = ['GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', 'GENERATION_CONTEXT_LENGTH_EXCEEDED',
  'ROOT_BUDGET_EXHAUSTED', 'GENERATION_STORAGE_FAILED'] as const satisfies readonly NonNullable<GenerationAttemptReceipt['failureCode']>[]
const INTERNAL_FAILURE_CODES = new Set([
  'GENERATION_ACTION_CANCELLED', 'GENERATION_IMPORT_CONTEXT_CHANGED', 'GENERATION_IMPORT_CONTEXT_REQUIRED',
  'GENERATION_IMPORT_CONTENT_CHANGED', 'GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED', 'GENERATION_IMPORT_EFFECT_SEALED',
  'GENERATION_IMPORT_EFFECT_SOURCE_CHANGED', 'GENERATION_IMPORT_EXECUTION_REQUIRED', 'GENERATION_IMPORT_EXECUTION_STALE',
  'GENERATION_IMPORT_MODEL_CHANGED', 'GENERATION_IMPORT_ORDINAL_GAP', 'GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE',
  'GENERATION_IMPORT_PREVIOUS_EFFECT_REQUIRED', 'GENERATION_IMPORT_ROOT_CHANGED', 'GENERATION_IMPORT_SLOT_AMBIGUOUS',
  'GENERATION_IMPORT_SLOT_REQUIRED', 'GENERATION_IMPORT_STAGE_INVALID', 'GENERATION_MODEL_REQUIRED',
  'GENERATION_FINALIZED_SOURCE_NOT_CURRENT', 'GENERATION_IMPORT_TASK_INVALID', 'GENERATION_REQUEST_FAILED',
  'IMPORT_RUN_CANCELLED', 'IMPORT_RUN_EFFECT_HANDLE_REQUIRED', 'IMPORT_RUN_EFFECT_HISTORY_UNKNOWN',
  'IMPORT_RUN_EXECUTION_STALE', 'IMPORT_RUN_NOT_FOUND', 'IMPORT_RUN_RECEIPT_CONFLICT',
  'IMPORT_RUN_RECEIPT_PAYLOAD_INVALID', 'IMPORT_RUN_STAGE_MISMATCH', 'IMPORT_RUN_STAGE_INCOMPLETE',
  'IMPORT_RUN_CHECKPOINT_CORRUPT', 'IMPORT_RUN_EFFECT_HISTORY_UNKNOWN', 'IMPORT_RUN_EFFECT_LEDGER_MISMATCH',
  'IMPORT_RUN_STATE_CONFLICT', 'IMPORT_RUN_REFERENCE_UNBOUND', 'IMPORT_RUN_GRANT_SCOPE_INVALID',
  'IMPORT_RUN_EXECUTION_REQUIRED', 'IMPORT_RUN_EXECUTION_STALE', 'IMPORT_RUN_RECEIPT_KEY_INVALID',
  'IMPORT_RUN_EFFECT_HISTORY_UNKNOWN', 'IMPORT_RUN_EFFECT_LEDGER_MISMATCH', 'IMPORT_RUN_CANCELLED',
  'BLUEPRINT_OPERATION_CONFLICT', 'BLUEPRINT_OPERATION_ID_REQUIRED', 'BLUEPRINT_RANGE_INVALID',
  'BLUEPRINT_CHARACTER_SYNC_OPERATION_MISSING', 'BLUEPRINT_CHARACTER_SYNC_READ_BACK_FAILED',
  'CHARACTER_PROPOSAL_DIRECTORY_OPERATION_REQUIRED', 'CHARACTER_PROPOSAL_SOURCE_CHANGED',
])

const SLOT = (runId: string, batchId: string): ImportGenerationSlot => ({ runId, stage: 'blueprints', batchId })
function safeFailureCode(code: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(code)
    && (knownAppErrorMessage('en-US', code) !== undefined || INTERNAL_FAILURE_CODES.has(code)
      || attemptFailureCode(code) !== undefined)
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'failureCode' in error
    && typeof error.failureCode === 'string' && safeFailureCode(error.failureCode)) return error.failureCode
  const message = error instanceof Error ? error.message : ''
  return safeFailureCode(message) ? message : 'GENERATION_REQUEST_FAILED'
}

function attemptFailureCode(value: unknown): NonNullable<GenerationAttemptReceipt['failureCode']> | undefined {
  return ATTEMPT_FAILURE_CODES.find(code => code === value)
}

function readRunLease(runtime: ProjectRuntime, runId: string): RunLeaseRow {
  const row = runtime.database.prepare(`SELECT purpose,stage,status,cancel_requested,execution_owner,execution_epoch,lease_expires_at,locale
    FROM import_runs WHERE id=?`).get(runId) as RunLeaseRow | undefined
  if (!row) throw new Error('IMPORT_RUN_NOT_FOUND')
  return row
}

function assertRequestExecution(row: RunLeaseRow, request: ReferenceBlueprintRequest): void {
  if (row.execution_owner !== request.execution.owner || row.execution_epoch !== request.execution.epoch) {
    throw new Error('IMPORT_RUN_EXECUTION_STALE')
  }
  if (row.purpose !== 'reference') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
}

function receiptHandle(receipt: ImportRunEffectReceipt): MainGenerationRunHandle | null {
  const handle = (receipt.payload as { generationRunHandle?: unknown }).generationRunHandle
  return handle && typeof handle === 'object' ? handle as MainGenerationRunHandle : null
}

function rangePayload(receipt: ImportRunEffectReceipt): BlueprintRangePayload {
  const payload = receipt.payload as Partial<BlueprintRangePayload> | null
  const range = parseImportRunChapterBatchCheckpointId(receipt.batchId)
  if (!payload || !range || payload.mode !== 'replace-range' || typeof payload.operationId !== 'string'
    || payload.operationId !== `import-blueprints-${receipt.runId}-${range.startChapter}-${range.endChapter}`
    || payload.startChapter !== range.startChapter || payload.endChapter !== range.endChapter
    || !Array.isArray(payload.blueprints) || !payload.generationRunHandle
    || payload.generationRunHandle !== receiptHandle(receipt)) throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
  return payload as BlueprintRangePayload
}

function canonicalRangeReceipt(receipt: ImportRunEffectReceipt, database: ProjectRuntime['database']): BlueprintRangeCommitReceipt {
  if (receipt.kind !== 'chapter-blueprint-range' || receipt.state !== 'committed') throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
  const payload = rangePayload(receipt)
  const canonical = BlueprintRepository.getCommittedRangeOperation(payload.operationId, database)
  if (!canonical || canonical.operationId !== payload.operationId || canonical.startChapter !== payload.startChapter
    || canonical.endChapter !== payload.endChapter || canonical.chapterNumbers.length !== payload.blueprints.length
    || canonical.snapshot.length !== payload.blueprints.length
    || canonical.chapterNumbers.some((number, index) => number !== payload.startChapter + index)) {
    throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
  }
  return canonical
}

function assertEffectHistoryKnown(runtime: ProjectRuntime, runId: string, batchId?: string): void {
  const row = batchId
    ? runtime.database.prepare(`SELECT 1 FROM import_effect_ledger WHERE run_id=? AND stage='blueprints' AND state='unknown'
        AND (batch_id=? OR batch_id LIKE '__legacy_%') LIMIT 1`).get(runId, batchId)
    : runtime.database.prepare(`SELECT 1 FROM import_effect_ledger WHERE run_id=? AND stage='blueprints'
        AND state='unknown' LIMIT 1`).get(runId)
  if (row) throw new Error('IMPORT_RUN_EFFECT_HISTORY_UNKNOWN')
}

export function readReferenceBlueprintHistory(runtime: ProjectRuntime, runId: string) {
  assertEffectHistoryKnown(runtime, runId)
  const snapshot = ImportRunRepository.get(runId, runtime)
  if (!snapshot) throw new Error('IMPORT_RUN_NOT_FOUND')
  if (snapshot.purpose !== 'reference') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
  const rows = runtime.database.prepare(`SELECT batch_id FROM import_run_receipts WHERE run_id=? AND stage='blueprints' ORDER BY rowid`)
    .all(runId) as { batch_id: string }[]
  const rawReceipts = rows.map(row => {
    if (!parseImportRunChapterBatchCheckpointId(row.batch_id)) throw new Error('IMPORT_RUN_CHECKPOINT_CORRUPT')
    assertEffectHistoryKnown(runtime, runId, row.batch_id)
    const receipt = ImportRunRepository.getEffectReceipt(runId, 'blueprints', row.batch_id, runtime)
    if (!receipt) throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
    return receipt
  })
  const byBatch = new Map(rawReceipts.map(receipt => [receipt.batchId, receipt]))
  const completedBatches = snapshot.completedBatches.blueprints ?? []
  for (const batchId of completedBatches) {
    if (!byBatch.has(batchId)) throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
  }
  const orderedReceipts = [...rawReceipts].sort((left, right) => {
    const a = parseImportRunChapterBatchCheckpointId(left.batchId)!
    const b = parseImportRunChapterBatchCheckpointId(right.batchId)!
    return a.startChapter - b.startChapter
  })
  const committedReceipts = orderedReceipts.filter(receipt => receipt.state === 'committed')
  const preparedReceipts = orderedReceipts.filter(receipt => receipt.state === 'prepared')
  if (orderedReceipts.some(receipt => receipt.state !== 'prepared' && receipt.state !== 'committed')) throw new Error('IMPORT_RUN_EFFECT_HISTORY_UNKNOWN')
  const covered = new Set<number>()
  const canonicalByBatch = new Map<string, BlueprintRangeCommitReceipt>()
  for (const receipt of committedReceipts) {
    if (!completedBatches.includes(receipt.batchId)) throw new Error('IMPORT_RUN_EFFECT_LEDGER_MISMATCH')
    const canonical = canonicalRangeReceipt(receipt, runtime.database)
    const range = parseImportRunChapterBatchCheckpointId(receipt.batchId)!
    if (range.endChapter - range.startChapter + 1 > MAX_RANGE || canonical.chapterNumbers.length !== range.endChapter - range.startChapter + 1
      || canonical.chapterNumbers.some((chapter, index) => chapter !== range.startChapter + index)) throw new Error('IMPORT_RUN_CHECKPOINT_CORRUPT')
    for (let chapter = range.startChapter; chapter <= range.endChapter; chapter++) {
      if (covered.has(chapter)) throw new Error('IMPORT_RUN_CHECKPOINT_CORRUPT')
      covered.add(chapter)
    }
    canonicalByBatch.set(receipt.batchId, canonical)
  }
  return { snapshot, orderedReceipts, committedReceipts, preparedReceipts, covered, canonicalByBatch }
}

export function assertReferenceBlueprintSkippedHistory(runtime: ProjectRuntime, runId: string): void {
  const { committedReceipts } = readReferenceBlueprintHistory(runtime, runId)
  if (!committedReceipts.length) throw new Error('IMPORT_RUN_STAGE_INCOMPLETE')
}

function importedBlueprint(item: ReturnType<typeof parseBlueprintSemanticResponseText>[number]): BlueprintData {
  return { ...item, relationshipHints: item.relationshipHints, userGuidance: '', notes: '', notesUpdatedAt: '' }
}

function splitUncovered(chapters: readonly ImportRunChapterSnapshot[], covered: ReadonlySet<number>): ImportRunChapterSnapshot[][] {
  const ranges: ImportRunChapterSnapshot[][] = []
  let current: ImportRunChapterSnapshot[] = []
  for (const chapter of chapters) {
    if (covered.has(chapter.number)) {
      if (current.length) ranges.push(current)
      current = []
      continue
    }
    if (current.length && (chapter.number !== current[current.length - 1]!.number + 1 || current.length >= MAX_RANGE)) {
      ranges.push(current)
      current = []
    }
    current.push(chapter)
  }
  if (current.length) ranges.push(current)
  return ranges
}

function postCommitSyncMessage(range: Pick<BlueprintRangeCommitReceipt, 'startChapter' | 'endChapter'>, locale: ImportRunLocale): string {
  return locale === 'zh-CN'
    ? `导入蓝图已提交（第 ${range.startChapter}–${range.endChapter} 章），但角色候选同步失败；可使用同步操作回执安全重试，无需重新生成蓝图。`
    : `Imported blueprints for Chapters ${range.startChapter}–${range.endChapter} were committed, but character-candidate synchronization failed. Retry with the synchronization receipt without regenerating the blueprints.`
}

export async function executeReferenceBlueprints({ runtime, owner, viewEpoch, request, signal, assertCurrent, hooks }: Options): Promise<ReferenceBlueprintResult> {
  const context = { database: runtime.database, canonicalRoot: runtime.canonicalRoot, projectId: runtime.projectId }
  let execution: ImportRunExecutionLease | null = null
  let executionCaptured = false
  let locale: ImportRunLocale = 'en-US'
  let handle: MainGenerationRunHandle | null = null
  let modelId: string | null = null
  let currentOperation: Promise<Awaited<ReturnType<Owner['executeImportGeneration']>>> | undefined
  let generatedAny = false
  let terminalWritten = false
  let monitorStopped = false
  let monitorTimer: ReturnType<typeof setTimeout> | undefined
  let interrupted: ReferenceBlueprintFailure | undefined
  let notifyInterrupted!: (error: ReferenceBlueprintFailure) => void
  const interruption = new Promise<never>((_resolve, reject) => { notifyInterrupted = reject })
  void interruption.catch(() => undefined)
  const localAbort = new AbortController()
  const onAbort = () => stopWith(new ReferenceBlueprintFailure('GENERATION_ACTION_CANCELLED', hooks.failureMessage('GENERATION_ACTION_CANCELLED', locale)))

  const stopWith = (error: ReferenceBlueprintFailure) => {
    if (interrupted) return
    interrupted = error
    localAbort.abort()
    notifyInterrupted(error)
    if (handle) { try { void owner.cancel(handle) } catch { /* The captured run may already be terminal or stale. */ } }
  }
  const interruptible = async <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, interruption])
  const assertResources = () => { assertCurrent(); if (signal.aborted) throw new Error('GENERATION_ACTION_CANCELLED') }
  const assertAuthorityCurrent = () => {
    const row = readRunLease(runtime, request.runId)
    if (!execution || row.execution_owner !== execution.owner || row.execution_epoch !== execution.epoch) throw new Error('IMPORT_RUN_EXECUTION_STALE')
    if (row.status !== 'running' || row.stage !== 'blueprints' || row.purpose !== 'reference') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    if (row.cancel_requested) throw new Error('IMPORT_RUN_CANCELLED')
  }
  const check = () => {
    if (monitorStopped) return
    if (signal.aborted) {
      stopWith(new ReferenceBlueprintFailure('GENERATION_ACTION_CANCELLED', hooks.failureMessage('GENERATION_ACTION_CANCELLED', locale)))
      return
    }
    try {
      assertResources()
      assertAuthorityCurrent()
      if (execution && execution.expiresAt - Date.now() <= Math.floor(HEARTBEAT_MAX_MS / 3)) {
        execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
      }
    } catch (error) {
      const code = failureCode(error)
      stopWith(new ReferenceBlueprintFailure(code, hooks.failureMessage(code, locale)))
      return
    }
    monitorTimer = setTimeout(check, LEASE_POLL_MS)
  }
  const settleOperation = async (operation: Promise<Awaited<ReturnType<Owner['executeImportGeneration']>>>) => {
    const settled = await operation.then(value => ({ value }), error => ({ error }))
    await owner.whenPhysicalIdle()
    if ('error' in settled) throw settled.error
    throwIfTerminalProviderFailure(settled.value.outcome.receipt)
    const code = attemptFailureCode(settled.value.outcome.receipt.failureCode)
    if (code) {
      if (settled.value.outcome.receipt.promptBudget) hooks.promptBudget(settled.value.outcome.receipt.promptBudget)
      throw new ReferenceBlueprintFailure(code, hooks.failureMessage(code, locale))
    }
    return settled.value
  }
  const settleFailure = (error: unknown) => {
    if (!execution) return
    const current = runtime.database.prepare('SELECT execution_owner,execution_epoch,status,stage FROM import_runs WHERE id=?').get(request.runId) as
      { execution_owner: string; execution_epoch: number; status: string; stage: string } | undefined
    if (!current || current.execution_owner !== execution.owner || current.execution_epoch !== execution.epoch
      || current.status !== 'running' || current.stage !== 'blueprints') return
    const code = failureCode(error)
    if (code === 'GENERATION_ACTION_CANCELLED' || code === 'IMPORT_RUN_CANCELLED') return ImportRunRepository.cancelAtBoundary(request.runId, execution, context)
    const display = error instanceof ReferenceBlueprintFailure ? error.displayMessage : hooks.failureMessage(code, locale)
    return ImportRunRepository.fail(request.runId, 'blueprints', display, execution, context)
  }

  const dispatch = async (task: GenerationTask, ordinalRef: { value: number }, writingLanguage: WritingLanguage) => {
    assertResources()
    assertAuthorityCurrent()
    const ordinal = ordinalRef.value
    const priorRow = runtime.database.prepare(`SELECT usage_receipt_json FROM generation_attempts WHERE run_id=? AND invocation_nonce=?`)
      .get(handle!.runId, `import:${ordinal}`) as { usage_receipt_json: string } | undefined
    let actualTask = task
    if (priorRow) {
      const usage = JSON.parse(priorRow.usage_receipt_json) as { replayTask?: GenerationTask }
      if (!usage.replayTask) throw new Error('GENERATION_IMPORT_TASK_INVALID')
      actualTask = usage.replayTask
    } else {
      const skill = owner.readImportPlanningSkill(handle!)
      actualTask = injectWritingSkillPrompt(task, writingLanguage, skill).task
    }
    if (!execution) throw new Error('IMPORT_RUN_EXECUTION_STALE')
    const operation = owner.executeImportGeneration({ handle: handle!, ordinal, task: actualTask, execution: request.execution })
    currentOperation = operation
    const advanceOrdinalIfRecorded = () => {
      const recorded = runtime.database.prepare('SELECT 1 FROM generation_attempts WHERE run_id=? AND invocation_nonce=?')
        .get(handle!.runId, `import:${ordinal}`)
      if (recorded) ordinalRef.value = ordinal + 1
    }
    let generated: Awaited<typeof operation>
    try {
      generated = await interruptible(operation)
    } catch (error) {
      let primaryError: unknown = error
      if (interrupted) {
        try { owner.cancel(handle!) } catch { /* Drain before terminal bookkeeping. */ }
      }
      try { await settleOperation(operation) } catch (drainError) {
        const hardCode = attemptFailureCode((drainError as { failureCode?: unknown }).failureCode)
          ?? attemptFailureCode((drainError as { outcome?: { receipt?: { failureCode?: unknown } } }).outcome?.receipt?.failureCode)
          ?? attemptFailureCode((drainError as { receipt?: { failureCode?: unknown } }).receipt?.failureCode)
          ?? attemptFailureCode(failureCode(drainError))
        const drainCode = failureCode(drainError)
        if (drainError instanceof TerminalProviderFailureError) primaryError = drainError
        else if (hardCode) primaryError = new ReferenceBlueprintFailure(hardCode, hooks.failureMessage(hardCode, locale))
        else if (!interrupted || drainCode !== 'GENERATION_ACTION_CANCELLED' && drainCode !== 'IMPORT_RUN_CANCELLED') primaryError = drainError
      } finally {
        advanceOrdinalIfRecorded()
        currentOperation = undefined
      }
      throw primaryError
    }
    try { await owner.whenPhysicalIdle() }
    finally {
      advanceOrdinalIfRecorded()
      currentOperation = undefined
    }
    throwIfTerminalProviderFailure(generated.outcome.receipt)
    const code = attemptFailureCode(generated.outcome.receipt.failureCode)
    if (interrupted && code) {
      if (generated.outcome.receipt.promptBudget) hooks.promptBudget(generated.outcome.receipt.promptBudget)
      throw new ReferenceBlueprintFailure(code, hooks.failureMessage(code, locale))
    }
    return generated.outcome
  }

  const syncRange = async (range: BlueprintRangeCommitReceipt) => {
    const operation = BlueprintRepository.getCharacterSyncOperation(range.characterSyncOperation.operationId, runtime.database)
    if (!operation || operation.blueprintCommitOperationId !== range.operationId
      || operation.blueprintCommitPayloadHash !== range.payloadHash) throw new Error('BLUEPRINT_CHARACTER_SYNC_OPERATION_MISSING')
    if (operation.status === 'completed') {
      if (!operation.completionReceipt) throw new Error('BLUEPRINT_CHARACTER_SYNC_READ_BACK_FAILED')
      return operation.completionReceipt
    }
    assertResources()
    assertAuthorityCurrent()
    await owner.characterProposals.stage({ kind: 'directory', operationId: operation.operationId })
    assertResources()
    assertAuthorityCurrent()
    const completed = BlueprintRepository.completeCharacterSyncOperation(operation.operationId, runtime.database)
    if (completed.status !== 'completed' || !completed.completionReceipt) throw new Error('BLUEPRINT_CHARACTER_SYNC_READ_BACK_FAILED')
    return completed.completionReceipt as BlueprintCharacterSyncCompletionReceipt
  }

  try {
    const runRow = readRunLease(runtime, request.runId)
    locale = runRow.locale
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    assertResources()
    const { snapshot, orderedReceipts, committedReceipts, preparedReceipts, covered, canonicalByBatch } = readReferenceBlueprintHistory(runtime, request.runId)

    if (runRow.status === 'completed' && runRow.stage === 'completed') {
      const last = [...committedReceipts].at(-1)
      if (!last) throw new Error('IMPORT_RUN_STAGE_INCOMPLETE')
      return { version: 1, run: snapshot, execution: null, receipt: last, handle: receiptHandle(last), modelId: null, replayed: true }
    }
    assertRequestExecution(runRow, request)
    if (runRow.status !== 'running') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    execution = { owner: runRow.execution_owner, epoch: runRow.execution_epoch, expiresAt: runRow.lease_expires_at }

    const lastCommittedReceipt = committedReceipts.at(-1)
    if (runRow.stage !== 'blueprints') {
      if (runRow.lease_expires_at <= Date.now() || !lastCommittedReceipt) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
      const run = ImportRunRepository.get(request.runId, context)
      if (!run) throw new Error('IMPORT_RUN_NOT_FOUND')
      return { version: 1, run, execution, receipt: lastCommittedReceipt, handle: receiptHandle(lastCommittedReceipt), modelId: null, replayed: true }
    }
    if (runRow.lease_expires_at <= Date.now()) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')

    execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
    executionCaptured = true
    monitorTimer = setTimeout(check, LEASE_POLL_MS)

    let visited = 0
    const projectProgress = () => hooks.progress(Math.min(99, Math.round((visited / Math.max(snapshot.totalChapters, 1)) * 100)))
    let latestReceipt = lastCommittedReceipt ?? null
    let latestHandle = latestReceipt ? receiptHandle(latestReceipt) : null
    let latestModelId: string | null = null
    let latestEnd = latestReceipt ? parseImportRunChapterBatchCheckpointId(latestReceipt.batchId)!.endChapter : 0
    const inheritedHandles = orderedReceipts.map(receiptHandle).filter((value): value is MainGenerationRunHandle => value !== null)
    const rootRecovery = owner.readImportGeneration({ runId: request.runId, stage: 'global', batchId: 'done' })
    const styleRecovery = owner.readImportGeneration({ runId: request.runId, stage: 'style', batchId: 'done' })
    const preparedHandle = preparedReceipts.length ? rangePayload(preparedReceipts[0]!).generationRunHandle : null
    const preparedSlot = preparedHandle ? SLOT(request.runId, preparedReceipts[0]!.batchId) : null
    const preparedRecovery = preparedHandle && preparedSlot ? owner.readImportGeneration(preparedSlot, preparedHandle.runId) : null
    const preparedRun = preparedHandle ? new GenerationRunRepository(() => runtime.database).get(preparedHandle.runId) : null
    const preparedModel = preparedRecovery?.modelId ?? (preparedRun?.binding.sourceManifest.modelReceipt as { modelId?: unknown } | undefined)?.modelId
    let existingRootHandle = rootRecovery?.view.handle ?? styleRecovery?.view.handle ?? inheritedHandles[0] ?? preparedRecovery?.view.handle ?? preparedHandle
    let rootModelId = rootRecovery?.modelId ?? styleRecovery?.modelId ?? (typeof preparedModel === 'string' ? preparedModel : null) ?? (latestReceipt && latestHandle
      ? owner.readImportGeneration(SLOT(request.runId, latestReceipt.batchId), latestHandle.runId)?.modelId
      : null) ?? request.modelId

    for (const receipt of committedReceipts) {
      assertResources()
      assertAuthorityCurrent()
      const canonical = canonicalByBatch.get(receipt.batchId)!
      const completed = await syncRange(canonical)
      void completed
      visited += canonical.chapterNumbers.length
      if (receipt === lastCommittedReceipt) {
        latestReceipt = receipt
        latestHandle = receiptHandle(receipt)
        latestModelId = owner.readImportGeneration(SLOT(request.runId, receipt.batchId), latestHandle?.runId)?.modelId ?? null
      }
      projectProgress()
    }

    for (const receipt of preparedReceipts) {
      assertResources()
      assertAuthorityCurrent()
      const payload = rangePayload(receipt)
      const slot = SLOT(request.runId, receipt.batchId)
      const recoveredHandle = payload.generationRunHandle
      const recovery = owner.readImportGeneration(slot, recoveredHandle.runId)
      handle = recoveredHandle
      owner.assertImportGenerationSources(handle, slot)
      execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
      const committed = ImportRunRepository.commitEffectReceipt(request.runId, 'blueprints', receipt.batchId, execution,
        Date.now(), owner.assertImportGenerationSources, context).receipt
      const canonical = canonicalRangeReceipt(committed, runtime.database)
      const syncReceipt = await syncRange(canonical)
      void syncReceipt
      const range = parseImportRunChapterBatchCheckpointId(receipt.batchId)!
      for (let chapter = range.startChapter; chapter <= range.endChapter; chapter++) covered.add(chapter)
      if (range.endChapter >= latestEnd) {
        latestEnd = range.endChapter
        latestReceipt = committed
        latestHandle = handle
        latestModelId = recovery?.modelId ?? null
      }
      visited += canonical.chapterNumbers.length
      projectProgress()
    }

    const ranges = async function* () {
      let afterChapter = 0
      let count = 0
      while (true) {
        assertResources()
        assertAuthorityCurrent()
        const page = ImportRunRepository.listChapterBatch(request.runId,
          { afterChapterNumber: afterChapter, limit: PAGE_SIZE }, context)
        if (page.length === 0) break
        count += page.length
        for (const batch of splitUncovered(page, covered)) {
          yield { batch, batchId: createImportRunChapterBatchCheckpointId(batch) }
        }
        afterChapter = page.at(-1)!.number
        if (page.length < PAGE_SIZE) break
      }
      if (count !== snapshot.totalChapters) throw new Error('IMPORT_RUN_CHECKPOINT_CORRUPT')
    }
    for await (const { batch, batchId } of ranges()) {
      assertResources()
      assertAuthorityCurrent()
      assertEffectHistoryKnown(runtime, request.runId, batchId)
      const slot = SLOT(request.runId, batchId)
      const existingReceipt = ImportRunRepository.getEffectReceipt(request.runId, 'blueprints', batchId, context)
      if (existingReceipt) throw new Error('IMPORT_RUN_RECEIPT_CONFLICT')
      let recovery = owner.readImportGeneration(slot)
      if (recovery && recovery.view.handle.epoch !== viewEpoch) {
        recovery = { ...recovery, view: await owner.resume(recovery.view.handle) }
      }
      if (!recovery) {
        if (!rootModelId) throw new Error('GENERATION_MODEL_REQUIRED')
        if (existingRootHandle) {
          const budget = new GenerationRunRepository(() => runtime.database).budget(existingRootHandle.rootActionId)
          if (rootBudgetExhausted(budget.policy, budget.attempts, budget.activeElapsedMs, budget.auxiliaryRequestCount)) {
            throw new Error('ROOT_BUDGET_EXHAUSTED')
          }
        }
        const view = owner.begin({ operation: 'import-blueprints',
          uiActionNonce: `blueprints:${request.runId}:${batchId}`, modelId: rootModelId,
          selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['infer_single_chapter_blueprint'],
          skillStages: ['planning'], authorInputs: [], output: 'structured-data', importSlot: slot,
          importExecution: request.execution, ...(existingRootHandle ? { parentRootActionId: existingRootHandle.rootActionId } : {}),
        } as BeginGenerationRequest)
        recovery = owner.readImportGeneration(slot, view.handle.runId)
        if (!recovery) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
      }
      handle = recovery.view.handle
      modelId = recovery.modelId
      if (!existingRootHandle) existingRootHandle = handle
      if (!rootModelId) rootModelId = modelId
      latestHandle = handle
      latestModelId = modelId
      await interruptible(hooks.opened({ batchId, handle, modelId }))
      owner.assertSourcesCurrent(handle)
      hooks.log({ key: 'begin', count: batch.length, estimatedCalls: Math.ceil(batch.length / MAX_RANGE) })
      hooks.progress(5)

      let activeChapterNumbers: number[] = []
      const writingLanguage = recovery.frozenContext.core.writingLanguage as WritingLanguage
      const template = recovery.frozenContext.prompts.infer_single_chapter_blueprint
      if (!template || !writingLanguage) throw new Error('GENERATION_IMPORT_CONTEXT_REQUIRED')
      const contract: StructuredBatchContract<ImportRunChapterSnapshot, BlueprintData> = {
        buildTask: ({ items, validatedPrefix }) => {
          activeChapterNumbers = items.map(item => item.number)
          hooks.log({ key: 'inferring', startChapter: activeChapterNumbers[0]!, endChapter: activeChapterNumbers.at(-1)! })
          hooks.progress(5 + Math.round((validatedPrefix.length / batch.length) * 80))
          return buildImportBlueprintTask({ template, writingLanguage, items, validatedPrefix,
            configSummary: JSON.stringify(recovery!.frozenContext.core) || '' })
        },
        inputKey: chapter => chapter.number,
        outputKey: blueprint => blueprint.chapterNumber,
        decode: content => parseBlueprintSemanticResponseText(content, activeChapterNumbers).map(importedBlueprint),
        validateItem: validateBlueprintSemanticItem,
      }
      const ordinal = { value: 0 }
      const session: Pick<GenerationSession, 'complete'> = {
        complete: async task => {
          const outcome = await dispatch(task, ordinal, writingLanguage)
          return outcome
        },
      }
      const batchResult = await createStructuredBatchExecutor({
        contract,
        session,
        writingLanguage,
        onAttempt: receipt => { if (receipt.promptBudget) hooks.promptBudget(receipt.promptBudget) },
      }).execute({ items: batch, limits: { maxBatchItems: MAX_RANGE }, signal: localAbort.signal })
      if (!batchResult.ok) {
        if (batchResult.failure.terminal) throw batchResult.failure.terminal
        const failure = batchResult.failure
        const code = failure.errorCode && safeFailureCode(failure.errorCode) ? failure.errorCode : 'GENERATION_REQUEST_FAILED'
        if (failure.code === 'invalid_output') {
          for (const candidateFailure of await discardRejected(owner, handle)) hooks.log({ key: 'discard-failed', code: candidateFailure })
        }
        if (failure.errorCode) hooks.log({ key: 'stop-reason', code })
        const reason = (failure.errorCode && importGenerationStopMessage(locale, code,
          failure.code === 'deadline', 'reference')) || displayedErrorMessage(locale, failure.message)
        const displayMessage = locale === 'zh-CN' ? `蓝图推演失败：${reason}`
          : englishWithReason(`Blueprint inference failed (${failure.reason ?? failure.code}).`, reason)
        throw new ReferenceBlueprintFailure(code, displayMessage)
      }

      assertResources()
      assertAuthorityCurrent()
      owner.assertImportGenerationSources(handle, slot)
      const rangePayload: BlueprintRangePayload = {
        mode: 'replace-range', operationId: `import-blueprints-${request.runId}-${batch[0]!.number}-${batch.at(-1)!.number}`,
        generationRunHandle: handle, startChapter: batch[0]!.number, endChapter: batch.at(-1)!.number,
        blueprints: [...batchResult.items],
      }
      execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
      const requestEffect = { runId: request.runId, stage: 'blueprints' as const, batchId,
        effectKey: `blueprints:${batchId}`, kind: 'chapter-blueprint-range' as const, payload: rangePayload }
      ImportRunRepository.prepareEffectReceipt(requestEffect, execution, Date.now(), owner.assertImportGenerationSources, context)
      const committed = ImportRunRepository.commitEffectReceipt(request.runId, 'blueprints', batchId, execution,
        Date.now(), owner.assertImportGenerationSources, context).receipt
      const canonical = canonicalRangeReceipt(committed, runtime.database)
      const committedEnd = parseImportRunChapterBatchCheckpointId(batchId)!.endChapter
      if (committedEnd >= latestEnd) {
        latestEnd = committedEnd
        latestReceipt = committed
        latestHandle = handle
        latestModelId = modelId
      }
      generatedAny = true
      hooks.rangeCommitted(batchId)
      try {
        await syncRange(canonical)
      } catch (syncError) {
        const displayMessage = postCommitSyncMessage(canonical, locale)
        const failure = new ReferenceBlueprintFailure('GENERATION_REQUEST_FAILED', displayMessage, batchId)
        const code = failureCode(syncError)
        if (code !== 'GENERATION_REQUEST_FAILED') failure.secondaryErrors.push(code)
        throw failure
      }
      hooks.rangeSynced(batchId)
      hooks.log({ key: 'complete', count: canonical.snapshot.length })
      hooks.progress(100)
      for (const chapter of canonical.chapterNumbers) covered.add(chapter)
      visited += canonical.chapterNumbers.length
      projectProgress()
    }

    assertResources()
    assertAuthorityCurrent()
    if (!latestReceipt) throw new Error('IMPORT_RUN_STAGE_INCOMPLETE')
    if (!execution) throw new Error('IMPORT_RUN_EXECUTION_STALE')
    execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
    const advanced = ImportRunRepository.advanceStage(request.runId, 'blueprints', 'refresh', execution, context)
    hooks.progress(100)
    monitorStopped = true
    return { version: 1, run: ImportRunRepository.get(request.runId, context) ?? advanced, execution,
      receipt: latestReceipt, handle: latestHandle, modelId: latestModelId, replayed: !generatedAny }
  } catch (error) {
    let primaryError: unknown = error
    if (currentOperation) {
      try { await settleOperation(currentOperation) } catch (drainError) {
        const hard = attemptFailureCode((drainError as { failureCode?: unknown }).failureCode)
          ?? attemptFailureCode((drainError as { outcome?: { receipt?: { failureCode?: unknown } } }).outcome?.receipt?.failureCode)
        const drainCode = failureCode(drainError)
        if (hard) primaryError = new ReferenceBlueprintFailure(hard, hooks.failureMessage(hard, locale))
        else if (!interrupted && drainCode !== 'GENERATION_ACTION_CANCELLED' && drainCode !== 'IMPORT_RUN_CANCELLED') primaryError = drainError
      }
    } else if (handle) {
      try { await owner.whenPhysicalIdle() } catch { /* Preserve the operation failure. */ }
    }
    if (isWorkflowCancellation(primaryError)) {
      primaryError = new ReferenceBlueprintFailure('GENERATION_ACTION_CANCELLED',
        hooks.failureMessage('GENERATION_ACTION_CANCELLED', locale))
    }
    if (executionCaptured && !terminalWritten) {
      try { settleFailure(primaryError); terminalWritten = true }
      catch (terminalError) {
        if (failureCode(terminalError) !== 'IMPORT_RUN_EXECUTION_STALE') {
          const failure = primaryError instanceof ReferenceBlueprintFailure ? primaryError : new ReferenceBlueprintFailure(
            failureCode(primaryError), hooks.failureMessage(failureCode(primaryError), locale))
          failure.secondaryErrors.push(failureCode(terminalError))
          primaryError = failure
        }
      }
    }
    if (primaryError instanceof ReferenceBlueprintFailure) throw primaryError
    if (primaryError instanceof BoundedCompletionFailure) {
      throw new ReferenceBlueprintFailure('GENERATION_REQUEST_FAILED', primaryError.message)
    }
    if (primaryError instanceof StructuredContractDiagnostic) {
      throw new ReferenceBlueprintFailure('GENERATION_REQUEST_FAILED', primaryError.message)
    }
    const code = failureCode(primaryError)
    throw new ReferenceBlueprintFailure(code, hooks.failureMessage(code, locale))
  } finally {
    monitorStopped = true
    if (monitorTimer) clearTimeout(monitorTimer)
    signal.removeEventListener('abort', onAbort)
    if (currentOperation) { try { await settleOperation(currentOperation) } catch { /* The terminal path already retained its primary error. */ } }
    if (handle) { try { await owner.whenPhysicalIdle() } catch { /* Physical work remains drained before this driver releases its flight. */ } }
  }
}

async function discardRejected(owner: Owner, handle: MainGenerationRunHandle): Promise<string[]> {
  const failures: string[] = []
  try {
    const view = owner.read(handle)
    for (const candidate of view.candidates ?? []) {
      if (candidate.status === 'running') continue
      try { owner.discardCandidate(handle, candidate.artifactId) }
      catch (error) { failures.push(failureCode(error)) }
    }
  } catch (error) { failures.push(failureCode(error)) }
  return failures
}

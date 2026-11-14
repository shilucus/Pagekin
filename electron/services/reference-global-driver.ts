import { knownAppErrorMessage } from '../../src/i18n/app-errors'
import type { PromptBudgetReport } from '../../src/services/generation/generation-harness'
import type { GenerationTask, GenerationAttemptReceipt } from '../../src/services/generation/generation-harness'
import { BoundedCompletionFailure, createBoundedCompletionError } from '../../src/services/workflows/bounded-completion'
import type { BoundedCompletionFailureCode } from '../../src/services/workflows/bounded-completion'
import { StructuredContractDiagnostic } from '../../src/shared/structured-contract-diagnostic'
import { buildImportEndpointCardTask, buildImportInferenceTask, formatImportInferenceSample, getImportInferenceTopics } from '../../src/shared/import-inference-materials'
import type { ImportInferenceTopicKey } from '../../src/shared/import-inference-materials'
import { buildStructuredSyntaxRepairTask, isRepairableDirectJsonSyntaxFailure, preservesStructuredJsonEvidence } from '../../src/services/workflows/structured-syntax-repair'
import { decodeImportInferenceJson, decodeRecoveredImportInference, importEndpointRecoveryTargets, importInferenceJsonContract, parseImportInferenceJsonObject, type ImportInferenceResult } from '../../src/services/workflows/commands/import-inference-contract'
import { injectWritingSkillPrompt } from '../../src/shared/writing-skill-task'
import { stripDraftThinkingTags } from '../../src/shared/draft-visible-text'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { ImportGenerationSlot, ImportQueryMaterialsResponse } from '../../src/shared/import-generation'
import type { ImportGlobalFactsReceipt, ImportGlobalFactsRequest } from '../../src/shared/import-global-facts'
import type { ImportRunEffectReceipt, ImportRunExecutionLease, ImportRunLocale } from '../../src/shared/import-run'
import type { ReferenceGlobalLog, ReferenceGlobalRequest, ReferenceGlobalResult } from '../../src/shared/reference-global-contract'
import { rootBudgetExhausted } from '../../src/shared/generation-contract'
import type { ImportQueryErrorCode } from './import-query-contract'
import { EmbeddingDispatchBarrierError } from './reference-embedding-dispatch-contract'
import type { EmbeddingDispatchBarrierCode } from './reference-embedding-dispatch-contract'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { GenerationRunRepository } from '../repositories/generation-run-repository'
import { CharacterRosterRepository } from '../repositories/character-roster-repository'
import type { ProjectRuntime } from './project-runtime'
import type { createMainGenerationOwner } from './main-generation-owner'

type Owner = ReturnType<typeof createMainGenerationOwner>
type Hooks = {
  opened(value: { handle: MainGenerationRunHandle; modelId: string }): Promise<void>
  committed(): void
  log(value: ReferenceGlobalLog): void
  progress(value: 5 | 10 | 20 | 25 | 70 | 90 | 100): void
  candidate(content: string): void
  promptBudget(report: PromptBudgetReport): void
  failureMessage(code: string, locale: ImportRunLocale): string
}
type Options = {
  runtime: ProjectRuntime
  owner: Owner
  viewEpoch: string
  request: ReferenceGlobalRequest
  signal: AbortSignal
  assertCurrent(): void
  hooks: Hooks
}
type RunLeaseRow = {
  purpose: string; stage: string; status: string; cancel_requested: number
  execution_owner: string; execution_epoch: number; lease_expires_at: number; locale: ImportRunLocale
}

export class ReferenceGlobalFailure extends Error {
  readonly secondaryErrors: string[] = []
  constructor(readonly errorCode: string, readonly displayMessage: string,
    readonly completionFailureCode?: BoundedCompletionFailureCode) {
    super(errorCode)
    this.name = 'ReferenceGlobalFailure'
  }
}

const SLOT = (runId: string): ImportGenerationSlot => ({ runId, stage: 'global', batchId: 'done' })
const ATTEMPT_FAILURE_CODES = ['GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', 'GENERATION_CONTEXT_LENGTH_EXCEEDED', 'ROOT_BUDGET_EXHAUSTED', 'GENERATION_STORAGE_FAILED'] as const satisfies readonly NonNullable<GenerationAttemptReceipt['failureCode']>[]
const IMPORT_QUERY_HARD_FAILURE_CODES = [
  'GENERATION_IMPORT_QUERY_REQUIRED', 'GENERATION_IMPORT_QUERY_INVALID', 'GENERATION_IMPORT_QUERY_PLAN_CONFLICT',
  'GENERATION_IMPORT_QUERY_ROOT_CHANGED', 'GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN', 'GENERATION_IMPORT_QUERY_RECEIPT_INVALID',
  'GENERATION_IMPORT_QUERY_PERSISTENCE_FAILED', 'GENERATION_IMPORT_QUERY_HISTORY_FROZEN',
  'ROOT_BUDGET_EXHAUSTED', 'GENERATION_DISPATCH_BLOCKED',
] as const satisfies readonly Exclude<ImportQueryErrorCode, 'GENERATION_ACTION_CANCELLED'>[]
const EMBEDDING_HARD_FAILURE_CODES = [
  'REFERENCE_EMBEDDING_PRIOR_DISPATCH_BLOCKED', 'REFERENCE_EMBEDDING_PREPARED_UNPROVEN',
  'REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED', 'REFERENCE_EMBEDDING_DISPATCH_INVALID',
  'REFERENCE_EMBEDDING_DISPATCH_FROZEN',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_REQUIRED', 'KNOWLEDGE_BASE_REFERENCE_BUDGET_INVALID',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_EXHAUSTED', 'KNOWLEDGE_BASE_REFERENCE_BUDGET_ACTIVE_TIME_EXHAUSTED',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_RECOVERY_UNKNOWN', 'KNOWLEDGE_BASE_REFERENCE_BUDGET_HISTORY_UNBUDGETED',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_PLAN_CONFLICT', 'KNOWLEDGE_BASE_REFERENCE_BUDGET_PERSISTENCE_FAILED',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_HISTORY_FROZEN',
] as const satisfies readonly Exclude<EmbeddingDispatchBarrierCode, ImportQueryErrorCode>[]
const QUERY_HARD_FAILURE_CODES = new Set<string>([...IMPORT_QUERY_HARD_FAILURE_CODES, ...EMBEDDING_HARD_FAILURE_CODES])
const INTERNAL_FAILURE_CODES = new Set([
  'GENERATION_ACTION_CANCELLED', 'GENERATION_IMPORT_CONTEXT_CHANGED', 'GENERATION_IMPORT_CONTEXT_REQUIRED',
  'GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED', 'GENERATION_IMPORT_EFFECT_SEALED', 'GENERATION_IMPORT_EFFECT_SOURCE_CHANGED',
  'GENERATION_IMPORT_EXECUTION_REQUIRED', 'GENERATION_IMPORT_EXECUTION_STALE', 'GENERATION_IMPORT_MODEL_CHANGED',
  'GENERATION_IMPORT_ORDINAL_GAP', 'GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE', 'GENERATION_IMPORT_PREVIOUS_EFFECT_REQUIRED',
  'GENERATION_IMPORT_QUERY_INVALID', 'GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN', 'GENERATION_IMPORT_QUERY_REQUIRED', 'GENERATION_IMPORT_ROOT_CHANGED',
  'GENERATION_IMPORT_SLOT_AMBIGUOUS', 'GENERATION_IMPORT_SLOT_REQUIRED', 'GENERATION_IMPORT_STAGE_INVALID',
  'GENERATION_FINALIZED_SOURCE_NOT_CURRENT', 'GENERATION_MODEL_REQUIRED', 'IMPORT_RUN_CANCELLED',
  'IMPORT_RUN_EFFECT_HANDLE_REQUIRED', 'IMPORT_RUN_EFFECT_HISTORY_UNKNOWN', 'IMPORT_RUN_EXECUTION_STALE',
  'IMPORT_RUN_NOT_FOUND', 'IMPORT_RUN_RECEIPT_PAYLOAD_INVALID', 'IMPORT_RUN_STAGE_MISMATCH',
  ...QUERY_HARD_FAILURE_CODES,
])
const LEASE_POLL_MS = 25
const HEARTBEAT_MAX_MS = 60_000

function safeFailureCode(code: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(code)
    && (knownAppErrorMessage('en-US', code) !== undefined || INTERNAL_FAILURE_CODES.has(code) || attemptFailureCode(code) !== undefined)
}
function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'failureCode' in error && typeof error.failureCode === 'string'
    && safeFailureCode(error.failureCode)) return error.failureCode
  const message = error instanceof Error ? error.message : ''
  return safeFailureCode(message) ? message : 'GENERATION_REQUEST_FAILED'
}
function attemptFailureCode(value: unknown): NonNullable<GenerationAttemptReceipt['failureCode']> | undefined {
  return ATTEMPT_FAILURE_CODES.find(code => code === value)
}
function queryHardFailureCode(error: unknown): string | undefined {
  if (!(error instanceof EmbeddingDispatchBarrierError) || error.code === 'GENERATION_ACTION_CANCELLED') return undefined
  return QUERY_HARD_FAILURE_CODES.has(error.code) ? error.code : undefined
}
function readRunLease(runtime: ProjectRuntime, runId: string): RunLeaseRow {
  const row = runtime.database.prepare(`SELECT purpose,stage,status,cancel_requested,execution_owner,execution_epoch,lease_expires_at,locale FROM import_runs WHERE id=?`).get(runId) as RunLeaseRow | undefined
  if (!row) throw new Error('IMPORT_RUN_NOT_FOUND')
  return row
}
function assertRequestExecution(row: RunLeaseRow, request: ReferenceGlobalRequest): void {
  if (row.execution_owner !== request.execution.owner || row.execution_epoch !== request.execution.epoch) throw new Error('IMPORT_RUN_EXECUTION_STALE')
  if (row.purpose !== 'reference') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
}
export function assertEffectHistoryKnown(runtime: ProjectRuntime, runId: string): void {
  const table = runtime.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_effect_ledger'").pluck().get()
  if (!table) return
  const unknown = runtime.database.prepare(`SELECT 1 FROM import_effect_ledger WHERE run_id=? AND stage='global'
    AND state='unknown' AND (batch_id='done' OR batch_id LIKE '__legacy_%') LIMIT 1`).get(runId)
  if (unknown) throw new Error('IMPORT_RUN_EFFECT_HISTORY_UNKNOWN')
}
function receiptHandle(receipt: ImportRunEffectReceipt): MainGenerationRunHandle | null {
  const handle = (receipt.payload as { generationRunHandle?: unknown }).generationRunHandle
  return handle && typeof handle === 'object' ? handle as MainGenerationRunHandle : null
}
function receiptGlobal(receipt: ImportRunEffectReceipt): ImportGlobalFactsReceipt {
  const value = receipt.state === 'committed' ? receipt.effectReceipt : undefined
  if (!value || typeof value !== 'object' || typeof (value as { operationId?: unknown }).operationId !== 'string') throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
  return value as ImportGlobalFactsReceipt
}
export function readReferenceGlobalHistory(runtime: ProjectRuntime, runId: string): ImportRunEffectReceipt | null {
  assertEffectHistoryKnown(runtime, runId)
  return ImportRunRepository.getEffectReceipt(runId, 'global', 'done', runtime)
}

export function assertReferenceGlobalSkippedHistory(runtime: ProjectRuntime, runId: string, completed: boolean): void {
  const receipt = readReferenceGlobalHistory(runtime, runId)
  if (!receipt || receipt.state !== 'committed') throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
  if (!completed && !receiptHandle(receipt)) throw new Error('GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED')
}
function noInferenceFailure(locale: ImportRunLocale): ReferenceGlobalFailure {
  return new ReferenceGlobalFailure('GENERATION_REQUEST_FAILED', locale === 'zh-CN'
    ? '未能从导入内容中提取有效的全局设定。'
    : 'No valid global settings could be inferred from the imported material.')
}
function replayTask(runtime: ProjectRuntime, handle: MainGenerationRunHandle, ordinal: number): GenerationTask | undefined {
  const row = runtime.database.prepare(`SELECT usage_receipt_json FROM generation_attempts WHERE run_id=? AND invocation_nonce=?`).get(handle.runId, `import:${ordinal}`) as { usage_receipt_json: string } | undefined
  if (!row) return undefined
  const usage = JSON.parse(row.usage_receipt_json) as { replayTask?: GenerationTask }
  if (!usage.replayTask) throw new Error('GENERATION_IMPORT_TASK_INVALID')
  return usage.replayTask
}
function outcomeFailure(result: Awaited<ReturnType<Owner['executeImportGeneration']>>, locale: ImportRunLocale, hooks: Hooks): void {
  const code = attemptFailureCode(result.outcome.receipt.failureCode)
  if (code) throw new ReferenceGlobalFailure(code, hooks.failureMessage(code, locale))
  if (result.outcome.finishReason === 'cancelled') throw new Error('GENERATION_ACTION_CANCELLED')
  if (result.outcome.status !== 'completed' || result.outcome.finishReason !== 'stop') throw createBoundedCompletionError(result.outcome.finishReason, locale)
}
function trustedFailure(error: unknown, hooks: Hooks, locale: ImportRunLocale): ReferenceGlobalFailure {
  if (error instanceof ReferenceGlobalFailure) return error
  if (error instanceof BoundedCompletionFailure) return new ReferenceGlobalFailure('GENERATION_REQUEST_FAILED', error.message, error.failureCode)
  if (error instanceof StructuredContractDiagnostic) return new ReferenceGlobalFailure('GENERATION_REQUEST_FAILED', error.message)
  const code = failureCode(error)
  return new ReferenceGlobalFailure(code, hooks.failureMessage(code, locale))
}

export async function executeReferenceGlobal({ runtime, owner, viewEpoch, request, signal, assertCurrent, hooks }: Options): Promise<ReferenceGlobalResult> {
  const context = { database: runtime.database, canonicalRoot: runtime.canonicalRoot, projectId: runtime.projectId }
  const slot = SLOT(request.runId)
  let execution: ImportRunExecutionLease
  let executionCaptured = false
  let locale: ImportRunLocale = 'en-US'
  let handle: MainGenerationRunHandle | null = null
  let modelId: string | null = request.modelId
  let committed = false
  let terminalWritten = false
  let currentOperation: Promise<unknown> | undefined
  let currentOperationKind: 'query' | 'generation' | undefined
  let monitorTimer: ReturnType<typeof setTimeout> | undefined
  let monitorStopped = false
  let interrupted: ReferenceGlobalFailure | undefined
  let notifyInterrupted!: (error: ReferenceGlobalFailure) => void
  const interruption = new Promise<never>((_resolve, reject) => { notifyInterrupted = reject })
  void interruption.catch(() => undefined)
  const stopWith = (error: ReferenceGlobalFailure) => {
    if (interrupted) return
    interrupted = error
    notifyInterrupted(error)
    if (handle) { try { void owner.cancel(handle) } catch { /* Captured generation may already be terminal or stale. */ } }
  }
  const interruptible = async <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, interruption])
  const assertResources = () => { assertCurrent(); if (signal.aborted) throw new Error('GENERATION_ACTION_CANCELLED') }
  const assertAuthorityCurrent = () => {
    const row = readRunLease(runtime, request.runId)
    if (row.execution_owner !== execution.owner || row.execution_epoch !== execution.epoch) throw new Error('IMPORT_RUN_EXECUTION_STALE')
    if (row.status !== 'running' || row.stage !== 'global' || row.purpose !== 'reference') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    if (row.cancel_requested) throw new Error('IMPORT_RUN_CANCELLED')
  }
  const check = () => {
    if (monitorStopped) return
    if (signal.aborted) { stopWith(new ReferenceGlobalFailure('GENERATION_ACTION_CANCELLED', hooks.failureMessage('GENERATION_ACTION_CANCELLED', locale))); return }
    try {
      assertResources(); assertAuthorityCurrent()
      if (execution.expiresAt - Date.now() <= Math.floor(HEARTBEAT_MAX_MS / 3)) execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
    } catch (error) {
      const code = failureCode(error)
      stopWith(new ReferenceGlobalFailure(code, hooks.failureMessage(code, locale)))
      return
    }
    monitorTimer = setTimeout(check, LEASE_POLL_MS)
  }
  const settleOperation = async (operation: Promise<unknown>) => {
    const settled = await operation.then(value => ({ value }), error => ({ error }))
    await owner.whenPhysicalIdle()
    if ('error' in settled) throw settled.error
    const value = settled.value as { outcome?: { receipt?: { failureCode?: unknown } } }
    const code = attemptFailureCode(value.outcome?.receipt?.failureCode)
    if (code) throw new ReferenceGlobalFailure(code, hooks.failureMessage(code, locale))
    return settled.value
  }
  const settleFailure = (error: unknown) => {
    const current = runtime.database.prepare('SELECT execution_owner,execution_epoch,status,stage FROM import_runs WHERE id=?').get(request.runId) as
      { execution_owner: string; execution_epoch: number; status: string; stage: string } | undefined
    if (!current || current.execution_owner !== execution.owner || current.execution_epoch !== execution.epoch
      || current.status !== 'running' || current.stage !== 'global') return
    const code = failureCode(error)
    if (code === 'GENERATION_ACTION_CANCELLED' || code === 'IMPORT_RUN_CANCELLED') return ImportRunRepository.cancelAtBoundary(request.runId, execution, context)
    const display = trustedFailure(error, hooks, locale).displayMessage
    return ImportRunRepository.fail(request.runId, 'global', display, execution, context)
  }
  const dispatch = async (ordinal: number, task: GenerationTask) => {
    assertResources(); assertAuthorityCurrent()
    const prior = replayTask(runtime, handle!, ordinal)
    let actualTask = prior
    if (!actualTask) {
      const skill = owner.readImportPlanningSkill(handle!)
      const injected = injectWritingSkillPrompt(task, frozen!.core.writingLanguage, skill)
      actualTask = injected.task
      if (injected.skillName && !skillLogged) { hooks.log({ key: 'skill', name: injected.skillName }); skillLogged = true }
    }
    hooks.progress(10)
    const operation = owner.executeImportGeneration({ handle: handle!, ordinal, task: actualTask, execution: request.execution })
    currentOperation = operation
    currentOperationKind = 'generation'
    let generated: Awaited<typeof operation>
    try { generated = await interruptible(operation) }
    catch (error) {
      if (interrupted) {
        try { owner.cancel(handle!) } catch { /* Drain before terminal bookkeeping. */ }
        try { await settleOperation(operation) } catch (drainError) {
          const hard = attemptFailureCode((drainError as { failureCode?: unknown })?.failureCode)
          if (hard) throw new ReferenceGlobalFailure(hard, hooks.failureMessage(hard, locale))
          const generic = failureCode(drainError)
          if (!['GENERATION_ACTION_CANCELLED', 'IMPORT_RUN_CANCELLED'].includes(generic)) throw drainError
        }
      }
      throw error
    }
    await owner.whenPhysicalIdle()
    currentOperation = undefined
    currentOperationKind = undefined
    if (generated.outcome.receipt.promptBudget) hooks.promptBudget(generated.outcome.receipt.promptBudget)
    hooks.progress(90)
    outcomeFailure(generated, locale, hooks)
    return stripDraftThinkingTags(generated.outcome.content)
  }

  let frozen: NonNullable<ReturnType<Owner['readImportGeneration']>>['frozenContext'] | undefined
  let skillLogged = false
  try {
    assertResources()
    const row = readRunLease(runtime, request.runId)
    locale = row.locale
    const existingReceipt = readReferenceGlobalHistory(runtime, request.runId)
    if (existingReceipt?.state === 'committed' && row.purpose === 'reference' && row.status === 'completed' && row.stage === 'completed') {
      handle = receiptHandle(existingReceipt)
      const run = ImportRunRepository.get(request.runId, context)
      if (!run) throw new Error('IMPORT_RUN_NOT_FOUND')
      committed = true
      return { version: 1, run, execution: null, receipt: existingReceipt, handle, modelId: null, replayed: true }
    }
    if (existingReceipt?.state === 'committed' && row.stage !== 'global') {
      assertRequestExecution(row, request)
      if (row.status !== 'running' || row.lease_expires_at <= Date.now()) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
      handle = receiptHandle(existingReceipt)
      if (!handle) throw new Error('GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED')
      execution = { owner: row.execution_owner, epoch: row.execution_epoch, expiresAt: row.lease_expires_at }
      const run = ImportRunRepository.get(request.runId, context)
      if (!run) throw new Error('IMPORT_RUN_NOT_FOUND')
      committed = true
      hooks.committed()
      return { version: 1, run, execution, receipt: existingReceipt, handle, modelId: null, replayed: true }
    }
    assertRequestExecution(row, request)
    if (row.stage !== 'global' || row.status !== 'running') throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    execution = ImportRunRepository.renewExecution(request.runId, {
      owner: row.execution_owner, epoch: row.execution_epoch, expiresAt: row.lease_expires_at,
    }, Date.now(), undefined, context)
    executionCaptured = true
    monitorTimer = setTimeout(check, LEASE_POLL_MS)

    let receipt = existingReceipt
    if (receipt?.state === 'prepared') {
      handle = receiptHandle(receipt)
      if (!handle) throw new Error('GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED')
      owner.assertImportGenerationSources(handle, slot)
      execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
      await owner.withImportQuerySources(handle, () => {
        const committedReceipt = ImportRunRepository.commitEffectReceipt(request.runId, 'global', 'done', execution,
          Date.now(), owner.assertImportGenerationSources, context)
        receipt = committedReceipt.receipt
      })
      committed = true
      hooks.committed()
    } else if (receipt?.state === 'committed') {
      handle = receiptHandle(receipt)
      if (!handle) throw new Error('GENERATION_IMPORT_EFFECT_HANDLE_REQUIRED')
      committed = true
      hooks.committed()
    } else if (!receipt) {
      let recovery = owner.readImportGeneration(slot)
      if (recovery && recovery.view.handle.epoch !== viewEpoch) recovery = { ...recovery, view: await owner.resume(recovery.view.handle) }
      if (!recovery) {
        const rootRecovery = owner.readImportGeneration({ runId: request.runId, stage: 'global', batchId: 'done' })
        const selectedModelId = request.modelId ?? rootRecovery?.modelId
        if (!selectedModelId) throw new Error('GENERATION_MODEL_REQUIRED')
        const started = runtime.database.transaction(() => {
          const chapters = ImportRunRepository.listRepresentativeChapters(request.runId, context)
          if (!chapters.length || chapters.every(chapter => !chapter.content.trim())) throw noInferenceFailure(locale)
          if (rootRecovery) {
            const budget = new GenerationRunRepository(() => runtime.database).budget(rootRecovery.view.handle.rootActionId)
            if (rootBudgetExhausted(budget.policy, budget.attempts, budget.activeElapsedMs, budget.auxiliaryRequestCount)) throw new Error('ROOT_BUDGET_EXHAUSTED')
          }
          const view = owner.begin({ operation: 'import-global-facts', uiActionNonce: `global:${request.runId}`,
            modelId: selectedModelId, selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'],
            skillStages: ['planning'], authorInputs: chapters.map(chapter => ({ id: `import:${chapter.number}:${chapter.contentFingerprint}`, text: chapter.content })),
            output: 'structured-data', importSlot: slot, importExecution: request.execution,
            ...(rootRecovery ? { parentRootActionId: rootRecovery.view.handle.rootActionId } : {}),
          } as import('../../src/shared/generation-owner-contract').BeginGenerationRequest)
          const startedRecovery = owner.readImportGeneration(slot, view.handle.runId)
          if (!startedRecovery) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
          return { ...startedRecovery, view }
        }).immediate()
        recovery = started
      }
      handle = recovery.view.handle
      modelId = recovery.modelId
      frozen = recovery.frozenContext
      await interruptible(hooks.opened({ handle, modelId }))
      hooks.log({ key: 'retrieving' })
      hooks.progress(5)
      const queryOperation = owner.prepareImportQueryMaterials({ handle, execution: request.execution })
      currentOperation = queryOperation
      currentOperationKind = 'query'
      const queried = await interruptible(queryOperation) as ImportQueryMaterialsResponse
      await owner.whenPhysicalIdle()
      currentOperation = undefined
      currentOperationKind = undefined
      if (queried.topics.length !== 4 || queried.topics.some((item, index) => item.key !== (['worldview', 'protagonist', 'conflict', 'style'] as const)[index])) throw new Error('GENERATION_IMPORT_QUERY_INVALID')
      const writingLanguage = frozen.core.writingLanguage
      const topics = getImportInferenceTopics(writingLanguage)
      const sampledContent: Partial<Record<ImportInferenceTopicKey, string>> = {}
      for (const [index, topic] of topics.entries()) {
        const results = queried.topics[index]!.results
        if (results === null) hooks.log({ key: 'retrieval-fallback', topic: topic.key })
        else hooks.log({ key: 'retrieved', topic: topic.key, count: Math.min(5, results.length) })
        sampledContent[topic.key] = formatImportInferenceSample(results === null ? 'unavailable' : results.slice(0, 5), writingLanguage)
      }
      hooks.progress(20)
      const template = frozen.prompts.infer_novel_config_with_vectors ?? frozen.prompts.infer_novel_config
      if (!template) throw new Error('GENERATION_IMPORT_CONTEXT_REQUIRED')
      const initialTask = buildImportInferenceTask({ template, writingLanguage, chapters: frozen.chapters, totalChapters: frozen.totalChapters, sampledContent })
      hooks.log({ key: 'calling-ai' })
      hooks.progress(25)
      let rawResult = await dispatch(0, initialTask)
      let nextOrdinal = 1
      if (isRepairableDirectJsonSyntaxFailure(rawResult)) {
        hooks.log({ key: 'syntax-repair' })
        const repairTask = buildStructuredSyntaxRepairTask({ purpose: 'import-inference', output: 'structured-data', messages: [] }, importInferenceJsonContract(writingLanguage), rawResult, writingLanguage)
        const repaired = await dispatch(nextOrdinal++, repairTask)
        if (!preservesStructuredJsonEvidence(rawResult, repaired)) {
          for (const code of await discardRejected(owner, handle)) hooks.log({ key: 'discard-failed', code })
          throw new ReferenceGlobalFailure('GENERATION_REQUEST_FAILED', locale === 'zh-CN'
            ? '导入推演 JSON 语法修复改变了候选事实，已拒绝写入'
            : 'The import-inference JSON syntax repair changed candidate facts, so the write was rejected.')
        }
        rawResult = repaired
      }
      hooks.candidate(rawResult)
      hooks.progress(70)
      hooks.log({ key: 'parsing' })
      let inference: ImportInferenceResult
      try { inference = decodeImportInferenceJson(rawResult) }
      catch (error) {
        if (!(error instanceof StructuredContractDiagnostic) || error.code !== 'relationship_endpoint_not_in_characters') {
          for (const code of await discardRejected(owner, handle)) hooks.log({ key: 'discard-failed', code })
          throw error
        }
        let targets: string[]
        try { targets = importEndpointRecoveryTargets(rawResult, textFor(locale)) }
        catch (targetError) {
          for (const code of await discardRejected(owner, handle)) hooks.log({ key: 'discard-failed', code })
          throw targetError
        }
        let delta: string | null = null
        if (targets.length) {
          hooks.log({ key: 'endpoint-recovery', count: targets.length })
          delta = await dispatch(nextOrdinal, buildImportEndpointCardTask({ writingLanguage, originalRoot: parseImportInferenceJsonObject(rawResult), unresolvedTargets: targets }))
        }
        let recovered: ReturnType<typeof decodeRecoveredImportInference>
        try { recovered = decodeRecoveredImportInference(rawResult, delta, textFor(locale)) }
        catch (decodeError) {
          for (const code of await discardRejected(owner, handle)) hooks.log({ key: 'discard-failed', code })
          throw decodeError
        }
        inference = recovered.result
        if (recovered.droppedRelationships.length) hooks.log({ key: 'dropped-relationships', relationships: recovered.droppedRelationships })
      }
      assertResources(); assertAuthorityCurrent()
      const roster = CharacterRosterRepository.readCaptured(runtime.database)
      if (roster.status !== 'ready' && roster.status !== 'empty') throw new ReferenceGlobalFailure('GENERATION_REQUEST_FAILED', locale === 'zh-CN'
        ? '角色名单当前不可安全导入；请先完成旧项目修复或处理数据不一致状态'
        : 'The character roster cannot be imported safely. Repair the legacy project or resolve its inconsistent state first.')
      const totalChapters = frozen.totalChapters
      const wordsPerChapter = Math.max(1, Math.round(frozen.totalWords / totalChapters))
      const core = {
        genre: inference.novelConfig.genre, subGenre: inference.novelConfig.subGenre, targetAudience: inference.novelConfig.targetAudience,
        totalChapters, wordsPerChapter, plotStructure: inference.novelConfig.plotStructure, narrativePov: inference.novelConfig.narrativePOV,
        goldenFinger: inference.novelConfig.goldenFinger, globalGuidance: inference.novelConfig.globalGuidance,
        coreOutline: inference.novelConfig.coreOutline, worldSetting: inference.novelConfig.worldSetting,
        protagonistProfile: inference.novelConfig.protagonistProfile, premise: inference.architectureFiles.premise,
        worldbuilding: inference.architectureFiles.worldbuilding, synopsis: inference.architectureFiles.synopsis,
      }
      const effectRequest: ImportGlobalFactsRequest = { operationId: `novel-import-global-${request.runId}`, generationRunHandle: handle,
        expectedRosterRevision: roster.revision, core, characterEntries: inference.characterCards }
      owner.assertImportGenerationSources(handle, slot)
      execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
      const committedEffectReceipt = await owner.withImportQuerySources(handle, () => {
        ImportRunRepository.prepareEffectReceipt({ runId: request.runId, stage: 'global', batchId: 'done',
          effectKey: 'global-facts', kind: 'project-global-facts', payload: effectRequest }, execution, Date.now(), owner.assertImportGenerationSources, context)
        return ImportRunRepository.commitEffectReceipt(request.runId, 'global', 'done', execution,
          Date.now(), owner.assertImportGenerationSources, context)
      })
      receipt = committedEffectReceipt.receipt
      committed = true
      hooks.committed()
      const globalReceipt = receiptGlobal(committedEffectReceipt.receipt)
      if ('characterProposal' in globalReceipt && globalReceipt.characterProposal) hooks.log({ key: 'saved-proposals', count: inference.characterCards.length })
      else hooks.log({ key: 'saved-roster', count: globalReceipt.roster?.snapshot.entries.length ?? inference.characterCards.length })
    }
    if (!receipt || receipt.state !== 'committed') throw new Error('IMPORT_RUN_RECEIPT_PAYLOAD_INVALID')
    hooks.progress(90)
    assertResources()
    execution = ImportRunRepository.renewExecution(request.runId, execution, Date.now(), undefined, context)
    const advanced = ImportRunRepository.advanceStage(request.runId, 'global', 'style', execution, context)
    hooks.progress(100)
    monitorStopped = true
    const finalRun = ImportRunRepository.get(request.runId, context) ?? advanced
    return { version: 1, run: finalRun, execution, receipt, handle, modelId, replayed: Boolean(existingReceipt) }
  } catch (error) {
    let primaryError: unknown = error
    if (currentOperation) {
      try { await settleOperation(currentOperation) } catch (drainError) {
        const drainedCode = failureCode(drainError)
        const hard = attemptFailureCode((drainError as { failureCode?: unknown })?.failureCode)
        const queryHard = queryHardFailureCode(drainError)
        if (currentOperationKind === 'query' && queryHard) {
          primaryError = new ReferenceGlobalFailure(queryHard, hooks.failureMessage(queryHard, locale))
        } else if (!interrupted && hard) primaryError = new ReferenceGlobalFailure(hard, hooks.failureMessage(hard, locale))
        else if (!interrupted && drainedCode !== 'GENERATION_ACTION_CANCELLED' && drainedCode !== 'IMPORT_RUN_CANCELLED') primaryError = drainError
      }
    } else if (handle) { try { await owner.whenPhysicalIdle() } catch { /* Preserve the primary error. */ } }
    if (executionCaptured && !committed && !terminalWritten) {
      try { settleFailure(primaryError); terminalWritten = true }
      catch (terminalError) {
        if (failureCode(terminalError) !== 'IMPORT_RUN_EXECUTION_STALE') {
          const code = failureCode(terminalError)
          const failure = trustedFailure(primaryError, hooks, locale)
          failure.secondaryErrors.push(code)
          primaryError = failure
        }
      }
    }
    throw trustedFailure(primaryError, hooks, locale)
  } finally {
    monitorStopped = true
    if (monitorTimer) clearTimeout(monitorTimer)
    if (currentOperation) { try { await settleOperation(currentOperation) } catch { /* The primary result already records operation failure. */ } }
    if (handle) { try { await owner.whenPhysicalIdle() } catch { /* Drain errors are surfaced from the operation path. */ } }
  }
}

function textFor(locale: ImportRunLocale) {
  return (zhCN: string, enUS: string) => locale === 'zh-CN' ? zhCN : enUS
}
async function discardRejected(owner: Owner, handle: MainGenerationRunHandle): Promise<string[]> {
  const failures: string[] = []
  try {
    const view = owner.read(handle)
    for (const candidate of view.candidates ?? []) {
      if (candidate.status !== 'running') {
        try { owner.discardCandidate(handle, candidate.artifactId) }
        catch (error) { const code = failureCode(error); failures.push(safeFailureCode(code) ? code : 'GENERATION_REQUEST_FAILED') }
      }
    }
  } catch (error) { const code = failureCode(error); failures.push(safeFailureCode(code) ? code : 'GENERATION_REQUEST_FAILED') }
  return failures
}

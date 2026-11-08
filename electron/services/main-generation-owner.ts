import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { BeginGenerationRequest, ExecuteGenerationRequest, BeginGenerationBatchRequest, GenerationDraftCommitRequest, GenerationRecoveryContext, MaterialDecisionReceipt, VisibleCompositionAlgorithm, GenerationOwnerChannels, GenerationRecoveryList, ShortOutlineRetry, PlanningContinuation } from '../../src/shared/generation-owner-contract'
import { isDraftVisibleTextVersion } from '../../src/shared/draft-visible-text'
import { generationOutputContract, type GenerationAuthorInput } from '../../src/shared/generation-owner-contract'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunSummary, MainGenerationRunView, MainGenerationSnapshot } from '../../src/services/generation/generation-runtime'
import type { ModelProfile, ModelExecutionLeaseReceipt, LLMFinishReason } from '../../src/shared/ipc-channels'
import type { CreativeStrategy } from '../../src/shared/reasoning-types'
import { TERMINAL_PROVIDER_FAILURE_CODES, rootBudgetExhausted, tokenLiability } from '../../src/shared/generation-contract'
import { DRAFT_RECONCILE_PURPOSE, stripDraftReconciliationBlock, withoutDraftReconciliationArtifacts } from '../../src/shared/draft-reconciliation'
import { DRAFT_SHORT_OUTLINE_PURPOSE, draftShortOutlineBlock, stripDraftShortOutlineBlock } from '../../src/shared/draft-short-outline'
import { GenerationRunRepository, textHash, type DurableGenerationRun, type RunBinding, type GenerationExecutionReceipt } from '../repositories/generation-run-repository'
import { GenerationRecoveryTailRepository } from '../repositories/generation-recovery-tail-repository'
import { PlanningFeedbackService, type PlanningFeedbackGenerationInput } from './planning-feedback-service'
import { readPlanningFeedbackTask } from './planning-feedback-generation'
import { assertPlanningFeedbackObject, type AdoptPlanningFeedbackCandidate, type PlanningFeedbackCaptureTarget, type RelineagePlanningFeedbackCandidate, type StagePlanningFeedbackCandidate } from '../../src/shared/planning-feedback'
import type { PlanningFeedbackCoreTarget } from '../../src/shared/planning-feedback'
import type { PlanningFeedbackRunRecovery } from '../../src/shared/planning-feedback-ipc'
import { ModelExecutionLeaseRegistry, createModelExecutionLeaseReceipt } from './model-execution-lease'
import { createGenerationRunService, GENERATION_STOPPED, type GenerationRunServiceDependencies } from './generation-run-service'
import type { GenerationSchedulingAdmission } from './generation-scheduler'
import { SchedulerAdmissionError, type MainProcessSchedulerPermit, type SchedulerLane } from './main-process-scheduler'
import { LLMHistoryRepository } from '../repositories/llm-repository'
import { assertSemanticGenerationTask, buildMainGenerationPlan, MAIN_GENERATION_POLICY, newMainGenerationPolicy, planningGenerationScope, readMainGenerationPolicy, type MainGenerationPlan, type MainGenerationPolicy } from './main-generation-plan'
import { LLMFactory } from '../llm/llm-factory'
import type { GenerationAttemptReceipt, GenerationTask } from '../../src/services/generation/generation-harness'
import type { ProviderUsageEvidence } from '../llm/provider.interface'
import { BlueprintRepository, type BlueprintRangeCommitReceipt, type BlueprintRangeCommitRequest } from '../repositories/blueprint-repository'
import { decodeBlueprintAuthorPayload } from '../../src/shared/blueprint-semantic-contract'
import { GenerationDraftEffects, assertGenerationBatchIntent } from './generation-draft-effects'
import { CharacterProposalService } from './character-proposal-service'
import { proveCharacterProposal } from './generation-character-proposal-proof'
import { compareGenerationSourceBindings, recordedModelName } from './generation-source-binding'
import type { GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'
import type { PrepareDraftContextRequest, PreparedDraftContext } from '../../src/shared/generation-owner-contract'
import { FinalizedCharacterGeneration } from './finalized-character-generation'
import type { FinalizedCharacterGenerationCommit } from '../../src/shared/finalized-character-generation'
import type { ReviewRevisionContext, PrepareReviewRevisionRequest, ReviewGenerationCommitRequest, RevisionGenerationCommitRequest } from '../../src/shared/review-revision-generation'
import { ReviewRevisionGeneration, ReviewSourceDeletedError } from './review-revision-generation'
import { AgentGeneration, type AgentBeginSelection } from './agent-generation'
import { ImportGeneration, importSlotNonce } from './import-generation'
import type { ImportGenerationSlot } from '../../src/shared/import-generation'
import { importGenerationSlotKey } from './import-generation-source'
import type { ApproveCharacterProposalRequest } from '../../src/shared/character-proposal'
import type { AgentGenerationContext, AgentGenerationInput } from '../../src/shared/agent-generation'
import type { EditorInlineInput, EditorInlineRecovery, EditorInlineGenerationChannels } from '../../src/shared/editor-inline-generation'
import { validateEditorInlineInput, readEditorInlineContext, readEditorInlineTask } from './editor-inline-generation'
import type { FinalizationGenerationChannels, FinalizationGenerationSlot, FinalizationGenerationRecovery } from '../../src/shared/finalization-generation'
import { FinalizationGeneration } from './finalization-generation'
import { finalizationSlotKey, readFinalizationGenerationContext } from './finalization-generation-source'
import { proveFinalizedCharacterGeneration } from './finalized-character-generation-proof'
import { FinalizedCharacterEvidenceError, parseFinalizedCharacterStateResponse, type FinalizedCharacterContext } from '../../src/shared/finalized-continuity'
import type { GraphGenerationChannels, GraphGenerationInput, GraphGenerationRecovery } from '../../src/shared/graph-generation'
import { GraphGeneration } from './graph-generation'
import type { LegacyRosterGenerationChannels, LegacyRosterGenerationRecovery } from '../../src/shared/legacy-roster-generation'
import { LegacyRosterGeneration } from './legacy-roster-generation'
import { readLegacyRosterGenerationProof } from './legacy-roster-generation-proof'
import { readLegacyRosterGenerationContext } from './legacy-roster-generation-context'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'
import { readLegacyRosterSource, adoptLegacyCards } from './legacy-roster-source'
import { buildLegacyRosterJsonRepairTask, buildLegacyRosterReplacementTask, parseLegacyRosterJson } from '../../src/shared/legacy-roster-generation-pure'
import { validateGraphGenerationInput, readGraphGenerationContext } from './graph-generation-source'
import { planningTargetInstruction, parsePlanningTargetUnits, renderPlotOutlineRange, plotOutlineRecoveryDraft, plotOutlineSourceInvalid, validPlotOutlineAuthorPrefix, type PlotOutlineSource, type PlotOutlineProgress, type PlotOutlineRecovery, type PlotOutlineAuthorEditReceipt } from '../../src/shared/plot-outline-contract'
import { ProjectCoreRepository, type ProjectCoreSynopsisExpected, type ProjectCoreSynopsisCommitRequest } from '../repositories/project-core-repository'
import { measurePerformanceOperation, recordPerformanceCount, recordPerformanceTextBytes } from './performance-diagnostics'
// 尝试 id 都由 randomUUID 生成；recoverFrom 还拼进 nonce，只收 UUID，免得拼出别的尝试的 nonce。
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const graphOperations = { plot: 'plot-tree-snapshot', plan: 'narrative-thread-plan-candidate', event: 'narrative-thread-event-candidate' } as const
/** 可能出现在运行侧页「可恢复」区的运行，按操作类型归类。不在表里的从不列出：定稿后处理、图生成、导入，以及随聊天隐藏的助手任务（磁盘记录保留）。 */
const RECOVERY_KIND: ReadonlyMap<string, 'planning' | 'review' | 'editor' | 'draft'> = new Map([
  ['generate-plot-outline', 'planning'], ['chapter-blueprint-directory', 'planning'],
  ['review-chapter', 'review'], ['refine-draft', 'review'], ['refine-from-review', 'review'],
  ['editor-inline', 'editor'], ['chapter-draft', 'draft'],
] as const)

export type SafeGenerationModelReceipt = Omit<ModelExecutionLeaseReceipt, 'leaseId' | 'createdAt' | 'expiresAt'>
export function safeGenerationModelReceipt(receipt: ModelExecutionLeaseReceipt): SafeGenerationModelReceipt {
  return { modelId: receipt.modelId, provider: receipt.provider, protocol: receipt.protocol, modelName: receipt.modelName,
    modelRevision: receipt.modelRevision, endpointFingerprint: receipt.endpointFingerprint, capabilityEvidence: structuredClone(receipt.capabilityEvidence) }
}
export interface MainGenerationOwnerDependencies {
  /** Main-only captured runtime identity; renderer project identifiers never select scheduler groups. */
  scheduling?: { admission: GenerationSchedulingAdmission; projectKey: string; quarantineAfterMs: number }
  /** Verifies the original KB snapshot after queueing; the synchronous start never awaits provider cleanup. */
  withDispatchKnowledge?: <T>(snapshot: GenerationKnowledgeSnapshot | undefined, operation: () => T) => Promise<T>
  mode?: 'legacy' | 'runtime-feedback' | 'workflow-driver' | 'workflow-batch'
  /** Disable database-wide recovery during an idle owner handoff on the same native DB. */
  recoverInterrupted?: boolean
  /** Checks runtime-owned claims before an idle owner handoff. */
  assertNoRuntimeClaims?: () => void
  /** Checks captured runtime and native DB identity for idle handoff without renewing a UI lease. */
  assertRetirementResources?: () => void
  runtimeFeedback?: {
    assertActive: (runId: string) => void
    assertDispatchAdmission: (runId: string) => void
  }
  workflowDriver?: {
    assertActive: (runId: string) => void
    assertDispatchAdmission: (runId: string, invocationNonce: string, task: GenerationTask) => void
  }
  database: Database.Database
  projectId: string
  projectPath: string
  epoch: string
  assertCurrent: () => void
  /** New work only; captured resources remain usable for settlement and cleanup. */
  assertAdmission?: () => void
  leases: ModelExecutionLeaseRegistry
  loadModel: (id: string) => ModelProfile | null
  buildBinding: (selection: BeginGenerationRequest & { knowledgeSnapshot?: GenerationKnowledgeSnapshot; finalizedCharacterContextHash?: string; reviewRevisionContext?: ReviewRevisionContext; agentInput?: AgentGenerationInput; agentSession?: { key: string; roundIndex: number }; editorInlineInput?: EditorInlineInput; finalizationGenerationSlot?: FinalizationGenerationSlot; graphGenerationInput?: GraphGenerationInput; graphGenerationKey?: string; legacyRosterKey?: string; planningFeedbackInput?: PlanningFeedbackGenerationInput }, model: SafeGenerationModelReceipt, policy: MainGenerationPolicy) => RunBinding
  rebuildBinding: (previous: RunBinding, model: SafeGenerationModelReceipt) => RunBinding
  beforeDispatch?: () => void
  onSnapshot?: (snapshot: MainGenerationSnapshot) => void
  onReasoning?: (event: { projectId: string; epoch: string; rootActionId: string; runId: string; attemptId: string; text: string }) => void
  dispatch?: GenerationRunServiceDependencies['dispatch']
  /** Verified portable-transfer originProjectId (readPortableCurrentAuthority), read at commit time. */
  transferOrigin?: () => string | undefined
}

interface ScheduledDispatch { permit: MainProcessSchedulerPermit; started: boolean; finished: boolean; quarantineTimer?: ReturnType<typeof setTimeout> }
interface ProviderRequest { conversationId: string; model: ModelProfile; task: GenerationTask; plan: MainGenerationPlan; scheduling?: ScheduledDispatch }
type ProviderDispatchResult = Awaited<ReturnType<GenerationRunServiceDependencies['dispatch']>>
interface ProviderFlight { result: Promise<ProviderDispatchResult>; physical: Promise<void> }

/** 回执里交给渲染端的失败码：供应商与网络失败、上下文超长，以及阻断根的活动时长用完、写入失败。 */
const RENDERER_SAFE_FAILURE_CODES = ['GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', ...TERMINAL_PROVIDER_FAILURE_CODES,
  'ROOT_BUDGET_EXHAUSTED', 'GENERATION_STORAGE_FAILED'] as const satisfies readonly NonNullable<GenerationAttemptReceipt['failureCode']>[]

/** Provider 流式失败的分类：上下文超长单列；请求或读流被传输层拒绝、拿不到响应流、流在完成标记前断开与原生网络错误都算网络失败，其余算供应商失败。 */
export function providerStreamFailureCode(error: string): 'NETWORK_ERROR' | 'GENERATION_PROVIDER_FAILED' | typeof TERMINAL_PROVIDER_FAILURE_CODES[number] {
  if (error === 'LLM_CONTEXT_LENGTH_EXCEEDED') return 'GENERATION_CONTEXT_LENGTH_EXCEEDED'
  return error === 'LLM_STREAM_NETWORK_FAILED' || error === 'LLM_STREAM_UNREADABLE' || error === 'LLM_STREAM_INCOMPLETE'
    || /fetch failed|failed to fetch|network|ECONNRESET|ETIMEDOUT/iu.test(error)
    ? 'NETWORK_ERROR' : 'GENERATION_PROVIDER_FAILED'
}
function dispatchProvider(value: unknown, options: Parameters<GenerationRunServiceDependencies['dispatch']>[1]): ProviderFlight {
  const { model, task, plan, conversationId } = value as ProviderRequest
  let evidence: ProviderUsageEvidence | null = null
  let settled = false
  let resolve!: (result: ProviderDispatchResult) => void, reject!: (error: unknown) => void
  const result = new Promise<ProviderDispatchResult>((yes, no) => { resolve = yes; reject = no })
  const fail = (error: unknown) => { if (!settled) { settled = true; reject(error) } }
  let transport: Promise<void>
  try {
  transport = LLMFactory.getProvider(model).generateStream(model, task.messages.map(message => ({ ...message })), {
    ...plan.options, conversationId, signal: options.signal, visibleOnly: true,
    onChunk: text => { if (!settled) options.onVisible({ kind: 'delta', text }) },
    onReasoning: text => { if (!settled) options.onReasoning?.(text) },
    onDiagnostics: value => { if (!settled) options.onDiagnostics?.(value) },
    onUsageEvidence: value => { if (!settled) evidence = value },
    onDone: (text, _usage, finishReason) => {
      if (settled) return
      options.onVisible({ kind: 'cumulative', text })
      settled = true
      resolve({ finishReason, usage: evidence ? { ...evidence.usage, reasoningTokens: evidence.reasoningTokens,
        accounting: evidence.accounting, totalIncludesReasoning: evidence.totalIncludesReasoning,
        trusted: plan.trustedUsage && evidence.protocol === model.protocol } : null })
    },
    onError: error => { fail(new Error(providerStreamFailureCode(error))) },
  })
  } catch (error) { transport = Promise.reject(error) }
  // A callback settles only the logical outcome; the actual adapter promise owns cleanup.
  const physical = transport.then(() => { fail(new Error('GENERATION_PROVIDER_FAILED')) }, fail)
  return { result, physical }
}

/** One owner per captured database/session. No renderer budget, lease or hash is authoritative. */
export function createMainGenerationOwner(deps: MainGenerationOwnerDependencies) {
  if (deps.scheduling && (!Number.isSafeInteger(deps.scheduling.quarantineAfterMs) || deps.scheduling.quarantineAfterMs <= 0))
    throw new Error('GENERATION_SCHEDULING_GRACE_INVALID')
  if (deps.mode === 'runtime-feedback' && !deps.runtimeFeedback) throw new Error('GENERATION_RUNTIME_FEEDBACK_ADMISSION_REQUIRED')
  const isDriverMode = deps.mode === 'workflow-driver' || deps.mode === 'workflow-batch'
  const isAuthorViewOwner = deps.mode === undefined || deps.mode === 'legacy'
  if (isDriverMode && !deps.workflowDriver) throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
  const hasRuntimeGrantTable = Boolean(deps.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_feedback_grants'").get())
  const hasWorkflowTaskTable = Boolean(deps.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_tasks'").get())
  const hasWorkflowBatchTable = Boolean(deps.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_batch_tasks'").get())
  if (deps.mode === 'runtime-feedback' && !hasRuntimeGrantTable) throw new Error('GENERATION_RUNTIME_FEEDBACK_SCHEMA_REQUIRED')
  if (deps.mode === 'workflow-driver' && !hasWorkflowTaskTable) throw new Error('GENERATION_WORKFLOW_DRIVER_SCHEMA_REQUIRED')
  if (deps.mode === 'workflow-batch' && !hasWorkflowBatchTable) throw new Error('GENERATION_WORKFLOW_DRIVER_SCHEMA_REQUIRED')
  const isGrantRun = (runId: string) => hasRuntimeGrantTable && Boolean(deps.database.prepare('SELECT 1 FROM runtime_feedback_grants WHERE run_id=? LIMIT 1').get(runId))
  const isV1DriverRun = (runId: string) => hasWorkflowTaskTable && Boolean(deps.database.prepare('SELECT 1 FROM workflow_tasks WHERE run_id=? LIMIT 1').get(runId))
  const isBatchDriverRun = (runId: string) => hasWorkflowBatchTable && Boolean(deps.database.prepare(`SELECT 1 FROM generation_runs candidate
    JOIN generation_runs registered ON registered.root_action_id=candidate.root_action_id WHERE candidate.run_id=? AND (
      EXISTS(SELECT 1 FROM workflow_batch_tasks t WHERE t.batch_run_id=registered.run_id)
      OR EXISTS(SELECT 1 FROM workflow_batch_steps s WHERE s.run_id=registered.run_id)) LIMIT 1`).get(runId))
  const isDriverRun = (runId: string) => isV1DriverRun(runId) || isBatchDriverRun(runId)
  const authorFollowupRuns = new Set<string>()
  const executableAuthorFollowups = new Set<string>()
  const assertAuthorFollowupWritable = (runId: string) => {
    if (authorFollowupRuns.has(runId)) {
      if (!executableAuthorFollowups.has(runId)) throw new Error('GENERATION_REVIEW_RECOVERY_COPY_ONLY')
      reviewRevisions.assertBatchFollowupWritable(runId)
    }
  }
  const assertLegacyRunAccess = (runId: string) => {
    if (deps.mode !== 'runtime-feedback' && isGrantRun(runId)) throw new Error('GENERATION_RUNTIME_FEEDBACK_ACCESS_DENIED')
    if (deps.mode !== 'workflow-driver' && isV1DriverRun(runId)
      || deps.mode !== 'workflow-batch' && isBatchDriverRun(runId) && !authorFollowupRuns.has(runId))
      throw new Error('GENERATION_WORKFLOW_DRIVER_ACCESS_DENIED')
  }
  const assertLegacyParentAccess = (rootActionId: string) => {
    for (const row of deps.database.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=?').all(rootActionId) as { run_id: string }[])
      assertLegacyRunAccess(row.run_id)
  }
  const capturedProjectPath = deps.projectPath
  const runtimeFreeze = readPortableRuntimeFreeze(capturedProjectPath)
  const repository = new GenerationRunRepository(() => deps.database, Date.now, (table, recordId) => runtimeFreeze.isFrozen(table, recordId))
  const recoveryTails = new GenerationRecoveryTailRepository(deps.database, repository, (table, id) => runtimeFreeze.isFrozen(table, id))
  const draftEffects = new GenerationDraftEffects(deps.database, repository)
  const runLeases = new Map<string, string>()
  const runtimePreparations = new Map<string, MainGenerationRunHandle>()
  const driverPreparations = new Map<string, MainGenerationRunHandle>()
  const volatileReceipts = new Map<string, GenerationExecutionReceipt>()
  const pending = new Map<string, { hash: string; promise: Promise<MainGenerationExecuteReceipt> }>()
  const queuedExecutions = new Map<string, { rootId: string; controller: AbortController }>()
  const abortQueuedRoot = (rootId: string) => {
    for (const item of queuedExecutions.values()) if (item.rootId === rootId) item.controller.abort(GENERATION_STOPPED)
  }
  const abortAllQueued = () => { for (const item of queuedExecutions.values()) item.controller.abort(GENERATION_STOPPED) }
  const preparations = new Map<string, { binding: RunBinding; knowledgeSnapshot: GenerationKnowledgeSnapshot }>()
  let closed = false, closing = false
  const assertCurrent = () => {
    if (closed || !deps.database.open) throw new Error('GENERATION_OWNER_CLOSED')
    deps.assertCurrent()
  }
  const assertAdmission = () => {
    if (closing) throw new Error('GENERATION_OWNER_CLOSING')
    assertCurrent()
    deps.assertAdmission?.()
  }
  const guardWork = <T extends object>(target: T, allowed: (name: string) => boolean): T => new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver)
      if (typeof property !== 'string' || typeof value !== 'function') return value
      if (allowed(property)) return value.bind(object)
      if (value.constructor.name === 'AsyncFunction') return async (...args: unknown[]) => { assertAdmission(); return Reflect.apply(value, object, args) }
      return (...args: unknown[]) => { assertAdmission(); return Reflect.apply(value, object, args) }
    },
  })
  const assertRetirable = () => {
    if (closed || !deps.database.open) throw new Error('GENERATION_OWNER_CLOSED')
    if (deps.assertRetirementResources) deps.assertRetirementResources()
    else deps.assertCurrent()
    if (physicalDispatches || pending.size || agents.hasActiveToolClaims()) throw new Error('GENERATION_OWNER_BUSY')
    service.assertRetirable()
    deps.assertNoRuntimeClaims?.()
  }
  const modelReceipt = (binding: RunBinding): SafeGenerationModelReceipt => {
    const value = binding.sourceManifest.modelReceipt as SafeGenerationModelReceipt | undefined
    if (!value || typeof value.modelId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.modelRevision)) throw new Error('GENERATION_MODEL_BINDING_INVALID')
    return value
  }
  const finalizedCharacters = new FinalizedCharacterGeneration(deps.database, repository, { projectId: deps.projectId, epoch: deps.epoch }, assertCurrent, deps.transferOrigin)
  const reviewRevisions = new ReviewRevisionGeneration(deps.database, repository, { projectId: deps.projectId, epoch: deps.epoch }, assertCurrent,
    (table, id) => runtimeFreeze.isFrozen(table, id))
  const handleOf = (run: DurableGenerationRun): MainGenerationRunHandle => ({ projectId: run.binding.projectId,
    epoch: run.binding.epoch, rootActionId: run.rootActionId, runId: run.runId })
  const rootPolicy = (rootActionId: string): MainGenerationPolicy => {
    const runId = deps.database.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=? ORDER BY rowid LIMIT 1').pluck().get(rootActionId)
    if (typeof runId !== 'string') throw new Error('GENERATION_ROOT_MISSING')
    const policy = readMainGenerationPolicy(repository.get(runId).binding.sourceManifest.policy)
    if (policy.version !== MAIN_GENERATION_POLICY.version && !isDeepStrictEqual(policy.budget, repository.budget(rootActionId).policy))
      throw new Error('GENERATION_POLICY_BUDGET_MISMATCH')
    return policy
  }
  const requireRun = (handle: MainGenerationRunHandle, execution = false) => {
    assertCurrent()
    assertLegacyRunAccess(handle.runId)
    const run = repository.get(handle.runId)
    if (run.binding.projectId !== deps.projectId || !isDeepStrictEqual(handleOf(run), handle)) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    if (execution) assertAuthorFollowupWritable(run.runId)
    if (execution) {
      repository.assertBlueprintRecoveryWritable(run.runId)
      repository.assertPlotOutlineWritable(run.runId)
    }
    if (execution && run.binding.epoch !== deps.epoch) throw new Error('GENERATION_EPOCH_STALE')
    if (repository.isPrivatePlanningHistory(run.runId)) return run
    const policy = readMainGenerationPolicy(run.binding.sourceManifest.policy)
    if (policy.version !== MAIN_GENERATION_POLICY.version && !isDeepStrictEqual(policy.budget, rootPolicy(run.rootActionId).budget))
      throw new Error('GENERATION_POLICY_BUDGET_MISMATCH')
    return run
  }
  const attemptPurpose = (attemptId: string): string => {
    const row = deps.database.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(attemptId) as string | undefined
    return row ? String(JSON.parse(row).purpose ?? 'unknown') : 'unknown'
  }
  const runAttempts = (runId: string) => (deps.database.prepare('SELECT attempt_id,invocation_nonce,attempt_json,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(runId) as { attempt_id: string; invocation_nonce: string; attempt_json: string; usage_receipt_json: string }[])
    .map(row => ({ attemptId: row.attempt_id, invocationNonce: row.invocation_nonce, status: String(JSON.parse(row.attempt_json).status),
      purpose: String(JSON.parse(row.usage_receipt_json).purpose ?? 'unknown') }))
  const readFailedShortOutlineTask = (run: DurableGenerationRun, failedAttemptId: string): GenerationTask => {
    const decision = run.binding.sourceManifest.materialDecision as MaterialDecisionReceipt | undefined
    const first = runAttempts(run.runId)[0]
    if (run.binding.sourceManifest.operation !== 'chapter-draft' || !decision?.shortOutlinePromptHash
      || !first || first.attemptId !== failedAttemptId || first.purpose !== DRAFT_SHORT_OUTLINE_PURPOSE)
      throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_RETRY_UNAVAILABLE')
    const receipt = volatileReceipts.get(failedAttemptId) ?? repository.receipt(failedAttemptId)
    if (receipt.attempt.status !== 'settled' || receipt.failureCode || receipt.unsavedTail || !receipt.artifact
      || !(receipt.result?.finishReason === 'length' || receipt.result?.finishReason === 'stop' && !receipt.artifact.text.trim()))
      throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_RETRY_UNAVAILABLE')
    const usage: { replayTask?: GenerationTask; requestHash?: string } = JSON.parse(deps.database.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(failedAttemptId) as string)
    const task = usage.replayTask
    if (!task) throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_TASK_INVALID')
    assertSemanticGenerationTask(task)
    const prompts = task.messages.filter(message => message.role === 'user')
    if (task.purpose !== DRAFT_SHORT_OUTLINE_PURPOSE || task.output !== 'visible-text' || prompts.length !== 1
      || textHash(prompts[0]!.content) !== decision.shortOutlinePromptHash
      || textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash])) !== usage.requestHash)
      throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_TASK_INVALID')
    if (!compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))))
      throw new Error('GENERATION_SOURCE_CHANGED')
    return task
  }
  const assertShortOutlineRetryAvailable = (run: DurableGenerationRun, failedAttemptId: string) => {
    const task = readFailedShortOutlineTask(run, failedAttemptId)
    const budget = repository.budget(run.rootActionId)
    if (runAttempts(run.runId).length !== 1 || repository.readVisibleComposition(run.runId) || draftEffects.readCommit(run.runId)
      || !['running', 'paused', 'failed'].includes(run.status) || !['active', 'paused'].includes(budget.root.status)
      || budget.blockedCode || budget.attempts.some(attempt => ['reserved', 'dispatch-marked'].includes(attempt.status))
      || budget.attempts.filter(attempt => attempt.status !== 'cancelled-before-dispatch').length >= budget.policy.maxPhysicalRequests
      || budget.activeElapsedMs >= budget.policy.maxActiveElapsedMs)
      throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_RETRY_UNAVAILABLE')
    return task
  }
  const shortOutlineRetry = (run: DurableGenerationRun): ShortOutlineRetry => {
    const failedAttemptId = runAttempts(run.runId)[0]?.attemptId
    if (failedAttemptId) {
      try { assertShortOutlineRetryAvailable(run, failedAttemptId); return { kind: 'available', failedAttemptId } }
      catch { return { kind: 'unavailable' } }
    }
    return { kind: 'unavailable' }
  }
  /** 最近一次完整结束（stop、无失败码）的对账原始输出。 */
  const completedReconciliationOutput = (runId: string): string | null => {
    for (const attempt of runAttempts(runId).filter(item => item.purpose === DRAFT_RECONCILE_PURPOSE).reverse()) {
      const receipt = volatileReceipts.get(attempt.attemptId) ?? repository.receipt(attempt.attemptId)
      if (!receipt.failureCode && receipt.result?.finishReason === 'stop' && receipt.artifact?.text) return receipt.artifact.text
    }
    return null
  }
  const shortOutlineContext = (run: DurableGenerationRun): GenerationRecoveryContext['draftShortOutline'] => {
    const decision = run.binding.sourceManifest.materialDecision as MaterialDecisionReceipt | undefined
    if (!decision?.shortOutlinePromptHash) return undefined
    const attempts = runAttempts(run.runId).filter(attempt => attempt.status !== 'cancelled-before-dispatch')
    const outlines = attempts.filter(attempt => attempt.purpose === DRAFT_SHORT_OUTLINE_PURPOSE)
    const receipts = outlines.map(attempt => repository.receipt(attempt.attemptId))
    const completed = receipts.find(receipt => !receipt.failureCode && receipt.result?.finishReason === 'stop' && receipt.artifact?.text.trim())
    const firstDraft = attempts.find(attempt => attempt.purpose === 'chapter-draft')
    const usage = firstDraft ? deps.database.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(firstDraft.attemptId) as string : null
    const initialDraftTask = usage ? JSON.parse(usage).replayTask as GenerationTask | undefined : undefined
    return { artifactIds: receipts.flatMap(receipt => receipt.artifact ? [receipt.artifact.artifactId] : []),
      completedOutput: completed?.artifact?.text ?? null, promptHash: decision.shortOutlinePromptHash, retry: shortOutlineRetry(run),
      ...(initialDraftTask ? { initialDraftTask } : {}) }
  }
  const snapshotOf = (receipt: GenerationExecutionReceipt, visiblePurpose?: { purpose: string }): MainGenerationSnapshot | null => {
    const artifact = receipt.artifact
    if (!artifact) return null
    const terminal = ['settled', 'unknown', 'cancelled-before-dispatch'].includes(receipt.attempt.status)
    const status = !terminal ? 'running' : receipt.failureCode ? 'failed' : receipt.result?.finishReason === 'stop' ? 'completed'
      : receipt.attempt.status === 'cancelled-before-dispatch' || receipt.budget.root.status === 'cancelled' ? 'cancelled'
        : receipt.result?.finishReason ? 'failed' : 'unknown'
    const compositionEligible = ['settled', 'unknown'].includes(receipt.attempt.status) && !receipt.failureCode
      && receipt.budget.root.status !== 'cancelled' && ['stop', 'length'].includes(receipt.result?.finishReason ?? '')
      && Boolean(artifact.text.trim()) && (visiblePurpose !== undefined || deps.database.prepare("SELECT 1 FROM generation_artifacts WHERE artifact_id=? AND status<>'discarded'").pluck().get(artifact.artifactId) === 1)
      && ![DRAFT_RECONCILE_PURPOSE, DRAFT_SHORT_OUTLINE_PURPOSE].includes((visiblePurpose?.purpose ?? attemptPurpose(receipt.attempt.attemptId)) as typeof DRAFT_RECONCILE_PURPOSE)
    return { ...handleOf(receipt.run), epoch: artifact.epoch, artifactId: artifact.artifactId, attemptId: artifact.attemptId,
      ...(receipt.diagnostics ? { diagnostics: receipt.diagnostics } : {}),
      revision: artifact.revision, durableRevision: artifact.revision, text: artifact.text, textHash: artifact.textHash, status, compositionEligible }
  }
  /** 还没结束的请求；关闭作品时在关库前把它们记成已取消。 */
  const unrecordedCalls = new Set<() => void>()
  let physicalDispatches = 0
  const physicalIdleWaiters = new Set<() => void>()
  /** 每次真正发出的模型请求都记入运行侧页的 AI 调用记录，每次只记一行；记录只作诊断，写不进去也不改变生成结果。 */
  const recordedDispatch: GenerationRunServiceDependencies['dispatch'] = async (request, options) => {
    const { model, task, scheduling } = request as ProviderRequest, startedAt = Date.now()
    if (scheduling) scheduling.started = true
    const record = (success: boolean, usage: ProviderDispatchResult['usage'], errorMessage?: string) => {
      if (!unrecordedCalls.delete(recordCancelled)) return
      // 调用记录的「输出」与 OpenAI 一致含思考消耗；思考分开计费的协议（Gemini）在这里加回来。
      // 证据字段是供应商原样报的，不是非负整数就记为未知。
      const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
      const completion = usage === null ? null : count(usage.completionTokens)
      const reasoning = usage?.accounting !== 'separately-billed' || usage.reasoningTokens === null ? 0 : count(usage.reasoningTokens)
      const completionTokens = completion === null || reasoning === null ? null : completion + reasoning
      try {
        LLMHistoryRepository.logCall({ modelId: model.id, modelName: model.name || recordedModelName(model.modelName), purpose: task.purpose,
          promptTokens: usage?.promptTokens ?? null, completionTokens, totalTokens: usage?.totalTokens ?? null,
          durationMs: Math.max(0, Date.now() - startedAt), success, errorMessage }, deps.database)
      } catch (error) { console.warn('[AI Novel Writer] LLM call statistics were not recorded.', error) }
    }
    const recordCancelled = () => record(false, null, 'cancelled')
    unrecordedCalls.add(recordCancelled)
    physicalDispatches++
    const finishPhysical = () => {
      physicalDispatches--
      if (scheduling) {
        scheduling.finished = true
        if (scheduling.quarantineTimer) clearTimeout(scheduling.quarantineTimer)
        scheduling.permit.finish()
      }
      if (!physicalDispatches) {
        for (const resolve of physicalIdleWaiters) resolve()
        physicalIdleWaiters.clear()
      }
    }
    let flight: ProviderFlight | undefined
    try {
      let result: ProviderDispatchResult
      if (deps.dispatch) result = await deps.dispatch(request, options)
      else {
        flight = dispatchProvider(request, options)
        void flight.physical.then(finishPhysical)
        result = await flight.result
      }
      record(result.finishReason === 'stop', result.usage, result.finishReason === 'stop' ? undefined : `finish:${result.finishReason ?? 'unknown'}`)
      return result
    } catch (error) {
      if (options.signal.reason === GENERATION_STOPPED) recordCancelled()
      else record(false, null, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      if (!flight) finishPhysical()
    }
  }
  const service = createGenerationRunService({ repository, recoveryTails, dispatch: recordedDispatch,
    assertAdmission,
    onStopRoot: abortQueuedRoot,
    admitReservation: operation => deps.database.transaction(operation).immediate(),
    onReasoning: event => deps.onReasoning?.({ projectId: deps.projectId, epoch: deps.epoch, ...event }),
    validateRecovery: async (previous, next) => {
      assertCurrent()
      const current = deps.rebuildBinding(previous, currentModelReceipt(previous))
      return isDeepStrictEqual(current, next)
    },
    onSnapshot: event => {
      if (closed || event.storageFailed) return
      recordPerformanceCount('generation.receipt.calls')
      const snapshot = snapshotOf(measurePerformanceOperation('generation.receipt.ms', () => repository.receipt(event.attemptId)))
      if (snapshot) {
        recordPerformanceCount('generation.publish.calls')
        recordPerformanceTextBytes('generation.publish.utf8_bytes', snapshot.text)
        deps.onSnapshot?.({ ...snapshot, ...(event.diagnostics ? { diagnostics: event.diagnostics } : {}) })
      }
    },
  })
  const recoverInterrupted = !['runtime-feedback', 'workflow-driver', 'workflow-batch'].includes(deps.mode ?? 'legacy') && deps.recoverInterrupted !== false
  if (recoverInterrupted) service.recoverInterrupted()
  function currentModelReceipt(binding: RunBinding): SafeGenerationModelReceipt {
    const model = deps.loadModel(modelReceipt(binding).modelId)
    if (!model) throw new Error('GENERATION_MODEL_MISSING')
    return safeGenerationModelReceipt(createModelExecutionLeaseReceipt(model, { leaseId: 'read-only-evidence', createdAt: 0, expiresAt: 0 }))
  }
  const viewOf = (run: DurableGenerationRun): MainGenerationRunView => {
    const { budget, plotOutline, attempts } = repository.readRunView(run.runId)
    const preservedTails = recoveryTails.list(run.runId)
    const visibleIds = new Map(attempts.filter(item => item.candidate).map(item => [item.receipt.artifact!.artifactId, { purpose: item.usage.purpose ?? 'unknown' }]))
    const receipts = attempts.map(item => volatileReceipts.get(item.receipt.attempt.attemptId) ?? item.receipt)
    const candidates = receipts
      .filter(receipt => receipt.run.runId === run.runId && receipt.artifact && visibleIds.has(receipt.artifact.artifactId))
      .map(receipt => ({ ...snapshotOf(receipt, visibleIds.get(receipt.artifact!.artifactId))!, fingerprint: receipt.artifact!.fingerprint, nonReplayable: true as const }))
    const artifacts = candidates.filter(artifact => artifact.epoch === run.binding.epoch)
    const budgetDiagnostics: NonNullable<MainGenerationRunView['budgetDiagnostics']> = receipts.map(receipt => {
      const attempt = receipt.attempt
      const usage = receipt.result?.usage
      return {
        attemptId: attempt.attemptId, runId: receipt.run.runId, plannerVersion: receipt.budgetDecision?.policyVersion,
        requestedOutputTokens: attempt.requestedOutputTokens,
        reservedTokens: attempt.reservedTokens,
        actualState: attempt.status === 'cancelled-before-dispatch' ? 'not-dispatched' : attempt.status === 'settled' ? 'settled' : ['reserved', 'dispatch-marked'].includes(attempt.status) ? 'reserved' : 'unknown',
        actual: usage?.trusted ? { input: usage.inputTokens ?? null, completion: usage.completionTokens ?? null,
          reasoning: usage.reasoningTokens ?? null, total: usage.actualTokens ?? null } : null,
        finishReason: receipt.result?.finishReason ?? null, failureCode: receipt.failureCode ?? budget.blockedCode,
        reasons: receipt.budgetDecision?.reasons ?? [],
      }
    })
    return { handle: handleOf(run), status: run.status as MainGenerationRunView['status'], operation: run.binding.sourceManifest.operation as string,
      ...(plotOutline ? { plotOutline } : {}),
      budgetDiagnostics,
      nonReplayable: run.binding.epoch !== deps.epoch || run.status !== 'running' || !!budget.blockedCode
        || repository.isPrivatePlanningHistory(run.runId) || !!repository.readPlanningContinuation(run.runId)
        || !!(plotOutline && repository.readPlotOutlineAuthorEdit(run.runId)),
      budget: { maxAttempts: budget.policy.maxPhysicalRequests, maxRequestedOutputTokens: budget.policy.maxTokenLiability,
        maxRequestedOutputTokensPerAttempt: budget.policy.maxOutputPerRequest,
        deadlineAt: Date.now() + Math.max(0, budget.policy.maxActiveElapsedMs - budget.activeElapsedMs) },
      ledger: { policy: budget.policy, tokenLiability: budget.attempts.reduce((sum, attempt) => sum + tokenLiability(attempt), 0),
        physicalRequests: budget.attempts.filter(attempt => attempt.status !== 'cancelled-before-dispatch').length,
        activeElapsedMs: budget.activeElapsedMs, blockedCode: budget.blockedCode }, artifacts, candidates,
      ...(preservedTails.length ? { recoveryTails: preservedTails } : {}),
      unsavedTails: service.readUnsavedTails().filter(tail => budget.attempts.some(attempt => attempt.attemptId === tail.attemptId)) }
  }
  /** 本作品的全部运行，新的在前；只从库里取身份、状态与操作类型，不解析整份冻结上下文。 */
  const runSummaries = () => (deps.database.prepare(`SELECT run_id,root_action_id,status,
      json_extract(binding_json,'$.projectId','$.epoch','$.sourceManifest.operation','$.sourceManifest.batchId','$.sourceManifest.batchIntent') AS identity
      FROM generation_runs ORDER BY created_at_ms DESC, rowid DESC`).all() as { run_id: string; root_action_id: string; status: MainGenerationRunView['status']; identity: string }[])
    .map(row => {
      const [projectId, epoch, operation, batchId, batchIntent] = JSON.parse(row.identity) as [string, string, string | null, string | null, unknown]
      return { handle: { projectId, epoch, rootActionId: row.root_action_id, runId: row.run_id }, status: row.status, operation: operation ?? undefined,
        batchId, batchRoot: Boolean(batchIntent) }
    }).filter(run => run.handle.projectId === deps.projectId
      && (deps.mode === 'runtime-feedback' || !isGrantRun(run.handle.runId))
      && (deps.mode === 'workflow-driver' && isV1DriverRun(run.handle.runId)
        || deps.mode === 'workflow-batch' && isBatchDriverRun(run.handle.runId) || !isDriverRun(run.handle.runId)
        || isAuthorViewOwner && reviewRevisions.isBatchFollowupRun(run.handle.runId)))
  const list = (): MainGenerationRunSummary[] => {
    assertCurrent()
    return runSummaries().map(({ handle, status, operation }) => ({ handle, status, operation }))
  }
  // S10B：'materialDecision'/'materialDecisionHash' 只在**取得准入之后**才可能出现在真正
  // 运行的 manifest 上（prepare 阶段早于材料装配），因此与 selectedFinalizedDraftIds 同类，
  // 不参与「准备期冻结源未变」的比对。指纹侧的 contextSnapshotHash 本就被排除。
  const preparationProjection = (binding: RunBinding, excludeKnowledge = false) => ({
    manifest: Object.fromEntries(Object.entries(binding.sourceManifest).filter(([key]) => !['selectedDraftIds', 'selectedFinalizedDraftIds', 'materialDecision', 'materialDecisionHash', ...(excludeKnowledge ? ['knowledgeSnapshot'] : [])].includes(key))),
    fingerprint: Object.fromEntries(Object.entries(binding.fingerprint).filter(([key]) => !['contextSnapshotHash', 'dependencyHash'].includes(key))),
    sources: binding.sourceRefs.filter(ref => !/^(draft|finalized):/.test(ref.sourceId) && (!excludeKnowledge || !/^(kb:|knowledge-selection$)/.test(ref.sourceId))),
  })
  const materialDecisionProjection = (binding: RunBinding) => ({
    manifest: Object.fromEntries(Object.entries(binding.sourceManifest)
      .filter(([key]) => key !== 'materialDecision' && key !== 'materialDecisionHash')),
    fingerprint: Object.fromEntries(Object.entries(binding.fingerprint).filter(([key]) => key !== 'contextSnapshotHash')),
    sources: binding.sourceRefs,
  })
  const preparationMatches = (previous: RunBinding, current: RunBinding, excludeKnowledge = false) =>
    isDeepStrictEqual(preparationProjection(previous, excludeKnowledge), preparationProjection(current, excludeKnowledge))
    && previous.sourceRefs.filter(ref => /^(draft|finalized):/.test(ref.sourceId))
      .every(ref => isDeepStrictEqual(ref, current.sourceRefs.find(candidate => candidate.sourceId === ref.sourceId)))
  const preparedKnowledge = (preparationId: string): GenerationKnowledgeSnapshot => {
    assertCurrent()
    const prepared = preparations.get(preparationId)
    if (!prepared) throw new Error('GENERATION_DRAFT_PREPARATION_REQUIRED')
    return structuredClone(prepared.knowledgeSnapshot)
  }
  const draftPreparationBinding = (request: PrepareDraftContextRequest, knowledgeSnapshot?: GenerationKnowledgeSnapshot): RunBinding => {
    assertCurrent()
    if (!request || typeof request.query !== 'string' || knowledgeSnapshot && request.query !== knowledgeSnapshot.query
      || Object.keys(request).some(key => !['chapterNumber', 'modelId', 'promptKeys', 'skillStages', 'authorInputs', 'query', 'selectedDraftIds', 'batchId'].includes(key))) throw new Error('GENERATION_DRAFT_PREPARATION_INVALID')
    if (request.batchId) assertLegacyRunAccess(request.batchId)
    const model = deps.loadModel(request.modelId)
    if (!model) throw new Error('GENERATION_MODEL_MISSING')
    const receipt = safeGenerationModelReceipt(createModelExecutionLeaseReceipt(model, { leaseId: 'read-only-evidence', createdAt: 0, expiresAt: 0 }))
    const selection = { operation: 'chapter-draft', uiActionNonce: 'prepare-only', modelId: request.modelId, chapterNumber: request.chapterNumber,
      selectedDraftIds: request.selectedDraftIds, selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: Array.from({ length: 6 }, (_, index) => request.chapterNumber + index),
      promptKeys: request.promptKeys, skillStages: request.skillStages, authorInputs: request.authorInputs, output: 'visible-text' as const,
      ...(request.batchId ? { batchId: request.batchId } : {}), ...(knowledgeSnapshot ? { knowledgeSnapshot: structuredClone(knowledgeSnapshot) } : {}) }
    const policy = request.batchId ? rootPolicy(draftEffects.readBatch(request.batchId, deps.projectId).rootHandle.rootActionId)
      : newMainGenerationPolicy(selection, model)
    return deps.buildBinding(selection, receipt, policy)
  }
  const prepareDraftContext = (request: PrepareDraftContextRequest, knowledgeSnapshot: GenerationKnowledgeSnapshot, beforeKnowledgeRead?: RunBinding): PreparedDraftContext => {
    const { binding, selectedDrafts } = deps.database.transaction(() => {
      const binding = draftPreparationBinding(request, knowledgeSnapshot)
      if (beforeKnowledgeRead && !preparationMatches(beforeKnowledgeRead, binding, true)) throw new Error('GENERATION_DRAFT_PREPARATION_CHANGED')
      const selectedDrafts = request.selectedDraftIds.map(draftId => {
        const row = deps.database.prepare('SELECT d.chapter_number,d.version,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(draftId) as { chapter_number: number; version: number; body: string }
        return { draftId, chapterNumber: row.chapter_number, version: row.version, contentHash: textHash(row.body), content: row.body }
      })
      return { binding, selectedDrafts }
    })()
    const preparationId = randomUUID()
    if (preparations.size >= 64) preparations.delete(preparations.keys().next().value!)
    preparations.set(preparationId, { binding, knowledgeSnapshot: structuredClone(knowledgeSnapshot) })
    return { preparationId, knowledgeSnapshot: structuredClone(knowledgeSnapshot), selectedDrafts }
  }
  const begin = (selection: (BeginGenerationRequest | AgentBeginSelection) & { editorInlineInput?: EditorInlineInput; finalizationGenerationSlot?: FinalizationGenerationSlot; graphGenerationInput?: GraphGenerationInput; graphGenerationKey?: string; legacyRosterKey?: string; planningFeedbackInput?: PlanningFeedbackGenerationInput }, batchInitialization = false, agentInitialization = false, editorInitialization = false, finalizationInitialization = false, graphInitialization = false, legacyInitialization = false, planningInitialization = false): MainGenerationRunView => {
    assertAdmission()
    if (!selection || typeof selection.operation !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(selection.operation)
      || !Array.isArray(selection.promptKeys) || selection.promptKeys.length === 0
      || Object.hasOwn(selection, 'parentRootActionId') && (typeof selection.parentRootActionId !== 'string' || !selection.parentRootActionId.trim())
      || typeof selection.uiActionNonce !== 'string' || !selection.uiActionNonce.trim() || selection.uiActionNonce.length > 256
      || Object.keys(selection).some(key => !['operation', 'uiActionNonce', 'modelId', 'chapterNumber', 'selectedDraftIds', 'selectedFinalizedDraftIds', 'selectedBlueprintChapterNumbers', 'promptKeys', 'skillStages', 'authorInputs', 'output', 'outputOverrides', 'parentRootActionId', 'continueDirectoryOperationId', 'batchId', 'batchIntent', 'preparationId', 'finalizedCharacterContextId', 'reviewRevisionContextId', 'agentWorkflowRegistrationId', 'materialDecision', 'importSlot', 'importExecution', ...(agentInitialization ? ['agentInput', 'agentSession'] : []), ...(editorInitialization ? ['editorInlineInput'] : []), ...(finalizationInitialization ? ['finalizationGenerationSlot'] : []), ...(graphInitialization ? ['graphGenerationInput', 'graphGenerationKey'] : []), ...(legacyInitialization ? ['legacyRosterKey'] : []), ...(planningInitialization ? ['planningFeedbackInput'] : [])].includes(key))) throw new Error('GENERATION_BEGIN_INVALID')
    if (selection.batchId) assertLegacyRunAccess(selection.batchId)
    const protectedReviewParent = isAuthorViewOwner && selection.parentRootActionId && selection.reviewRevisionContextId
      && (deps.database.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=?').all(selection.parentRootActionId) as { run_id: string }[])
        .some(row => isBatchDriverRun(row.run_id))
    const authorFollowup = protectedReviewParent ? reviewRevisions.admitBatchFollowup(selection) : undefined
    if (selection.parentRootActionId && !authorFollowup) assertLegacyParentAccess(selection.parentRootActionId)
    if (selection.operation === 'planning-feedback' && !planningInitialization) throw new Error('GENERATION_FEEDBACK_ADMISSION_REQUIRED')
    if (selection.operation === 'editor-inline' && !editorInitialization) throw new Error('GENERATION_EDITOR_ADMISSION_REQUIRED')
    if (['finalized-chapter-notes', 'finalized-character-state'].includes(selection.operation) && !finalizationInitialization) throw new Error('GENERATION_FINALIZATION_ADMISSION_REQUIRED')
    if (Object.values(graphOperations).includes(selection.operation as typeof graphOperations[keyof typeof graphOperations]) && !graphInitialization) throw new Error('GENERATION_GRAPH_ADMISSION_REQUIRED')
    if (selection.operation === 'legacy-character-roster-repair' && !legacyInitialization) throw new Error('GENERATION_LEGACY_ADMISSION_REQUIRED')
    const importAdmission = imports.admit(selection)
    if (importAdmission?.existing) return viewOf(importAdmission.existing)
    if (importAdmission) selection = { ...selection, uiActionNonce: importSlotNonce(importGenerationSlotKey(selection.importSlot!), importAdmission.retryOf),
      ...(importAdmission.parentRootActionId ? { parentRootActionId: importAdmission.parentRootActionId } : {}),
      ...(importAdmission.modelId ? { modelId: importAdmission.modelId } : {}) }
    if (selection.operation === 'agent-round' && !agentInitialization) throw new Error('GENERATION_AGENT_ADMISSION_REQUIRED')
    const agentWorkflow = agentInitialization ? undefined : agents.admitWorkflow(selection)
    if (selection.parentRootActionId && repository.budget(selection.parentRootActionId).root.operation === 'editor-inline') throw new Error('GENERATION_EDITOR_CHILD_FORBIDDEN')
    if (selection.parentRootActionId && Object.values(graphOperations).includes(repository.budget(selection.parentRootActionId).root.operation as typeof graphOperations[keyof typeof graphOperations])) throw new Error('GENERATION_GRAPH_CHILD_FORBIDDEN')
    if (selection.parentRootActionId && repository.budget(selection.parentRootActionId).root.operation === 'legacy-character-roster-repair') throw new Error('GENERATION_LEGACY_CHILD_FORBIDDEN')
    if (selection.parentRootActionId && repository.budget(selection.parentRootActionId).root.operation === 'planning-feedback') throw new Error('GENERATION_FEEDBACK_CHILD_FORBIDDEN')
    if (agentWorkflow?.existing) return viewOf(repository.get(agentWorkflow.existing.runId))
    generationOutputContract(selection)
    const finalizedCharacterContextHash = finalizedCharacters.admit(selection)
    const reviewRevision = authorFollowup ?? reviewRevisions.admit(selection)
    if (selection.batchIntent && !batchInitialization) throw new Error('GENERATION_BATCH_INTENT_MAIN_ONLY')
    const batch = selection.batchId ? draftEffects.readBatch(selection.batchId, deps.projectId) : undefined
    if (batch) {
      if (selection.parentRootActionId !== batch.rootHandle.rootActionId || selection.operation !== 'chapter-draft'
        || selection.chapterNumber !== batch.nextChapterNumber || selection.batchIntent || selection.continueDirectoryOperationId
        || batch.completedChapters.some(item => item.chapterNumber === selection.chapterNumber)) throw new Error('GENERATION_BATCH_PROGRESS_CONFLICT')
      const predecessor = batch.completedChapters.find(item => item.chapterNumber === selection.chapterNumber! - 1)
      if (selection.selectedDraftIds.some(id => id !== predecessor?.draftId || batch.mode !== 'draft_review')) throw new Error('GENERATION_BATCH_LINEAGE_INVALID')
      if (predecessor && batch.mode === 'draft_review' && !selection.selectedDraftIds.includes(predecessor.draftId)) throw new Error('GENERATION_BATCH_LINEAGE_INVALID')
      if (predecessor && batch.mode === 'auto_finalize' && !selection.selectedFinalizedDraftIds.includes(predecessor.draftId)) throw new Error('GENERATION_BATCH_LINEAGE_INVALID')
      for (const input of batch.authorInputs) {
        if (!isDeepStrictEqual(input, selection.authorInputs?.find(item => item.id === input.id))) throw new Error('GENERATION_BATCH_AUTHOR_INPUT_CHANGED')
      }
    }
    const continuation = selection.continueDirectoryOperationId === undefined ? undefined
      : repository.readDirectoryProgress(selection.continueDirectoryOperationId)
    if (selection.continueDirectoryOperationId !== undefined && (!continuation?.remainingRange || selection.parentRootActionId
      || selection.output !== 'structured-data'
      // Selected rows also include preceding chapters consumed as source dependencies.
      // The formal target is separately authorized by the durable remainingRange.
      || Array.from({ length: continuation.remainingRange.endChapter - continuation.remainingRange.startChapter + 1 }, (_, index) => continuation.remainingRange!.startChapter + index)
        .some(chapter => !selection.selectedBlueprintChapterNumbers?.includes(chapter)))) throw new Error('GENERATION_DIRECTORY_CONTINUATION_INVALID')
    if (continuation) {
      const originalInputs = repository.get(continuation.sourceHandle.runId).binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined
      for (const id of ['directory:author-config', 'directory:pacing-guidance']) {
        const original = originalInputs?.find(input => input.id === id)
        if (!original || !isDeepStrictEqual(original, selection.authorInputs?.find(input => input.id === id)))
          throw new Error('GENERATION_DIRECTORY_AUTHOR_INPUT_CHANGED')
      }
    }
    const lease = deps.leases.begin(selection.modelId)
    try {
      const parentRootActionId = continuation?.sourceHandle.rootActionId ?? selection.parentRootActionId
      const scope = planningGenerationScope(selection)
      if (scope) {
        const rangeEnd = scope.kind === 'directory' ? scope.requestedRange.endChapter : scope.intent.synopsisRange?.to
        if (rangeEnd !== undefined && rangeEnd > (ProjectCoreRepository.get(deps.database)?.totalChapters ?? 0))
          throw new Error('GENERATION_PLANNING_RANGE_INVALID')
        const targets = selection.authorInputs?.filter(input => input.id === 'planning:target-units') ?? []
        if (targets.length > 1) throw new Error('GENERATION_PLANNING_TARGET_INVALID')
        const targetUnits = parsePlanningTargetUnits(targets.length ? Number(targets[0].text) : undefined)
        selection = { ...selection, authorInputs: [...(selection.authorInputs ?? []).filter(input => input.id !== 'planning:target-units'),
          { id: 'planning:target-units', text: String(targetUnits) }] }
      }
      let policy = parentRootActionId ? rootPolicy(parentRootActionId) : newMainGenerationPolicy(selection, deps.leases.resolve(lease.leaseId), importAdmission?.chapterCount)
      if (deps.mode === 'runtime-feedback' && planningInitialization) policy = { ...policy, budget: { ...policy.budget, maxPhysicalRequests: 1 } }
      if (parentRootActionId && agentWorkflow && scope) policy = { ...policy, planning: scope }
      else if (parentRootActionId && policy.planning) {
        if (continuation && policy.planning.kind === 'directory' && scope?.kind === 'directory') {
          if (!isDeepStrictEqual(continuation.remainingRange, { startChapter: scope.requestedRange.startChapter, endChapter: scope.requestedRange.endChapter }))
            throw new Error('GENERATION_DIRECTORY_CONTINUATION_RANGE_CHANGED')
        } else if (scope?.kind === 'architecture' && policy.planning.kind === 'architecture'
          ? !isDeepStrictEqual(scope.intent, policy.planning.intent) : !isDeepStrictEqual(scope, policy.planning)) throw new Error('GENERATION_PLANNING_INTENT_CHANGED')
        const rootRunId = deps.database.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=? ORDER BY rowid LIMIT 1').pluck().get(parentRootActionId) as string
        const target = (repository.get(rootRunId).binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined)?.find(input => input.id === 'planning:target-units')
        if (target && !isDeepStrictEqual(target, selection.authorInputs?.find(input => input.id === target.id))) throw new Error('GENERATION_PLANNING_TARGET_CHANGED')
      }
      const prepared = selection.preparationId ? preparations.get(selection.preparationId) : undefined
      if (selection.preparationId && (!prepared || selection.operation !== 'chapter-draft')) throw new Error('GENERATION_DRAFT_PREPARATION_REQUIRED')
      if (selection.operation === 'chapter-draft' && selection.preparationId && !selection.materialDecision)
        throw new Error('GENERATION_MATERIAL_DECISION_REQUIRED')
      const binding = deps.buildBinding({ ...selection, ...(prepared ? { knowledgeSnapshot: prepared.knowledgeSnapshot } : {}),
        ...(finalizedCharacterContextHash ? { finalizedCharacterContextHash } : {}),
        ...(reviewRevision ? { reviewRevisionContext: reviewRevision.context } : {}) }, safeGenerationModelReceipt(lease), policy)
      if (!isDeepStrictEqual(binding.sourceManifest.policy, policy)) throw new Error('GENERATION_POLICY_BINDING_MISMATCH')
      if (prepared && !preparationMatches(prepared.binding, binding)) throw new Error('GENERATION_DRAFT_PREPARATION_CHANGED')
      if (binding.projectId !== deps.projectId || binding.epoch !== deps.epoch) throw new Error('GENERATION_BINDING_INVALID')
      const run = deps.database.transaction(() => {
      if (authorFollowup) reviewRevisions.admitBatchFollowup(selection)
      if (selection.importSlot) {
        const existing = imports.find(selection.importSlot)
        if (existing && !imports.retryable(existing)) return existing
      }
      if (selection.finalizationGenerationSlot) {
        const existing = finalizations.find(selection.finalizationGenerationSlot)
        if (existing && !finalizations.retryable(existing) && selection.uiActionNonce !== `finalization:${finalizationSlotKey(selection.finalizationGenerationSlot)}:retry:${existing.runId}`) return existing
        if (selection.parentRootActionId) repository.activateRootForCommittedStage(selection.parentRootActionId, binding)
      }
      if (batch) repository.activateRootForCommittedStage(batch.rootHandle.rootActionId, binding)
      if (reviewRevision?.parentRootActionId) repository.activateRootForCommittedStage(reviewRevision.parentRootActionId, binding)
      if (agentInitialization && selection.parentRootActionId) repository.activateRootForCommittedStage(selection.parentRootActionId, binding)
      if (agentWorkflow) repository.activateRootForCommittedStage(agentWorkflow.parentRootActionId, binding)
      if (importAdmission?.parentRootActionId) repository.activateRootForCommittedStage(importAdmission.parentRootActionId, binding)
      if (continuation && !continuation.continuationHandle) repository.activateRootForCommittedStage(continuation.sourceHandle.rootActionId, binding)
      const budget = parentRootActionId ? repository.budget(parentRootActionId).policy : policy.budget
      const next = service.open({ ...binding, operation: selection.operation, uiActionNonce: selection.uiActionNonce,
        frozenInputHash: textHash(JSON.stringify([binding.fingerprint, binding.contextSnapshotId, selection.output])),
        budget, parentRootActionId })
      if (parentRootActionId && repository.readPlotOutline(next.runId)) {
        const rows = deps.database.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=?').all(parentRootActionId) as { run_id: string }[]
        if (rows.some(row => row.run_id !== next.runId && repository.readPlotOutline(row.run_id))) throw new Error('GENERATION_PLOT_OUTLINE_RECOVERY_REQUIRED')
      }
      if (continuation?.continuationHandle && continuation.continuationHandle.runId !== next.runId) throw new Error('GENERATION_DIRECTORY_CONTINUATION_EXISTS')
      if (batch?.currentChapterRunHandle && batch.currentChapterRunHandle.runId !== next.runId) throw new Error('GENERATION_BATCH_RECOVERY_REQUIRED')
      if (continuation && !continuation.continuationHandle) repository.bindDirectoryContinuation(continuation.operationId, handleOf(next))
      if (selection.agentWorkflowRegistrationId) agents.recordWorkflowChild(selection.agentWorkflowRegistrationId, handleOf(next))
      if (authorFollowup) reviewRevisions.assertBatchFollowupRun(next.runId)
      return next
      }).immediate()
      if (authorFollowup) { authorFollowupRuns.add(run.runId); executableAuthorFollowups.add(run.runId) }
      if (run.binding.epoch === deps.epoch && !runLeases.has(run.runId)) runLeases.set(run.runId, lease.leaseId)
      else deps.leases.close(lease.leaseId)
      return viewOf(run)
    } catch (error) { deps.leases.close(lease.leaseId); throw error }
  }
  const outcomeOf = (receipt: GenerationExecutionReceipt, task: Pick<GenerationTask, 'purpose'>): MainGenerationExecuteReceipt => {
    const frozenModel = modelReceipt(receipt.run.binding), budget = receipt.budget
    const stored = receipt.result?.finishReason
    const finishReason: LLMFinishReason = receipt.failureCode ? 'error'
      : ['stop', 'length', 'content_filter', 'error', 'unknown'].includes(stored ?? '') ? stored as LLMFinishReason : 'unknown'
    const evidence = frozenModel.capabilityEvidence
    const safeFailureCode = RENDERER_SAFE_FAILURE_CODES.find(code => code === receipt.failureCode)
    const details: GenerationAttemptReceipt = { purpose: task.purpose,
      ...(receipt.diagnostics ? { diagnostics: receipt.diagnostics } : {}),
      ...(safeFailureCode ? { failureCode: safeFailureCode } : {}),
      ...(receipt.artifact ? { visibleArtifact: { artifactId: receipt.artifact.artifactId, attemptId: receipt.attempt.attemptId,
        revision: receipt.artifact.revision, textHash: receipt.artifact.textHash } } : {}),
      model: { id: frozenModel.modelId, configurationRevision: frozenModel.modelRevision, endpointFingerprint: frozenModel.endpointFingerprint },
      capabilities: { contextWindowTokens: evidence.contextWindowTokens, maxOutputTokens: evidence.maxOutputTokens,
        reasoning: evidence.reasoning, structuredOutput: evidence.structuredOutput, usage: evidence.usage, source: evidence.source },
      budget: { attempt: budget.attempts.findIndex(attempt => attempt.attemptId === receipt.attempt.attemptId) + 1,
        maxAttempts: budget.policy.maxPhysicalRequests, requestedOutputTokens: receipt.attempt.requestedOutputTokens,
        cumulativeRequestedOutputTokens: budget.attempts.reduce((sum, attempt) => sum + (attempt.status === 'cancelled-before-dispatch' ? 0 : attempt.requestedOutputTokens), 0),
        maxRequestedOutputTokens: budget.policy.maxTokenLiability, maxRequestedOutputTokensPerAttempt: budget.policy.maxOutputPerRequest,
        deadlineAt: Date.now() + Math.max(0, budget.policy.maxActiveElapsedMs - budget.activeElapsedMs) }, finishReason }
    const content = receipt.artifact?.text ?? ''
    return { outcome: finishReason === 'stop' ? { status: 'completed', content, finishReason, receipt: details }
      : { status: 'incomplete', content, finishReason, receipt: details }, run: viewOf(repository.get(receipt.run.runId)) }
  }
  const execute = async (request: ExecuteGenerationRequest, agentExecution = false, importExecution = false, editorExecution = false, finalizationExecution = false, graphExecution = false, legacyExecution = false, shortOutlineRetryAttemptId?: string, planningExecution = false, driverExecution = false): Promise<MainGenerationExecuteReceipt> => {
    assertAdmission()
    const run = requireRun(request.handle, true)
    if (isDriverRun(run.runId) && !driverExecution && !authorFollowupRuns.has(run.runId)) throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
    if (run.binding.sourceManifest.operation === 'planning-feedback' && !planningExecution) throw new Error('GENERATION_FEEDBACK_ADMISSION_REQUIRED')
    if (run.binding.sourceManifest.operation === 'agent-round' && !agentExecution) throw new Error('GENERATION_AGENT_ADMISSION_REQUIRED')
    if (run.binding.sourceManifest.importSlot && !importExecution) throw new Error('GENERATION_IMPORT_ADMISSION_REQUIRED')
    if (run.binding.sourceManifest.operation === 'editor-inline' && !editorExecution) throw new Error('GENERATION_EDITOR_ADMISSION_REQUIRED')
    if (['finalized-chapter-notes', 'finalized-character-state'].includes(run.binding.sourceManifest.operation as string) && !finalizationExecution) throw new Error('GENERATION_FINALIZATION_ADMISSION_REQUIRED')
    if (Object.values(graphOperations).includes(run.binding.sourceManifest.operation as typeof graphOperations[keyof typeof graphOperations]) && !graphExecution) throw new Error('GENERATION_GRAPH_ADMISSION_REQUIRED')
    if (run.binding.sourceManifest.operation === 'legacy-character-roster-repair' && !legacyExecution) throw new Error('GENERATION_LEGACY_ADMISSION_REQUIRED')
    assertSemanticGenerationTask(request.task)
    const task = structuredClone(request.task)
    if (['generate-plot-outline', 'chapter-blueprint-directory'].includes(String(run.binding.sourceManifest.operation))
      && (run.binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined)?.some(input => input.id === 'planning:target-units')) {
      const target = (run.binding.sourceManifest.authorInputs as GenerationAuthorInput[]).find(input => input.id === 'planning:target-units')!
      const language = deps.database.prepare("SELECT writing_language FROM project_core WHERE id='main'").pluck().get() === 'en-US' ? 'en-US' : 'zh-CN'
      const instruction = planningTargetInstruction(run.binding.sourceManifest.operation === 'generate-plot-outline' ? 'outline' : 'blueprint', parsePlanningTargetUnits(Number(target.text)), language)
      if (!task.messages.some(message => message.role === 'system' && message.content.includes(instruction)))
        task.messages = [...task.messages, { role: 'system', content: instruction }]
    }
    const materialDecision = run.binding.sourceManifest.materialDecision as MaterialDecisionReceipt | undefined
    const materialOperation = String(run.binding.sourceManifest.operation)
    if ((!materialDecision && ['review-chapter', 'refine-draft', 'refine-from-review'].includes(materialOperation))
      || !materialDecision && materialOperation === 'chapter-draft' && run.binding.sourceManifest.preparationId)
      throw new Error('GENERATION_MATERIAL_DECISION_REQUIRED')
    let reconciliationInjected = false
    if (materialDecision) {
      const prior = runAttempts(run.runId).filter(attempt => attempt.status !== 'cancelled-before-dispatch')
      const userMessages = task.messages.filter(message => message.role === 'user')
      const userPrompt = userMessages.length === 1 ? userMessages[0]!.content : null
      // 写稿首个物理请求可以是生成前定稿对账：只能有一次、只能最先，提示须与收据绑定的哈希一致。
      const reconciliationHash = materialOperation === 'chapter-draft' ? materialDecision.reconciliationPromptHash : undefined
      const onlyReconciled = !!reconciliationHash && prior.length > 0 && prior.every(attempt => attempt.purpose === DRAFT_RECONCILE_PURPOSE)
      if (materialDecision.shortOutlinePromptHash) {
        const outline = shortOutlineContext(run)!
        if (materialOperation !== 'chapter-draft') throw new Error('GENERATION_MATERIAL_PROMPT_MISMATCH')
        if (task.purpose === DRAFT_SHORT_OUTLINE_PURPOSE) {
          if (userPrompt === null || textHash(userPrompt) !== materialDecision.shortOutlinePromptHash)
            throw new Error('GENERATION_MATERIAL_PROMPT_MISMATCH')
        } else {
          if (!outline.completedOutput) throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_REQUIRED')
          const original = outline.initialDraftTask
          if (task.purpose === 'chapter-draft') {
            const stripped = userPrompt === null ? null : stripDraftShortOutlineBlock(userPrompt, outline.completedOutput)
            if (stripped === null || textHash(stripped) !== materialDecision.promptHash
              || original && !isDeepStrictEqual(original, task)) throw new Error('GENERATION_MATERIAL_PROMPT_MISMATCH')
          } else if (!original || !['chapter-draft-continuation', 'chapter-draft-no-progress-recovery', 'chapter-draft-condense'].includes(task.purpose)
            || !task.messages.some(message => message.role === 'user' && ['zh-CN', 'en-US'].some(language => message.content.includes(draftShortOutlineBlock(language as 'zh-CN' | 'en-US', outline.completedOutput!))))
            || !isDeepStrictEqual(task.messages.filter(message => message.role === 'system'), original.messages.filter(message => message.role === 'system')))
            throw new Error('GENERATION_MATERIAL_PROMPT_MISMATCH')
        }
      } else if (task.purpose === DRAFT_SHORT_OUTLINE_PURPOSE) {
        throw new Error('GENERATION_MATERIAL_PROMPT_MISMATCH')
      } else if (task.purpose === DRAFT_RECONCILE_PURPOSE) {
        const replay = prior.length === 1 && prior[0]!.invocationNonce === request.invocationNonce
        if (!reconciliationHash || prior.length && !replay || userPrompt === null || textHash(userPrompt) !== reconciliationHash)
          throw new Error('GENERATION_MATERIAL_PROMPT_MISMATCH')
      } else if (!prior.length || onlyReconciled) {
        // 首稿提示：与收据的 promptHash 完全一致，或恰好多出由已完成对账输出重算的注入块。
        const reconciliationOutput = onlyReconciled ? completedReconciliationOutput(run.runId) : null
        const stripped = userPrompt !== null && reconciliationOutput !== null ? stripDraftReconciliationBlock(userPrompt, reconciliationOutput) : null
        if (task.purpose !== run.binding.sourceManifest.operation || userPrompt === null
          || textHash(userPrompt) !== materialDecision.promptHash && (stripped === null || textHash(stripped) !== materialDecision.promptHash))
          throw new Error('GENERATION_MATERIAL_PROMPT_MISMATCH')
        reconciliationInjected = userPrompt !== null && textHash(userPrompt) !== materialDecision.promptHash
      }
    }
    const contract = run.binding.sourceManifest.outputContract
    const composite = contract as { primary?: string; overrides?: { purpose: string; output: string }[] }
    const expectedOutput = typeof contract === 'string' ? contract : composite.overrides?.find(item => item.purpose === task.purpose)?.output ?? composite.primary
    if (task.output !== expectedOutput) throw new Error('GENERATION_OUTPUT_CONTRACT_CHANGED')
    const requestHash = textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
    const key = JSON.stringify([run.runId, request.invocationNonce])
    const inFlight = pending.get(key)
    if (inFlight) {
      if (inFlight.hash !== requestHash) throw new Error('GENERATION_INVOCATION_CONFLICT')
      return inFlight.promise
    }
    const existing = repository.findInvocation(run.runId, request.invocationNonce, requestHash)
    if (existing && (task.purpose === DRAFT_SHORT_OUTLINE_PURPOSE || existing.attempt.status !== 'dispatch-marked' && existing.attempt.status !== 'reserved')) return outcomeOf(volatileReceipts.get(existing.attempt.attemptId) ?? existing, task)
    if (authorFollowupRuns.has(run.runId) && reviewRevisions.hasUnknownDelivery(run.runId))
      throw new Error('GENERATION_REVIEW_RECOVERY_COPY_ONLY')
    repository.assertPlotOutlineRequest(run.runId, task.purpose, task)
    if (task.purpose === DRAFT_SHORT_OUTLINE_PURPOSE && runAttempts(run.runId).length) {
      if (!shortOutlineRetryAttemptId) throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_ALREADY_ATTEMPTED')
      const original = assertShortOutlineRetryAvailable(run, shortOutlineRetryAttemptId)
      if (request.invocationNonce !== `draft-short-outline-retry:${shortOutlineRetryAttemptId}` || !isDeepStrictEqual(task, original))
        throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_TASK_INVALID')
    }
    reviewRevisions.assertMutable(run.runId)
    imports.assertMutable(run)
    finalizations.assertMutable(run)
    graphs.assertMutable(run)
    legacyRosters.assertMutable(run)
    const operation = (async () => {
    let scheduled: ScheduledDispatch | undefined
    let queuedController: AbortController | undefined
    try {
    const assertFrozenSources = () => {
      const current = deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))
      // 途中在设置里保存了模型是作者最常见的来源变化，单列一个码，界面才能说清是模型变了。
      // 用冻结的模型凭据再重建一次：仍与原绑定一致才是只有模型变了；作品设定等也变了时报通用码。
      if (!isDeepStrictEqual(current, run.binding)) throw new Error(isDeepStrictEqual(deps.rebuildBinding(run.binding, modelReceipt(run.binding)), run.binding)
        ? 'GENERATION_SOURCE_CHANGED_MODEL' : 'GENERATION_SOURCE_CHANGED')
    }
    assertFrozenSources()
    const leaseId = runLeases.get(run.runId)
    if (!leaseId) throw new Error('GENERATION_RESUME_REQUIRED')
    const model = deps.leases.resolve(leaseId)
    const dispatchAdmission = () => {
      assertAdmission()
      const latest = requireRun(request.handle, true)
      if (!isDeepStrictEqual(latest.binding, run.binding)) throw new Error('GENERATION_SOURCE_CHANGED')
      reviewRevisions.assertMutable(latest.runId)
      imports.assertMutable(latest)
      finalizations.assertMutable(latest)
      graphs.assertMutable(latest)
      legacyRosters.assertMutable(latest)
      if (authorFollowupRuns.has(latest.runId) && reviewRevisions.hasUnknownDelivery(latest.runId))
        throw new Error('GENERATION_REVIEW_RECOVERY_COPY_ONLY')
      repository.assertPlotOutlineRequest(latest.runId, task.purpose, task)
      if (task.purpose === DRAFT_SHORT_OUTLINE_PURPOSE && runAttempts(latest.runId).length) {
        if (!shortOutlineRetryAttemptId) throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_ALREADY_ATTEMPTED')
        if (!isDeepStrictEqual(task, assertShortOutlineRetryAvailable(latest, shortOutlineRetryAttemptId)))
          throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_TASK_INVALID')
      }
      assertFrozenSources()
      if (runLeases.get(latest.runId) !== leaseId) throw new Error('GENERATION_RESUME_REQUIRED')
      const frozenModel = deps.leases.resolve(leaseId)
      const receipt = safeGenerationModelReceipt(createModelExecutionLeaseReceipt(frozenModel, { leaseId: 'read-only-evidence', createdAt: 0, expiresAt: 0 }))
      if (!isDeepStrictEqual(receipt, modelReceipt(run.binding))) throw new Error('GENERATION_MODEL_CHANGED')
      const budget = repository.budget(latest.rootActionId)
      if (latest.status === 'cancelled' || budget.root.status === 'cancelled') throw new Error('GENERATION_ACTION_CANCELLED')
      if (latest.status !== 'running' || budget.root.status !== 'active' || budget.blockedCode) throw new Error('GENERATION_DISPATCH_BLOCKED')
      if (rootBudgetExhausted(budget.policy, budget.attempts, budget.activeElapsedMs)) throw new Error('ROOT_BUDGET_EXHAUSTED')
      if (queuedController?.signal.aborted) throw new Error('GENERATION_CANCELLED')
    }
    if (deps.scheduling) {
      queuedController = new AbortController()
      queuedExecutions.set(key, { rootId: run.rootActionId, controller: queuedController })
      const lane: SchedulerLane = !authorFollowupRuns.has(run.runId) && (driverExecution || isDriverRun(run.runId) || run.binding.sourceManifest.batchId
        || run.binding.sourceManifest.batchIntent || importExecution || agentExecution || finalizationExecution) ? 'background' : 'interactive'
      try {
        const permit = await deps.scheduling.admission.acquire({ projectKey: deps.scheduling.projectKey, model, lane, signal: queuedController.signal })
        scheduled = { permit, started: false, finished: false }
      } catch (error) {
        if (queuedController.signal.aborted && error instanceof SchedulerAdmissionError && error.code === 'SCHEDULER_CANCELLED') dispatchAdmission()
        throw error
      }
    }
    const startDispatch = () => {
    if (scheduled) dispatchAdmission()
    const creativeStrategy = deps.database.prepare("SELECT creative_strategy FROM project_core WHERE id='main'").pluck().get() as CreativeStrategy | undefined
    const plan = buildMainGenerationPlan(model, modelReceipt(run.binding), task, repository.budget(run.rootActionId), creativeStrategy)
    deps.beforeDispatch?.()
    assertAdmission()
    return { promise: service.execute({ runId: run.runId, invocationNonce: request.invocationNonce, requestHash,
      providerRequest: { model, task, plan, conversationId: run.rootActionId, ...(scheduled ? { scheduling: scheduled } : {}) } satisfies ProviderRequest, reservedTokens: plan.reservedTokens,
      requestedOutputTokens: plan.requestedOutputTokens, inputUpperBoundTokens: plan.inputUpperBoundTokens,
      reasoningUpperBoundTokens: plan.reasoningUpperBoundTokens, usagePolicy: plan.usagePolicy, purpose: task.purpose,
      ...(plan.budgetDecision ? { budgetDecision: plan.budgetDecision } : {}),
      ...(run.binding.sourceManifest.importSlot || run.binding.sourceManifest.operation === 'planning-feedback' || materialDecision?.shortOutlinePromptHash || repository.readPlotOutline(run.runId) ? { replayTask: task } : {}),
      ...(reconciliationInjected ? { reconciliationInjected } : {}),
      ...(scheduled ? { dispatchAdmission } : {}),
      ...(deps.mode === 'runtime-feedback' && planningExecution ? { runtimeFeedbackAdmission: () => {
        assertAdmission()
        assertSourcesCurrent(handleOf(run))
        deps.runtimeFeedback!.assertDispatchAdmission(run.runId)
        const frozenModel = deps.leases.resolve(leaseId)
        const receipt = safeGenerationModelReceipt(createModelExecutionLeaseReceipt(frozenModel, { leaseId: 'read-only-evidence', createdAt: 0, expiresAt: 0 }))
        if (!isDeepStrictEqual(receipt, modelReceipt(run.binding))) throw new Error('GENERATION_MODEL_CHANGED')
      } } : {}),
      ...(isDriverMode && driverExecution ? { workflowDriverAdmission: () => {
        assertAdmission()
        assertSourcesCurrent(handleOf(run))
        deps.workflowDriver!.assertDispatchAdmission(run.runId, request.invocationNonce, task)
        const frozenModel = deps.leases.resolve(leaseId)
        const receipt = safeGenerationModelReceipt(createModelExecutionLeaseReceipt(frozenModel, { leaseId: 'read-only-evidence', createdAt: 0, expiresAt: 0 }))
        if (!isDeepStrictEqual(receipt, modelReceipt(run.binding))) throw new Error('GENERATION_MODEL_CHANGED')
      } } : {}),
      ...(agentExecution ? { agentToolNames: (run.binding.sourceManifest.agentContext as AgentGenerationContext).input.tools.map(tool => tool.name) } : {}) }) }
    }
    const started = deps.withDispatchKnowledge
      ? await deps.withDispatchKnowledge(run.binding.sourceManifest.knowledgeSnapshot as GenerationKnowledgeSnapshot | undefined, startDispatch)
      : startDispatch()
    const receipt = await started.promise
    if (receipt.failureCode || receipt.unsavedTail) volatileReceipts.set(receipt.attempt.attemptId, receipt)
    assertCurrent()
    const snapshot = snapshotOf(receipt)
    if (snapshot) deps.onSnapshot?.(snapshot)
    return outcomeOf(receipt, task)
    } finally {
      queuedExecutions.delete(key)
      if (scheduled && !scheduled.started) scheduled.permit.finish()
      else if (scheduled && !scheduled.finished) {
        const flight = scheduled
        // Logical cancellation can win before cooperative local cleanup finishes.
        // Hold the permit throughout grace; only a genuinely late cleanup is parked.
        flight.quarantineTimer = setTimeout(() => {
          if (!flight.finished) flight.permit.quarantine()
        }, deps.scheduling!.quarantineAfterMs)
      }
    }
    })()
    pending.set(key, { hash: requestHash, promise: operation })
    try { return await operation } finally { pending.delete(key) }
  }
  const retryDraftShortOutline = async (request: GenerationOwnerChannels['generation:retry-draft-short-outline']['args'][0]) => {
    const run = requireRun(request.handle, true)
    const task = readFailedShortOutlineTask(run, request.failedAttemptId)
    return execute({ handle: request.handle, invocationNonce: `draft-short-outline-retry:${request.failedAttemptId}`, task },
      false, false, false, false, false, false, request.failedAttemptId)
  }
  const resume = async (handle: MainGenerationRunHandle) => {
    assertAdmission()
    const run = requireRun(handle)
    assertAuthorFollowupWritable(run.runId)
    repository.assertBlueprintRecoveryWritable(run.runId)
    repository.assertPlotOutlineWritable(run.runId)
    if (plotOutlineAlreadyCurrent(run)) return viewOf(run)
    imports.assertMutable(run)
    finalizations.assertMutable(run)
    graphs.assertMutable(run)
    legacyRosters.assertMutable(run)
    const outline = repository.readPlotOutline(run.runId)
    if (outline && plotOutlineSourceInvalid(outline)) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
    const receipt = currentModelReceipt(run.binding)
    const next = deps.rebuildBinding(run.binding, receipt)
    const lease = deps.leases.begin(receipt.modelId)
    try {
      if (!isDeepStrictEqual(safeGenerationModelReceipt(lease), receipt)) throw new Error('GENERATION_MODEL_CHANGED')
      const authorRecovery = authorFollowupRuns.has(run.runId)
      const admitAuthorRecovery = () => {
        assertAdmission()
        assertRetirable()
        reviewRevisions.assertBatchFollowupWritable(run.runId)
        if (!compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))))
          throw new Error('GENERATION_REVIEW_CONTEXT_CHANGED')
      }
      if (authorRecovery && run.binding.epoch !== deps.epoch && repository.budget(run.rootActionId).root.status === 'active')
        repository.recoverReviewRevisionRun(run.runId, admitAuthorRecovery)
      const resumed = await service.resume(run.runId, next, isDriverMode ? () => {
        assertAdmission()
        deps.workflowDriver!.assertActive(run.runId)
      } : authorRecovery ? admitAuthorRecovery : undefined)
      assertCurrent()
      const previous = runLeases.get(run.runId)
      if (previous) deps.leases.close(previous)
      runLeases.set(run.runId, lease.leaseId)
      return viewOf(resumed)
    } catch (error) { deps.leases.close(lease.leaseId); throw error }
  }
  const bindMaterialDecision = (handle: MainGenerationRunHandle, materialDecision: MaterialDecisionReceipt): MainGenerationRunView => {
    const run = requireRun(handle, true)
    const operation = run.binding.sourceManifest.operation
    if (!['review-chapter', 'refine-draft', 'refine-from-review'].includes(String(operation)))
      throw new Error('GENERATION_MATERIAL_DECISION_INVALID')
    const existing = run.binding.sourceManifest.materialDecision
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, materialDecision)) throw new Error('GENERATION_MATERIAL_DECISION_CONFLICT')
      return viewOf(run)
    }
    const candidate = deps.rebuildBinding({ ...run.binding,
      sourceManifest: { ...run.binding.sourceManifest, materialDecision } }, currentModelReceipt(run.binding))
    if (!isDeepStrictEqual(materialDecisionProjection(run.binding), materialDecisionProjection(candidate)))
      throw new Error('GENERATION_SOURCE_CHANGED')
    return viewOf(repository.replaceUnstartedBinding(run.runId, run.binding, candidate))
  }
  const assertSourcesCurrent = (handle: MainGenerationRunHandle, blueprintRange?: { startChapter: number; endChapter: number }) => {
      assertAdmission()
      const run = requireRun(handle, true)
      if (repository.budget(run.rootActionId).root.status === 'cancelled') throw new Error('GENERATION_ACTION_CANCELLED')
      if (blueprintRange) {
        const continued = repository.assertBlueprintRecoveryWritable(run.runId).predecessor
        if (continued && !isDeepStrictEqual(continued.remainingRange, blueprintRange)) throw new Error('GENERATION_DIRECTORY_CONTINUATION_RANGE_CHANGED')
        const selected = run.binding.sourceManifest.selectedBlueprintChapterNumbers as number[] | undefined
        if (!selected || !Number.isSafeInteger(blueprintRange.startChapter) || !Number.isSafeInteger(blueprintRange.endChapter)
          || blueprintRange.startChapter < 1 || blueprintRange.endChapter < blueprintRange.startChapter
          || blueprintRange.endChapter - blueprintRange.startChapter >= 10000
          || Array.from({ length: blueprintRange.endChapter - blueprintRange.startChapter + 1 }, (_, index) => blueprintRange.startChapter + index).some(chapter => !selected.includes(chapter)))
          throw new Error('GENERATION_FORMAL_RANGE_NOT_SELECTED')
      }
      const current = deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))
      if (!isDeepStrictEqual(current, run.binding)) throw new Error('GENERATION_SOURCE_CHANGED')
    }
  const planningFeedback = () => {
    assertCurrent()
    if (!capturedProjectPath) throw new Error('PLANNING_FEEDBACK_PROJECT_ROOT_REQUIRED')
    return new PlanningFeedbackService({ database: deps.database, projectId: deps.projectId,
      projectPath: capturedProjectPath, assertCurrent, assertGenerationBindingCurrent: receipt => {
        const binding = receipt.run.binding
        assertLegacyRunAccess(receipt.run.runId)
        // A settled original-project receipt may be staged after restart; it grants no new dispatch.
        if (runtimeFreeze.isFrozen('generation_runs', receipt.run.runId) || binding.projectId !== deps.projectId
          || !compareGenerationSourceBindings(binding, deps.rebuildBinding(binding, currentModelReceipt(binding)))) {
          throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
        }
      } })
  }
  const fieldFeedbackBase = (baseId: string) => {
    const base = planningFeedback().getBase(baseId)
    if (base.schemaVersion !== 1) throw new Error('PLANNING_FEEDBACK_TARGET_INVALID')
    if (base.projectId !== deps.projectId && !runtimeFreeze.isFrozen('planning_feedback_bases', base.baseId))
      throw new Error('PLANNING_FEEDBACK_HISTORY_FROZEN')
    return base
  }
  const fieldFeedbackCandidate = (candidateId: string) => {
    const candidate = planningFeedback().getCandidate(candidateId)
    fieldFeedbackBase(candidate.baseId)
    if (candidate.schemaVersion !== 1) throw new Error('PLANNING_FEEDBACK_TARGET_INVALID')
    return candidate
  }
  const fieldFeedbackRun = (handle: MainGenerationRunHandle) => {
    const run = requireRun(handle)
    const manifest = run.binding.sourceManifest
    if (manifest.operation !== 'planning-feedback') throw new Error('GENERATION_FEEDBACK_ADMISSION_REQUIRED')
    const input = manifest.planningFeedbackInput as PlanningFeedbackGenerationInput
    if (!input || typeof input.baseId !== 'string') throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    const base = fieldFeedbackBase(input.baseId)
    const context = manifest.planningFeedbackContext as { schemaVersion?: unknown; baseId?: unknown; projectId?: unknown; target?: unknown } | undefined
    if (context?.schemaVersion !== 1) throw new Error('PLANNING_FEEDBACK_TARGET_INVALID')
    if (context.baseId !== base.baseId || context.projectId !== base.projectId || context.target !== base.target)
      throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    return { run, input }
  }
  const plotOutlineTargetCurrent = (run: DurableGenerationRun, outline: PlotOutlineProgress, target: string): boolean => {
    const raw = deps.database.prepare("SELECT * FROM project_core WHERE id='main'").get() as Record<string, unknown> | undefined
    if (!raw || raw.synopsis !== target) return false
    const core = Object.fromEntries(Object.entries(raw).filter(([key]) => !['created_at', 'updated_at', 'character_states', 'plot_tree_snapshot'].includes(key)))
    const origin = run.binding.sourceManifest.plotOutlineSource as PlotOutlineSource
    if (!isDeepStrictEqual({ ...core, synopsis: outline.sourceExpected.synopsis }, origin.core)) throw new Error('GENERATION_SOURCE_CHANGED')
    const current = deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))
    const refs = (binding: RunBinding) => binding.sourceRefs.filter(ref => ref.sourceId !== 'project-core:main').map(ref => ({ ...ref, epoch: undefined }))
    const unchangedFingerprint = (binding: RunBinding) => Object.fromEntries(Object.entries(binding.fingerprint)
      .filter(([key]) => !['authorGuidanceHash', 'contextSnapshotHash'].includes(key)))
    if (current.projectId !== run.binding.projectId || !isDeepStrictEqual(current.sourceManifest, run.binding.sourceManifest)
      || !isDeepStrictEqual(refs(current), refs(run.binding)) || !isDeepStrictEqual(unchangedFingerprint(current), unchangedFingerprint(run.binding)))
      throw new Error('GENERATION_SOURCE_CHANGED')
    return true
  }
  const plotOutlineAlreadyCurrent = (run: DurableGenerationRun): boolean => {
    const outline = repository.readPlotOutline(run.runId)
    if (outline?.cursor.kind !== 'complete' || !outline.composition) return false
    return plotOutlineTargetCurrent(run, outline, renderPlotOutlineRange(outline.composition.text, outline.range, outline.sourceExpected))
  }
  const projectGenerationInFlight = () => pending.size > 0 || !!deps.database.prepare(
    "SELECT 1 FROM generation_attempts WHERE json_extract(attempt_json,'$.status') IN ('reserved','dispatch-marked') LIMIT 1").get()
  const planningContinuation = (run: DurableGenerationRun): PlanningContinuation | undefined => {
    if (repository.isPrivatePlanningHistory(run.runId)) return undefined
    const outline = repository.readPlotOutline(run.runId)
    const inputs = run.binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined
    const directoryRange = run.binding.sourceManifest.operation === 'chapter-blueprint-directory'
      ? inputs?.find(input => input.id === 'directory:requested-range') : undefined
    if (!outline && !directoryRange) return undefined
    const scope = directoryRange ? JSON.parse(directoryRange.text) as { startChapter: number; endChapter: number } : undefined
    const saved = outline ? repository.readPlotOutlineAuthorEdit(run.runId) : null
    const recovery = scope ? repository.readBlueprintRecovery(run.runId) : null
    if (recovery && recovery.kind !== 'available') return undefined
    if (recovery && recovery.progress.length > 1) throw new Error('GENERATION_DIRECTORY_PROGRESS_INVALID')
    const blueprintSaved = recovery?.authorEdit
    const progress = recovery?.progress[0]
    const remainingRange = outline ? saved ? saved.remainingRange : outline.range
      : blueprintSaved ? blueprintSaved.remainingRange : progress ? progress.remainingRange ? { from: progress.remainingRange.startChapter, to: progress.remainingRange.endChapter } : null
        : { from: scope!.startChapter, to: scope!.endChapter }
    const target = inputs?.find(input => input.id === 'planning:target-units')
    const base = { sourceHandle: handleOf(run), remainingRange, targetUnits: parsePlanningTargetUnits(target ? Number(target.text) : undefined) }
    const continued = repository.readPlanningContinuation(run.runId)
    if (continued) return { ...base, state: 'continued', nextHandle: continued.nextHandle }
    if (outline && plotOutlineSourceInvalid(outline)) return { ...base, state: 'source-invalid' }
    if (projectGenerationInFlight()) return { ...base, state: 'in-flight' }
    let current = false
    try {
      if (outline && saved) {
        const synopsis = ProjectCoreRepository.get(deps.database)?.synopsis
        current = synopsis !== undefined && textHash(synopsis) === saved.synopsisHash && plotOutlineTargetCurrent(run, outline, synopsis)
      } else if (progress || blueprintSaved) {
        const committed = [progress?.operationId, blueprintSaved?.operationId].filter((id): id is string => !!id).flatMap(id => {
          const row = deps.database.prepare('SELECT character_sync_input FROM blueprint_commit_operations WHERE operation_id=?').pluck().get(id)
          return JSON.parse(String(row)) as import('../repositories/blueprint-repository').BlueprintData[]
        })
        const stored = new Map(BlueprintRepository.getAll(deps.database).map(item => [item.chapterNumber, item]))
        const fields = ['chapterNumber', 'title', 'role', 'purpose', 'keyEvents', 'characters', 'suspenseHook', 'userGuidance'] as const
        current = committed.every(item => fields.every(key => isDeepStrictEqual(item[key], stored.get(item.chapterNumber)?.[key])))
        const projection = (binding: RunBinding) => ({ manifest: binding.sourceManifest,
          fingerprint: Object.fromEntries(Object.entries(binding.fingerprint).filter(([key]) => !['contextSnapshotHash', 'chapterBriefHash'].includes(key))),
          refs: binding.sourceRefs.filter(ref => !committed.some(item => ref.sourceId === `blueprint:${item.chapterNumber}`)).map(ref => ({ ...ref, epoch: undefined })) })
        current = current && isDeepStrictEqual(projection(run.binding), projection(deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))))
      } else current = compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding)))
    } catch { return { ...base, state: 'source-changed' } }
    if (!current) return { ...base, state: 'source-changed' }
    if (!remainingRange) return { ...base, state: 'complete' }
    if (outline && !saved && (outline.composition?.chapters?.length || outline.cursor.kind === 'accept')) return { ...base, state: 'save-prefix' }
    return { ...base, state: 'ready' }
  }
  const plotOutlineRecovery = (run: DurableGenerationRun, outline: PlotOutlineProgress): PlotOutlineRecovery => {
    const saved = repository.readPlotOutlineAuthorEdit(run.runId)
    const cursor = outline.cursor
    const currentAttempts = new Set(cursor.kind === 'request' || cursor.kind === 'stopped'
      ? runAttempts(run.runId).filter(attempt => attempt.purpose?.startsWith(`plot-outline:chapter:${cursor.chapterNumber}:`)).map(attempt => attempt.attemptId) : [])
    const latest = [...(viewOf(run).candidates ?? [])].reverse().find(candidate => currentAttempts.has(candidate.attemptId))
    let draft = plotOutlineRecoveryDraft(outline, latest?.text)
    let writeState: PlotOutlineRecovery['writeState'] = { kind: 'blocked', reason: 'source-changed' }
    try {
      if (plotOutlineSourceInvalid(outline)) writeState = { kind: 'blocked', reason: 'source-invalid' }
      else if (saved) {
        const current = ProjectCoreRepository.get(deps.database)?.synopsis
        if (current !== undefined && textHash(current) === saved.synopsisHash && plotOutlineTargetCurrent(run, outline, current)) {
          draft = current
          writeState = { kind: 'blocked', reason: 'author-saved' }
        }
      } else if (!repository.readPlanningContinuation(run.runId) && compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding)))) {
        writeState = projectGenerationInFlight() ? { kind: 'blocked', reason: 'in-flight' } : { kind: 'ready' }
      }
    } catch { /* Frozen proposals remain readable when current sources are unavailable. */ }
    const batch = outline.cursor.kind === 'complete' ? outline.composition?.text.trim() : undefined
    const inFormalOutline = !!batch && (ProjectCoreRepository.get(deps.database)?.synopsis ?? '').includes(batch)
    return { sourceHandle: handleOf(run), leaseEpoch: deps.epoch, draft, inFormalOutline,
      completeChapters: [...(outline.composition?.chapters?.map(chapter => chapter.chapterNumber) ?? []),
        ...(outline.cursor.kind === 'accept' ? [outline.cursor.chapterNumber] : [])],
      writeState, saved }
  }
  const commitPlotOutlineAuthorEdit = (request: ProjectCoreSynopsisCommitRequest): PlotOutlineAuthorEditReceipt => {
    if (!deps.database.inTransaction) throw new Error('GENERATION_PLOT_OUTLINE_TRANSACTION_REQUIRED')
    const author = request.authorRecovery
    if (!author || request.generationRunHandle || typeof request.synopsis !== 'string') throw new Error('GENERATION_PLOT_OUTLINE_AUTHOR_EDIT_INVALID')
    if (author.leaseEpoch !== deps.epoch) throw new Error('GENERATION_EPOCH_STALE')
    const run = requireRun(author.sourceHandle), outline = repository.readPlotOutline(run.runId)
    if (!outline || !isDeepStrictEqual(request.expected, outline.sourceExpected)) throw new Error('GENERATION_PLOT_OUTLINE_AUTHOR_EDIT_INVALID')
    const receipt = repository.plotOutlineAuthorEditReceipt(run.runId, author.operationId, author.committedRange, textHash(request.synopsis))
    const saved = repository.readPlotOutlineAuthorEdit(run.runId)
    // 回执与正文哈希都对上的重试，写的就是当时校验过、已落库的那份；升级前存下的编辑不再按现行规则重判。
    if (saved) {
      if (!isDeepStrictEqual(saved, receipt)) throw new Error('GENERATION_PLOT_OUTLINE_AUTHOR_RECEIPT_CONFLICT')
      if (!plotOutlineTargetCurrent(run, outline, request.synopsis)) throw new Error('GENERATION_SOURCE_CHANGED')
      return { ...saved, idempotent: true }
    }
    if (plotOutlineSourceInvalid(outline)) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
    if (!validPlotOutlineAuthorPrefix(request.synopsis, outline, author.committedRange)) throw new Error('GENERATION_PLOT_OUTLINE_AUTHOR_EDIT_INVALID')
    repository.assertPlotOutlineWritable(run.runId)
    if (projectGenerationInFlight()) throw new Error('GENERATION_PLOT_OUTLINE_AUTHOR_IN_FLIGHT')
    if (!compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding)))) throw new Error('GENERATION_SOURCE_CHANGED')
    if (!ProjectCoreRepository.commitSynopsis(request, deps.database)) throw new Error('GENERATION_SOURCE_CHANGED')
    repository.recordPlotOutlineAuthorEdit(receipt)
    return receipt
  }
  const commitBlueprintAuthorEdit = (request: BlueprintRangeCommitRequest): BlueprintRangeCommitReceipt => {
    if (!deps.database.inTransaction) throw new Error('GENERATION_DIRECTORY_TRANSACTION_REQUIRED')
    const author = request.authorRecovery
    if (!author || request.generationRunHandle || request.mode !== 'replace-range' || author.leaseEpoch !== deps.epoch)
      throw new Error('GENERATION_BLUEPRINT_AUTHOR_EDIT_INVALID')
    const run = requireRun(author.sourceHandle)
    repository.assertBlueprintRecoveryWritable(run.runId)
    const recovery = planningContinuation(run)
    if (run.binding.sourceManifest.operation !== 'chapter-blueprint-directory' || !recovery
      || !Number.isSafeInteger(request.startChapter) || !Number.isSafeInteger(request.endChapter) || request.startChapter < 1 || request.endChapter < request.startChapter
      || request.endChapter - request.startChapter >= 10000
      || Buffer.byteLength(JSON.stringify(request.blueprints), 'utf8') > 8 * 1024 * 1024) throw new Error('GENERATION_BLUEPRINT_AUTHOR_EDIT_INVALID')
    const chapters = Array.from({ length: request.endChapter - request.startChapter + 1 }, (_, index) => request.startChapter + index)
    const blueprints = decodeBlueprintAuthorPayload(request.blueprints, chapters)
    const saved = repository.readBlueprintAuthorEdit(run.runId)
    if (saved) {
      if (saved.operationId !== request.operationId || saved.committedRange.from !== request.startChapter || saved.committedRange.to !== request.endChapter)
        throw new Error('GENERATION_BLUEPRINT_AUTHOR_RECEIPT_CONFLICT')
      if (recovery.state === 'source-changed') throw new Error('GENERATION_SOURCE_CHANGED')
      return { ...BlueprintRepository.commitRange({ ...request, blueprints }, undefined, deps.database), authorEdit: saved }
    }
    repository.assertPlotOutlineWritable(run.runId)
    if (recovery.state !== 'ready' || !recovery.remainingRange || request.startChapter !== recovery.remainingRange.from || request.endChapter > recovery.remainingRange.to)
      throw new Error(`GENERATION_BLUEPRINT_AUTHOR_${recovery.state.toUpperCase().replaceAll('-', '_')}`)
    const receipt = BlueprintRepository.commitRange({ ...request, blueprints }, () => {
      if (planningContinuation(run)?.state !== 'ready') throw new Error('GENERATION_SOURCE_CHANGED')
    }, deps.database)
    const input = (run.binding.sourceManifest.authorInputs as GenerationAuthorInput[]).find(item => item.id === 'directory:requested-range')!
    const range = JSON.parse(input.text) as { startChapter: number; endChapter: number }
    const authorEdit = { kind: 'blueprint-author-edit' as const, operationId: request.operationId, sourceHandle: handleOf(run),
      requestedRange: { from: range.startChapter, to: range.endChapter }, committedRange: { from: request.startChapter, to: request.endChapter },
      remainingRange: request.endChapter < range.endChapter ? { from: request.endChapter + 1, to: range.endChapter } : null, payloadHash: receipt.payloadHash }
    repository.recordBlueprintAuthorEdit(authorEdit)
    return { ...receipt, authorEdit }
  }
  const assertSynopsisCommit = (handle: MainGenerationRunHandle, synopsis: string, expected: ProjectCoreSynopsisExpected): boolean => {
    const run = requireRun(handle), outline = repository.readPlotOutline(run.runId)
    repository.assertPlotOutlineWritable(run.runId)
    if (outline) {
      if (outline.cursor.kind !== 'complete' || !outline.composition
        || synopsis !== renderPlotOutlineRange(outline.composition.text, outline.range, outline.sourceExpected)
        || !isDeepStrictEqual(expected, outline.sourceExpected)) throw new Error('GENERATION_PLOT_OUTLINE_COMMIT_INVALID')
      if (plotOutlineAlreadyCurrent(run)) return true
    }
    assertSourcesCurrent(handle)
    return false
  }
  const readContext = (handle: MainGenerationRunHandle): GenerationRecoveryContext => {
    const run = requireRun(handle), manifest = run.binding.sourceManifest, composition = repository.isPrivatePlanningHistory(run.runId) ? null : repository.readVisibleComposition(run.runId)
    const plotOutline = repository.readPlotOutline(run.runId)
    const continuation = planningContinuation(run)
    const blueprint = manifest.operation === 'chapter-blueprint-directory' ? repository.readBlueprintRecovery(run.runId) : null
    const blueprintSaved = blueprint?.kind === 'available' ? blueprint.authorEdit : null
    const draftSave = draftEffects.readRecovery(run.runId)
    const materialDecision = manifest.materialDecision as MaterialDecisionReceipt | undefined
    const requiredCandidateDraftIds = new Set((materialDecision?.included ?? [])
      .filter(item => item.required && /^candidate:\d+$/u.test(item.sourceId))
      .map(item => Number(item.sourceId.slice('candidate:'.length))))
    const selectedDrafts = (manifest.selectedDraftIds as number[] ?? []).map(draftId => {
      const row = deps.database.prepare('SELECT d.chapter_number,d.version,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(draftId) as { chapter_number: number; version: number; body: string } | undefined
      const ref = run.binding.sourceRefs.find(source => source.sourceId === `draft:${draftId}`)
      return row && ref && row.version === ref.revision && textHash(row.body) === ref.contentHash
        ? { draftId, chapterNumber: row.chapter_number, version: row.version, contentHash: ref.contentHash, content: row.body,
            ...(requiredCandidateDraftIds.has(draftId) ? { required: true } : {}) } : null
    })
    const rows = deps.database.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(run.runId) as { attempt_id: string; usage_receipt_json: string }[]
    const last = composition ? deps.database.prepare('SELECT attempt_id FROM generation_artifacts WHERE artifact_id=?').pluck().get(composition.artifactIds.at(-1)) as string : undefined
    return { modelId: modelReceipt(run.binding).modelId, handle: handleOf(run), operation: manifest.operation as string, chapterNumber: manifest.chapterNumber as number | undefined,
      ...(plotOutline ? { plotOutline, plotOutlineRecovery: plotOutlineRecovery(run, plotOutline) } : {}),
      ...(continuation ? { planningContinuation: continuation } : {}),
      ...(blueprint && blueprint.kind !== 'available' ? { blueprintRecovery: {
        sourceHandle: handleOf(run), leaseEpoch: deps.epoch, draft: viewOf(run).candidates?.at(-1)?.text ?? '',
        editRange: null, saved: null, writeState: 'unavailable' as const, diagnostic: blueprint.diagnostic,
      } } : manifest.operation === 'chapter-blueprint-directory' && continuation ? { blueprintRecovery: {
        sourceHandle: handleOf(run), leaseEpoch: deps.epoch, draft: viewOf(run).candidates?.at(-1)?.text ?? '',
        editRange: continuation.remainingRange, saved: blueprintSaved,
        // source-invalid 只出现在情节大纲任务上
        writeState: blueprintSaved ? 'author-saved' as const : continuation.state === 'save-prefix' ? 'ready' as const : continuation.state as Exclude<PlanningContinuation['state'], 'save-prefix' | 'source-invalid'>,
      } } : {}),
      authorInputs: structuredClone(manifest.authorInputs as GenerationAuthorInput[] ?? []),
      selectedDraftIds: structuredClone(manifest.selectedDraftIds as number[] ?? []), selectedFinalizedDraftIds: structuredClone(manifest.selectedFinalizedDraftIds as number[] ?? []),
      selectedBlueprintChapterNumbers: structuredClone(manifest.selectedBlueprintChapterNumbers as number[] ?? []), composition,
      lastCompositionFinishReason: last ? repository.receipt(last).result?.finishReason ?? null : null,
      attemptedPurposes: rows.map(row => JSON.parse(row.usage_receipt_json).purpose ?? 'unknown'),
      ...(materialDecision?.shortOutlinePromptHash ? { draftShortOutline: shortOutlineContext(run) } : {}),
      ...(rows.some(row => JSON.parse(row.usage_receipt_json).purpose === DRAFT_RECONCILE_PURPOSE) ? { draftReconciliation: {
        artifactIds: rows.filter(row => JSON.parse(row.usage_receipt_json).purpose === DRAFT_RECONCILE_PURPOSE)
          .flatMap(row => { const artifact = repository.receipt(row.attempt_id).artifact; return artifact ? [artifact.artifactId] : [] }),
        // 首稿已发出时，只有首稿提示经复核确实带了注入块，续写/压缩才沿用；首稿尚未发出时沿用记录的对账结果。
        completedOutput: (() => {
          const firstDraft = rows.find(row => JSON.parse(row.usage_receipt_json).purpose === 'chapter-draft')
          return !firstDraft || JSON.parse(firstDraft.usage_receipt_json).reconciliationInjected === true ? completedReconciliationOutput(run.runId) : null
        })() } } : {}),
      draftSave,
      ...(manifest.knowledgeSnapshot ? { knowledgeSnapshot: structuredClone(manifest.knowledgeSnapshot) as GenerationKnowledgeSnapshot } : {}),
      ...(selectedDrafts.every(item => item !== null) ? { selectedDrafts } : {}),
      ...(manifest.batchId ? { batchId: manifest.batchId as string } : {}) }
  }
  const readBatch = (batchId: string) => { assertCurrent(); assertLegacyRunAccess(batchId); return draftEffects.readBatch(batchId, deps.projectId) }
  const characters = new CharacterProposalService(deps.database, deps.projectId, (source, forWrite, version) => {
    assertCurrent(); return proveCharacterProposal(deps.database, repository, deps.projectId, source, forWrite, (handle, committedBlueprintChapters) => {
      const run = requireRun(handle)
      if (repository.budget(run.rootActionId).root.status === 'cancelled') throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
      if (source.kind === 'finalized-generation' && run.binding.sourceManifest.finalizationGenerationContextHash) return
      const current = deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))
      const projection = (binding: RunBinding) => ({ sourceManifest: binding.sourceManifest,
        fingerprint: Object.fromEntries(Object.entries(binding.fingerprint).filter(([key]) => !['contextSnapshotHash', 'chapterBriefHash'].includes(key))),
        sources: binding.sourceRefs.filter(ref => !committedBlueprintChapters?.some(chapter => ref.sourceId === `blueprint:${chapter}`))
          .map(({ epoch: _epoch, ...ref }) => { void _epoch; return ref }) })
      const matches = committedBlueprintChapters ? isDeepStrictEqual(projection(run.binding), projection(current)) : compareGenerationSourceBindings(run.binding, current)
      if (!matches) throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    }, version)
  })
  const imports = new ImportGeneration(deps.database, repository, deps.projectId)
  const legacyRosters = new LegacyRosterGeneration(deps.database, repository, deps.projectId, characters)
  const graphs = new GraphGeneration(deps.database, repository, deps.projectId)
  const finalizations = new FinalizationGeneration(deps.database, repository, deps.projectId, characters, deps.transferOrigin)
  const agents = new AgentGeneration(deps.database, repository, { projectId: deps.projectId, epoch: deps.epoch }, assertCurrent, {
    begin: selection => begin(selection, false, true), read: handle => viewOf(requireRun(handle)), resume,
    execute: (handle, invocationNonce, task) => execute({ handle, invocationNonce, task }, true),
    current: (run, expected) => { try { return compareGenerationSourceBindings(expected ?? run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))) } catch { return false } },
    capture: run => deps.rebuildBinding(run.binding, currentModelReceipt(run.binding)),
  }, recoverInterrupted, assertAdmission)
  const requireEditorInlineRun = (handle: MainGenerationRunHandle) => {
    assertCurrent()
    if (!handle || Object.keys(handle).some(key => !['projectId', 'epoch', 'rootActionId', 'runId'].includes(key))
      || handle.projectId !== deps.projectId || typeof handle.epoch !== 'string' || !handle.epoch) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    const run = repository.get(handle.runId)
    readEditorInlineContext(run)
    if (run.binding.projectId !== handle.projectId || run.rootActionId !== handle.rootActionId
      || handle.epoch !== run.binding.epoch && handle.epoch !== run.binding.sourceManifest.editorInlineOriginEpoch) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    return run
  }
  const readEditorInlineRecovery = (handle: MainGenerationRunHandle): EditorInlineRecovery => {
    const run = requireEditorInlineRun(handle)
    const context = readEditorInlineContext(run)
    let current = false
    try { current = repository.budget(run.rootActionId).root.status !== 'cancelled' && compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))) } catch { /* Original text remains readable after source or model changes. */ }
    return { view: viewOf(run), modelId: modelReceipt(run.binding).modelId, context, sourceStatus: current ? 'current' : 'conflict' }
  }
  const readReviewRevisionRecovery = (handle: MainGenerationRunHandle, admitRecovery = true) => {
    const protectedFollowup = isAuthorViewOwner && isBatchDriverRun(handle.runId)
    if (protectedFollowup) reviewRevisions.assertBatchFollowupRun(handle.runId)
    else requireRun(handle)
    const read = () => reviewRevisions.readRecovery(handle,
      run => compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))),
      run => viewOf(run).candidates?.at(-1))
    let recovery = read()
    const interrupted = protectedFollowup && runAttempts(handle.runId).some(attempt => attempt.status === 'dispatch-marked')
    if (admitRecovery && interrupted && !reviewRevisions.hasUnknownDelivery(handle.runId)
      && !recovery.saved && recovery.sourceStatus === 'current' && handle.epoch !== deps.epoch) {
      assertAdmission()
      assertRetirable()
      repository.recoverReviewRevisionRun(handle.runId, () => {
        assertAdmission()
        assertRetirable()
        reviewRevisions.assertBatchFollowupRun(handle.runId)
        if (read().sourceStatus !== 'current') throw new Error('GENERATION_REVIEW_CONTEXT_CHANGED')
      })
      recovery = read()
    }
    if (admitRecovery && protectedFollowup && (recovery.saved || recovery.sourceStatus === 'current')) authorFollowupRuns.add(handle.runId)
    if (admitRecovery && protectedFollowup && !recovery.saved && recovery.sourceStatus === 'current' && !reviewRevisions.hasUnknownDelivery(handle.runId))
      executableAuthorFollowups.add(handle.runId)
    if (protectedFollowup && !recovery.saved && reviewRevisions.hasUnknownDelivery(handle.runId))
      return { ...recovery, canResume: false, contextId: undefined }
    return recovery
  }
  /**
   * 运行侧页「可恢复」区的数据。只读操作类型可能恢复的运行；一个运行读不出不挡其余运行，只标 partial。
   * 单章写稿保存过就不再需要恢复，正文后来改没改过都一样；只有这次打开里还留着没落盘的正文时仍列出，那段文字只能从这里复制。
   * 规划恢复稿只列没写进正式内容的：续写已完成的，或来源变了但本批已原样在正式大纲里的，都不算可恢复。
   */
  const listRecovery = (): GenerationRecoveryList => {
    assertCurrent()
    const list: GenerationRecoveryList = { planning: [], editors: [], reviews: [], batches: [], drafts: [], partial: false }
    const hasText = (item: { text: string }) => item.text.trim().length > 0
    const attemptRun = deps.database.prepare('SELECT run_id FROM generation_attempts WHERE attempt_id=?').pluck()
    const tailedRuns = new Set(service.readUnsavedTails().filter(hasText)
      .flatMap(tail => { const runId = attemptRun.get(tail.attemptId); return typeof runId === 'string' ? [runId] : [] }))
    for (const row of deps.database.prepare(`SELECT DISTINCT a.run_id FROM generation_recovery_tails t
      JOIN generation_attempts a ON a.attempt_id=t.attempt_id`).all() as { run_id: string }[]) tailedRuns.add(row.run_id)
    const collect = {
      planning: (handle: MainGenerationRunHandle) => {
        const recovery = readContext(handle)
        if ((recovery.plotOutlineRecovery || recovery.blueprintRecovery) && recovery.planningContinuation?.state !== 'complete'
          && !recovery.plotOutlineRecovery?.inFormalOutline) list.planning.push(recovery)
      },
      review: (handle: MainGenerationRunHandle) => { const recovery = readReviewRevisionRecovery(handle, false); list.reviews.push({ view: viewOf(repository.get(handle.runId)), recovery }) },
      editor: (handle: MainGenerationRunHandle) => { list.editors.push(readEditorInlineRecovery(handle)) },
      draft: (handle: MainGenerationRunHandle) => {
        const saved = draftEffects.readRecovery(handle.runId).kind !== 'absent'
        if (saved && !tailedRuns.has(handle.runId)) return
        const view = viewOf(requireRun(handle))
        if (saved) {
          list.drafts.push({ view, recovery: readContext(handle) })
          return
        }
        const recovery = readContext(handle)
        if (recovery.composition || recovery.draftShortOutline?.completedOutput || recovery.draftShortOutline?.retry?.kind === 'available'
          || withoutDraftReconciliationArtifacts([...view.artifacts, ...(view.candidates ?? [])], recovery).some(hasText)
          || view.unsavedTails?.some(hasText) || view.recoveryTails?.some(tail => tail.tailText.trim().length > 0)) list.drafts.push({ view, recovery })
      },
    }
    const runs = runSummaries()
    for (const run of runs) {
      const kind = RECOVERY_KIND.get(run.operation ?? '')
      if (!kind || (kind === 'draft' && run.batchId)) continue
      try { collect[kind](run.handle) } catch (error) {
        if (!(error instanceof ReviewSourceDeletedError)) list.partial = true
      }
    }
    const batchRoots = runs.filter(item => item.batchRoot)
    if (!batchRoots.length) return list
    const { commits, unreadable } = draftEffects.listedBatchCommits()
    if (unreadable) list.partial = true
    for (const run of batchRoots) {
      try {
        const batch = draftEffects.readBatchHistory(run.handle.runId, deps.projectId, commits)
        if (batch.nextChapterNumber !== null) list.batches.push(batch)
      } catch { list.partial = true }
    }
    return list
  }
  /**
   * 蓝图页挂载时要的那份：最新一个还没写完的章节蓝图恢复稿；只读章节蓝图运行，读不出的跳过，不挡更早的恢复稿。
   * 作者整段保存完的（续写已完成）与运行侧页一样不算。
   */
  const findBlueprintRecovery = (): GenerationRecoveryContext | null => {
    assertCurrent()
    for (const run of runSummaries().filter(item => item.operation === 'chapter-blueprint-directory')) {
      let recovery: GenerationRecoveryContext
      try { recovery = readContext(run.handle) } catch { continue }
      if (recovery.blueprintRecovery && recovery.blueprintRecovery.writeState !== 'complete' && recovery.planningContinuation?.state !== 'complete') return recovery
    }
    return null
  }
  const finalizationRecovery = (run: DurableGenerationRun): FinalizationGenerationRecovery => {
    assertCurrent()
    const context = readFinalizationGenerationContext(run), effect = finalizations.readEffect(run)
    let current = false
    try { current = repository.budget(run.rootActionId).root.status !== 'cancelled' && compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))) } catch { /* History remains readable without current source/model admission. */ }
    const attempts = runAttempts(run.runId), last = attempts.at(-1)
    const receipt = last && (volatileReceipts.get(last.attemptId) ?? repository.receipt(last.attemptId))
    return { view: viewOf(run), context, modelId: modelReceipt(run.binding).modelId, sourceStatus: current ? 'current' : 'conflict',
      attemptCount: attempts.length, ...(effect ? { effect } : {}),
      ...(receipt ? { latestAttempt: { attemptId: receipt.attempt.attemptId, inFlight: ['reserved', 'dispatch-marked'].includes(receipt.attempt.status),
        finishReason: receipt.result?.finishReason ?? null, failureCode: receipt.failureCode ?? null } } : {}) }
  }
  const assertFinalizationSources = (run: DurableGenerationRun) => {
    assertCurrent()
    if (repository.budget(run.rootActionId).root.status === 'cancelled') throw new Error('GENERATION_ACTION_CANCELLED')
    if (!compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding)))) throw new Error('GENERATION_SOURCE_CHANGED')
  }
  /** 角色状态回答不合合同（坏 JSON 或合同码）时返回那个错误，合格时返回 undefined；别的错误照抛。 */
  const characterContractFailure = (text: string, identity: FinalizedCharacterContext): Error | undefined => {
    try { parseFinalizedCharacterStateResponse(text, identity); return undefined } catch (error) {
      if (error instanceof SyntaxError || error instanceof Error && /^FINALIZED_CHARACTER_(UPDATES_INVALID|UPDATE_INVALID|EVIDENCE_MISSING|EVIDENCE_NOT_UNIQUE|EVIDENCE_INVALID|FIELD_INVALID|IDENTITY_REQUIRED|DUPLICATE_ID)$/.test(error.message)) return error
      throw error
    }
  }
  /** 作者点重试时能否另开运行：本运行没有写入结果、没有在途请求，最后的候选也不能直接提交。能提交的候选沿用它，不重新计费。 */
  const finalizationRetriesWithNewRun = (run: DurableGenerationRun): boolean => {
    if (finalizations.readEffect(run) || repository.budget(run.rootActionId).attempts.some(attempt => ['reserved', 'dispatch-marked'].includes(attempt.status))) return false
    const candidate = viewOf(run).candidates?.at(-1)
    if (candidate?.status !== 'completed' || !candidate.compositionEligible) return true
    const context = readFinalizationGenerationContext(run)
    return context.slot.stepKey === 'character_cards' && !!characterContractFailure(candidate.text, context.identity)
  }
  const graphRecovery = (run: DurableGenerationRun): GraphGenerationRecovery => {
    assertCurrent()
    const context = readGraphGenerationContext(run), effects = graphs.effects(run)
    const attempts = deps.database.prepare('SELECT attempt_id FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(run.runId) as { attempt_id: string }[]
    if (attempts.length > 1) throw new Error('GENERATION_GRAPH_ATTEMPT_CONFLICT')
    let artifact: GraphGenerationRecovery['artifact'], result: GraphGenerationRecovery['result']
    if (attempts[0]) {
      const candidate = repository.receipt(attempts[0].attempt_id).artifact
      if (candidate) {
        const reference = { artifactId: candidate.artifactId, revision: candidate.revision, textHash: candidate.textHash }
        try { result = graphs.result(run, reference); artifact = reference } catch { /* Unqualified raw output remains in the run view for copying. */ }
      }
    }
    let current = false
    try { assertFinalizationSources(run); current = true } catch { /* Historical context/result does not require current sources or model. */ }
    return { view: viewOf(run), modelId: modelReceipt(run.binding).modelId, context, effects, attemptCount: attempts.length,
      sourceStatus: current ? 'current' : 'conflict', ...(artifact && result ? { artifact, result } : {}) }
  }
  const legacyRosterRecovery = (run: DurableGenerationRun): LegacyRosterGenerationRecovery => {
    assertCurrent()
    const context = readLegacyRosterGenerationContext(run), proposal = legacyRosters.proposal(run), artifact = legacyRosters.artifactFor(run)
    let current = false
    try { assertFinalizationSources(run); current = true } catch { /* Preserve original candidate/proposal when author facts or model change. */ }
    return { view: viewOf(run), modelId: modelReceipt(run.binding).modelId, context, sourceStatus: current ? 'current' : 'conflict',
      attemptCount: deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) as number,
      ...(artifact ? {artifact} : {}), ...(proposal ? {proposal} : {}) }
  }
  const beginPlanningFeedbackRun = (request: { input: PlanningFeedbackGenerationInput; modelId: string; uiActionNonce: string }) => {
    assertCurrent()
    assertPlanningFeedbackObject(request, ['input', 'modelId', 'uiActionNonce'])
    if (typeof request.uiActionNonce !== 'string' || !request.uiActionNonce.trim() || request.uiActionNonce.length > 256)
      throw new Error('GENERATION_BEGIN_INVALID')
    const rows = deps.database.prepare(`SELECT r.run_id FROM generation_runs r JOIN generation_roots g ON g.root_action_id=r.root_action_id
      WHERE json_extract(g.action_json,'$.operation')='planning-feedback' AND json_extract(g.action_json,'$.projectId')=?
        AND json_extract(g.action_json,'$.uiActionNonce')=?`).all(deps.projectId, request.uiActionNonce) as { run_id: string }[]
    if (rows.length > 1) throw new Error('GENERATION_NONCE_CONFLICT')
    if (rows[0]) {
      assertLegacyRunAccess(rows[0].run_id)
      if (deps.mode === 'runtime-feedback') throw new Error('GENERATION_NONCE_CONFLICT')
      const prior = repository.get(rows[0].run_id)
      if (!isDeepStrictEqual(request.input, prior.binding.sourceManifest.planningFeedbackInput)
        || request.modelId !== modelReceipt(prior.binding).modelId) throw new Error('GENERATION_NONCE_CONFLICT')
      return viewOf(prior)
    }
    const prepared = planningFeedback().prepare(request.input)
    return begin({ operation: 'planning-feedback', uiActionNonce: request.uiActionNonce, modelId: request.modelId,
      selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: [`planning-feedback-v${prepared.context.schemaVersion}`], skillStages: ['planning'],
      output: 'visible-text', planningFeedbackInput: structuredClone(request.input) }, false, false, false, false, false, false, true)
  }
  const executePlanningFeedbackRun = async (handle: MainGenerationRunHandle) => {
    const run = requireRun(handle)
    if (run.binding.sourceManifest.operation !== 'planning-feedback') throw new Error('GENERATION_FEEDBACK_ADMISSION_REQUIRED')
    const task = readPlanningFeedbackTask(run), invocationNonce = 'planning-feedback:0'
    const requestHash = textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
    const prior = repository.findInvocation(run.runId, invocationNonce, requestHash)
    if (prior) {
      const running = pending.get(JSON.stringify([run.runId, invocationNonce]))
      return running ? running.promise : outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior, task)
    }
    if (runAttempts(run.runId).length) throw new Error('GENERATION_FEEDBACK_ATTEMPT_CONFLICT')
    const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
    return execute({ handle: current.handle, invocationNonce, task }, false, false, false, false, false, false, undefined, true)
  }
  const executeRuntimeFieldFeedback = async (handle: MainGenerationRunHandle) => {
    if (deps.mode !== 'runtime-feedback' || !deps.runtimeFeedback) throw new Error('GENERATION_RUNTIME_FEEDBACK_ADMISSION_REQUIRED')
    deps.runtimeFeedback.assertActive(handle.runId)
    const { run } = fieldFeedbackRun(handle)
    const task = readPlanningFeedbackTask(run), invocationNonce = 'planning-feedback:0'
    const requestHash = textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
    const prior = repository.findInvocation(run.runId, invocationNonce, requestHash)
    if (prior) {
      const running = pending.get(JSON.stringify([run.runId, invocationNonce]))
      return running ? running.promise : outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior, task)
    }
    if (runAttempts(run.runId).length) throw new Error('GENERATION_FEEDBACK_ATTEMPT_CONFLICT')
    return execute({ handle, invocationNonce, task }, false, false, false, false, false, false, undefined, true)
  }
  const executeWorkflowDriver = async (request: ExecuteGenerationRequest) => {
    if (!isDriverMode || !deps.workflowDriver) throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
    deps.workflowDriver.assertActive(request.handle.runId)
    const run = requireRun(request.handle, true)
    if (!isDriverRun(run.runId)) throw new Error('GENERATION_WORKFLOW_DRIVER_ACCESS_DENIED')
    const requestHash = textHash(JSON.stringify([request.task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
    const prior = repository.findInvocation(run.runId, request.invocationNonce, requestHash)
    if (prior) {
      const running = pending.get(JSON.stringify([run.runId, request.invocationNonce]))
      return running ? running.promise : outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior, request.task)
    }
    return execute(request, false, false, false, false, false, false, undefined, false, true)
  }
  const api = { begin: (selection: BeginGenerationRequest) => begin(selection), bindMaterialDecision, execute: (request: ExecuteGenerationRequest) => execute(request), resume, list, assertSourcesCurrent,
    agents: guardWork(agents, name => ['read', 'hasActiveToolClaims', 'requestProjectClose'].includes(name)),
    executeRuntimeFieldFeedback,
    executeWorkflowDriver,
    pauseWorkflowDriver: (handle: MainGenerationRunHandle, cancel = false) => {
      if (!isDriverMode) throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
      const run = requireRun(handle)
      if (!isDriverRun(run.runId)) throw new Error('GENERATION_WORKFLOW_DRIVER_ACCESS_DENIED')
      if (cancel) service.cancelRuntimeFeedback(run.rootActionId)
      else service.pauseWorkflowDriver(run.rootActionId)
    },
    recoverWorkflowDriverRun: (runId: string) => {
      if (!isDriverMode) throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
      assertAdmission()
      if (physicalDispatches || pending.size) throw new Error('GENERATION_OWNER_BUSY')
      if (repository.get(runId).binding.epoch === deps.epoch) throw new Error('GENERATION_WORKFLOW_DRIVER_EPOCH_CURRENT')
      repository.recoverWorkflowDriverRun(runId)
      return viewOf(repository.get(runId))
    },
    assertWorkflowDriverRecoverySources: (handle: MainGenerationRunHandle) => {
      if (!isDriverMode || !isDriverRun(handle.runId)) throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
      const run = requireRun(handle)
      if (!compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))))
        throw new Error('GENERATION_SOURCE_CHANGED')
    },
    beginWorkflowDriver: (selection: BeginGenerationRequest) => {
      if (deps.mode !== 'workflow-driver') throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
      if (selection.operation !== 'chapter-draft' || selection.chapterNumber !== 1 || !selection.preparationId
        || !selection.materialDecision || selection.selectedDraftIds.length || selection.selectedFinalizedDraftIds.length
        || !Array.isArray(selection.materialDecision.included) || selection.materialDecision.reconciliationPromptHash
        || selection.materialDecision.included.some(source => source.category === 'finalized-history'
          || /^(?:candidate|finalized):/u.test(source.sourceId))
        || selection.batchId || selection.parentRootActionId || selection.output !== 'visible-text')
        throw new Error('GENERATION_WORKFLOW_DRIVER_SCOPE_INVALID')
      const view = begin(selection)
      driverPreparations.set(view.handle.runId, { ...view.handle })
      return view
    },
    beginWorkflowBatchRoot: (request: BeginGenerationBatchRequest) => {
      if (deps.mode !== 'workflow-batch' || !deps.database.inTransaction) throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
      assertGenerationBatchIntent(request)
      if (request.mode !== 'draft_review') throw new Error('GENERATION_WORKFLOW_DRIVER_SCOPE_INVALID')
      const { mode, range, targetUnits, ...intent } = request
      const view = begin({ ...intent, operation: 'batch-chapters', selectedDraftIds: [], selectedFinalizedDraftIds: [],
        selectedBlueprintChapterNumbers: Array.from({ length: range.endChapter - range.startChapter + 1 }, (_, index) => range.startChapter + index),
        output: 'visible-text', batchIntent: { mode, range, targetUnits } }, true)
      driverPreparations.set(view.handle.runId, { ...view.handle })
      return view
    },
    beginWorkflowBatchRun: (selection: BeginGenerationRequest) => {
      if (deps.mode !== 'workflow-batch' || !deps.database.inTransaction) throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
      if (selection.operation === 'chapter-draft') {
        if (!selection.batchId || !selection.parentRootActionId || !selection.preparationId || !selection.materialDecision
          || selection.output !== 'visible-text') throw new Error('GENERATION_WORKFLOW_DRIVER_SCOPE_INVALID')
      } else if (selection.operation === 'review-chapter') {
        if (selection.batchId || selection.parentRootActionId || !selection.reviewRevisionContextId
          || selection.output !== 'structured-data') throw new Error('GENERATION_WORKFLOW_DRIVER_SCOPE_INVALID')
      } else throw new Error('GENERATION_WORKFLOW_DRIVER_SCOPE_INVALID')
      const view = begin(selection)
      driverPreparations.set(view.handle.runId, { ...view.handle })
      return view
    },
    retryWorkflowBatchShortOutline: (request: GenerationOwnerChannels['generation:retry-draft-short-outline']['args'][0]) => {
      if (deps.mode !== 'workflow-batch') throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
      const run = requireRun(request.handle, true)
      if (!isBatchDriverRun(run.runId)) throw new Error('GENERATION_WORKFLOW_DRIVER_ACCESS_DENIED')
      deps.workflowDriver!.assertActive(run.runId)
      const task = readFailedShortOutlineTask(run, request.failedAttemptId)
      return execute({ handle: request.handle, invocationNonce: `draft-short-outline-retry:${request.failedAttemptId}`, task },
        false, false, false, false, false, false, request.failedAttemptId, false, true)
    },
    rollbackWorkflowDriverPreparation: (handle: MainGenerationRunHandle) => {
      if (!isDriverMode) throw new Error('GENERATION_WORKFLOW_DRIVER_ADMISSION_REQUIRED')
      if (closed || !deps.database.open) throw new Error('GENERATION_OWNER_CLOSED')
      if (deps.assertRetirementResources) deps.assertRetirementResources()
      else deps.assertCurrent()
      if (deps.database.inTransaction) throw new Error('GENERATION_WORKFLOW_DRIVER_TRANSACTION_OPEN')
      if (!isDeepStrictEqual(driverPreparations.get(handle.runId), handle)) throw new Error('GENERATION_WORKFLOW_DRIVER_PREPARATION_INVALID')
      if (deps.database.prepare('SELECT 1 FROM generation_runs WHERE run_id=?').get(handle.runId)
        || deps.database.prepare('SELECT 1 FROM generation_attempts WHERE run_id=?').get(handle.runId)
        || isDriverRun(handle.runId)) throw new Error('GENERATION_WORKFLOW_DRIVER_PREPARATION_DURABLE')
      const leaseId = runLeases.get(handle.runId)
      if (leaseId) { deps.leases.close(leaseId); runLeases.delete(handle.runId) }
      driverPreparations.delete(handle.runId)
    },
    beginRuntimeFieldFeedback: (request: { input: PlanningFeedbackGenerationInput; modelId: string; uiActionNonce: string }) => {
      if (deps.mode !== 'runtime-feedback') throw new Error('GENERATION_RUNTIME_FEEDBACK_ADMISSION_REQUIRED')
      fieldFeedbackBase(request.input.baseId)
      if (request.input.parentCandidateId) fieldFeedbackCandidate(request.input.parentCandidateId)
      const view = beginPlanningFeedbackRun(request)
      runtimePreparations.set(view.handle.runId, { ...view.handle })
      return view
    },
    rollbackRuntimeFieldFeedbackPreparation: (handle: MainGenerationRunHandle) => {
      if (deps.mode !== 'runtime-feedback') throw new Error('GENERATION_RUNTIME_FEEDBACK_ADMISSION_REQUIRED')
      if (closed || !deps.database.open) throw new Error('GENERATION_OWNER_CLOSED')
      if (deps.assertRetirementResources) deps.assertRetirementResources()
      else deps.assertCurrent()
      if (deps.database.inTransaction) throw new Error('GENERATION_RUNTIME_FEEDBACK_TRANSACTION_OPEN')
      if (!isDeepStrictEqual(runtimePreparations.get(handle.runId), handle)) throw new Error('GENERATION_RUNTIME_FEEDBACK_PREPARATION_INVALID')
      if (deps.database.prepare('SELECT 1 FROM generation_runs WHERE run_id=?').get(handle.runId)
        || deps.database.prepare('SELECT 1 FROM generation_attempts WHERE run_id=?').get(handle.runId)
        || deps.database.prepare('SELECT 1 FROM runtime_feedback_grants WHERE run_id=?').get(handle.runId))
        throw new Error('GENERATION_RUNTIME_FEEDBACK_PREPARATION_DURABLE')
      const leaseId = runLeases.get(handle.runId)
      if (leaseId) {
        deps.leases.close(leaseId)
        runLeases.delete(handle.runId)
      }
      runtimePreparations.delete(handle.runId)
    },
    stageRuntimeFieldFeedback: (request: StagePlanningFeedbackCandidate) => {
      if (deps.mode !== 'runtime-feedback') throw new Error('GENERATION_RUNTIME_FEEDBACK_ADMISSION_REQUIRED')
      if (!deps.database.inTransaction) throw new Error('GENERATION_RUNTIME_FEEDBACK_TRANSACTION_REQUIRED')
      fieldFeedbackBase(request.baseId)
      if (request.parentCandidateId) fieldFeedbackCandidate(request.parentCandidateId)
      const { input } = fieldFeedbackRun(handleOf(repository.get(request.runId)))
      if (input.baseId !== request.baseId) throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
      return planningFeedback().stage(request)
    },
    cancelRuntimeFieldFeedback: (handle: MainGenerationRunHandle) => {
      if (deps.mode !== 'runtime-feedback') throw new Error('GENERATION_RUNTIME_FEEDBACK_ADMISSION_REQUIRED')
      if (!isDeepStrictEqual(runtimePreparations.get(handle.runId), handle)) throw new Error('GENERATION_RUNTIME_FEEDBACK_PREPARATION_INVALID')
      service.cancelRuntimeFeedback(handle.rootActionId)
    },
    captureFieldFeedback: (target: PlanningFeedbackCoreTarget) => {
      const base = planningFeedback().captureBase(target)
      if (base.schemaVersion !== 1) throw new Error('PLANNING_FEEDBACK_TARGET_INVALID')
      return base
    },
    listFieldFeedbackBases: (target: PlanningFeedbackCoreTarget) => planningFeedback().listFieldBases(target),
    readFieldFeedbackHistory: (baseId: string) => {
      const base = fieldFeedbackBase(baseId), service = planningFeedback()
      return { base, candidates: service.listCandidates(baseId).map(candidate => ({ candidate, state: service.candidateState(candidate.candidateId) })),
        adoptions: service.listAdoptions(baseId) }
    },
    beginFieldFeedback: (request: { input: PlanningFeedbackGenerationInput; modelId: string; uiActionNonce: string }) => {
      fieldFeedbackBase(request.input.baseId)
      if (request.input.parentCandidateId) fieldFeedbackCandidate(request.input.parentCandidateId)
      const { parentCandidateId, ...input } = request.input
      return beginPlanningFeedbackRun({ ...request, input: { ...input, ...(parentCandidateId !== undefined ? { parentCandidateId } : {}) } })
    },
    readFieldFeedbackRun: (handle: MainGenerationRunHandle): PlanningFeedbackRunRecovery => {
      const { run, input } = fieldFeedbackRun(handle)
      let sourceStatus: 'current' | 'conflict' = 'current'
      try {
        planningFeedback().prepare(input)
        if (!compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding)))) sourceStatus = 'conflict'
      } catch (error) {
        if (error instanceof Error && (['PLANNING_FEEDBACK_SOURCE_CONFLICT', 'PLANNING_FEEDBACK_PARENT_CONFLICT',
          'PLANNING_FEEDBACK_HISTORY_FROZEN', 'GENERATION_MODEL_CHANGED', 'GENERATION_MODEL_MISSING',
          'GENERATION_SKILL_BINDINGS_INVALID', 'GENERATION_SKILL_ID_INVALID', 'GENERATION_SKILL_MISSING',
          'GENERATION_SKILL_BUNDLE_DAMAGED', 'GENERATION_SKILL_INCOMPATIBLE', 'GENERATION_SOURCE_CHANGED',
          'GENERATION_ASSET_CHANGED_DURING_SNAPSHOT', 'GENERATION_SOURCE_CHANGED_DURING_SNAPSHOT'].includes(error.message)
          || (error as NodeJS.ErrnoException).code === 'ENOENT')) sourceStatus = 'conflict'
        else throw error
      }
      return { view: viewOf(run), modelId: modelReceipt(run.binding).modelId, input: structuredClone(input), sourceStatus }
    },
    listFieldFeedbackRuns: (baseId: string) => {
      fieldFeedbackBase(baseId)
      const ids = new Set((deps.database.prepare(`SELECT run_id FROM generation_runs WHERE
        json_extract(binding_json,'$.sourceManifest.operation')='planning-feedback'
        AND json_extract(binding_json,'$.sourceManifest.planningFeedbackInput.baseId')=?
        AND json_extract(binding_json,'$.sourceManifest.planningFeedbackContext.schemaVersion')=1`).all(baseId) as { run_id: string }[]).map(row => row.run_id))
      return runSummaries().filter(item => ids.has(item.handle.runId)).map(({ handle, status, operation }) => ({ handle, status, operation }))
    },
    executeFieldFeedback: (handle: MainGenerationRunHandle) => {
      const { run } = fieldFeedbackRun(handle)
      if (runtimeFreeze.isFrozen('generation_runs', run.runId)) throw new Error('PLANNING_FEEDBACK_HISTORY_FROZEN')
      return executePlanningFeedbackRun(handle)
    },
    cancelFieldFeedback: (handle: MainGenerationRunHandle) => {
      const { run } = fieldFeedbackRun(handle)
      if (runtimeFreeze.isFrozen('generation_runs', run.runId)) throw new Error('PLANNING_FEEDBACK_HISTORY_FROZEN')
      service.cancel(run.rootActionId)
      return viewOf(repository.get(run.runId))
    },
    stageFieldFeedback: (request: StagePlanningFeedbackCandidate) => {
      fieldFeedbackBase(request.baseId)
      if (request.parentCandidateId) fieldFeedbackCandidate(request.parentCandidateId)
      const { input } = fieldFeedbackRun(handleOf(repository.get(request.runId)))
      if (input.baseId !== request.baseId) throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
      return planningFeedback().stage(request)
    },
    relineageFieldFeedback: (request: RelineagePlanningFeedbackCandidate) => {
      fieldFeedbackBase(request.baseId); fieldFeedbackCandidate(request.sourceCandidateId)
      return planningFeedback().relineage(request)
    },
    adoptFieldFeedback: (request: AdoptPlanningFeedbackCandidate) => {
      fieldFeedbackCandidate(request.candidateId)
      return planningFeedback().adopt(request)
    },
    capturePlanningFeedbackBase: (target: PlanningFeedbackCaptureTarget) => planningFeedback().captureBase(target),
    preparePlanningFeedback: (input: PlanningFeedbackGenerationInput) => planningFeedback().prepare(input),
    beginPlanningFeedback: beginPlanningFeedbackRun,
    executePlanningFeedback: executePlanningFeedbackRun,
    stagePlanningFeedback: (request: StagePlanningFeedbackCandidate) => { assertLegacyRunAccess(request.runId); return planningFeedback().stage(request) },
    adoptPlanningFeedback: (request: AdoptPlanningFeedbackCandidate) => planningFeedback().adopt(request),
    relineagePlanningFeedback: (request: RelineagePlanningFeedbackCandidate) => planningFeedback().relineage(request),
    listPlanningFeedbackCandidates: (baseId: string) => planningFeedback().listCandidates(baseId),
    listPlanningFeedbackAdoptions: (baseId: string) => planningFeedback().listAdoptions(baseId),
    planningFeedbackCandidateState: (candidateId: string) => planningFeedback().candidateState(candidateId),
    readLegacyRosterSource: () => { assertCurrent(); return readLegacyRosterSource(deps.database) },
    adoptLegacyCards: (request: LegacyRosterGenerationChannels['legacy-roster:adopt-existing']['args'][0]) => { assertCurrent(); return adoptLegacyCards(deps.database, request) },
    beginLegacyRosterGeneration: (request: LegacyRosterGenerationChannels['legacy-roster:begin']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['modelId','uiActionNonce'].includes(key)) || typeof request.uiActionNonce !== 'string'
        || !request.uiActionNonce.trim() || request.uiActionNonce.length > 256) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      const rows = deps.database.prepare("SELECT r.run_id FROM generation_runs r JOIN generation_roots g ON g.root_action_id=r.root_action_id WHERE json_extract(g.action_json,'$.projectId')=? AND json_extract(g.action_json,'$.uiActionNonce')=? AND json_extract(r.binding_json,'$.sourceManifest.legacyRosterContext') IS NOT NULL").all(deps.projectId,request.uiActionNonce) as {run_id:string}[]
      if (rows.length > 1) throw new Error('GENERATION_NONCE_CONFLICT')
      if (rows[0]) return legacyRosterRecovery(repository.get(rows[0].run_id))
      const view = begin({operation:'legacy-character-roster-repair',uiActionNonce:request.uiActionNonce,modelId:request.modelId,
        selectedDraftIds:[],selectedFinalizedDraftIds:[],promptKeys:['legacy-roster'],skillStages:[],output:'structured-data',legacyRosterKey:randomUUID()},false,false,false,false,false,true)
      return legacyRosterRecovery(repository.get(view.handle.runId))
    },
    readLegacyRosterGeneration: (request: LegacyRosterGenerationChannels['legacy-roster:read']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      return legacyRosterRecovery(legacyRosters.require(request.handle))
    },
    executeLegacyRosterGeneration: async (request: LegacyRosterGenerationChannels['legacy-roster:execute']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      let run = legacyRosters.require(request.handle)
      const context = readLegacyRosterGenerationContext(run), initialTask = legacyRosters.task(run)
      let stageTask = initialTask, total = 0
      for (const stage of ['initial','repair'] as const) {
        let previousText: string | undefined
        for (let ordinal = 0; ordinal < 3; ordinal++, total++) {
          const task = previousText === undefined ? stageTask : buildLegacyRosterReplacementTask(stageTask, previousText, context.source.writingLanguage)
          const invocationNonce = `legacy:${stage}:${ordinal}`
          const requestHash = textHash(JSON.stringify([task,run.binding.fingerprint.modelLeaseRevision,run.binding.fingerprint.policyHash]))
          const prior = repository.findInvocation(run.runId,invocationNonce,requestHash)
          let result: MainGenerationExecuteReceipt
          if (prior) result = await (pending.get(JSON.stringify([run.runId,invocationNonce]))?.promise ?? outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior,task))
          else {
            legacyRosters.assertMutable(run)
            if (deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) !== total) throw new Error('GENERATION_LEGACY_ATTEMPT_CONFLICT')
            const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
            result = await execute({handle:current.handle,invocationNonce,task},false,false,false,false,false,true)
          }
          run = repository.get(run.runId)
          const reference = result.outcome.receipt.visibleArtifact
          const candidate = (result.run.candidates ?? result.run.artifacts).find(item => item.artifactId === reference?.artifactId)
          if (!candidate?.compositionEligible || repository.budget(run.rootActionId).root.status === 'cancelled') return result
          if (textHash(candidate.text) !== candidate.textHash) throw new Error('GENERATION_LEGACY_ARTIFACT_INVALID')
          if (result.outcome.finishReason === 'length') {
            if (ordinal === 2) return result
            previousText = candidate.text
            continue
          }
          if (result.outcome.finishReason !== 'stop' || result.outcome.status !== 'completed') return result
          try { parseLegacyRosterJson(candidate.text); return result } catch {
            if (stage === 'repair') return result
            stageTask = buildLegacyRosterJsonRepairTask(candidate.text)
            total++
            break
          }
        }
      }
      throw new Error('GENERATION_LEGACY_ATTEMPT_CONFLICT')
    },
    stageLegacyRosterGeneration: (request: LegacyRosterGenerationChannels['legacy-roster:stage']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['handle','artifact'].includes(key))) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      return legacyRosters.stage(request.handle,request.artifact,assertFinalizationSources)
    },
    cancelLegacyRosterGeneration: (request: LegacyRosterGenerationChannels['legacy-roster:cancel']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      const run = legacyRosters.require(request.handle); service.cancel(run.rootActionId); return viewOf(repository.get(run.runId))
    },
    beginGraphGeneration: (request: GraphGenerationChannels['graph-generation:begin']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['input', 'modelId', 'uiActionNonce'].includes(key))
        || typeof request.uiActionNonce !== 'string' || !request.uiActionNonce.trim() || request.uiActionNonce.length > 256) throw new Error('GENERATION_GRAPH_INPUT_INVALID')
      const input = validateGraphGenerationInput(request.input)
      const rows = deps.database.prepare("SELECT r.run_id FROM generation_runs r JOIN generation_roots g ON g.root_action_id=r.root_action_id WHERE json_extract(g.action_json,'$.projectId')=? AND json_extract(g.action_json,'$.uiActionNonce')=? AND json_extract(r.binding_json,'$.sourceManifest.graphGenerationContext') IS NOT NULL").all(deps.projectId, request.uiActionNonce) as { run_id: string }[]
      if (rows.length > 1) throw new Error('GENERATION_NONCE_CONFLICT')
      if (rows[0]) {
        const run = repository.get(rows[0].run_id)
        if (!isDeepStrictEqual(readGraphGenerationContext(run).input, input)) throw new Error('GENERATION_NONCE_CONFLICT')
        return graphRecovery(run)
      }
      const view = begin({ operation: graphOperations[input.kind], uiActionNonce: request.uiActionNonce, modelId: request.modelId,
        selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: [`graph-${input.kind}`], skillStages: [], output: 'structured-data',
        graphGenerationInput: input, graphGenerationKey: randomUUID() }, false, false, false, false, true)
      return graphRecovery(repository.get(view.handle.runId))
    },
    readGraphGeneration: (request: GraphGenerationChannels['graph-generation:read']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_GRAPH_REQUEST_INVALID')
      return graphRecovery(graphs.require(request.handle))
    },
    executeGraphGeneration: async (request: GraphGenerationChannels['graph-generation:execute']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_GRAPH_REQUEST_INVALID')
      const run = graphs.require(request.handle), task = graphs.task(run), invocationNonce = 'graph:0'
      const requestHash = textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
      const prior = repository.findInvocation(run.runId, invocationNonce, requestHash)
      if (prior) return pending.get(JSON.stringify([run.runId, invocationNonce]))?.promise ?? outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior, task)
      graphs.assertMutable(run)
      legacyRosters.assertMutable(run)
      if (deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) !== 0) throw new Error('GENERATION_GRAPH_ATTEMPT_CONFLICT')
      const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
      return execute({ handle: current.handle, invocationNonce, task }, false, false, false, false, true)
    },
    confirmGraphGeneration: (request: GraphGenerationChannels['graph-generation:confirm']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['handle', 'artifact', 'index'].includes(key))) throw new Error('GENERATION_GRAPH_REQUEST_INVALID')
      return graphs.confirm(request.handle, request.artifact, request.index, assertFinalizationSources)
    },
    cancelGraphGeneration: (request: GraphGenerationChannels['graph-generation:cancel']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_GRAPH_REQUEST_INVALID')
      const run = graphs.require(request.handle)
      service.cancel(run.rootActionId)
      return viewOf(repository.get(run.runId))
    },
    readFinalizationGeneration: (request: FinalizationGenerationChannels['finalization-generation:read']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'slot')) throw new Error('GENERATION_FINALIZATION_SLOT_INVALID')
      const run = finalizations.find(request.slot)
      return run ? finalizationRecovery(run) : null
    },
    beginFinalizationGeneration: (request: FinalizationGenerationChannels['finalization-generation:begin']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['slot', 'modelId', 'parentRootActionId', 'retryRunId'].includes(key))) throw new Error('GENERATION_FINALIZATION_SLOT_INVALID')
      const { slot } = request, prior = finalizations.find(slot)
      // 作者重试没有可提交结果的运行：在同一 root 另开运行，用作者现在选的模型，修正次数与首跑相同。
      const explicitRetry = prior !== undefined && request.retryRunId === prior.runId
      const authorRetry = explicitRetry && finalizationRetriesWithNewRun(prior)
      if (prior && !authorRetry && !finalizations.retryable(prior)) return finalizationRecovery(prior)
      const sibling = finalizations.find({ source: slot.source, stepKey: slot.stepKey === 'chapter_notes' ? 'character_cards' : 'chapter_notes' })
      const predecessor = prior ?? sibling
      let parentRootActionId = predecessor && repository.budget(predecessor.rootActionId).root.status !== 'cancelled' ? predecessor.rootActionId : undefined
      // 作者点重试而另开的运行（包括要点改过、root 被取消的情形）一律用作者现在选的模型。
      let selectedModelId = predecessor && !explicitRetry ? modelReceipt(predecessor.binding).modelId : request.modelId
      if (request.parentRootActionId !== undefined) {
        const root = repository.budget(request.parentRootActionId).root
        if (root.operation !== 'batch-chapters' || root.projectId !== deps.projectId || parentRootActionId && parentRootActionId !== request.parentRootActionId) throw new Error('GENERATION_FINALIZATION_PARENT_INVALID')
        const rows = deps.database.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=? ORDER BY rowid').all(root.rootActionId) as { run_id: string }[]
        const committed = rows.map(row => repository.get(row.run_id)).filter(run => run.binding.sourceManifest.operation === 'chapter-draft')
          .map(run => ({ run, receipt: draftEffects.readCommit(run.runId) })).find(item => item.receipt?.id === slot.source.draftId)
        if (!committed || committed.receipt?.contentHash !== slot.source.contentHash) throw new Error('GENERATION_FINALIZATION_PARENT_INVALID')
        parentRootActionId = root.rootActionId; selectedModelId = modelReceipt(committed.run.binding).modelId
      }
      // 只查新运行要加入的根（已取消的根不会被加入）：它已阻断或预算用完时新运行也发不出请求，直接报原因，不留空运行。
      const target = authorRetry && parentRootActionId ? repository.budget(parentRootActionId) : undefined
      const blockedCode = target && (target.blockedCode ?? (rootBudgetExhausted(target.policy, target.attempts, target.activeElapsedMs) ? 'ROOT_BUDGET_EXHAUSTED' : null))
      if (blockedCode) throw new Error(blockedCode)
      if (sibling && !finalizations.readEffect(sibling)) throw new Error('GENERATION_FINALIZATION_PREDECESSOR_REQUIRED')
      const prepared = finalizedCharacters.readContext(slot.source.draftId)
      if (!isDeepStrictEqual(prepared.context.source, slot.source)) throw new Error('GENERATION_FINALIZATION_SOURCE_CHANGED')
      const characterStep = slot.stepKey === 'character_cards'
      const view = begin({ operation: characterStep ? 'finalized-character-state' : 'finalized-chapter-notes', uiActionNonce: `finalization:${finalizationSlotKey(slot)}${prior ? `:retry:${prior.runId}` : ''}`,
        modelId: selectedModelId, chapterNumber: slot.source.chapterNumber, selectedDraftIds: [], selectedFinalizedDraftIds: [slot.source.draftId],
        promptKeys: [characterStep ? 'update_character_cards' : 'generate_chapter_notes'], skillStages: ['review'], output: characterStep ? 'structured-data' : 'visible-text',
        authorInputs: [{ id: 'finalized-character-context', text: JSON.stringify(prepared.context) }],
        ...(characterStep ? { finalizedCharacterContextId: prepared.contextId } : {}), ...(parentRootActionId ? { parentRootActionId } : {}), finalizationGenerationSlot: slot }, false, false, false, true)
      return finalizationRecovery(repository.get(view.handle.runId))
    },
    executeFinalizationGeneration: async (request: FinalizationGenerationChannels['finalization-generation:execute']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['handle', 'retryOf', 'recoverFrom'].includes(key))
        || request.recoverFrom !== undefined && (request.retryOf !== undefined || typeof request.recoverFrom !== 'string' || !ATTEMPT_ID.test(request.recoverFrom))) throw new Error('GENERATION_FINALIZATION_REQUEST_INVALID')
      let run = finalizations.require(request.handle)
      const initialTask = finalizations.task(run), context = readFinalizationGenerationContext(run)
      const replay = (attempt: ReturnType<typeof runAttempts>[number]) => pending.get(JSON.stringify([run.runId, attempt.invocationNonce]))?.promise
        ?? outcomeOf(volatileReceipts.get(attempt.attemptId) ?? repository.receipt(attempt.attemptId), { purpose: attempt.purpose })
      const failureOf = (text: string) => characterContractFailure(text, context.identity)
      const repairTask = (invalidText: string | undefined, ordinal: number | string, error?: Error): GenerationTask => {
        const code = error?.message ?? ''
        const repairKind = code === 'FINALIZED_CHARACTER_EVIDENCE_MISSING' ? 'evidence-missing' : code.startsWith('FINALIZED_CHARACTER_EVIDENCE_') ? 'evidence-span' : 'generic'
        const detail = error instanceof FinalizedCharacterEvidenceError ? context.writingLanguage === 'en-US'
          ? ` updates[${error.updateIndex}].evidence.text: ${error.reason === 'no-exact-match' ? '0 exact matches' : error.reason === 'multiple-exact-matches' ? 'at least 2 exact matches' : error.reason === 'missing' ? 'evidence is missing' : 'start/end do not match the exact source span'}.`
          : `updates[${error.updateIndex}].evidence.text：${error.reason === 'no-exact-match' ? '精确匹配 0 次' : error.reason === 'multiple-exact-matches' ? '精确匹配至少 2 次' : error.reason === 'missing' ? '缺少 evidence' : 'start/end 与精确原文片段不符'}。` : ''
        const english = context.writingLanguage === 'en-US'
        // Only our own error codes select fixed guidance; model text and error details never enter the message.
        const guidance = repairKind === 'generic' ? '' : repairKind === 'evidence-missing' ? english
          ? ' At least one update had no evidence object. Keep the supported updates from the preceding response instead of returning an empty list because evidence was missing. Give every update an evidence.text copied as one contiguous, verbatim span of the frozen chapter, and omit start/end so the program calculates them. For a person who has an existing character card, use that card\'s characterId rather than a name alone. Keep recentEvents in every update and only the other fields that actually changed, and remove newCharacters.'
          : '上一份回答的更新项缺少 evidence。请保留上一份回答中有正文支持的更新，不要因缺少 evidence 而返回空列表：每项都必须填写逐字复制的单一连续原文 evidence.text，省略 start/end，由程序计算；现有角色卡中的人物必须填写其 characterId，不能只写 name；每项保留 recentEvents，其余只保留实际变化的字段；删除 newCharacters。'
          : english
            ? ' The evidence.text was not one contiguous, verbatim span of the frozen chapter that occurs exactly once, or its start/end did not match. Copy a single contiguous span verbatim; never join sentences across paragraphs or blank lines, and do not alter punctuation or whitespace. Quote only one sentence; do not rewrite recentEvents to fit a quote: it must still state the latest state of this character at the end of the chapter (when later prose corrects, withdraws, or postpones an earlier plan, follow the last correction), and the evidence must be the one sentence that directly supports that latest state; if that sentence appears more than once, extend it with adjacent text into a longer contiguous span that is unique, and omit start/end so the program calculates them.'
            : '上一份回答的 evidence.text 不是冻结正文中单一连续、只出现一次的逐字片段，或 start/end 与正文不符。只能逐字复制一段连续原文；不得跨段落或空行拼接多句，不得删改标点或空白。请只引用一句；不要为了迁就引用而改写 recentEvents：它仍须写本章结束时该角色的最新状态（正文后文更正、撤回或推迟前文安排时，以最后的更正为准），evidence 选直接支持这一最新状态的那一句；若该句在正文中不唯一，扩展为包含相邻文字的更长连续片段。省略 start/end，由程序计算。'
        return invalidText === undefined ? initialTask : { ...initialTask, purpose: `${initialTask.purpose}:repair:${ordinal}`,
          messages: [...initialTask.messages, { role: 'assistant', content: invalidText }, { role: 'user', content: english
            ? `The preceding response does not satisfy the required ${repairKind === 'generic' ? 'JSON structure or exact source evidence' : 'exact source evidence'}.${guidance}${detail} Return a corrected JSON object using only the original frozen source and character IDs. Do not change or invent evidence. Return {"updates":[]} when there is no supported update.`
            : `${repairKind === 'generic' ? '上一份回答未满足要求的 JSON 结构或原文证据校验。' : guidance}${detail}请仅依据原始冻结正文和角色 ID 返回修正后的 JSON 对象，不得改写或虚构证据。没有可靠更新时返回 {"updates":[]}。` }] }
      }
      const assertRootIdle = () => {
        const budget = repository.budget(run.rootActionId)
        // 根被阻断时先给出阻断原因（如超时后的 ROOT_BUDGET_EXHAUSTED、写入失败的 GENERATION_STORAGE_FAILED），再点重试也不会解除。
        if (budget.blockedCode) throw new Error(budget.blockedCode)
        if (service.readUnsavedTails().some(tail => repository.receipt(tail.attemptId).run.rootActionId === run.rootActionId)) throw new Error('GENERATION_FINALIZATION_ARTIFACT_INVALID')
        if (!['active', 'paused'].includes(budget.root.status)
          || budget.attempts.some(attempt => ['reserved', 'dispatch-marked'].includes(attempt.status))
          || [...pending.keys()].some(key => repository.get(JSON.parse(key)[0]).rootActionId === run.rootActionId)) throw new Error('GENERATION_DISPATCH_BLOCKED')
      }
      // 显式请求按幂等 nonce 先回放；首次才在 resume 前后各校验一次可用性再发出。
      const explicitExecute = async (invocationNonce: string, assertAvailable: () => void, task: () => GenerationTask) => {
        if (viewOf(run).nonReplayable) {
          try { await resume(handleOf(run)) } catch (error) {
            const existing = runAttempts(run.runId).find(attempt => attempt.invocationNonce === invocationNonce)
            if (existing) return replay(existing)
            if (!(error instanceof Error) || error.message !== 'GENERATION_RESUME_REFUSED' || viewOf(repository.get(run.runId)).nonReplayable) throw error
          }
        }
        run = repository.get(run.runId)
        const existing = runAttempts(run.runId).find(attempt => attempt.invocationNonce === invocationNonce)
        if (existing) return replay(existing)
        assertAvailable()
        return execute({ handle: handleOf(run), invocationNonce, task: task() }, false, false, false, true)
      }
      // 角色状态结果 JSON 不合格时在同一运行里自动修正，连首个请求共 3 次；nonceOf 给出每一轮的幂等键，已有的轮次只回放。
      const generateWithRepairs = async (nonceOf: (ordinal: number) => string, first: () => Promise<MainGenerationExecuteReceipt>) => {
        let invalidText: string | undefined, failure: Error | undefined
        for (let ordinal = 0; ordinal < 3; ordinal++) {
          const invocationNonce = nonceOf(ordinal)
          const prior = runAttempts(run.runId).find(attempt => attempt.invocationNonce === invocationNonce)
          let result: MainGenerationExecuteReceipt
          if (prior) result = await replay(prior)
          else if (ordinal === 0) result = await first()
          else {
            if (runAttempts(run.runId).at(-1)?.invocationNonce !== nonceOf(ordinal - 1)) throw new Error('GENERATION_FINALIZATION_ATTEMPT_CONFLICT')
            const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
            result = await execute({ handle: current.handle, invocationNonce, task: repairTask(invalidText, invocationNonce.slice('finalization:'.length), failure) }, false, false, false, true)
          }
          run = repository.get(run.runId)
          if (context.slot.stepKey !== 'character_cards' || result.outcome.status !== 'completed' || ordinal === 2
            || repository.budget(run.rootActionId).root.status === 'cancelled') return result
          const reference = result.outcome.receipt.visibleArtifact
          const candidate = (result.run.candidates ?? result.run.artifacts).find(item => item.artifactId === reference?.artifactId)
          if (!candidate?.compositionEligible) return result
          if (textHash(candidate.text) !== candidate.textHash) throw new Error('GENERATION_FINALIZATION_ARTIFACT_INVALID')
          failure = failureOf(result.outcome.content)
          if (!failure) return result
          invalidText = result.outcome.content
        }
        throw new Error('GENERATION_FINALIZATION_ATTEMPT_CONFLICT')
      }
      const failedAttemptId = request.recoverFrom
      const recoverNonce = (ordinal: number) => `finalization:recover:${failedAttemptId}${ordinal ? `:${ordinal}` : ''}`
      // recoverFrom 只对本运行的尝试有效；属于同 root 的另一步骤或已被新运行取代时，按普通路径处理。
      if (failedAttemptId !== undefined && runAttempts(run.runId).some(attempt => attempt.attemptId === failedAttemptId || attempt.invocationNonce === recoverNonce(0))) {
        const assertAvailable = () => {
          finalizations.assertMutable(run)
          assertFinalizationSources(run)
          if (runAttempts(run.runId).at(-1)?.attemptId !== failedAttemptId) throw new Error('GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE')
          const receipt = volatileReceipts.get(failedAttemptId) ?? repository.receipt(failedAttemptId)
          // 只有未产出可用结果的尝试才可重发：可用的 stop 结果走提交或 retryOf 修正，不重复计费。
          if (['reserved', 'dispatch-marked'].includes(receipt.attempt.status)
            || !receipt.failureCode && !receipt.unsavedTail && receipt.result?.finishReason === 'stop' && !!receipt.artifact?.text.trim()) throw new Error('GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE')
          assertRootIdle()
        }
        return generateWithRepairs(recoverNonce, () => { assertAvailable(); return explicitExecute(recoverNonce(0), assertAvailable, () => initialTask) })
      }
      if (request.retryOf !== undefined) {
        if (context.slot.stepKey !== 'character_cards') throw new Error('GENERATION_FINALIZATION_REQUEST_INVALID')
        const retryOf = structuredClone(request.retryOf)
        const proof = finalizations.artifact(run, retryOf)
        const invocationNonce = `finalization:retry:${proof.attemptId}`
        const prior = runAttempts(run.runId).find(attempt => attempt.invocationNonce === invocationNonce)
        if (prior) return replay(prior)
        const assertAvailable = () => {
          finalizations.assertMutable(run)
          assertFinalizationSources(run)
          if (runAttempts(run.runId).at(-1)?.attemptId !== proof.attemptId) throw new Error('GENERATION_FINALIZATION_ATTEMPT_CONFLICT')
          const currentProof = finalizations.artifact(run, retryOf)
          const receipt = volatileReceipts.get(proof.attemptId) ?? currentProof.receipt
          if (receipt.failureCode || receipt.unsavedTail) throw new Error('GENERATION_FINALIZATION_ARTIFACT_INVALID')
          assertRootIdle()
        }
        assertAvailable()
        const failure = failureOf(proof.artifact.text)
        if (!failure) return outcomeOf(proof.receipt, { purpose: attemptPurpose(proof.attemptId) })
        return explicitExecute(invocationNonce, assertAvailable, () => repairTask(proof.artifact.text, proof.attemptId, failure))
      }
      // Dedicated requests own these nonces; old prompts need only their saved purpose and receipt for replay.
      const latestExplicit = runAttempts(run.runId).reverse().find(attempt => /^finalization:(retry|recover):/.test(attempt.invocationNonce))
      if (latestExplicit) return replay(latestExplicit)
      return generateWithRepairs(ordinal => `finalization:${ordinal}`, async () => {
        if (runAttempts(run.runId).length !== 0) throw new Error('GENERATION_FINALIZATION_ATTEMPT_CONFLICT')
        const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
        return execute({ handle: current.handle, invocationNonce: 'finalization:0', task: initialTask }, false, false, false, true)
      })
    },
    commitFinalizationGeneration: (request: FinalizationGenerationChannels['finalization-generation:commit']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['handle', 'artifact'].includes(key))) throw new Error('GENERATION_FINALIZATION_REQUEST_INVALID')
      return finalizations.commit(request.handle, request.artifact, characters, assertFinalizationSources)
    },
    cancelFinalizationGeneration: (request: FinalizationGenerationChannels['finalization-generation:cancel']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_FINALIZATION_REQUEST_INVALID')
      const run = finalizations.require(request.handle)
      service.cancel(run.rootActionId)
      return viewOf(repository.get(run.runId))
    },
    readEditorInlineRecovery,
    cancelEditorInline: (handle: MainGenerationRunHandle) => {
      const run = requireEditorInlineRun(handle)
      service.cancel(run.rootActionId)
      return viewOf(repository.get(run.runId))
    },
    beginEditorInline: (request: EditorInlineGenerationChannels['editor-inline:begin']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['input', 'modelId', 'uiActionNonce'].includes(key))
        || typeof request.uiActionNonce !== 'string' || !request.uiActionNonce.trim() || request.uiActionNonce.length > 256) throw new Error('GENERATION_EDITOR_INPUT_INVALID')
      const input = validateEditorInlineInput(request.input)
      const rows = deps.database.prepare("SELECT r.run_id FROM generation_runs r JOIN generation_roots g ON g.root_action_id=r.root_action_id WHERE json_extract(g.action_json,'$.operation')='editor-inline' AND json_extract(g.action_json,'$.projectId')=? AND json_extract(g.action_json,'$.uiActionNonce')=?").all(deps.projectId, request.uiActionNonce) as { run_id: string }[]
      if (rows.length > 1) throw new Error('GENERATION_NONCE_CONFLICT')
      if (rows[0]) {
        const prior = repository.get(rows[0].run_id)
        if (!isDeepStrictEqual(input, prior.binding.sourceManifest.editorInlineInput) || request.modelId !== modelReceipt(prior.binding).modelId) throw new Error('GENERATION_NONCE_CONFLICT')
        return readEditorInlineRecovery(handleOf(prior))
      }
      const view = begin({ operation: 'editor-inline', uiActionNonce: request.uiActionNonce, modelId: request.modelId,
        selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['edit_selected_text'], skillStages: [], output: 'visible-text', editorInlineInput: input }, false, false, true)
      return readEditorInlineRecovery(view.handle)
    },
    executeEditorInline: async (handle: MainGenerationRunHandle) => {
      const run = requireEditorInlineRun(handle), task = readEditorInlineTask(run)
      const invocationNonce = 'editor-inline:0'
      const requestHash = textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
      const prior = repository.findInvocation(run.runId, invocationNonce, requestHash)
      if (prior) {
        const running = pending.get(JSON.stringify([run.runId, invocationNonce]))
        return running ? running.promise : outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior, task)
      }
      if (deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) !== 0) throw new Error('GENERATION_EDITOR_ATTEMPT_CONFLICT')
      const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
      return execute({ handle: current.handle, invocationNonce, task }, false, false, true)
    },
    readImportGeneration: (slot: ImportGenerationSlot, runId?: string) => {
      assertCurrent()
      const run = imports.find(slot)
      return run && (run.runId === runId || !imports.retryable(run)) ? { view: viewOf(run), modelId: modelReceipt(run.binding).modelId, frozenContext: imports.context(run) } : null
    },
    assertImportGenerationSources: (handle: MainGenerationRunHandle, slot?: ImportGenerationSlot, allowLegacyStyle = false) => {
      const run = requireRun(handle)
      // Historical standalone style runs predate the checkpoint seam.
      if (!run.binding.sourceManifest.importSlot) {
        if (!allowLegacyStyle || !slot || slot.stage !== 'style' || run.binding.sourceManifest.operation !== 'analyze-writing-style'
          || !repository.budget(run.rootActionId).attempts.some(attempt => { const receipt = repository.receipt(attempt.attemptId); return receipt.run.runId === run.runId && receipt.result?.finishReason === 'stop' }))
          throw new Error('GENERATION_IMPORT_EFFECT_SLOT_CHANGED')
        assertSourcesCurrent(handle); return
      }
      if (!slot || !isDeepStrictEqual(imports.context(run).slot, slot)) throw new Error('GENERATION_IMPORT_EFFECT_SLOT_CHANGED')
      const current = deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))
      if (repository.budget(run.rootActionId).root.status === 'cancelled' || !compareGenerationSourceBindings(run.binding, current)
        || !imports.hasAttempts(run) || imports.rejected(run))
        throw new Error('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    },
    executeImportGeneration: async (request: import('../../src/shared/import-generation').ImportGenerationChannels['import-generation:execute']['args'][0]) => {
      const run = requireRun(request.handle)
      if (!Number.isSafeInteger(request.ordinal) || request.ordinal < 0 || request.ordinal >= MAIN_GENERATION_POLICY.budget.maxPhysicalRequests) throw new Error('GENERATION_IMPORT_ORDINAL_INVALID')
      imports.context(run)
      const invocationNonce = `import:${request.ordinal}`
      const prior = deps.database.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? AND invocation_nonce=?').get(run.runId, invocationNonce) as { attempt_id: string; usage_receipt_json: string } | undefined
      if (prior) {
        const usage = JSON.parse(prior.usage_receipt_json) as { replayTask?: GenerationTask; requestHash?: string }
        if (!usage.replayTask || textHash(JSON.stringify([usage.replayTask, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash])) !== usage.requestHash) throw new Error('GENERATION_IMPORT_TASK_INVALID')
        // Explicit ordinal replay reads the original request/receipt even when
        // the caller rebuilt a template or changed its current model selection.
        const running = pending.get(JSON.stringify([run.runId, invocationNonce]))
        return running ? running.promise : outcomeOf(repository.receipt(prior.attempt_id), usage.replayTask)
      }
      const count = deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) as number
      if (count !== request.ordinal) throw new Error('GENERATION_IMPORT_ORDINAL_GAP')
      imports.assertMutable(run)
      imports.assertExecution(run, request.execution)
      const previous = repository.budget(run.rootActionId).attempts.map(attempt => repository.receipt(attempt.attemptId)).filter(receipt => receipt.run.runId === run.runId)
      if (previous.some(receipt => receipt.result?.finishReason !== 'stop')) throw new Error('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
      imports.abandonIfRootStopped(run)
      const current = viewOf(run).nonReplayable ? await resume(request.handle) : viewOf(run)
      return execute({ handle: current.handle, invocationNonce, task: request.task }, false, true)
    },
    characterProposals: guardWork(characters, name => /^(read|list|identitySnapshot)/u.test(name)),
    approveCharacterProposal: (request: ApproveCharacterProposalRequest) => {
      assertCurrent()
      return deps.database.transaction(() => {
        const batch = characters.read(request.proposalBatchId)
        if (batch.status === 'approved') return characters.approve(request)
        const source = batch.source
        const directoryOperation = source.kind === 'directory' ? deps.database.prepare(
          'SELECT blueprint_commit_operation_id FROM blueprint_character_sync_operations WHERE operation_id=?').pluck().get(source.operationId) : undefined
        if (source.kind === 'directory' && typeof directoryOperation !== 'string') throw new Error('CHARACTER_PROPOSAL_SOURCE_MISSING')
        const handle = source.kind === 'finalized-generation' ? proveFinalizedCharacterGeneration(deps.database, repository, deps.projectId, source.handle, source.artifact).currentHandle
          : source.kind === 'legacy-roster-generation' ? readLegacyRosterGenerationProof(deps.database, repository, deps.projectId, source).currentHandle : source.kind === 'generation' ? source.handle
          : typeof directoryOperation === 'string' ? repository.readDirectoryProgress(directoryOperation)?.sourceHandle : undefined
        return handle ? agents.withChildEffect(handle, () => characters.approve(request)) : characters.approve(request)
      }).immediate()
    },
    readFinalizedCharacterContext: (draftId: number) => finalizedCharacters.readContext(draftId),
    commitFinalizedCharacterStates: (request: FinalizedCharacterGenerationCommit) => finalizedCharacters.commit(request, characters, assertSourcesCurrent),
    listPendingFinalizedCharacterStateCandidates: () => finalizedCharacters.listPendingStateCandidates(),
    readPendingFinalizedCharacterStateCandidate: (request: { draftId: number; candidateKey: string }) => finalizedCharacters.readPendingStateCandidate(request),
    decideFinalizedCharacterStateCandidate: (request: import('../../src/shared/finalized-continuity').FinalizedCharacterStateDecisionRequest) => finalizedCharacters.decideStateCandidate(request),
    prepareReviewRevision: (request: PrepareReviewRevisionRequest) => reviewRevisions.prepare(request),
    commitReview: (request: ReviewGenerationCommitRequest) => { requireRun(request.handle); return reviewRevisions.commitReview(request, assertSourcesCurrent) },
    commitRevision: (request: RevisionGenerationCommitRequest) => { requireRun(request.handle); return reviewRevisions.commitRevision(request, assertSourcesCurrent) },
    readReviewRevisionRecovery, listRecovery, findBlueprintRecovery,
    readContext, readBatch, prepareDraftContext, preparedKnowledge, draftPreparationBinding, retryDraftShortOutline,
    beginBatch: (request: BeginGenerationBatchRequest) => {
      assertGenerationBatchIntent(request)
      const { mode, range, targetUnits, ...intent } = request
      const run = begin({ ...intent, operation: 'batch-chapters', selectedDraftIds: [], selectedFinalizedDraftIds: [],
        output: 'visible-text', batchIntent: { mode, range, targetUnits } }, true)
      return readBatch(run.handle.runId)
    },
    listBatches: () => {
      assertCurrent()
      const commits = draftEffects.batchCommits()
      return runSummaries().filter(run => run.batchRoot).map(run => draftEffects.readBatchHistory(run.handle.runId, deps.projectId, commits))
    },
    confirmBatchFinalization: (request: { batchId: string; chapterNumber: number; finalizationId: string }) => {
      const batch = readBatch(request.batchId)
      if (!batch.completedChapters.some(item => item.chapterNumber === request.chapterNumber && item.finalizationId === request.finalizationId && item.postProcessComplete)) throw new Error('GENERATION_BATCH_FINALIZATION_REQUIRED')
      return batch
    },
    commitDraft: (request: GenerationDraftCommitRequest) => {
      requireRun(request.handle)
      return deps.database.transaction(() => {
        // The effect owner still validates the exact target/hash on a saved ACK.
        if (draftEffects.readCommit(request.handle.runId)) return draftEffects.commit(request, () => { throw new Error('GENERATION_DRAFT_REPLAY_NOT_SAVED') })
        return agents.withChildEffect(request.handle, () => draftEffects.commit(request, () => assertSourcesCurrent(request.handle)))
      }).immediate()
    },
    assertSynopsisCommit, commitPlotOutlineAuthorEdit, commitBlueprintAuthorEdit,
    withAgentChildEffect: <T>(handle: MainGenerationRunHandle, effect: () => T): T => { const run = requireRun(handle); assertAuthorFollowupWritable(run.runId); return agents.withChildEffect(handle, effect) },
    read: (handle: MainGenerationRunHandle) => viewOf(requireRun(handle)),
    listDirectoryProgress: () => {
      assertCurrent()
      const catalog = repository.listDirectoryProgress()
      return { ...catalog, progress: catalog.progress.map(progress => ({ ...progress,
        authorInputs: structuredClone(repository.get(progress.sourceHandle.runId).binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined) })) }
    },
    recordDirectoryCommit: (handle: MainGenerationRunHandle, requestedRange: { startChapter: number; endChapter: number }, receipt: BlueprintRangeCommitReceipt) => {
      const run = requireRun(handle, true)
      if (readMainGenerationPolicy(run.binding.sourceManifest.policy).version === 's07-capacity-v2' && receipt.mode !== 'replace-range')
        throw new Error('GENERATION_DIRECTORY_RANGE_REPLACE_REQUIRED')
      const existing = repository.readDirectoryProgress(receipt.operationId)
      if (existing) {
        if (existing.payloadHash !== receipt.payloadHash || existing.sourceHandle.runId !== handle.runId || !isDeepStrictEqual(existing.requestedRange, requestedRange)) throw new Error('GENERATION_DIRECTORY_PROGRESS_CONFLICT')
        return existing
      }
      const progress = { operationId: receipt.operationId, payloadHash: receipt.payloadHash, sourceHandle: handle,
        requestedRange, committedRange: { startChapter: receipt.startChapter, endChapter: receipt.endChapter },
        remainingRange: receipt.endChapter < requestedRange.endChapter ? { startChapter: receipt.endChapter + 1, endChapter: requestedRange.endChapter } : null }
      repository.recordDirectoryProgress(progress)
      return progress
    },
    composeVisible: (handle: MainGenerationRunHandle, artifactIds: string[], expectedTextHash: string | undefined, algorithm?: VisibleCompositionAlgorithm) => {
      if (requireRun(handle).binding.sourceManifest.operation === 'agent-round') throw new Error('GENERATION_AGENT_CONTROL_IMMUTABLE')
      reviewRevisions.assertMutable(requireRun(handle).runId)
      imports.assertMutable(requireRun(handle))
      finalizations.assertMutable(requireRun(handle))
      graphs.assertMutable(requireRun(handle))
      legacyRosters.assertMutable(requireRun(handle))
      const run = requireRun(handle, true)
      if (repository.budget(run.rootActionId).root.status === 'cancelled') throw new Error('GENERATION_ACTION_CANCELLED')
      if (isDraftVisibleTextVersion(algorithm) && requireRun(handle).binding.sourceManifest.operation !== 'chapter-draft') throw new Error('GENERATION_COMPOSITION_ALGORITHM_INVALID')
      return repository.composeVisible(handle.runId, artifactIds, expectedTextHash, algorithm)
    },
    readVisibleComposition: (handle: MainGenerationRunHandle) => {
      const run = requireRun(handle), composition = repository.readVisibleComposition(run.runId)
      return composition ? { ...composition, authorInputs: structuredClone(run.binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined) } : null
    },
    pause: (handle: MainGenerationRunHandle) => { const run = requireRun(handle, true); service.pause(run.rootActionId); return viewOf(repository.get(run.runId)) },
    cancel: (handle: MainGenerationRunHandle) => { const run = requireRun(handle); assertAuthorFollowupWritable(run.runId); service.cancel(run.rootActionId); return viewOf(repository.get(run.runId)) },
    restart: (handle: MainGenerationRunHandle, selection: BeginGenerationRequest) => {
      const old = requireRun(handle)
      assertAuthorFollowupWritable(old.runId)
      if (authorFollowupRuns.has(old.runId)) throw new Error('GENERATION_WORKFLOW_DRIVER_ACCESS_DENIED')
      repository.assertBlueprintRecoveryWritable(old.runId)
      imports.assertMutable(old)
      finalizations.assertMutable(old)
      graphs.assertMutable(old)
      legacyRosters.assertMutable(old)
      if (old.binding.sourceManifest.legacyRosterContext) throw new Error('GENERATION_LEGACY_ADMISSION_REQUIRED')
      if (old.binding.sourceManifest.graphGenerationContext) throw new Error('GENERATION_GRAPH_ADMISSION_REQUIRED')
      if (selection.parentRootActionId || selection.uiActionNonce === repository.budget(old.rootActionId).root.uiActionNonce) throw new Error('GENERATION_RESTART_NEW_NONCE_REQUIRED')
      const continuation = planningContinuation(old)
      if (continuation) return deps.database.transaction(() => {
        const { uiActionNonce: _nonce, ...restartIntent } = selection
        void _nonce
        const requestHash = textHash(JSON.stringify(restartIntent))
        const existing = repository.readPlanningContinuation(old.runId)
        if (existing) {
          if (existing.requestHash !== requestHash) throw new Error('GENERATION_PLANNING_CONTINUATION_EXISTS')
          return viewOf(repository.get(existing.nextHandle.runId))
        }
        const current = planningContinuation(old)!
        if (current.state !== 'ready') throw new Error(`GENERATION_PLANNING_CONTINUATION_${current.state.toUpperCase().replaceAll('-', '_')}`)
        const scope = planningGenerationScope(selection)
        const range = scope?.kind === 'architecture' ? scope.intent.synopsisRange
          : scope?.kind === 'directory' ? { from: scope.requestedRange.startChapter, to: scope.requestedRange.endChapter } : null
        if (selection.operation !== old.binding.sourceManifest.operation || !isDeepStrictEqual(range, current.remainingRange)
          || scope?.kind === 'architecture' && scope.intent.priorSteps.length
          || selection.continueDirectoryOperationId || selection.agentWorkflowRegistrationId)
          throw new Error('GENERATION_PLANNING_CONTINUATION_RANGE_CHANGED')
        const next = begin(selection)
        service.cancel(old.rootActionId)
        repository.recordPlanningContinuation({ kind: 'planning-continuation', sourceHandle: handleOf(old), nextHandle: next.handle, requestHash })
        return next
      }).immediate()
      // Admit the replacement before cancelling; rejected sources must leave the original resumable.
      const next = begin(selection)
      service.cancel(old.rootActionId)
      return next
    },
    discardCandidate: (handle: MainGenerationRunHandle, artifactId: string) => {
      const run = requireRun(handle)
      assertAuthorFollowupWritable(run.runId)
      if (run.binding.sourceManifest.operation === 'agent-round') throw new Error('GENERATION_AGENT_CONTROL_IMMUTABLE')
      reviewRevisions.assertMutable(run.runId)
      imports.assertMutable(run)
      finalizations.assertMutable(run)
      graphs.assertMutable(run)
      legacyRosters.assertMutable(run)
      const artifact = viewOf(run).candidates?.find(item => item.artifactId === artifactId)
      if (!artifact || artifact.status === 'running') throw new Error('GENERATION_CANDIDATE_NOT_DISCARDABLE')
      service.discardCandidate(artifactId)
      volatileReceipts.delete(artifact.attemptId)
      return viewOf(run)
    },
    hasPhysicalInFlight: () => physicalDispatches > 0 || pending.size > 0 || agents.hasActiveToolClaims(),
    whenPhysicalIdle: () => physicalDispatches === 0 ? Promise.resolve() : new Promise<void>(resolve => { physicalIdleWaiters.add(resolve) }),
    requestProjectClose: () => {
      if (closed) return
      closing = true
      abortAllQueued()
      const failures: unknown[] = []
      try { service.requestProjectClose() } catch (error) { failures.push(error) }
      try { agents.requestProjectClose() } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'GENERATION_CLOSE_QUIESCE_FAILED')
    },
    assertRetirable,
    retireIdle: () => {
      assertRetirable()
      preparations.clear()
      finalizedCharacters.close()
      reviewRevisions.close()
      authorFollowupRuns.clear()
      executableAuthorFollowups.clear()
      closed = true
      for (const leaseId of runLeases.values()) deps.leases.close(leaseId)
      runLeases.clear()
      runtimePreparations.clear()
      driverPreparations.clear()
    },
    suspendForProjectClose: () => {
      preparations.clear()
      finalizedCharacters.close()
      reviewRevisions.close()
      authorFollowupRuns.clear()
      executableAuthorFollowups.clear()
      if (closed) return
      abortAllQueued()
      for (const recordCancelled of [...unrecordedCalls]) recordCancelled()
      service.suspendForProjectClose(deps.mode === 'runtime-feedback')
      closed = true
      for (const leaseId of runLeases.values()) deps.leases.close(leaseId)
      runLeases.clear()
      runtimePreparations.clear()
      driverPreparations.clear()
    },
  }
  return guardWork(api, name => /^(read|list|find|has|cancel|pause)/u.test(name)
    || ['execute', 'whenPhysicalIdle', 'requestProjectClose', 'assertRetirable', 'retireIdle', 'suspendForProjectClose', 'rollbackRuntimeFieldFeedbackPreparation', 'rollbackWorkflowDriverPreparation'].includes(name))
}

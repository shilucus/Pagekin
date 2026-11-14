import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type Database from 'better-sqlite3'
import type { GenerationOwnerChannels } from '../../src/shared/generation-owner-contract'
import type { CharacterProposalChannels } from '../../src/shared/character-proposal'
import type { FinalizedCharacterGenerationChannels } from '../../src/shared/finalized-character-generation'
import type { ReviewRevisionGenerationInvokeChannels } from '../../src/shared/review-revision-generation'
import type { AgentGenerationChannels } from '../../src/shared/agent-generation'
import { assertImportQueryMaterialsRequest, type ImportGenerationChannels } from '../../src/shared/import-generation'
import type { EditorInlineGenerationChannels } from '../../src/shared/editor-inline-generation'
import type { FinalizationGenerationChannels } from '../../src/shared/finalization-generation'
import type { GraphGenerationChannels } from '../../src/shared/graph-generation'
import type { LegacyRosterGenerationChannels } from '../../src/shared/legacy-roster-generation'
import { assertPlanningFeedbackRequest, type PlanningFeedbackChannels, type PlanningFeedbackChannel } from '../../src/shared/planning-feedback-ipc'
import { assertRuntimeFeedbackRequest, RUNTIME_FEEDBACK_CHANNELS } from '../../src/shared/runtime-feedback-contract'
import type { PrepareRuntimeFeedbackRequest, RuntimeFeedbackReference, RuntimeFeedbackRevocationReceipt } from '../../src/shared/runtime-feedback-contract'
import { assertWorkflowDriverRequest, WORKFLOW_DRIVER_CHANNELS, workflowDriverRequiresView } from '../../src/shared/workflow-driver-contract'
import type { StartWorkflowDriverRequest, WorkflowDriverReference } from '../../src/shared/workflow-driver-contract'
import { assertWorkflowBatchRequest, WORKFLOW_BATCH_CHANNELS, workflowBatchRequiresView,
  type StartWorkflowBatchRequest, type WorkflowBatchReference } from '../../src/shared/workflow-batch-contract'
import { generationOutputContract } from '../../src/shared/generation-owner-contract'
import type { ModelProfile, ProjectSessionContext } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import { getBuiltinPromptTemplate } from '../../src/services/builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../src/shared/builtin-writing-skills'
import { getProjectDb, onProjectDatabaseBeforeClose } from '../database'
import { getGlobalDataRoot } from '../services/app-data-locator'
import { projectAccess, ProjectSessionStaleError } from '../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../services/project-runtime'
import { ModelExecutionLeaseRegistry, createModelExecutionLeaseReceipt } from '../services/model-execution-lease'
import { createMainGenerationOwner, safeGenerationModelReceipt } from '../services/main-generation-owner'
import type { MainGenerationOwnerDependencies } from '../services/main-generation-owner'
import { createMainNetworkScheduler, type GenerationSchedulingAdmission } from '../services/generation-scheduler'
import type { EmbeddingSchedulingContext } from '../services/embedding-scheduling'
import { RuntimeFeedbackAuthority, readRuntimeFeedbackReceipt } from '../services/runtime-feedback-authority'
import { WorkflowDriverAuthority, readWorkflowDriverReceipt } from '../services/workflow-driver-authority'
import { WorkflowBatchAuthority, readWorkflowBatchReceipt } from '../services/workflow-batch-authority'
import { readMainGenerationPolicy, TaskBudgetPreflightError } from '../services/main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../services/generation-source-binding'
import { LegacyVectorMigrationBlockedError } from '../services/knowledge-base-migration-error'
import { errorStackFrames } from '../services/error-stack-frames'
import { readPortableCurrentAuthority } from '../services/portable-current-authority'
import { FinalizationRepository } from '../repositories/finalization-repository'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { BlueprintRangeCommitReceipt } from '../repositories/blueprint-repository'
import type { GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'
import { withKnowledgeSourceGate } from '../services/knowledge-source-gate'
import { KnowledgeBaseUnavailableError, knowledgeBaseLoader } from '../services/knowledge-base-loader'
import { getEmbeddingConfig } from './kb-controller'
import { recordPerformanceComputedMetric, recordPerformanceCount } from '../services/performance-diagnostics'
import { isAgentGlobalToolAction, issueAgentGlobalToolExecution, revokeAgentGlobalToolExecutions } from '../services/agent-global-tool-admission'
import { assertReferenceStyleRequest, assertReferenceStyleAckRequest } from '../../src/shared/reference-style-contract'
import type { ReferenceStyleRequest } from '../../src/shared/reference-style-contract'
import type { ReferenceGlobalRequest } from '../../src/shared/reference-global-contract'
import type { ReferenceBlueprintRequest } from '../../src/shared/reference-blueprint-contract'
import type { ImportRunParentFlightToken } from '../services/import-stage-flight'
import { ReferenceStyleForeground } from './reference-style-foreground'
import { assertReferenceGlobalRequest, assertReferenceGlobalAckRequest } from '../../src/shared/reference-global-contract'
import { ReferenceGlobalForeground } from './reference-global-foreground'
import { ReferenceGlobalFailure } from '../services/reference-global-driver'
import { ReferenceStyleFailure } from '../services/reference-style-driver'
import { assertReferenceBlueprintRequest, assertReferenceBlueprintAckRequest } from '../../src/shared/reference-blueprint-contract'
import { ReferenceBlueprintForeground } from './reference-blueprint-foreground'
import { ReferenceBlueprintFailure } from '../services/reference-blueprint-driver'
import { assertImportStageUnmanagedMutationAllowed, assertImportBlueprintSyncUnmanagedMutationAllowed } from '../services/import-stage-flight'

type Owner = ReturnType<typeof createMainGenerationOwner>
type OwnerChannels = PlanningFeedbackChannels & LegacyRosterGenerationChannels & GraphGenerationChannels & GenerationOwnerChannels & CharacterProposalChannels & FinalizedCharacterGenerationChannels & ReviewRevisionGenerationInvokeChannels & AgentGenerationChannels & ImportGenerationChannels & EditorInlineGenerationChannels & FinalizationGenerationChannels
type LegacyOwnerEntry = { mode: 'legacy'; owner: Owner; session: ProjectSessionContext; subscribers: Set<WebContents> }
type RuntimeOwnerEntry = { mode: 'runtime-feedback'; authority: RuntimeFeedbackAuthority; runtime: ProjectRuntime }
type DriverOwnerEntry = { mode: 'workflow-driver'; authority: WorkflowDriverAuthority; runtime: ProjectRuntime }
type BatchOwnerEntry = { mode: 'workflow-batch'; authority: WorkflowBatchAuthority; runtime: ProjectRuntime }
type OwnerEntry = LegacyOwnerEntry | RuntimeOwnerEntry | DriverOwnerEntry | BatchOwnerEntry
const owners = new Map<Database.Database, OwnerEntry>()
const receiptAuthorities = new Map<Database.Database, Set<RuntimeFeedbackAuthority>>()
const driverReceiptAuthorities = new Map<Database.Database, Set<WorkflowDriverAuthority>>()
const batchReceiptAuthorities = new Map<Database.Database, Set<WorkflowBatchAuthority>>()
const ownerSessions = new WeakMap<Owner, ProjectSessionContext>()
const ownerRuntimes = new WeakMap<Owner, ProjectRuntime>()
// Match the existing runtime's bounded local close-wait scale, not a provider
// deadline. Keep the permit held throughout cooperative cancellation cleanup.
const GENERATION_TRANSPORT_CLEANUP_GRACE_MS = 5_000
/** Called synchronously inside the same SQLite transaction as the formal effect. */
export function assertGenerationSourcesCurrent(handle: MainGenerationRunHandle, blueprintRange?: { startChapter: number; endChapter: number }): void {
  const database = getProjectDb()
  const entry = database && owners.get(database)
  if (entry?.mode !== 'legacy') throw new Error('GENERATION_OWNER_REQUIRED')
  entry.owner.assertSourcesCurrent(handle, blueprintRange)
}
export function assertGenerationSynopsisCommit(handle: MainGenerationRunHandle, synopsis: string, expected: import('../repositories/project-core-repository').ProjectCoreSynopsisExpected): boolean {
  const database = getProjectDb(), entry = database && owners.get(database)
  if (entry?.mode !== 'legacy' || !database?.inTransaction) throw new Error('GENERATION_OWNER_REQUIRED')
  return entry.owner.assertSynopsisCommit(handle, synopsis, expected)
}
export function commitGenerationPlotOutlineAuthorEdit(request: import('../repositories/project-core-repository').ProjectCoreSynopsisCommitRequest) {
  const database = getProjectDb(), entry = database && owners.get(database)
  if (entry?.mode !== 'legacy' || !database?.inTransaction) throw new Error('GENERATION_OWNER_REQUIRED')
  return entry.owner.commitPlotOutlineAuthorEdit(request)
}
export function commitGenerationBlueprintAuthorEdit(request: import('../repositories/blueprint-repository').BlueprintRangeCommitRequest) {
  const database = getProjectDb(), entry = database && owners.get(database)
  if (entry?.mode !== 'legacy' || !database?.inTransaction) throw new Error('GENERATION_OWNER_REQUIRED')
  return entry.owner.commitBlueprintAuthorEdit(request)
}
export function recordGenerationDirectoryCommit(handle: MainGenerationRunHandle, requestedRange: { startChapter: number; endChapter: number }, receipt: BlueprintRangeCommitReceipt) {
  const database = getProjectDb(), entry = database && owners.get(database)
  if (entry?.mode !== 'legacy' || !database?.inTransaction) throw new Error('GENERATION_DIRECTORY_TRANSACTION_REQUIRED')
  return entry.owner.recordDirectoryCommit(handle, requestedRange, receipt)
}
export function withGenerationAgentChildEffect<T>(handle: MainGenerationRunHandle, effect: () => T): T {
  const database = getProjectDb(), entry = database && owners.get(database)
  if (entry?.mode !== 'legacy' || !database?.inTransaction) throw new Error('GENERATION_OWNER_REQUIRED')
  return entry.owner.withAgentChildEffect(handle, effect)
}
export function assertImportGenerationSourcesCurrent(handle: MainGenerationRunHandle, slot?: import('../../src/shared/import-generation').ImportGenerationSlot, allowLegacyStyle = false): void {
  const database = getProjectDb(), entry = database && owners.get(database)
  if (entry?.mode !== 'legacy' || !database?.inTransaction) throw new Error('GENERATION_OWNER_REQUIRED')
  entry.owner.assertImportGenerationSources(handle, slot, allowLegacyStyle)
}
/** Verify query evidence before opening the synchronous domain transaction. */
export async function withImportGenerationQuerySources<T>(handle: MainGenerationRunHandle, operation: () => T): Promise<T> {
  const database = getProjectDb(), entry = database && owners.get(database)
  if (entry?.mode !== 'legacy' || database?.inTransaction) throw new Error('GENERATION_OWNER_REQUIRED')
  return entry.owner.withImportQuerySources(handle, operation)
}

const GENERATION_ERROR_CODE = /^(?:GENERATION|ROOT_BUDGET|ARTIFACT|MAIN|CHARACTER|FINALIZED_CHARACTER|LEGACY_ROSTER|PLANNING_FEEDBACK|RUNTIME_FEEDBACK|WORKFLOW_DRIVER|WORKFLOW_BATCH)_[A-Z_]+$/u
const DIAGNOSTIC_MESSAGE_LIMIT = 200

/**
 * 生成 IPC 只向渲染端返回错误码。没有错误码的异常要先留下主进程诊断，再统一成
 * GENERATION_REQUEST_FAILED；诊断只记通道、异常类型、截断的消息与堆栈，不记请求参数，
 * 因为参数里可能有正文。
 */
export function generationIpcErrorCode(channel: string, error: unknown): string {
  if (error instanceof TaskBudgetPreflightError) return error.message
  if (error instanceof KnowledgeBaseUnavailableError || error instanceof LegacyVectorMigrationBlockedError) return error.code
  if (error instanceof ProjectSessionStaleError) {
    console.warn('[generation] stale project session rejected', { channel })
    return 'GENERATION_PROJECT_SESSION_STALE'
  }
  if (error instanceof Error && (error.message === 'SOURCE_DRAFT_CHANGED' || GENERATION_ERROR_CODE.test(error.message))) return error.message
  if (channel === 'generation:read-diagnostics') {
    // Corrupt receipt JSON may appear in a parser message or fabricated stack frame.
    console.error('[generation] diagnostic read failed', { channel, name: 'Error' })
    return 'GENERATION_REQUEST_FAILED'
  }
  if (channel.startsWith('planning-feedback:') || channel.startsWith('runtime-feedback:')
    || channel.startsWith('workflow-driver:') || channel.startsWith('workflow-batch:') || channel.startsWith('import-generation:')) {
    console.error('[generation] unmapped feedback failure', { channel, name: error instanceof Error ? 'Error' : typeof error,
      stack: error instanceof Error ? errorStackFrames(error, 7) : undefined })
    return 'GENERATION_REQUEST_FAILED'
  }
  console.error('[generation] unmapped failure', {
    channel,
    name: error instanceof Error ? error.name : typeof error,
    message: (error instanceof Error ? error.message : String(error)).slice(0, DIAGNOSTIC_MESSAGE_LIMIT),
    // stack 开头带着完整消息，只留调用栈帧，免得绕过消息截断。
    stack: error instanceof Error ? errorStackFrames(error, 7) : undefined,
  })
  return 'GENERATION_REQUEST_FAILED'
}

export function registerGenerationController(options: {
  modelExecutionLeases: ModelExecutionLeaseRegistry
  loadModel: (id: string) => ModelProfile | null
  applyProxyConfig: () => void
  /** Trusted main-process composition only, never an IPC request field. */
  scheduler?: GenerationSchedulingAdmission
}) {
  const scheduler = options.scheduler ?? createMainNetworkScheduler()
  const activeHandlers = new Map<ProjectRuntime, number>()
  const knowledgeRequests = new Map<ProjectRuntime, Set<AbortController>>()
  const captureScheduledKnowledge = async (
    kb: Awaited<ReturnType<typeof knowledgeBaseLoader.load>>,
    runtime: ProjectRuntime,
    query: string,
    excludedDocuments: string[],
    assertCurrent: () => void,
    lane: 'interactive' | 'background' = 'interactive',
  ) => {
    const controller = new AbortController()
    let requests = knowledgeRequests.get(runtime)
    if (!requests) { requests = new Set(); knowledgeRequests.set(runtime, requests) }
    requests.add(controller)
    const assertActive = () => {
      assertCurrent()
      projectRuntimeHost.assertWorkAvailable(runtime)
      if (controller.signal.aborted) throw new Error('GENERATION_ACTION_CANCELLED')
    }
    const scheduling: EmbeddingSchedulingContext = { admission: scheduler, projectKey: runtime.executionEpoch,
      lane, signal: controller.signal, assertActive, quarantineAfterMs: GENERATION_TRANSPORT_CLEANUP_GRACE_MS }
    try {
      assertActive()
      return await kb.captureWritingKnowledgeSnapshot(query, runtime.canonicalRoot, getEmbeddingConfig(),
        excludedDocuments, assertActive, scheduling)
    } finally {
      requests.delete(controller)
      if (!requests.size) knowledgeRequests.delete(runtime)
    }
  }
  const referenceStyles = new ReferenceStyleForeground()
  const referenceGlobals = new ReferenceGlobalForeground()
  const referenceBlueprints = new ReferenceBlueprintForeground()
  const hasPhysical = (entry: OwnerEntry | undefined) => entry?.mode === 'legacy'
    ? entry.owner.hasPhysicalInFlight() : entry?.authority.hasPhysicalInFlight() ?? false
  projectRuntimeHost.registerBusyPredicate(runtime => (activeHandlers.get(runtime) ?? 0) > 0 || hasPhysical(owners.get(runtime.database)))
  projectRuntimeHost.onCloseRequested(runtime => {
    for (const controller of knowledgeRequests.get(runtime) ?? []) controller.abort()
    referenceStyles.requestClose(runtime)
    referenceGlobals.requestClose(runtime)
    referenceBlueprints.requestClose(runtime)
    revokeAgentGlobalToolExecutions(runtime)
    const failures: unknown[] = []
    const entry = owners.get(runtime.database)
    try {
      if (entry?.mode === 'legacy') entry.owner.requestProjectClose()
      else entry?.authority.requestProjectClose()
    } catch (error) { failures.push(error) }
    for (const authority of receiptAuthorities.get(runtime.database) ?? []) {
      if (entry?.mode === 'runtime-feedback' && entry.authority === authority) continue
      try { authority.requestProjectClose() } catch (error) { failures.push(error) }
    }
    for (const authority of driverReceiptAuthorities.get(runtime.database) ?? []) {
      if (entry?.mode === 'workflow-driver' && entry.authority === authority) continue
      try { authority.requestProjectClose() } catch (error) { failures.push(error) }
    }
    for (const authority of batchReceiptAuthorities.get(runtime.database) ?? []) {
      if (entry?.mode === 'workflow-batch' && entry.authority === authority) continue
      try { authority.requestProjectClose() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'GENERATION_PROJECT_CLOSE_FAILED')
  })
  onProjectDatabaseBeforeClose(({ database }) => {
    referenceStyles.release(database)
    referenceGlobals.release(database)
    referenceBlueprints.release(database)
    const entry = owners.get(database)
    if (entry) {
      if (entry.mode === 'legacy') entry.owner.suspendForProjectClose()
      else entry.authority.suspendForProjectClose()
      owners.delete(database)
    }
    for (const authority of receiptAuthorities.get(database) ?? []) {
      if (entry?.mode !== 'runtime-feedback' || entry.authority !== authority) authority.suspendForProjectClose()
    }
    receiptAuthorities.delete(database)
    for (const authority of driverReceiptAuthorities.get(database) ?? []) {
      if (entry?.mode === 'workflow-driver' && entry.authority === authority) continue
      authority.suspendForProjectClose()
    }
    driverReceiptAuthorities.delete(database)
    for (const authority of batchReceiptAuthorities.get(database) ?? []) {
      if (entry?.mode === 'workflow-batch' && entry.authority === authority) continue
      authority.suspendForProjectClose()
    }
    batchReceiptAuthorities.delete(database)
  })
  const capturedResources = (runtime: ProjectRuntime) => {
    const database = runtime.database, identity = runtime.databaseIdentity, epoch = runtime.executionEpoch
    return () => {
      if (!projectRuntimeHost.getOpenRuntimes().includes(runtime) || !database.open || runtime.database !== database
        || runtime.databaseIdentity !== identity || runtime.executionEpoch !== epoch || runtime.phase === 'closed') {
        throw new Error('RUNTIME_FEEDBACK_RESOURCES_CHANGED')
      }
    }
  }
  const assertRetirable = (runtime: ProjectRuntime, entry: OwnerEntry) => {
    if ((activeHandlers.get(runtime) ?? 0) > 0) throw new Error('GENERATION_OWNER_BUSY')
    if (entry.mode === 'legacy') entry.owner.assertRetirable()
    else if (entry.mode === 'runtime-feedback') entry.authority.prepareRetirement()
    else entry.authority.assertRetirable()
  }
  const retire = (runtime: ProjectRuntime, entry: OwnerEntry) => {
    assertRetirable(runtime, entry)
    if (entry.mode === 'legacy') entry.owner.retireIdle()
    else entry.authority.retireIdle()
    owners.delete(runtime.database)
  }
  const makeOwner = (runtime: ProjectRuntime, epoch: string, assertCurrent: () => void,
    extra: Partial<Pick<MainGenerationOwnerDependencies, 'mode' | 'runtimeFeedback' | 'workflowDriver' | 'assertNoRuntimeClaims' | 'recoverInterrupted'>> = {},
    delivery?: Pick<MainGenerationOwnerDependencies, 'onSnapshot' | 'onReasoning'>) => {
    const sourceDependencies = { db: runtime.database, projectStorageRoot: runtime.projectStorageRoot,
      globalDataRoot: getGlobalDataRoot(), readBuiltinSkill: readBuiltinWritingSkill,
      readBuiltinPrompt: (key: string, language: 'zh-CN' | 'en-US') => {
        const template = getBuiltinPromptTemplate(key, language)
        if (!template) throw new Error('GENERATION_BUILTIN_PROMPT_MISSING')
        return JSON.stringify(template)
      } }
    return createMainGenerationOwner({ database: runtime.database, projectId: runtime.projectId,
      projectPath: runtime.canonicalRoot, epoch, assertCurrent, assertRetirementResources: capturedResources(runtime),
      scheduling: { admission: scheduler, projectKey: runtime.executionEpoch, quarantineAfterMs: GENERATION_TRANSPORT_CLEANUP_GRACE_MS },
      referenceImportQueries: { runtime, loadConfiguration: getEmbeddingConfig },
      withDispatchKnowledge: (snapshot, operation) => guardRuntimeKnowledge(runtime, snapshot, operation),
      assertAdmission: () => projectRuntimeHost.assertWorkAvailable(runtime),
      leases: options.modelExecutionLeases, loadModel: options.loadModel, beforeDispatch: options.applyProxyConfig,
      transferOrigin: () => readPortableCurrentAuthority({ database: runtime.database,
        projectStorageRoot: runtime.projectStorageRoot, projectId: runtime.projectId })?.originProjectId,
      buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(sourceDependencies, { ...selection,
        ...(extra.mode === 'workflow-driver' || extra.mode === 'workflow-batch' ? { freezeWritingLanguage: true as const } : {}),
        projectId: runtime.projectId, epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
      rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDependencies, previous, epoch,
        modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding,
      readImportPlanningSkill: (previous, modelReceipt) => {
        const rebuilt = rebuildGenerationSourceBinding(sourceDependencies, previous, epoch,
          modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy))
        return { binding: rebuilt.binding, skill: rebuilt.importPlanningSkill ?? null }
      },
      ...extra, ...delivery })
  }
  const authorizedRuntimeFeedback = (runtime: ProjectRuntime): RuntimeFeedbackAuthority => {
    projectRuntimeHost.assertTaskAvailable(runtime)
    const entry = owners.get(runtime.database)
    if (entry?.mode === 'runtime-feedback') return entry.authority
    if (entry) assertRetirable(runtime, entry)
    const authority = new RuntimeFeedbackAuthority({ runtime,
      assertOpen: () => projectRuntimeHost.assertOpen(runtime), assertCapturedResources: capturedResources(runtime),
      assertAdmission: () => projectRuntimeHost.assertTaskAvailable(runtime),
      createOwner: hooks => makeOwner(runtime, runtime.executionEpoch, () => projectRuntimeHost.assertOpen(runtime),
        { mode: 'runtime-feedback', recoverInterrupted: false, ...hooks }) })
    if (entry) {
      try { retire(runtime, entry) }
      catch (error) {
        try { authority.retireIdle() }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'RUNTIME_FEEDBACK_HANDOFF_FAILED') }
        throw error
      }
    }
    owners.set(runtime.database, { mode: 'runtime-feedback', authority, runtime })
    let receipts = receiptAuthorities.get(runtime.database)
    if (!receipts) { receipts = new Set(); receiptAuthorities.set(runtime.database, receipts) }
    receipts.add(authority)
    return authority
  }
  const authorizedOwner = (session: ProjectSessionContext, event: IpcMainInvokeEvent) => {
    const runtime = projectAccess.assertViewContext(session)
    const database = runtime.database
    let entry = owners.get(database)
    const handoff = Boolean(entry && (entry.mode !== 'legacy' || entry.session.projectId !== session.projectId || entry.session.leaseId !== session.leaseId))
    if (!entry || handoff) {
      projectRuntimeHost.assertTaskAvailable(runtime)
      if (entry) assertRetirable(runtime, entry)
      const captured = Object.freeze({ ...session })
      const subscribers = new Set<WebContents>()
      const owner = makeOwner(runtime, captured.leaseId,
        () => { if (projectAccess.assertViewContext(captured) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED') },
        { recoverInterrupted: !handoff, assertNoRuntimeClaims: () => {
          projectRuntimeHost.assertTaskAvailable(runtime)
          const current = owners.get(database)
          // The synchronous recovery handler itself is allowed; another handler or physical claim is not.
          if ((activeHandlers.get(runtime) ?? 0) > 1 || hasPhysical(current)
            || [...receiptAuthorities.get(database) ?? []].some(authority => authority.hasPhysicalInFlight())
            || [...driverReceiptAuthorities.get(database) ?? [], ...batchReceiptAuthorities.get(database) ?? []]
              .some(authority => authority.hasIssuance() || authority.hasPhysicalInFlight())) throw new Error('GENERATION_OWNER_BUSY')
          if (current?.mode === 'runtime-feedback') current.authority.assertRetirable()
        } }, {
        onSnapshot: snapshot => {
          try { if (projectAccess.assertViewContext(captured) !== runtime) return } catch { return }
          for (const subscriber of subscribers) {
          if (subscriber.isDestroyed()) subscribers.delete(subscriber)
          else {
            subscriber.send('generation:snapshot', snapshot)
            try {
              recordPerformanceCount('ipc.snapshot.calls')
              recordPerformanceComputedMetric('ipc.snapshot.utf8_bytes', () => Buffer.byteLength(JSON.stringify(snapshot), 'utf8'))
            } catch { /* Snapshot delivery does not depend on diagnostics. */ }
          }
        } },
        onReasoning: reasoning => {
          try { if (projectAccess.assertViewContext(captured) !== runtime) return } catch { return }
          for (const subscriber of subscribers) {
          if (subscriber.isDestroyed()) subscribers.delete(subscriber)
          else subscriber.send('generation:reasoning', reasoning)
        } },
      })
      if (entry) {
        try { retire(runtime, entry) }
        catch (error) {
          try { owner.retireIdle() }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'RUNTIME_FEEDBACK_HANDOFF_FAILED') }
          throw error
        }
      }
      entry = { mode: 'legacy', owner, session: captured, subscribers }
      ownerSessions.set(owner, captured)
      ownerRuntimes.set(owner, runtime)
      owners.set(database, entry)
    }
    if (entry.mode !== 'legacy') throw new Error('GENERATION_OWNER_REQUIRED')
    entry.subscribers.add(event.sender)
    return entry.owner
  }
  const withRuntimeHandler = async <T>(runtime: ProjectRuntime, operation: () => T | Promise<T>): Promise<T> => {
    activeHandlers.set(runtime, (activeHandlers.get(runtime) ?? 0) + 1)
    try { return await operation() }
    finally {
      const remaining = activeHandlers.get(runtime)! - 1
      if (remaining) activeHandlers.set(runtime, remaining)
      else activeHandlers.delete(runtime)
    }
  }
  const capabilityAuthority = (reference: Pick<RuntimeFeedbackReference, 'projectId' | 'grantId'>) => {
    const authority = [...receiptAuthorities.values()].flatMap(value => [...value]).find(value =>
      value.runtime.projectId === reference.projectId && value.hasIssuance(reference.grantId))
    if (!authority) throw new Error('RUNTIME_FEEDBACK_CAPABILITY_REQUIRED')
    return authority
  }
  for (const channel of RUNTIME_FEEDBACK_CHANNELS) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      try {
        const requiresView = channel === 'runtime-feedback:v1:prepare' || channel === 'runtime-feedback:v1:read-history'
        if (raw.length !== (requiresView ? 2 : 1)) throw new Error('RUNTIME_FEEDBACK_PAYLOAD_INVALID')
        const body = raw[0]
        assertRuntimeFeedbackRequest(channel, body)
        if (channel === 'runtime-feedback:v1:revoke-many') {
          const projects = new Map<string, RuntimeFeedbackRevocationReceipt['projects'][number]>()
          for (const reference of (body as { references: RuntimeFeedbackReference[] }).references) {
            let project = projects.get(reference.projectId)
            if (!project) {
              project = { projectId: reference.projectId, completeForRequestedScope: true, grants: [] }
              projects.set(reference.projectId, project)
            }
            const fence: RuntimeFeedbackRevocationReceipt['projects'][number]['grants'][number] = {
              grantId: reference.grantId, requestedRevision: reference.revision, fenced: false, receipt: null, errorCode: null,
            }
            try {
              const authority = capabilityAuthority(reference)
              fence.receipt = await withRuntimeHandler(authority.runtime, () => authority.revoke(event.sender, reference))
              fence.fenced = fence.receipt.grant.state === 'revoked' || fence.receipt.grant.state === 'completed'
            } catch (error) { fence.errorCode = generationIpcErrorCode(channel, error) }
            project.grants.push(fence)
            project.completeForRequestedScope &&= fence.fenced
          }
          const result = [...projects.values()]
          return { completeForRequestedScope: result.every(project => project.completeForRequestedScope), projects: result }
        }
        if (requiresView) {
          const session = raw[1]
          if (!isProjectSessionContext(session)) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
          const runtime = projectAccess.assertViewContext(session)
          const fresh = () => {
            if (projectAccess.assertViewContext(session) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
          }
          if (channel === 'runtime-feedback:v1:read-history') {
            return await withRuntimeHandler(runtime, () => readRuntimeFeedbackReceipt(runtime,
              (body as { grantId: string }).grantId, capturedResources(runtime)))
          }
          const authority = authorizedRuntimeFeedback(runtime)
          return await withRuntimeHandler(runtime, () => authority.prepare(event.sender, body as PrepareRuntimeFeedbackRequest, fresh))
        }
        const reference = body as RuntimeFeedbackReference
        const authority = capabilityAuthority(reference)
        return await withRuntimeHandler(authority.runtime, () => {
          if (channel === 'runtime-feedback:v1:execute') return authority.execute(event.sender, reference)
          if (channel === 'runtime-feedback:v1:revoke') return authority.revoke(event.sender, reference)
          return authority.readReceipt(event.sender, reference)
        })
      } catch (error) { throw new Error(generationIpcErrorCode(channel, error)) }
    })
  }
  const guardKnowledge = async <T>(owner: Owner, snapshot: GenerationKnowledgeSnapshot | undefined, operation: () => T | Promise<T>): Promise<T> => {
    if (!snapshot) return operation()
    const session = ownerSessions.get(owner)!
    const runtime = ownerRuntimes.get(owner)!
    const projectStorageRoot = runtime.projectStorageRoot
    return withKnowledgeSourceGate(projectStorageRoot, async () => {
      const { verifyGenerationKnowledge } = await import('../services/generation-knowledge-source')
      await verifyGenerationKnowledge({ projectStorageRoot, snapshot })
      if (projectAccess.assertViewContext(session) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
      return operation()
    })
  }
  const readActionContext = (owner: Owner, handle: MainGenerationRunHandle) => {
    const context = owner.readContext(handle)
    if (context.draftSave.kind === 'changed') throw new Error('GENERATION_DRAFT_RECEIPT_INVALID')
    return context
  }
  const guardRuntimeKnowledge = async <T>(runtime: ProjectRuntime, snapshot: GenerationKnowledgeSnapshot | undefined,
    operation: () => T | Promise<T>): Promise<T> => {
    const assertResources = capturedResources(runtime)
    assertResources()
    projectRuntimeHost.assertWorkAvailable(runtime)
    if (!snapshot) return operation()
    return withKnowledgeSourceGate(runtime.projectStorageRoot, async () => {
      const { verifyGenerationKnowledge } = await import('../services/generation-knowledge-source')
      await verifyGenerationKnowledge({ projectStorageRoot: runtime.projectStorageRoot, snapshot })
      assertResources()
      projectRuntimeHost.assertWorkAvailable(runtime)
      return operation()
    })
  }
  const driverLaterFinalizedDocuments = (runtime: ProjectRuntime, chapterNumber: number) => new Set([
    ...FinalizationRepository.knowledgeDocumentChapters(runtime.database),
  ].filter(([, finalizedChapter]) => finalizedChapter >= chapterNumber).map(([documentId]) => documentId))
  const authorizedWorkflowDriver = (runtime: ProjectRuntime): WorkflowDriverAuthority => {
    const entry = owners.get(runtime.database)
    if (entry?.mode === 'workflow-driver') {
      projectRuntimeHost.assertWorkAvailable(runtime)
      return entry.authority
    }
    projectRuntimeHost.assertTaskAvailable(runtime)
    if (entry) assertRetirable(runtime, entry)
    let driverOwner: Owner
    const authority = new WorkflowDriverAuthority({ runtime,
      assertAdmission: () => projectRuntimeHost.assertWorkAvailable(runtime),
      assertCapturedResources: capturedResources(runtime),
      acquireWork: () => projectRuntimeHost.acquireWork(runtime),
      withKnowledge: (handle, operation) => guardRuntimeKnowledge(runtime,
        readActionContext(driverOwner, handle).knowledgeSnapshot, operation),
      withPreparedKnowledge: (preparationId, chapterNumber, operation) => {
        const knowledge = driverOwner.preparedKnowledge(preparationId)
        return guardRuntimeKnowledge(runtime, knowledge, () => {
          const later = driverLaterFinalizedDocuments(runtime, chapterNumber)
          if (knowledge.items.some(item => later.has(item.documentId))) throw new Error('GENERATION_KNOWLEDGE_SOURCE_STALE')
          return operation()
        })
      },
      createOwner: hooks => {
        driverOwner = makeOwner(runtime, runtime.executionEpoch, () => projectRuntimeHost.assertOpen(runtime),
          { mode: 'workflow-driver', recoverInterrupted: false, ...hooks })
        ownerRuntimes.set(driverOwner, runtime)
        return driverOwner
      } })
    if (entry) {
      try { retire(runtime, entry) }
      catch (error) {
        try { authority.retireIdle() }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'WORKFLOW_DRIVER_HANDOFF_FAILED') }
        throw error
      }
    }
    owners.set(runtime.database, { mode: 'workflow-driver', authority, runtime })
    let receipts = driverReceiptAuthorities.get(runtime.database)
    if (!receipts) { receipts = new Set(); driverReceiptAuthorities.set(runtime.database, receipts) }
    receipts.add(authority)
    return authority
  }
  const driverCapabilityAuthority = (reference: WorkflowDriverReference, subject: WebContents): WorkflowDriverAuthority => {
    const authority = [...driverReceiptAuthorities.values()].flatMap(value => [...value]).reverse().find(value =>
      value.runtime.projectId === reference.projectId && value.hasIssuance(reference.taskId, subject))
    if (!authority) throw new Error('WORKFLOW_DRIVER_CAPABILITY_REQUIRED')
    return authority
  }
  for (const channel of WORKFLOW_DRIVER_CHANNELS) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      try {
        const requiresView = workflowDriverRequiresView(channel)
        if (raw.length !== (requiresView ? 2 : 1)) throw new Error('WORKFLOW_DRIVER_PAYLOAD_INVALID')
        const body = raw[0]
        assertWorkflowDriverRequest(channel, body)
        if (requiresView) {
          const session = raw[1]
          if (!isProjectSessionContext(session)) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
          const runtime = projectAccess.assertViewContext(session)
          const fresh = () => {
            if (projectAccess.assertViewContext(session) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
          }
          if (channel === 'workflow-driver:v1:read-history') {
            return await withRuntimeHandler(runtime, () => readWorkflowDriverReceipt(runtime,
              (body as { taskId: string }).taskId, capturedResources(runtime)))
          }
          const authority = authorizedWorkflowDriver(runtime)
          return await withRuntimeHandler(runtime, async () => {
            if (channel === 'workflow-driver:v1:reauthorize') return authority.reauthorize(event.sender, (body as { taskId: string }).taskId, fresh)
            if (channel === 'workflow-driver:v1:start') return authority.start(event.sender, body as StartWorkflowDriverRequest, fresh)
            projectRuntimeHost.assertTaskAvailable(runtime)
            const request = (body as { request: import('../../src/shared/generation-owner-contract').PrepareDraftContextRequest }).request
            const baseline = authority.prepareDraftContextBinding(request)
            const kb = await knowledgeBaseLoader.load()
            fresh()
            projectRuntimeHost.assertWorkAvailable(runtime)
            const knowledge = await captureScheduledKnowledge(kb, runtime, request.query,
              [...driverLaterFinalizedDocuments(runtime, request.chapterNumber)], () => {
                fresh()
                projectRuntimeHost.assertWorkAvailable(runtime)
              })
            return guardRuntimeKnowledge(runtime, knowledge, () => {
              fresh()
              return authority.prepareDraftContext(request, knowledge, baseline)
            })
          })
        }
        const reference = (body as { reference: WorkflowDriverReference }).reference
        const authority = driverCapabilityAuthority(reference, event.sender)
        return await withRuntimeHandler(authority.runtime, () => {
          if (channel === 'workflow-driver:v1:pause') return authority.pause(event.sender, reference)
          if (channel === 'workflow-driver:v1:cancel') return authority.cancel(event.sender, reference)
          if (channel === 'workflow-driver:v1:resume') return authority.resume(event.sender, reference)
          return authority.readReceipt(event.sender, reference)
        })
      } catch (error) { throw new Error(generationIpcErrorCode(channel, error)) }
    })
  }
  const authorizedWorkflowBatch = (runtime: ProjectRuntime): WorkflowBatchAuthority => {
    const entry = owners.get(runtime.database)
    if (entry?.mode === 'workflow-batch') {
      projectRuntimeHost.assertWorkAvailable(runtime)
      return entry.authority
    }
    projectRuntimeHost.assertTaskAvailable(runtime)
    if (entry) assertRetirable(runtime, entry)
    let batchOwner: Owner
    const assertResources = capturedResources(runtime)
    const authority = new WorkflowBatchAuthority({ runtime, globalDataRoot: getGlobalDataRoot(),
      assertAdmission: () => projectRuntimeHost.assertWorkAvailable(runtime),
      assertCapturedResources: assertResources,
      acquireWork: () => projectRuntimeHost.acquireWork(runtime),
      readSafeModelReceipt: modelId => {
        assertResources()
        const model = options.loadModel(modelId)
        if (!model) throw new Error('GENERATION_MODEL_MISSING')
        return safeGenerationModelReceipt(createModelExecutionLeaseReceipt(model,
          { leaseId: 'read-only-evidence', createdAt: 0, expiresAt: 0 }))
      },
      captureKnowledge: async (query, chapterNumber) => {
        assertResources()
        projectRuntimeHost.assertWorkAvailable(runtime)
        const kb = await knowledgeBaseLoader.load()
        assertResources()
        projectRuntimeHost.assertWorkAvailable(runtime)
        return captureScheduledKnowledge(kb, runtime, query,
          [...driverLaterFinalizedDocuments(runtime, chapterNumber)], () => {
            assertResources()
            projectRuntimeHost.assertWorkAvailable(runtime)
          }, 'background')
      },
      withKnowledge: (handle, operation) => guardRuntimeKnowledge(runtime,
        readActionContext(batchOwner, handle).knowledgeSnapshot, operation),
      withPreparedKnowledge: (preparationId, chapterNumber, operation) => {
        const knowledge = batchOwner.preparedKnowledge(preparationId)
        return guardRuntimeKnowledge(runtime, knowledge, () => {
          const later = driverLaterFinalizedDocuments(runtime, chapterNumber)
          if (knowledge.items.some(item => later.has(item.documentId))) throw new Error('GENERATION_KNOWLEDGE_SOURCE_STALE')
          return operation()
        })
      },
      createOwner: hooks => {
        batchOwner = makeOwner(runtime, runtime.executionEpoch, () => projectRuntimeHost.assertOpen(runtime),
          { mode: 'workflow-batch', recoverInterrupted: false, ...hooks })
        ownerRuntimes.set(batchOwner, runtime)
        return batchOwner
      } })
    if (entry) {
      try { retire(runtime, entry) }
      catch (error) {
        try { authority.retireIdle() }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'WORKFLOW_BATCH_HANDOFF_FAILED') }
        throw error
      }
    }
    owners.set(runtime.database, { mode: 'workflow-batch', authority, runtime })
    let receipts = batchReceiptAuthorities.get(runtime.database)
    if (!receipts) { receipts = new Set(); batchReceiptAuthorities.set(runtime.database, receipts) }
    receipts.add(authority)
    return authority
  }
  const batchCapabilityAuthority = (reference: WorkflowBatchReference, subject: WebContents): WorkflowBatchAuthority => {
    const authority = [...batchReceiptAuthorities.values()].flatMap(value => [...value]).reverse().find(value =>
      value.runtime.projectId === reference.projectId && value.hasIssuance(reference.taskId, subject))
    if (!authority) throw new Error('WORKFLOW_BATCH_CAPABILITY_REQUIRED')
    return authority
  }
  for (const channel of WORKFLOW_BATCH_CHANNELS) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      try {
        const requiresView = workflowBatchRequiresView(channel)
        if (raw.length !== (requiresView ? 2 : 1)) throw new Error('WORKFLOW_BATCH_PAYLOAD_INVALID')
        const body = raw[0]
        assertWorkflowBatchRequest(channel, body)
        if (requiresView) {
          const session = raw[1]
          if (!isProjectSessionContext(session)) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
          const runtime = projectAccess.assertViewContext(session)
          const fresh = () => {
            if (projectAccess.assertViewContext(session) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
          }
          if (channel === 'workflow-batch:v2:read-history') {
            return await withRuntimeHandler(runtime, () => readWorkflowBatchReceipt(runtime,
              (body as { taskId: string }).taskId, capturedResources(runtime)))
          }
          const authority = authorizedWorkflowBatch(runtime)
          return await withRuntimeHandler(runtime, () => channel === 'workflow-batch:v2:reauthorize'
            ? authority.reauthorize(event.sender, (body as { taskId: string }).taskId, fresh)
            : authority.start(event.sender, body as StartWorkflowBatchRequest, fresh))
        }
        const reference = (body as { reference: WorkflowBatchReference }).reference
        const authority = batchCapabilityAuthority(reference, event.sender)
        return await withRuntimeHandler(authority.runtime, () => {
          if (channel === 'workflow-batch:v2:pause') return authority.pause(event.sender, reference)
          if (channel === 'workflow-batch:v2:cancel') return authority.cancel(event.sender, reference)
          if (channel === 'workflow-batch:v2:resume') return authority.resume(event.sender, reference)
          return authority.readReceipt(event.sender, reference)
        })
      } catch (error) { throw new Error(generationIpcErrorCode(channel, error)) }
    })
  }
  function register<C extends keyof OwnerChannels>(channel: C, arity: number,
    handler: (owner: Owner, ...args: OwnerChannels[C]['args']) => OwnerChannels[C]['return'] | Promise<OwnerChannels[C]['return']>,
    afterResult?: (result: OwnerChannels[C]['return'], owner: Owner, event: IpcMainInvokeEvent) => OwnerChannels[C]['return']) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      try {
        const session = raw.pop()
        if (!isProjectSessionContext(session) || raw.length !== arity && !(channel === 'generation:compose-visible' && raw.length === 3)) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
        if (channel === 'generation:read-diagnostics') {
          const request = raw[0]
          if (!request || typeof request !== 'object' || Array.isArray(request)
            || Object.keys(request).length !== 1 || !Object.hasOwn(request, 'handle')) throw new Error('GENERATION_DIAGNOSTICS_INVALID')
        }
        if (channel.startsWith('planning-feedback:')) assertPlanningFeedbackRequest(channel as PlanningFeedbackChannel, raw[0])
        if (channel === 'import-generation:v1:query-materials') assertImportQueryMaterialsRequest(raw[0])
        const owner = authorizedOwner(session, event)
        const runtime = ownerRuntimes.get(owner)!
        assertUnmanagedImportGeneration(channel, raw, runtime.database)
        activeHandlers.set(runtime, (activeHandlers.get(runtime) ?? 0) + 1)
        try {
          const result = await handler(owner, ...raw as OwnerChannels[C]['args'])
          if (projectAccess.assertViewContext(session) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
          return afterResult ? afterResult(result, owner, event) : result
        } finally {
          const remaining = activeHandlers.get(runtime)! - 1
          if (remaining) activeHandlers.set(runtime, remaining)
          else activeHandlers.delete(runtime)
        }
      } catch (error) {
        throw new Error(generationIpcErrorCode(channel, error))
      }
    })
  }
  function assertUnmanagedImportGeneration(channel: string, args: unknown[], database: Database.Database): void {
    const selection = (input: unknown) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return
      const value = input as { importSlot?: { runId?: unknown }; parentRootActionId?: unknown }
      assertImportStageUnmanagedMutationAllowed(database, value.importSlot?.runId)
      if (typeof value.parentRootActionId === 'string') root(value.parentRootActionId)
    }
    const root = (rootActionId: string) => {
      const slots = database.prepare(`SELECT DISTINCT json_extract(binding_json,'$.sourceManifest.importSlot.runId') AS import_run_id
        FROM generation_runs WHERE root_action_id=?`).all(rootActionId) as { import_run_id: unknown }[]
      for (const slot of slots) assertImportStageUnmanagedMutationAllowed(database, slot.import_run_id)
    }
    if (channel === 'generation:begin') { selection(args[0]); return }
    if (channel === 'character-proposal:stage') {
      const request = args[0] as { source?: { kind?: unknown; operationId?: unknown } } | undefined
      if (request?.source?.kind === 'directory') assertImportBlueprintSyncUnmanagedMutationAllowed(database, request.source.operationId)
      return
    }
    if (!['import-generation:execute', 'import-generation:v1:query-materials', 'generation:pause', 'generation:cancel', 'generation:resume',
      'generation:restart', 'generation:discard-candidate', 'generation:compose-visible'].includes(channel)) return
    const first = args[0]
    const handle = ['import-generation:execute', 'import-generation:v1:query-materials'].includes(channel) && first && typeof first === 'object' && 'handle' in first
      ? first.handle : first
    if (handle && typeof handle === 'object' && 'runId' in handle && typeof handle.runId === 'string') {
      const row = database.prepare('SELECT root_action_id FROM generation_runs WHERE run_id=?').get(handle.runId) as { root_action_id: string } | undefined
      if (row) root(row.root_action_id)
    }
    if (channel === 'generation:restart') selection(args[1])
  }
  for (const channel of ['import-generation:v1:blueprints', 'import-generation:v1:blueprints-ack'] as const) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      try {
        const session = raw[1]
        if (raw.length !== 2 || !isProjectSessionContext(session)) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
        if (channel === 'import-generation:v1:blueprints') assertReferenceBlueprintRequest(raw[0])
        else assertReferenceBlueprintAckRequest(raw[0])
        const owner = authorizedOwner(session, event)
        const runtime = ownerRuntimes.get(owner)!
        return await withRuntimeHandler(runtime, async () => {
          if (channel === 'import-generation:v1:blueprints-ack') {
            assertReferenceBlueprintAckRequest(raw[0])
            return referenceBlueprints.acknowledge(runtime, event.sender, session, raw[0])
          }
          assertReferenceBlueprintRequest(raw[0])
          try {
            const result = await referenceBlueprints.execute(runtime, owner, event.sender, session, raw[0], () => {
              if (projectAccess.assertViewContext(session) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
            })
            return { success: true, ...result }
          } catch (error) {
            if (error instanceof ReferenceBlueprintFailure) {
              if (error.secondaryErrors.length) console.error('[generation] reference blueprint terminal bookkeeping failed', {
                channel, errorCode: error.errorCode, secondaryErrorCodes: error.secondaryErrors,
              })
              return { success: false, errorCode: error.errorCode, error: error.displayMessage,
                ...(error.postCommitSyncBatchId ? { postCommitSyncBatchId: error.postCommitSyncBatchId } : {}) }
            }
            throw error
          }
        })
      } catch (error) { throw new Error(generationIpcErrorCode(channel, error)) }
    })
  }
  for (const channel of ['import-generation:v1:global', 'import-generation:v1:global-ack'] as const) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      try {
        const session = raw[1]
        if (raw.length !== 2 || !isProjectSessionContext(session)) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
        if (channel === 'import-generation:v1:global') assertReferenceGlobalRequest(raw[0])
        else assertReferenceGlobalAckRequest(raw[0])
        const owner = authorizedOwner(session, event)
        const runtime = ownerRuntimes.get(owner)!
        return await withRuntimeHandler(runtime, async () => {
          if (channel === 'import-generation:v1:global-ack') {
            assertReferenceGlobalAckRequest(raw[0])
            return referenceGlobals.acknowledge(runtime, event.sender, session, raw[0])
          }
          assertReferenceGlobalRequest(raw[0])
          try {
            const result = await referenceGlobals.execute(runtime, owner, event.sender, session, raw[0], () => {
              if (projectAccess.assertViewContext(session) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
            })
            return { success: true, ...result }
          } catch (error) {
            if (error instanceof ReferenceGlobalFailure) {
              if (error.secondaryErrors.length) console.error('[generation] reference global terminal bookkeeping failed', {
                channel, errorCode: error.errorCode, secondaryErrorCodes: error.secondaryErrors,
              })
              return { success: false, errorCode: error.errorCode, error: error.displayMessage,
                ...(error.completionFailureCode ? { completionFailureCode: error.completionFailureCode } : {}) }
            }
            throw error
          }
        })
      } catch (error) { throw new Error(generationIpcErrorCode(channel, error)) }
    })
  }
  for (const channel of ['import-generation:v1:style', 'import-generation:v1:style-ack'] as const) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      try {
        const session = raw[1]
        if (raw.length !== 2 || !isProjectSessionContext(session)) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
        if (channel === 'import-generation:v1:style') assertReferenceStyleRequest(raw[0])
        else assertReferenceStyleAckRequest(raw[0])
        const owner = authorizedOwner(session, event)
        const runtime = ownerRuntimes.get(owner)!
        return await withRuntimeHandler(runtime, async () => {
          if (channel === 'import-generation:v1:style-ack') {
            assertReferenceStyleAckRequest(raw[0])
            return referenceStyles.acknowledge(runtime, event.sender, session, raw[0])
          }
          assertReferenceStyleRequest(raw[0])
          try {
            const result = await referenceStyles.execute(runtime, owner, event.sender, session, raw[0], () => {
              if (projectAccess.assertViewContext(session) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
            })
            return { success: true, ...result }
          } catch (error) {
            if (error instanceof ReferenceStyleFailure) {
              if (error.secondaryErrors.length) console.error('[generation] reference style terminal bookkeeping failed', {
                channel, errorCode: error.errorCode, secondaryErrorCodes: error.secondaryErrors,
              })
              return { success: false, errorCode: error.errorCode, error: error.displayMessage }
            }
            throw error
          }
        })
      } catch (error) { throw new Error(generationIpcErrorCode(channel, error)) }
    })
  }
  register('planning-feedback:v1:capture', 1, (owner, request) => owner.captureFieldFeedback(request.target))
  register('planning-feedback:v1:list-bases', 1, (owner, request) => owner.listFieldFeedbackBases(request.target))
  register('planning-feedback:v1:read-history', 1, (owner, request) => owner.readFieldFeedbackHistory(request.baseId))
  register('planning-feedback:v1:begin', 1, (owner, request) => owner.beginFieldFeedback(request))
  register('planning-feedback:v1:execute', 1, (owner, request) => owner.executeFieldFeedback(request.handle))
  register('planning-feedback:v1:read-run', 1, (owner, request) => owner.readFieldFeedbackRun(request.handle))
  register('planning-feedback:v1:list-runs', 1, (owner, request) => owner.listFieldFeedbackRuns(request.baseId))
  register('planning-feedback:v1:cancel', 1, (owner, request) => owner.cancelFieldFeedback(request.handle))
  register('planning-feedback:v1:stage', 1, (owner, request) => owner.stageFieldFeedback(request))
  register('planning-feedback:v1:relineage', 1, (owner, request) => owner.relineageFieldFeedback(request))
  register('planning-feedback:v1:adopt', 1, (owner, request) => owner.adoptFieldFeedback(request))
  register('planning-feedback:v2:capture', 1, (owner, request) => owner.captureRangeFeedback(request.target))
  register('planning-feedback:v2:list-bases', 1, (owner, request) => owner.listRangeFeedbackBases(request.target))
  register('planning-feedback:v2:read-history', 1, (owner, request) => owner.readRangeFeedbackHistory(request.baseId))
  register('planning-feedback:v2:begin', 1, (owner, request) => owner.beginRangeFeedback(request))
  register('planning-feedback:v2:execute', 1, (owner, request) => owner.executeRangeFeedback(request.handle))
  register('planning-feedback:v2:read-run', 1, (owner, request) => owner.readRangeFeedbackRun(request.handle))
  register('planning-feedback:v2:list-runs', 1, (owner, request) => owner.listRangeFeedbackRuns(request.baseId))
  register('planning-feedback:v2:cancel', 1, (owner, request) => owner.cancelRangeFeedback(request.handle))
  register('planning-feedback:v2:stage', 1, (owner, request) => owner.stageRangeFeedback(request))
  register('planning-feedback:v2:relineage', 1, (owner, request) => owner.relineageRangeFeedback(request))
  register('planning-feedback:v2:adopt', 1, (owner, request) => owner.adoptRangeFeedback(request))
  register('planning-feedback:v3:capture', 1, (owner, request) => owner.captureBlueprintFeedback(request.target))
  register('planning-feedback:v3:list-bases', 1, (owner, request) => owner.listBlueprintFeedbackBases(request.target))
  register('planning-feedback:v3:read-history', 1, (owner, request) => owner.readBlueprintFeedbackHistory(request.baseId))
  register('planning-feedback:v3:begin', 1, (owner, request) => owner.beginBlueprintFeedback(request))
  register('planning-feedback:v3:execute', 1, (owner, request) => owner.executeBlueprintFeedback(request.handle))
  register('planning-feedback:v3:read-run', 1, (owner, request) => owner.readBlueprintFeedbackRun(request.handle))
  register('planning-feedback:v3:list-runs', 1, (owner, request) => owner.listBlueprintFeedbackRuns(request.baseId))
  register('planning-feedback:v3:cancel', 1, (owner, request) => owner.cancelBlueprintFeedback(request.handle))
  register('planning-feedback:v3:stage', 1, (owner, request) => owner.stageBlueprintFeedback(request))
  register('planning-feedback:v3:relineage', 1, (owner, request) => owner.relineageBlueprintFeedback(request))
  register('planning-feedback:v3:adopt', 1, (owner, request) => owner.adoptBlueprintFeedback(request))
  // 补写中间章时，本章及以后章节的定稿正文不能进取材，否则模型会提前写出或照抄后文。
  const laterFinalizedDocuments = (owner: Owner, chapterNumber: number) => new Set([...FinalizationRepository.knowledgeDocumentChapters(ownerRuntimes.get(owner)!.database)]
    .filter(([, finalizedChapter]) => finalizedChapter >= chapterNumber).map(([documentId]) => documentId))
  // 定稿后处理先导入、再登记文档身份，登记走另一条 IPC，不经过知识库门闩。
  // 准备之后才登记的后文章节要拦下，所以查登记和放行必须在同一个同步块里，中间不能有 await。
  const admitPreparedDraft = <T>(owner: Owner, request: { operation: string; chapterNumber?: number; preparationId?: string }, admit: () => T) => {
    const knowledge = request.preparationId ? owner.preparedKnowledge(request.preparationId) : undefined
    return guardKnowledge(owner, knowledge, () => {
      const later = knowledge && request.operation === 'chapter-draft' && request.chapterNumber !== undefined ? laterFinalizedDocuments(owner, request.chapterNumber) : new Set<string>()
      if (knowledge?.items.some(item => later.has(item.documentId))) throw new Error('GENERATION_KNOWLEDGE_SOURCE_STALE')
      return admit()
    })
  }
  register('generation:prepare-draft-context', 1, async (owner, request) => {
    const baseline = owner.draftPreparationBinding(request)
    const session = ownerSessions.get(owner)!
    const kb = await knowledgeBaseLoader.load()
    if (projectAccess.assertViewContext(session) !== ownerRuntimes.get(owner)) throw new Error('GENERATION_DATABASE_CHANGED')
    const runtime = ownerRuntimes.get(owner)!
    const knowledge = await captureScheduledKnowledge(kb, runtime, request.query,
      [...laterFinalizedDocuments(owner, request.chapterNumber)], () => {
        if (projectAccess.assertViewContext(session) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
      })
    return guardKnowledge(owner, knowledge, () => owner.prepareDraftContext(request, knowledge, baseline))
  })
  register('generation:begin', 1, (owner, request) => {
    if (request.operation === 'chapter-draft' && !request.preparationId) throw new Error('GENERATION_DRAFT_PREPARATION_REQUIRED')
    if (request.operation === 'chapter-draft' && !request.materialDecision) throw new Error('GENERATION_MATERIAL_DECISION_REQUIRED')
    if (request.operation !== 'chapter-draft' && request.materialDecision) throw new Error('GENERATION_MATERIAL_DECISION_INVALID')
    return admitPreparedDraft(owner, request, () => owner.begin(request))
  })
  register('generation:bind-material-decision', 1, (owner, request) =>
    owner.bindMaterialDecision(request.handle, request.materialDecision))
  register('character-proposal:stage', 1, (owner, request) => {
    if (request.source?.kind === 'legacy-roster-generation') throw new Error('GENERATION_LEGACY_ADMISSION_REQUIRED')
    return owner.characterProposals.stage(request.source)
  })
  register('character-proposal:read', 1, (owner, request) => owner.characterProposals.read(request.proposalBatchId))
  register('character-proposal:list-pending-finalized', 0, owner => owner.characterProposals.listPendingFinalized())
  register('character-proposal:read-pending-finalized', 1, (owner, request) => owner.characterProposals.readPendingFinalized(request.proposalBatchId))
  register('character-proposal:approve', 1, (owner, request) => owner.approveCharacterProposal(request))
  register('character-proposal:cancel', 1, (owner, request) => owner.characterProposals.cancel(request))
  register('character-identity:read', 0, owner => owner.characterProposals.identitySnapshot())
  register('finalized-character:read-context', 1, (owner, request) => owner.readFinalizedCharacterContext(request.draftId))
  register('finalized-character:commit', 1, (owner, request) => owner.commitFinalizedCharacterStates(request))
  register('finalized-character:list-state-candidates', 0, owner => owner.listPendingFinalizedCharacterStateCandidates())
  register('finalized-character:read-state-candidate', 1, (owner, request) => owner.readPendingFinalizedCharacterStateCandidate(request))
  register('finalized-character:decide-state-candidate', 1, (owner, request) => owner.decideFinalizedCharacterStateCandidate(request))
  register('finalization-generation:read', 1, (owner, request) => owner.readFinalizationGeneration(request))
  register('finalization-generation:begin', 1, (owner, request) => owner.beginFinalizationGeneration(request))
  register('finalization-generation:execute', 1, (owner, request) => owner.executeFinalizationGeneration(request))
  register('finalization-generation:commit', 1, (owner, request) => owner.commitFinalizationGeneration(request))
  register('finalization-generation:cancel', 1, (owner, request) => owner.cancelFinalizationGeneration(request))
  register('graph-generation:begin', 1, (owner, request) => owner.beginGraphGeneration(request))
  register('graph-generation:read', 1, (owner, request) => owner.readGraphGeneration(request))
  register('graph-generation:execute', 1, (owner, request) => owner.executeGraphGeneration(request))
  register('graph-generation:confirm', 1, (owner, request) => owner.confirmGraphGeneration(request))
  register('graph-generation:cancel', 1, (owner, request) => owner.cancelGraphGeneration(request))
  register('legacy-roster:read-source', 0, owner => owner.readLegacyRosterSource())
  register('legacy-roster:adopt-existing', 1, (owner, request) => owner.adoptLegacyCards(request))
  register('legacy-roster:begin', 1, (owner, request) => owner.beginLegacyRosterGeneration(request))
  register('legacy-roster:read', 1, (owner, request) => owner.readLegacyRosterGeneration(request))
  register('legacy-roster:execute', 1, (owner, request) => owner.executeLegacyRosterGeneration(request))
  register('legacy-roster:stage', 1, (owner, request) => owner.stageLegacyRosterGeneration(request))
  register('legacy-roster:cancel', 1, (owner, request) => owner.cancelLegacyRosterGeneration(request))
  register('review-revision:prepare', 1, (owner, request) => owner.prepareReviewRevision(request))
  register('review-revision:commit-review', 1, (owner, request) => owner.commitReview(request))
  register('review-revision:commit-revision', 1, (owner, request) => owner.commitRevision(request))
  register('review-revision:read-recovery', 1, (owner, request) => owner.readReviewRevisionRecovery(request.handle))
  register('agent-generation:begin', 1, (owner, request) => owner.agents.begin(request))
  register('agent-generation:read', 1, (owner, request) => owner.agents.read(request.handle))
  register('import-generation:read', 1, (owner, request) => owner.readImportGeneration(request.slot, typeof request.runId === 'string' ? request.runId : undefined))
  register('import-generation:v1:query-materials', 1, (owner, request) => owner.prepareImportQueryMaterials(request))
  register('import-generation:execute', 1, (owner, request) => owner.executeImportGeneration(request))
  register('editor-inline:begin', 1, (owner, request) => owner.beginEditorInline(request))
  register('editor-inline:read-recovery', 1, (owner, request) => owner.readEditorInlineRecovery(request.handle))
  register('editor-inline:execute', 1, (owner, request) => owner.executeEditorInline(request.handle))
  register('editor-inline:cancel', 1, (owner, request) => owner.cancelEditorInline(request.handle))
  register('agent-generation:resume', 1, (owner, request) => owner.agents.resume(request.handle))
  register('agent-generation:round', 1, (owner, request) => owner.agents.executeRound(request))
  register('agent-generation:claim-tool', 1, (owner, request) => owner.agents.claimTool(request), (claim, owner, event) => {
    if (!claim.execute || !isAgentGlobalToolAction(claim.action)) return claim
    const ref = structuredClone(claim.action.ref)
    return { ...claim, globalExecution: issueAgentGlobalToolExecution({ sender: event.sender, runtime: ownerRuntimes.get(owner)!,
      action: claim.action, assertClaim: () => owner.agents.assertToolEffectAvailable(ref) }) }
  })
  register('agent-generation:finish-tool', 1, (owner, request) => owner.agents.finishTool(request), (action, owner) => {
    revokeAgentGlobalToolExecutions(ownerRuntimes.get(owner)!, action.ref)
    return action
  })
  register('agent-generation:register-workflow', 1, (owner, request) => owner.agents.registerWorkflow(request.ref))
  register('agent-generation:commit-domain-tool', 1, (owner, request) => owner.agents.commitDomainTool(request.ref))
  register('generation:execute', 1, (owner, request) => {
    readActionContext(owner, request.handle)
    return owner.execute(request)
  })
  register('generation:retry-draft-short-outline', 1, (owner, request) => {
    readActionContext(owner, request.handle)
    return owner.retryDraftShortOutline(request)
  })
  register('generation:read', 1, (owner, handle) => owner.read(handle))
  register('generation:compose-visible', 4, (owner, handle, ids, hash, algorithm) => owner.composeVisible(handle, ids, hash, algorithm))
  register('generation:commit-draft', 1, (owner, request) => {
    const context = readActionContext(owner, request.handle)
    return guardKnowledge(owner, context.draftSave.kind === 'current' ? undefined : context.knowledgeSnapshot, () => owner.commitDraft(request))
  })
  register('generation:read-context', 1, (owner, request) => owner.readContext(request.handle))
  register('generation:read-diagnostics', 1, (owner, request) => owner.readDiagnostics(request.handle))
  register('generation:begin-batch', 1, (owner, request) => owner.beginBatch(request))
  register('generation:read-batch', 1, (owner, request) => owner.readBatch(request.batchId))
  register('generation:list-batches', 0, owner => owner.listBatches())
  register('generation:list-recovery', 0, owner => owner.listRecovery())
  register('generation:find-blueprint-recovery', 0, owner => owner.findBlueprintRecovery())
  register('generation:confirm-batch-finalization', 1, (owner, request) => owner.confirmBatchFinalization(request))
  register('generation:read-visible-composition', 1, (owner, handle) => owner.readVisibleComposition(handle))
  register('generation:list', 0, owner => owner.list())
  register('generation:list-directory-progress', 0, owner => owner.listDirectoryProgress())
  register('generation:pause', 1, (owner, handle) => owner.pause(handle))
  register('generation:cancel', 1, (owner, handle) => owner.cancel(handle))
  register('generation:resume', 1, (owner, handle) => guardKnowledge(owner, readActionContext(owner, handle).knowledgeSnapshot, () => owner.resume(handle)))
  register('generation:restart', 2, (owner, handle, request) => {
    if (request.operation === 'chapter-draft' && !request.preparationId) throw new Error('GENERATION_DRAFT_PREPARATION_REQUIRED')
    if (request.operation === 'chapter-draft' && !request.materialDecision) throw new Error('GENERATION_MATERIAL_DECISION_REQUIRED')
    if (request.operation !== 'chapter-draft' && request.materialDecision) throw new Error('GENERATION_MATERIAL_DECISION_INVALID')
    return admitPreparedDraft(owner, request, () => owner.restart(handle, request))
  })
  register('generation:discard-candidate', 2, (owner, handle, artifactId) => owner.discardCandidate(handle, artifactId))

  // Trusted composition reuses the same authorized owner and child foreground ACKs, never internal IPC calls.
  return {
    referenceGlobal(runtime: ProjectRuntime, event: IpcMainInvokeEvent, session: ProjectSessionContext,
      request: ReferenceGlobalRequest, parentToken: ImportRunParentFlightToken, assertCurrent: () => void) {
      assertReferenceGlobalRequest(request)
      const owner = authorizedOwner(session, event)
      if (ownerRuntimes.get(owner) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
      return withRuntimeHandler(runtime, () => referenceGlobals.execute(runtime, owner, event.sender, session,
        request, assertCurrent, parentToken))
    },
    referenceStyle(runtime: ProjectRuntime, event: IpcMainInvokeEvent, session: ProjectSessionContext,
      request: ReferenceStyleRequest, parentToken: ImportRunParentFlightToken, assertCurrent: () => void) {
      assertReferenceStyleRequest(request)
      const owner = authorizedOwner(session, event)
      if (ownerRuntimes.get(owner) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
      return withRuntimeHandler(runtime, () => referenceStyles.execute(runtime, owner, event.sender, session,
        request, assertCurrent, parentToken))
    },
    referenceBlueprints(runtime: ProjectRuntime, event: IpcMainInvokeEvent, session: ProjectSessionContext,
      request: ReferenceBlueprintRequest, parentToken: ImportRunParentFlightToken, assertCurrent: () => void) {
      assertReferenceBlueprintRequest(request)
      const owner = authorizedOwner(session, event)
      if (ownerRuntimes.get(owner) !== runtime) throw new Error('GENERATION_DATABASE_CHANGED')
      return withRuntimeHandler(runtime, () => referenceBlueprints.execute(runtime, owner, event.sender, session,
        request, assertCurrent, parentToken))
    },
  }
}

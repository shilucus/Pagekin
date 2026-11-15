import { createHash, randomUUID } from 'node:crypto'
import type { ReferenceImportResources } from '../knowledge-base'
import { ImportRunRepository, type CapturedImportRunContext } from '../repositories/import-run-repository'
import { ReferenceImportGrantRepository } from '../repositories/reference-import-grant-repository'
import { assertReferenceImportGrantOperationId, type ReferenceImportGrant, type ReferenceImportGrantRef } from '../../src/shared/reference-import-grant'
import { createImportRunChapterBatchCheckpointId, importStagesFor, IMPORT_RUN_KNOWLEDGE_BATCH_SIZE,
  type ImportRunChapterSnapshot, type ImportRunExecutionAuthority, type ImportRunExecutionLease, type ImportRunLocale,
  type ImportRunSnapshot, type ImportRunStartResult } from '../../src/shared/import-run'
import { normalizeEmbeddingOptions, type EmbeddingModel } from '../../src/shared/embedding-options'
import { chunkText } from '../embedding'
import { ReferenceEmbeddingBudgetRepository, type ReferenceEmbeddingBudgetCapability } from '../repositories/reference-embedding-budget-repository'
import type { PrepareReferenceKnowledgeRequest, ReferenceKnowledgeImportResult,
  ExecuteReferenceKnowledgeRequest, ReferenceKnowledgeProgress, ReferenceKnowledgeReference } from '../../src/shared/reference-knowledge-contract'
import type { ReferenceRefreshRequest, ReferenceRefreshSuccess } from '../../src/shared/reference-refresh-contract'
import { captureReferenceImportAdmission, type ReferenceImportAdmission } from './reference-import-admission'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'
import { projectRuntimeHost, type ProjectRuntime } from './project-runtime'
import { referenceEmbeddingBudgetFailure, type ReferenceEmbeddingBudgetPlan } from './reference-embedding-budget-contract'
import { LEGACY_VECTOR_MIGRATION_BLOCKED } from './knowledge-base-migration-error'
import { acquireImportRunParentFlight, acquireImportStageFlight, assertImportRunParentFlightAccess, assertImportRunParentFlightCurrent,
  assertImportStageUnmanagedMutationAllowed, hasImportStageChildFlight, hasImportStageFlight,
  type ImportRunParentFlightToken } from './import-stage-flight'

interface Subject {
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}
interface FrozenEmbedding { modelId: string | null; protocol: 'openai' | 'gemini'; model: EmbeddingModel }
interface ImportInput {
  binding: ReturnType<typeof ImportRunRepository.resolveReferenceImportAuthority>
  runId: string
  execution: ImportRunExecutionLease
  embedding: FrozenEmbedding
  resources: ReferenceImportResources
  admission: ReferenceImportAdmission
}
interface Options {
  resources: ReferenceImportResources
  captureEmbedding(): FrozenEmbedding
  importReference(input: ImportInput): Promise<ReferenceKnowledgeImportResult>
}
interface Issuance {
  sender: Subject
  reference: ReferenceKnowledgeReference
  operationId: string
  runId: string
  manifestFingerprint: string
  execution: ImportRunExecutionLease
  embedding: FrozenEmbedding
  requestHash: string
  admission: ReferenceImportAdmission
  budget: ReferenceEmbeddingBudgetCapability
  knowledgeActive: boolean
  knowledgeOperation: Promise<ImportRunStartResult> | null
  wholeActive: ImportRunParentFlightToken | null
  inFlight: number
  lifecycle: { revoked: boolean; destroyed: boolean }
  destroyedListener: (() => void) | null
  resumed: boolean
}

export interface ReferenceKnowledgeExecutionHooks {
  progress(event: ReferenceKnowledgeProgress): void
  failureMessage(code: string, locale: ImportRunLocale, source: 'result' | 'throw'): string
}

export interface ReferenceRefreshExecutionHooks {
  signal: AbortSignal
  assertCurrent(): void
  refresh(): Promise<void>
  progress(progress: 100): void
  failureMessage(code: string, locale: ImportRunLocale): string
}

export class ReferenceKnowledgeExecutionFailure extends Error {
  readonly secondaryErrors: Error[] = []

  constructor(readonly errorCode: string, readonly displayMessage: string) {
    super(errorCode)
    this.name = 'ReferenceKnowledgeExecutionFailure'
  }
}

export function assertReferenceKnowledgeUnmanagedMutationAllowed(database: object, runId: unknown): void {
  assertImportStageUnmanagedMutationAllowed(database, runId)
}

function splitKnowledgeBatches(chapters: readonly ImportRunChapterSnapshot[]): ImportRunChapterSnapshot[][] {
  const batches: ImportRunChapterSnapshot[][] = []
  let current: ImportRunChapterSnapshot[] = []
  for (const chapter of chapters) {
    const previous = current.at(-1)
    if (current.length >= IMPORT_RUN_KNOWLEDGE_BATCH_SIZE
      || (previous && chapter.number !== previous.number + 1)) {
      batches.push(current)
      current = []
    }
    current.push(chapter)
  }
  if (current.length) batches.push(current)
  return batches
}

const IMPORT_KNOWLEDGE_PAGE_SIZE = 100
const KNOWLEDGE_HEARTBEAT_MAX_INTERVAL_MS = 60_000

const nativeIdentityKeys = new WeakMap<object, string>()
function nativeIdentityKey(identity: object): string {
  let key = nativeIdentityKeys.get(identity)
  if (!key) { key = randomUUID(); nativeIdentityKeys.set(identity, key) }
  return key
}

function failure(code: string): Error { return new Error(code) }
function grantRef(reference: ReferenceKnowledgeReference): ReferenceImportGrantRef {
  return { grantId: reference.grantId, revision: reference.revision, runId: reference.runId }
}
function cloneEmbedding(value: FrozenEmbedding): FrozenEmbedding {
  if (!value || (value.protocol !== 'openai' && value.protocol !== 'gemini')
    || (value.modelId !== null && typeof value.modelId !== 'string') || !value.model
    || typeof value.model.apiKey !== 'string') throw failure('KNOWLEDGE_BASE_REFERENCE_EMBEDDING_CONFIG_INVALID')
  const model: EmbeddingModel = Object.freeze({
    provider: value.model.provider, baseUrl: value.model.baseUrl, apiKey: value.model.apiKey,
    ...(value.model.modelName === undefined ? {} : { modelName: value.model.modelName }),
    embeddingOptions: Object.freeze(normalizeEmbeddingOptions(value.model.embeddingOptions)),
  })
  return Object.freeze({ modelId: value.modelId, protocol: value.protocol, model })
}
function requestHash(input: { projectId: string; root: string; nativeIdentity: object; epoch: string; runId: string;
  owner: string; executionEpoch: number; manifestFingerprint: string; embedding: FrozenEmbedding }): string {
  return createHash('sha256').update(JSON.stringify({
    projectId: input.projectId, root: input.root, nativeIdentity: nativeIdentityKey(input.nativeIdentity), runtimeEpoch: input.epoch,
    runId: input.runId, owner: input.owner, executionEpoch: input.executionEpoch,
    manifestFingerprint: input.manifestFingerprint, modelId: input.embedding.modelId,
    protocol: input.embedding.protocol, provider: input.embedding.model.provider,
    baseUrl: input.embedding.model.baseUrl, modelName: input.embedding.model.modelName ?? '',
    embeddingOptions: input.embedding.model.embeddingOptions ?? null,
  })).digest('hex')
}
function safeFailure(error: unknown): Error {
  if (error instanceof AggregateError) {
    const errors = [...error.errors].map(safeFailure)
    return new AggregateError(errors, errors[0]?.message ?? 'KNOWLEDGE_BASE_REFERENCE_AUTHORITY_REJECTED')
  }
  const code = error instanceof Error ? error.message : ''
  return code === LEGACY_VECTOR_MIGRATION_BLOCKED
    || /^(?:KNOWLEDGE_BASE_|IMPORT_RUN_|EMBEDDING_|REFERENCE_EMBEDDING_|REFERENCE_IMPORT_|PROJECT_RUNTIME_)[A-Z0-9_]+$/u.test(code)
    ? failure(code) : failure('KNOWLEDGE_BASE_REFERENCE_AUTHORITY_REJECTED')
}
function importResultFailure(result: ReferenceKnowledgeImportResult | undefined): Error | undefined {
  if (!result || result.success) return undefined
  const rawCode = result.errorCode ?? result.error
  const code = typeof rawCode === 'string'
    && (rawCode === LEGACY_VECTOR_MIGRATION_BLOCKED
      || /^(?:KNOWLEDGE_BASE_|IMPORT_RUN_|EMBEDDING_|REFERENCE_EMBEDDING_|REFERENCE_IMPORT_)[A-Z0-9_]+$/u.test(rawCode))
    ? rawCode : 'KNOWLEDGE_BASE_REFERENCE_OPERATION_FAILED'
  return failure(code)
}

/** A process-local foreground issuance; persisted grants alone never reconstruct it. */
export class ReferenceKnowledgeAuthority {
  private readonly runtime: ProjectRuntime
  private readonly resources: ReferenceImportResources
  private readonly context: CapturedImportRunContext
  private readonly budgets: ReferenceEmbeddingBudgetRepository
  private readonly issuances = new Map<string, Issuance>()
  private readonly cleanupFailures = new Map<string, Error>()
  private retired = false

  constructor(runtime: ProjectRuntime, private readonly options: Options) {
    this.runtime = runtime
    this.resources = options.resources
    this.context = Object.freeze({ database: runtime.database, canonicalRoot: runtime.canonicalRoot, projectId: runtime.projectId })
    this.budgets = new ReferenceEmbeddingBudgetRepository(runtime.database, {
      assertCurrent: () => this.assertRuntime(false),
      isFrozen: id => readPortableRuntimeFreeze(runtime.canonicalRoot).isFrozen('reference_embedding_budgets', id),
    })
    this.assertRuntime(false)
  }

  private assertRuntime(work = true): void {
    this.resources.assertResources()
    if (this.retired || this.runtime.database !== this.context.database
      || this.runtime.databaseIdentity !== this.resources.databaseIdentity
      || this.runtime.canonicalRoot !== this.resources.canonicalRoot
      || this.runtime.executionEpoch !== this.resources.executionEpoch) throw failure('KNOWLEDGE_BASE_REFERENCE_RESOURCES_CHANGED')
    if (work) projectRuntimeHost.assertWorkAvailable(this.runtime)
  }

  private grants(): ReferenceImportGrantRepository {
    return new ReferenceImportGrantRepository(this.context.database, {
      projectId: this.context.projectId, context: this.context,
      assertCurrent: () => this.assertRuntime(false),
      isFrozen: id => readPortableRuntimeFreeze(this.context.canonicalRoot).isFrozen('reference_import_grants', id),
    })
  }

  private require(subject: Subject, reference: ReferenceKnowledgeReference): Issuance {
    this.assertRuntime()
    const issuance = this.issuances.get(reference.grantId)
    if (!issuance || issuance.sender !== subject || subject.isDestroyed()
      || issuance.reference.projectId !== reference.projectId || issuance.reference.runId !== reference.runId
      || issuance.reference.grantId !== reference.grantId || issuance.reference.revision !== reference.revision
      || issuance.lifecycle.revoked || issuance.lifecycle.destroyed) throw failure('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    return issuance
  }

  private erase(issuance: Issuance): void {
    if (issuance.inFlight || issuance.knowledgeActive || issuance.wholeActive) return
    this.clearEmbedding(issuance)
    this.issuances.delete(issuance.reference.grantId)
    if (issuance.destroyedListener) {
      issuance.sender.removeListener('destroyed', issuance.destroyedListener)
      issuance.destroyedListener = null
    }
  }

  private clearEmbedding(issuance: Issuance): void {
    issuance.embedding = { modelId: null, protocol: 'openai', model: { provider: '', baseUrl: '', apiKey: '' } }
  }

  private revokeGrant(issuance: Issuance): ReferenceImportGrant {
    const grant = this.grants().revoke(grantRef(issuance.reference))
    issuance.lifecycle.revoked = true
    return grant
  }

  private cancel(issuance: Issuance): void {
    const snapshot = ImportRunRepository.get(issuance.runId, this.context)
    if (!snapshot || snapshot.status === 'completed' || snapshot.status === 'cancelled') return
    try {
      ImportRunRepository.assertExecutionAuthority(issuance.runId, issuance.execution, Date.now(), this.context.database)
      ImportRunRepository.requestCancel(issuance.runId, issuance.execution, this.context)
      if (issuance.inFlight === 0 && !issuance.knowledgeActive && !hasImportStageFlight(this.context.database, issuance.runId)
        && (snapshot.stage === 'knowledge' || !issuance.resumed)) {
        ImportRunRepository.cancelAtBoundary(issuance.runId, issuance.execution, this.context)
      }
    } catch (error) {
      const current = this.context.database.prepare('SELECT status, execution_owner, execution_epoch, lease_expires_at FROM import_runs WHERE id=?')
        .get(issuance.runId) as { status: string; execution_owner: string; execution_epoch: number; lease_expires_at: number } | undefined
      if (error instanceof Error && error.message === 'IMPORT_RUN_EXECUTION_STALE'
        && current?.status === 'running' && current.execution_owner === issuance.execution.owner
        && current.execution_epoch === issuance.execution.epoch && current.lease_expires_at <= Date.now()
        && !issuance.resumed && !issuance.wholeActive && !issuance.knowledgeActive && issuance.inFlight === 0
        && !hasImportStageFlight(this.context.database, issuance.runId)) {
        const parent = acquireImportRunParentFlight(this.context.database, issuance.runId)
        try { ImportRunRepository.cancelExpiredReferenceAtBoundary(issuance.runId, issuance.execution, this.context, parent.token) }
        finally { parent.release() }
        return
      }
      if (current && current.execution_owner === issuance.execution.owner && current.execution_epoch === issuance.execution.epoch
        && current.status !== 'completed' && current.status !== 'cancelled') throw error
    }
  }

  private quiesce(issuance: Issuance): ReferenceImportGrant {
    issuance.lifecycle.revoked = true
    try {
      const grant = this.revokeGrant(issuance)
      this.cancel(issuance)
      if (issuance.inFlight === 0 && !issuance.knowledgeActive && !issuance.wholeActive) {
        this.cleanupFailures.delete(issuance.reference.grantId)
        this.erase(issuance)
      }
      return grant
    } catch (error) {
      const safe = safeFailure(error)
      this.cleanupFailures.set(issuance.reference.grantId, safe)
      if (issuance.inFlight === 0 && !issuance.knowledgeActive && !issuance.wholeActive) this.clearEmbedding(issuance)
      throw safe
    }
  }

  prepare(subject: Subject, request: PrepareReferenceKnowledgeRequest, assertFreshView: () => void): {
    reference: ReferenceKnowledgeReference; execution: ImportRunExecutionLease
  } {
    if (this.retired || subject.isDestroyed()) throw failure('KNOWLEDGE_BASE_REFERENCE_CALLER_DESTROYED')
    assertFreshView(); this.assertRuntime()
    assertReferenceImportGrantOperationId(request.operationId)
    if (typeof request.runId !== 'string' || !request.runId || request.runId.length > 160) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID')
    }
    assertReferenceImportGrantOperationId(request.executionOwner)
    assertImportStageUnmanagedMutationAllowed(this.context.database, request.runId)
    const prior = this.grants().getByOperation(request.operationId)
    if (prior) {
      const retained = this.issuances.get(prior.grantId)
      if (!retained || retained.sender !== subject || retained.runId !== request.runId
        || retained.execution.owner !== request.executionOwner || retained.lifecycle.revoked) throw failure('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
      retained.admission.assertCurrent(this.resources, retained.runId)
      ImportRunRepository.assertExecutionAuthority(retained.runId, retained.execution, Date.now(), this.context.database)
      return { reference: retained.reference, execution: retained.execution }
    }
    for (const old of this.issuances.values()) if (old.runId === request.runId && old.knowledgeActive) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
    }
    for (const old of this.issuances.values()) if (old.runId === request.runId && old.inFlight > 0) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_IMPORT_IN_FLIGHT')
    }
    for (const old of this.issuances.values()) if (old.runId === request.runId
      && this.cleanupFailures.has(old.reference.grantId)) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_CLEANUP_PENDING')
    }
    const scope = ImportRunRepository.captureReferenceGrantScope(request.runId, this.context)
    if (scope.status === 'completed') throw failure('KNOWLEDGE_BASE_REFERENCE_RUN_COMPLETED')
    const embedding = cloneEmbedding(this.options.captureEmbedding())
    this.budgets.preflight(request.runId)
    const currentBudget = this.budgets.get(request.runId)
    let requestLimit = 0
    const options = normalizeEmbeddingOptions(embedding.model.embeddingOptions)
    const validatedManifest = ImportRunRepository.streamValidatedReferenceManifest(
      request.runId, this.context, currentBudget ? undefined : chapter => {
        const chunks = chunkText(chapter.content, options.chunkSize, options.chunkOverlap).length
        const requests = Math.ceil(chunks / options.batchSize)
        requestLimit += requests
        if (!Number.isSafeInteger(requestLimit)) referenceEmbeddingBudgetFailure('KNOWLEDGE_BASE_REFERENCE_BUDGET_INVALID')
      })
    if (validatedManifest.manifestFingerprint !== scope.manifestFingerprint) {
      referenceEmbeddingBudgetFailure('KNOWLEDGE_BASE_REFERENCE_BUDGET_PLAN_CONFLICT')
    }
    const plan: ReferenceEmbeddingBudgetPlan | undefined = currentBudget ? undefined : {
      chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap, batchSize: options.batchSize, requestLimit,
    }
    if (!currentBudget && requestLimit < 1) referenceEmbeddingBudgetFailure('KNOWLEDGE_BASE_REFERENCE_BUDGET_INVALID')
    const grantId = randomUUID()
    const reference = Object.freeze({ projectId: this.runtime.projectId, runId: request.runId, grantId, revision: 1 })
    const lifecycle = { revoked: false, destroyed: false }
    const started = this.context.database.transaction(() => {
      const rechecked = ImportRunRepository.streamValidatedReferenceManifest(request.runId, this.context)
      if (rechecked.rootRunId !== validatedManifest.rootRunId
        || rechecked.manifestFingerprint !== validatedManifest.manifestFingerprint
        || rechecked.chapterCount !== validatedManifest.chapterCount) {
        referenceEmbeddingBudgetFailure('KNOWLEDGE_BASE_REFERENCE_BUDGET_PLAN_CONFLICT')
      }
      const budget = this.budgets.prepare({ runId: request.runId,
        manifestFingerprint: scope.manifestFingerprint, ...(plan ? { plan } : {}) })
      const execution = ImportRunRepository.startOrResume(request.runId, request.executionOwner, Date.now(), undefined, this.context)
      const hash = requestHash({ projectId: this.runtime.projectId, root: this.runtime.canonicalRoot,
        nativeIdentity: this.resources.databaseIdentity, epoch: this.resources.executionEpoch, runId: request.runId, owner: execution.execution.owner,
        executionEpoch: execution.execution.epoch, manifestFingerprint: scope.manifestFingerprint, embedding })
      const revoked: Issuance[] = []
      for (const grant of this.grants().listByRun(request.runId)) {
        if (grant.state === 'active') {
          const held = this.issuances.get(grant.grantId)
          if (held && held.inFlight) throw failure('KNOWLEDGE_BASE_REFERENCE_IMPORT_IN_FLIGHT')
          this.grants().revoke({ grantId: grant.grantId, revision: grant.revision, runId: grant.runId })
          if (held) revoked.push(held)
        }
      }
      const grant = this.grants().issue({ grantId, operationKey: request.operationId, runId: request.runId,
        manifestFingerprint: scope.manifestFingerprint, requestHash: hash })
      if (grant.grantId !== reference.grantId || grant.revision !== reference.revision) {
        throw failure('KNOWLEDGE_BASE_REFERENCE_ISSUANCE_CONFLICT')
      }
      const admission = captureReferenceImportAdmission(this.runtime, grantRef(reference), hash, () => {
        if (this.retired || lifecycle.revoked || lifecycle.destroyed) throw failure('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REVOKED')
      }, { repository: this.budgets, capability: budget })
      return { execution: execution.execution, reference, grant, hash, admission, budget, lifecycle, revoked }
    }).immediate()
    for (const old of started.revoked) {
      old.lifecycle.revoked = true
      this.cleanupFailures.delete(old.reference.grantId)
      this.erase(old)
    }
    const issuance: Issuance = { sender: subject, reference: started.reference, operationId: request.operationId, runId: request.runId,
      manifestFingerprint: scope.manifestFingerprint, execution: started.execution, embedding, requestHash: started.hash,
      admission: started.admission, budget: started.budget, lifecycle: started.lifecycle,
      knowledgeActive: false, knowledgeOperation: null, wholeActive: null, inFlight: 0, destroyedListener: null, resumed: false }
    this.issuances.set(started.reference.grantId, issuance)
    const destroyedListener = () => {
      issuance.lifecycle.destroyed = true
      try { this.quiesce(issuance) } catch { /* The close hook retries the retained, locally revoked issuance. */ }
    }
    issuance.destroyedListener = destroyedListener
    subject.once('destroyed', destroyedListener)
    return { reference: started.reference, execution: started.execution }
  }

  resume(subject: Subject, reference: ReferenceKnowledgeReference): ImportRunStartResult {
    const issuance = this.require(subject, reference)
    assertImportStageUnmanagedMutationAllowed(this.context.database, issuance.runId)
    if (issuance.knowledgeActive) throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
    issuance.admission.assertCurrent(this.resources, issuance.runId)
    ImportRunRepository.assertExecutionAuthority(issuance.runId, issuance.execution, Date.now(), this.context.database)
    const run = ImportRunRepository.get(issuance.runId, this.context)
    if (!run || run.status !== 'running') throw failure('IMPORT_RUN_EXECUTION_STALE')
    const execution = ImportRunRepository.renewExecution(issuance.runId, issuance.execution, Date.now(), undefined, this.context)
    issuance.execution = execution
    const resumedRun = ImportRunRepository.get(issuance.runId, this.context)!
    issuance.resumed = true
    return { run: resumedRun, execution }
  }

  assertRunAdmission(subject: Subject, reference: ReferenceKnowledgeReference, execution: ImportRunExecutionAuthority): void {
    const issuance = this.require(subject, reference)
    if (execution.owner !== issuance.execution.owner || execution.epoch !== issuance.execution.epoch) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_MISMATCH')
    }
    issuance.admission.assertCurrent(this.resources, issuance.runId)
    ImportRunRepository.assertExecutionAuthority(issuance.runId, issuance.execution, Date.now(), this.context.database)
  }

  beginRun(subject: Subject, reference: ReferenceKnowledgeReference, execution: ImportRunExecutionAuthority,
    parentToken: ImportRunParentFlightToken): () => void {
    assertImportRunParentFlightCurrent(this.context.database, reference.runId, parentToken)
    const issuance = this.require(subject, reference)
    if (issuance.wholeActive || issuance.knowledgeActive || issuance.inFlight) throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
    if (execution.owner !== issuance.execution.owner || execution.epoch !== issuance.execution.epoch) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_MISMATCH')
    }
    const run = ImportRunRepository.get(issuance.runId, this.context)
    if (run?.status === 'completed' && run.stage === 'completed') {
      const scope = ImportRunRepository.captureReferenceGrantScope(issuance.runId, this.context)
      const grant = this.grants().get(issuance.reference.grantId)
      if (!grant || grant.state !== 'active' || grant.projectId !== reference.projectId
        || grant.runId !== issuance.runId || grant.revision !== reference.revision
        || grant.manifestFingerprint !== issuance.manifestFingerprint || grant.requestHash !== issuance.requestHash
        || scope.runId !== issuance.runId || scope.manifestFingerprint !== issuance.manifestFingerprint
        || scope.status !== 'completed' || scope.stage !== 'completed' || run.purpose !== 'reference') {
        throw failure('REFERENCE_IMPORT_GRANT_SCOPE_MISMATCH')
      }
    } else {
      issuance.admission.assertCurrent(this.resources, issuance.runId)
      ImportRunRepository.assertExecutionAuthority(issuance.runId, issuance.execution, Date.now(), this.context.database)
    }
    issuance.wholeActive = parentToken
    let released = false
    return () => {
      if (released) return
      if (issuance.knowledgeActive || issuance.inFlight) throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
      if (hasImportStageChildFlight(this.context.database, issuance.runId)) throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
      if (issuance.wholeActive !== parentToken) { released = true; return }
      if (issuance.lifecycle.revoked || issuance.lifecycle.destroyed) {
        this.cancelRunAtBoundary(subject, reference, execution, parentToken)
        this.quiesce(issuance)
      }
      issuance.wholeActive = null
      released = true
      if (issuance.lifecycle.revoked || issuance.lifecycle.destroyed) {
        this.cleanupFailures.delete(issuance.reference.grantId)
        this.erase(issuance)
      }
    }
  }

  assertRunCurrent(subject: Subject, reference: ReferenceKnowledgeReference, execution: ImportRunExecutionAuthority,
    parentToken: ImportRunParentFlightToken): void {
    assertImportRunParentFlightCurrent(this.context.database, reference.runId, parentToken)
    const issuance = this.require(subject, reference)
    if (issuance.wholeActive !== parentToken || execution.owner !== issuance.execution.owner
      || execution.epoch !== issuance.execution.epoch) throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_MISMATCH')
    issuance.admission.assertCurrent(this.resources, issuance.runId)
    ImportRunRepository.assertExecutionAuthority(issuance.runId, issuance.execution, Date.now(), this.context.database)
  }

  async withRunHeartbeat<T>(subject: Subject, reference: ReferenceKnowledgeReference, execution: ImportRunExecutionAuthority,
    parentToken: ImportRunParentFlightToken, operation: () => Promise<T>): Promise<T> {
    this.assertRunCurrent(subject, reference, execution, parentToken)
    const issuance = this.require(subject, reference)
    return this.withKnowledgeHeartbeat(issuance, operation)
  }

  cancelRunAtBoundary(subject: Subject, reference: ReferenceKnowledgeReference, execution: ImportRunExecutionAuthority,
    parentToken: ImportRunParentFlightToken): void {
    assertImportRunParentFlightCurrent(this.context.database, reference.runId, parentToken)
    const issuance = this.issuances.get(reference.grantId)
    if (!issuance || issuance.sender !== subject || issuance.wholeActive !== parentToken
      || issuance.reference.projectId !== reference.projectId || issuance.reference.runId !== reference.runId
      || issuance.reference.revision !== reference.revision || issuance.execution.owner !== execution.owner
      || issuance.execution.epoch !== execution.epoch) throw failure('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    if (issuance.knowledgeActive || issuance.inFlight || hasImportStageChildFlight(this.context.database, issuance.runId)) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
    }
    const row = this.context.database.prepare('SELECT status, execution_owner, execution_epoch, lease_expires_at FROM import_runs WHERE id=?')
      .get(issuance.runId) as { status: string; execution_owner: string; execution_epoch: number; lease_expires_at: number } | undefined
    if (!row || row.status !== 'running' || row.execution_owner !== execution.owner || row.execution_epoch !== execution.epoch) return
    if (row.lease_expires_at <= Date.now()) {
      ImportRunRepository.cancelExpiredReferenceAtBoundary(issuance.runId, issuance.execution, this.context, parentToken)
      return
    }
    ImportRunRepository.assertExecutionAuthority(issuance.runId, issuance.execution, Date.now(), this.context.database)
    ImportRunRepository.cancelAtBoundary(issuance.runId, issuance.execution, this.context)
  }

  executeKnowledge(subject: Subject, request: ExecuteReferenceKnowledgeRequest,
    hooks: ReferenceKnowledgeExecutionHooks, parentToken?: ImportRunParentFlightToken): Promise<ImportRunStartResult> {
    const issuance = this.require(subject, request.reference)
    assertImportRunParentFlightAccess(this.context.database, issuance.runId, parentToken)
    if (parentToken && issuance.wholeActive !== parentToken) throw failure('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    if (request.execution.owner !== issuance.execution.owner || request.execution.epoch !== issuance.execution.epoch) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_MISMATCH')
    }
    if (issuance.knowledgeOperation) return issuance.knowledgeOperation
    if (issuance.inFlight > 0) throw failure('KNOWLEDGE_BASE_REFERENCE_IMPORT_IN_FLIGHT')

    const releaseStage = acquireImportStageFlight(this.context.database, issuance.runId, 'knowledge', parentToken)
    let releaseWork: () => void
    try { releaseWork = this.resources.acquireWork() }
    catch (error) { releaseStage(); throw error }
    issuance.knowledgeActive = true
    issuance.resumed = true
    const operation = this.runKnowledge(issuance, hooks, () => {
      try { releaseWork() } finally { releaseStage() }
    })
    issuance.knowledgeOperation = operation
    return operation
  }

  private async renewKnowledgeExecution(issuance: Issuance): Promise<ImportRunExecutionLease> {
    if (issuance.lifecycle.revoked || issuance.lifecycle.destroyed) throw failure('IMPORT_RUN_CANCELLED')
    issuance.admission.assertCurrent(this.resources, issuance.runId)
    const renewed = ImportRunRepository.renewExecution(issuance.runId, issuance.execution, Date.now(), undefined, this.context)
    issuance.execution = renewed
    return renewed
  }

  private async withKnowledgeHeartbeat<T>(issuance: Issuance, operation: () => Promise<T>, heartbeatFirst = false): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let heartbeatError: unknown
    let renewalTail = Promise.resolve()

    const renew = (): Promise<void> => {
      const renewal = renewalTail.then(async () => {
        if (heartbeatError) throw heartbeatError
        try { await this.renewKnowledgeExecution(issuance) }
        catch (error) { heartbeatError = error; throw error }
      })
      renewalTail = renewal.then(() => undefined, () => undefined)
      return renewal
    }
    const schedule = () => {
      if (stopped || heartbeatError) return
      const remaining = Math.max(1, issuance.execution.expiresAt - Date.now())
      timer = setTimeout(() => {
        if (stopped || heartbeatError) return
        void renew().then(schedule, () => undefined)
      }, Math.max(1, Math.min(KNOWLEDGE_HEARTBEAT_MAX_INTERVAL_MS, Math.floor(remaining / 3))))
    }

    await renew()
    schedule()
    let value!: T
    let operationError: unknown
    try { value = await operation() }
    catch (error) { operationError = error }
    finally {
      stopped = true
      if (timer) clearTimeout(timer)
      await renewalTail
    }
    if (heartbeatFirst && heartbeatError) throw heartbeatError
    if (operationError !== undefined) throw operationError
    if (heartbeatError) throw heartbeatError
    return value
  }

  private async runKnowledge(issuance: Issuance, hooks: ReferenceKnowledgeExecutionHooks,
    releaseWork: () => void): Promise<ImportRunStartResult> {
    let source: 'result' | 'throw' = 'throw'
    let outcome: ImportRunStartResult | undefined
    let operationFailure: ReferenceKnowledgeExecutionFailure | undefined
    let locale: ImportRunLocale = 'en-US'
    const secondaryErrors: Error[] = []
    try {
      await this.renewKnowledgeExecution(issuance)
      const run = ImportRunRepository.get(issuance.runId, this.context)
      if (!run || run.purpose !== 'reference' || run.status !== 'running') throw failure('IMPORT_RUN_EXECUTION_STALE')
      locale = run.locale
      outcome = await this.driveKnowledge(issuance, run, hooks, value => { source = value })
    } catch (error) {
      const safe = safeFailure(error)
      const current = ImportRunRepository.get(issuance.runId, this.context)
      locale = current?.locale ?? locale
      const cancelledAtKnowledgeBoundary = safe.message === 'IMPORT_RUN_CANCELLED'
        || (safe.message === 'KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REVOKED'
          && (issuance.lifecycle.revoked || issuance.lifecycle.destroyed))
      if (cancelledAtKnowledgeBoundary) {
        if (this.isCurrentKnowledgeExecution(issuance)) {
          try { ImportRunRepository.cancelAtBoundary(issuance.runId, issuance.execution, this.context) }
          catch (persistError) { secondaryErrors.push(safeFailure(persistError)) }
        }
      } else if (this.isCurrentKnowledgeExecution(issuance)) {
        try {
          const message = hooks.failureMessage(safe.message, locale, source)
          ImportRunRepository.fail(issuance.runId, 'knowledge', message, issuance.execution, this.context)
        } catch (persistError) { secondaryErrors.push(safeFailure(persistError)) }
      }
      const displayMessage = hooks.failureMessage(safe.message, locale, source)
      operationFailure = new ReferenceKnowledgeExecutionFailure(safe.message, displayMessage)
      operationFailure.secondaryErrors.push(...secondaryErrors)
    } finally {
      issuance.knowledgeActive = false
      issuance.knowledgeOperation = null
      try {
        if (issuance.lifecycle.revoked && issuance.inFlight === 0) this.quiesce(issuance)
      } catch (error) {
        if (!operationFailure) {
          const safe = safeFailure(error)
          const displayMessage = hooks.failureMessage(safe.message, locale, 'throw')
          operationFailure = new ReferenceKnowledgeExecutionFailure(safe.message, displayMessage)
        } else operationFailure.secondaryErrors.push(safeFailure(error))
      } finally {
        try { releaseWork() }
        catch (error) {
          if (!operationFailure) {
            const safe = safeFailure(error)
            const displayMessage = hooks.failureMessage(safe.message, locale, 'throw')
            operationFailure = new ReferenceKnowledgeExecutionFailure(safe.message, displayMessage)
          } else operationFailure.secondaryErrors.push(safeFailure(error))
        }
      }
    }
    if (operationFailure) throw operationFailure
    return outcome!
  }

  private isCurrentKnowledgeExecution(issuance: Issuance): boolean {
    const row = this.context.database.prepare(`SELECT status, stage, execution_owner, execution_epoch
      FROM import_runs WHERE id=?`).get(issuance.runId) as {
      status: string; stage: string; execution_owner: string; execution_epoch: number
    } | undefined
    return row?.status === 'running' && row.stage === 'knowledge'
      && row.execution_owner === issuance.execution.owner && row.execution_epoch === issuance.execution.epoch
  }

  private async driveKnowledge(issuance: Issuance, initialRun: ImportRunSnapshot,
    hooks: ReferenceKnowledgeExecutionHooks,
    setFailureSource: (source: 'result' | 'throw') => void): Promise<ImportRunStartResult> {
    const knowledgeIndex = importStagesFor({ purpose: 'reference' }).indexOf('knowledge')
    const currentIndex = importStagesFor(initialRun).indexOf(initialRun.stage)
    if (initialRun.stage !== 'knowledge') {
      if (currentIndex > knowledgeIndex) return { run: initialRun, execution: issuance.execution }
      throw failure('IMPORT_RUN_STAGE_MISMATCH')
    }
    const progressBase = { reference: issuance.reference,
      execution: { owner: issuance.execution.owner, epoch: issuance.execution.epoch } }
    const report = (event: ReferenceKnowledgeProgress) => {
      try { hooks.progress(event) } catch { /* Progress is a view projection, never a durable acknowledgement. */ }
    }
    const assertBoundary = () => {
      if (issuance.lifecycle.revoked || issuance.lifecycle.destroyed) throw failure('IMPORT_RUN_CANCELLED')
      issuance.admission.assertCurrent(this.resources, issuance.runId)
      ImportRunRepository.assertExecutionAuthority(issuance.runId, issuance.execution, Date.now(), this.context.database)
      const run = ImportRunRepository.get(issuance.runId, this.context)
      if (!run || run.status !== 'running' || run.stage !== 'knowledge') {
        throw failure('IMPORT_RUN_EXECUTION_STALE')
      }
      if (run.cancelRequested) throw failure('IMPORT_RUN_CANCELLED')
      return run
    }

    let run = initialRun
    let after = 0
    let visited = 0
    let page = ImportRunRepository.listChapterBatch(issuance.runId,
      { afterChapterNumber: after, limit: IMPORT_KNOWLEDGE_PAGE_SIZE }, this.context)
    while (page.length > 0) {
      for (const batch of splitKnowledgeBatches(page)) {
        const checkpoint = createImportRunChapterBatchCheckpointId(batch)
        if (!run.completedBatches.knowledge?.includes(checkpoint)) {
          assertBoundary()
          for (const chapter of batch) {
            await this.renewKnowledgeExecution(issuance)
            assertBoundary()
            const result = await this.withKnowledgeHeartbeat(issuance, async () => {
              const imported = await this.importChapterForIssuance(issuance, chapter.number)
              if (!imported.success) {
                setFailureSource('result')
                throw importResultFailure(imported) ?? failure('KNOWLEDGE_BASE_REFERENCE_OPERATION_FAILED')
              }
              return imported
            })
            report({ ...progressBase, kind: 'chapter', chapterNumber: chapter.number,
              idempotent: result.idempotent ?? false })
          }
          await this.renewKnowledgeExecution(issuance)
          assertBoundary()
          const completed = ImportRunRepository.completeBatch(issuance.runId, 'knowledge', checkpoint,
            issuance.execution, this.context)
          run = completed.run
          visited += batch.length
          report({ ...progressBase, kind: 'batch', progress: Math.min(99, Math.round((visited / run.totalChapters) * 100)) })
          if (completed.cancelApplied) throw failure('IMPORT_RUN_CANCELLED')
        } else {
          visited += batch.length
          report({ ...progressBase, kind: 'batch', progress: Math.min(99, Math.round((visited / run.totalChapters) * 100)) })
        }
        assertBoundary()
      }
      after = page.at(-1)!.number
      page = ImportRunRepository.listChapterBatch(issuance.runId,
        { afterChapterNumber: after, limit: IMPORT_KNOWLEDGE_PAGE_SIZE }, this.context)
    }
    await this.renewKnowledgeExecution(issuance)
    assertBoundary()
    run = ImportRunRepository.advanceStage(issuance.runId, 'knowledge', 'global', issuance.execution, this.context)
    return { run, execution: issuance.execution }
  }

  async importChapter(subject: Subject, request: { reference: ReferenceKnowledgeReference; chapterNumber: number;
    execution: { owner: string; epoch: number } }): Promise<ReferenceKnowledgeImportResult> {
    const issuance = this.require(subject, request.reference)
    assertImportStageUnmanagedMutationAllowed(this.context.database, issuance.runId)
    if (issuance.knowledgeActive) throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
    if (request.execution.owner !== issuance.execution.owner || request.execution.epoch !== issuance.execution.epoch) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_MISMATCH')
    }
    return this.importChapterForIssuance(issuance, request.chapterNumber)
  }

  private async importChapterForIssuance(issuance: Issuance, chapterNumber: number): Promise<ReferenceKnowledgeImportResult> {
    const release = this.resources.acquireWork()
    issuance.inFlight++
    let primaryFailure: Error | undefined
    let result: ReferenceKnowledgeImportResult | undefined
    try {
      issuance.admission.assertCurrent(this.resources, issuance.runId)
      const binding = ImportRunRepository.resolveReferenceImportAuthority(issuance.runId, issuance.execution,
        chapterNumber, undefined, this.context.database)
      result = await this.options.importReference({ binding, runId: issuance.runId,
        execution: issuance.execution, embedding: issuance.embedding, resources: this.resources, admission: issuance.admission })
      if (result.success) {
        if (!result.docId) throw failure('KNOWLEDGE_BASE_REFERENCE_DOCUMENT_INCOMPLETE')
        issuance.admission.withTransaction(this.resources, issuance.runId,
          () => {
            issuance.admission.budget!.assertEffect()
            ImportRunRepository.commitReferenceImportReceipt(issuance.runId, issuance.execution,
              chapterNumber, result!.docId!, this.context.database)
          })
      }
    } catch (error) { primaryFailure = safeFailure(error) }
    finally {
      issuance.inFlight--
      try {
        if (issuance.lifecycle.revoked && issuance.inFlight === 0 && !issuance.knowledgeActive) {
          try {
            this.quiesce(issuance)
          } catch (error) {
            const cleanupFailure = safeFailure(error)
            const safePrimary = primaryFailure ?? importResultFailure(result)
            primaryFailure = safePrimary
              ? new AggregateError([safePrimary, cleanupFailure], safePrimary.message)
              : cleanupFailure
          }
        }
      } finally {
        try { release() }
        catch (error) {
          const cleanupFailure = safeFailure(error)
          const safePrimary = primaryFailure ?? importResultFailure(result)
          primaryFailure = safePrimary
            ? new AggregateError([safePrimary, cleanupFailure], safePrimary.message)
            : cleanupFailure
        }
      }
    }
    if (primaryFailure) throw primaryFailure
    return result!
  }

  revoke(subject: Subject, reference: ReferenceKnowledgeReference): { state: 'revoked' | 'completed' } {
    const issuance = this.require(subject, reference)
    issuance.lifecycle.revoked = true
    const grant = this.quiesce(issuance)
    return { state: grant.state === 'completed' ? 'completed' : 'revoked' }
  }

  complete(subject: Subject, reference: ReferenceKnowledgeReference): { state: 'completed' } {
    const issuance = this.require(subject, reference)
    assertImportStageUnmanagedMutationAllowed(this.context.database, issuance.runId)
    if (issuance.knowledgeActive) throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
    this.completeOriginalGrant(issuance)
    issuance.lifecycle.revoked = true
    this.erase(issuance)
    return { state: 'completed' }
  }

  private completeOriginalGrant(issuance: Issuance): ReferenceImportGrant {
    const grant = this.grants().complete(grantRef(issuance.reference))
    if (grant.state !== 'completed') throw failure('KNOWLEDGE_BASE_REFERENCE_RUN_NOT_COMPLETED')
    return grant
  }

  async executeRefresh(subject: Subject, request: ReferenceRefreshRequest,
    hooks: ReferenceRefreshExecutionHooks, parentToken?: ImportRunParentFlightToken): Promise<ReferenceRefreshSuccess> {
    this.assertRuntime(false)
    hooks.assertCurrent()
    assertImportRunParentFlightAccess(this.context.database, request.reference.runId, parentToken)
    if (subject.isDestroyed() || request.reference.projectId !== this.context.projectId) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    }

    const scope = ImportRunRepository.captureReferenceGrantScope(request.reference.runId, this.context)
    const savedGrant = this.grants().get(request.reference.grantId)
    const savedRun = ImportRunRepository.get(request.reference.runId, this.context)
    if (!savedGrant || !savedRun || savedGrant.projectId !== request.reference.projectId
      || savedGrant.runId !== request.reference.runId || savedGrant.revision !== request.reference.revision
      || savedGrant.manifestFingerprint !== scope.manifestFingerprint
      || savedRun.id !== scope.runId || savedRun.purpose !== 'reference') {
      throw failure('REFERENCE_IMPORT_GRANT_SCOPE_MISMATCH')
    }

    const retained = this.issuances.get(request.reference.grantId)
    if (!retained) {
      if (savedGrant.state !== 'completed' || savedRun.status !== 'completed' || savedRun.stage !== 'completed'
        || scope.status !== 'completed' || scope.stage !== 'completed') {
        throw failure('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
      }
      return { version: 1, run: savedRun, execution: null, replayed: true }
    }

    const issuance = this.require(subject, request.reference)
    if (parentToken && issuance.wholeActive !== parentToken) throw failure('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    if (request.execution.owner !== issuance.execution.owner || request.execution.epoch !== issuance.execution.epoch) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_MISMATCH')
    }
    if (issuance.knowledgeActive || issuance.inFlight > 0) throw failure('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
    if (savedGrant.state !== 'active' && savedGrant.state !== 'completed') {
      throw failure('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    }

    if (savedRun.status === 'completed' && savedRun.stage === 'completed' && scope.status === 'completed'
      && scope.stage === 'completed') {
      if (savedGrant.state === 'active') this.completeOriginalGrant(issuance)
      issuance.lifecycle.revoked = true
      this.erase(issuance)
      return { version: 1, run: savedRun, execution: null, replayed: true }
    }
    if (savedGrant.state !== 'active' || savedRun.status !== 'running' || savedRun.stage !== 'refresh'
      || scope.status !== 'running' || scope.stage !== 'refresh') {
      throw failure('IMPORT_RUN_STAGE_MISMATCH')
    }

    const releaseStage = acquireImportStageFlight(this.context.database, issuance.runId, 'refresh', parentToken)
    let releaseWork: () => void
    try { releaseWork = this.resources.acquireWork() }
    catch (error) { releaseStage(); throw error }
    issuance.inFlight++

    return this.driveRefresh(issuance, hooks, savedRun, releaseWork, releaseStage)
  }

  private async driveRefresh(issuance: Issuance, hooks: ReferenceRefreshExecutionHooks,
    initialRun: ImportRunSnapshot, releaseWork: () => void, releaseStage: () => void): Promise<ReferenceRefreshSuccess> {
    let currentRun = initialRun
    let replayed = initialRun.completedBatches.refresh?.includes('done') ?? false
    let runCompleted = false
    let operationFailure: ReferenceKnowledgeExecutionFailure | undefined
    const secondaryErrors: Error[] = []
    const stillCurrent = () => this.isCurrentRefreshExecution(issuance)
    const cancelled = () => {
      if (hooks.signal.aborted || issuance.lifecycle.revoked || issuance.lifecycle.destroyed) return true
      const run = ImportRunRepository.get(issuance.runId, this.context)
      return !run || run.status === 'cancelled' || run.cancelRequested
    }
    const cancelAtBoundary = () => {
      if (!stillCurrent()) return
      const run = ImportRunRepository.get(issuance.runId, this.context)
      if (run?.status === 'running' && run.stage === 'refresh') {
        ImportRunRepository.cancelAtBoundary(issuance.runId, issuance.execution, this.context)
      }
    }

    try {
      hooks.assertCurrent()
      await this.renewKnowledgeExecution(issuance)
      currentRun = ImportRunRepository.get(issuance.runId, this.context)!
      if (!currentRun || currentRun.status !== 'running' || currentRun.stage !== 'refresh') {
        throw failure('IMPORT_RUN_EXECUTION_STALE')
      }
      if (!replayed) {
        if (cancelled()) {
          cancelAtBoundary()
          throw failure('IMPORT_RUN_CANCELLED')
        }
        if (hooks.signal.aborted) throw failure('IMPORT_RUN_CANCELLED')
        await this.withKnowledgeHeartbeat(issuance, () => hooks.refresh(), true)
        hooks.assertCurrent()
        await this.renewKnowledgeExecution(issuance)
        const checkpoint = ImportRunRepository.completeBatch(issuance.runId, 'refresh', 'done', issuance.execution, this.context)
        currentRun = checkpoint.run
        replayed = !checkpoint.newlyCompleted
      }

      hooks.progress(100)
      if (cancelled()) {
        cancelAtBoundary()
        throw failure('IMPORT_RUN_CANCELLED')
      }
      hooks.assertCurrent()
      await this.renewKnowledgeExecution(issuance)
      if (cancelled()) {
        cancelAtBoundary()
        throw failure('IMPORT_RUN_CANCELLED')
      }
      hooks.assertCurrent()
      currentRun = ImportRunRepository.complete(issuance.runId, issuance.execution, this.context)
      runCompleted = true
      this.completeOriginalGrant(issuance)
      issuance.lifecycle.revoked = true
    } catch (error) {
      const safe = safeFailure(error)
      currentRun = ImportRunRepository.get(issuance.runId, this.context) ?? currentRun
      if (!runCompleted && stillCurrent()) {
        const isCancelled = safe.message === 'IMPORT_RUN_CANCELLED'
          || (safe.message === 'KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REVOKED'
            && (issuance.lifecycle.revoked || issuance.lifecycle.destroyed))
        try {
          if (isCancelled) cancelAtBoundary()
          else {
            const message = hooks.failureMessage(safe.message, currentRun.locale)
            ImportRunRepository.fail(issuance.runId, 'refresh', message, issuance.execution, this.context)
          }
        } catch (persistError) { secondaryErrors.push(safeFailure(persistError)) }
      }
      operationFailure = new ReferenceKnowledgeExecutionFailure(safe.message,
        hooks.failureMessage(safe.message, currentRun.locale))
      operationFailure.secondaryErrors.push(...secondaryErrors)
    } finally {
      issuance.inFlight--
      try {
        if (issuance.lifecycle.revoked && issuance.inFlight === 0 && !issuance.knowledgeActive) {
          try { this.quiesce(issuance) }
          catch (error) {
            const safe = safeFailure(error)
            if (operationFailure) operationFailure.secondaryErrors.push(safe)
            else operationFailure = new ReferenceKnowledgeExecutionFailure(safe.message,
              hooks.failureMessage(safe.message, currentRun.locale))
          }
        }
      } finally {
        try { releaseWork() }
        catch (error) {
          const safe = safeFailure(error)
          if (operationFailure) operationFailure.secondaryErrors.push(safe)
          else operationFailure = new ReferenceKnowledgeExecutionFailure(safe.message,
            hooks.failureMessage(safe.message, currentRun.locale))
        }
        try { releaseStage() }
        catch (error) {
          const safe = safeFailure(error)
          if (operationFailure) operationFailure.secondaryErrors.push(safe)
          else operationFailure = new ReferenceKnowledgeExecutionFailure(safe.message,
            hooks.failureMessage(safe.message, currentRun.locale))
        }
      }
    }

    if (operationFailure) throw operationFailure
    return { version: 1, run: currentRun, execution: null, replayed }
  }

  private isCurrentRefreshExecution(issuance: Issuance): boolean {
    const row = this.context.database.prepare(`SELECT status, stage, execution_owner, execution_epoch
      FROM import_runs WHERE id=?`).get(issuance.runId) as {
      status: string; stage: string; execution_owner: string; execution_epoch: number
    } | undefined
    return row?.status === 'running' && row.stage === 'refresh'
      && row.execution_owner === issuance.execution.owner && row.execution_epoch === issuance.execution.epoch
  }

  hasIssuance(grantId: string): boolean { return this.issuances.has(grantId) }

  canRetire(): boolean { return this.issuances.size === 0 && this.cleanupFailures.size === 0 }

  requestProjectClose(): void {
    const failures: Error[] = []
    for (const issuance of this.issuances.values()) {
      try { this.quiesce(issuance) } catch (error) { failures.push(safeFailure(error)) }
    }
    if (failures.length) throw new AggregateError(failures, 'KNOWLEDGE_BASE_REFERENCE_CLOSE_CLEANUP_FAILED')
  }

  retire(): void {
    if (this.cleanupFailures.size) throw new AggregateError([...this.cleanupFailures.values()], 'KNOWLEDGE_BASE_REFERENCE_CLOSE_CLEANUP_FAILED')
    if ([...this.issuances.values()].some(issuance => issuance.inFlight > 0 || issuance.knowledgeActive || issuance.wholeActive)) {
      throw failure('KNOWLEDGE_BASE_REFERENCE_IMPORT_IN_FLIGHT')
    }
    this.retired = true
    for (const issuance of this.issuances.values()) this.erase(issuance)
  }
}

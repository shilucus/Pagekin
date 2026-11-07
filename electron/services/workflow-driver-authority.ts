import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'
import { isDraftVisibleTextVersion, sanitizeDraftText } from '../../src/shared/draft-visible-text'
import type { PrepareDraftContextRequest } from '../../src/shared/generation-owner-contract'
import { assertWorkflowDriverRequest, parseWorkflowDriverRecipe, type StartWorkflowDriverRequest,
  type WorkflowDriverReceipt, type WorkflowDriverReference, type WorkflowDriverResult } from '../../src/shared/workflow-driver-contract'
import { GenerationRunRepository, textHash, type RunBinding } from '../repositories/generation-run-repository'
import { WorkflowDriverRepository, type WorkflowDriverTask, type WorkflowDriverTaskRef } from '../repositories/workflow-driver-repository'
import { GenerationDraftEffects } from './generation-draft-effects'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'
import type { ProjectRuntime } from './project-runtime'
import type { createMainGenerationOwner, MainGenerationOwnerDependencies } from './main-generation-owner'
import { runWorkflowDriver } from './workflow-driver-engine'

export interface WorkflowDriverSubject {
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
}
type Owner = Pick<ReturnType<typeof createMainGenerationOwner>, 'draftPreparationBinding' | 'prepareDraftContext'
  | 'preparedKnowledge' | 'beginWorkflowDriver' | 'rollbackWorkflowDriverPreparation' | 'executeWorkflowDriver'
  | 'recoverWorkflowDriverRun' | 'assertWorkflowDriverRecoverySources' | 'pauseWorkflowDriver'
  | 'read' | 'readContext' | 'composeVisible' | 'commitDraft' | 'assertSourcesCurrent' | 'resume'
  | 'hasPhysicalInFlight' | 'whenPhysicalIdle' | 'assertRetirable' | 'retireIdle' | 'requestProjectClose' | 'suspendForProjectClose'>
export interface WorkflowDriverAuthorityOptions {
  runtime: ProjectRuntime
  assertAdmission(): void
  assertCapturedResources(): void
  acquireWork(): () => void
  withKnowledge<T>(handle: MainGenerationRunHandle, operation: () => T | Promise<T>): Promise<T>
  withPreparedKnowledge<T>(preparationId: string, chapterNumber: number, operation: () => T | Promise<T>): Promise<T>
  createOwner(hooks: { assertNoRuntimeClaims(): void; workflowDriver: NonNullable<MainGenerationOwnerDependencies['workflowDriver']> }): Owner
}
interface Issuance { subject: WorkflowDriverSubject; task: WorkflowDriverTask; handle: MainGenerationRunHandle; claim: boolean }
const refOf = (task: WorkflowDriverTask): WorkflowDriverTaskRef => ({ taskId: task.taskId, revision: task.revision, runId: task.runId })
const publicRef = (task: WorkflowDriverTask): WorkflowDriverReference => ({ projectId: task.projectId, taskId: task.taskId, revision: task.revision })
function fail(code: string): never { throw new Error(`WORKFLOW_DRIVER_${code}`) }

/** This projection does not create an owner or sign execution authority. */
export function readWorkflowDriverReceipt(runtime: ProjectRuntime, taskId: string, assertCapturedResources: () => void): WorkflowDriverReceipt {
  const frozen = readPortableRuntimeFreeze(runtime.canonicalRoot)
  const repository = new WorkflowDriverRepository(runtime.database, { projectId: runtime.projectId, assertCurrent: assertCapturedResources,
    isFrozen: (table, id) => frozen.isFrozen(table, id) })
  const task = repository.get(taskId)
  if (!task) fail('TASK_MISSING')
  const runs = new GenerationRunRepository(() => runtime.database, Date.now, (table, id) => frozen.isFrozen(table, id))
  const effects = repository.readEffects(taskId)
  const steps = repository.readSteps(taskId).map(step => ({ stepId: step.stepId, commandId: step.commandId,
    ordinal: step.ordinal, kind: step.kind, inputHash: step.inputHash,
    effect: effects.find(effect => effect.stepId === step.stepId) ?? null }))
  if (frozen.isFrozen('workflow_tasks', task.taskId)) {
    if (!frozen.isFrozen('generation_runs', task.runId)
      || repository.readSteps(taskId).some(step => !frozen.isFrozen('workflow_steps', step.stepId))
      || effects.some(effect => !frozen.isFrozen('workflow_effects', effect.stepId))) fail('HISTORY_INVALID')
    const rows = runtime.database.prepare(`SELECT t.attempt_id,t.root_action_id,t.attempt_json,
      a.artifact_id,a.run_id AS artifact_run_id,a.artifact_json,a.revision
      FROM generation_attempts t LEFT JOIN generation_artifacts a ON a.attempt_id=t.attempt_id
      WHERE t.run_id=? ORDER BY t.rowid`).all(task.runId) as {
        attempt_id: string; root_action_id: string; attempt_json: string; artifact_id: string | null;
        artifact_run_id: string | null; artifact_json: string | null; revision: number | null
      }[]
    const attempts: WorkflowDriverReceipt['attempts'] = []
    const historicalArtifacts: NonNullable<WorkflowDriverReceipt['historicalArtifacts']> = []
    for (const row of rows) {
      if (!frozen.isFrozen('generation_attempts', row.attempt_id)) fail('HISTORY_INVALID')
      let attempt: Record<string, unknown>, artifact: Record<string, unknown> | null
      try {
        attempt = JSON.parse(row.attempt_json)
        artifact = row.artifact_json === null ? null : JSON.parse(row.artifact_json)
      } catch { fail('HISTORY_INVALID') }
      if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)
        || attempt.attemptId !== row.attempt_id || attempt.rootActionId !== row.root_action_id
        || !['reserved', 'dispatch-marked', 'settled', 'unknown', 'cancelled-before-dispatch'].includes(String(attempt.status))) fail('HISTORY_INVALID')
      if (artifact) {
        if (typeof artifact !== 'object' || Array.isArray(artifact) || row.artifact_run_id !== task.runId
          || artifact.artifactId !== row.artifact_id || artifact.attemptId !== row.attempt_id
          || artifact.rootActionId !== row.root_action_id || artifact.revision !== row.revision
          || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
          || typeof artifact.text !== 'string' || typeof artifact.textHash !== 'string'
          || textHash(artifact.text) !== artifact.textHash) fail('HISTORY_INVALID')
        historicalArtifacts.push({ attemptId: row.attempt_id, artifactId: row.artifact_id!, revision: row.revision!,
          text: artifact.text, textHash: artifact.textHash })
      } else if (row.artifact_id !== null || row.artifact_json !== null) fail('HISTORY_INVALID')
      attempts.push({ attemptId: row.attempt_id, status: attempt.status as WorkflowDriverReceipt['attempts'][number]['status'],
        artifactId: row.artifact_id })
    }
    const fullSteps = repository.readSteps(taskId)
    const composeStep = fullSteps[2]!, draftStep = fullSteps[1]!, commitStep = fullSteps[3]!
    const composeEffect = effects.find(effect => effect.stepId === composeStep.stepId)
    const draftEffect = effects.find(effect => effect.stepId === draftStep.stepId)
    const commitEffect = effects.find(effect => effect.stepId === commitStep.stepId)
    let composition: WorkflowDriverReceipt['composition'] = null
    if (composeEffect) {
      const input = composeStep.input
      const artifact = historicalArtifacts.find(item => item.attemptId === composeEffect.receiptAttemptId)
      if (!input || input.kind !== 'compose' || !isDraftVisibleTextVersion(input.algorithm)
        || input.artifactIds.length !== 1 || !artifact || input.artifactIds[0] !== artifact.artifactId
        || !draftEffect || draftEffect.receiptKind !== 'model' || draftEffect.receiptAttemptId !== artifact.attemptId
        || draftEffect.contentHash !== artifact.textHash || composeEffect.receiptKind !== 'composition') fail('HISTORY_INVALID')
      const text = sanitizeDraftText(artifact.text, input.algorithm), hash = textHash(text)
      if (!text.trim() || hash !== input.expectedTextHash || hash !== composeEffect.contentHash) fail('HISTORY_INVALID')
      composition = { algorithm: input.algorithm, text, textHash: hash, artifactIds: [artifact.artifactId],
        sources: [{ artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }] }
    }
    if (commitEffect && (!composition || commitEffect.receiptKind !== 'draft_commit'
      || commitEffect.receiptAttemptId !== composeEffect?.receiptAttemptId || commitEffect.contentHash !== composition.textHash
      || commitStep.input?.kind !== 'commit' || commitStep.input.chapterNumber !== 1
      || commitStep.input.expectedCompositionHash !== composition.textHash)) fail('HISTORY_INVALID')
    assertCapturedResources()
    return { task: { taskId: task.taskId, projectId: task.projectId, template: task.template, runId: task.runId,
      revision: task.revision, state: task.state, blockedCode: task.blockedCode, createdAt: task.createdAt, updatedAt: task.updatedAt },
    steps, attempts, composition, historicalArtifacts, draftSave: commitEffect ? { kind: 'changed' } : { kind: 'absent' },
    ...(commitEffect ? { draftSaveProof: 'unavailable' as const } : {}), nonReplayable: true }
  }
  const attempts = runs.readRunView(task.runId).attempts.map(({ receipt }) => ({ attemptId: receipt.attempt.attemptId,
    status: receipt.attempt.status, artifactId: receipt.artifact?.artifactId ?? null }))
  const draftSave = new GenerationDraftEffects(runtime.database, runs).readRecovery(task.runId)
  assertCapturedResources()
  return { task: { taskId: task.taskId, projectId: task.projectId, template: task.template, runId: task.runId,
    revision: task.revision, state: task.state, blockedCode: task.blockedCode, createdAt: task.createdAt, updatedAt: task.updatedAt },
  steps, attempts, composition: runs.readVisibleComposition(task.runId), draftSave, nonReplayable: true }
}

export class WorkflowDriverAuthority {
  readonly runtime: ProjectRuntime
  private readonly repository: WorkflowDriverRepository
  private readonly runs: GenerationRunRepository
  private readonly owner: Owner
  private readonly issuances = new Map<string, Issuance>()
  private readonly subjects = new WeakSet<WorkflowDriverSubject>()
  private readonly running = new Map<string, Promise<void>>()
  private closing = false
  private retired = false

  constructor(private readonly options: WorkflowDriverAuthorityOptions) {
    this.runtime = options.runtime
    const frozen = readPortableRuntimeFreeze(this.runtime.canonicalRoot)
    this.repository = new WorkflowDriverRepository(this.runtime.database, { projectId: this.runtime.projectId,
      assertCurrent: options.assertCapturedResources, isFrozen: (table, id) => frozen.isFrozen(table, id) })
    this.runs = new GenerationRunRepository(() => this.runtime.database, Date.now, (table, id) => frozen.isFrozen(table, id))
    this.owner = options.createOwner({ assertNoRuntimeClaims: () => {
      if ([...this.issuances.values()].some(item => item.claim) || this.running.size) fail('OWNER_BUSY')
    }, workflowDriver: {
      assertActive: runId => { this.active(runId) },
      assertDispatchAdmission: (runId, nonce, task) => {
        const issuance = this.active(runId)
        const steps = this.repository.readSteps(issuance.task.taskId)
        const effects = this.repository.readEffects(issuance.task.taskId)
        const step = steps.find(item => item.invocationNonce === nonce)
        if (!step || !step.input || step.input.kind !== 'model' || !isDeepStrictEqual(step.input.task, task)
          || effects.some(effect => effect.stepId === step.stepId)
          || steps.slice(0, step.ordinal).some(item => !effects.some(effect => effect.stepId === item.stepId))) fail('DISPATCH_MISMATCH')
        const attempts = this.runs.readRunView(runId).attempts
        if (attempts.length !== step.ordinal) fail('DISPATCH_ORDER')
      },
    } })
  }

  private active(runId: string): Issuance {
    if (this.closing || this.retired) fail('OWNER_CLOSING')
    this.options.assertAdmission(); this.options.assertCapturedResources()
    const issuance = [...this.issuances.values()].find(item => item.handle.runId === runId)
    if (!issuance || !issuance.claim || issuance.subject.isDestroyed()) fail('CAPABILITY_REQUIRED')
    const check = () => this.repository.assertActive(refOf(issuance.task))
    if (this.runtime.database.inTransaction) check()
    else this.runtime.database.transaction(check).immediate()
    return issuance
  }
  private owned(subject: WorkflowDriverSubject, reference: WorkflowDriverReference, checkRevision = true): Issuance {
    this.options.assertCapturedResources()
    const item = this.issuances.get(reference.taskId)
    if (!item || item.subject !== subject || subject.isDestroyed() || reference.projectId !== this.runtime.projectId) fail('CAPABILITY_REQUIRED')
    if (checkRevision && reference.revision !== item.task.revision) fail('REVISION_CONFLICT')
    return item
  }
  private result(item: Issuance): WorkflowDriverResult { return { reference: publicRef(item.task), receipt: this.receipt(item.task.taskId) } }
  private receipt(taskId: string): WorkflowDriverReceipt { return readWorkflowDriverReceipt(this.runtime, taskId, this.options.assertCapturedResources) }
  private handle(runId: string): MainGenerationRunHandle {
    const run = this.runs.get(runId)
    return { projectId: run.binding.projectId, epoch: run.binding.epoch, rootActionId: run.rootActionId, runId }
  }
  private observe(subject: WorkflowDriverSubject): void {
    if (this.subjects.has(subject)) return
    this.subjects.add(subject)
    subject.once('destroyed', () => {
      for (const item of this.issuances.values()) if (item.subject === subject && item.claim) {
        try { this.stop(item, false) } catch { console.error('[workflow-driver] sender cleanup failed') }
      }
    })
  }
  private stop(item: Issuance, cancel: boolean): void {
    let failure: unknown
    try { item.task = cancel ? this.repository.cancel(refOf(item.task)) : this.repository.pause(refOf(item.task)); item.claim = false }
    catch (error) { failure = error }
    try { this.owner.pauseWorkflowDriver(item.handle, cancel) }
    catch (error) { if (failure) throw new AggregateError([failure, error], 'WORKFLOW_DRIVER_STOP_FAILED'); throw error }
    if (failure) throw failure
  }
  private launch(item: Issuance): void {
    if (this.running.has(item.task.taskId)) fail('TASK_BUSY')
    const release = this.options.acquireWork()
    const ref = refOf(item.task)
    const work = runWorkflowDriver({ database: this.runtime.database, repository: this.repository, runs: this.runs,
      owner: this.owner, handle: item.handle, ref, assertActive: () => { this.active(item.task.runId) }, withKnowledge: this.options.withKnowledge })
      .catch(error => {
        const current = this.repository.get(ref.taskId)
        if (current && item.claim && current.revision === ref.revision && current.state === 'ready') {
          const raw = error instanceof Error ? error.message : ''
          const code = /^[A-Z][A-Z0-9_]{0,127}$/u.test(raw) ? raw : 'WORKFLOW_DRIVER_FAILED'
          item.task = this.repository.block(ref, code)
          item.claim = false
          this.owner.pauseWorkflowDriver(item.handle)
        }
      }).catch(() => { console.error('[workflow-driver] failed to persist task state') })
      .finally(async () => {
        try {
          await this.owner.whenPhysicalIdle()
          this.running.delete(ref.taskId)
          const current = this.repository.get(ref.taskId)
          if (current && current.state !== 'ready') { item.task = current; item.claim = false }
        } finally { release() }
      }).catch(() => { console.error('[workflow-driver] failed to finish task cleanup') })
    this.running.set(ref.taskId, work)
  }
  prepareDraftContextBinding(request: PrepareDraftContextRequest): RunBinding { return this.owner.draftPreparationBinding(request) }
  prepareDraftContext(request: PrepareDraftContextRequest, snapshot: GenerationKnowledgeSnapshot, baseline: RunBinding) {
    return this.owner.prepareDraftContext(request, snapshot, baseline)
  }
  preparedKnowledge(preparationId: string) { return this.owner.preparedKnowledge(preparationId) }
  hasIssuance(taskId?: string, subject?: WorkflowDriverSubject): boolean {
    if (taskId === undefined) return [...this.issuances.values()].some(item => item.claim) || this.running.size > 0
    const item = this.issuances.get(taskId)
    return Boolean(item && (!subject || item.subject === subject))
  }

  async start(subject: WorkflowDriverSubject, request: StartWorkflowDriverRequest, assertFreshView: () => void): Promise<WorkflowDriverResult> {
    assertWorkflowDriverRequest('workflow-driver:v1:start', request)
    assertFreshView(); this.options.assertAdmission(); this.options.assertCapturedResources()
    if (this.closing || this.retired || subject.isDestroyed()) fail('OWNER_CLOSING')
    const recipe = parseWorkflowDriverRecipe(request.recipe)
    const requestHash = textHash(JSON.stringify({ selection: request.selection, recipe }))
    const prior = this.repository.getByOperation(request.operationKey)
    if (prior) {
      if (prior.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
      const issued = this.issuances.get(prior.taskId)
      return { reference: issued?.subject === subject ? publicRef(issued.task) : null, receipt: this.receipt(prior.taskId) }
    }
    if (this.hasIssuance() || this.owner.hasPhysicalInFlight()) fail('TASK_BUSY')
    const taskId = randomUUID()
    let handle: MainGenerationRunHandle | undefined
    return this.options.withPreparedKnowledge(request.selection.preparationId!, 1, () => {
      assertFreshView(); this.options.assertAdmission(); this.options.assertCapturedResources()
      if (subject.isDestroyed() || this.closing) fail('OWNER_CLOSING')
      if (this.hasIssuance() || this.owner.hasPhysicalInFlight()) fail('TASK_BUSY')
      let task: WorkflowDriverTask
      try {
        task = this.runtime.database.transaction(() => {
          const view = this.owner.beginWorkflowDriver({ ...request.selection, uiActionNonce: `workflow-driver:${taskId}` })
          handle = view.handle
          return this.repository.issue({ taskId, operationKey: request.operationKey, requestHash, runId: view.handle.runId, recipe })
        }).immediate()
      } catch (error) {
        if (handle) this.owner.rollbackWorkflowDriverPreparation(handle)
        throw error
      }
      if (!handle) fail('RUN_MISSING')
      const item: Issuance = { subject, task, handle, claim: true }
      this.issuances.set(task.taskId, item); this.observe(subject)
      try { this.launch(item) } catch (error) {
        try { this.stop(item, false) } catch (cleanup) { throw new AggregateError([error, cleanup], 'WORKFLOW_DRIVER_START_CLEANUP_FAILED') }
        throw error
      }
      return this.result(item)
    })
  }
  readReceipt(subject: WorkflowDriverSubject, reference: WorkflowDriverReference): WorkflowDriverReceipt {
    this.owned(subject, reference, false)
    return this.receipt(reference.taskId)
  }
  pause(subject: WorkflowDriverSubject, reference: WorkflowDriverReference): WorkflowDriverResult {
    const item = this.owned(subject, reference)
    if (this.retired || this.closing) fail('OWNER_CLOSING')
    if (item.task.state === 'ready') this.stop(item, false)
    return this.result(item)
  }
  cancel(subject: WorkflowDriverSubject, reference: WorkflowDriverReference): WorkflowDriverResult {
    const item = this.owned(subject, reference)
    if ((this.retired || this.closing) && !['cancelled', 'waiting_review'].includes(item.task.state)) fail('OWNER_CLOSING')
    if (!['cancelled', 'waiting_review'].includes(item.task.state)) this.stop(item, true)
    return this.result(item)
  }
  async resume(subject: WorkflowDriverSubject, reference: WorkflowDriverReference): Promise<WorkflowDriverResult> {
    const item = this.owned(subject, reference)
    if (this.retired || this.closing) fail('OWNER_CLOSING')
    this.options.assertAdmission()
    if (item.task.state === 'ready') return this.result(item)
    if (['cancelled', 'waiting_review'].includes(item.task.state)) return this.result(item)
    if (this.running.has(item.task.taskId) || this.owner.hasPhysicalInFlight()) fail('TASK_BUSY')
    item.task = this.repository.resume(refOf(item.task)); item.claim = true
    try {
      const view = await this.options.withKnowledge(item.handle, () => this.owner.resume(item.handle))
      item.handle = view.handle
      this.active(item.handle.runId)
      this.launch(item)
    } catch (error) {
      try { this.stop(item, false) } catch (cleanup) { throw new AggregateError([error, cleanup], 'WORKFLOW_DRIVER_RESUME_CLEANUP_FAILED') }
      throw error
    }
    return this.result(item)
  }
  async reauthorize(subject: WorkflowDriverSubject, taskId: string, assertFreshView: () => void): Promise<WorkflowDriverResult> {
    assertFreshView(); this.options.assertAdmission(); this.options.assertCapturedResources()
    if (this.closing || this.retired || subject.isDestroyed()) fail('OWNER_CLOSING')
    const existing = this.issuances.get(taskId)
    if (existing?.claim || this.hasIssuance() || this.owner.hasPhysicalInFlight()) fail('TASK_BUSY')
    let task = this.repository.get(taskId)
    if (!task) fail('TASK_MISSING')
    if (['cancelled', 'waiting_review'].includes(task.state)) return { reference: null, receipt: this.receipt(taskId) }
    for (const step of this.repository.readSteps(taskId)) {
      if (!step.input) break
      try { if (!this.repository.acknowledgeFromReceipt(refOf(task), step.stepId)) break }
      catch (error) { if (error instanceof Error && error.message === 'WORKFLOW_DRIVER_RECEIPT_NOT_COMMITTED') break; throw error }
      task = this.repository.get(taskId)!
    }
    if (task.state === 'waiting_review') return { reference: null, receipt: this.receipt(taskId) }
    let handle = this.handle(task.runId)
    await this.options.withKnowledge(handle, () => {
      assertFreshView(); this.options.assertAdmission()
      this.owner.assertWorkflowDriverRecoverySources(handle)
    })
    assertFreshView(); this.options.assertAdmission()
    if (subject.isDestroyed() || this.closing || this.hasIssuance() || this.owner.hasPhysicalInFlight()) fail('TASK_BUSY')
    const latest = this.repository.get(taskId)
    if (!latest || latest.revision !== task.revision || latest.state !== task.state) fail('REVISION_CONFLICT')
    if (handle.epoch !== this.runtime.executionEpoch) {
      this.owner.recoverWorkflowDriverRun(task.runId)
      handle = this.handle(task.runId)
    } else if (this.runs.budget(handle.rootActionId).root.status === 'active') {
      this.owner.pauseWorkflowDriver(handle)
    }
    if (task.state === 'ready') task = this.repository.pause(refOf(task))
    const item: Issuance = { subject, task, handle, claim: false }
    this.issuances.set(taskId, item); this.observe(subject)
    return this.result(item)
  }
  assertRetirable(): void { this.owner.assertRetirable() }
  retireIdle(): void { this.owner.retireIdle(); this.retired = true }
  requestProjectClose(): void {
    this.closing = true
    const failures: unknown[] = []
    for (const item of this.issuances.values()) if (item.claim) try { this.stop(item, false) } catch (error) { failures.push(error) }
    try { this.owner.requestProjectClose() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'WORKFLOW_DRIVER_CLOSE_FAILED')
  }
  hasPhysicalInFlight(): boolean { return this.owner.hasPhysicalInFlight() || this.running.size > 0 }
  suspendForProjectClose(): void { this.owner.suspendForProjectClose() }
}

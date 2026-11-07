import { randomUUID } from 'node:crypto'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import { assertRuntimeFeedbackRequest, type PrepareRuntimeFeedbackRequest, type RuntimeFeedbackChannels,
  type RuntimeFeedbackReceipt, type RuntimeFeedbackReference } from '../../src/shared/runtime-feedback-contract'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'
import { GenerationRecoveryTailRepository } from '../repositories/generation-recovery-tail-repository'
import { PlanningFeedbackRepository } from '../repositories/planning-feedback-repository'
import { RuntimeFeedbackGrantRepository, type RuntimeFeedbackGrant } from '../repositories/runtime-feedback-grant-repository'
import type { createMainGenerationOwner, MainGenerationOwnerDependencies } from './main-generation-owner'
import type { PlanningFeedbackGenerationInput } from './planning-feedback-service'
import type { ProjectRuntime } from './project-runtime'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'

export interface RuntimeFeedbackSubject {
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
}

type NarrowOwner = Pick<ReturnType<typeof createMainGenerationOwner>,
  'beginRuntimeFieldFeedback' | 'rollbackRuntimeFieldFeedbackPreparation' | 'executeRuntimeFieldFeedback'
  | 'stageRuntimeFieldFeedback' | 'cancelRuntimeFieldFeedback'
  | 'hasPhysicalInFlight' | 'assertRetirable' | 'retireIdle' | 'requestProjectClose' | 'suspendForProjectClose'>

export interface RuntimeFeedbackAuthorityOptions {
  runtime: ProjectRuntime
  assertOpen(): void
  /** New dispatch/effect admission, not permission for already-authorized cleanup. */
  assertAdmission(): void
  /** Exact captured resources, also valid during synchronous true-close cleanup. */
  assertCapturedResources(): void
  createOwner(hooks: {
    assertNoRuntimeClaims(): void
    runtimeFeedback: NonNullable<MainGenerationOwnerDependencies['runtimeFeedback']>
  }): NarrowOwner
}

interface Issuance {
  subject: RuntimeFeedbackSubject
  reference: RuntimeFeedbackReference
  handle: MainGenerationRunHandle
  input: PlanningFeedbackGenerationInput
  modelId: string
  claim: boolean
  cancelRequested: boolean
}

function fail(code: string): never { throw new Error(`RUNTIME_FEEDBACK_${code}`) }
const grantRef = (grant: Pick<RuntimeFeedbackGrant, 'grantId' | 'revision' | 'runId'>) => ({
  grantId: grant.grantId, revision: grant.revision, runId: grant.runId,
})

/** Pure history projection: constructing it cannot create an owner, lease or execution capability. */
export function readRuntimeFeedbackReceipt(runtime: ProjectRuntime, grantId: string,
  assertCapturedResources: () => void): RuntimeFeedbackReceipt {
  const frozen = readPortableRuntimeFreeze(runtime.canonicalRoot)
  const grants = new RuntimeFeedbackGrantRepository(runtime.database, { projectId: runtime.projectId,
    assertCurrent: assertCapturedResources, isFrozen: id => frozen.isFrozen('runtime_feedback_grants', id) })
  const grant = grants.get(grantId)
  if (!grant) fail('GRANT_MISSING')
  const runs = new GenerationRunRepository(() => runtime.database, Date.now, (table, id) => frozen.isFrozen(table, id))
  const recoveryTails = new GenerationRecoveryTailRepository(runtime.database, runs, (table, id) => frozen.isFrozen(table, id)).list(grant.runId)
  const feedback = new PlanningFeedbackRepository(runtime.database, { projectId: runtime.projectId,
    assertCurrent: assertCapturedResources, isFrozen: (table, id) => frozen.isFrozen(table, id),
    assertGenerationCurrent: () => fail('HISTORY_READ_ONLY') })
  const attempts = runs.readRunView(grant.runId).attempts.map(({ receipt }) => ({
    attemptId: receipt.attempt.attemptId, status: receipt.attempt.status, artifactId: receipt.artifact?.artifactId ?? null,
  }))
  assertCapturedResources()
  return { grant: { grantId: grant.grantId, projectId: grant.projectId, revision: grant.revision, target: grant.target,
    baseId: grant.baseId, parentCandidateId: grant.parentCandidateId, runId: grant.runId, state: grant.state,
    candidateId: grant.candidateId }, attempts,
  candidate: grant.candidateId ? feedback.getCandidate(grant.candidateId) : null,
  ...(recoveryTails.length ? { recoveryTails } : {}), nonReplayable: true }
}

/** A private single-producer facade. Durable rows and renderer references are not bearer authority. */
export class RuntimeFeedbackAuthority {
  readonly runtime: ProjectRuntime
  private readonly grants: RuntimeFeedbackGrantRepository
  private readonly owner: NarrowOwner
  private readonly issuances = new Map<string, Issuance>()
  private readonly observedSubjects = new WeakSet<RuntimeFeedbackSubject>()
  private retired = false
  private closing = false

  constructor(private readonly options: RuntimeFeedbackAuthorityOptions) {
    this.runtime = options.runtime
    this.grants = new RuntimeFeedbackGrantRepository(this.runtime.database, { projectId: this.runtime.projectId,
      assertCurrent: options.assertCapturedResources,
      isFrozen: id => readPortableRuntimeFreeze(this.runtime.canonicalRoot).isFrozen('runtime_feedback_grants', id) })
    this.owner = options.createOwner({
      assertNoRuntimeClaims: () => {
        if ([...this.issuances.values()].some(value => value.claim)) fail('OWNER_BUSY')
      },
      runtimeFeedback: {
        assertActive: runId => { this.active(runId) },
        assertDispatchAdmission: runId => {
          const issuance = this.active(runId)
          this.grants.assertActive({ grantId: issuance.reference.grantId, revision: issuance.reference.revision, runId })
        },
      },
    })
  }

  private active(runId: string): Issuance {
    if (this.closing) fail('OWNER_CLOSING')
    this.options.assertAdmission()
    this.options.assertCapturedResources()
    const issuance = [...this.issuances.values()].find(value => value.handle.runId === runId)
    if (!issuance || !issuance.claim || issuance.subject.isDestroyed()) fail('CAPABILITY_REQUIRED')
    const grant = this.grants.get(issuance.reference.grantId)
    if (!grant || grant.state !== 'active' || grant.revision !== issuance.reference.revision
      || grant.projectId !== this.runtime.projectId || grant.runId !== runId) fail('CAPABILITY_REVOKED')
    return issuance
  }

  private owned(subject: RuntimeFeedbackSubject, reference: Pick<RuntimeFeedbackReference, 'projectId' | 'grantId'>): Issuance {
    this.options.assertCapturedResources()
    const issuance = this.issuances.get(reference.grantId)
    if (!issuance || issuance.subject !== subject || subject.isDestroyed()
      || reference.projectId !== this.runtime.projectId) fail('CAPABILITY_REQUIRED')
    return issuance
  }

  private exact(subject: RuntimeFeedbackSubject, reference: RuntimeFeedbackReference): Issuance {
    const issuance = this.owned(subject, reference)
    if (issuance.reference.revision !== reference.revision) fail('REVISION_CONFLICT')
    return issuance
  }

  private receipt(grantId: string): RuntimeFeedbackReceipt {
    return readRuntimeFeedbackReceipt(this.runtime, grantId, this.options.assertCapturedResources)
  }

  private requestCancel(issuance: Issuance): void {
    if (issuance.cancelRequested) return
    issuance.cancelRequested = true
    this.owner.cancelRuntimeFieldFeedback(issuance.handle)
  }

  private revokeIssuance(issuance: Issuance, cancel: boolean): void {
    let prior: RuntimeFeedbackGrant
    let revoked: RuntimeFeedbackGrant
    try {
      const current = this.grants.get(issuance.reference.grantId)
      if (!current) fail('GRANT_MISSING')
      prior = current
      revoked = this.grants.revoke({ grantId: issuance.reference.grantId,
        revision: issuance.reference.revision, runId: issuance.handle.runId })
    } catch (error) {
      if (cancel && issuance.subject.isDestroyed()) {
        try { this.requestCancel(issuance) }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'RUNTIME_FEEDBACK_REVOKE_CLEANUP_FAILED') }
      }
      throw error
    }
    if (prior.state === 'active' && revoked.state === 'revoked') {
      issuance.claim = false
      if (cancel) this.requestCancel(issuance)
    }
  }

  private observe(subject: RuntimeFeedbackSubject): void {
    if (this.observedSubjects.has(subject)) return
    this.observedSubjects.add(subject)
    subject.once('destroyed', () => {
      for (const issuance of this.issuances.values()) {
        if (issuance.subject !== subject || !issuance.claim) continue
        try { this.revokeIssuance(issuance, true) }
        catch { console.error('[runtime-feedback] sender cleanup failed') }
      }
    })
  }

  prepare(subject: RuntimeFeedbackSubject, request: PrepareRuntimeFeedbackRequest,
    assertFreshView: () => void): RuntimeFeedbackChannels['runtime-feedback:v1:prepare']['return'] {
    assertRuntimeFeedbackRequest('runtime-feedback:v1:prepare', request)
    if (this.retired) fail('OWNER_RETIRED')
    if (this.closing) fail('OWNER_CLOSING')
    assertFreshView()
    this.options.assertAdmission()
    this.options.assertCapturedResources()
    if (subject.isDestroyed()) fail('CALLER_DESTROYED')
    if (this.runtime.database.inTransaction) fail('PREPARE_TRANSACTION_OPEN')
    const input: PlanningFeedbackGenerationInput = { baseId: request.input.baseId,
      parentCandidateId: request.input.parentCandidateId ?? null, feedback: request.input.feedback,
      constraints: [...request.input.constraints] }
    const feedback = new PlanningFeedbackRepository(this.runtime.database, { projectId: this.runtime.projectId,
      assertCurrent: this.options.assertCapturedResources,
      isFrozen: (table, id) => readPortableRuntimeFreeze(this.runtime.canonicalRoot).isFrozen(table, id),
      assertGenerationCurrent: () => fail('HISTORY_READ_ONLY') })
    const base = feedback.getBase(input.baseId)
    if (base.schemaVersion !== 1) fail('TARGET_INVALID')
    const requestHash = textHash(JSON.stringify({ schemaVersion: 1, projectId: this.runtime.projectId, target: base.target,
      baseId: input.baseId, parentCandidateId: input.parentCandidateId, feedback: input.feedback, constraints: input.constraints }))
    const prior = this.grants.getByOperation(request.operationId)
    if (prior) {
      if (prior.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
      const retained = this.issuances.get(prior.grantId)
      const frozenModel = retained?.modelId ?? (new GenerationRunRepository(() => this.runtime.database)
        .get(prior.runId).binding.sourceManifest.modelReceipt as { modelId?: unknown } | undefined)?.modelId
      if (frozenModel !== request.modelId) fail('IDEMPOTENCY_CONFLICT')
      return { reference: retained?.subject === subject ? { ...retained.reference } : null, receipt: this.receipt(prior.grantId) }
    }
    let handle: MainGenerationRunHandle | undefined
    let grant: RuntimeFeedbackGrant
    try {
      grant = this.runtime.database.transaction(() => {
        const view = this.owner.beginRuntimeFieldFeedback({ input, modelId: request.modelId,
          uiActionNonce: `runtime-feedback:${request.operationId}` })
        handle = { ...view.handle }
        const issued = this.grants.issue({ grantId: randomUUID(), operationKey: request.operationId,
          target: base.target, baseId: input.baseId, parentCandidateId: input.parentCandidateId ?? null,
          runId: handle.runId, requestHash })
        assertFreshView()
        this.options.assertAdmission()
        if (subject.isDestroyed()) fail('CALLER_DESTROYED')
        return issued
      }).immediate()
    } catch (error) {
      if (handle) {
        try { this.owner.rollbackRuntimeFieldFeedbackPreparation(handle) }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'RUNTIME_FEEDBACK_PREPARE_ROLLBACK_FAILED') }
      }
      throw error
    }
    // Native COMMIT and capability publication are contiguous and synchronous.
    const reference = { projectId: this.runtime.projectId, grantId: grant.grantId, revision: grant.revision }
    const issuance: Issuance = { subject, reference, handle: handle!, input, modelId: request.modelId, claim: true, cancelRequested: false }
    this.issuances.set(grant.grantId, issuance)
    this.observe(subject)
    if (subject.isDestroyed()) { this.revokeIssuance(issuance, true); fail('CALLER_DESTROYED') }
    return { reference: { ...reference }, receipt: this.receipt(grant.grantId) }
  }

  async execute(subject: RuntimeFeedbackSubject, reference: RuntimeFeedbackReference): Promise<RuntimeFeedbackReceipt> {
    assertRuntimeFeedbackRequest('runtime-feedback:v1:execute', reference)
    const issuance = this.exact(subject, reference)
    if (this.grants.get(reference.grantId)?.state !== 'active') return this.receipt(reference.grantId)
    this.active(issuance.handle.runId)
    try {
      const result = await this.owner.executeRuntimeFieldFeedback(issuance.handle)
      this.options.assertCapturedResources()
      const grant = this.grants.get(reference.grantId)
      if (grant?.state !== 'active') return this.receipt(reference.grantId)
      this.active(issuance.handle.runId)
      const artifact = result.outcome.receipt.visibleArtifact
      if (result.outcome.status === 'completed' && artifact) {
        this.grants.withCandidateCommit(grantRef(grant), () => {
          this.active(issuance.handle.runId)
          return this.owner.stageRuntimeFieldFeedback({ ...issuance.input, runId: issuance.handle.runId,
            attemptId: artifact.attemptId, artifactId: artifact.artifactId })
        })
        issuance.claim = false
      } else {
        this.revokeIssuance(issuance, true)
      }
      return this.receipt(reference.grantId)
    } catch (error) {
      try { this.revokeIssuance(issuance, true) }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'RUNTIME_FEEDBACK_EXECUTION_CLEANUP_FAILED') }
      throw error
    }
  }

  revoke(subject: RuntimeFeedbackSubject, reference: RuntimeFeedbackReference): RuntimeFeedbackReceipt {
    assertRuntimeFeedbackRequest('runtime-feedback:v1:revoke', reference)
    const issuance = this.exact(subject, reference)
    this.options.assertOpen()
    this.revokeIssuance(issuance, true)
    return this.receipt(reference.grantId)
  }

  readReceipt(subject: RuntimeFeedbackSubject, reference: Pick<RuntimeFeedbackReference, 'projectId' | 'grantId'>): RuntimeFeedbackReceipt {
    assertRuntimeFeedbackRequest('runtime-feedback:v1:read-receipt', reference)
    this.owned(subject, reference)
    return this.receipt(reference.grantId)
  }

  hasPhysicalInFlight(): boolean { return this.owner.hasPhysicalInFlight() }
  requestProjectClose(): void {
    this.closing = true
    const failures: unknown[] = []
    for (const issuance of this.issuances.values()) {
      if (!issuance.claim) continue
      try { this.revokeIssuance(issuance, true) }
      catch (error) {
        failures.push(error)
        try { this.requestCancel(issuance) } catch (cancelError) { failures.push(cancelError) }
      }
    }
    try { this.owner.requestProjectClose() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'RUNTIME_FEEDBACK_CLOSE_QUIESCE_FAILED')
  }
  hasIssuance(grantId: string): boolean { return this.issuances.has(grantId) }
  assertRetirable(): void { this.owner.assertRetirable() }
  prepareRetirement(): void {
    for (const issuance of this.issuances.values()) {
      if (issuance.claim && issuance.subject.isDestroyed()) this.revokeIssuance(issuance, true)
    }
    this.owner.assertRetirable()
  }
  retireIdle(): void {
    this.prepareRetirement()
    this.owner.retireIdle()
    this.retired = true
  }

  suspendForProjectClose(): void {
    // Host has already fenced physical/handler work. Do not require an open UI lease in closing.
    for (const issuance of this.issuances.values()) if (issuance.claim) this.revokeIssuance(issuance, false)
    this.owner.suspendForProjectClose()
    this.issuances.clear()
  }
}

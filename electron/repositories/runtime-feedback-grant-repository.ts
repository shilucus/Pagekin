import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { assertPlanningFeedbackId, assertPlanningFeedbackObject, isPlanningFeedbackCoreTarget,
  type PlanningFeedbackCandidate, type PlanningFeedbackCoreTarget } from '../../src/shared/planning-feedback'
import { isContentHash } from '../../src/shared/source-ref'

type Row = Record<string, unknown>
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
function fail(code: string): never { throw new Error(`RUNTIME_FEEDBACK_GRANT_${code}`) }
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) fail('INVALID')
  return Number(value)
}
function id(value: unknown): string { assertPlanningFeedbackId(value); return value }
function operationId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) fail('ID_INVALID')
  return value
}
function json(value: unknown): Row {
  if (typeof value !== 'string') fail('INTEGRITY_FAILED')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { fail('INTEGRITY_FAILED') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('INTEGRITY_FAILED')
  return parsed as Row
}

export interface RuntimeFeedbackGrantRef {
  grantId: string
  revision: number
  runId: string
}

export interface RuntimeFeedbackGrant extends RuntimeFeedbackGrantRef {
  operationKey: string
  projectId: string
  action: 'planning-feedback-candidate'
  target: PlanningFeedbackCoreTarget
  baseId: string
  parentCandidateId: string | null
  requestHash: string
  state: 'active' | 'completed' | 'revoked'
  candidateId: string | null
  decisionSource: 'author-action'
  createdAt: number
  revokedAt: number | null
}

export interface IssueRuntimeFeedbackGrant {
  grantId: string
  operationKey: string
  requestHash: string
  target: PlanningFeedbackCoreTarget
  baseId: string
  parentCandidateId: string | null
  runId: string
  createdAt?: number
}

export interface RuntimeFeedbackGrantRepositoryOptions {
  projectId: string
  /** Verify captured resources and the exact native DB; execution caps stay in main memory. */
  assertCurrent(): void
  isFrozen(grantId: string): boolean
  now?(): number
}

/** Explicit resources only. Historical rows cannot reconstruct permission to execute a run. */
export class RuntimeFeedbackGrantRepository {
  constructor(private readonly db: Database.Database, private readonly options: RuntimeFeedbackGrantRepositoryOptions) {
    assertPlanningFeedbackId(options.projectId)
  }

  private current(): void {
    if (!this.db.open) fail('DATABASE_NOT_READY')
    const result: unknown = this.options.assertCurrent()
    if (result !== undefined) fail('ASYNC_GUARD_INVALID')
  }

  private transaction<T>(callback: () => T): T {
    this.current()
    return this.db.transaction(() => { this.current(); return callback() }).immediate()
  }

  private ref(ref: RuntimeFeedbackGrantRef): void {
    assertPlanningFeedbackObject(ref, ['grantId', 'revision', 'runId'])
    operationId(ref.grantId)
    integer(ref.revision, 1)
    id(ref.runId)
  }

  private row(row: Row): RuntimeFeedbackGrant {
    if (row.action !== 'planning-feedback-candidate' || !isPlanningFeedbackCoreTarget(row.target)
      || typeof row.request_hash !== 'string' || !isContentHash(row.request_hash)
      || row.decision_source !== 'author-action'
      || !['active', 'completed', 'revoked'].includes(String(row.state))) fail('INTEGRITY_FAILED')
    const result: RuntimeFeedbackGrant = { grantId: operationId(row.grant_id), operationKey: id(row.operation_key),
      projectId: id(row.project_id), revision: integer(row.revision, 1), action: row.action, target: row.target, baseId: id(row.base_id),
      parentCandidateId: row.parent_candidate_id === null ? null : id(row.parent_candidate_id), runId: id(row.run_id),
      requestHash: row.request_hash, state: row.state as RuntimeFeedbackGrant['state'],
      candidateId: row.candidate_id === null ? null : id(row.candidate_id), decisionSource: row.decision_source,
      createdAt: integer(row.created_at), revokedAt: row.revoked_at === null ? null : integer(row.revoked_at) }
    if (result.state === 'completed' ? result.candidateId === null || result.revokedAt !== null
      : result.candidateId !== null || (result.state === 'active' ? result.revokedAt !== null : result.revokedAt === null || result.revision < 2)) fail('INTEGRITY_FAILED')
    if (result.projectId !== this.options.projectId && !this.options.isFrozen(result.grantId)) fail('PROJECT_MISMATCH')
    return result
  }

  get(grantId: string): RuntimeFeedbackGrant | null {
    this.current()
    const row = this.db.prepare('SELECT * FROM runtime_feedback_grants WHERE grant_id=?').get(operationId(grantId)) as Row | undefined
    return row ? this.row(row) : null
  }

  getByRun(runId: string): RuntimeFeedbackGrant | null {
    this.current()
    const row = this.db.prepare('SELECT * FROM runtime_feedback_grants WHERE run_id=?').get(id(runId)) as Row | undefined
    return row ? this.row(row) : null
  }

  getByOperation(operationKey: string): RuntimeFeedbackGrant | null {
    this.current()
    const row = this.db.prepare('SELECT * FROM runtime_feedback_grants WHERE operation_key=?').get(operationId(operationKey)) as Row | undefined
    return row ? this.row(row) : null
  }

  private mutable(grant: RuntimeFeedbackGrant): void {
    if (grant.projectId !== this.options.projectId || this.options.isFrozen(grant.grantId)) fail('HISTORY_FROZEN')
  }

  private binding(grant: Pick<RuntimeFeedbackGrant, 'projectId' | 'target' | 'baseId' | 'parentCandidateId' | 'runId'>): number {
    const base = this.db.prepare('SELECT * FROM planning_feedback_bases WHERE base_id=?').get(grant.baseId) as Row | undefined
    if (!base || base.project_id !== this.options.projectId || base.project_id !== grant.projectId
      || base.schema_version !== 1 || base.scope_json !== null || base.target !== grant.target) fail('BASE_MISMATCH')
    if (grant.parentCandidateId !== null) {
      const parent = this.db.prepare('SELECT schema_version,project_id,base_id FROM planning_feedback_candidates WHERE candidate_id=?')
        .get(grant.parentCandidateId) as Row | undefined
      if (!parent || parent.schema_version !== 1 || parent.project_id !== grant.projectId || parent.base_id !== grant.baseId) fail('PARENT_MISMATCH')
    }
    const row = this.db.prepare(`SELECT r.binding_json,root.action_json,root.budget_json
      FROM generation_runs r JOIN generation_roots root ON root.root_action_id=r.root_action_id WHERE r.run_id=?`)
      .get(grant.runId) as Row | undefined
    if (!row) fail('RUN_MISMATCH')
    const binding = json(row.binding_json), action = json(row.action_json), budget = json(row.budget_json)
    const manifest = binding.sourceManifest as Row | undefined
    const context = manifest?.planningFeedbackContext as Row | undefined
    if (binding.projectId !== grant.projectId || action.projectId !== grant.projectId || action.operation !== 'planning-feedback'
      || manifest?.operation !== 'planning-feedback' || context?.schemaVersion !== 1 || context.projectId !== grant.projectId
      || context.target !== grant.target || context.baseId !== grant.baseId || context.parentCandidateId !== grant.parentCandidateId
      || budget.maxPhysicalRequests !== 1) fail('RUN_MISMATCH')
    const count = this.db.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(grant.runId) as number
    if (count > 1) fail('ATTEMPT_LIMIT')
    return count
  }

  issue(request: IssueRuntimeFeedbackGrant): RuntimeFeedbackGrant {
    assertPlanningFeedbackObject(request, ['grantId', 'operationKey', 'requestHash', 'target', 'baseId', 'parentCandidateId', 'runId'], ['createdAt'])
    operationId(request.grantId)
    operationId(request.operationKey)
    if (typeof request.requestHash !== 'string' || !isContentHash(request.requestHash)) fail('HASH_INVALID')
    if (!isPlanningFeedbackCoreTarget(request.target)) fail('TARGET_INVALID')
    id(request.baseId)
    if (request.parentCandidateId !== null) id(request.parentCandidateId)
    id(request.runId)
    if (request.createdAt !== undefined) integer(request.createdAt)
    return this.transaction(() => {
      const prior = this.getByOperation(request.operationKey)
      if (prior) {
        this.mutable(prior)
        if (prior.requestHash !== request.requestHash || prior.target !== request.target || prior.baseId !== request.baseId
          || prior.parentCandidateId !== request.parentCandidateId || prior.runId !== request.runId) fail('IDEMPOTENCY_CONFLICT')
        return prior
      }
      if (this.get(request.grantId)) fail('IDEMPOTENCY_CONFLICT')
      if (this.options.isFrozen(request.grantId)) fail('HISTORY_FROZEN')
      const grant: RuntimeFeedbackGrant = { ...request, projectId: this.options.projectId, revision: 1,
        action: 'planning-feedback-candidate', state: 'active', candidateId: null, decisionSource: 'author-action',
        createdAt: integer(request.createdAt ?? (this.options.now ?? Date.now)()), revokedAt: null }
      if (this.binding(grant) !== 0) fail('RUN_ALREADY_STARTED')
      if (this.getByRun(grant.runId)) fail('RUN_ALREADY_GRANTED')
      this.db.prepare(`INSERT INTO runtime_feedback_grants
        (grant_id,operation_key,project_id,revision,action,target,base_id,parent_candidate_id,run_id,request_hash,state,candidate_id,decision_source,created_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(grant.grantId, grant.operationKey, grant.projectId, 1, grant.action, grant.target, grant.baseId,
        grant.parentCandidateId, grant.runId, grant.requestHash, grant.state, null, grant.decisionSource, grant.createdAt, null)
      return grant
    })
  }

  private matching(ref: RuntimeFeedbackGrantRef): RuntimeFeedbackGrant {
    const grant = this.get(ref.grantId)
    if (!grant) fail('MISSING')
    this.mutable(grant)
    if (grant.runId !== ref.runId) fail('RUN_MISMATCH')
    return grant
  }

  assertActive(ref: RuntimeFeedbackGrantRef): RuntimeFeedbackGrant {
    this.ref(ref)
    this.current()
    if (!this.db.inTransaction) fail('TRANSACTION_REQUIRED')
    const grant = this.matching(ref)
    if (grant.revision !== ref.revision) fail('REVISION_CONFLICT')
    if (grant.state !== 'active') fail('INACTIVE')
    this.binding(grant)
    return grant
  }

  revoke(ref: RuntimeFeedbackGrantRef): RuntimeFeedbackGrant {
    this.ref(ref)
    return this.transaction(() => {
      const grant = this.matching(ref)
      if (grant.state === 'revoked' && grant.revision === ref.revision + 1) return grant
      if (grant.revision !== ref.revision) fail('REVISION_CONFLICT')
      if (grant.state === 'completed') return grant
      if (grant.state !== 'active') fail('INACTIVE')
      const revokedAt = integer((this.options.now ?? Date.now)())
      const result = this.db.prepare(`UPDATE runtime_feedback_grants SET state='revoked',revision=revision+1,revoked_at=?
        WHERE grant_id=? AND revision=? AND state='active'`).run(revokedAt, grant.grantId, ref.revision)
      if (result.changes !== 1) fail('REVISION_CONFLICT')
      return this.get(grant.grantId)!
    })
  }

  private candidate(grant: RuntimeFeedbackGrant, candidate: PlanningFeedbackCandidate): void {
    const row = this.db.prepare('SELECT * FROM planning_feedback_candidates WHERE candidate_id=?').get(id(candidate.candidateId)) as Row | undefined
    if (!row || row.schema_version !== 1 || candidate.schemaVersion !== 1 || row.project_id !== grant.projectId
      || candidate.projectId !== grant.projectId || row.base_id !== grant.baseId || candidate.baseId !== grant.baseId
      || row.parent_candidate_id !== grant.parentCandidateId || candidate.parentCandidateId !== grant.parentCandidateId) fail('CANDIDATE_MISMATCH')
    const origin = json(row.origin_json)
    if (origin.kind !== 'generated' || origin.runId !== grant.runId || !isDeepStrictEqual(origin, candidate.origin)) fail('CANDIDATE_MISMATCH')
    const artifact = this.db.prepare(`SELECT 1 FROM generation_artifacts a JOIN generation_attempts attempt ON attempt.attempt_id=a.attempt_id
      WHERE a.artifact_id=? AND a.attempt_id=? AND a.run_id=? AND attempt.run_id=?`)
      .get(id(origin.artifactId), id(origin.attemptId), grant.runId, grant.runId)
    if (!artifact || this.binding(grant) !== 1) fail('CANDIDATE_MISMATCH')
  }

  withCandidateCommit(ref: RuntimeFeedbackGrantRef, callback: () => PlanningFeedbackCandidate): RuntimeFeedbackGrant {
    this.ref(ref)
    return this.transaction(() => {
      const prior = this.matching(ref)
      if (prior.revision !== ref.revision) fail('REVISION_CONFLICT')
      if (prior.state === 'completed') return prior
      const grant = this.assertActive(ref)
      if (Object.prototype.toString.call(callback) === '[object AsyncFunction]') fail('ASYNC_CALLBACK_INVALID')
      const candidate: unknown = callback()
      if (!candidate || typeof candidate !== 'object' || typeof (candidate as { then?: unknown }).then === 'function') fail('ASYNC_CALLBACK_INVALID')
      this.assertActive(ref)
      this.candidate(grant, candidate as PlanningFeedbackCandidate)
      const result = this.db.prepare(`UPDATE runtime_feedback_grants SET state='completed',candidate_id=?
        WHERE grant_id=? AND revision=? AND state='active'`).run((candidate as PlanningFeedbackCandidate).candidateId, grant.grantId, ref.revision)
      if (result.changes !== 1) fail('REVISION_CONFLICT')
      return this.get(grant.grantId)!
    })
  }
}

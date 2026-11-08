import type Database from 'better-sqlite3'
import { assertIssueReferenceImportGrant, assertReferenceImportGrantId, assertReferenceImportGrantOperationId,
  assertReferenceImportGrantRef, referenceImportGrantFail as fail, referenceImportGrantInteger as integer,
  type IssueReferenceImportGrant, type ReferenceImportGrant, type ReferenceImportGrantRef } from '../../src/shared/reference-import-grant'
import { isContentHash } from '../../src/shared/source-ref'
import { ImportRunRepository, type CapturedImportRunContext } from './import-run-repository'

export type { IssueReferenceImportGrant, ReferenceImportGrant, ReferenceImportGrantRef } from '../../src/shared/reference-import-grant'

export interface ReferenceImportGrantRepositoryOptions {
  projectId: string
  context: CapturedImportRunContext
  /** Synchronous captured resource and native database identity check; no capability is reconstructed. */
  assertCurrent(): void
  isFrozen(grantId: string): boolean
  now?(): number
}

type Row = Record<string, unknown>

/** Grant lifecycle only. Import stages, leases and effect receipts retain their existing writer. */
export class ReferenceImportGrantRepository {
  constructor(private readonly db: Database.Database, private readonly options: ReferenceImportGrantRepositoryOptions) {
    assertReferenceImportGrantId(options.projectId)
  }

  private current(): void {
    if (!this.db.open) fail('DATABASE_NOT_READY')
    if (this.options.context.database !== this.db || this.options.context.projectId !== this.options.projectId) fail('DATABASE_MISMATCH')
    const result: unknown = this.options.assertCurrent()
    if (result !== undefined) fail('ASYNC_GUARD_INVALID')
  }

  private frozen(grantId: string): boolean {
    const value: unknown = this.options.isFrozen(grantId)
    if (typeof value !== 'boolean') fail('ASYNC_GUARD_INVALID')
    return value
  }

  private transaction<T>(callback: () => T): T {
    this.current()
    return this.db.transaction(() => { this.current(); return callback() }).immediate()
  }

  private row(row: Row): ReferenceImportGrant {
    assertReferenceImportGrantOperationId(row.grant_id)
    assertReferenceImportGrantId(row.operation_key)
    assertReferenceImportGrantId(row.project_id)
    assertReferenceImportGrantId(row.import_run_id)
    const frozen = this.frozen(row.grant_id)
    if (row.project_id !== this.options.projectId && !frozen) fail('PROJECT_MISMATCH')
    if ((row.manifest_fingerprint === null) !== (row.request_hash === null)) fail('INTEGRITY_FAILED')
    for (const value of [row.manifest_fingerprint, row.request_hash]) {
      if (value !== null && (typeof value !== 'string' || !isContentHash(value))) fail('INTEGRITY_FAILED')
    }
    if (row.request_hash === null && !frozen) fail('HISTORY_FROZEN')
    if (row.action !== 'reference-import-v1' || row.decision_source !== 'author-action') fail('INTEGRITY_FAILED')
    const createdAt = integer(row.created_at), revision = integer(row.revision, 1)
    const completedAt = row.completed_at === null ? null : integer(row.completed_at)
    const revokedAt = row.revoked_at === null ? null : integer(row.revoked_at)
    if (!(row.state === 'active' && completedAt === null && revokedAt === null
      || row.state === 'completed' && completedAt !== null && revokedAt === null
      || row.state === 'revoked' && completedAt === null && revokedAt !== null && revision >= 2)) fail('INTEGRITY_FAILED')
    return { grantId: row.grant_id, operationKey: row.operation_key, projectId: row.project_id, runId: row.import_run_id,
      revision, action: row.action, manifestFingerprint: row.manifest_fingerprint as string | null,
      requestHash: row.request_hash as string | null, state: row.state, decisionSource: row.decision_source,
      createdAt, completedAt, revokedAt }
  }

  get(grantId: string): ReferenceImportGrant | null {
    this.current()
    assertReferenceImportGrantOperationId(grantId)
    const row = this.db.prepare('SELECT * FROM reference_import_grants WHERE grant_id=?').get(grantId) as Row | undefined
    return row ? this.row(row) : null
  }

  getByOperation(operationKey: string): ReferenceImportGrant | null {
    this.current()
    assertReferenceImportGrantId(operationKey)
    const row = this.db.prepare('SELECT * FROM reference_import_grants WHERE operation_key=?').get(operationKey) as Row | undefined
    return row ? this.row(row) : null
  }

  listByRun(runId: string): ReferenceImportGrant[] {
    this.current()
    assertReferenceImportGrantId(runId)
    return (this.db.prepare('SELECT * FROM reference_import_grants WHERE import_run_id=? ORDER BY created_at,grant_id').all(runId) as Row[])
      .map(row => this.row(row))
  }

  private mutable(grant: ReferenceImportGrant): void {
    if (grant.projectId !== this.options.projectId || this.frozen(grant.grantId)
      || grant.manifestFingerprint === null || grant.requestHash === null) fail('HISTORY_FROZEN')
  }

  private binding(grant: Pick<ReferenceImportGrant, 'runId' | 'manifestFingerprint'>) {
    const scope = ImportRunRepository.captureReferenceGrantScope(grant.runId, this.options.context)
    if (scope.runId !== grant.runId || scope.manifestFingerprint !== grant.manifestFingerprint) fail('SCOPE_MISMATCH')
    return scope
  }

  issue(request: IssueReferenceImportGrant): ReferenceImportGrant {
    assertIssueReferenceImportGrant(request)
    return this.transaction(() => {
      const prior = this.getByOperation(request.operationKey)
      if (prior) {
        this.mutable(prior)
        if (prior.grantId !== request.grantId || prior.runId !== request.runId || prior.requestHash !== request.requestHash
          || prior.manifestFingerprint !== request.manifestFingerprint
          || request.createdAt !== undefined && prior.createdAt !== request.createdAt) fail('IDEMPOTENCY_CONFLICT')
        this.binding(prior)
        return prior
      }
      if (this.frozen(request.grantId)) fail('HISTORY_FROZEN')
      const existing = this.get(request.grantId)
      if (existing) {
        this.mutable(existing)
        fail('IDEMPOTENCY_CONFLICT')
      }
      const grant: ReferenceImportGrant = { grantId: request.grantId, operationKey: request.operationKey, runId: request.runId,
        projectId: this.options.projectId, revision: 1, action: 'reference-import-v1', manifestFingerprint: request.manifestFingerprint,
        requestHash: request.requestHash, state: 'active', decisionSource: 'author-action',
        createdAt: integer(request.createdAt ?? (this.options.now ?? Date.now)()), completedAt: null, revokedAt: null }
      const scope = this.binding(grant)
      if (scope.status === 'completed') fail('RUN_COMPLETED')
      if (this.db.prepare("SELECT 1 FROM reference_import_grants WHERE import_run_id=? AND state='active'").get(grant.runId)) fail('RUN_ALREADY_GRANTED')
      this.db.prepare(`INSERT INTO reference_import_grants
        (grant_id,operation_key,project_id,import_run_id,revision,action,manifest_fingerprint,request_hash,state,decision_source,created_at,completed_at,revoked_at)
        VALUES(?,?,?,?,1,'reference-import-v1',?,?,'active','author-action',?,NULL,NULL)`)
        .run(grant.grantId, grant.operationKey, grant.projectId, grant.runId, grant.manifestFingerprint, grant.requestHash, grant.createdAt)
      return grant
    })
  }

  private matching(ref: ReferenceImportGrantRef): ReferenceImportGrant {
    const grant = this.get(ref.grantId)
    if (!grant) fail('MISSING')
    this.mutable(grant)
    if (grant.runId !== ref.runId) fail('RUN_MISMATCH')
    return grant
  }

  assertActive(ref: ReferenceImportGrantRef): ReferenceImportGrant {
    assertReferenceImportGrantRef(ref)
    this.current()
    if (!this.db.inTransaction) fail('TRANSACTION_REQUIRED')
    const grant = this.matching(ref)
    if (grant.revision !== ref.revision) fail('REVISION_CONFLICT')
    if (grant.state !== 'active') fail('INACTIVE')
    if (this.binding(grant).status === 'completed') fail('RUN_COMPLETED')
    return grant
  }

  revoke(ref: ReferenceImportGrantRef): ReferenceImportGrant {
    assertReferenceImportGrantRef(ref)
    return this.transaction(() => {
      const grant = this.matching(ref)
      this.binding(grant)
      if (grant.state === 'revoked' && grant.revision === ref.revision + 1) return grant
      if (grant.revision !== ref.revision) fail('REVISION_CONFLICT')
      if (grant.state === 'completed') return grant
      if (grant.state !== 'active') fail('INACTIVE')
      const revokedAt = integer((this.options.now ?? Date.now)())
      const result = this.db.prepare(`UPDATE reference_import_grants SET state='revoked',revision=revision+1,revoked_at=?
        WHERE grant_id=? AND revision=? AND state='active'`).run(revokedAt, grant.grantId, ref.revision)
      if (result.changes !== 1) fail('REVISION_CONFLICT')
      return this.get(grant.grantId)!
    })
  }

  complete(ref: ReferenceImportGrantRef): ReferenceImportGrant {
    assertReferenceImportGrantRef(ref)
    return this.transaction(() => {
      const grant = this.matching(ref)
      if (grant.revision !== ref.revision) fail('REVISION_CONFLICT')
      const scope = this.binding(grant)
      if (grant.state === 'completed') return grant
      if (grant.state !== 'active') fail('INACTIVE')
      if (scope.status !== 'completed' || scope.stage !== 'completed') fail('RUN_NOT_COMPLETED')
      const completedAt = integer((this.options.now ?? Date.now)())
      const result = this.db.prepare(`UPDATE reference_import_grants SET state='completed',completed_at=?
        WHERE grant_id=? AND revision=? AND state='active'`).run(completedAt, grant.grantId, ref.revision)
      if (result.changes !== 1) fail('REVISION_CONFLICT')
      return this.get(grant.grantId)!
    })
  }
}

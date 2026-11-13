import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { captureReferenceImportResources, type ReferenceImportResources } from '../../knowledge-base'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { ReferenceEmbeddingBudgetRepository } from '../../repositories/reference-embedding-budget-repository'
import { ReferenceImportGrantRepository, type ReferenceImportGrant, type ReferenceImportGrantRef } from '../../repositories/reference-import-grant-repository'
import { chunkText } from '../../embedding'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { projectRuntimeHost, type ProjectRuntime } from '../project-runtime'
import { assertIssuedReferenceImportAdmission, captureReferenceImportAdmission } from '../reference-import-admission'
// @ts-expect-error The shared JavaScript fixture cleanup helper has no TypeScript declaration.
import { removeTemporaryTree } from '../../../test/helpers/remove-temporary-tree.mjs'

const parent = fs.realpathSync.native(os.tmpdir()), prefix = 'pk-reference-admission-'
const roots: string[] = [], runtimes: ProjectRuntime[] = [], handles: Database.Database[] = []
const disposers: Array<() => void> = []
const runId = 'fictional-reference-admission', requestHash = 'b'.repeat(64)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function verifiedCleanupRoots(targets: readonly string[]): string[] {
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const assertChild = (base: string, child: string) => {
    const relative = path.relative(base, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('FICTIONAL_ADMISSION_CLEANUP_OUTSIDE_PARENT')
    }
  }
  const resolved = targets.map(target => path.resolve(target))
  for (const root of resolved) {
    assertChild(parent, root)
    if (normalized(path.dirname(root)) !== normalized(parent) || !path.basename(root).startsWith(prefix)) {
      throw new Error('FICTIONAL_ADMISSION_CLEANUP_OUTSIDE_PARENT')
    }
    for (const directory of [parent, root]) {
      const info = fs.lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
        throw new Error('FICTIONAL_ADMISSION_CLEANUP_LINK')
      }
    }
    const pending = [root]
    while (pending.length) {
      const directory = pending.pop()!
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name), info = fs.lstatSync(target)
        if (info.isSymbolicLink() || normalized(fs.realpathSync.native(target)) !== normalized(target)) {
          throw new Error('FICTIONAL_ADMISSION_CLEANUP_LINK')
        }
        assertChild(root, fs.realpathSync.native(target))
        if (info.isDirectory()) pending.push(target)
      }
    }
  }
  return resolved
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dispose of disposers.splice(0).reverse()) dispose()
  for (const db of handles.splice(0)) if (db.open) db.close()
  for (const runtime of runtimes.splice(0).reverse()) if (runtime.phase === 'open') projectRuntimeHost.releaseIdle(runtime)
  const targets = verifiedCleanupRoots(roots)
  for (const root of targets) removeTemporaryTree(root, parent)
  roots.length = 0
})

function fixture(withBudget = false) {
  const root = fs.mkdtempSync(path.join(parent, prefix))
  roots.push(root)
  openCanonicalProjectFixture(root)
  const runtime = projectRuntimeHost.getActiveView()!
  runtimes.push(runtime)
  const content = 'A fictional reference courier waits beside the harbor.'
  ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash(`source:${content}`), locale: 'en-US',
    sourceDisplay: [{ displayName: 'Fictional reference.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'One', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }] })
  const resources = captureReferenceImportResources(runtime)
  const grants = new ReferenceImportGrantRepository(runtime.database, { projectId: runtime.projectId, context: runtime,
    assertCurrent: () => projectRuntimeHost.assertOpen(runtime),
    isFrozen: grantId => readPortableRuntimeFreeze(root).isFrozen('reference_import_grants', grantId) })
  const scope = ImportRunRepository.captureReferenceGrantScope(runId, runtime)
  const budgets = withBudget ? new ReferenceEmbeddingBudgetRepository(runtime.database, {
    assertCurrent: () => projectRuntimeHost.assertOpen(runtime),
    isFrozen: id => readPortableRuntimeFreeze(root).isFrozen('reference_embedding_budgets', id),
  }) : undefined
  budgets?.preflight(runId)
  const start = () => {
    const chunkSize = 100, chunkOverlap = 0, batchSize = 1
    const capability = budgets?.prepare({ runId, manifestFingerprint: scope.manifestFingerprint,
      plan: { chunkSize, chunkOverlap, batchSize,
        requestLimit: Math.ceil(chunkText(content, chunkSize, chunkOverlap).length / batchSize) } })
    const execution = ImportRunRepository.startOrResume(runId, 'fictional-owner', Date.now(), 60_000, runtime).execution
    const grant = grants.issue({ grantId: randomUUID(), operationKey: randomUUID(), runId,
      manifestFingerprint: scope.manifestFingerprint, requestHash })
    return { execution, grant, budget: budgets && capability ? { repository: budgets, capability } : undefined }
  }
  const { execution, grant, budget } = budgets ? runtime.database.transaction(start).immediate() : start()
  const ref: ReferenceImportGrantRef = { grantId: grant.grantId, revision: grant.revision, runId }
  runtime.database.exec('CREATE TEMP TABLE admission_effects(value TEXT NOT NULL)')
  return { root, runtime, resources, grants, grant, ref, execution, budget }
}

function freeze(book: ReturnType<typeof fixture>, table: 'reference_import_grants' | 'import_runs') {
  const recordId = table === 'reference_import_grants' ? book.grant.grantId : runId
  fs.writeFileSync(path.join(book.runtime.projectStorageRoot, 'portable-runtime-freeze.json'), JSON.stringify({ version: 1,
    originProjectId: '11111111-1111-4111-8111-111111111111', snapshotGeneration: 'fictional-admission-archive',
    nonReplayable: true, requiresRuntimeFreezeGuard: true, avatarReferenceProjections: [],
    records: [{ projectionId: `history:${table}:${recordId}`, table, recordId, terminalState: 'active', projection: {},
      projectionHash: 'd'.repeat(64), excludedFields: [], nonReplayable: true, originalReceiptVerified: false }] }))
}

describe('main-only reference import admission', () => {
  it('preflights the complete cleanup set and rejects outside roots and nested links', () => {
    expect(() => verifiedCleanupRoots([parent])).toThrow('CLEANUP_OUTSIDE_PARENT')
    expect(() => verifiedCleanupRoots([path.join(parent, 'unrelated-project')])).toThrow('CLEANUP_OUTSIDE_PARENT')
    const a = fixture(), b = fixture(), link = path.join(a.root, 'outside-link')
    fs.symlinkSync(b.root, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => verifiedCleanupRoots([b.root, a.root])).toThrow('CLEANUP_LINK')
      expect(fs.existsSync(b.root)).toBe(true)
      expect(fs.existsSync(a.root)).toBe(true)
    } finally { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link) }
  })

  it('captures an existing active grant without issuing work or changing persisted facts', () => {
    const a = fixture(), before = a.runtime.database.serialize()
    const admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    expect(() => assertIssuedReferenceImportAdmission(admission)).not.toThrow()
    expect(Object.isFrozen(admission)).toBe(true)
    expect(admission.bindingKey).toMatch(/^[a-f0-9]{64}$/u)
    expect(captureReferenceImportAdmission(a.runtime, a.ref, requestHash).bindingKey).toBe(admission.bindingKey)
    expect(() => admission.assertCurrent(a.resources, runId)).not.toThrow()
    expect(a.runtime.database.serialize()).toEqual(before)
    expect(a.grants.listByRun(runId)).toEqual([a.grant])
  })

  it.each(['outside', 'inside'] as const)('captures a budget-bound grant %s a native transaction', location => {
    const a = fixture(true), budget = a.budget!, database = a.runtime.database
    const before = database.serialize(), activeTransactions: boolean[] = []
    const original = ReferenceImportGrantRepository.prototype.assertActive
    vi.spyOn(ReferenceImportGrantRepository.prototype, 'assertActive').mockImplementation(function (this: ReferenceImportGrantRepository, ref) {
      activeTransactions.push(database.inTransaction)
      return original.call(this, ref)
    })
    const capture = () => captureReferenceImportAdmission(a.runtime, a.ref, requestHash, undefined, budget)
    const admission = location === 'inside' ? database.transaction(capture).immediate() : capture()
    expect(activeTransactions.length).toBeGreaterThan(0)
    expect(activeTransactions.every(Boolean)).toBe(true)
    expect(() => admission.assertCurrent(a.resources, runId)).not.toThrow()
    expect(() => admission.budget!.assertEffect()).not.toThrow()
    expect(database.serialize()).toEqual(before)
    expect(database.prepare('SELECT COUNT(*) FROM reference_embedding_dispatches').pluck().get()).toBe(0)
    expect(database.prepare('SELECT * FROM admission_effects').all()).toEqual([])
  })

  it.each(['runId', 'manifestFingerprint'] as const)('rejects a budget capability with a mismatched %s', field => {
    const a = fixture(true), budget = a.budget!, database = a.runtime.database
    const before = database.serialize(), activeTransactions: boolean[] = []
    const original = ReferenceImportGrantRepository.prototype.assertActive
    vi.spyOn(ReferenceImportGrantRepository.prototype, 'assertActive').mockImplementation(function (this: ReferenceImportGrantRepository, ref) {
      activeTransactions.push(database.inTransaction)
      return original.call(this, ref)
    })
    const capability = { ...budget.capability, [field]: field === 'runId' ? 'another-run' : hash('another-manifest') }
    expect(() => captureReferenceImportAdmission(a.runtime, a.ref, requestHash, undefined,
      { repository: budget.repository, capability })).toThrow('REFERENCE_IMPORT_ADMISSION_INVALID')
    expect(activeTransactions.length).toBeGreaterThan(0)
    expect(activeTransactions.every(Boolean)).toBe(true)
    expect(database.serialize()).toEqual(before)
    expect(database.prepare('SELECT COUNT(*) FROM reference_embedding_dispatches').pluck().get()).toBe(0)
    expect(database.prepare('SELECT * FROM admission_effects').all()).toEqual([])
  })

  it('still rejects a structurally identical forged budget capability at effect authorization', () => {
    const a = fixture(true), budget = a.budget!, before = a.runtime.database.serialize()
    const admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash, undefined,
      { repository: budget.repository, capability: { ...budget.capability } })
    expect(() => admission.budget!.assertEffect()).toThrow('KNOWLEDGE_BASE_REFERENCE_BUDGET_INVALID')
    expect(a.runtime.database.serialize()).toEqual(before)
    expect(a.runtime.database.prepare('SELECT COUNT(*) FROM reference_embedding_dispatches').pluck().get()).toBe(0)
  })

  it('rejects forged, spread, inherited and proxied admission objects', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    for (const value of [null, undefined, {}, { ...admission }, Object.create(admission), new Proxy(admission, {})]) {
      expect(() => assertIssuedReferenceImportAdmission(value)).toThrow('REFERENCE_IMPORT_ADMISSION_INVALID')
    }
  })

  it('uses a frozen copy of the ref and never substitutes active B for captured A', () => {
    const a = fixture(), ref = { ...a.ref }, admission = captureReferenceImportAdmission(a.runtime, ref, requestHash)
    const b = fixture(), beforeB = b.runtime.database.serialize()
    ref.grantId = b.grant.grantId; ref.runId = 'changed-run'; ref.revision = 999
    expect(projectRuntimeHost.getActiveView()).toBe(b.runtime)
    expect(() => admission.assertCurrent(a.resources, runId)).not.toThrow()
    expect(admission.withTransaction(a.resources, runId, () => {
      a.runtime.database.prepare('INSERT INTO admission_effects VALUES(?)').run('fictional A')
      return 'saved-A'
    })).toBe('saved-A')
    expect(a.runtime.database.prepare('SELECT value FROM admission_effects').pluck().all()).toEqual(['fictional A'])
    expect(b.runtime.database.serialize()).toEqual(beforeB)
  })

  it('requires a closed valid ref, actual registered runtime and exact stored request hash', () => {
    const a = fixture(), b = fixture()
    for (const ref of [{ ...a.ref, proof: true }, { ...a.ref, revision: 0 }, { ...a.ref, grantId: 'not-a-uuid' },
      { ...a.ref, runId: '../private' }]) {
      expect(() => captureReferenceImportAdmission(a.runtime, ref, requestHash)).toThrow('REFERENCE_IMPORT_GRANT_')
    }
    for (const value of ['', 'A'.repeat(64), null, { toString: () => requestHash }]) {
      expect(() => captureReferenceImportAdmission(a.runtime, a.ref, value as string)).toThrow('REQUEST_HASH_INVALID')
    }
    expect(() => captureReferenceImportAdmission({ ...a.runtime }, a.ref, requestHash)).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
    expect(() => captureReferenceImportAdmission(a.runtime, b.ref, requestHash)).toThrow('REFERENCE_IMPORT_GRANT_MISSING')
    expect(() => captureReferenceImportAdmission(a.runtime, { ...a.ref, revision: 2 }, requestHash)).toThrow('REVISION_CONFLICT')
    expect(() => captureReferenceImportAdmission(a.runtime, { ...a.ref, runId: 'other-run' }, requestHash)).toThrow('RUN_MISMATCH')
    expect(() => captureReferenceImportAdmission(a.runtime, a.ref, 'c'.repeat(64))).toThrow('REQUEST_MISMATCH')
  })

  it('rejects mismatched run, database, root, native identity and runtime epoch before callback effects', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash), b = fixture()
    const operation = vi.fn(() => 'not-authorized')
    for (const resources of [{ ...a.resources, database: b.runtime.database }, { ...a.resources, canonicalRoot: b.root },
      { ...a.resources, databaseIdentity: {} }, { ...a.resources, executionEpoch: 'another-epoch' }]) {
      expect(() => admission.assertCurrent(resources, runId)).toThrow('RESOURCES_CHANGED')
      expect(() => admission.withTransaction(resources, runId, operation)).toThrow('RESOURCES_CHANGED')
    }
    expect(() => admission.withTransaction(a.resources, 'other-run', operation)).toThrow('RUN_MISMATCH')
    expect(operation).not.toHaveBeenCalled()
  })

  it('requires the stored grant project and request binding on every later check', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    a.runtime.database.prepare('UPDATE reference_import_grants SET request_hash=? WHERE grant_id=?').run('c'.repeat(64), a.ref.grantId)
    expect(() => admission.assertCurrent(a.resources, runId)).toThrow('REQUEST_MISMATCH')
    a.runtime.database.prepare('UPDATE reference_import_grants SET request_hash=?,project_id=? WHERE grant_id=?')
      .run(requestHash, randomUUID(), a.ref.grantId)
    expect(() => admission.assertCurrent(a.resources, runId)).toThrow('PROJECT_MISMATCH')
  })

  it('denies revoked grants both before capture and after a successful captured check', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    admission.assertCurrent(a.resources, runId)
    a.grants.revoke(a.ref)
    expect(() => captureReferenceImportAdmission(a.runtime, a.ref, requestHash)).toThrow('REVISION_CONFLICT')
    expect(() => admission.assertCurrent(a.resources, runId)).toThrow('REVISION_CONFLICT')
    const operation = vi.fn(() => 'not-authorized')
    expect(() => admission.withTransaction(a.resources, runId, operation)).toThrow('REVISION_CONFLICT')
    expect(operation).not.toHaveBeenCalled()
  })

  it('denies a locally retired issuance even when the durable grant remains active', () => {
    const a = fixture()
    let retired = false
    const assertLocal = () => { if (retired) throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED') }
    const admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash, assertLocal)
    expect(() => assertIssuedReferenceImportAdmission(admission)).not.toThrow()
    admission.assertCurrent(a.resources, runId)
    retired = true
    expect(a.grants.get(a.ref.grantId)?.state).toBe('active')
    expect(() => admission.assertCurrent(a.resources, runId)).toThrow('CAPABILITY_REQUIRED')
    const operation = vi.fn(() => a.runtime.database.prepare('INSERT INTO admission_effects VALUES(?)').run('forbidden'))
    expect(() => admission.withTransaction(a.resources, runId, operation)).toThrow('CAPABILITY_REQUIRED')
    expect(operation).not.toHaveBeenCalled()
    expect(a.runtime.database.prepare('SELECT COUNT(*) FROM admission_effects').pluck().get()).toBe(0)
  })

  it('rolls back an effect if the local issuance retires during that transaction', () => {
    const a = fixture()
    let retired = false
    const admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash, () => {
      if (retired) throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    })
    expect(() => admission.withTransaction(a.resources, runId, () => {
      a.runtime.database.prepare('INSERT INTO admission_effects VALUES(?)').run('must roll back')
      retired = true
    })).toThrow('CAPABILITY_REQUIRED')
    expect(a.grants.get(a.ref.grantId)?.state).toBe('active')
    expect(a.runtime.database.prepare('SELECT COUNT(*) FROM admission_effects').pluck().get()).toBe(0)
  })

  it('rejects asynchronous local guards at capture and at a later grant check', () => {
    const a = fixture()
    expect(() => captureReferenceImportAdmission(a.runtime, a.ref, requestHash, async () => {})).toThrow('ASYNC_GUARD_INVALID')
    let asynchronous = false
    const admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash, () => {
      if (asynchronous) return Promise.resolve()
    })
    asynchronous = true
    expect(() => admission.assertCurrent(a.resources, runId)).toThrow('ASYNC_GUARD_INVALID')
    const operation = vi.fn(() => 'forbidden')
    expect(() => admission.withTransaction(a.resources, runId, operation)).toThrow('ASYNC_GUARD_INVALID')
    expect(operation).not.toHaveBeenCalled()
  })

  it.each(['reference_import_grants', 'import_runs'] as const)('denies portable frozen %s at capture and recheck', table => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    freeze(a, table)
    expect(() => captureReferenceImportAdmission(a.runtime, a.ref, requestHash)).toThrow(/FROZEN/u)
    expect(() => admission.assertCurrent(a.resources, runId)).toThrow(/FROZEN/u)
    const operation = vi.fn(() => 'not-authorized')
    expect(() => admission.withTransaction(a.resources, runId, operation)).toThrow(/FROZEN/u)
    expect(operation).not.toHaveBeenCalled()
  })

  it('changes the flight binding for a genuinely new grant without rescuing the old admission', () => {
    const a = fixture(), old = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    a.grants.revoke(a.ref)
    const grant = a.grants.issue({ grantId: randomUUID(), operationKey: randomUUID(), runId,
      manifestFingerprint: a.grant.manifestFingerprint!, requestHash: 'c'.repeat(64) })
    const fresh = captureReferenceImportAdmission(a.runtime, { grantId: grant.grantId, revision: grant.revision, runId }, 'c'.repeat(64))
    expect(fresh.bindingKey).not.toBe(old.bindingKey)
    expect(() => old.assertCurrent(a.resources, runId)).toThrow('REVISION_CONFLICT')
    expect(() => fresh.assertCurrent(a.resources, runId)).not.toThrow()
  })

  it('uses one immediate native transaction for the grant, existing source check and write', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    const competitor = new Database(path.join(a.runtime.projectStorageRoot, 'project.db'))
    handles.push(competitor)
    competitor.pragma('busy_timeout=0')
    const original = ReferenceImportGrantRepository.prototype.assertActive
    const observed: boolean[] = []
    vi.spyOn(ReferenceImportGrantRepository.prototype, 'assertActive').mockImplementation(function (this: ReferenceImportGrantRepository, ref) {
      observed.push(a.runtime.database.inTransaction)
      return original.call(this, ref)
    })
    expect(admission.withTransaction(a.resources, runId, () => {
      expect(a.runtime.database.inTransaction).toBe(true)
      expect(() => competitor.prepare("UPDATE project_core SET core_outline=core_outline WHERE id='main'").run()).toThrow(/locked|SQLITE_BUSY/iu)
      const binding = ImportRunRepository.resolveReferenceImportAuthority(runId, a.execution, 1, undefined, a.runtime.database)
      a.runtime.database.prepare('INSERT INTO admission_effects VALUES(?)').run(binding.stableKey)
      return binding.content
    })).toBe('A fictional reference courier waits beside the harbor.')
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every(Boolean)).toBe(true)
    expect(a.runtime.database.inTransaction).toBe(false)
    expect(a.runtime.database.prepare('SELECT COUNT(*) FROM admission_effects').pluck().get()).toBe(1)
  })

  it('reuses an existing transaction for guards but nests effect calls and rolls back failed source checks', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    const transaction = vi.spyOn(a.runtime.database, 'transaction')
    a.runtime.database.transaction(() => {
      transaction.mockClear()
      admission.assertCurrent(a.resources, runId)
      expect(transaction).not.toHaveBeenCalled()
      expect(admission.withTransaction(a.resources, runId, () => 17)).toBe(17)
      expect(transaction).toHaveBeenCalledTimes(1)
    }).immediate()
    expect(() => admission.withTransaction(a.resources, runId, () => {
      a.runtime.database.prepare('INSERT INTO admission_effects VALUES(?)').run('must roll back')
      ImportRunRepository.resolveReferenceImportAuthority(runId, { ...a.execution, owner: 'wrong-owner' }, 1, undefined, a.runtime.database)
    })).toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(a.runtime.database.prepare('SELECT * FROM admission_effects').all()).toEqual([])
  })

  it('does not commit a synchronous effect after its operation revokes the captured grant', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    expect(() => admission.withTransaction(a.resources, runId, () => {
      a.grants.revoke(a.ref)
      a.runtime.database.prepare('INSERT INTO admission_effects VALUES(?)').run('revoked write')
    })).toThrow('REVISION_CONFLICT')
    expect(a.runtime.database.prepare('SELECT * FROM admission_effects').all()).toEqual([])
    expect(a.grants.get(a.ref.grantId)).toMatchObject({ state: 'active', revision: 1 })
  })

  it.each(['thenable', 'revocation'] as const)('rolls back nested %s effects even when the outer transaction catches and commits', failure => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    a.runtime.database.transaction(() => {
      a.runtime.database.prepare('INSERT INTO admission_effects VALUES(?)').run('unrelated outer effect')
      expect(() => admission.withTransaction(a.resources, runId, () => {
        a.runtime.database.prepare('INSERT INTO admission_effects VALUES(?)').run('rejected admission effect')
        if (failure === 'revocation') a.grants.revoke(a.ref)
        else return { then: () => {} }
      })).toThrow(failure === 'revocation' ? 'REVISION_CONFLICT' : 'ASYNC_GUARD_INVALID')
      expect(a.runtime.database.inTransaction).toBe(true)
    }).immediate()
    expect(a.runtime.database.prepare('SELECT value FROM admission_effects').pluck().all()).toEqual(['unrelated outer effect'])
    expect(a.grants.get(a.ref.grantId)).toMatchObject({ state: 'active', revision: 1 })
  })

  it('rejects async and non-void resource guards without treating them as successful authority', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    for (const guard of [async () => {}, () => Promise.resolve(), () => ({ then: () => {} }), () => true]) {
      const resources = { ...a.resources, assertResources: guard } as ReferenceImportResources
      expect(() => admission.assertCurrent(resources, runId)).toThrow('ASYNC_GUARD_INVALID')
    }
  })

  it('does not count a thenable with grant-shaped properties as a repository authorization', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    const thenable = { ...a.grant, then: () => {} } as unknown as ReferenceImportGrant
    vi.spyOn(ReferenceImportGrantRepository.prototype, 'assertActive').mockReturnValue(thenable)
    expect(() => admission.assertCurrent(a.resources, runId)).toThrow('ASYNC_GUARD_INVALID')
    expect(() => captureReferenceImportAdmission(a.runtime, a.ref, requestHash)).toThrow('ASYNC_GUARD_INVALID')
  })

  it('rejects async transaction callbacks and rolls back sync callbacks that return promises or thenables', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    let asyncStarted = false
    expect(() => admission.withTransaction(a.resources, runId, async () => { asyncStarted = true })).toThrow('ASYNC_GUARD_INVALID')
    expect(asyncStarted).toBe(false)
    for (const result of [Promise.resolve('not-synchronous'), { then: () => {} }]) {
      expect(() => admission.withTransaction(a.resources, runId, () => {
        a.runtime.database.prepare('INSERT INTO admission_effects VALUES(?)').run('must roll back')
        return result
      })).toThrow('ASYNC_GUARD_INVALID')
    }
    expect(a.runtime.database.inTransaction).toBe(false)
    expect(a.runtime.database.prepare('SELECT * FROM admission_effects').all()).toEqual([])
  })

  it('denies new capture during maintenance but preserves already captured resource liveness', () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    const maintenance = projectRuntimeHost.acquireMaintenance(a.runtime, 'backup')
    disposers.push(() => maintenance.release())
    expect(() => captureReferenceImportAdmission(a.runtime, a.ref, requestHash)).toThrow('MAINTENANCE_BUSY')
    expect(() => admission.assertCurrent(a.resources, runId)).not.toThrow()
  })

  it('allows admitted checks while physical work drains but refuses new capture and stale native handles', async () => {
    const a = fixture(), admission = captureReferenceImportAdmission(a.runtime, a.ref, requestHash)
    const release = a.resources.acquireWork()
    const closing = projectRuntimeHost.requestClose(a.runtime)
    try {
      expect(() => captureReferenceImportAdmission(a.runtime, a.ref, requestHash)).toThrow('CLOSE_REQUESTED')
      expect(() => admission.assertCurrent(a.resources, runId)).not.toThrow()
    } finally { release(); await closing }
    expect(() => admission.assertCurrent(a.resources, runId)).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
    openCanonicalProjectFixture(a.root)
    const reopened = projectRuntimeHost.getActiveView()!
    runtimes.push(reopened)
    expect(reopened.executionEpoch).not.toBe(a.runtime.executionEpoch)
    expect(() => admission.assertCurrent(captureReferenceImportResources(reopened), runId)).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
  })
})

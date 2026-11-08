import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBaselineTables } from '../../migrations/baseline-schema'
import { applyM14ReferenceImportGrants } from '../../migrations/m14-reference-import-grants'
import { readPortableRuntimeFreeze } from '../../services/portable-runtime-freeze'
import { ReferenceImportGrantRepository, type IssueReferenceImportGrant, type ReferenceImportGrant,
  type ReferenceImportGrantRef } from '../reference-import-grant-repository'
// @ts-expect-error The shared JavaScript fixture cleanup helper has no TypeScript declaration.
import { removeTemporaryTree } from '../../../test/helpers/remove-temporary-tree.mjs'

const handles: Database.Database[] = [], roots: string[] = []
const temporaryParent = fs.realpathSync.native(os.tmpdir())
const temporaryPrefix = 'pagekin-reference-grant-'
const manifest = 'a'.repeat(64), requestHash = 'b'.repeat(64)

function verifiedCleanupRoots(targets: readonly string[]): string[] {
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const assertChild = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('FICTIONAL_GRANT_CLEANUP_OUTSIDE_PARENT')
    }
  }
  const resolved = targets.map(target => path.resolve(target))
  for (const root of resolved) {
    assertChild(temporaryParent, root)
    if (normalized(path.dirname(root)) !== normalized(temporaryParent) || !path.basename(root).startsWith(temporaryPrefix)) {
      throw new Error('FICTIONAL_GRANT_CLEANUP_OUTSIDE_PARENT')
    }
    for (const directory of [temporaryParent, root]) {
      const info = fs.lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
        throw new Error('FICTIONAL_GRANT_CLEANUP_LINK')
      }
    }
    const pending = [root]
    while (pending.length) {
      const directory = pending.pop()!
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        const info = fs.lstatSync(target)
        if (info.isSymbolicLink()) throw new Error('FICTIONAL_GRANT_CLEANUP_LINK')
        const realTarget = fs.realpathSync.native(target)
        if (normalized(realTarget) !== normalized(target)) throw new Error('FICTIONAL_GRANT_CLEANUP_LINK')
        assertChild(root, realTarget)
        if (info.isDirectory()) pending.push(target)
      }
    }
  }
  return resolved
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of handles.splice(0)) if (db.open) db.close()
  const targets = verifiedCleanupRoots(roots)
  for (const root of targets) removeTemporaryTree(root, temporaryParent)
  roots.length = 0
})

function fixture(projectId = 'project-A') {
  const db = new Database(':memory:')
  handles.push(db)
  const root = fs.mkdtempSync(path.join(temporaryParent, temporaryPrefix))
  roots.push(root)
  fs.mkdirSync(path.join(root, '.ai-novel'))
  db.pragma('foreign_keys=ON')
  applyBaselineTables(db)
  db.transaction(() => applyM14ReferenceImportGrants(db))()
  db.exec("INSERT INTO project_core(id,project_name,premise) VALUES('main','Fictional grant book','Author F0')")
  db.exec('CREATE TABLE fictional_effects(id TEXT PRIMARY KEY,body TEXT NOT NULL)')
  db.prepare(`INSERT INTO import_runs
    (id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count)
    VALUES('import-A','import-A','import:reference:import-A',?,?,'en-US',1,1)`).run('c'.repeat(64), manifest)
  const context = { projectId, database: db, canonicalRoot: root }
  const assertCurrent = vi.fn(() => {})
  const options = { projectId, context, assertCurrent,
    isFrozen: (grantId: string) => readPortableRuntimeFreeze(root).isFrozen('reference_import_grants', grantId), now: () => 1000 }
  const grants = new ReferenceImportGrantRepository(db, options)
  return { db, root, projectId, context, assertCurrent, options, grants }
}

function issueRequest(change: Partial<IssueReferenceImportGrant> = {}): IssueReferenceImportGrant {
  return { grantId: randomUUID(), operationKey: randomUUID(), runId: 'import-A', manifestFingerprint: manifest, requestHash, ...change }
}

function ref(grant: ReferenceImportGrant): ReferenceImportGrantRef {
  return { grantId: grant.grantId, revision: grant.revision, runId: grant.runId }
}

function completedImport(f: ReturnType<typeof fixture>) {
  f.db.prepare("UPDATE import_runs SET status='completed',stage='completed',completed_at='2026-11-08 00:00:00' WHERE id='import-A'").run()
}

function freeze(f: ReturnType<typeof fixture>, grant: ReferenceImportGrant, includeImport = true) {
  const history = (table: string, recordId: string) => ({ projectionId: `history:${table}:${recordId}`, table, recordId,
    terminalState: 'active', projection: {}, projectionHash: 'd'.repeat(64), excludedFields: [], nonReplayable: true, originalReceiptVerified: false })
  fs.writeFileSync(path.join(f.root, '.ai-novel', 'portable-runtime-freeze.json'), JSON.stringify({ version: 1,
    originProjectId: '11111111-1111-4111-8111-111111111111', snapshotGeneration: 'fictional-generation-1',
    nonReplayable: true, requiresRuntimeFreezeGuard: true, avatarReferenceProjections: [],
    records: [history('reference_import_grants', grant.grantId), ...(includeImport ? [history('import_runs', grant.runId)] : [])] }))
}

describe('reference import grant captured repository', () => {
  it('rejects cleanup targets outside the captured temporary parent or without the fixture prefix', () => {
    expect(() => verifiedCleanupRoots([temporaryParent])).toThrow('CLEANUP_OUTSIDE_PARENT')
    expect(() => verifiedCleanupRoots([path.resolve(temporaryParent, '..', 'not-a-grant-fixture')])).toThrow('CLEANUP_OUTSIDE_PARENT')
    expect(() => verifiedCleanupRoots([path.join(temporaryParent, 'unrelated-fixture')])).toThrow('CLEANUP_OUTSIDE_PARENT')
  })

  it('preflights the whole cleanup set and refuses a nested symlink or junction without touching its target', () => {
    const first = fixture(), second = fixture(), outside = fixture()
    const link = path.join(second.root, '.ai-novel', 'linked-outside')
    const kept = path.join(outside.root, 'kept.txt')
    fs.writeFileSync(kept, 'fictional cleanup boundary')
    fs.symlinkSync(outside.root, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => verifiedCleanupRoots([first.root, second.root])).toThrow('CLEANUP_LINK')
      expect(fs.existsSync(first.root)).toBe(true)
      expect(fs.readFileSync(kept, 'utf8')).toBe('fictional cleanup boundary')
    } finally {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link)
    }
  })

  it('issues and reads exact explicit authorization without changing import, author facts or receipts', () => {
    const f = fixture(), request = issueRequest(), before = f.db.prepare('SELECT * FROM import_runs').all()
    const grant = f.grants.issue(request)
    expect(grant).toEqual({ ...request, projectId: f.projectId, action: 'reference-import-v1', revision: 1, state: 'active',
      decisionSource: 'author-action', createdAt: 1000, completedAt: null, revokedAt: null })
    expect(f.grants.get(grant.grantId)).toEqual(grant)
    expect(f.grants.getByOperation(request.operationKey)).toEqual(grant)
    expect(f.grants.listByRun(request.runId)).toEqual([grant])
    expect(f.grants.issue(request)).toEqual(grant)
    expect(f.db.prepare('SELECT * FROM import_runs').all()).toEqual(before)
    expect(f.db.prepare('SELECT * FROM import_run_receipts').all()).toEqual([])
    expect(f.db.prepare('SELECT premise FROM project_core').pluck().get()).toBe('Author F0')
  })

  it.each(['grantId', 'runId', 'requestHash', 'manifestFingerprint', 'createdAt'] as const)('rejects same operation key with changed %s', field => {
    const f = fixture(), request = issueRequest(), grant = f.grants.issue(request)
    const changed = field === 'grantId' ? randomUUID() : field === 'createdAt' ? 1001 : field === 'runId' ? 'import-B' : 'e'.repeat(64)
    expect(() => f.grants.issue({ ...request, [field]: changed })).toThrow('IDEMPOTENCY_CONFLICT')
    expect(f.grants.get(grant.grantId)).toEqual(grant)
  })

  it('requires a fresh explicit key and grant after revocation, keeps old replay revoked, and permits only one active per run', () => {
    const f = fixture(), request = issueRequest(), first = f.grants.issue(request)
    expect(() => f.grants.issue(issueRequest())).toThrow('RUN_ALREADY_GRANTED')
    const before = f.db.prepare('SELECT * FROM import_runs').all()
    const revoked = f.grants.revoke(ref(first))
    expect(revoked).toEqual({ ...first, state: 'revoked', revision: 2, revokedAt: 1000 })
    expect(f.grants.revoke(ref(first))).toEqual(revoked)
    expect(f.grants.issue(request)).toEqual(revoked)
    expect(() => f.grants.issue({ ...issueRequest(), grantId: first.grantId })).toThrow('IDEMPOTENCY_CONFLICT')
    const second = f.grants.issue(issueRequest())
    expect(second.state).toBe('active')
    expect(f.grants.listByRun(first.runId)).toHaveLength(2)
    expect(f.grants.get(first.grantId)).toEqual(revoked)
    expect(f.db.prepare('SELECT * FROM import_runs').all()).toEqual(before)
  })

  it('requires the same native transaction, exact revision and exact run at dispatch and effect admission', () => {
    const f = fixture(), other = fixture('project-B'), grant = f.grants.issue(issueRequest())
    expect(() => f.grants.assertActive(ref(grant))).toThrow('TRANSACTION_REQUIRED')
    expect(() => other.db.transaction(() => f.grants.assertActive(ref(grant)))()).toThrow('TRANSACTION_REQUIRED')
    expect(() => f.db.transaction(() => f.grants.assertActive({ ...ref(grant), revision: 2 }))()).toThrow('REVISION_CONFLICT')
    expect(() => f.db.transaction(() => f.grants.assertActive({ ...ref(grant), runId: 'import-B' }))()).toThrow('RUN_MISMATCH')
    expect(f.db.transaction(() => f.grants.assertActive(ref(grant)))()).toEqual(grant)
    expect(() => f.grants.revoke({ ...ref(grant), revision: 2 })).toThrow('REVISION_CONFLICT')
    expect(() => f.grants.complete({ ...ref(grant), revision: 2 })).toThrow('REVISION_CONFLICT')
  })

  it('preserves an effect that commits before revoke and denies a new effect when revoke wins first', () => {
    const f = fixture(), grant = f.grants.issue(issueRequest())
    const effect = (id: string) => f.db.transaction(() => {
      f.grants.assertActive(ref(grant))
      f.db.prepare('INSERT INTO fictional_effects VALUES(?,?)').run(id, 'fictional durable effect')
    })()
    effect('before-revoke')
    f.grants.revoke(ref(grant))
    expect(() => effect('after-revoke')).toThrow('REVISION_CONFLICT')
    expect(f.db.prepare('SELECT id FROM fictional_effects').pluck().all()).toEqual(['before-revoke'])
  })

  it('rolls back revoke in the caller transaction rather than leaving authority and effects out of order', () => {
    const f = fixture(), grant = f.grants.issue(issueRequest())
    expect(() => f.db.transaction(() => { f.grants.revoke(ref(grant)); throw new Error('fictional transaction abort') })()).toThrow('fictional transaction abort')
    expect(f.grants.get(grant.grantId)).toEqual(grant)
    expect(f.db.transaction(() => f.grants.assertActive(ref(grant)))()).toEqual(grant)
  })

  it('completes only against the actual completed import and never fabricates an import completion receipt', () => {
    const f = fixture(), request = issueRequest(), grant = f.grants.issue(request)
    expect(() => f.grants.complete(ref(grant))).toThrow('RUN_NOT_COMPLETED')
    expect(f.grants.get(grant.grantId)).toEqual(grant)
    completedImport(f)
    const before = f.db.prepare('SELECT * FROM import_runs').all()
    expect(() => f.db.transaction(() => f.grants.assertActive(ref(grant)))()).toThrow('RUN_COMPLETED')
    const completed = f.grants.complete(ref(grant))
    expect(completed).toEqual({ ...grant, state: 'completed', completedAt: 1000 })
    expect(f.grants.complete(ref(grant))).toEqual(completed)
    expect(f.grants.revoke(ref(grant))).toEqual(completed)
    expect(f.grants.issue(request)).toEqual(completed)
    expect(() => f.grants.issue(issueRequest())).toThrow('RUN_COMPLETED')
    expect(f.db.prepare('SELECT * FROM import_runs').all()).toEqual(before)
    expect(f.db.prepare('SELECT * FROM import_run_receipts').all()).toEqual([])
    expect(() => f.db.transaction(() => f.grants.assertActive(ref(completed)))()).toThrow('INACTIVE')
  })

  it('cannot complete a revoked grant even when its import has completed', () => {
    const f = fixture(), grant = f.grants.issue(issueRequest()), revoked = f.grants.revoke(ref(grant))
    completedImport(f)
    expect(() => f.grants.complete(ref(revoked))).toThrow('INACTIVE')
    expect(f.grants.get(grant.grantId)).toEqual(revoked)
  })

  it('rolls back failed completion without mutating existing completed import facts', () => {
    const f = fixture(), grant = f.grants.issue(issueRequest())
    completedImport(f)
    const before = f.db.prepare('SELECT * FROM import_runs').all()
    f.db.exec(`CREATE TEMP TRIGGER fictional_grant_completion_failure BEFORE UPDATE OF state ON reference_import_grants
      WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fictional completion failure'); END`)
    expect(() => f.grants.complete(ref(grant))).toThrow('fictional completion failure')
    expect(f.grants.get(grant.grantId)).toEqual(grant)
    expect(f.db.prepare('SELECT * FROM import_runs').all()).toEqual(before)
  })

  it.each([
    "purpose='author-manuscript'", "stage='parsing'", "manifest_fingerprint=''", "stage='completed'", "status='completed'",
  ])('refuses missing, unprepared or nonreference import scope: %s', assignment => {
    const f = fixture()
    f.db.prepare(`UPDATE import_runs SET ${assignment} WHERE id='import-A'`).run()
    expect(() => f.grants.issue(issueRequest())).toThrow('IMPORT_RUN_')
    expect(f.grants.listByRun('import-A')).toEqual([])
  })

  it('binds the exact persisted manifest and refuses changed scope on later admission or mutation', () => {
    const f = fixture()
    expect(() => f.grants.issue(issueRequest({ runId: 'missing-run' }))).toThrow('IMPORT_RUN_NOT_FOUND')
    expect(() => f.grants.issue(issueRequest({ manifestFingerprint: 'e'.repeat(64) }))).toThrow('SCOPE_MISMATCH')
    const request = issueRequest(), grant = f.grants.issue(request)
    f.db.prepare("UPDATE import_runs SET manifest_fingerprint=? WHERE id='import-A'").run('e'.repeat(64))
    expect(() => f.db.transaction(() => f.grants.assertActive(ref(grant)))()).toThrow('SCOPE_MISMATCH')
    expect(() => f.grants.issue(request)).toThrow('SCOPE_MISMATCH')
    expect(() => f.grants.complete(ref(grant))).toThrow('SCOPE_MISMATCH')
    expect(() => f.grants.revoke(ref(grant))).toThrow('SCOPE_MISMATCH')
  })

  it('rejects captured database/project mismatch, cross-project grant rows and changed current-resource guards', () => {
    const f = fixture(), other = fixture('project-B'), grant = f.grants.issue(issueRequest())
    const crossDb = new ReferenceImportGrantRepository(f.db, { ...f.options, context: other.context })
    expect(() => crossDb.get(grant.grantId)).toThrow('DATABASE_MISMATCH')
    const crossProject = new ReferenceImportGrantRepository(f.db, { ...f.options, projectId: 'project-B' })
    expect(() => crossProject.get(grant.grantId)).toThrow('DATABASE_MISMATCH')
    expect(other.grants.get(grant.grantId)).toBe(null)
    f.db.prepare('UPDATE reference_import_grants SET project_id=? WHERE grant_id=?').run('foreign-project', grant.grantId)
    expect(() => f.grants.get(grant.grantId)).toThrow('PROJECT_MISMATCH')
    f.db.prepare('UPDATE reference_import_grants SET project_id=? WHERE grant_id=?').run(f.projectId, grant.grantId)
    f.assertCurrent.mockImplementation(() => { throw new Error('fictional resource fence changed') })
    expect(() => f.grants.get(grant.grantId)).toThrow('fictional resource fence changed')
    expect(() => f.grants.revoke(ref(grant))).toThrow('fictional resource fence changed')
  })

  it('reads portable NULL-hash old-project history only under its real freeze guard and refuses all mutations', () => {
    const f = fixture(), request = issueRequest(), grant = f.grants.issue(request)
    freeze(f, grant)
    f.db.prepare(`UPDATE reference_import_grants SET project_id='original-project',operation_key=?,manifest_fingerprint=NULL,request_hash=NULL WHERE grant_id=?`)
      .run(`history:reference-import:${grant.grantId}`, grant.grantId)
    const history = f.grants.get(grant.grantId)!
    expect(history).toMatchObject({ projectId: 'original-project', manifestFingerprint: null, requestHash: null, state: 'active' })
    expect(f.grants.getByOperation(history.operationKey)).toEqual(history)
    expect(f.grants.listByRun(grant.runId)).toEqual([history])
    expect(() => f.db.transaction(() => f.grants.assertActive(ref(history)))()).toThrow('HISTORY_FROZEN')
    expect(() => f.grants.revoke(ref(history))).toThrow('HISTORY_FROZEN')
    expect(() => f.grants.complete(ref(history))).toThrow('HISTORY_FROZEN')
    expect(() => f.grants.issue(request)).toThrow('HISTORY_FROZEN')
    expect(() => f.grants.issue(issueRequest())).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(f.grants.get(grant.grantId)).toEqual(history)
  })

  it('also refuses frozen hash-bearing history and a frozen source whose grant is not listed in history', () => {
    const f = fixture(), grant = f.grants.issue(issueRequest())
    freeze(f, grant)
    expect(f.grants.get(grant.grantId)).toEqual(grant)
    expect(() => f.grants.revoke(ref(grant))).toThrow('HISTORY_FROZEN')
    expect(() => f.db.transaction(() => f.grants.assertActive(ref(grant)))()).toThrow('HISTORY_FROZEN')
    const document = JSON.parse(fs.readFileSync(path.join(f.root, '.ai-novel', 'portable-runtime-freeze.json'), 'utf8'))
    document.records = document.records.filter((row: { table: string }) => row.table === 'import_runs')
    fs.writeFileSync(path.join(f.root, '.ai-novel', 'portable-runtime-freeze.json'), JSON.stringify(document))
    expect(() => f.db.transaction(() => f.grants.assertActive(ref(grant)))()).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(() => f.grants.revoke(ref(grant))).toThrow('PORTABLE_RUNTIME_FROZEN')
  })

  it('never interprets NULL hashes or missing history sidecars as authority, including a same-project row', () => {
    const f = fixture(), grant = f.grants.issue(issueRequest())
    f.db.prepare('UPDATE reference_import_grants SET manifest_fingerprint=NULL,request_hash=NULL WHERE grant_id=?').run(grant.grantId)
    expect(() => f.grants.get(grant.grantId)).toThrow('HISTORY_FROZEN')
    expect(() => f.grants.revoke(ref(grant))).toThrow('HISTORY_FROZEN')
    expect(() => f.grants.complete(ref(grant))).toThrow('HISTORY_FROZEN')
    expect(() => f.db.transaction(() => f.grants.assertActive(ref(grant)))()).toThrow('HISTORY_FROZEN')
    freeze(f, grant)
    expect(f.grants.get(grant.grantId)?.requestHash).toBe(null)
    fs.rmSync(path.join(f.root, '.ai-novel', 'portable-runtime-freeze.json'))
    expect(() => f.grants.get(grant.grantId)).toThrow('HISTORY_FROZEN')
  })

  it('repository reconstruction reads existing grant without issuing a capability or changing import execution', () => {
    const f = fixture(), grant = f.grants.issue(issueRequest()), before = f.db.prepare('SELECT * FROM import_runs').all()
    const reconstructed = new ReferenceImportGrantRepository(f.db, f.options)
    expect(reconstructed.get(grant.grantId)).toEqual(grant)
    expect(f.db.prepare('SELECT * FROM import_runs').all()).toEqual(before)
    expect(f.db.prepare('SELECT * FROM fictional_effects').all()).toEqual([])
    expect(() => reconstructed.assertActive(ref(grant))).toThrow('TRANSACTION_REQUIRED')
  })

  it('rejects Promise-returning guards and closed native databases', () => {
    const f = fixture(), request = issueRequest()
    f.assertCurrent.mockImplementation((() => Promise.resolve()) as never)
    expect(() => f.grants.issue(request)).toThrow('ASYNC_GUARD_INVALID')
    f.assertCurrent.mockImplementation(() => {})
    const asynchronous = new ReferenceImportGrantRepository(f.db, { ...f.options, isFrozen: (() => Promise.resolve(false)) as never })
    expect(() => asynchronous.issue(request)).toThrow('ASYNC_GUARD_INVALID')
    expect(f.grants.listByRun(request.runId)).toEqual([])
    f.db.close()
    expect(() => f.grants.issue(request)).toThrow('DATABASE_NOT_READY')
  })
})

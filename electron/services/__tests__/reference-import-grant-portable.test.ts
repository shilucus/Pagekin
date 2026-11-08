import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema, verifySchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { ReferenceImportGrantRepository } from '../../repositories/reference-import-grant-repository'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { exportPortableProject, sanitizePortableDatabase } from '../project-archive-service'
import { writePortableProjectArchive } from '../portable-project-archive'
import type { PortableProjectManifestEntry } from '../portable-project-format'
import { restorePortableProject } from '../project-restore-service'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { readPortableCurrentAuthority } from '../portable-current-authority'
import { createPortableTransferAuthority, serializePortableTransferAuthority } from '../portable-transfer-authority'
import { probeProjectSqlite } from '../sqlite-project-migration'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: Array<{ root: string; parent: string }> = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function verifiedCleanupRoot(root: string, parent: string): string {
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const assertChild = (base: string, child: string) => {
    const relative = path.relative(base, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
    }
  }
  const absolute = path.resolve(root)
  assertChild(parent, absolute)
  if (normalized(path.dirname(absolute)) !== normalized(parent)
    || !path.basename(absolute).startsWith('reference-grant-portable-')) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
  for (let directory = absolute; ; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
      throw new Error('FICTIONAL_CLEANUP_LINK')
    }
    if (normalized(directory) === normalized(parent)) break
  }
  const realRoot = fs.realpathSync.native(absolute)
  assertChild(fs.realpathSync.native(parent), realRoot)
  const pending = [absolute]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name), stat = fs.lstatSync(target)
      if (stat.isSymbolicLink()) throw new Error('FICTIONAL_CLEANUP_LINK')
      const realTarget = fs.realpathSync.native(target)
      if (normalized(realTarget) !== normalized(target)) throw new Error('FICTIONAL_CLEANUP_LINK')
      assertChild(realRoot, realTarget)
      if (stat.isDirectory()) pending.push(target)
    }
  }
  return absolute
}

afterEach(() => {
  closeProjectDatabase()
  for (const { root, parent } of roots.splice(0)) fs.rmSync(verifiedCleanupRoot(root, parent), { recursive: true, force: true })
})

function fixture() {
  const parent = fs.realpathSync.native(os.tmpdir())
  const base = fs.mkdtempSync(path.join(parent, 'reference-grant-portable-'))
  roots.push({ root: base, parent })
  const root = path.join(base, 'source'), projectId = randomUUID()
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-11-07T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  initProjectDatabase(root)
  getProjectDb()!.prepare("INSERT INTO project_core(id,core_outline) VALUES('main','Author outline')").run()
  return { base, root, projectId, databasePath: path.join(root, '.ai-novel', 'project.db') }
}

describe('reference import grant portable history', () => {
  it('preserves nonreplayable history and excludes machine authority through two generations', async () => {
    const f = fixture(), db = getProjectDb()!
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const runs = [randomUUID(), randomUUID(), randomUUID()]
    const operationKeys = ['private-reference-grant-key', `portable-history:${ids[0]}`, 'portable-temporary:0']
    const manifest = hash('private-reference-manifest'), request = hash('private-reference-request')
    const insertRun = db.prepare(`INSERT INTO import_runs
      (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,stage,status,
       total_chapters,manifest_chapter_count) VALUES(?,'reference',?,'private-namespace',?,?,'en-US',?,?,1,1)`)
    const insertGrant = db.prepare(`INSERT INTO reference_import_grants
      (grant_id,operation_key,project_id,import_run_id,revision,action,manifest_fingerprint,request_hash,
       state,decision_source,created_at,completed_at,revoked_at)
      VALUES(?,?,?,?,?,'reference-import-v1',?, ?,?,'author-action',100,?,?)`)
    for (const [index, state] of ['active', 'completed', 'revoked'].entries()) {
      insertRun.run(runs[index], runs[index], hash(`source-${index}`), manifest,
        state === 'completed' ? 'completed' : 'prepared', state === 'completed' ? 'completed' : 'ready')
      insertGrant.run(ids[index], operationKeys[index], f.projectId, runs[index], index + 1, manifest, request,
        state, state === 'completed' ? 101 : null, state === 'revoked' ? 102 : null)
    }
    const original = db.prepare('SELECT * FROM reference_import_grants ORDER BY grant_id').all() as Array<Record<string, unknown>>
    closeProjectDatabase()
    let sourceRoot = f.root, sourceProjectId: string = f.projectId
    for (let index = 0; index < 2; index += 1) {
      const sourcePath = path.join(sourceRoot, '.ai-novel', 'project.db')
      const before = fs.readFileSync(sourcePath)
      const attemptParentPath = path.join(f.base, `attempt-${index}`)
      fs.mkdirSync(attemptParentPath)
      const archivePath = path.join(f.base, `generation-${index}.ainovel`)
      await exportPortableProject({ sourceProjectRoot: sourceRoot,
        projectSession: { projectId: sourceProjectId, projectPath: sourceRoot, leaseId: `lease-${index}` },
        targetArchivePath: archivePath, attemptParentPath, assertCurrentContext: () => undefined,
        assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) } })
      expect(fs.readFileSync(sourcePath)).toEqual(before)
      const evidence = probeProjectSqlite({ databasePath: sourcePath })
      expect(evidence.domain.tableCounts.reference_import_grants).toBe(3)
      expect(evidence.preReferenceImportGrantsDomain?.tableCounts.reference_import_grants).toBeUndefined()
      const target = path.join(f.base, `restored-${index}`)
      const restored = await restorePortableProject({ archivePath, targetProjectRoot: target })
      expect(restored.targetProjectId).not.toBe(sourceProjectId)
      initProjectDatabase(target)
      const copied = getProjectDb()!, guard = readPortableRuntimeFreeze(target)
      const grants = new ReferenceImportGrantRepository(copied, { projectId: restored.targetProjectId,
        context: { database: copied, canonicalRoot: target, projectId: restored.targetProjectId },
        assertCurrent: () => undefined, isFrozen: id => guard.isFrozen('reference_import_grants', id), now: () => 200 })
      const rows = copied.prepare('SELECT * FROM reference_import_grants ORDER BY grant_id').all()
      expect(rows).toEqual(original.map(row => ({ ...row, operation_key: `portable-history:${row.grant_id}`,
        manifest_fingerprint: null, request_hash: null })))
      for (const [position, id] of ids.entries()) {
        expect(guard.isFrozen('reference_import_grants', id!)).toBe(true)
        expect(guard.isFrozen('import_runs', runs[position]!)).toBe(true)
        expect(() => guard.assertMutable('reference_import_grants', id!)).toThrow('PORTABLE_RUNTIME_FROZEN')
        const ref = { grantId: id!, runId: runs[position]!, revision: position + 1 }
        expect(grants.get(id!)).toMatchObject({ grantId: id, projectId: f.projectId, runId: runs[position] })
        expect(() => grants.revoke(ref)).toThrow('REFERENCE_IMPORT_GRANT_HISTORY_FROZEN')
        expect(() => copied.transaction(() => grants.assertActive(ref))()).toThrow('REFERENCE_IMPORT_GRANT_HISTORY_FROZEN')
      }
      const freezePath = path.join(target, '.ai-novel', 'portable-runtime-freeze.json')
      const freezeBytes = fs.readFileSync(freezePath)
      const portableBytes = Buffer.concat([fs.readFileSync(path.join(target, '.ai-novel', 'project.db')), freezeBytes])
      for (const secret of [operationKeys[0]!, manifest, request, hash(manifest), hash(request)]) {
        expect(portableBytes.includes(Buffer.from(secret))).toBe(false)
      }
      const readAuthority = () => readPortableCurrentAuthority({ database: copied,
        projectStorageRoot: path.join(target, '.ai-novel'), projectId: restored.targetProjectId })
      expect(readAuthority()).not.toBeNull()
      const document = JSON.parse(freezeBytes.toString('utf8')) as { records: Array<{ table: string; recordId: string }> }
      document.records = document.records.filter(record => !(record.table === 'import_runs' && record.recordId === runs[0]))
      fs.writeFileSync(freezePath, JSON.stringify(document))
      expect(readAuthority).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID')
      fs.renameSync(freezePath, `${freezePath}.held`)
      expect(readAuthority).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID')
      const authorityPath = path.join(target, '.ai-novel', 'portable-transfer-authority.json')
      fs.renameSync(authorityPath, `${authorityPath}.held`)
      expect(readAuthority).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID')
      fs.renameSync(`${authorityPath}.held`, authorityPath)
      fs.writeFileSync(freezePath, freezeBytes)
      fs.unlinkSync(`${freezePath}.held`)
      if (index === 1) {
        const runId = randomUUID(), grantId = randomUUID(), freshManifest = hash('fresh-manifest')
        copied.prepare(`INSERT INTO import_runs
          (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,stage,status,
           total_chapters,manifest_chapter_count) VALUES(?,'reference',?,'fresh',?,?,'en-US','prepared','ready',1,1)`)
          .run(runId, runId, hash('fresh-source'), freshManifest)
        const issued = grants.issue({ grantId, operationKey: randomUUID(), runId,
          manifestFingerprint: freshManifest, requestHash: hash('fresh-request') })
        expect(copied.transaction(() => grants.assertActive({ grantId, runId, revision: issued.revision }))())
          .toMatchObject({ grantId, projectId: restored.targetProjectId, state: 'active' })
      }
      closeProjectDatabase()
      sourceRoot = target
      sourceProjectId = restored.targetProjectId
    }
    initProjectDatabase(f.root)
    expect(getProjectDb()!.prepare('SELECT * FROM reference_import_grants ORDER BY grant_id').all()).toEqual(original)
  })

  it('restores a real schema 14 portable archive into the current schema without changing the old package', async () => {
    const f = fixture()
    closeProjectDatabase()
    const databasePath = path.join(f.base, 'schema14.db'), runId = randomUUID()
    const old = new Database(databasePath)
    try {
      old.transaction(() => initializeLegacyBaselineSchema(old))()
      migrateSchema(new SqliteSchemaAdapter(old), getDesktopMigrationRegistry(), 14)
      expect(verifySchema(new SqliteSchemaAdapter(old), getDesktopMigrationRegistry(), 14).version).toBe(14)
      old.prepare("INSERT INTO project_core(id,core_outline) VALUES('main','Old author outline')").run()
      old.prepare(`INSERT INTO import_runs
        (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,stage,status,
         total_chapters,manifest_chapter_count) VALUES(?,'reference',?,'','','','en-US','prepared','ready',1,1)`)
        .run(runId, runId)
      expect(old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reference_import_grants'").get()).toBeUndefined()
    } finally { old.close() }
    const databaseBytes = fs.readFileSync(databasePath), generation = 'schema14-reference-history'
    const projection = { source_display_json: [] }
    const record = { projectionId: `history:import_runs:${runId}`, table: 'import_runs', recordId: runId,
      terminalState: 'ready', projection, projectionHash: hash(JSON.stringify(projection)),
      excludedFields: ['effect_namespace', 'source_fingerprint', 'manifest_fingerprint', 'authority_fingerprint',
        'legacy_source_fingerprint', 'last_error'], nonReplayable: true, originalReceiptVerified: false }
    const freezeBytes = Buffer.from(JSON.stringify({ version: 1, originProjectId: f.projectId, snapshotGeneration: generation,
      nonReplayable: true, requiresRuntimeFreezeGuard: true, records: [record], avatarReferenceProjections: [] }))
    const source = new Database(databasePath, { readonly: true, fileMustExist: true })
    let authorityBytes: Buffer, receiptId: string
    try {
      const authority = { ...createPortableTransferAuthority({ database: source, originProjectId: f.projectId,
        snapshotGeneration: generation, portableDatabaseSha256: hash(databaseBytes) }), sourceSchemaVersion: 14 as const }
      authorityBytes = serializePortableTransferAuthority(authority)
      receiptId = authority.receiptId
    } finally { source.close() }
    const payloads: Array<{ path: string; bytes: Buffer; disposition: PortableProjectManifestEntry['disposition'] }> = [
      { path: 'project.db', bytes: databaseBytes, disposition: 'portable-database' },
      { path: 'portable-runtime-freeze.json', bytes: freezeBytes, disposition: 'history-projection' },
      { path: '.ai-novel/portable-transfer-authority.json', bytes: authorityBytes, disposition: 'transfer-receipt' },
    ]
    const sources = payloads.map((payload, index) => {
      const sourcePath = path.join(f.base, `schema14-payload-${index}`)
      fs.writeFileSync(sourcePath, payload.bytes)
      return { sourcePath, entry: { path: payload.path, byteSize: payload.bytes.length,
        sha256: hash(payload.bytes), disposition: payload.disposition } }
    })
    const archivePath = path.join(f.base, 'schema14.ainovel')
    const total = payloads.reduce((sum, item) => sum + item.bytes.length, 0)
    await writePortableProjectArchive({ targetPath: archivePath, sources, manifest: {
      formatVersion: 1, sourceSchemaVersion: 14, originProjectId: f.projectId, snapshotGeneration: generation,
      createdAt: '2026-11-07T00:00:00.000Z', declaredUncompressedBytes: total, declaredCompressedBytes: total,
      entries: sources.map(item => item.entry), semanticCounts: {}, omittedItems: [], transferReceiptIds: [receiptId],
      historyProjectionIds: [record.projectionId],
    } })
    const archiveBytes = fs.readFileSync(archivePath), target = path.join(f.base, 'schema14-restored')
    const restored = await restorePortableProject({ archivePath, targetProjectRoot: target })
    expect(fs.readFileSync(databasePath)).toEqual(databaseBytes)
    expect(fs.readFileSync(archivePath)).toEqual(archiveBytes)
    expect(restored.targetProjectId).not.toBe(f.projectId)
    initProjectDatabase(target)
    const copied = getProjectDb()!
    expect(copied.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect(copied.prepare("SELECT core_outline FROM project_core WHERE id='main'").pluck().get()).toBe('Old author outline')
    expect(copied.prepare('SELECT id FROM import_runs WHERE id=?').pluck().get(runId)).toBe(runId)
    expect(copied.prepare('SELECT COUNT(*) FROM reference_import_grants').pluck().get()).toBe(0)
    expect(readPortableRuntimeFreeze(target).isFrozen('import_runs', runId)).toBe(true)
    expect(readPortableCurrentAuthority({ database: copied, projectStorageRoot: path.join(target, '.ai-novel'),
      projectId: restored.targetProjectId })).not.toBeNull()
  })

  it.each(['table', 'column'] as const)('rejects an unclassified %s', mode => {
    const f = fixture(), db = getProjectDb()!
    if (mode === 'column') db.exec('ALTER TABLE reference_import_grants ADD COLUMN future_authority TEXT')
    else db.exec('CREATE TABLE future_reference_authority (secret TEXT)')
    closeProjectDatabase()
    const before = fs.readFileSync(f.databasePath)
    expect(() => sanitizePortableDatabase(f.databasePath)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
  })
})

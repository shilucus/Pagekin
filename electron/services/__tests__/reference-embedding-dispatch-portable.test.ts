import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema, verifySchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { exportPortableProject, sanitizePortableDatabase } from '../project-archive-service'
import { writePortableProjectArchive } from '../portable-project-archive'
import { getPortableFieldPolicy, type PortableProjectManifestEntry } from '../portable-project-format'
import { restorePortableProject } from '../project-restore-service'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { readPortableCurrentAuthority } from '../portable-current-authority'
import { createPortableTransferAuthority, serializePortableTransferAuthority } from '../portable-transfer-authority'
import { REFERENCE_EMBEDDING_DISPATCH_FIELDS, referenceEmbeddingDispatchId, type ReferenceEmbeddingDispatchRecord } from '../reference-embedding-dispatch-contract'
import { probeProjectSqlite } from '../sqlite-project-migration'

const parent = fs.realpathSync.native(os.tmpdir()), prefix = 'reference-embedding-portable-'
const roots: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function cleanupTargets(): string[] {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const child = (base: string, target: string) => {
    const relative = path.relative(base, target)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('FICTIONAL_DISPATCH_CLEANUP_OUTSIDE_PARENT')
  }
  const targets = roots.map(root => path.resolve(root))
  for (const root of targets) {
    child(parent, root)
    if (normalize(path.dirname(root)) !== normalize(parent) || !path.basename(root).startsWith(prefix)) throw new Error('FICTIONAL_DISPATCH_CLEANUP_OUTSIDE_PARENT')
    const pending = [root]
    while (pending.length) {
      const directory = pending.pop()!, info = fs.lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || normalize(fs.realpathSync.native(directory)) !== normalize(directory)) throw new Error('FICTIONAL_DISPATCH_CLEANUP_LINK')
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name), stat = fs.lstatSync(target)
        if (stat.isSymbolicLink() || normalize(fs.realpathSync.native(target)) !== normalize(target)) throw new Error('FICTIONAL_DISPATCH_CLEANUP_LINK')
        child(root, fs.realpathSync.native(target))
        if (stat.isDirectory()) pending.push(target)
      }
    }
  }
  return targets
}

afterEach(() => {
  closeProjectDatabase()
  const targets = cleanupTargets()
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true })
  roots.length = 0
})

function fixture() {
  const base = fs.mkdtempSync(path.join(parent, prefix)), root = path.join(base, 'source'), projectId = randomUUID()
  roots.push(base)
  fs.mkdirSync(path.join(root, '.ai-novel'), { recursive: true })
  fs.writeFileSync(path.join(root, '.ai-novel', 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId, createdAt: '2026-11-11T00:00:00.000Z',
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  initProjectDatabase(root)
  getProjectDb()!.prepare("INSERT INTO project_core(id,core_outline) VALUES('main','Fictional author outline')").run()
  return { base, root, projectId, databasePath: path.join(root, '.ai-novel', 'project.db') }
}

function seed(db: Database.Database, runId = 'fictional-dispatch-run', documentId = hash('fictional-reference-document')) {
  db.prepare(`INSERT INTO import_runs
    (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,stage,status,total_chapters,manifest_chapter_count)
    VALUES(?,'reference',?,'import:fictional',?,?,'en-US','knowledge','running',1,1)`)
    .run(runId, runId, hash(`source:${runId}`), hash(`manifest:${runId}`))
  db.prepare(`INSERT INTO import_reference_documents
    (document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state)
    VALUES(?,?,?,?,5,'reference','prepared')`).run(documentId, documentId, hash('fictional content'), hash('fictional chunks'))
  const states = ['dispatch_marked', 'response_received', 'http_failed', 'response_invalid', 'transport_unknown'] as const
  for (const [ordinal, state] of states.entries()) {
    db.prepare('INSERT INTO reference_embedding_dispatches VALUES(?,?,?,?,?,?,?,?,?)')
      .run(referenceEmbeddingDispatchId(documentId, ordinal), runId, documentId, ordinal, 1, state,
        state === 'http_failed' ? 503 : state === 'response_received' || state === 'response_invalid' ? 200 : null,
        100 + ordinal, state === 'dispatch_marked' ? null : 200 + ordinal)
  }
  return { runId, documentId, rows: db.prepare('SELECT * FROM reference_embedding_dispatches ORDER BY batch_ordinal').all() as ReferenceEmbeddingDispatchRecord[] }
}

describe('reference embedding dispatch portable history', () => {
  it('serializes exact document/run/dispatch history identities instead of physical document rowids', () => {
    const f = fixture(), original = seed(getProjectDb()!)
    closeProjectDatabase()
    const before = fs.readFileSync(f.databasePath), copy = path.join(f.base, 'isolated-portable-copy.db')
    fs.copyFileSync(f.databasePath, copy, fs.constants.COPYFILE_EXCL)
    const sanitized = sanitizePortableDatabase(copy)
    expect(sanitized.history.filter(record => record.table === 'import_reference_documents').map(record => record.recordId))
      .toEqual([original.documentId])
    expect(sanitized.history.filter(record => record.table === 'import_runs').map(record => record.recordId))
      .toEqual([original.runId])
    expect(sanitized.history.filter(record => record.table === 'reference_embedding_dispatches').map(record => record.recordId).sort())
      .toEqual(original.rows.map(row => row.dispatch_id).sort())
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
  })

  it('opens an actual canonical schema16 project through the installed upgrade and preserves its old domain', () => {
    const f = fixture()
    closeProjectDatabase()
    const old = new Database(f.databasePath)
    try {
      old.exec('DROP TABLE reference_import_manifest_chapters; DROP TABLE reference_embedding_budgets; DROP TABLE reference_embedding_dispatches')
      old.pragma('user_version=16')
      expect(verifySchema(new SqliteSchemaAdapter(old), getDesktopMigrationRegistry(), 16).version).toBe(16)
    } finally { old.close() }
    const before = probeProjectSqlite({ databasePath: f.databasePath })
    initProjectDatabase(f.root)
    expect(getProjectDb()!.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect(getProjectDb()!.prepare('SELECT * FROM reference_embedding_dispatches').all()).toEqual([])
    expect(getProjectDb()!.prepare('SELECT * FROM reference_embedding_budgets').all()).toEqual([])
    expect(probeProjectSqlite({ databasePath: f.databasePath }).preEmbeddingDispatchDomain).toEqual(before.domain)
  })

  it('preserves all nine H fields and unknown facts through canonical reopen and two actual archive generations', async () => {
    const f = fixture(), original = seed(getProjectDb()!)
    for (const field of REFERENCE_EMBEDDING_DISPATCH_FIELDS) expect(getPortableFieldPolicy('reference_embedding_dispatches', field)).toMatchObject({
      origin: 'm16-delta', disposition: 'historical-nonreplayable', signedDisposition: null,
    })
    closeProjectDatabase()
    initProjectDatabase(f.root)
    expect(getProjectDb()!.prepare('SELECT * FROM reference_embedding_dispatches ORDER BY batch_ordinal').all()).toEqual(original.rows)
    closeProjectDatabase()
    let sourceRoot = f.root, sourceProjectId: string = f.projectId
    for (let generation = 0; generation < 2; generation += 1) {
      const sourcePath = path.join(sourceRoot, '.ai-novel', 'project.db'), before = fs.readFileSync(sourcePath)
      const attemptParentPath = path.join(f.base, `attempt-${generation}`), archivePath = path.join(f.base, `generation-${generation}.ainovel`)
      fs.mkdirSync(attemptParentPath)
      await exportPortableProject({ sourceProjectRoot: sourceRoot,
        projectSession: { projectId: sourceProjectId, projectPath: sourceRoot, leaseId: `fictional-lease-${generation}` },
        targetArchivePath: archivePath, attemptParentPath, assertCurrentContext: () => undefined,
        assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) } })
      expect(fs.readFileSync(sourcePath)).toEqual(before)
      const evidence = probeProjectSqlite({ databasePath: sourcePath })
      expect(evidence.domain.tableCounts.reference_embedding_dispatches).toBe(5)
      expect(evidence.preEmbeddingDispatchDomain?.tableCounts.reference_embedding_dispatches).toBeUndefined()
      const target = path.join(f.base, `restored-${generation}`)
      const restored = await restorePortableProject({ archivePath, targetProjectRoot: target })
      expect(restored.targetProjectId).not.toBe(sourceProjectId)
      initProjectDatabase(target)
      const copied = getProjectDb()!, guard = readPortableRuntimeFreeze(target)
      expect(copied.prepare('SELECT * FROM reference_embedding_dispatches ORDER BY batch_ordinal').all()).toEqual(original.rows)
      const freezePath = path.join(target, '.ai-novel', 'portable-runtime-freeze.json'), freezeBytes = fs.readFileSync(freezePath)
      const document = JSON.parse(freezeBytes.toString('utf8')) as { records: Array<{ table: string; recordId: string; projection: Record<string, unknown> }> }
      const readAuthority = () => readPortableCurrentAuthority({ database: getProjectDb()!, projectStorageRoot: path.join(target, '.ai-novel'), projectId: restored.targetProjectId })
      expect(readAuthority()).not.toBeNull()
      expect(guard.isFrozen('import_runs', original.runId)).toBe(true)
      expect(guard.isFrozen('import_reference_documents', original.documentId)).toBe(true)
      for (const row of original.rows) {
        expect(guard.isFrozen('reference_embedding_dispatches', row.dispatch_id)).toBe(true)
        expect(() => guard.assertMutable('reference_embedding_dispatches', row.dispatch_id)).toThrow('PORTABLE_RUNTIME_FROZEN')
        expect(document.records.find(record => record.table === 'reference_embedding_dispatches' && record.recordId === row.dispatch_id)?.projection).toEqual({})
      }
      const omissions = [
        ...original.rows.map(row => ({ table: 'reference_embedding_dispatches', recordId: row.dispatch_id })),
        { table: 'import_runs', recordId: original.runId }, { table: 'import_reference_documents', recordId: original.documentId },
      ]
      for (const omitted of omissions) {
        fs.writeFileSync(freezePath, JSON.stringify({ ...document, records: document.records.filter(record =>
          record.table !== omitted.table || record.recordId !== omitted.recordId) }))
        expect(readAuthority).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID')
      }
      fs.writeFileSync(freezePath, JSON.stringify({ ...document, records: [] }))
      expect(readAuthority).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID')
      closeProjectDatabase()
      expect(() => initProjectDatabase(target)).toThrow('PORTABLE_TRANSFER_AUTHORITY_INVALID')
      fs.writeFileSync(freezePath, freezeBytes)
      initProjectDatabase(target)
      expect(readAuthority()).not.toBeNull()
      fs.renameSync(freezePath, `${freezePath}.held`)
      expect(readAuthority).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID')
      const authorityPath = path.join(target, '.ai-novel', 'portable-transfer-authority.json')
      fs.renameSync(authorityPath, `${authorityPath}.held`)
      expect(readAuthority).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID')
      fs.renameSync(`${authorityPath}.held`, authorityPath)
      fs.renameSync(`${freezePath}.held`, freezePath)
      if (generation === 1) {
        seed(getProjectDb()!, 'fresh-local-run', hash('fresh-local-reference'))
        expect(readAuthority()).not.toBeNull()
      }
      closeProjectDatabase()
      sourceRoot = target
      sourceProjectId = restored.targetProjectId
    }
    initProjectDatabase(f.root)
    expect(getProjectDb()!.prepare('SELECT * FROM reference_embedding_dispatches ORDER BY batch_ordinal').all()).toEqual(original.rows)
  })

  it('restores a real schema16 archive and upgrades without inventing old prepared dispatches', async () => {
    const f = fixture()
    closeProjectDatabase()
    const databasePath = path.join(f.base, 'schema16.db'), old = new Database(databasePath), documentId = hash('schema16-prepared-document')
    try {
      old.transaction(() => initializeLegacyBaselineSchema(old))()
      migrateSchema(new SqliteSchemaAdapter(old), getDesktopMigrationRegistry(), 16)
      old.exec("INSERT INTO project_core(id,core_outline) VALUES('main','Fictional schema16 outline')")
      old.exec("INSERT INTO blueprints(chapter_number,title,notes) VALUES(3,'Fictional schema16 blueprint','Author note')")
      old.prepare(`INSERT INTO import_reference_documents
        (document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state)
        VALUES(?,?,?,?,1,'reference','prepared')`).run(documentId, documentId, hash('old fictional content'), hash('old fictional chunks'))
      expect(verifySchema(new SqliteSchemaAdapter(old), getDesktopMigrationRegistry(), 16).version).toBe(16)
    } finally { old.close() }
    const bytes = fs.readFileSync(databasePath), generation = 'fictional-schema16', source = new Database(databasePath, { readonly: true })
    let authorityBytes: Buffer, receiptId: string
    try {
      const authority = { ...createPortableTransferAuthority({ database: source, originProjectId: f.projectId,
        snapshotGeneration: generation, portableDatabaseSha256: hash(bytes) }), sourceSchemaVersion: 16 as const }
      authorityBytes = serializePortableTransferAuthority(authority)
      receiptId = authority.receiptId
    } finally { source.close() }
    const record = { projectionId: `history:import_reference_documents:${documentId}`, table: 'import_reference_documents', recordId: documentId,
      terminalState: 'prepared', projection: {}, projectionHash: hash('{}'), excludedFields: [], nonReplayable: true, originalReceiptVerified: false }
    const freezeBytes = Buffer.from(JSON.stringify({ version: 1, originProjectId: f.projectId, snapshotGeneration: generation,
      nonReplayable: true, requiresRuntimeFreezeGuard: true, records: [record], avatarReferenceProjections: [] }))
    const payloads: Array<{ path: string; bytes: Buffer; disposition: PortableProjectManifestEntry['disposition'] }> = [
      { path: 'project.db', bytes, disposition: 'portable-database' },
      { path: 'portable-runtime-freeze.json', bytes: freezeBytes, disposition: 'history-projection' },
      { path: '.ai-novel/portable-transfer-authority.json', bytes: authorityBytes, disposition: 'transfer-receipt' },
    ]
    const sources = payloads.map((payload, index) => {
      const sourcePath = path.join(f.base, `schema16-payload-${index}`)
      fs.writeFileSync(sourcePath, payload.bytes)
      return { sourcePath, entry: { path: payload.path, byteSize: payload.bytes.length, sha256: hash(payload.bytes), disposition: payload.disposition } }
    })
    const archivePath = path.join(f.base, 'schema16.ainovel'), total = payloads.reduce((sum, item) => sum + item.bytes.length, 0)
    await writePortableProjectArchive({ targetPath: archivePath, sources, manifest: {
      formatVersion: 1, sourceSchemaVersion: 16, originProjectId: f.projectId, snapshotGeneration: generation,
      createdAt: '2026-11-11T00:00:00.000Z', declaredUncompressedBytes: total, declaredCompressedBytes: total,
      entries: sources.map(item => item.entry), semanticCounts: {}, omittedItems: [], transferReceiptIds: [receiptId], historyProjectionIds: [record.projectionId],
    } })
    const archiveBytes = fs.readFileSync(archivePath), target = path.join(f.base, 'schema16-restored')
    const restored = await restorePortableProject({ archivePath, targetProjectRoot: target })
    expect(fs.readFileSync(databasePath)).toEqual(bytes)
    expect(fs.readFileSync(archivePath)).toEqual(archiveBytes)
    initProjectDatabase(target)
    expect(getProjectDb()!.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM reference_embedding_dispatches').pluck().get()).toBe(0)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM reference_embedding_budgets').pluck().get()).toBe(0)
    expect(getProjectDb()!.prepare('SELECT state FROM import_reference_documents WHERE document_id=?').pluck().get(documentId)).toBe('prepared')
    expect(getProjectDb()!.prepare("SELECT core_outline FROM project_core WHERE id='main'").pluck().get()).toBe('Fictional schema16 outline')
    expect(getProjectDb()!.prepare('SELECT title,notes FROM blueprints WHERE chapter_number=3').get()).toEqual({ title: 'Fictional schema16 blueprint', notes: 'Author note' })
    expect(readPortableCurrentAuthority({ database: getProjectDb()!, projectStorageRoot: path.join(target, '.ai-novel'), projectId: restored.targetProjectId })).not.toBeNull()
  })

  it.each(['table', 'column'] as const)('rejects an unclassified dispatch %s without sanitizing source bytes', mode => {
    const f = fixture(), db = getProjectDb()!
    seed(db)
    if (mode === 'column') db.exec('ALTER TABLE reference_embedding_dispatches ADD COLUMN model_configuration TEXT')
    else db.exec('CREATE TABLE reference_embedding_dispatch_private (payload TEXT)')
    closeProjectDatabase()
    const before = fs.readFileSync(f.databasePath)
    expect(() => sanitizePortableDatabase(f.databasePath)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
  })
})

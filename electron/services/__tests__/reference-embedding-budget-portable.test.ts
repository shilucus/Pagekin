import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { verifySchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { getImportInferenceTopics } from '../../../src/shared/import-inference-materials'
import { importQueryId } from '../import-query-contract'
import { getPortableFieldPolicy, PORTABLE_READABLE_SOURCE_SCHEMA_VERSIONS, type PortableProjectManifestEntry } from '../portable-project-format'
import { readPortableRuntimeFreeze, type PortableRuntimeFreezeGuard, type PortableRuntimeFreezeTable } from '../portable-runtime-freeze'
import { assertReferenceEmbeddingBudgetFreezeCoverage, assertReferenceManifestBindingFreezeCoverage, createPortableTransferAuthority, serializePortableTransferAuthority, type PortableTransferAuthority } from '../portable-transfer-authority'
import { exportPortableProject, sanitizePortableDatabase } from '../project-archive-service'
import { writePortableProjectArchive } from '../portable-project-archive'
import { restorePortableProject } from '../project-restore-service'
import { readPortableCurrentAuthority } from '../portable-current-authority'

const parent = fs.realpathSync.native(os.tmpdir()), prefix = 'reference-budget-portable-'
const roots: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

afterEach(() => {
  closeProjectDatabase()
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  for (const target of roots) {
    if (normalize(path.dirname(target)) !== normalize(parent) || !path.basename(target).startsWith(prefix)) throw new Error('BUDGET_CLEANUP_OUTSIDE_PARENT')
    const pending = [target]
    while (pending.length) {
      const current = pending.pop()!, info = fs.lstatSync(current)
      if (info.isSymbolicLink() || normalize(fs.realpathSync.native(current)) !== normalize(current)) throw new Error('BUDGET_CLEANUP_LINK')
      const relative = path.relative(target, current)
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('BUDGET_CLEANUP_OUTSIDE_ROOT')
      if (info.isDirectory()) for (const name of fs.readdirSync(current)) pending.push(path.join(current, name))
    }
  }
  for (const target of roots) fs.rmSync(target, { recursive: true, force: true })
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
  getProjectDb()!.prepare("INSERT INTO project_core(id,core_outline) VALUES('main','Fictional outline')").run()
  return { base, root, projectId, databasePath: path.join(root, '.ai-novel', 'project.db') }
}

function seedRoot(db: Database.Database, id: string, sanitized = false, snapshotRunId = id, chapterNumber = 1): void {
  db.prepare(`INSERT INTO import_runs
    (id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,stage,status,total_chapters,manifest_chapter_count,manifest_content_size)
    VALUES(?,'reference',?, ?,?,?,'en-US','knowledge','running',1,1,?)`)
    .run(id, id, sanitized ? '' : `import:${id}`, sanitized ? '' : hash(`source:${id}`), sanitized ? '' : hash(`manifest:${id}`),
      Buffer.byteLength(`Fictional snapshot ${snapshotRunId}`))
  if (snapshotRunId === id) {
    const text = `Fictional snapshot ${id}`
    db.prepare(`INSERT INTO import_run_chapters
      (run_id,chapter_number,source_id,source_chapter_number,title,content_fingerprint,content_size,content_snapshot)
      VALUES(?,1,'fictional-source',1,'One',?,?,?)`).run(id, hash(text), Buffer.byteLength(text), text)
  }
  db.prepare(`INSERT INTO reference_import_manifest_chapters
    (import_run_id,chapter_number,snapshot_run_id,snapshot_chapter_number,source_id,source_chapter_number)
    VALUES(?,?,?,1,'fictional-source',1)`).run(id, chapterNumber, snapshotRunId)
}

function seedBudget(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO reference_embedding_budgets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, hash(`manifest:${id}`), 'reference-embedding-budget-v1', 100, 10, 5, 2, 225000, 1, 5, null, 'ready')
}

function seedQuery(db: Database.Database, id: string): void {
  const action = `action-${id}`, run = `generation-${id}`
  db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)').run(
    action, `private-${id}`, JSON.stringify({ rootActionId: action, operation: 'import', status: 'active' }),
    JSON.stringify({ maxPhysicalRequests: 4, maxTokenLiability: 1, maxOutputPerRequest: 1, maxActiveElapsedMs: 1000 }))
  db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run(run, action, '{}', 'running', 1, `open-${id}`)
  const topics = getImportInferenceTopics('en-US').map(({ key, query, topK }) => ({ key, query, topK }))
  const binding = JSON.stringify({ version: 1, slot: { stage: 'global', batchId: 'global', writingLanguage: 'en-US' },
    contextFingerprint: hash('context'), configurationFingerprint: hash('private-config'), topics })
  db.prepare('INSERT INTO import_query_plans VALUES(?,?,?,?,?,?,?,?)')
    .run(id, run, action, hash(`manifest:${id}`), binding, hash(binding), 'ready', 1)
  const hit = { text: 'Fictional material', score: 0.75, fileName: 'fiction.txt' }
  const receipt = JSON.stringify({ version: 1, state: 'available', snapshot: {
    version: 1, state: 'stored', query: topics[0]!.query, topK: 5, storageState: 'present',
    canonicalRevision: 1, documentsRevision: 1, tableRevisions: [{ tableName: 'chunks', revision: 1 }],
    registryHash: hash('private-registry'), results: [hit], items: [{ ...hit, chunkId: 'chunk-1', documentId: 'document-1',
      chunkIndex: 0, corpusKind: 'reference', contentHash: hash(hit.text), documentChunkSetHash: hash('chunk-set'),
      documentChunks: [{ chunkId: 'chunk-1', chunkIndex: 0, contentHash: hash(hit.text) }] }],
  } })
  const unavailable = JSON.stringify({ version: 1, state: 'unavailable' })
  const insert = db.prepare('INSERT INTO import_query_topics VALUES(?,?,?,?,?,?,?,?,?,?)')
  topics.forEach((topic, index) => {
    const material = index === 0 ? receipt : index === 1 ? unavailable : null
    insert.run(importQueryId(id, topic.key), id, topic.key, index < 2 ? 'completed' : 'prepared',
      index === 1 ? 2 : null, index === 1 ? JSON.stringify({ kind: 'http_failed', httpStatus: 503 }) : null,
      index === 1 ? 3 : null, index === 1 ? 4 : null, material, material === null ? null : hash(material))
  })
}

async function exportArchive(base: string, root: string, projectId: string, name: string): Promise<string> {
  const attemptParentPath = path.join(base, `${name}-attempt`), archivePath = path.join(base, `${name}.ainovel`)
  fs.mkdirSync(attemptParentPath)
  await exportPortableProject({ sourceProjectRoot: root,
    projectSession: { projectId, projectPath: root, leaseId: `lease-${name}` }, targetArchivePath: archivePath,
    attemptParentPath, assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) } })
  return archivePath
}

async function writeTestArchive(input: { base: string; databasePath: string; projectId: string; name: string;
  sourceVersion: 17 | 18 | 19; authorityVersion: 17 | 18 | 19; records: ReturnType<typeof sanitizePortableDatabase>['history'] }): Promise<string> {
  const bytes = fs.readFileSync(input.databasePath), generation = `generation-${input.name}`
  const db = new Database(input.databasePath, { readonly: true })
  let authority: PortableTransferAuthority
  try {
    authority = { ...createPortableTransferAuthority({ database: db, originProjectId: input.projectId,
      snapshotGeneration: generation, portableDatabaseSha256: hash(bytes) }), sourceSchemaVersion: input.authorityVersion }
  } finally { db.close() }
  const freezeBytes = Buffer.from(JSON.stringify({ version: 1, originProjectId: input.projectId, snapshotGeneration: generation,
    nonReplayable: true, requiresRuntimeFreezeGuard: true, records: input.records, avatarReferenceProjections: [] }))
  const payloads: Array<{ path: string; bytes: Buffer; disposition: PortableProjectManifestEntry['disposition'] }> = [
    { path: 'project.db', bytes, disposition: 'portable-database' },
    { path: 'portable-runtime-freeze.json', bytes: freezeBytes, disposition: 'history-projection' },
    { path: '.ai-novel/portable-transfer-authority.json', bytes: serializePortableTransferAuthority(authority), disposition: 'transfer-receipt' },
  ]
  const sources = payloads.map((payload, index) => {
    const sourcePath = path.join(input.base, `${input.name}-payload-${index}`)
    fs.writeFileSync(sourcePath, payload.bytes)
    return { sourcePath, entry: { path: payload.path, byteSize: payload.bytes.length, sha256: hash(payload.bytes), disposition: payload.disposition } }
  })
  const archivePath = path.join(input.base, `${input.name}.ainovel`), total = payloads.reduce((sum, item) => sum + item.bytes.length, 0)
  await writePortableProjectArchive({ targetPath: archivePath, sources, manifest: {
    formatVersion: 1, sourceSchemaVersion: input.sourceVersion, originProjectId: input.projectId, snapshotGeneration: generation,
    createdAt: '2026-11-11T00:00:00.000Z', declaredUncompressedBytes: total, declaredCompressedBytes: total,
    entries: sources.map(item => item.entry), semanticCounts: {}, omittedItems: [], transferReceiptIds: [authority.receiptId],
    historyProjectionIds: input.records.map(item => item.projectionId),
  } })
  return archivePath
}

function freeze(entries: Array<[PortableRuntimeFreezeTable, string]>): PortableRuntimeFreezeGuard {
  return {
    active: true,
    isFrozen: (table, id) => entries.some(([candidate, key]) => candidate === table && key === id),
    assertMutable: () => {},
  }
}

function authority(version: 17 | 18): PortableTransferAuthority {
  return { sourceSchemaVersion: version } as PortableTransferAuthority
}

function database(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE reference_embedding_budgets (
    root_run_id TEXT, manifest_fingerprint TEXT, policy_version TEXT, initial_chunk_size INTEGER,
    initial_chunk_overlap INTEGER, initial_batch_size INTEGER, request_limit INTEGER, active_limit_ms INTEGER,
    spent_requests INTEGER, active_elapsed_ms INTEGER, active_since_ms INTEGER, state TEXT)`)
  return db
}

describe('portable reference embedding budgets', () => {
  it('keeps schema 17 readable and classifies all budget fields', () => {
    expect(PORTABLE_READABLE_SOURCE_SCHEMA_VERSIONS).toContain(17)
    expect(PORTABLE_READABLE_SOURCE_SCHEMA_VERSIONS).toContain(18)
    for (const field of ['root_run_id', 'policy_version', 'initial_chunk_size', 'initial_chunk_overlap',
      'initial_batch_size', 'request_limit', 'active_limit_ms', 'spent_requests', 'active_elapsed_ms', 'active_since_ms', 'state']) {
      expect(getPortableFieldPolicy('reference_embedding_budgets', field)).toMatchObject({
        disposition: 'historical-nonreplayable', origin: 'm17-delta',
      })
    }
    expect(getPortableFieldPolicy('reference_embedding_budgets', 'manifest_fingerprint')).toMatchObject({
      disposition: 'exclude-machine-authority', origin: 'm17-delta',
    })
    for (const field of ['import_run_id', 'chapter_number', 'snapshot_run_id', 'snapshot_chapter_number', 'source_id', 'source_chapter_number']) {
      expect(getPortableFieldPolicy('reference_import_manifest_chapters', field)).toMatchObject({
        disposition: 'historical-nonreplayable', origin: 'm17-delta',
      })
    }
  })

  it('requires root and budget freezes for schema 18 and rejects an unredacted manifest', () => {
    const db = database()
    try {
      db.prepare('INSERT INTO reference_embedding_budgets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('root', null, 'reference-embedding-budget-v1', 100, 10, 5, 2, 225000, 1, 5, null, 'ready')
      const rootOnly = freeze([['import_runs', 'root']])
      const both = freeze([['import_runs', 'root'], ['reference_embedding_budgets', 'root']])
      expect(() => assertReferenceEmbeddingBudgetFreezeCoverage(db, authority(18), rootOnly, true)).toThrow()
      expect(() => assertReferenceEmbeddingBudgetFreezeCoverage(db, authority(18), both, true)).not.toThrow()
      db.prepare('UPDATE reference_embedding_budgets SET manifest_fingerprint=?').run('not-redacted')
      expect(() => assertReferenceEmbeddingBudgetFreezeCoverage(db, authority(18), both, true)).toThrow()
    } finally { db.close() }
  })

  it('accepts only null legacy markers for a frozen root migrated from schema 17', () => {
    const db = database()
    try {
      db.prepare('INSERT INTO reference_embedding_budgets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('root', null, 'reference-embedding-budget-v1', null, null, null, null, null, null, null, null, 'legacy_unbudgeted')
      const rootOnly = freeze([['import_runs', 'root']])
      expect(() => assertReferenceEmbeddingBudgetFreezeCoverage(db, authority(17), rootOnly, true)).not.toThrow()
      expect(() => assertReferenceEmbeddingBudgetFreezeCoverage(db, authority(18), rootOnly, true)).toThrow()
      expect(() => assertReferenceEmbeddingBudgetFreezeCoverage(db, authority(17), freeze([]), true)).toThrow()
      db.prepare('UPDATE reference_embedding_budgets SET spent_requests=0').run()
      expect(() => assertReferenceEmbeddingBudgetFreezeCoverage(db, authority(17), rootOnly, true)).toThrow()
    } finally { db.close() }
  })

  it('does not freeze a genuinely new local budget', () => {
    const db = database()
    try {
      db.prepare('INSERT INTO reference_embedding_budgets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('new-root', 'local-hash', 'reference-embedding-budget-v1', 100, 10, 5, 2, 225000, 0, 0, null, 'ready')
      expect(() => assertReferenceEmbeddingBudgetFreezeCoverage(db, authority(17), freeze([]))).not.toThrow()
    } finally { db.close() }
  })

  it('limits old-source unfrozen binding backfill to the original snapshot identity', () => {
    const db = database()
    try {
      db.exec(`CREATE TABLE import_runs (id TEXT,root_run_id TEXT,purpose TEXT,stage TEXT,manifest_chapter_count INTEGER,manifest_content_size INTEGER);
        CREATE TABLE import_run_chapters (run_id TEXT,chapter_number INTEGER,source_id TEXT,source_chapter_number INTEGER,content_size INTEGER);
        CREATE TABLE reference_import_manifest_chapters (import_run_id TEXT,chapter_number INTEGER,snapshot_run_id TEXT,snapshot_chapter_number INTEGER,source_id TEXT,source_chapter_number INTEGER);
        INSERT INTO import_run_chapters VALUES ('root',1,'source',1,10),('other',1,'source',1,10);
        INSERT INTO reference_import_manifest_chapters VALUES ('root',1,'root',1,'source',1)`)
      const rootOnly = freeze([['import_runs', 'root']])
      expect(() => assertReferenceManifestBindingFreezeCoverage(db, authority(17), rootOnly, true)).not.toThrow()
      db.prepare("UPDATE reference_import_manifest_chapters SET source_id='different'").run()
      expect(() => assertReferenceManifestBindingFreezeCoverage(db, authority(17), rootOnly, true)).toThrow()
      db.prepare("UPDATE reference_import_manifest_chapters SET source_id='source',snapshot_run_id='other'").run()
      expect(() => assertReferenceManifestBindingFreezeCoverage(db, authority(17), rootOnly, true)).toThrow()
      db.prepare("UPDATE reference_import_manifest_chapters SET snapshot_run_id='root',source_chapter_number=2").run()
      expect(() => assertReferenceManifestBindingFreezeCoverage(db, authority(17), rootOnly, true)).toThrow()
      db.prepare('UPDATE reference_import_manifest_chapters SET source_chapter_number=1,snapshot_chapter_number=2').run()
      expect(() => assertReferenceManifestBindingFreezeCoverage(db, authority(17), rootOnly, true)).toThrow()
    } finally { db.close() }
  })

  it('rejects unsafe binding identifiers and broken snapshot references without modifying the source', () => {
    const f = fixture()
    seedRoot(getProjectDb()!, 'identifier-root')
    closeProjectDatabase()
    const sourceBytes = fs.readFileSync(f.databasePath)
    for (const [field, value, error] of [
      ['source_id', '../private', 'PORTABLE_UNSAFE_PROJECTION'],
      ['snapshot_run_id', 'secret like value', 'PORTABLE_SCHEMA_UNSUPPORTED'],
    ] as const) {
      const copyPath = path.join(f.base, `unsafe-${field}.db`)
      fs.copyFileSync(f.databasePath, copyPath, fs.constants.COPYFILE_EXCL)
      const copy = new Database(copyPath)
      try {
        copy.pragma('foreign_keys = OFF')
        copy.prepare(`UPDATE reference_import_manifest_chapters SET ${field}=?`).run(value)
      } finally { copy.close() }
      expect(() => sanitizePortableDatabase(copyPath)).toThrow(error)
      expect(fs.readFileSync(f.databasePath)).toEqual(sourceBytes)
    }
  })

  it('migrates a schema 17 archive without inventing budget history and re-exports it alongside a new local root', async () => {
    const f = fixture()
    seedRoot(getProjectDb()!, 'legacy-root', true)
    closeProjectDatabase()
    const old = new Database(f.databasePath)
    try {
      old.exec('DROP TABLE import_query_topics; DROP TABLE import_query_plans; DROP TABLE reference_import_manifest_chapters; DROP TABLE reference_embedding_budgets')
      old.pragma('user_version=17')
      expect(verifySchema(new SqliteSchemaAdapter(old), getDesktopMigrationRegistry(), 17).version).toBe(17)
    } finally { old.close() }
    const rootRecord = { projectionId: 'history:import_runs:legacy-root', table: 'import_runs', recordId: 'legacy-root',
      terminalState: 'running', projection: {}, projectionHash: hash('{}'), excludedFields: [], nonReplayable: true as const,
      originalReceiptVerified: false as const }
    const mismatch = await writeTestArchive({ ...f, name: 'mismatch', sourceVersion: 17, authorityVersion: 18, records: [rootRecord] })
    await expect(restorePortableProject({ archivePath: mismatch, targetProjectRoot: path.join(f.base, 'mismatch-target') }))
      .rejects.toThrow('PORTABLE_RESTORE_INVALID')
    const archivePath = await writeTestArchive({ ...f, name: 'old', sourceVersion: 17, authorityVersion: 17, records: [rootRecord] })
    const originalDatabase = fs.readFileSync(f.databasePath), originalArchive = fs.readFileSync(archivePath)
    const target = path.join(f.base, 'restored-old')
    const restored = await restorePortableProject({ archivePath, targetProjectRoot: target })
    expect(fs.readFileSync(f.databasePath)).toEqual(originalDatabase)
    expect(fs.readFileSync(archivePath)).toEqual(originalArchive)
    initProjectDatabase(target)
    const db = getProjectDb()!, guard = readPortableRuntimeFreeze(target)
    expect(db.pragma('user_version', { simple: true })).toBe(19)
    expect(db.prepare('SELECT * FROM reference_embedding_budgets WHERE root_run_id=?').get('legacy-root')).toEqual({
      root_run_id: 'legacy-root', manifest_fingerprint: null, policy_version: 'reference-embedding-budget-v1',
      initial_chunk_size: null, initial_chunk_overlap: null, initial_batch_size: null, request_limit: null,
      active_limit_ms: null, spent_requests: null, active_elapsed_ms: null, active_since_ms: null, state: 'legacy_unbudgeted',
    })
    expect(guard.isFrozen('import_runs', 'legacy-root')).toBe(true)
    expect(guard.isFrozen('reference_embedding_budgets', 'legacy-root')).toBe(false)
    expect(db.prepare('SELECT snapshot_run_id FROM reference_import_manifest_chapters WHERE import_run_id=?').pluck().get('legacy-root')).toBe('legacy-root')
    expect(guard.isFrozen('reference_import_manifest_chapters', 'legacy-root:1')).toBe(false)
    seedRoot(db, 'new-local-root', false, 'legacy-root', 2)
    seedBudget(db, 'new-local-root')
    expect(guard.isFrozen('reference_embedding_budgets', 'new-local-root')).toBe(false)
    expect(guard.isFrozen('reference_import_manifest_chapters', 'new-local-root:2')).toBe(false)
    expect(db.prepare('SELECT chapter_number,snapshot_chapter_number FROM reference_import_manifest_chapters WHERE import_run_id=?').get('new-local-root'))
      .toEqual({ chapter_number: 2, snapshot_chapter_number: 1 })
    expect(readPortableCurrentAuthority({ database: db, projectStorageRoot: path.join(target, '.ai-novel'), projectId: restored.targetProjectId })).not.toBeNull()
    closeProjectDatabase()
    const secondArchive = await exportArchive(f.base, target, restored.targetProjectId, 'old-reexport')
    const secondTarget = path.join(f.base, 'restored-old-reexport')
    const second = await restorePortableProject({ archivePath: secondArchive, targetProjectRoot: secondTarget })
    initProjectDatabase(secondTarget)
    const secondGuard = readPortableRuntimeFreeze(secondTarget)
    expect(secondGuard.isFrozen('reference_embedding_budgets', 'legacy-root')).toBe(true)
    expect(secondGuard.isFrozen('reference_embedding_budgets', 'new-local-root')).toBe(true)
    expect(secondGuard.isFrozen('reference_import_manifest_chapters', 'legacy-root:1')).toBe(true)
    expect(secondGuard.isFrozen('reference_import_manifest_chapters', 'new-local-root:2')).toBe(true)
    expect(getProjectDb()!.prepare('SELECT chapter_number,snapshot_run_id,snapshot_chapter_number FROM reference_import_manifest_chapters WHERE import_run_id=?').get('new-local-root'))
      .toEqual({ chapter_number: 2, snapshot_run_id: 'legacy-root', snapshot_chapter_number: 1 })
    expect(getProjectDb()!.prepare('SELECT content_snapshot FROM import_run_chapters WHERE run_id=? AND chapter_number=1').pluck().get('legacy-root'))
      .toBe('Fictional snapshot legacy-root')
    expect(getProjectDb()!.pragma('foreign_key_check')).toEqual([])
    expect(getProjectDb()!.prepare('SELECT state,manifest_fingerprint FROM reference_embedding_budgets ORDER BY root_run_id').all())
      .toEqual([{ state: 'legacy_unbudgeted', manifest_fingerprint: null }, { state: 'ready', manifest_fingerprint: null }])
    expect(readPortableCurrentAuthority({ database: getProjectDb()!, projectStorageRoot: path.join(secondTarget, '.ai-novel'), projectId: second.targetProjectId })).not.toBeNull()
  })

  it('round-trips schema 18 budget history twice and rejects an archive missing its budget freeze', async () => {
    const f = fixture(), db = getProjectDb()!
    seedRoot(db, 'budget-root')
    seedBudget(db, 'budget-root')
    seedRoot(db, 'budget-child', false, 'budget-root')
    db.prepare(`UPDATE import_runs SET root_run_id='budget-root',effect_namespace=?,source_fingerprint=?,manifest_fingerprint=?
      WHERE id='budget-child'`).run('import:budget-root', hash('source:budget-root'), hash('manifest:budget-root'))
    closeProjectDatabase()
    const sourceBytes = fs.readFileSync(f.databasePath), copyPath = path.join(f.base, 'sanitized.db')
    fs.copyFileSync(f.databasePath, copyPath, fs.constants.COPYFILE_EXCL)
    const sanitized = sanitizePortableDatabase(copyPath)
    const records = sanitized.history.filter(item => item.table !== 'reference_embedding_budgets')
    const incomplete = await writeTestArchive({ ...f, databasePath: copyPath, name: 'missing-budget-freeze',
      sourceVersion: 19, authorityVersion: 19, records })
    await expect(restorePortableProject({ archivePath: incomplete, targetProjectRoot: path.join(f.base, 'missing-budget-target') })).rejects.toThrow()
    const noBinding = await writeTestArchive({ ...f, databasePath: copyPath, name: 'missing-binding-freeze',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history.filter(item => item.table !== 'reference_import_manifest_chapters') })
    await expect(restorePortableProject({ archivePath: noBinding, targetProjectRoot: path.join(f.base, 'missing-binding-target') })).rejects.toThrow()
    const noBindingRowPath = path.join(f.base, 'missing-binding-row.db')
    fs.copyFileSync(copyPath, noBindingRowPath, fs.constants.COPYFILE_EXCL)
    const noBindingRow = new Database(noBindingRowPath)
    try { noBindingRow.prepare('DELETE FROM reference_import_manifest_chapters').run() } finally { noBindingRow.close() }
    const noBindingRowArchive = await writeTestArchive({ ...f, databasePath: noBindingRowPath, name: 'missing-binding-row',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history })
    await expect(restorePortableProject({ archivePath: noBindingRowArchive, targetProjectRoot: path.join(f.base, 'missing-binding-row-target') })).rejects.toThrow()
    const noBindingOrFreeze = await writeTestArchive({ ...f, databasePath: noBindingRowPath, name: 'missing-binding-and-freeze',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history.filter(item => item.table !== 'reference_import_manifest_chapters') })
    await expect(restorePortableProject({ archivePath: noBindingOrFreeze, targetProjectRoot: path.join(f.base, 'missing-binding-and-freeze-target') })).rejects.toThrow()
    const partialLineagePath = path.join(f.base, 'partial-lineage.db')
    fs.copyFileSync(copyPath, partialLineagePath, fs.constants.COPYFILE_EXCL)
    const partialLineage = new Database(partialLineagePath)
    try { partialLineage.prepare("DELETE FROM reference_import_manifest_chapters WHERE import_run_id='budget-child'").run() } finally { partialLineage.close() }
    const partialLineageArchive = await writeTestArchive({ ...f, databasePath: partialLineagePath, name: 'partial-lineage',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history.filter(item =>
        item.table !== 'reference_import_manifest_chapters' || item.recordId !== 'budget-child:1') })
    await expect(restorePortableProject({ archivePath: partialLineageArchive, targetProjectRoot: path.join(f.base, 'partial-lineage-target') })).rejects.toThrow()
    const wrongSizePath = path.join(f.base, 'wrong-manifest-size.db')
    fs.copyFileSync(copyPath, wrongSizePath, fs.constants.COPYFILE_EXCL)
    const wrongSize = new Database(wrongSizePath)
    try { wrongSize.prepare('UPDATE import_runs SET manifest_content_size=manifest_content_size+1').run() } finally { wrongSize.close() }
    const wrongSizeArchive = await writeTestArchive({ ...f, databasePath: wrongSizePath, name: 'wrong-manifest-size',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history })
    await expect(restorePortableProject({ archivePath: wrongSizeArchive, targetProjectRoot: path.join(f.base, 'wrong-manifest-size-target') })).rejects.toThrow()
    const brokenPath = path.join(f.base, 'broken-reference.db')
    fs.copyFileSync(copyPath, brokenPath, fs.constants.COPYFILE_EXCL)
    const broken = new Database(brokenPath)
    try {
      broken.pragma('foreign_keys = OFF')
      broken.prepare("UPDATE reference_import_manifest_chapters SET snapshot_run_id='missing-snapshot'").run()
    } finally { broken.close() }
    const brokenArchive = await writeTestArchive({ ...f, databasePath: brokenPath, name: 'broken-reference',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history })
    await expect(restorePortableProject({ archivePath: brokenArchive, targetProjectRoot: path.join(f.base, 'broken-reference-target') })).rejects.toThrow()
    const disguised = await writeTestArchive({ ...f, databasePath: copyPath, name: 'disguised-schema',
      sourceVersion: 17, authorityVersion: 17, records })
    await expect(restorePortableProject({ archivePath: disguised, targetProjectRoot: path.join(f.base, 'disguised-target') })).rejects.toThrow()
    let sourceRoot = f.root, sourceProjectId: string = f.projectId
    for (let generation = 0; generation < 2; generation += 1) {
      const archive = await exportArchive(f.base, sourceRoot, sourceProjectId, `current-${generation}`)
      const target = path.join(f.base, `current-target-${generation}`)
      const restored = await restorePortableProject({ archivePath: archive, targetProjectRoot: target })
      initProjectDatabase(target)
      expect(getProjectDb()!.prepare('SELECT manifest_fingerprint,spent_requests,active_elapsed_ms,state FROM reference_embedding_budgets WHERE root_run_id=?')
        .get('budget-root')).toEqual({ manifest_fingerprint: null, spent_requests: 1, active_elapsed_ms: 5, state: 'ready' })
      const guard = readPortableRuntimeFreeze(target)
      expect(guard.isFrozen('import_runs', 'budget-root')).toBe(true)
      expect(guard.isFrozen('reference_embedding_budgets', 'budget-root')).toBe(true)
      expect(guard.isFrozen('reference_import_manifest_chapters', 'budget-root:1')).toBe(true)
      expect(getProjectDb()!.pragma('foreign_key_check')).toEqual([])
      expect(() => guard.assertMutable('reference_embedding_budgets', 'budget-root')).toThrow('PORTABLE_RUNTIME_FROZEN')
      expect(readPortableCurrentAuthority({ database: getProjectDb()!, projectStorageRoot: path.join(target, '.ai-novel'), projectId: restored.targetProjectId })).not.toBeNull()
      closeProjectDatabase()
      sourceRoot = target
      sourceProjectId = restored.targetProjectId
    }
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBytes)
  })

  it('restores schema18 history without inventing a query plan', async () => {
    const f = fixture()
    seedRoot(getProjectDb()!, 'old-query-root')
    closeProjectDatabase()
    const sourceBytes = fs.readFileSync(f.databasePath), copyPath = path.join(f.base, 'schema18.db')
    fs.copyFileSync(f.databasePath, copyPath, fs.constants.COPYFILE_EXCL)
    const sanitized = sanitizePortableDatabase(copyPath)
    const old = new Database(copyPath)
    try {
      old.exec('DROP TABLE import_query_topics; DROP TABLE import_query_plans')
      old.pragma('user_version=18')
      expect(verifySchema(new SqliteSchemaAdapter(old), getDesktopMigrationRegistry(), 18).version).toBe(18)
    } finally { old.close() }
    const archive = await writeTestArchive({ ...f, databasePath: copyPath, name: 'query-old', sourceVersion: 18,
      authorityVersion: 18, records: sanitized.history })
    const target = path.join(f.base, 'query-old-target')
    await restorePortableProject({ archivePath: archive, targetProjectRoot: target })
    initProjectDatabase(target)
    expect(getProjectDb()!.prepare('SELECT * FROM import_query_plans').all()).toEqual([])
    expect(getProjectDb()!.prepare('SELECT * FROM import_query_topics').all()).toEqual([])
    expect(readPortableRuntimeFreeze(target).isFrozen('import_runs', 'old-query-root')).toBe(true)
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBytes)
  })

  it('rejects a query topic removed from the database while its freeze remains', async () => {
    const f = fixture(), db = getProjectDb()!
    seedRoot(db, 'query-root')
    seedQuery(db, 'query-root')
    closeProjectDatabase()
    const sourceBytes = fs.readFileSync(f.databasePath), copyPath = path.join(f.base, 'query-orphan-freeze.db')
    fs.copyFileSync(f.databasePath, copyPath, fs.constants.COPYFILE_EXCL)
    const sanitized = sanitizePortableDatabase(copyPath)
    const broken = new Database(copyPath)
    try { broken.prepare("DELETE FROM import_query_topics WHERE topic_key='style'").run() } finally { broken.close() }
    const archive = await writeTestArchive({ ...f, databasePath: copyPath, name: 'query-orphan-freeze',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history })
    await expect(restorePortableProject({ archivePath: archive, targetProjectRoot: path.join(f.base, 'query-orphan-freeze-target') })).rejects.toThrow()
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBytes)
  })

  it('rejects orphan query freezes after the entire plan and its topics are removed', async () => {
    const f = fixture(), db = getProjectDb()!
    seedRoot(db, 'query-root')
    seedQuery(db, 'query-root')
    closeProjectDatabase()
    const sourceBytes = fs.readFileSync(f.databasePath), copyPath = path.join(f.base, 'query-orphan-plan.db')
    fs.copyFileSync(f.databasePath, copyPath, fs.constants.COPYFILE_EXCL)
    const sanitized = sanitizePortableDatabase(copyPath)
    expect(sanitized.history.filter(item => item.table === 'import_query_plans')).toHaveLength(1)
    expect(sanitized.history.filter(item => item.table === 'import_query_topics')).toHaveLength(4)
    const broken = new Database(copyPath)
    try {
      broken.exec('DELETE FROM import_query_topics; DELETE FROM import_query_plans')
      expect(broken.prepare('SELECT count(*) FROM import_query_plans').pluck().get()).toBe(0)
      expect(broken.prepare('SELECT count(*) FROM import_query_topics').pluck().get()).toBe(0)
      expect(verifySchema(new SqliteSchemaAdapter(broken), getDesktopMigrationRegistry(), 19).version).toBe(19)
    } finally { broken.close() }
    const archive = await writeTestArchive({ ...f, databasePath: copyPath, name: 'query-orphan-plan',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history })
    await expect(restorePortableProject({ archivePath: archive, targetProjectRoot: path.join(f.base, 'query-orphan-plan-target') }))
      .rejects.toThrow('PORTABLE_TRANSFER_AUTHORITY_INVALID')
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBytes)
  })

  it('projects query history through two actual restores and rejects missing topic or parent freezes', async () => {
    const f = fixture(), db = getProjectDb()!
    seedRoot(db, 'query-root')
    seedQuery(db, 'query-root')
    closeProjectDatabase()
    const sourceBytes = fs.readFileSync(f.databasePath), copyPath = path.join(f.base, 'query-sanitized.db')
    fs.copyFileSync(f.databasePath, copyPath, fs.constants.COPYFILE_EXCL)
    const sanitized = sanitizePortableDatabase(copyPath)
    for (const missing of ['import_query_plans', 'import_query_topics', 'generation_runs', 'generation_roots', 'import_runs']) {
      const archive = await writeTestArchive({ ...f, databasePath: copyPath, name: `query-missing-${missing}`,
        sourceVersion: 19, authorityVersion: 19, records: sanitized.history.filter(item => item.table !== missing) })
      await expect(restorePortableProject({ archivePath: archive, targetProjectRoot: path.join(f.base, `target-${missing}`) })).rejects.toThrow()
    }
    const missingPath = path.join(f.base, 'query-missing-row.db')
    fs.copyFileSync(copyPath, missingPath, fs.constants.COPYFILE_EXCL)
    const broken = new Database(missingPath)
    try { broken.prepare("DELETE FROM import_query_topics WHERE topic_key='style'").run() } finally { broken.close() }
    const missingArchive = await writeTestArchive({ ...f, databasePath: missingPath, name: 'query-missing-row',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history.filter(item => item.recordId !== importQueryId('query-root', 'style')) })
    await expect(restorePortableProject({ archivePath: missingArchive, targetProjectRoot: path.join(f.base, 'query-missing-row-target') })).rejects.toThrow()
    const unsafePath = path.join(f.base, 'query-unsafe-receipt.db')
    fs.copyFileSync(copyPath, unsafePath, fs.constants.COPYFILE_EXCL)
    const unsafe = new Database(unsafePath)
    try { unsafe.prepare("UPDATE import_query_topics SET receipt_json=json_set(receipt_json,'$.snapshot.registryHash',?) WHERE topic_key='worldview'").run(hash('private-registry')) }
    finally { unsafe.close() }
    const unsafeArchive = await writeTestArchive({ ...f, databasePath: unsafePath, name: 'query-unsafe-receipt',
      sourceVersion: 19, authorityVersion: 19, records: sanitized.history })
    await expect(restorePortableProject({ archivePath: unsafeArchive, targetProjectRoot: path.join(f.base, 'query-unsafe-target') })).rejects.toThrow()
    let sourceRoot = f.root, sourceProjectId: string = f.projectId
    for (let generation = 0; generation < 2; generation += 1) {
      const archive = await exportArchive(f.base, sourceRoot, sourceProjectId, `query-${generation}`)
      const target = path.join(f.base, `query-target-${generation}`)
      const restored = await restorePortableProject({ archivePath: archive, targetProjectRoot: target })
      initProjectDatabase(target)
      const restoredDb = getProjectDb()!, guard = readPortableRuntimeFreeze(target)
      expect(restoredDb.prepare('SELECT manifest_fingerprint,binding_json,binding_fingerprint FROM import_query_plans WHERE import_root_run_id=?').get('query-root'))
        .toEqual({ manifest_fingerprint: null, binding_json: null, binding_fingerprint: null })
      const topics = restoredDb.prepare('SELECT topic_key,receipt_json,receipt_fingerprint FROM import_query_topics WHERE import_root_run_id=? ORDER BY topic_key').all('query-root') as Array<{
        topic_key: string; receipt_json: string | null; receipt_fingerprint: string | null
      }>
      expect(topics).toHaveLength(4)
      const material = JSON.parse(topics.find(topic => topic.topic_key === 'worldview')!.receipt_json!)
      expect(material.snapshot.results[0].text).toBe('Fictional material')
      expect(material.snapshot).not.toHaveProperty('registryHash')
      expect(material.snapshot).not.toHaveProperty('projectStorageRoot')
      expect(material.snapshot).not.toHaveProperty('runtimeEpoch')
      expect(JSON.parse(topics.find(topic => topic.topic_key === 'protagonist')!.receipt_json!)).toEqual({ version: 1, state: 'unavailable' })
      expect(topics.every(topic => topic.receipt_fingerprint === null)).toBe(true)
      for (const [table, id] of [['import_runs', 'query-root'], ['generation_runs', 'generation-query-root'],
        ['generation_roots', 'action-query-root'], ['import_query_plans', 'query-root'],
        ['import_query_topics', importQueryId('query-root', 'worldview')]] as const) expect(guard.isFrozen(table, id)).toBe(true)
      if (generation === 0) {
        seedRoot(restoredDb, 'fresh-query-root')
        seedQuery(restoredDb, 'fresh-query-root')
        expect(guard.isFrozen('import_query_plans', 'fresh-query-root')).toBe(false)
        expect(readPortableCurrentAuthority({ database: restoredDb, projectStorageRoot: path.join(target, '.ai-novel'),
          projectId: restored.targetProjectId })).not.toBeNull()
      } else {
        expect(restoredDb.prepare('SELECT count(*) FROM import_query_topics WHERE import_root_run_id=?').pluck().get('fresh-query-root')).toBe(4)
        expect(guard.isFrozen('import_query_plans', 'fresh-query-root')).toBe(true)
      }
      closeProjectDatabase()
      sourceRoot = target
      sourceProjectId = restored.targetProjectId
    }
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBytes)
  })
})

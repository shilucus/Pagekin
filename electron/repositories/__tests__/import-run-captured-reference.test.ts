import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getProjectDb } from '../../database'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ImportRunRepository } from '../import-run-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import type { ImportRunExecutionAuthority, ImportRunPrepareRequest } from '../../../src/shared/import-run'
import { countDraftUnits } from '../../../src/shared/draft-units'

const RUN_ID = 'fictional-shared-import-run'
const OWNER = 'fictional-shared-import-owner'
const base = path.resolve('.runtime/creation-runtime-modernization/stage-6a-captured-reference-tests')
const runtimes: ProjectRuntime[] = []
let root = ''

type Binding = ReturnType<typeof ImportRunRepository.resolveReferenceImportAuthority>
interface Book {
  runtime: ProjectRuntime
  database: Database.Database
  authority: ImportRunExecutionAuthority
  binding: Binding
}
let a: Book
let b: Book

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function request(content: string): ImportRunPrepareRequest {
  return {
    runId: RUN_ID, purpose: 'reference', sourceFingerprint: hash(`source:${content}`), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional-reference.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'Fictional chapter', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }],
  }
}

function openReferenceBook(name: string, content: string): Book {
  openCanonicalProjectFixture(path.join(root, name))
  const runtime = projectRuntimeHost.getActiveView()!
  runtimes.push(runtime)
  ImportRunRepository.prepare(request(content))
  const execution = ImportRunRepository.startOrResume(RUN_ID, OWNER, Date.now(), 60_000).execution
  const authority = { owner: execution.owner, epoch: execution.epoch }
  const binding = ImportRunRepository.resolveReferenceImportAuthority(RUN_ID, authority, 1)
  return { runtime, database: runtime.database, authority, binding }
}

function verifiedCleanupRoot(): string {
  const assertChild = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
    }
  }
  const workspace = path.resolve('.')
  const absoluteRoot = path.resolve(root)
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  assertChild(workspace, base)
  assertChild(base, absoluteRoot)
  for (let directory = absoluteRoot; ; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
      throw new Error('FICTIONAL_CLEANUP_LINK')
    }
    if (normalized(directory) === normalized(workspace)) break
  }
  const realRoot = fs.realpathSync.native(absoluteRoot)
  assertChild(fs.realpathSync.native(base), realRoot)
  const pending = [absoluteRoot]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const realTarget = fs.realpathSync.native(target)
      if (fs.lstatSync(target).isSymbolicLink() || normalized(realTarget) !== normalized(target)) {
        throw new Error('FICTIONAL_CLEANUP_LINK')
      }
      assertChild(realRoot, realTarget)
      if (entry.isDirectory()) pending.push(target)
    }
  }
  return absoluteRoot
}

beforeEach(() => {
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'fictional-'))
  a = openReferenceBook('a', 'Fictional reference material A')
  b = openReferenceBook('b', 'Different fictional reference material B')
  expect(a.authority).toEqual(b.authority)
  expect(a.database).not.toBe(b.database)
  expect(getProjectDb()).toBe(b.database)
})

afterEach(() => {
  for (const runtime of runtimes.splice(0).reverse()) projectRuntimeHost.releaseIdle(runtime)
  if (root) fs.rmSync(verifiedCleanupRoot(), { recursive: true, force: true })
  root = ''
})

function referenceState(database: Database.Database) {
  return {
    runs: database.prepare('SELECT * FROM import_runs ORDER BY id').all(),
    chapters: database.prepare('SELECT * FROM import_run_chapters ORDER BY run_id, chapter_number').all(),
    documents: database.prepare('SELECT * FROM import_reference_documents ORDER BY document_id').all(),
    receipts: database.prepare('SELECT * FROM import_run_knowledge_receipts ORDER BY run_id, chapter_number').all(),
  }
}

function documentId(binding: Binding): string {
  return hash(`reference-import:${binding.stableKey}`)
}

function seedDocument(database: Database.Database, binding: Binding, contentHash = binding.contentFingerprint, state = 'committed'): void {
  database.prepare(`
    INSERT INTO import_reference_documents (
      document_id, idempotency_key_hash, content_hash, chunk_set_hash,
      expected_chunk_count, corpus_kind, state
    ) VALUES (?, ?, ?, ?, 1, 'reference', ?)
  `).run(documentId(binding), hash(binding.stableKey), contentHash, hash('fictional-chunk-set'), state)
}

function resolveA(now?: number): Binding {
  return ImportRunRepository.resolveReferenceImportAuthority(RUN_ID, a.authority, 1, now, a.database)
}

function commitA(id = documentId(a.binding)): void {
  ImportRunRepository.commitReferenceImportReceipt(RUN_ID, a.authority, 1, id, a.database)
}

describe('captured reference-import SQLite seam', () => {
  it('resolves, commits and replays only A while the distinct same-authority B is current', () => {
    seedDocument(a.database, a.binding)
    seedDocument(b.database, b.binding)
    const insertTransactions: boolean[] = []
    a.database.function('observe_captured_reference_transaction', () => {
      insertTransactions.push(a.database.inTransaction)
      return 1
    })
    a.database.exec(`
      CREATE TEMP TRIGGER observe_reference_receipt_insert BEFORE INSERT ON import_run_knowledge_receipts
      BEGIN SELECT observe_captured_reference_transaction(); END
    `)
    const beforeA = referenceState(a.database)
    const beforeB = referenceState(b.database)

    expect(resolveA()).toEqual(a.binding)
    expect(resolveA().content).not.toBe(b.binding.content)
    expect(() => ImportRunRepository.assertExecutionAuthority(RUN_ID, a.authority, undefined, a.database)).not.toThrow()
    commitA()
    const committed = referenceState(a.database)
    expect(committed).toEqual({ ...beforeA, receipts: [expect.objectContaining({
      run_id: RUN_ID, chapter_number: 1, purpose: 'reference', document_id: documentId(a.binding),
      content_fingerprint: a.binding.contentFingerprint, state: 'committed',
    })] })
    commitA()
    expect(referenceState(a.database)).toEqual(committed)
    expect(insertTransactions).toEqual([true])
    expect(referenceState(b.database)).toEqual(beforeB)
    expect(getProjectDb()).toBe(b.database)
  })

  it('preserves the omitted-database B branch without touching A', () => {
    seedDocument(b.database, b.binding)
    const beforeA = referenceState(a.database)
    expect(ImportRunRepository.resolveReferenceImportAuthority(RUN_ID, b.authority, 1)).toEqual(b.binding)
    expect(() => ImportRunRepository.assertExecutionAuthority(RUN_ID, b.authority)).not.toThrow()
    ImportRunRepository.commitReferenceImportReceipt(RUN_ID, b.authority, 1, documentId(b.binding))
    expect(referenceState(b.database).receipts).toEqual([expect.objectContaining({ document_id: documentId(b.binding) })])
    expect(referenceState(a.database)).toEqual(beforeA)
  })

  it('preserves the fourth now argument, including the exact lease-expiry boundary', () => {
    const row = a.database.prepare('SELECT lease_expires_at AS expiry FROM import_runs WHERE id = ?')
      .get(RUN_ID) as { expiry: number }
    expect(resolveA(row.expiry - 1)).toEqual(a.binding)
    expect(() => resolveA(row.expiry)).toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(() => ImportRunRepository.assertExecutionAuthority(RUN_ID, a.authority, row.expiry, a.database))
      .toThrow('IMPORT_RUN_EXECUTION_STALE')
  })

  it.each([
    ['missing run', 'DELETE FROM import_runs', 'IMPORT_RUN_EXECUTION_STALE'],
    ['stale owner', "UPDATE import_runs SET execution_owner = 'another-owner'", 'IMPORT_RUN_EXECUTION_STALE'],
    ['stale epoch', 'UPDATE import_runs SET execution_epoch = execution_epoch + 1', 'IMPORT_RUN_EXECUTION_STALE'],
    ['expired lease', 'UPDATE import_runs SET lease_expires_at = 0', 'IMPORT_RUN_EXECUTION_STALE'],
    ['nonrunning status', "UPDATE import_runs SET status = 'failed'", 'IMPORT_RUN_EXECUTION_STALE'],
    ['cancel requested', 'UPDATE import_runs SET cancel_requested = 1', 'IMPORT_RUN_CANCELLED'],
    ['wrong stage', "UPDATE import_runs SET stage = 'global'", 'IMPORT_RUN_REFERENCE_UNBOUND'],
    ['missing chapter', 'DELETE FROM import_run_chapters', 'IMPORT_RUN_REFERENCE_UNBOUND'],
    ['corrupt snapshot hash', "UPDATE import_run_chapters SET content_snapshot = replace(content_snapshot, 'A', 'Z')", 'IMPORT_RUN_SNAPSHOT_CORRUPT'],
    ['corrupt snapshot byte size', 'UPDATE import_run_chapters SET content_size = content_size + 1', 'IMPORT_RUN_SNAPSHOT_CORRUPT'],
  ])('rejects invalid captured A (%s) even when current B remains valid', (_name, sql, code) => {
    seedDocument(a.database, a.binding)
    const beforeB = referenceState(b.database)
    if (_name === 'missing chapter') {
      expect(() => a.database.exec(sql)).toThrow('FOREIGN KEY constraint failed')
      a.database.prepare('DELETE FROM reference_import_manifest_chapters WHERE import_run_id=? AND chapter_number=1').run(RUN_ID)
    }
    a.database.exec(sql)
    const invalidA = referenceState(a.database)

    expect(() => resolveA()).toThrow(code)
    expect(() => commitA()).toThrow(code)
    if (code === 'IMPORT_RUN_EXECUTION_STALE') {
      expect(() => ImportRunRepository.assertExecutionAuthority(RUN_ID, a.authority, undefined, a.database)).toThrow(code)
    }
    expect(referenceState(a.database)).toEqual(invalidA)
    expect(ImportRunRepository.resolveReferenceImportAuthority(RUN_ID, b.authority, 1)).toEqual(b.binding)
    expect(referenceState(b.database)).toEqual(beforeB)
  })

  it.each([
    ['missing document', 'missing'],
    ['wrong document ID', 'id'],
    ['wrong content hash', 'hash'],
    ['uncommitted document', 'state'],
  ])('rejects %s without partial writes or using a matching document in B', (_name, failure) => {
    seedDocument(b.database, a.binding)
    if (failure !== 'missing') {
      seedDocument(a.database, a.binding, failure === 'hash' ? hash('wrong material') : a.binding.contentFingerprint,
        failure === 'state' ? 'prepared' : 'committed')
    }
    const beforeA = referenceState(a.database)
    const beforeB = referenceState(b.database)
    expect(() => commitA(failure === 'id' ? hash('another document') : documentId(a.binding)))
      .toThrow('IMPORT_RUN_REFERENCE_DOCUMENT_INCOMPLETE')
    expect(referenceState(a.database)).toEqual(beforeA)
    expect(referenceState(b.database)).toEqual(beforeB)
  })

  it.each([
    ['document ID', 'document_id', hash('another document')],
    ['purpose', 'purpose', 'author-manuscript'],
    ['source ID', 'source_id', 'another-source'],
    ['source chapter', 'source_chapter_number', 2],
    ['content fingerprint', 'content_fingerprint', hash('another material')],
  ])('rejects a conflicting receipt %s without changing either database', (_name, column, value) => {
    seedDocument(a.database, a.binding)
    commitA()
    // Column identifiers are this closed test matrix, never imported input.
    a.database.prepare(`UPDATE import_run_knowledge_receipts SET ${column} = ? WHERE run_id = ?`).run(value, RUN_ID)
    const beforeA = referenceState(a.database)
    const beforeB = referenceState(b.database)
    expect(() => commitA()).toThrow('IMPORT_RUN_REFERENCE_RECEIPT_CONFLICT')
    expect(referenceState(a.database)).toEqual(beforeA)
    expect(referenceState(b.database)).toEqual(beforeB)
  })

  it('rejects a real author-manuscript run at the reference seam', () => {
    openCanonicalProjectFixture(path.join(root, 'author'))
    const runtime = projectRuntimeHost.getActiveView()!
    runtimes.push(runtime)
    const content = 'Fictional author manuscript'
    const preview = FinalizedDraftImportRepository.preview([{
      chapterNumber: 1, title: 'Fictional chapter', content, wordCount: countDraftUnits(content),
    }])
    ImportRunRepository.prepare({ ...request(content), purpose: 'author-manuscript',
      authorityFingerprint: preview.authorityFingerprint, expectedManifestFingerprint: preview.manifestFingerprint })
    const authority = ImportRunRepository.startOrResume(RUN_ID, OWNER, Date.now(), 60_000).execution
    projectRuntimeHost.activateView(b.runtime)
    const before = referenceState(runtime.database)
    const beforeB = referenceState(b.database)

    expect(() => ImportRunRepository.resolveReferenceImportAuthority(RUN_ID, authority, 1, undefined, runtime.database))
      .toThrow('IMPORT_RUN_REFERENCE_UNBOUND')
    expect(() => ImportRunRepository.commitReferenceImportReceipt(RUN_ID, authority, 1, documentId(b.binding), runtime.database))
      .toThrow('IMPORT_RUN_REFERENCE_UNBOUND')
    expect(referenceState(runtime.database)).toEqual(before)
    expect(referenceState(b.database)).toEqual(beforeB)
  })

  it('rejects malformed document IDs before resolving a missing current database', () => {
    projectRuntimeHost.activateView(null)
    expect(() => ImportRunRepository.commitReferenceImportReceipt(RUN_ID, a.authority, 1, 'invalid'))
      .toThrow('IMPORT_RUN_REFERENCE_DOCUMENT_INVALID')
    expect(() => ImportRunRepository.commitReferenceImportReceipt(RUN_ID, a.authority, 1, documentId(a.binding)))
      .toThrow('PROJECT_NOT_OPEN')
  })
})

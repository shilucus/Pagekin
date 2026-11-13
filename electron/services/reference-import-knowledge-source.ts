import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Connection, Table } from '@lancedb/lancedb'
import { openLanceDatabase } from '../lance-database'
import { isDocumentCopyIndexCurrent, searchWithOriginalHits, type EmbeddingSpaceIdentity, type KnowledgeCorpusKind, type SearchResult } from '../vector-store'
import { getProjectDataRoot } from './project-data-locator'
import { withKnowledgeSourceGate } from './knowledge-source-gate'

type Row = Record<string, unknown>
const fail = (code: string): never => { throw new Error(`REFERENCE_IMPORT_KNOWLEDGE_${code}`) }
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`
const string = (value: unknown): string => typeof value === 'string' && value.length > 0 ? value : fail('INVALID_ROW')
const integer = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail('INVALID_ROW')
const corpus = (value: unknown): KnowledgeCorpusKind => value === undefined ? 'unknown'
  : value === 'reference' || value === 'project-knowledge' || value === 'unknown' ? value : fail('INVALID_CORPUS')

export interface ReferenceImportKnowledgeItem extends SearchResult {
  chunkId: string
  documentId: string
  chunkIndex: number
  corpusKind: KnowledgeCorpusKind
  contentHash: string
  documentChunkSetHash: string
  documentChunks: Array<{ chunkId: string; chunkIndex: number; contentHash: string }>
}
export interface ReferenceImportKnowledgeSnapshot {
  version: 1
  state: 'empty' | 'stored'
  projectStorageRoot: string
  runtimeEpoch: string
  query: string
  topK: number
  storageState: 'absent' | 'empty' | 'present'
  canonicalRevision: number | null
  documentsRevision: number | null
  tableRevisions: Array<{ tableName: string; revision: number }>
  registryHash: string | null
  results: SearchResult[]
  items: ReferenceImportKnowledgeItem[]
}

function physicalDirectory(directory: string): void {
  const stat = fs.lstatSync(directory)
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(fs.realpathSync.native(directory)) !== normalize(directory)) fail('UNSAFE_ROOT')
}
function registryBytes(root: string): string | null {
  const file = path.join(root, 'embedding-spaces.json')
  if (!fs.existsSync(file)) return null
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_REGISTRY')
  return fs.readFileSync(file, 'utf8')
}
function assertStorage(root: string): void {
  if (!path.isAbsolute(root)) fail('ABSOLUTE_ROOT_REQUIRED')
  physicalDirectory(root)
  if (['vectors.json', 'vectors.json.migration-journal.json'].some(name => fs.existsSync(path.join(root, name)))) fail('LEGACY_PENDING')
  const directory = path.join(root, 'lancedb')
  if (fs.existsSync(directory)) physicalDirectory(directory)
  registryBytes(root)
}
interface Reader {
  root: string
  state: ReferenceImportKnowledgeSnapshot['storageState']
  chunks?: Table
  documents?: Table
  tableRevisions: ReferenceImportKnowledgeSnapshot['tableRevisions']
  registryHash: string | null
}

/** Dedicated pinned handles are closed before captured work can release its native runtime. */
async function readStable<T>(root: string, assertActive: () => void, operation: (reader: Reader) => Promise<T>): Promise<T> {
  let connection: Connection | undefined
  const pinned: Array<{ tableName: string; table: Table; revision: number }> = []
  let result!: T
  let operationFailure: { error: unknown } | undefined
  let closeFailure: { error: unknown } | undefined
  try {
    assertActive()
    assertStorage(root)
    const registry = registryBytes(root)
    const directory = path.join(root, 'lancedb')
    const reader: Reader = { root, state: 'absent', tableRevisions: [], registryHash: registry === null ? null : hash(registry) }
    let names: string[] = []
    if (fs.existsSync(directory)) {
      connection = await openLanceDatabase(directory)
      assertActive()
      names = (await connection.tableNames()).sort()
      assertActive()
      if (names.includes('chunks') !== names.includes('documents')) fail('INCOMPLETE_TABLES')
      reader.state = names.includes('chunks') ? 'present' : 'empty'
      for (const tableName of names) {
        const table = await connection.openTable(tableName)
        const entry = { tableName, table, revision: 0 }
        pinned.push(entry)
        assertActive()
        entry.revision = integer(await table.version())
        assertActive()
        await table.checkout(entry.revision)
        assertActive()
        reader.tableRevisions.push({ tableName, revision: entry.revision })
        if (tableName === 'chunks') reader.chunks = table
        if (tableName === 'documents') reader.documents = table
      }
    }
    result = await operation(reader)
    assertActive()
    for (const entry of pinned) {
      await entry.table.checkoutLatest()
      assertActive()
      const revision = await entry.table.version()
      assertActive()
      if (revision !== entry.revision) fail('CHANGED_DURING_READ')
    }
    assertStorage(root)
    if (registryBytes(root) !== registry) fail('CHANGED_DURING_READ')
    if (connection) {
      const currentNames = (await connection.tableNames()).sort()
      assertActive()
      if (!isDeepStrictEqual(currentNames, names)) fail('CHANGED_DURING_READ')
    } else if (fs.existsSync(directory)) fail('CHANGED_DURING_READ')
  } catch (error) {
    operationFailure = { error }
  } finally {
    for (const entry of pinned.reverse()) {
      try { entry.table.close() } catch (error) { closeFailure ??= { error } }
    }
    try { connection?.close() } catch (error) { closeFailure ??= { error } }
  }
  if (operationFailure) throw operationFailure.error
  if (closeFailure) throw closeFailure.error
  return result
}

async function sourceItem(reader: Reader, original: Row, score: number, assertActive: () => void): Promise<ReferenceImportKnowledgeItem> {
  if (!reader.chunks || !reader.documents) fail('DOCUMENT_INCOMPLETE')
  if (!Number.isFinite(score)) fail('INVALID_SCORE')
  const chunkId = string(original.id)
  const canonical = await reader.chunks!.query().where(`id = ${quote(chunkId)}`).toArray()
  assertActive()
  if (canonical.length !== 1) fail('SOURCE_MISMATCH')
  const row = canonical[0]
  if (['docId', 'text', 'fileName', 'chunkIndex', 'totalChunks'].some(key => !isDeepStrictEqual(row[key], original[key]))
    || corpus(row.corpusKind) !== corpus(original.corpusKind)) fail('SOURCE_MISMATCH')
  const documentId = string(row.docId), fileName = string(row.fileName), text = string(row.text)
  const chunkIndex = integer(row.chunkIndex), kind = corpus(row.corpusKind)
  const documents = await reader.documents!.query().where(`id = ${quote(documentId)}`).toArray()
  assertActive()
  if (documents.length !== 1) fail('DOCUMENT_INCOMPLETE')
  if (!isDocumentCopyIndexCurrent(reader.root, documentId, documents[0].filePath)) fail('SOURCE_STALE')
  const chunks = await reader.chunks!.query().where(`\`docId\` = ${quote(documentId)}`).toArray()
  assertActive()
  const ordered = chunks.sort((left, right) => integer(left.chunkIndex) - integer(right.chunkIndex))
  if (!ordered.length || integer(documents[0].chunkCount) !== ordered.length
    || string(documents[0].fileName) !== fileName || corpus(documents[0].corpusKind) !== kind
    || new Set(ordered.map(item => string(item.id))).size !== ordered.length
    || ordered.some((item, index) => integer(item.chunkIndex) !== index || integer(item.totalChunks) !== ordered.length
      || string(item.fileName) !== fileName || corpus(item.corpusKind) !== kind || typeof item.text !== 'string')) fail('DOCUMENT_INCOMPLETE')
  return {
    text, fileName, score, chunkId, documentId, chunkIndex, corpusKind: kind, contentHash: hash(text),
    documentChunkSetHash: hash(JSON.stringify(ordered.map(item => item.text))),
    documentChunks: ordered.map(item => ({ chunkId: string(item.id), chunkIndex: integer(item.chunkIndex), contentHash: hash(item.text as string) })),
  }
}

export async function captureReferenceImportKnowledge(input: {
  projectPath: string; runtimeEpoch: string; query: string; topK?: number; queryVector?: number[]
  embeddingSpace?: EmbeddingSpaceIdentity; assertActive: () => void
}): Promise<ReferenceImportKnowledgeSnapshot> {
  const topK = input.topK ?? 5
  if (typeof input.query !== 'string' || !Number.isSafeInteger(topK) || topK < 1 || topK > 100) fail('INVALID_REQUEST')
  input.assertActive()
  const root = getProjectDataRoot(input.projectPath)
  return withKnowledgeSourceGate(root, async () => {
    input.assertActive()
    assertStorage(root)
    const selected = await searchWithOriginalHits(input.projectPath, input.query, input.queryVector, topK, input.embeddingSpace)
    input.assertActive()
    if (selected.failed) fail('SEARCH_UNAVAILABLE')
    return readStable<ReferenceImportKnowledgeSnapshot>(root, input.assertActive, async reader => {
      if (!isDeepStrictEqual(reader.tableRevisions.map(entry => entry.tableName), selected.tableNames)
        || reader.registryHash !== selected.registryHash
        || selected.tableRevisions.some(expected => !reader.tableRevisions.some(actual => isDeepStrictEqual(actual, expected)))) fail('CHANGED_DURING_READ')
      if (selected.results.length !== selected.hits.length || new Set(selected.hits.map(hit => hit.row.id)).size !== selected.hits.length) fail('DUPLICATE_CHUNK')
      const items: ReferenceImportKnowledgeItem[] = []
      for (const hit of selected.hits) {
        const item = await sourceItem(reader, hit.row, hit.result.score, input.assertActive)
        if (!isDeepStrictEqual({ text: item.text, score: item.score, fileName: item.fileName }, hit.result)) fail('SOURCE_MISMATCH')
        items.push(item)
      }
      return {
        version: 1, state: items.length ? 'stored' : 'empty', projectStorageRoot: root, runtimeEpoch: input.runtimeEpoch,
        query: input.query, topK, storageState: reader.state,
        canonicalRevision: reader.tableRevisions.find(entry => entry.tableName === 'chunks')?.revision ?? null,
        documentsRevision: reader.tableRevisions.find(entry => entry.tableName === 'documents')?.revision ?? null,
        tableRevisions: reader.tableRevisions, registryHash: reader.registryHash, results: selected.results, items,
      }
    })
  })
}

/** Verification reads only the original IDs and revisions; search and embedding are never repeated. */
export async function verifyReferenceImportKnowledge(input: {
  projectPath: string; runtimeEpoch: string; snapshot: ReferenceImportKnowledgeSnapshot; assertActive: () => void
}): Promise<void> {
  input.assertActive()
  const expected = input.snapshot
  const root = getProjectDataRoot(input.projectPath)
  if (expected.runtimeEpoch !== input.runtimeEpoch || expected.projectStorageRoot !== root) fail('RUNTIME_CHANGED')
  await verifyReferenceImportKnowledgeMaterial({ root, snapshot: expected, assertActive: input.assertActive })
}

export async function verifyDurableReferenceImportKnowledge(input: {
  projectPath: string
  snapshot: Omit<ReferenceImportKnowledgeSnapshot, 'projectStorageRoot' | 'runtimeEpoch'>
  assertActive: () => void
}): Promise<void> {
  input.assertActive()
  await verifyReferenceImportKnowledgeMaterial({
    root: getProjectDataRoot(input.projectPath), snapshot: input.snapshot, assertActive: input.assertActive,
  })
}

async function verifyReferenceImportKnowledgeMaterial(input: {
  root: string
  snapshot: Omit<ReferenceImportKnowledgeSnapshot, 'projectStorageRoot' | 'runtimeEpoch'>
  assertActive: () => void
}): Promise<void> {
  const { root, snapshot: expected } = input
  if (expected.version !== 1 || typeof expected.query !== 'string' || !Number.isSafeInteger(expected.topK)
    || expected.topK < 1 || expected.topK > 100 || !Array.isArray(expected.items) || !Array.isArray(expected.results)
    || expected.items.length > expected.topK || expected.results.length !== expected.items.length
    || expected.state !== (expected.items.length ? 'stored' : 'empty')
    || new Set(expected.items.map(item => item.chunkId)).size !== expected.items.length) fail('INVALID_SNAPSHOT')
  await withKnowledgeSourceGate(root, () => readStable(root, input.assertActive, async reader => {
    if (reader.state !== expected.storageState || reader.registryHash !== expected.registryHash
      || !isDeepStrictEqual(reader.tableRevisions, expected.tableRevisions)
      || (reader.tableRevisions.find(entry => entry.tableName === 'chunks')?.revision ?? null) !== expected.canonicalRevision
      || (reader.tableRevisions.find(entry => entry.tableName === 'documents')?.revision ?? null) !== expected.documentsRevision) fail('SOURCE_STALE')
    for (let index = 0; index < expected.items.length; index++) {
      const item = expected.items[index]
      if (!reader.chunks) fail('SOURCE_STALE')
      const rows = await reader.chunks!.query().where(`id = ${quote(string(item.chunkId))}`).toArray()
      input.assertActive()
      if (rows.length !== 1) fail('SOURCE_STALE')
      const actual = await sourceItem(reader, rows[0], item.score, input.assertActive)
      if (!isDeepStrictEqual(actual, item)
        || !isDeepStrictEqual({ text: actual.text, score: actual.score, fileName: actual.fileName }, expected.results[index])) fail('SOURCE_STALE')
    }
  }))
}

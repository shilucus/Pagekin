import path from 'node:path'
import { assertEmbeddingRequestOutcome } from './reference-embedding-dispatch-contract'

const fail = (): never => { throw new Error('PORTABLE_UNSAFE_PROJECTION') }
export function stableImportQueryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableImportQueryJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableImportQueryJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !keys.includes(key))) fail()
  return row
}
function parse(value: unknown): unknown {
  if (typeof value !== 'string') return fail()
  try { return JSON.parse(value) } catch { return fail() }
}
function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}._:@+-]{1,512}$/u.test(value) || /^[a-z]:/iu.test(value)) return fail()
  return value
}
function contentHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return fail()
  return value
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail()
  return value as number
}
function text(value: unknown, max = 16 * 1024 * 1024): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) return fail()
  return value
}

export function projectImportQueryOutcome(value: unknown): unknown {
  if (value === null) return null
  const outcome = parse(value)
  try { assertEmbeddingRequestOutcome(outcome) } catch { fail() }
  return outcome
}

/** Only source-material evidence survives transfer; machine-derived registry identity does not. */
export function projectImportQueryReceipt(value: unknown): unknown {
  if (value === null) return null
  const receipt = object(parse(value), ['version', 'state', 'snapshot'])
  if (receipt.version !== 1) fail()
  if (receipt.state === 'unavailable') {
    if (Object.hasOwn(receipt, 'snapshot')) fail()
    return { version: 1, state: 'unavailable' }
  }
  if (receipt.state !== 'available') fail()
  const snapshot = object(receipt.snapshot, ['version', 'state', 'query', 'topK', 'storageState',
    'canonicalRevision', 'documentsRevision', 'tableRevisions', 'registryHash', 'results', 'items'])
  if (snapshot.version !== 1 || !['empty', 'stored'].includes(String(snapshot.state)) || snapshot.topK !== 5
    || !['absent', 'empty', 'present'].includes(String(snapshot.storageState))
    || !Array.isArray(snapshot.tableRevisions) || !Array.isArray(snapshot.results) || !Array.isArray(snapshot.items)
    || snapshot.results.length > 5 || snapshot.items.length !== snapshot.results.length) fail()
  if (snapshot.registryHash !== undefined && snapshot.registryHash !== null) contentHash(snapshot.registryHash)
  const revision = (value: unknown) => value === null ? null : integer(value)
  const result = (value: unknown) => {
    const row = object(value, ['text', 'score', 'fileName'])
    const fileName = text(row.fileName, 1024)
    if (path.isAbsolute(fileName) || fileName.includes('/') || fileName.includes('\\')
      || typeof row.score !== 'number' || !Number.isFinite(row.score)) fail()
    return { text: text(row.text), score: row.score, fileName }
  }
  const results = (snapshot.results as unknown[]).map(result)
  const items = (snapshot.items as unknown[]).map((value, index) => {
    const row = object(value, ['text', 'score', 'fileName', 'chunkId', 'documentId', 'chunkIndex', 'corpusKind',
      'contentHash', 'documentChunkSetHash', 'documentChunks'])
    const hit = result({ text: row.text, score: row.score, fileName: row.fileName })
    if (JSON.stringify(hit) !== JSON.stringify(results[index]) || !['reference', 'project-knowledge', 'unknown'].includes(String(row.corpusKind))
      || !Array.isArray(row.documentChunks)) fail()
    return { ...hit, chunkId: safeId(row.chunkId), documentId: safeId(row.documentId), chunkIndex: integer(row.chunkIndex),
      corpusKind: row.corpusKind, contentHash: contentHash(row.contentHash), documentChunkSetHash: contentHash(row.documentChunkSetHash),
      documentChunks: (row.documentChunks as unknown[]).map(value => {
        const chunk = object(value, ['chunkId', 'chunkIndex', 'contentHash'])
        return { chunkId: safeId(chunk.chunkId), chunkIndex: integer(chunk.chunkIndex), contentHash: contentHash(chunk.contentHash) }
      }) }
  })
  return { version: 1, state: 'available', snapshot: {
    version: 1, state: snapshot.state, query: text(snapshot.query), topK: 5, storageState: snapshot.storageState,
    canonicalRevision: revision(snapshot.canonicalRevision), documentsRevision: revision(snapshot.documentsRevision),
    tableRevisions: (snapshot.tableRevisions as unknown[]).map(value => {
      const row = object(value, ['tableName', 'revision'])
      return { tableName: safeId(row.tableName), revision: integer(row.revision) }
    }), results, items,
  } }
}

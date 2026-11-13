import { createHash } from 'node:crypto'
import { getImportInferenceTopics, type ImportInferenceTopicKey } from '../../src/shared/import-inference-materials'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { isContentHash } from '../../src/shared/source-ref'
import { assertEmbeddingRequestOutcome, type EmbeddingRequestOutcome } from './reference-embedding-dispatch-contract'
import type { ReferenceImportKnowledgeSnapshot } from './reference-import-knowledge-source'
import type { GenerationRunRepository } from '../repositories/generation-run-repository'
import type { PortableRuntimeFreezeGuard } from './portable-runtime-freeze'
import type { ImportGenerationContext } from '../../src/shared/import-generation'

export const IMPORT_QUERY_PLAN_FIELDS = ['import_root_run_id', 'generation_run_id', 'root_action_id',
  'manifest_fingerprint', 'binding_json', 'binding_fingerprint', 'state', 'created_at_ms'] as const
export const IMPORT_QUERY_TOPIC_FIELDS = ['query_id', 'import_root_run_id', 'topic_key', 'state',
  'marked_at_ms', 'outcome_json', 'settled_at_ms', 'physical_closed_at_ms', 'receipt_json', 'receipt_fingerprint'] as const
export const IMPORT_QUERY_TOPIC_KEYS = ['worldview', 'protagonist', 'conflict', 'style'] as const
export type ImportQueryTopic = ImportInferenceTopicKey
export type ImportQueryErrorCode = `GENERATION_IMPORT_QUERY_${'REQUIRED' | 'INVALID' | 'PLAN_CONFLICT' | 'ROOT_CHANGED'
  | 'RECOVERY_UNKNOWN' | 'RECEIPT_INVALID' | 'PERSISTENCE_FAILED' | 'HISTORY_FROZEN'}`
  | 'ROOT_BUDGET_EXHAUSTED' | 'GENERATION_DISPATCH_BLOCKED' | 'GENERATION_ACTION_CANCELLED'
export class ImportQueryBarrierError extends Error {
  constructor(readonly code: ImportQueryErrorCode) { super(code); this.name = 'ImportQueryBarrierError' }
}
export function importQueryFailure(code: ImportQueryErrorCode): never { throw new ImportQueryBarrierError(code) }
export function importQueryHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
export function importQueryContextFingerprint(context: ImportGenerationContext): string {
  const { runId, ...slot } = context.slot
  void runId
  return importQueryHash(JSON.stringify({ ...context, slot }))
}
export function importQueryId(rootRunId: string, topic: ImportQueryTopic): string {
  if (!id(rootRunId) || !IMPORT_QUERY_TOPIC_KEYS.includes(topic)) invalid()
  return `import-query:v1:${rootRunId}:${topic}`
}

export interface ImportQueryBinding {
  version: 1
  slot: { stage: 'global'; batchId: string; writingLanguage: WritingLanguage }
  contextFingerprint: string
  configurationFingerprint: string
  topics: readonly { key: ImportQueryTopic; query: string; topK: 5 }[]
}
export type DurableImportQuerySnapshot = Omit<ReferenceImportKnowledgeSnapshot, 'projectStorageRoot' | 'runtimeEpoch'>
export type ImportQueryReceipt = { version: 1; state: 'available'; snapshot: DurableImportQuerySnapshot }
  | { version: 1; state: 'unavailable' }
export type PortableImportQueryReceipt = { version: 1; state: 'available'; snapshot: Omit<DurableImportQuerySnapshot, 'registryHash'> }
  | { version: 1; state: 'unavailable' }
export interface ImportQueryPlanRecord {
  import_root_run_id: string; generation_run_id: string; root_action_id: string
  manifest_fingerprint: string | null; binding_json: string | null; binding_fingerprint: string | null
  state: 'ready' | 'recovery_unknown'; created_at_ms: number
}
export interface ImportQueryTopicRecord {
  query_id: string; import_root_run_id: string; topic_key: ImportQueryTopic
  state: 'prepared' | 'dispatch_marked' | 'completed' | 'unknown'
  marked_at_ms: number | null; outcome_json: string | null; settled_at_ms: number | null
  physical_closed_at_ms: number | null; receipt_json: string | null; receipt_fingerprint: string | null
}
export interface ImportQueryPlan {
  readonly record: ImportQueryPlanRecord
  readonly binding: ImportQueryBinding
  readonly topics: readonly ImportQueryTopicRecord[]
}
export interface PrepareImportQuery {
  generationRunId: string
  importRunId: string
  /** Main derives the exact fixed topics and hashes its private frozen configuration. */
  binding: ImportQueryBinding
  assertCurrent(): void
}
export interface ImportQueryRepositoryOptions {
  runs: GenerationRunRepository
  now?(): number
  freeze?: PortableRuntimeFreezeGuard
  /** Native resource identity only; this must remain valid for settlement after revocation. */
  assertResources?(): void
}
/** Structural fields are readable evidence, not the private flight's authority. */
export interface ImportQueryFlight {
  readonly queryId: string
  readonly importRootRunId: string
  readonly rootActionId: string
  readonly topic: ImportQueryTopic
}

/** M18 owns execution of this DDL and verification of all cross-row relationships. */
export const IMPORT_QUERY_TABLES_SQL = `
CREATE TABLE import_query_plans (
  import_root_run_id TEXT NOT NULL PRIMARY KEY REFERENCES import_runs(id),
  generation_run_id TEXT NOT NULL REFERENCES generation_runs(run_id),
  root_action_id TEXT NOT NULL REFERENCES generation_roots(root_action_id),
  manifest_fingerprint TEXT,
  binding_json TEXT,
  binding_fingerprint TEXT,
  state TEXT NOT NULL CHECK(state IN ('ready','recovery_unknown')),
  created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms)='integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK((manifest_fingerprint IS NULL AND binding_json IS NULL AND binding_fingerprint IS NULL)
    OR (manifest_fingerprint IS NOT NULL AND binding_fingerprint IS NOT NULL
      AND length(manifest_fingerprint)=64 AND manifest_fingerprint NOT GLOB '*[^a-f0-9]*'
      AND binding_json IS NOT NULL AND json_valid(binding_json)
      AND length(binding_fingerprint)=64 AND binding_fingerprint NOT GLOB '*[^a-f0-9]*'))
);
CREATE TABLE import_query_topics (
  query_id TEXT NOT NULL PRIMARY KEY,
  import_root_run_id TEXT NOT NULL REFERENCES import_query_plans(import_root_run_id),
  topic_key TEXT NOT NULL CHECK(topic_key IN ('worldview','protagonist','conflict','style')),
  state TEXT NOT NULL CHECK(state IN ('prepared','dispatch_marked','completed','unknown')),
  marked_at_ms INTEGER CHECK(marked_at_ms IS NULL OR typeof(marked_at_ms)='integer' AND marked_at_ms BETWEEN 0 AND 9007199254740991),
  outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
  settled_at_ms INTEGER CHECK(settled_at_ms IS NULL OR typeof(settled_at_ms)='integer' AND settled_at_ms BETWEEN 0 AND 9007199254740991),
  physical_closed_at_ms INTEGER CHECK(physical_closed_at_ms IS NULL OR typeof(physical_closed_at_ms)='integer' AND physical_closed_at_ms BETWEEN 0 AND 9007199254740991),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  receipt_fingerprint TEXT CHECK(receipt_fingerprint IS NULL OR length(receipt_fingerprint)=64 AND receipt_fingerprint NOT GLOB '*[^a-f0-9]*'),
  UNIQUE(import_root_run_id,topic_key),
  CHECK(query_id='import-query:v1:' || import_root_run_id || ':' || topic_key),
  CHECK((outcome_json IS NULL)=(settled_at_ms IS NULL)),
  CHECK(marked_at_ms IS NOT NULL OR outcome_json IS NULL AND settled_at_ms IS NULL AND physical_closed_at_ms IS NULL
    AND state NOT IN ('dispatch_marked','unknown')),
  CHECK(state<>'prepared' OR marked_at_ms IS NULL),
  CHECK((state='completed' AND receipt_json IS NOT NULL
      AND (marked_at_ms IS NULL OR outcome_json IS NOT NULL AND physical_closed_at_ms IS NOT NULL))
    OR (state<>'completed' AND receipt_json IS NULL AND receipt_fingerprint IS NULL))
);`

function invalid(): never { return importQueryFailure('GENERATION_IMPORT_QUERY_INVALID') }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function keys(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
}
function id(value: unknown): value is string { return typeof value === 'string' && /^[\p{L}\p{N}._:@+-]{1,512}$/u.test(value) }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function hash(value: unknown): value is string { return typeof value === 'string' && isContentHash(value) }
function parse(value: string): unknown { try { return JSON.parse(value) } catch { return invalid() } }

export function assertImportQueryBinding(value: unknown): asserts value is ImportQueryBinding {
  if (!keys(value, ['version', 'slot', 'contextFingerprint', 'configurationFingerprint', 'topics']) || value.version !== 1
    || !keys(value.slot, ['stage', 'batchId', 'writingLanguage']) || value.slot.stage !== 'global'
    || typeof value.slot.batchId !== 'string' || !value.slot.batchId || !['zh-CN', 'en-US'].includes(value.slot.writingLanguage as string)
    || !hash(value.contextFingerprint) || !hash(value.configurationFingerprint) || !Array.isArray(value.topics)) invalid()
  const topics = getImportInferenceTopics(value.slot.writingLanguage as WritingLanguage)
  if (value.topics.length !== topics.length || value.topics.some((topic, index) => !keys(topic, ['key', 'query', 'topK'])
    || topic.key !== topics[index].key || topic.query !== topics[index].query || topic.topK !== 5)) invalid()
}
export function assertImportQueryPlanRecord(value: unknown): asserts value is ImportQueryPlanRecord {
  if (!keys(value, IMPORT_QUERY_PLAN_FIELDS) || !id(value.import_root_run_id) || !id(value.generation_run_id)
    || !id(value.root_action_id) || !['ready', 'recovery_unknown'].includes(value.state as string) || !integer(value.created_at_ms)
    || value.manifest_fingerprint !== null && !hash(value.manifest_fingerprint)
    || value.binding_fingerprint !== null && !hash(value.binding_fingerprint)) invalid()
  if (value.binding_json === null) { if (value.binding_fingerprint !== null || value.manifest_fingerprint !== null) invalid(); return }
  if (typeof value.binding_json !== 'string' || value.manifest_fingerprint === null) invalid()
  assertImportQueryBinding(parse(value.binding_json))
  if (value.binding_fingerprint !== importQueryHash(value.binding_json)) invalid()
}

function result(value: unknown): boolean {
  return keys(value, ['text', 'score', 'fileName']) && typeof value.text === 'string' && typeof value.fileName === 'string'
    && typeof value.score === 'number' && Number.isFinite(value.score)
}
export function assertImportQueryReceipt(value: unknown): asserts value is ImportQueryReceipt {
  if (keys(value, ['version', 'state']) && value.version === 1 && value.state === 'unavailable') return
  if (!keys(value, ['version', 'state', 'snapshot']) || value.version !== 1 || value.state !== 'available') invalid()
  const s = value.snapshot
  if (!keys(s, ['version', 'state', 'query', 'topK', 'storageState', 'canonicalRevision', 'documentsRevision',
    'tableRevisions', 'registryHash', 'results', 'items']) || s.version !== 1 || !['empty', 'stored'].includes(s.state as string)
    || typeof s.query !== 'string' || s.topK !== 5 || !['absent', 'empty', 'present'].includes(s.storageState as string)
    || s.canonicalRevision !== null && !integer(s.canonicalRevision) || s.documentsRevision !== null && !integer(s.documentsRevision)
    || s.registryHash !== null && !hash(s.registryHash) || !Array.isArray(s.tableRevisions)
    || s.tableRevisions.some(r => !keys(r, ['tableName', 'revision']) || typeof r.tableName !== 'string' || !integer(r.revision))
    || !Array.isArray(s.results) || s.results.length > 5 || !s.results.every(result) || !Array.isArray(s.items)
    || s.items.length !== s.results.length) invalid()
  for (let index = 0; index < s.items.length; index++) {
    const item = s.items[index]
    if (!keys(item, ['text', 'score', 'fileName', 'chunkId', 'documentId', 'chunkIndex', 'corpusKind', 'contentHash',
      'documentChunkSetHash', 'documentChunks']) || !result({ text: item.text, score: item.score, fileName: item.fileName })
      || !id(item.chunkId) || !id(item.documentId) || !integer(item.chunkIndex)
      || !['reference', 'project-knowledge', 'unknown'].includes(item.corpusKind as string)
      || !hash(item.contentHash) || !hash(item.documentChunkSetHash) || !Array.isArray(item.documentChunks)
      || item.documentChunks.some(c => !keys(c, ['chunkId', 'chunkIndex', 'contentHash']) || !id(c.chunkId)
        || !integer(c.chunkIndex) || !hash(c.contentHash))) invalid()
    const hit = s.results[index] as Record<string, unknown>
    if (hit.text !== item.text || hit.score !== item.score || hit.fileName !== item.fileName) invalid()
  }
}
export function assertPortableImportQueryReceipt(value: unknown): asserts value is PortableImportQueryReceipt {
  if (keys(value, ['version', 'state']) && value.version === 1 && value.state === 'unavailable') return
  if (!keys(value, ['version', 'state', 'snapshot']) || value.version !== 1 || value.state !== 'available'
    || !keys(value.snapshot, ['version', 'state', 'query', 'topK', 'storageState', 'canonicalRevision', 'documentsRevision',
      'tableRevisions', 'results', 'items'])) invalid()
  assertImportQueryReceipt({ ...value, snapshot: { ...value.snapshot, registryHash: null } })
}
export function assertImportQueryTopicRecord(value: unknown, options: { portable?: boolean } = {}): asserts value is ImportQueryTopicRecord {
  if (!keys(value, IMPORT_QUERY_TOPIC_FIELDS) || !id(value.import_root_run_id)
    || !IMPORT_QUERY_TOPIC_KEYS.includes(value.topic_key as ImportQueryTopic)
    || value.query_id !== importQueryId(value.import_root_run_id, value.topic_key as ImportQueryTopic)
    || !['prepared', 'dispatch_marked', 'completed', 'unknown'].includes(value.state as string)
    || [value.marked_at_ms, value.settled_at_ms, value.physical_closed_at_ms].some(v => v !== null && !integer(v))) invalid()
  if (value.marked_at_ms === null && (value.outcome_json !== null || value.settled_at_ms !== null
    || value.physical_closed_at_ms !== null || value.state === 'dispatch_marked' || value.state === 'unknown')) invalid()
  if ((value.outcome_json === null) !== (value.settled_at_ms === null)) invalid()
  if (value.outcome_json !== null) {
    if (typeof value.outcome_json !== 'string') invalid()
    try { assertEmbeddingRequestOutcome(parse(value.outcome_json)) } catch { invalid() }
    if ((parse(value.outcome_json) as EmbeddingRequestOutcome).kind === 'transport_unknown' && value.state === 'completed') invalid()
  }
  if (value.state === 'prepared' && value.marked_at_ms !== null) invalid()
  if (value.state === 'completed') {
    if (typeof value.receipt_json !== 'string' || value.receipt_fingerprint !== null && !hash(value.receipt_fingerprint)
      || value.marked_at_ms !== null && (value.outcome_json === null || value.physical_closed_at_ms === null)) invalid()
    if (options.portable) {
      if (value.receipt_fingerprint !== null) invalid()
      assertPortableImportQueryReceipt(parse(value.receipt_json))
    } else {
      if (!hash(value.receipt_fingerprint)) invalid()
      assertImportQueryReceipt(parse(value.receipt_json))
    }
    if (value.receipt_fingerprint !== null && value.receipt_fingerprint !== importQueryHash(value.receipt_json)) invalid()
  } else if (value.receipt_json !== null || value.receipt_fingerprint !== null) invalid()
}
export type { EmbeddingRequestOutcome }

import { createHash } from 'node:crypto'

import type Database from 'better-sqlite3'

import type { PortableRuntimeFreezeGuard } from './portable-runtime-freeze'
import { PORTABLE_READABLE_SOURCE_SCHEMA_VERSIONS, PORTABLE_SOURCE_SCHEMA_VERSION, type PortableSourceSchemaVersion } from './portable-project-format'
import { projectImportQueryOutcome, projectImportQueryReceipt, stableImportQueryJson } from './portable-import-query-projection'

const HASH = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ID = /^[\p{L}\p{N}._:@+-]{1,512}$/u
const MAX_RECORDS = 100_000
const MAX_BYTES = 4 * 1024 * 1024

export const PORTABLE_TRANSFER_AUTHORITY_PATH = '.ai-novel/portable-transfer-authority.json'

export interface PortableFinalizationAuthority {
  finalizationId: string
  draftId: number
  chapterNumber: number
  contentHash: string
}

export interface PortableSummarySourceAuthority {
  summaryId: number
  draftId: number
  chapterNumber: number
  sourceFinalizationId: string
  sourceContentHash: string
  projectionGeneration: number
}

export interface PortableTransferAuthority {
  version: 1
  receiptId: string
  originProjectId: string
  targetProjectId: string | null
  snapshotGeneration: string
  /** 收据记的是导出时的 schema 版本：v7 包导入的作品升到 v8 后原收据仍须可读（#564 M07）。 */
  sourceSchemaVersion: PortableSourceSchemaVersion
  portableDatabaseSha256: string
  requiresRuntimeFreezeGuard: true
  finalizations: PortableFinalizationAuthority[]
  summarySources: PortableSummarySourceAuthority[]
}

function invalid(): never { throw new Error('PORTABLE_TRANSFER_AUTHORITY_INVALID') }

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const result = value as Record<string, unknown>
  const actual = Object.keys(result).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid()
  return result
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid()
  return value
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid()
  return value
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid()
  return value
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid()
  return value as number
}

function finalization(value: unknown): PortableFinalizationAuthority {
  const row = object(value, ['finalizationId', 'draftId', 'chapterNumber', 'contentHash'])
  return {
    finalizationId: identifier(row.finalizationId),
    draftId: integer(row.draftId, 1),
    chapterNumber: integer(row.chapterNumber, 1),
    contentHash: hash(row.contentHash),
  }
}

function summarySource(value: unknown): PortableSummarySourceAuthority {
  const row = object(value, [
    'summaryId', 'draftId', 'chapterNumber', 'sourceFinalizationId', 'sourceContentHash', 'projectionGeneration',
  ])
  return {
    summaryId: integer(row.summaryId, 1),
    draftId: integer(row.draftId, 1),
    chapterNumber: integer(row.chapterNumber, 1),
    sourceFinalizationId: identifier(row.sourceFinalizationId),
    sourceContentHash: hash(row.sourceContentHash),
    projectionGeneration: integer(row.projectionGeneration),
  }
}

function assertFacts(
  finalizations: PortableFinalizationAuthority[],
  summarySources: PortableSummarySourceAuthority[],
): void {
  if (new Set(finalizations.map(item => item.finalizationId)).size !== finalizations.length
    || new Set(finalizations.map(item => item.draftId)).size !== finalizations.length
    || new Set(finalizations.map(item => item.chapterNumber)).size !== finalizations.length
    || new Set(summarySources.map(item => item.summaryId)).size !== summarySources.length) invalid()
  const finalizationById = new Map(finalizations.map(item => [item.finalizationId, item]))
  if (summarySources.some(item => {
    const current = finalizationById.get(item.sourceFinalizationId)
    return current?.contentHash !== item.sourceContentHash || current.draftId !== item.draftId
      || current.chapterNumber !== item.chapterNumber
  })) invalid()
}

export function parsePortableTransferAuthority(value: unknown): PortableTransferAuthority {
  const source = object(value, [
    'version', 'receiptId', 'originProjectId', 'targetProjectId', 'snapshotGeneration', 'sourceSchemaVersion',
    'portableDatabaseSha256', 'requiresRuntimeFreezeGuard', 'finalizations', 'summarySources',
  ])
  if (source.version !== 1 || !(PORTABLE_READABLE_SOURCE_SCHEMA_VERSIONS as readonly unknown[]).includes(source.sourceSchemaVersion)
    || source.requiresRuntimeFreezeGuard !== true || !Array.isArray(source.finalizations)
    || !Array.isArray(source.summarySources) || source.finalizations.length > MAX_RECORDS
    || source.summarySources.length > MAX_RECORDS) invalid()
  const finalizations = source.finalizations.map(finalization)
  const summarySources = source.summarySources.map(summarySource)
  assertFacts(finalizations, summarySources)
  const result: PortableTransferAuthority = {
    version: 1,
    receiptId: identifier(source.receiptId),
    originProjectId: uuid(source.originProjectId),
    targetProjectId: source.targetProjectId === null ? null : uuid(source.targetProjectId),
    snapshotGeneration: identifier(source.snapshotGeneration),
    sourceSchemaVersion: source.sourceSchemaVersion as PortableTransferAuthority['sourceSchemaVersion'],
    portableDatabaseSha256: hash(source.portableDatabaseSha256),
    requiresRuntimeFreezeGuard: true,
    finalizations,
    summarySources,
  }
  const expectedReceiptId = receiptId(result)
  if (result.receiptId !== expectedReceiptId) invalid()
  return result
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }

/** Neutralized grant rows are history only when their grant and import run are frozen. */
export function assertReferenceImportGrantFreezeCoverage(database: Database.Database, freeze?: PortableRuntimeFreezeGuard): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_import_grants'").get()) return
  const rows = database.prepare(`SELECT grant_id,import_run_id,manifest_fingerprint,request_hash
    FROM reference_import_grants WHERE manifest_fingerprint IS NULL OR request_hash IS NULL`).all() as Array<{
      grant_id: string; import_run_id: string; manifest_fingerprint: string | null; request_hash: string | null
    }>
  for (const row of rows) {
    if (row.manifest_fingerprint !== null || row.request_hash !== null || !freeze?.active
      || !freeze.isFrozen('reference_import_grants', row.grant_id) || !freeze.isFrozen('import_runs', row.import_run_id)) invalid()
  }
}

/** Exported dispatches remain history; genuinely new local runs keep their own live authority. */
export function assertReferenceEmbeddingDispatchFreezeCoverage(
  database: Database.Database,
  freeze?: PortableRuntimeFreezeGuard,
  completePortableCopy = false,
): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_embedding_dispatches'").get()) return
  const rows = database.prepare(`SELECT d.dispatch_id,d.import_run_id,d.document_id,r.source_fingerprint,r.manifest_fingerprint
    FROM reference_embedding_dispatches d JOIN import_runs r ON r.id=d.import_run_id`).all() as Array<{
      dispatch_id: string; import_run_id: string; document_id: string; source_fingerprint: string; manifest_fingerprint: string
    }>
  for (const row of rows) {
    const historical = completePortableCopy || row.source_fingerprint === '' || row.manifest_fingerprint === ''
      || freeze?.isFrozen('reference_embedding_dispatches', row.dispatch_id)
      || freeze?.isFrozen('import_runs', row.import_run_id) || freeze?.isFrozen('import_reference_documents', row.document_id)
    if (historical && (!freeze?.active || !freeze.isFrozen('reference_embedding_dispatches', row.dispatch_id)
      || !freeze.isFrozen('import_runs', row.import_run_id) || !freeze.isFrozen('import_reference_documents', row.document_id))) invalid()
  }
}

/** Budget history cannot be used as execution authority after transfer. */
export function assertReferenceEmbeddingBudgetFreezeCoverage(
  database: Database.Database,
  authority: PortableTransferAuthority,
  freeze?: PortableRuntimeFreezeGuard,
  completePortableCopy = false,
): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_embedding_budgets'").get()) return
  const rows = database.prepare(`SELECT root_run_id,manifest_fingerprint,policy_version,initial_chunk_size,
    initial_chunk_overlap,initial_batch_size,request_limit,active_limit_ms,spent_requests,active_elapsed_ms,active_since_ms,state
    FROM reference_embedding_budgets`).all() as Array<{
      root_run_id: string; manifest_fingerprint: string | null; policy_version: string; initial_chunk_size: number | null
      initial_chunk_overlap: number | null; initial_batch_size: number | null; request_limit: number | null
      active_limit_ms: number | null; spent_requests: number | null; active_elapsed_ms: number | null
      active_since_ms: number | null; state: string
    }>
  for (const row of rows) {
    const rootFrozen = freeze?.isFrozen('import_runs', row.root_run_id) === true
    const budgetFrozen = freeze?.isFrozen('reference_embedding_budgets', row.root_run_id) === true
    const historical = completePortableCopy || rootFrozen || budgetFrozen || row.manifest_fingerprint === null
    if (!historical) continue
    const migratedLegacy = authority.sourceSchemaVersion < 18 && row.state === 'legacy_unbudgeted'
      && row.policy_version === 'reference-embedding-budget-v1'
      && [row.manifest_fingerprint, row.initial_chunk_size, row.initial_chunk_overlap, row.initial_batch_size,
        row.request_limit, row.active_limit_ms, row.spent_requests, row.active_elapsed_ms, row.active_since_ms]
        .every(value => value === null)
    if (!freeze?.active || !rootFrozen || row.manifest_fingerprint !== null || (!budgetFrozen && !migratedLegacy)) invalid()
  }
}

/** A snapshot reference does not freeze a new local import's own binding. */
export function assertReferenceManifestBindingFreezeCoverage(
  database: Database.Database,
  authority: PortableTransferAuthority,
  freeze?: PortableRuntimeFreezeGuard,
  completePortableCopy = false,
): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_import_manifest_chapters'").get()) return
  const rows = database.prepare(`SELECT b.import_run_id,b.chapter_number,b.snapshot_run_id,b.snapshot_chapter_number,b.source_id,b.source_chapter_number,
    c.run_id AS snapshot_owner,c.source_id AS snapshot_source_id,c.source_chapter_number AS snapshot_source_chapter_number
    FROM reference_import_manifest_chapters b LEFT JOIN import_run_chapters c
      ON c.run_id=b.snapshot_run_id AND c.chapter_number=b.snapshot_chapter_number`).all() as Array<{
    import_run_id: string; chapter_number: number; snapshot_run_id: string; snapshot_chapter_number: number; source_id: string; source_chapter_number: number
    snapshot_owner: string | null; snapshot_source_id: string | null; snapshot_source_chapter_number: number | null
  }>
  const ids = new Set(rows.map(row => `${row.import_run_id}:${row.chapter_number}`))
  if (freeze?.recordIds?.('reference_import_manifest_chapters').some(id => !ids.has(id))) invalid()
  for (const row of rows) {
    const runFrozen = freeze?.isFrozen('import_runs', row.import_run_id) === true
    const bindingFrozen = freeze?.isFrozen('reference_import_manifest_chapters', `${row.import_run_id}:${row.chapter_number}`) === true
    if (!(completePortableCopy || runFrozen || bindingFrozen)) continue
    // Pre-M17 packages cannot contain binding projections: migration backfills from their verified snapshots.
    if (!freeze?.active || !runFrozen) invalid()
    if (!bindingFrozen && (authority.sourceSchemaVersion >= 18 || row.snapshot_run_id !== row.import_run_id
      || row.snapshot_chapter_number !== row.chapter_number
      || row.snapshot_owner !== row.import_run_id || row.source_id !== row.snapshot_source_id
      || row.source_chapter_number !== row.snapshot_source_chapter_number)) invalid()
  }
  const roots = database.prepare("SELECT root_run_id FROM reference_embedding_budgets WHERE state IN ('ready','recovery_unknown')")
    .all() as Array<{ root_run_id: string }>
  const manifests = database.prepare(`SELECT r.id,r.manifest_chapter_count,r.manifest_content_size,
    COUNT(b.chapter_number) AS binding_count,COUNT(c.run_id) AS snapshot_count,COALESCE(SUM(c.content_size),0) AS snapshot_size
    FROM import_runs r LEFT JOIN reference_import_manifest_chapters b ON b.import_run_id=r.id
    LEFT JOIN import_run_chapters c ON c.run_id=b.snapshot_run_id AND c.chapter_number=b.snapshot_chapter_number
    WHERE r.root_run_id=? AND r.purpose='reference' AND r.stage<>'parsing' GROUP BY r.id`)
  for (const root of roots) {
    if (!freeze?.isFrozen('import_runs', root.root_run_id)) continue
    const candidates = manifests.all(root.root_run_id) as Array<{
      id: string; manifest_chapter_count: number; manifest_content_size: number
      binding_count: number; snapshot_count: number; snapshot_size: number
    }>
    if (candidates.length === 0 || !candidates.every(row => freeze.isFrozen('import_runs', row.id)
      && Number.isSafeInteger(row.manifest_chapter_count) && row.manifest_chapter_count > 0
      && Number.isSafeInteger(row.manifest_content_size) && row.manifest_content_size >= 0
      && row.binding_count === row.manifest_chapter_count && row.snapshot_count === row.binding_count
      && row.snapshot_size === row.manifest_content_size)) invalid()
  }
}

/** Query material is readable history, never a transferred execution capability. */
export function assertImportQueryFreezeCoverage(
  database: Database.Database,
  freeze?: PortableRuntimeFreezeGuard,
  completePortableCopy = false,
): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_query_plans'").get()) return
  const plans = database.prepare(`SELECT p.*,i.id AS import_id,i.root_run_id AS import_root,
    r.run_id AS generation_id,r.root_action_id AS generation_root,g.root_action_id AS root_id
    FROM import_query_plans p LEFT JOIN import_runs i ON i.id=p.import_root_run_id
    LEFT JOIN generation_runs r ON r.run_id=p.generation_run_id
    LEFT JOIN generation_roots g ON g.root_action_id=p.root_action_id`).all() as Array<{
      import_root_run_id: string; generation_run_id: string; root_action_id: string
      manifest_fingerprint: string | null; binding_json: string | null; binding_fingerprint: string | null
      import_id: string | null; import_root: string | null; generation_id: string | null
      generation_root: string | null; root_id: string | null
    }>
  const topics = database.prepare('SELECT query_id,import_root_run_id,topic_key,outcome_json,receipt_json,receipt_fingerprint FROM import_query_topics').all() as Array<{
    query_id: string; import_root_run_id: string; topic_key: string; receipt_fingerprint: string | null
    outcome_json: string | null; receipt_json: string | null
  }>
  const planIds = new Set(plans.map(row => row.import_root_run_id))
  const topicIds = new Set(topics.map(row => row.query_id))
  if (freeze?.recordIds?.('import_query_plans').some(id => !planIds.has(id))
    || freeze?.recordIds?.('import_query_topics').some(id => !topicIds.has(id))) invalid()
  if (topics.some(row => !planIds.has(row.import_root_run_id))) invalid()
  for (const plan of plans) {
    for (const id of [plan.import_root_run_id, plan.generation_run_id, plan.root_action_id]) {
      if (!ID.test(id) || /^[a-z]:/iu.test(id)) invalid()
    }
    if (plan.import_id !== plan.import_root_run_id || plan.import_root !== plan.import_root_run_id
      || plan.generation_id !== plan.generation_run_id || plan.generation_root !== plan.root_action_id
      || plan.root_id !== plan.root_action_id) invalid()
    const children = topics.filter(row => row.import_root_run_id === plan.import_root_run_id)
    if (children.some(row => !ID.test(row.query_id) || /^[a-z]:/iu.test(row.query_id))) invalid()
    if (children.length !== 4 || ['worldview', 'protagonist', 'conflict', 'style']
      .some(key => children.filter(row => row.topic_key === key).length !== 1)) invalid()
    const historical = completePortableCopy || plan.manifest_fingerprint === null || plan.binding_json === null
      || plan.binding_fingerprint === null || freeze?.isFrozen('import_query_plans', plan.import_root_run_id)
      || freeze?.isFrozen('import_runs', plan.import_root_run_id) || freeze?.isFrozen('generation_runs', plan.generation_run_id)
      || freeze?.isFrozen('generation_roots', plan.root_action_id)
      || children.some(row => freeze?.isFrozen('import_query_topics', row.query_id))
    if (!historical) continue
    if (!freeze?.active || !freeze.isFrozen('import_query_plans', plan.import_root_run_id)
      || !freeze.isFrozen('import_runs', plan.import_root_run_id)
      || !freeze.isFrozen('generation_runs', plan.generation_run_id)
      || !freeze.isFrozen('generation_roots', plan.root_action_id)
      || plan.manifest_fingerprint !== null || plan.binding_json !== null || plan.binding_fingerprint !== null
      || children.some(row => !freeze.isFrozen('import_query_topics', row.query_id) || row.receipt_fingerprint !== null)) invalid()
    for (const child of children) {
      try {
        const outcome = projectImportQueryOutcome(child.outcome_json), receipt = projectImportQueryReceipt(child.receipt_json)
        const actual = { outcome_json: child.outcome_json === null ? null : JSON.parse(child.outcome_json),
          receipt_json: child.receipt_json === null ? null : JSON.parse(child.receipt_json) }
        if (stableImportQueryJson(actual) !== stableImportQueryJson({ outcome_json: outcome, receipt_json: receipt })
          || stableImportQueryJson(freeze.projection?.('import_query_topics', child.query_id))
            !== stableImportQueryJson(actual)) invalid()
      } catch { invalid() }
    }
  }
}

function receiptId(input: Pick<PortableTransferAuthority,
  'originProjectId' | 'snapshotGeneration' | 'portableDatabaseSha256' | 'finalizations' | 'summarySources'>): string {
  return `portable-transfer:${sha256(JSON.stringify({ originProjectId: input.originProjectId,
    snapshotGeneration: input.snapshotGeneration, portableDatabaseSha256: input.portableDatabaseSha256,
    finalizations: input.finalizations, summarySources: input.summarySources })).slice(0, 32)}`
}

function currentness(database: Database.Database, legacyCopy = false, freeze?: PortableRuntimeFreezeGuard): Pick<PortableTransferAuthority, 'finalizations' | 'summarySources'> {
  const core = database.prepare('SELECT id FROM project_core').all() as Array<{ id: string }>
  if (core.length > 1 || core.some(row => row.id !== 'main')) invalid()
  const rows = database.prepare(`
    SELECT o.finalization_id AS finalizationId, d.id AS draftId,
      o.chapter_number AS chapterNumber, o.content_hash AS contentHash,
      o.content_snapshot AS contentSnapshot, d.chapter_number AS draftChapterNumber,
      d.status AS draftStatus, c.body AS body
    FROM drafts_all d
    JOIN contents c ON c.id = d.content_id
    LEFT JOIN finalization_outbox_all o ON o.draft_id = d.id
    WHERE d.status = 'finalized'
      ${legacyCopy ? 'AND o.finalization_id IS NOT NULL' : ''}
      AND NOT EXISTS (
        SELECT 1 FROM drafts_all newer
        WHERE newer.chapter_number = d.chapter_number
          AND newer.status = 'finalized'
          AND (newer.version > d.version OR (newer.version = d.version AND newer.id > d.id))
      )
    ORDER BY o.finalization_id
  `).all() as Array<{
    finalizationId: string | null; draftId: number; chapterNumber: number | null; contentHash: string | null
    contentSnapshot: string | null; draftChapterNumber: number; draftStatus: string; body: string
  }>
  const finalizations = rows.filter(row => !(row.finalizationId === null && freeze?.isFrozen('drafts', String(row.draftId)))).map(row => {
    const projected = finalization({
      finalizationId: row.finalizationId,
      draftId: row.draftId,
      chapterNumber: row.chapterNumber,
      contentHash: row.contentHash,
    })
    if (row.draftStatus !== 'finalized' || row.chapterNumber !== row.draftChapterNumber
      || typeof row.contentSnapshot !== 'string' || typeof row.body !== 'string'
      || row.contentSnapshot !== row.body || sha256(row.contentSnapshot) !== row.contentHash) invalid()
    return projected
  })
  const summaries = database.prepare(`
    SELECT s.id AS summaryId, s.draft_id AS draftId, s.chapter_number AS chapterNumber,
      s.source_finalization_id AS sourceFinalizationId, s.source_content_hash AS sourceContentHash,
      s.projection_generation AS projectionGeneration
    FROM summary_snapshots_all s
    JOIN drafts_all d ON d.id = s.draft_id
    WHERE (s.source_finalization_id <> '' OR s.source_content_hash <> '')
      AND d.status = 'finalized'
      AND NOT EXISTS (
        SELECT 1 FROM drafts_all newer
        WHERE newer.chapter_number = d.chapter_number
          AND newer.status = 'finalized'
          AND (newer.version > d.version OR (newer.version = d.version AND newer.id > d.id))
      )
    ORDER BY s.id
  `).all() as Array<Record<string, unknown>>
  const summarySources = summaries.map(summarySource)
  assertFacts(finalizations, summarySources)
  return { finalizations, summarySources }
}

export function createPortableTransferAuthority(input: {
  freeze?: PortableRuntimeFreezeGuard
  database: Database.Database
  originProjectId: string
  snapshotGeneration: string
  portableDatabaseSha256: string
}): PortableTransferAuthority {
  return createAuthority(input, currentness(input.database, false, input.freeze))
}

/** Old finalized prose without an outbox receipt remains readable legacy content;
 * only source-bound receipts become transferred authority. */
export function createLegacyCopyTransferAuthority(input: {
  database: Database.Database
  originProjectId: string
  snapshotGeneration: string
  portableDatabaseSha256: string
}): PortableTransferAuthority {
  return createAuthority(input, currentness(input.database, true))
}

function createAuthority(input: {
  originProjectId: string
  snapshotGeneration: string
  portableDatabaseSha256: string
}, facts: Pick<PortableTransferAuthority, 'finalizations' | 'summarySources'>): PortableTransferAuthority {
  return parsePortableTransferAuthority({
    version: 1,
    originProjectId: input.originProjectId,
    targetProjectId: null,
    snapshotGeneration: input.snapshotGeneration,
    sourceSchemaVersion: PORTABLE_SOURCE_SCHEMA_VERSION,
    portableDatabaseSha256: input.portableDatabaseSha256,
    requiresRuntimeFreezeGuard: true,
    ...facts,
    receiptId: receiptId({ originProjectId: input.originProjectId, snapshotGeneration: input.snapshotGeneration,
      portableDatabaseSha256: input.portableDatabaseSha256, ...facts }),
  })
}

export function mapPortableTransferAuthority(
  authority: PortableTransferAuthority,
  targetProjectId: string,
): PortableTransferAuthority {
  return parsePortableTransferAuthority({ ...authority, targetProjectId })
}

export function verifyPortableTransferAuthority(
  database: Database.Database,
  authority: PortableTransferAuthority,
  freeze?: PortableRuntimeFreezeGuard,
): void {
  assertReferenceImportGrantFreezeCoverage(database, freeze)
  assertReferenceEmbeddingDispatchFreezeCoverage(database, freeze, true)
  assertReferenceEmbeddingBudgetFreezeCoverage(database, authority, freeze, true)
  assertReferenceManifestBindingFreezeCoverage(database, authority, freeze, true)
  assertImportQueryFreezeCoverage(database, freeze, true)
  const facts = currentness(database, false, freeze)
  if (JSON.stringify(facts.finalizations) !== JSON.stringify(authority.finalizations)
    || JSON.stringify(facts.summarySources) !== JSON.stringify(authority.summarySources)) invalid()
}

export function verifyPortableTransferAuthorityHistory(
  database: Database.Database,
  authority: PortableTransferAuthority,
  freeze?: PortableRuntimeFreezeGuard,
): void {
  assertReferenceImportGrantFreezeCoverage(database, freeze)
  assertReferenceEmbeddingDispatchFreezeCoverage(database, freeze)
  assertReferenceEmbeddingBudgetFreezeCoverage(database, authority, freeze)
  assertReferenceManifestBindingFreezeCoverage(database, authority, freeze)
  assertImportQueryFreezeCoverage(database, freeze)
  const deleted = new Set<number>()
  for (const item of authority.finalizations) {
    const row = database.prepare(`
      SELECT d.status AS status,d.chapter_number AS chapterNumber,c.body AS body,
        o.finalization_id AS finalizationId,o.content_hash AS contentHash,o.content_snapshot AS contentSnapshot,
        EXISTS (SELECT 1 FROM drafts_all newer WHERE newer.chapter_number=d.chapter_number
          AND newer.status='finalized' AND newer.id<>d.id) AS replaced
      FROM drafts_all d JOIN contents c ON c.id=d.content_id
      LEFT JOIN finalization_outbox_all o ON o.draft_id=d.id WHERE d.id=?
    `).get(item.draftId) as { status: string; chapterNumber: number; body: string; finalizationId: string | null; contentHash: string | null; contentSnapshot: string | null; replaced: number } | undefined
    /** 本地删除的凭据：一张有效、未被冻结的删除收据。彻底删除后行没了要它，进回收站的行也要它。 */
    const deletionProven = () => {
      if (!freeze?.active) return false
      const deletion = database.prepare(`
        SELECT operation_id AS operationId FROM chapter_deletion_operations
        WHERE draft_id=? AND chapter_number=? AND finalization_id=?
          AND status IN ('pending','failed','completed')
          AND (legacy_knowledge_authorization='not_required'
            OR (legacy_knowledge_authorization='consumed' AND legacy_knowledge_authorized_at <> ''))
      `).get(item.draftId, item.chapterNumber, item.finalizationId) as { operationId: string } | undefined
      return Boolean(deletion && !freeze.isFrozen('chapter_deletion_operations', deletion.operationId))
    }
    if (!row && !database.prepare('SELECT 1 FROM drafts_all WHERE id=?').get(item.draftId) && deletionProven()) {
      deleted.add(item.draftId)
      continue
    }
    // 回收站里的行原样保留正文与 outbox，下面的内容校验照做。
    const stillReceipted = row?.status === 'finalized' || (row?.status === 'deleted' && deletionProven())
      || (row?.status === 'superseded' && row.replaced === 1)
    if (!row || !stillReceipted || row.chapterNumber !== item.chapterNumber
      || row.finalizationId !== item.finalizationId || row.contentHash !== item.contentHash
      || row.contentSnapshot !== row.body || sha256(row.body) !== item.contentHash) invalid()
  }
  for (const item of authority.summarySources) {
    const row = database.prepare(`
      SELECT id AS summaryId,draft_id AS draftId,chapter_number AS chapterNumber,
        source_finalization_id AS sourceFinalizationId,source_content_hash AS sourceContentHash,
        projection_generation AS projectionGeneration
      FROM summary_snapshots_all WHERE id=?
    `).get(item.summaryId) as PortableSummarySourceAuthority | undefined
    if (!row && deleted.has(item.draftId)) continue
    if (!row || row.draftId !== item.draftId || row.chapterNumber !== item.chapterNumber
      || row.sourceFinalizationId !== item.sourceFinalizationId || row.sourceContentHash !== item.sourceContentHash
      || row.projectionGeneration !== item.projectionGeneration) invalid()
  }
}

export function serializePortableTransferAuthority(authority: PortableTransferAuthority): Buffer {
  const bytes = Buffer.from(JSON.stringify(parsePortableTransferAuthority(authority)), 'utf8')
  if (bytes.length > MAX_BYTES) invalid()
  return bytes
}

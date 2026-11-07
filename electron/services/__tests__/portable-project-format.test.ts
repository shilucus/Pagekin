import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../../migrations/sqlite-schema-adapter'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  assertPortableSourceSchema,
  getPortableFieldPolicy,
  listPortableFieldPolicyKeys,
  parsePortableProjectManifest,
} from '../portable-project-format'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []

function fixture(): { root: string; databasePath: string } {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/b01-portable-format')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, '项目-'))
  roots.push(root)
  const dataRoot = path.join(root, '.ai-novel')
  fs.mkdirSync(dataRoot)
  fs.writeFileSync(path.join(dataRoot, 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId: randomUUID(), createdAt: new Date().toISOString(),
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  return { root, databasePath: path.join(dataRoot, 'project.db') }
}

function openCurrent(): { databasePath: string; database: import('better-sqlite3').Database } {
  const project = fixture()
  initProjectDatabase(project.root)
  BlueprintRepository.listPendingCharacterSyncOperations()
  const database = getProjectDb()!
  return { databasePath: project.databasePath, database }
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const byteSize = 512 * 1024 * 1024
  return {
    formatVersion: 1,
    sourceSchemaVersion: 8,
    originProjectId: 'origin-project',
    snapshotGeneration: 'generation-0001',
    createdAt: '2026-09-20T00:00:00.000Z',
    declaredUncompressedBytes: byteSize,
    declaredCompressedBytes: 16 * 1024 * 1024,
    entries: [{ path: '正文/第一章-铜钥匙.txt', byteSize, sha256: 'a'.repeat(64), disposition: 'author-content' }],
    semanticCounts: { chapters: 120_000, characters: 800 },
    omittedItems: [{ id: 'vectors', reason: 'rebuild-stale' }],
    transferReceiptIds: ['transfer-1'],
    historyProjectionIds: ['history-1'],
    ...overrides,
  }
}

afterEach(() => {
  closeProjectDatabase()
  vi.doUnmock('../portable-project-field-policy.json')
  vi.resetModules()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('portable v14 field policy', () => {
  it('与实际当前registry双向精确匹配64表612字段，放行M07的四个live视图，并包含两个lazy表', () => {
    const { database } = openCurrent()
    expect(database.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    const tables = database.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    const fieldCount = tables.reduce((count, table) => count
      + (database.prepare(`PRAGMA table_info("${table.name}")`).all() as unknown[]).length, 0)
    expect({ tables: tables.length, fields: fieldCount }).toEqual({ tables: 64, fields: 612 })
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name").pluck().all()).toEqual([
      'drafts', 'finalization_outbox', 'narrative_thread_confirmations', 'summary_snapshots',
    ])
    expect(assertPortableSourceSchema(database)).toEqual({ tables: 64, fields: 612 })
    for (const field of ['deletion_id', 'deleted_from_status', 'deleted_at']) {
      expect(getPortableFieldPolicy('drafts', field)).toMatchObject({ disposition: 'preserve-domain', origin: 'm07-delta', signedDisposition: null })
    }
    expect(getPortableFieldPolicy('review_cycle_merges', 'cycle_id').disposition).toBe('historical-nonreplayable')
    expect(getPortableFieldPolicy('review_cycle_merges', 'body').disposition).toBe('historical-nonreplayable')
    expect(listPortableFieldPolicyKeys()).toContain('blueprint_commit_operations.operation_id')
    expect(listPortableFieldPolicyKeys()).toContain('blueprint_character_sync_operations.operation_id')
  })

  it('把签署S01基线35表356字段逐项投影，并精确增加M01-M05的15表/123字段、M06的1表/2字段及M07的3字段', () => {
    const signed = JSON.parse(fs.readFileSync(path.resolve(
      'docs/research/novel-quality-modernization/s01-storage-contract.json'), 'utf8')) as {
      fieldDispositions: Array<{ table: string; field: string; portableDisposition: string }>
    }
    const normalize = (value: string) => value === 'exclude-machine-authority' ? 'exclude-machine-authority'
      : value === 'allowlist-rebuild-or-block' || value === 'safe-diagnostic-projection' ? 'redacted-projection'
        : value === 'historical-read-only-projection' || value === 'non-executable-history' ? 'historical-nonreplayable'
          : value === 'rebuildable-metric-version' ? 'rebuild-stale'
            : value === 'validate-relative-projection' ? 'validated-relative' : 'preserve-domain'
    expect(new Set(signed.fieldDispositions.map(field => field.table)).size).toBe(35)
    expect(signed.fieldDispositions).toHaveLength(356)
    for (const field of signed.fieldDispositions) {
      expect(getPortableFieldPolicy(field.table, field.field)).toMatchObject({
        disposition: normalize(field.portableDisposition),
        origin: 'signed-s01',
        signedDisposition: field.portableDisposition,
      })
    }
    const baseline = new Set(signed.fieldDispositions.map(field => `${field.table}.${field.field}`))
    const baselineTables = new Set(signed.fieldDispositions.map(field => field.table))
    const added = listPortableFieldPolicyKeys().filter(key => !baseline.has(key))
    expect(added).toHaveLength(257)
    expect(added.filter(key => getPortableFieldPolicy(...key.split('.') as [string, string]).origin !== 'm13-delta')).toHaveLength(224)
    expect(getPortableFieldPolicy('characters', 'avatar')).toMatchObject({
      origin: 'registered-donor', disposition: 'exclude-machine-authority', signedDisposition: null,
    })
    const delta = added.filter(key => getPortableFieldPolicy(...key.split('.') as [string, string]).origin === 'm01-m05-delta')
    expect(delta).toHaveLength(123)
    expect(new Set(delta.map(key => key.split('.')[0]).filter(table => !baselineTables.has(table!))).size).toBe(15)
    expect(delta.filter(key => key.startsWith('characters.')).sort()).toEqual([
      'characters.character_id', 'characters.identity_revision', 'characters.legacy_key',
      'characters.retired', 'characters.static_provenance',
    ])
    expect(listPortableFieldPolicyKeys().filter(key => getPortableFieldPolicy(
      ...key.split('.') as [string, string]).origin === 'm06-delta')).toEqual([
      'review_cycle_merges.body', 'review_cycle_merges.cycle_id',
    ])
    expect(listPortableFieldPolicyKeys().filter(key => getPortableFieldPolicy(
      ...key.split('.') as [string, string]).origin === 'm07-delta')).toEqual([
      'drafts.deleted_at', 'drafts.deleted_from_status', 'drafts.deletion_id',
    ])
    expect(listPortableFieldPolicyKeys().filter(key => getPortableFieldPolicy(
      ...key.split('.') as [string, string]).origin === 'm08-delta')).toHaveLength(43)
    expect(listPortableFieldPolicyKeys().filter(key => getPortableFieldPolicy(
      ...key.split('.') as [string, string]).origin === 'm09-delta')).toEqual([
      'planning_feedback_adoptions.adopted_scope_json', 'planning_feedback_bases.scope_json',
      'planning_feedback_outline_revision.id', 'planning_feedback_outline_revision.revision',
    ])
    for (const [table, field] of [['planning_feedback_bases', 'scope_json'], ['planning_feedback_adoptions', 'adopted_scope_json']]) {
      expect(getPortableFieldPolicy(table!, field!).disposition).toBe('redacted-projection')
    }
    expect(getPortableFieldPolicy('planning_feedback_adoptions', 'request_hash').disposition).toBe('exclude-machine-authority')
    expect(getPortableFieldPolicy('planning_feedback_adoptions', 'decision_source').disposition).toBe('historical-nonreplayable')
    for (const [table, field] of [['generation_attempts', 'invocation_nonce'], ['generation_roots', 'idempotency_key'], ['generation_runs', 'open_key']]) {
      expect(getPortableFieldPolicy(table!, field!).disposition).toBe('exclude-machine-authority')
    }
    expect(getPortableFieldPolicy('planning_feedback_candidates', 'origin_json').disposition).toBe('redacted-projection')
    const grants = listPortableFieldPolicyKeys().filter(key => getPortableFieldPolicy(
      ...key.split('.') as [string, string]).origin === 'm10-delta')
    expect(grants).toHaveLength(15)
    for (const key of grants) expect(getPortableFieldPolicy(...key.split('.') as [string, string])).toMatchObject({
      disposition: key === 'runtime_feedback_grants.operation_key' ? 'exclude-machine-authority' : 'historical-nonreplayable',
      signedDisposition: null,
    })
    const tails = listPortableFieldPolicyKeys().filter(key => getPortableFieldPolicy(
      ...key.split('.') as [string, string]).origin === 'm11-delta')
    expect(tails).toEqual(['artifact_id', 'attempt_id', 'durable_revision', 'prefix_hash', 'preserved_at', 'tail_hash', 'tail_text']
      .map(field => `generation_recovery_tails.${field}`))
    for (const key of tails) expect(getPortableFieldPolicy(...key.split('.') as [string, string])).toMatchObject({
      disposition: 'historical-nonreplayable', signedDisposition: null,
    })
    const workflow = listPortableFieldPolicyKeys().filter(key => getPortableFieldPolicy(
      ...key.split('.') as [string, string]).origin === 'm12-delta')
    expect(workflow).toHaveLength(26)
    for (const key of workflow) expect(getPortableFieldPolicy(...key.split('.') as [string, string])).toMatchObject({
      disposition: ['workflow_tasks.operation_key', 'workflow_tasks.request_hash', 'workflow_steps.invocation_nonce'].includes(key)
        ? 'exclude-machine-authority' : ['workflow_tasks.recipe_json', 'workflow_steps.input_json'].includes(key)
          ? 'redacted-projection' : 'historical-nonreplayable', signedDisposition: null,
    })
    const batch = listPortableFieldPolicyKeys().filter(key => getPortableFieldPolicy(
      ...key.split('.') as [string, string]).origin === 'm13-delta')
    expect(batch).toEqual(Object.entries({
      workflow_batch_tasks: ['task_id', 'project_id', 'operation_key', 'request_hash', 'template', 'batch_run_id', 'revision',
        'state', 'blocked_code', 'recipe_json', 'recipe_hash', 'review_model_id', 'review_model_hash', 'created_at', 'updated_at'],
      workflow_batch_steps: ['step_id', 'task_id', 'chapter_number', 'role', 'kind', 'slot', 'command_id', 'run_id',
        'invocation_nonce', 'input_json', 'input_hash'],
      workflow_batch_effects: ['step_id', 'receipt_kind', 'receipt_attempt_id', 'content_hash', 'acknowledged_at',
        'semantic_history_json', 'semantic_history_hash'],
    }).flatMap(([table, fields]) => fields.map(field => `${table}.${field}`)).sort())
    for (const key of batch) expect(getPortableFieldPolicy(...key.split('.') as [string, string])).toMatchObject({
      disposition: ['workflow_batch_tasks.operation_key', 'workflow_batch_tasks.request_hash', 'workflow_batch_tasks.review_model_id',
        'workflow_batch_tasks.review_model_hash', 'workflow_batch_steps.invocation_nonce'].includes(key) ? 'exclude-machine-authority'
        : ['workflow_batch_tasks.recipe_json', 'workflow_batch_steps.input_json', 'workflow_batch_effects.semantic_history_json'].includes(key)
          ? 'redacted-projection' : 'historical-nonreplayable', signedDisposition: null,
    })
  })

  it('机器权限、执行历史、未知nested与M05头像采用不同的fail-closed处置', () => {
    expect(getPortableFieldPolicy('import_runs', 'execution_owner').disposition).toBe('exclude-machine-authority')
    expect(getPortableFieldPolicy('import_legacy_identity_bridge', 'ciphertext_hex').disposition).toBe('exclude-machine-authority')
    expect(getPortableFieldPolicy('generation_runs', 'status').disposition).toBe('historical-nonreplayable')
    expect(getPortableFieldPolicy('review_cycles', 'revision_status').disposition).toBe('historical-nonreplayable')
    expect(getPortableFieldPolicy('import_effect_ledger', 'state').disposition).toBe('historical-nonreplayable')
    expect(getPortableFieldPolicy('generation_attempts', 'attempt_json').disposition).toBe('redacted-projection')
    expect(getPortableFieldPolicy('character_avatar_assets', 'relative_path').disposition).toBe('avatar-asset')
    expect(getPortableFieldPolicy('character_avatar_unresolved', 'disposition')).toMatchObject({
      disposition: 'avatar-asset', validator: 'character-asset-or-reference-only',
    })
    expect(getPortableFieldPolicy('contents', 'body').disposition).toBe('preserve-domain')
    expect(() => getPortableFieldPolicy('future_table', 'opaque_json')).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
  })

  it.each(['extra-table', 'extra-field', 'unregistered-avatar', 'higher-version', 'lower-version', 'legacy-v6',
    'extra-view', 'altered-live-view'] as const)(
    '%s在只读门拒绝且不再改源DB', mode => {
      const project = fixture()
      const mutate = new Database(project.databasePath)
      try {
        if (mode === 'extra-table') mutate.exec('CREATE TABLE future_portable_data(id TEXT)')
        if (mode === 'extra-field') mutate.exec('ALTER TABLE contents ADD COLUMN future_payload TEXT')
        if (mode === 'unregistered-avatar') mutate.exec('ALTER TABLE characters ADD COLUMN avatar TEXT')
        if (mode === 'higher-version') mutate.pragma(`user_version = ${CURRENT_DESKTOP_SCHEMA_VERSION + 1}`)
        if (mode === 'lower-version') mutate.pragma('user_version = 5')
        if (mode === 'extra-view') mutate.exec('CREATE VIEW future_portable_view AS SELECT id FROM contents')
        if (mode === 'altered-live-view') mutate.exec('DROP VIEW drafts; CREATE VIEW drafts AS SELECT * FROM drafts_all')
        if (mode === 'legacy-v6') {
          mutate.exec('DROP TABLE review_cycle_merges')
          mutate.pragma('user_version = 6')
        }
      } finally { mutate.close() }
      const before = fs.readFileSync(project.databasePath)
      const database = new Database(project.databasePath)
      try { expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED') }
      finally { database.close() }
      expect(fs.readFileSync(project.databasePath)).toEqual(before)
    },
  )

  it('按包声明版本分别核验schema 7、8、9、10、11、12、13，不混用列集合和DDL', () => {
    const database = new Database(':memory:')
    try {
      database.transaction(() => initializeLegacyBaselineSchema(database))()
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 7)
      expect(assertPortableSourceSchema(database, 7)).toEqual({ tables: 51, fields: 481 })
      expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 8)
      expect(() => assertPortableSourceSchema(database, 7)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      expect(assertPortableSourceSchema(database, 8)).toEqual({ tables: 51, fields: 484 })
      expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 9)
      expect(() => assertPortableSourceSchema(database, 8)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      expect(assertPortableSourceSchema(database, 9)).toEqual({ tables: 55, fields: 527 })
      expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 10)
      expect(() => assertPortableSourceSchema(database, 9)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      expect(assertPortableSourceSchema(database, 10)).toEqual({ tables: 56, fields: 531 })
      expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 11)
      expect(() => assertPortableSourceSchema(database, 10)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      expect(assertPortableSourceSchema(database, 11)).toEqual({ tables: 57, fields: 546 })
      expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 12)
      expect(() => assertPortableSourceSchema(database, 11)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      expect(assertPortableSourceSchema(database, 12)).toEqual({ tables: 58, fields: 553 })
      expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 13)
      expect(assertPortableSourceSchema(database, 13)).toEqual({ tables: 61, fields: 579 })
      expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(() => assertPortableSourceSchema(database, 12)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
      expect(assertPortableSourceSchema(database)).toEqual({ tables: 64, fields: 612 })
    } finally { database.close() }
  })

  it.each(['normal', 'donor'] as const)('pins the immutable 1815d16a schema-9 %s fingerprint before upgrading', variant => {
    const database = new Database(':memory:')
    try {
      database.transaction(() => initializeLegacyBaselineSchema(database))()
      if (variant === 'donor') {
        const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
        database.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
        database.exec(row.sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
        database.exec('DROP TABLE characters_without_avatar')
      }
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 9)
      // Captured by executing the immutable 1815d16ae12b15c852b34b0cea06d790439ae5a7 source closure.
      expect(sqliteSchemaFingerprint(database)).toBe(variant === 'normal'
        ? '361b1c5416492d9e4a827119aaf8bcfdea25ecd52fc26e65207c77f901e780d2'
        : '6d513eed561970b9db78e9b75f7259b383f8e1eeb7194a71fe222dccaec007e7')
      expect(assertPortableSourceSchema(database, 9)).toEqual({ tables: 55, fields: variant === 'normal' ? 527 : 528 })
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 10)
      expect(assertPortableSourceSchema(database, 10)).toEqual({ tables: 56, fields: variant === 'normal' ? 531 : 532 })
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(assertPortableSourceSchema(database)).toEqual({ tables: 64, fields: variant === 'normal' ? 612 : 613 })
    } finally { database.close() }
  })

  it.each(['normal', 'donor'] as const)('pins the immutable 546486a schema-11 %s fingerprint before M11', variant => {
    const database = new Database(':memory:')
    try {
      database.transaction(() => initializeLegacyBaselineSchema(database))()
      if (variant === 'donor') {
        const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
        database.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
        database.exec(row.sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
        database.exec('DROP TABLE characters_without_avatar')
      }
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 11)
      // Captured by root from the immutable 546486a82832cf1c63d6754b98c9be5ebc28371a source closure.
      expect(sqliteSchemaFingerprint(database)).toBe(variant === 'normal'
        ? '3b151d5a40e96963f9f0e467823df87ece9002bc37de80b67c967f35122d2c7a'
        : '1d6c2f83c2f5047b46952e1485bd10591140de7c888431fe5d24f18456be0a53')
      expect(assertPortableSourceSchema(database, 11)).toEqual({ tables: 57, fields: variant === 'normal' ? 546 : 547 })
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(assertPortableSourceSchema(database)).toEqual({ tables: 64, fields: variant === 'normal' ? 612 : 613 })
    } finally { database.close() }
  })

  it.each(['normal', 'donor'] as const)('pins the immutable d33a907 schema-12 %s fingerprint before M12', variant => {
    const database = new Database(':memory:')
    try {
      database.transaction(() => initializeLegacyBaselineSchema(database))()
      if (variant === 'donor') {
        const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
        database.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
        database.exec(row.sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
        database.exec('DROP TABLE characters_without_avatar')
      }
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 12)
      // Captured by root from the immutable d33a907e50e4ece4bdaa334a40f6627d4a87cc39 source closure.
      expect(sqliteSchemaFingerprint(database)).toBe(variant === 'normal'
        ? '5a3b32060a5e785f7a86872c6a32c2dc42646c50ba329c14af8a03fd0eccd9e0'
        : '188a053ae4383277590ee57e35c7ec514ecddc6d025225cc1bf8e88b6c1d9900')
      expect(assertPortableSourceSchema(database, 12)).toEqual({ tables: 58, fields: variant === 'normal' ? 553 : 554 })
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(assertPortableSourceSchema(database)).toEqual({ tables: 64, fields: variant === 'normal' ? 612 : 613 })
    } finally { database.close() }
  })

  it.each(['normal', 'donor'] as const)('pins the captured immutable c8fc65fa schema-13 %s identity before M13', variant => {
    const database = new Database(':memory:')
    try {
      database.transaction(() => initializeLegacyBaselineSchema(database))()
      if (variant === 'donor') {
        const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
        database.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
        database.exec(row.sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
        database.exec('DROP TABLE characters_without_avatar')
      }
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), 13)
      // Captured from the immutable c8fc65fa1c8bc0934eda0f8e648237b0b8440ece closure, not generated by M13.
      expect(sqliteSchemaFingerprint(database)).toBe(variant === 'normal'
        ? '0085a4739a488e00fcb59d22df89d952facecec62afb311b7f4f3d339f21a540'
        : '56add2e81a7516281abe9f25091632d441b8c2b55228aeba448cce7feb136e00')
      expect(assertPortableSourceSchema(database, 13)).toEqual({ tables: 61, fields: variant === 'normal' ? 579 : 580 })
      migrateSchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(assertPortableSourceSchema(database)).toEqual({ tables: 64, fields: variant === 'normal' ? 612 : 613 })
    } finally { database.close() }
  })

  it('同表同字段但删除index的current DDL fork被registry fingerprint拒绝', () => {
    const project = fixture()
    const mutate = new Database(project.databasePath)
    try { mutate.exec('DROP INDEX idx_character_avatar_revision') } finally { mutate.close() }
    const before = fs.readFileSync(project.databasePath)
    const database = new Database(project.databasePath)
    try {
      database.pragma('foreign_keys = ON')
      const tables = database.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
      const fields = tables.reduce((count, table) => count
        + (database.prepare(`PRAGMA table_info("${table.name}")`).all() as unknown[]).length, 0)
      expect({ tables: tables.length, fields }).toEqual({ tables: 64, fields: 612 })
      expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    } finally { database.close() }
    expect(fs.readFileSync(project.databasePath)).toEqual(before)
  })

  it('recognized DDL含外键破坏时仍由integrity/foreign-key gate拒绝', () => {
    const project = fixture()
    const mutate = new Database(project.databasePath)
    try {
      mutate.pragma('foreign_keys = OFF')
      mutate.prepare(`INSERT INTO character_avatar_assets(
        character_id,asset_revision,relative_path,content_hash,mime,byte_size,source_reference
      ) VALUES(?,?,?,?,?,?,?)`).run('missing-character', 1, 'avatars/missing.png', 'a'.repeat(64), 'image/png', 1, '')
    } finally { mutate.close() }
    const before = fs.readFileSync(project.databasePath)
    const database = new Database(project.databasePath)
    try { expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED') }
    finally { database.close() }
    expect(fs.readFileSync(project.databasePath)).toEqual(before)
  })

  it.each([['contents', 'body'], ['runtime_feedback_grants', 'grant_id'], ['generation_recovery_tails', 'tail_text'], ['workflow_tasks', 'recipe_json']])('rejects a missing policy for %s.%s without mutating the source', async (table, field) => {
    const project = fixture()
    const document = JSON.parse(fs.readFileSync(path.resolve(
      'electron/services/portable-project-field-policy.json'), 'utf8')) as {
      tables: Record<string, Record<string, string>>
    }
    delete document.tables[table!]![field!]
    vi.resetModules()
    vi.doMock('../portable-project-field-policy.json', () => ({ default: document }))
    const isolated = await import('../portable-project-format')
    const before = fs.readFileSync(project.databasePath)
    const database = new Database(project.databasePath)
    try { expect(() => isolated.assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED') }
    finally { database.close() }
    expect(fs.readFileSync(project.databasePath)).toEqual(before)
  })
})

describe('portable manifest v1', () => {
  it('接受 M07 之前（v1.2.0-Preview 到 v1.4.0）导出的 sourceSchemaVersion 7 清单，并原样报告版本', () => {
    expect(parsePortableProjectManifest(manifest({ sourceSchemaVersion: 7 })).sourceSchemaVersion).toBe(7)
    expect(parsePortableProjectManifest(manifest()).sourceSchemaVersion).toBe(8)
    expect(parsePortableProjectManifest(manifest({ sourceSchemaVersion: 9 })).sourceSchemaVersion).toBe(9)
    expect(parsePortableProjectManifest(manifest({ sourceSchemaVersion: 10 })).sourceSchemaVersion).toBe(10)
    expect(parsePortableProjectManifest(manifest({ sourceSchemaVersion: 11 })).sourceSchemaVersion).toBe(11)
    expect(parsePortableProjectManifest(manifest({ sourceSchemaVersion: 12 })).sourceSchemaVersion).toBe(12)
    expect(parsePortableProjectManifest(manifest({ sourceSchemaVersion: 13 })).sourceSchemaVersion).toBe(13)
  })

  it('接受有界的大型中文项目声明与引用标识', () => {
    const parsed = parsePortableProjectManifest(manifest())
    expect(parsed.entries[0]).toMatchObject({ path: '正文/第一章-铜钥匙.txt', disposition: 'author-content' })
    expect(parsed.transferReceiptIds).toEqual(['transfer-1'])
    expect(parsed.historyProjectionIds).toEqual(['history-1'])
  })

  it.each([
    '/absolute.txt', 'C:/machine.txt', '目录\\file.txt', '目录/../file.txt', '目录/./file.txt',
    '目录/con.txt', '目录/name.', '目录/name ', `目录/a\0b`, '目录／..／file.txt',
  ])('拒绝恶意或跨平台不安全路径 %s', unsafe => {
    expect(() => parsePortableProjectManifest(manifest({
      entries: [{ path: unsafe, byteSize: 1, sha256: 'a'.repeat(64), disposition: 'author-content' }],
      declaredUncompressedBytes: 1,
      declaredCompressedBytes: 1,
    }))).toThrow('PORTABLE_PATH_UNSAFE')
  })

  it('normalize前拒绝孤立或配对surrogate，避免与replacement character碰撞', () => {
    const entry = (path: string) => ({ path, byteSize: 1, sha256: 'a'.repeat(64), disposition: 'author-content' })
    expect(() => parsePortableProjectManifest(manifest({
      entries: [entry('assets/\uD800.txt'), entry('assets/\uFFFD.txt')],
      declaredUncompressedBytes: 2,
      declaredCompressedBytes: 1,
    }))).toThrow('PORTABLE_PATH_UNSAFE')
    expect(() => parsePortableProjectManifest(manifest({
      entries: [entry('assets/😀.txt')],
      declaredUncompressedBytes: 1,
      declaredCompressedBytes: 1,
    }))).toThrow('PORTABLE_PATH_UNSAFE')
    expect(parsePortableProjectManifest(manifest({
      entries: [entry('assets/\uFFFD.txt')],
      declaredUncompressedBytes: 1,
      declaredCompressedBytes: 1,
    })).entries[0]!.path).toBe('assets/\uFFFD.txt')
  })

  it.each([
    ['大小写折叠重复', ['Assets/头像.png', 'assets/头像.png']],
    ['Unicode折叠重复', ['正文/Café.txt', '正文/Café.txt']],
    ['文件目录冲突', ['assets', 'assets/avatar.png']],
  ])('拒绝%s', (_label, paths) => {
    expect(() => parsePortableProjectManifest(manifest({
      entries: (paths as string[]).map(item => ({ path: item, byteSize: 1, sha256: 'a'.repeat(64), disposition: 'author-content' })),
      declaredUncompressedBytes: 2,
      declaredCompressedBytes: 1,
    }))).toThrow('PORTABLE_PATH_CONFLICT')
  })

  it('拒绝未知格式、非法hash、非安全整数和声明总量不符', () => {
    for (const version of [6, CURRENT_DESKTOP_SCHEMA_VERSION + 1, '8', null]) {
      expect(() => parsePortableProjectManifest(manifest({ sourceSchemaVersion: version })), String(version)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    }
    expect(() => parsePortableProjectManifest(manifest({ entries: [{
      path: '正文/a.txt', byteSize: 1, sha256: 'A'.repeat(64), disposition: 'author-content',
    }], declaredUncompressedBytes: 1, declaredCompressedBytes: 1 }))).toThrow('PORTABLE_MANIFEST_INVALID')
    expect(() => parsePortableProjectManifest(manifest({ declaredUncompressedBytes: Number.MAX_VALUE })))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest({ declaredUncompressedBytes: 1 })))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  })

  it('显式limits约束数量、单项、总量、压缩声明和压缩比', () => {
    const twoEntries = {
      entries: [
        { path: 'a.txt', byteSize: 1, sha256: 'a'.repeat(64), disposition: 'author-content' },
        { path: 'b.txt', byteSize: 1, sha256: 'b'.repeat(64), disposition: 'author-content' },
      ],
      declaredUncompressedBytes: 2,
      declaredCompressedBytes: 1,
    }
    expect(() => parsePortableProjectManifest(manifest(twoEntries), { maxEntries: 1 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest(), { maxEntryBytes: 1024 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest(), { maxTotalBytes: 1024 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest(), { maxDeclaredCompressedBytes: 1024 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest({ declaredCompressedBytes: 1 }), { maxCompressionRatio: 2 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxTotalBytes).toBeGreaterThan(8 * 1024 ** 3)
  })
})

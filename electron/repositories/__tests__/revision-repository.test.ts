import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { createLiveRowViews } from '../../../test/helpers/live-row-views'
import { ContentRepository } from '../content-repository'
import { RevisionRepository } from '../revision-repository'
import { ReviewRepository } from '../review-repository'
import { ReviewCycleRepository } from '../review-cycle-repository'
import { textHash } from '../generation-run-repository'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { readOrdinaryHistoryDomainRecords, readVerifiedOrdinaryHistory } from '../../migrations/ordinary-review-history'
import { WorkflowBatchAuthority } from '../../services/workflow-batch-authority'
import { createMainGenerationOwner, safeGenerationModelReceipt, type MainGenerationOwnerDependencies } from '../../services/main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../../services/generation-source-binding'
import { readMainGenerationPolicy } from '../../services/main-generation-plan'
import { sanitizePortableDatabase } from '../../services/project-archive-service'
import type { ProjectRuntime } from '../../services/project-runtime'
import type { GenerationRunServiceDependencies } from '../../services/generation-run-service'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../../src/shared/builtin-writing-skills'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { createHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief, serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
let db: BetterSqlite3.Database
const disposers: (() => void)[] = []
const temporaryRoots: string[] = []

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL
    );
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'write',
      content_id INTEGER NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE TABLE revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,
      revision_index INTEGER NOT NULL,
      revision_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      merged_to_draft_id INTEGER,
      user_prompt TEXT DEFAULT '',
      review_source_id INTEGER,
      source_draft_chapter_number INTEGER,
      source_draft_version INTEGER,
      source_draft_status TEXT,
      source_content TEXT,
      content_id INTEGER NOT NULL,
      word_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT,
      UNIQUE(base_draft_id, revision_index)
    );
  `)
  createLiveRowViews(db)
  vi.mocked(getProjectDb).mockReturnValue(db)
  const draftContentId = ContentRepository.create('原稿')
  db.prepare('INSERT INTO drafts_all (content_id) VALUES (?)').run(draftContentId)
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  db.close()
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const expectedSource = {
  id: 1,
  chapterNumber: 1,
  version: 1,
  status: 'draft' as const,
  content: '原稿',
}

/** Real domain receipts are projected by the production sanitizer, not fabricated as a history marker. */
async function historicalPendingFixture() {
  db.close()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-revision-history-'))
  temporaryRoots.push(root)
  const databasePath = path.join(root, 'project.db')
  db = new Database(databasePath)
  db.pragma('foreign_keys=ON')
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  const sourceText = '林岚走进北塔，灯火照亮石阶。'.repeat(20) + '门闩上的裂纹仍在。'
  const revisionText = sourceText.replace('门闩上的裂纹仍在。', '门闩上的裂纹已用石蜡封住。')
  db.prepare("INSERT INTO project_core(id,project_name,writing_language,words_per_chapter,total_chapters) VALUES('main','合成历史','zh-CN',?,1)").run(countDraftUnits(sourceText))
  db.prepare('INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,?,?)').run('北塔', '修复门闩上的裂纹')
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
    apiKey: 'synthetic-no-network', baseUrl: 'https://synthetic.invalid/v1', temperature: 0.7, maxTokens: 2048,
    purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const loadModel = (id: string) => id === model.id ? model : null
  const outputs = ['林岚检查门闩，发现裂纹并安排修复。', sourceText, JSON.stringify({ summary: '修复门闩事实。',
    items: [{ category: '表达', severity: 'pass', description: '其余表达可接受。' }], goalReviews: [{ id: 'ch1:keyEvents:1',
      evidence: [{ quote: '门闩上的裂纹仍在' }], description: '门闩裂纹尚未处理。', status: 'unmet' }] }), revisionText]
  const dispatch: GenerationRunServiceDependencies['dispatch'] = async (_request, options) => {
    const output = outputs.shift()
    if (output === undefined) throw new Error('SYNTHETIC_OUTPUT_EXHAUSTED')
    options.onVisible({ kind: 'delta', text: output })
    return { finishReason: 'stop', usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50,
      reasoningTokens: null, accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true } }
  }
  const bindingDeps = { db, projectStorageRoot: root, globalDataRoot: root,
    readBuiltinPrompt: (key: string, language: 'zh-CN' | 'en-US') => JSON.stringify(getBuiltinPromptTemplate(key, language)),
    readBuiltinSkill: readBuiltinWritingSkill }
  const makeOwner = (extra: Partial<MainGenerationOwnerDependencies> = {}) => {
    const owner = createMainGenerationOwner({ database: db, projectPath: root, projectId: 'project', epoch: 'epoch-1',
      assertCurrent() {}, leases: new ModelExecutionLeaseRegistry({ loadModel }), loadModel, dispatch,
      buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(bindingDeps, { ...selection,
        projectId: 'project', epoch: 'epoch-1', modelReceipt, policy, freezeWritingLanguage: true,
        outputContract: generationOutputContract(selection) }).binding,
      rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(bindingDeps, previous, 'epoch-1', modelReceipt,
        readMainGenerationPolicy(previous.sourceManifest.policy)).binding, ...extra })
    disposers.push(() => owner.suspendForProjectClose())
    return owner
  }
  const leases = new ModelExecutionLeaseRegistry({ loadModel })
  const authority = new WorkflowBatchAuthority({ runtime: { database: db, projectId: 'project', executionEpoch: 'epoch-1',
    canonicalRoot: root, projectStorageRoot: root } as ProjectRuntime, globalDataRoot: root,
    assertAdmission() {}, assertCapturedResources() {}, acquireWork: () => () => {},
    readSafeModelReceipt: id => { const lease = leases.begin(id); try { return safeGenerationModelReceipt(lease) } finally { leases.close(lease.leaseId) } },
    captureKnowledge: async query => ({ version: 1, state: 'empty', storageState: 'absent', query, topK: 5,
      canonicalRevision: null, documentsRevision: null, items: [] }),
    withKnowledge: async (_handle, operation) => operation(), withPreparedKnowledge: async (_id, _chapter, operation) => operation(),
    createOwner: hooks => makeOwner({ mode: 'workflow-batch', recoverInterrupted: false, ...hooks }) })
  const subject = { isDestroyed: () => false, once() {} }
  const started = await authority.start(subject, { operationKey: randomUUID(), modelId: model.id, reviewModelId: model.id,
    uiLocale: 'zh-CN', intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 1 }, targetUnits: countDraftUnits(sourceText) }, authorInputs: [] }, () => {})
  if (!started.reference) throw new Error('SYNTHETIC_REFERENCE_MISSING')
  const reference = started.reference
  await vi.waitFor(() => { expect(authority.readReceipt(subject, reference).task.state).toBe('waiting_review'); expect(authority.hasIssuance()).toBe(false) })
  const review = authority.readReceipt(subject, reference).chapters[0]!.review!
  authority.retireIdle()
  const owner = makeOwner({ recoverInterrupted: false })
  const cycle = ReviewCycleRepository.getByReviewId(review.id, db)!
  const finding = cycle.findings.find(item => item.targetId === 'ch1:keyEvents:1')!
  const snapshot = createHumanConfirmedReviewSnapshot({ cycleId: cycle.cycleId, sourceReviewId: review.id, sourceDraft: review.source,
    summary: '作者确认修复门闩', authorGuidance: '', items: [{ findingId: finding.findingId, category: '本章目标', severity: 'error',
      description: '门闩裂纹尚未处理。', quote: '门闩上的裂纹仍在', goalId: finding.targetId!, decision: 'apply', origin: 'ai' }] })!
  const content = serializeHumanConfirmedReviewSnapshot(snapshot)
  const confirmation = db.transaction(() => {
    const saved = ReviewRepository.create({ baseDraftId: review.source.id, content, expectedSource: review.source }, db)
    ReviewCycleRepository.commitAuthorConfirmation({ cycleId: cycle.cycleId, confirmationReviewId: saved.id }, db)
    return saved
  })()
  const prepared = owner.prepareReviewRevision({ operation: 'refine-from-review', draftId: review.source.id,
    expectedDraft: { chapterNumber: 1, version: review.source.version, status: 'draft', contentHash: textHash(sourceText) },
    reviewSourceId: confirmation.id, confirmedReviewContent: content, authorInputs: [], uiLocale: 'zh-CN' })
  const selection: BeginGenerationRequest = { operation: 'refine-from-review', uiActionNonce: randomUUID(), modelId: model.id,
    chapterNumber: 1, selectedDraftIds: [review.source.id], selectedFinalizedDraftIds: [], promptKeys: ['refine_from_review'],
    skillStages: ['refinement'], output: 'visible-text', parentRootActionId: prepared.parentRootActionId,
    reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }] }
  const view = owner.begin(selection), prompt = '只修复门闩事实', brief = renderHumanConfirmedReviewBrief(snapshot, 'zh-CN')
  owner.bindMaterialDecision(view.handle, { version: 1, verdict: 'admitted', promptHash: textHash(prompt),
    capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: Buffer.byteLength(brief) },
    coverage: { required: 1, included: 1, complete: true }, included: [{ sourceId: `review:confirmed:${confirmation.id}`,
      revision: confirmation.id, contentHash: textHash(brief), category: 'author', required: true, units: Buffer.byteLength(brief) }], omitted: [] })
  const execution = await owner.execute({ handle: view.handle, invocationNonce: randomUUID(), task: {
    purpose: 'refine-from-review', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
  const composition = owner.composeVisible(view.handle, [execution.outcome.receipt.visibleArtifact!.artifactId], textHash(revisionText), 'visible-append-v1')
  const revision = owner.commitRevision({ contextId: prepared.contextId, handle: view.handle, expectedCompositionHash: composition.textHash })
  owner.retireIdle()
  db.close()
  const projected = sanitizePortableDatabase(databasePath)
  expect(projected.history.some(item => item.table === 'revisions' && item.recordId === String(revision.id))).toBe(true)
  db = new Database(databasePath)
  db.pragma('foreign_keys=ON')
  vi.mocked(getProjectDb).mockReturnValue(db)
  expect(readVerifiedOrdinaryHistory(db).cycleIds).toContain(cycle.cycleId)
  expect(readOrdinaryHistoryDomainRecords(db)).toContainEqual({ table: 'revisions', recordId: String(revision.id) })
  return { source: review.source, revisionId: revision.id, cycleId: cycle.cycleId }
}

describe('RevisionRepository.replacePending', () => {
  it.each(['refine', 'review-fix'] as const)('preserves the proved portable pending candidate while replacing only live pending (%s)', async revisionType => {
    const history = await historicalPendingFixture()
    const facts = () => ({
      revision: db.prepare('SELECT * FROM revisions WHERE id=?').get(history.revisionId),
      content: RevisionRepository.getFull(history.revisionId, db)?.content,
      cycle: db.prepare('SELECT * FROM review_cycles WHERE cycle_id=?').get(history.cycleId),
      attempts: db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all(),
      effects: db.prepare('SELECT * FROM workflow_batch_effects ORDER BY rowid').all(),
    })
    const before = facts()
    const live = RevisionRepository.replacePending({ baseDraftId: history.source.id, revisionType,
      content: '可写的新修稿一', wordCount: 7, expectedSource: history.source }, db)
    expect(live.discardedRevisionIds).toEqual([])
    const replacement = RevisionRepository.replacePending({ baseDraftId: history.source.id, revisionType,
      content: '可写的新修稿二', wordCount: 7, expectedSource: history.source }, db)
    expect(replacement.discardedRevisionIds).toEqual([live.id])
    expect(replacement.revisionIndex).toBe(live.revisionIndex + 1)
    expect(RevisionRepository.getPending(history.source.id).map(item => item.id)).toEqual([history.revisionId, replacement.id])
    expect(RevisionRepository.getFull(live.id, db)?.status).toBe('discarded')
    expect(RevisionRepository.getFull(history.revisionId, db)?.status).toBe('pending')
    expect(facts()).toEqual(before)
    expect(readVerifiedOrdinaryHistory(db).cycleIds).toContain(history.cycleId)
    const frozen = db.serialize(), changes = db.prepare('SELECT total_changes()').pluck().get()
    expect(() => RevisionRepository.mergeIntoDraft({ revisionId: history.revisionId, targetDraftId: history.source.id,
      expectedDraftContent: history.source.content, mergedContent: '旧历史候选不得合并', wordCount: 10 }, db)).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(db.serialize()).toEqual(frozen)
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
    expect(() => RevisionRepository.markDiscarded(history.revisionId, db)).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(db.serialize()).toEqual(frozen)
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  })

  it('rejects a corrupt portable proof before allocating contents or replacing any candidate', async () => {
    const history = await historicalPendingFixture()
    db.prepare("UPDATE workflow_batch_effects SET semantic_history_hash=? WHERE receipt_kind='review_commit'").run('0'.repeat(64))
    const before = db.serialize()
    expect(() => RevisionRepository.replacePending({ baseDraftId: history.source.id, revisionType: 'refine',
      content: '不得分配的新修稿', wordCount: 8, expectedSource: history.source }, db)).toThrow('ORDINARY_REVIEW_HISTORY_INVALID')
    expect(db.serialize()).toEqual(before)
  })

  it('rejects creating a new revision without a frozen source', () => {
    expect(() => RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '无来源修订',
      wordCount: 6,
    })).toThrow('SOURCE_DRAFT_CHANGED')
    expect(RevisionRepository.listByDraft(1)).toEqual([])
  })

  it.each([
    ['id', { id: 999, chapterNumber: 1, version: 1, status: 'draft', content: '原稿' }],
    ['chapter', { id: 1, chapterNumber: 2, version: 1, status: 'draft', content: '原稿' }],
    ['version', { id: 1, chapterNumber: 1, version: 2, status: 'draft', content: '原稿' }],
    ['status', { id: 1, chapterNumber: 1, version: 1, status: 'reviewed', content: '原稿' }],
    ['content', { id: 1, chapterNumber: 1, version: 1, status: 'draft', content: '过期原稿' }],
  ] as const)('atomically rejects a stale frozen source %s without allocating content', (_field, expectedSource) => {
    const contentsBefore = db.prepare('SELECT COUNT(*) AS count FROM contents').get() as { count: number }

    expect(() => RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '不应保存的修订',
      wordCount: 7,
      expectedSource,
    })).toThrow('SOURCE_DRAFT_CHANGED')

    expect(RevisionRepository.listByDraft(1)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM contents').get())
      .toEqual(contentsBefore)
  })

  it('validates the frozen source and creates the replacement in one transaction', () => {
    const replacement = RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '合法新修订',
      wordCount: 6,
      expectedSource: {
        id: 1,
        chapterNumber: 1,
        version: 1,
        status: 'draft',
        content: '原稿',
      },
    })

    expect(replacement).toEqual({ id: 1, revisionIndex: 1, discardedRevisionIds: [] })
    expect(RevisionRepository.getFull(replacement.id)).toMatchObject({
      content: '合法新修订',
      sourceDraft: {
        id: 1,
        chapterNumber: 1,
        version: 1,
        status: 'draft',
        content: '原稿',
      },
    })
  })

  it('creates the replacement and discards every previous pending revision in one transaction', () => {
    const first = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '旧修订一',
      wordCount: 5,
      expectedSource,
    })
    const second = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'review-fix',
      content: '旧修订二',
      wordCount: 5,
      expectedSource,
    })

    const replacement = RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '完整新修订',
      wordCount: 6,
      expectedSource,
    })

    expect(replacement.revisionIndex).toBe(3)
    expect(RevisionRepository.getPending(1).map(item => item.id)).toEqual([replacement.id])
    expect(RevisionRepository.getFull(replacement.id)?.content).toBe('完整新修订')
    expect(RevisionRepository.listByDraft(1).map(item => [item.id, item.status])).toEqual([
      [first.id, 'discarded'],
      [second.id, 'discarded'],
      [replacement.id, 'pending'],
    ])
  })

  it('rolls back discards and content allocation when replacement creation fails', () => {
    const original = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '仍需保留的修订',
      wordCount: 7,
      expectedSource,
    })
    db.exec(`
      CREATE TRIGGER reject_replacement BEFORE INSERT ON revisions
      WHEN NEW.revision_index = 2
      BEGIN
        SELECT RAISE(ABORT, 'replacement rejected');
      END;
    `)
    const contentsBefore = db.prepare('SELECT COUNT(*) AS count FROM contents').get() as { count: number }

    expect(() => RevisionRepository.replacePending({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '失败的新修订',
      wordCount: 6,
      expectedSource,
    })).toThrow('replacement rejected')

    expect(RevisionRepository.getPending(1).map(item => item.id)).toEqual([original.id])
    const contentsAfter = db.prepare('SELECT COUNT(*) AS count FROM contents').get() as { count: number }
    expect(contentsAfter.count).toBe(contentsBefore.count)
  })
})

describe('RevisionRepository.mergeIntoDraft', () => {
  function mergeRequest(revisionId: number) {
    return {
      revisionId,
      targetDraftId: 1,
      expectedDraftContent: '原稿',
      mergedContent: '人工确认后的合并正文',
      wordCount: 10,
    }
  }

  it('atomically persists the merged body, revised status, and revision relationship', () => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: 'AI 修订候选',
      wordCount: 7,
      expectedSource,
    })

    const receipt = RevisionRepository.mergeIntoDraft(mergeRequest(revision.id))

    expect(receipt).toEqual({
      revisionId: revision.id,
      targetDraftId: 1,
      status: 'revised',
      wordCount: 10,
      idempotent: false,
      chapterNumber: 1,
      version: 1,
    })
    expect(db.prepare(`
      SELECT drafts.status, drafts.word_count, contents.body
      FROM drafts JOIN contents ON contents.id = drafts.content_id
      WHERE drafts.id = 1
    `).get()).toEqual({
      status: 'revised',
      word_count: 10,
      body: '人工确认后的合并正文',
    })
    expect(RevisionRepository.getFull(revision.id)).toMatchObject({
      status: 'merged',
      mergedToDraftId: 1,
    })
  })

  it.each([
    ['正文写入', 'contents'],
    ['草稿状态写入', 'drafts_all'],
    ['修订关系写入', 'revisions'],
  ])('rolls back every fact when %s fails', (_label, table) => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: 'AI 修订候选',
      wordCount: 7,
      expectedSource,
    })
    db.exec(`
      CREATE TRIGGER reject_merge_${table} BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'injected ${table} failure'); END;
    `)

    expect(() => RevisionRepository.mergeIntoDraft(mergeRequest(revision.id)))
      .toThrow(`injected ${table} failure`)
    expect(db.prepare(`
      SELECT drafts.status, drafts.word_count, contents.body
      FROM drafts JOIN contents ON contents.id = drafts.content_id
      WHERE drafts.id = 1
    `).get()).toEqual({ status: 'draft', word_count: 0, body: '原稿' })
    expect(RevisionRepository.getFull(revision.id)).toMatchObject({
      status: 'pending',
      mergedToDraftId: null,
    })
  })

  it('returns the same read-back result after a lost receipt without writing again', () => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: 'AI 修订候选',
      wordCount: 7,
      expectedSource,
    })
    const request = mergeRequest(revision.id)
    RevisionRepository.mergeIntoDraft(request)

    expect(RevisionRepository.mergeIntoDraft(request)).toEqual({
      revisionId: revision.id,
      targetDraftId: 1,
      status: 'revised',
      wordCount: 10,
      idempotent: true,
      chapterNumber: 1,
      version: 1,
    })

    db.prepare('UPDATE contents SET body = ? WHERE id = 1').run('合并成功后的用户新编辑')
    expect(() => RevisionRepository.mergeIntoDraft(request)).toThrow('REVISION_ALREADY_MERGED')
    expect(db.prepare('SELECT body FROM contents WHERE id = 1').get())
      .toEqual({ body: '合并成功后的用户新编辑' })
  })

  it('rejects a stale base, foreign revision, and finalized target without changing data', () => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: 'AI 修订候选',
      wordCount: 7,
      expectedSource,
    })
    expect(() => RevisionRepository.mergeIntoDraft({
      ...mergeRequest(revision.id),
      expectedDraftContent: '过期原稿',
    })).toThrow('REVISION_TARGET_CHANGED')

    const secondContentId = ContentRepository.create('另一个草稿')
    db.prepare('INSERT INTO drafts_all (content_id) VALUES (?)').run(secondContentId)
    expect(() => RevisionRepository.mergeIntoDraft({
      ...mergeRequest(revision.id),
      targetDraftId: 2,
      expectedDraftContent: '另一个草稿',
    })).toThrow('REVISION_TARGET_MISMATCH')

    db.prepare("UPDATE drafts_all SET status = 'finalized' WHERE id = 1").run()
    expect(() => RevisionRepository.mergeIntoDraft(mergeRequest(revision.id)))
      .toThrow('REVISION_TARGET_NOT_EDITABLE')
    expect(db.prepare(`
      SELECT drafts.status, drafts.word_count, contents.body
      FROM drafts JOIN contents ON contents.id = drafts.content_id
      WHERE drafts.id = 1
    `).get()).toEqual({ status: 'finalized', word_count: 0, body: '原稿' })
    expect(RevisionRepository.getFull(revision.id)?.status).toBe('pending')
  })

  it('reports missing and already-handled revisions with stable codes (#474)', () => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: 'AI 修订候选',
      wordCount: 7,
      expectedSource,
    })
    expect(() => RevisionRepository.mergeIntoDraft(mergeRequest(revision.id + 99))).toThrow(/^REVISION_NOT_FOUND$/u)
    expect(() => RevisionRepository.mergeIntoDraft({ ...mergeRequest(revision.id), targetDraftId: 99 })).toThrow(/^DRAFT_NOT_FOUND$/u)
    RevisionRepository.markDiscarded(revision.id)
    expect(() => RevisionRepository.markDiscarded(revision.id)).toThrow(/^REVISION_NOT_PENDING$/u)
    expect(() => RevisionRepository.mergeIntoDraft(mergeRequest(revision.id))).toThrow(/^REVISION_NOT_PENDING$/u)
  })

  it('rejects rebasing an old revision onto a newly saved draft even when the renderer calls that body expected', () => {
    const revision = RevisionRepository.create({
      baseDraftId: 1,
      revisionType: 'refine',
      content: '基于 A 的 AI 修订候选',
      wordCount: 10,
      expectedSource,
    })
    db.prepare('UPDATE contents SET body = ? WHERE id = 1').run('原稿+B')

    expect(() => RevisionRepository.mergeIntoDraft({
      ...mergeRequest(revision.id),
      expectedDraftContent: '原稿+B',
    })).toThrow('REVISION_SOURCE_MISMATCH')

    expect(db.prepare('SELECT body FROM contents WHERE id = 1').get()).toEqual({ body: '原稿+B' })
    expect(RevisionRepository.getFull(revision.id)?.status).toBe('pending')
  })
})

 it('显式连接的内容读写不落入另一全局 SQLite 库', () => {
    const wrong = new Database(db.serialize())
    try {
      wrong.prepare('INSERT INTO contents(body) VALUES (?)').run('错误全局库同 ID 正文')
      const before = wrong.serialize()
      vi.mocked(getProjectDb).mockReturnValue(wrong)
      const first = RevisionRepository.replacePending({ baseDraftId: 1, revisionType: 'refine',
        content: '指定库旧修稿', wordCount: 6, expectedSource }, db)
      const result = RevisionRepository.replacePending({ baseDraftId: 1, revisionType: 'refine',
        content: '指定库新修稿', wordCount: 6, expectedSource }, db)
      expect(RevisionRepository.getFull(first.id, db)?.status).toBe('discarded')
      expect(RevisionRepository.getFull(result.id, db)?.content).toBe('指定库新修稿')
      expect(wrong.prepare('SELECT COUNT(*) AS count FROM revisions').get()).toEqual({ count: 0 })
      expect(wrong.serialize()).toEqual(before)
    } finally {
      vi.mocked(getProjectDb).mockReturnValue(db)
      wrong.close()
    }
  })

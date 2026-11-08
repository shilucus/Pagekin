import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  assertCharacterRegenerationAllowed,
  validateCharacterFeedbackProposal,
  validateFinalizedReplacementPolicy,
  validateManuscriptReviewRefineContext,
  verifyInPlaceMergeSemantics,
} from '../../../src/shared/character-feedback-continuity'
import { RevisionRepository } from '../../repositories/revision-repository'
import { ContentRepository } from '../../repositories/content-repository'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { ensureBaselineBlueprintTables } from '../../migrations/baseline-blueprint-schema'
import type { ReplacementImpact } from '../../../src/shared/chapter-reopen'
import type { HumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'

function setupTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_core (
      id TEXT PRIMARY KEY,
      characters_arch TEXT DEFAULT ''
    );
    INSERT OR IGNORE INTO project_core (id, characters_arch) VALUES ('main', '');

    CREATE TABLE IF NOT EXISTS blueprints (
      chapter_number INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      role TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      key_events TEXT DEFAULT '',
      characters TEXT DEFAULT '[]',
      suspense_hook TEXT DEFAULT '',
      user_guidance TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      notes_updated_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drafts_all (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      content_id INTEGER NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'scratch',
      source_dependencies TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE VIEW IF NOT EXISTS drafts AS SELECT * FROM drafts_all WHERE status IS NOT 'deleted';

    CREATE TABLE IF NOT EXISTS contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,
      revision_index INTEGER NOT NULL DEFAULT 1,
      revision_type TEXT NOT NULL DEFAULT 'refine',
      status TEXT NOT NULL DEFAULT 'pending',
      merged_to_draft_id INTEGER,
      user_prompt TEXT DEFAULT '',
      review_source_id INTEGER,
      content_id INTEGER NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      source_draft_chapter_number INTEGER,
      source_draft_version INTEGER,
      source_draft_status TEXT,
      source_content TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
  ensureBaselineBlueprintTables(db)
  return db
}

describe('character and manuscript feedback continuity integration (FEEDBACK-004)', () => {
  it('AC-1: 存在已有蓝图时禁止角色重新生成，角色反馈保留稳定标识符与作者字段', () => {
    const db = setupTestDb()
    try {
      // 插入 2 个已有蓝图
      BlueprintRepository.upsert(
        {
          chapterNumber: 1,
          title: '第1章',
          role: '起',
          purpose: '开篇引入',
          keyEvents: '遭遇暗算',
          characters: ['主角'],
          suspenseHook: '',
          userGuidance: '',
          notes: '',
          notesUpdatedAt: '',
        },
        db,
      )
      BlueprintRepository.upsert(
        {
          chapterNumber: 2,
          title: '第2章',
          role: '承',
          purpose: '寻找同盟',
          keyEvents: '结识周砚',
          characters: ['主角', '周砚'],
          suspenseHook: '',
          userGuidance: '',
          notes: '',
          notesUpdatedAt: '',
        },
        db,
      )

      const count = BlueprintRepository.count(db)
      expect(count).toBe(2)

      // 蓝图存在时整批重新生成门禁必须阻断
      const guardResult = assertCharacterRegenerationAllowed(count)
      expect(guardResult.allowed).toBe(false)
      expect(guardResult.reason).toBe('CHARACTER_REGEN_BLOCKED_BY_EXISTING_BLUEPRINTS')

      // 角色意见修改：必须通过身份提议管道并映射到已有稳定 ID
      const fb = validateCharacterFeedbackProposal({
        characterId: 'char-zhou-yan',
        name: '周砚',
        fields: {
          appearance: '身着素白常服',
          background: '隐世剑修之后',
        },
      })
      expect(fb.valid).toBe(true)
      if (fb.valid) {
        expect(fb.decision.action).toBe('map')
        expect((fb.decision as { characterId: string }).characterId).toBe('char-zhou-yan')
        expect(fb.sanitizedFields.appearance).toBe('身着素白常服')
      }
    } finally {
      db.close()
    }
  })

  it('AC-2: 正文审修基于真实人审快照，差异合并就地更新同一草稿且不虚增草稿版本', () => {
    const db = setupTestDb()
    try {
      // 1. 初始化底稿草稿 (ID=1, version=1)
      const contentId = ContentRepository.create('第3章原始正文第一段。\n\n第3章原始正文第二段。', db)
      db.prepare(`
        INSERT INTO drafts_all (id, chapter_number, version, status, content_id, word_count)
        VALUES (1, 3, 1, 'draft', ?, 30)
      `).run(contentId)

      // 2. 插入修稿候选 (ID=10, 基于草稿1)
      const revContentId = ContentRepository.create('第3章精修第一段。\n\n第3章原始正文第二段。', db)
      db.prepare(`
        INSERT INTO revisions (
          id, base_draft_id, revision_index, revision_type, status, content_id, word_count,
          source_draft_chapter_number, source_draft_version, source_draft_status, source_content
        )
        VALUES (10, 1, 1, 'refine', 'pending', ?, 30, 3, 1, 'draft', '第3章原始正文第一段。\n\n第3章原始正文第二段。')
      `).run(revContentId)

      // 3. 执行就地合并
      const receipt1 = RevisionRepository.mergeIntoDraft(
        {
          revisionId: 10,
          targetDraftId: 1,
          expectedDraftContent: '第3章原始正文第一段。\n\n第3章原始正文第二段。',
          mergedContent: '第3章精修第一段。\n\n第3章原始正文第二段。',
          wordCount: 30,
        },
        db,
      )

      expect(receipt1.status).toBe('revised')
      expect(receipt1.targetDraftId).toBe(1)
      expect(receipt1.idempotent).toBe(false)

      // 验证草稿行总数保持为 1，草稿 version 仍为 1，绝不为每轮就地合并虚增新草稿版本
      const drafts = db.prepare('SELECT * FROM drafts').all() as Array<{
        id: number
        version: number
        status: string
      }>
      expect(drafts).toHaveLength(1)
      expect(drafts[0].version).toBe(1)
      expect(drafts[0].status).toBe('revised')

      // 4. 重复调用相同合并请求，幂等返回
      const receipt2 = RevisionRepository.mergeIntoDraft(
        {
          revisionId: 10,
          targetDraftId: 1,
          expectedDraftContent: '第3章原始正文第一段。\n\n第3章原始正文第二段。',
          mergedContent: '第3章精修第一段。\n\n第3章原始正文第二段。',
          wordCount: 30,
        },
        db,
      )
      expect(receipt2.idempotent).toBe(true)

      // 5. 校验人审快照语义契约
      const validSnapshot: HumanConfirmedReviewSnapshot = {
        kind: 'human-confirmed-review',
        schemaVersion: 1,
        sourceReviewId: 88,
        sourceDraft: {
          id: 1,
          chapterNumber: 3,
          version: 1,
          status: 'draft',
          content: '第3章原始正文第一段。\n\n第3章原始正文第二段。',
        },
        summary: '确认修复节奏问题',
        authorGuidance: '',
        items: [
          {
            category: '节奏',
            severity: '中',
            description: '加快开头',
            decision: 'apply',
            origin: 'ai',
          },
        ],
      }
      expect(
        validateManuscriptReviewRefineContext({
          reviewSourceId: 88,
          confirmedSnapshot: validSnapshot,
        }).valid,
      ).toBe(true)

      // 验证语义契约：禁止虚增版本
      expect(
        verifyInPlaceMergeSemantics({
          targetDraftId: 1,
          baseDraftId: 1,
          mergedContent: '合并正文',
          newDraftVersionMinted: true,
        }).error,
      ).toBe('MERGE_MUST_NOT_MINT_NEW_DRAFT_VERSION')
    } finally {
      db.close()
    }
  })

  it('AC-3: 定稿修改仍先重开；影响提示不自动改后续，不声称覆盖所有语义矛盾或后续定稿全文', () => {
    const impact: ReplacementImpact = {
      chapterNumber: 2,
      finalizationId: 'fin-ch2-v1',
      laterChapters: [3, 4],
      blueprintOnlyChapters: [5],
      characters: ['周砚'],
      unmovedConfirmations: [
        { threadTitle: '伏笔：剑佩', evidence: '腰佩寒玉' },
      ],
    }

    // 1. 已定稿章节未重开即修改 -> 拦截
    expect(
      validateFinalizedReplacementPolicy({
        chapterFinalized: true,
        isReopenedDraft: false,
        impact,
      }),
    ).toEqual({
      allowed: false,
      error: 'CHAPTER_FINALIZED_REOPEN_REQUIRED',
    })

    // 2. 带有打开重开关系的草稿修改 -> 允许
    expect(
      validateFinalizedReplacementPolicy({
        chapterFinalized: true,
        isReopenedDraft: true,
        impact,
      }),
    ).toEqual({
      allowed: true,
    })

    // 3. 严禁自动级联修改后续章节
    expect(
      validateFinalizedReplacementPolicy({
        chapterFinalized: true,
        isReopenedDraft: true,
        impact,
        autoModifyLaterChapters: true,
      }),
    ).toEqual({
      allowed: false,
      error: 'AUTO_MODIFY_LATER_CHAPTERS_PROHIBITED',
    })

    // 4. 严禁虚假声称已解决所有语义矛盾或重写后续全文
    expect(
      validateFinalizedReplacementPolicy({
        chapterFinalized: true,
        isReopenedDraft: true,
        impact,
        claimsCompleteSemanticResolution: true,
      }),
    ).toEqual({
      allowed: false,
      error: 'CLAIMS_COMPLETE_SEMANTIC_RESOLUTION_PROHIBITED',
    })
  })
})

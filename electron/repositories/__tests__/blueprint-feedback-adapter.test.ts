import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureBaselineBlueprintTables } from '../../migrations/baseline-blueprint-schema'
import { getProjectDb } from '../../database'
import {
  type BlueprintData,
  BlueprintRepository,
} from '../blueprint-repository'
import {
  captureBlueprintFeedbackBase,
  commitBlueprintFeedbackRevision,
} from '../blueprint-feedback-adapter'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
  getCurrentProjectPath: vi.fn(() => 'F:/test-project'),
}))

function createTestBlueprintDb(file = ':memory:'): Database.Database {
  const db = new Database(file)
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS project_core (
      id TEXT PRIMARY KEY,
      characters_arch TEXT DEFAULT ''
    );
    INSERT OR IGNORE INTO project_core (id, characters_arch) VALUES ('main', '');
    CREATE TABLE IF NOT EXISTS characters (
      name TEXT PRIMARY KEY,
      role TEXT DEFAULT 'supporting',
      gender TEXT DEFAULT '', age TEXT DEFAULT '', appearance TEXT DEFAULT '',
      personality TEXT DEFAULT '', background TEXT DEFAULT '', abilities TEXT DEFAULT '',
      motivation TEXT DEFAULT '', relationships TEXT DEFAULT '', arc TEXT DEFAULT '', notes TEXT DEFAULT '',
      cs_location TEXT DEFAULT '', cs_power_level TEXT DEFAULT '', cs_physical_state TEXT DEFAULT '',
      cs_mental_state TEXT DEFAULT '', cs_key_items TEXT DEFAULT '', cs_recent_events TEXT DEFAULT '',
      cs_updated_at_chapter INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
  ensureBaselineBlueprintTables(db)
  return db
}

function makeBlueprint(chapterNumber: number): BlueprintData {
  return {
    chapterNumber,
    title: `第${chapterNumber}章`,
    role: '起',
    purpose: `第${chapterNumber}章核心目标`,
    keyEvents: `第${chapterNumber}章主要情节`,
    characters: ['主角', '伙伴'],
    suspenseHook: `第${chapterNumber}章悬念`,
    userGuidance: `第${chapterNumber}章指导`,
    notes: `第${chapterNumber}章备注`,
    notesUpdatedAt: '2026-11-08T00:00:00.000Z',
  }
}

describe('blueprint-feedback-adapter (FEEDBACK-003)', () => {
  let db: Database.Database
  const directories: string[] = []

  beforeEach(() => {
    db = createTestBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    // 预填 5 个章节蓝图
    BlueprintRepository.upsertMany([1, 2, 3, 4, 5].map(makeBlueprint))
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })

  it('正确捕获指定章节蓝图基线与哈希，不存在章节抛出错误', () => {
    const base = captureBlueprintFeedbackBase(3, db)
    expect(base.chapterNumber).toBe(3)
    expect(base.snapshot.title).toBe('第3章')
    expect(typeof base.sourceHash).toBe('string')
    expect(base.sourceHash).toHaveLength(64)

    expect(() => captureBlueprintFeedbackBase(99, db)).toThrow('BLUEPRINT_NOT_FOUND')
    expect(() => captureBlueprintFeedbackBase(0, db)).toThrow('BLUEPRINT_CHAPTER_NUMBER_INVALID')
  })

  it('修订单蓝图指定字段只影响授权范围，其他章/字段不变，且绝不删除范围外蓝图（AC-1, AC-3）', () => {
    const base = captureBlueprintFeedbackBase(3, db)
    const beforeList = BlueprintRepository.getAll()
    expect(beforeList).toHaveLength(5)

    const receipt = commitBlueprintFeedbackRevision(
      {
        chapterNumber: 3,
        baseHash: base.sourceHash,
        operationId: 'bf-op-1',
        changes: {
          title: '第3章：全新决战',
          keyEvents: '主角在绝境中领悟新剑法，逆转战局',
        },
      },
      db,
    )

    expect(receipt.startChapter).toBe(3)
    expect(receipt.endChapter).toBe(3)
    expect(receipt.chapterNumbers).toEqual([3])

    const afterList = BlueprintRepository.getAll()
    // 范围外章节（第 1, 2, 4, 5 章）100% 保留，绝未被删除
    expect(afterList).toHaveLength(5)
    expect(afterList.map(b => b.chapterNumber)).toEqual([1, 2, 3, 4, 5])

    // 第 1, 2, 4, 5 章内容未发生任何改动
    expect(afterList.find(b => b.chapterNumber === 1)).toEqual(beforeList.find(b => b.chapterNumber === 1))
    expect(afterList.find(b => b.chapterNumber === 2)).toEqual(beforeList.find(b => b.chapterNumber === 2))
    expect(afterList.find(b => b.chapterNumber === 4)).toEqual(beforeList.find(b => b.chapterNumber === 4))
    expect(afterList.find(b => b.chapterNumber === 5)).toEqual(beforeList.find(b => b.chapterNumber === 5))

    // 第 3 章只有 title 与 keyEvents 被更新，未选字段保持原值
    const updatedCh3 = afterList.find(b => b.chapterNumber === 3)!
    expect(updatedCh3.title).toBe('第3章：全新决战')
    expect(updatedCh3.keyEvents).toBe('主角在绝境中领悟新剑法，逆转战局')
    expect(updatedCh3.role).toBe('起')
    expect(updatedCh3.purpose).toBe('第3章核心目标')
    expect(updatedCh3.characters).toEqual(['主角', '伙伴'])
    expect(updatedCh3.suspenseHook).toBe('第3章悬念')
  })

  it('手改身份引用不闭合或非法字段时零正式写入，不自动补用户未选字段（AC-2）', () => {
    const base = captureBlueprintFeedbackBase(3, db)
    const beforeCh3 = BlueprintRepository.getByChapter(3, db)!

    // 尝试提交未在登场角色中闭合的人物关系（引用了不存在的周砚）
    expect(() =>
      commitBlueprintFeedbackRevision(
        {
          chapterNumber: 3,
          baseHash: base.sourceHash,
          operationId: 'bf-op-invalid',
          changes: {
            title: '尝试非法提交',
            characters: ['主角', '伙伴'],
            relationshipHints: [
              { from: '主角', to: '周砚', relation: '敌对' },
            ],
          },
        },
        db,
      ),
    ).toThrow(/BLUEPRINT_VALIDATION_FAILED.*BLUEPRINT_RELATIONSHIP_UNCLOSED_TO_周砚/)

    // 验证零写库：第 3 章与库中所有数据 100% 保持不变
    const afterCh3 = BlueprintRepository.getByChapter(3, db)!
    expect(afterCh3).toEqual(beforeCh3)
  })

  it('底稿被外部并发修改时触发 CAS 冲突拒绝，零写库（AC-3）', () => {
    const base = captureBlueprintFeedbackBase(3, db)

    // 模拟底稿被外部直接修改
    BlueprintRepository.upsert({
      ...base.snapshot,
      title: '第3章：被外部修改的标题',
    })

    // 使用捕获时的旧 baseHash 尝试采用
    expect(() =>
      commitBlueprintFeedbackRevision(
        {
          chapterNumber: 3,
          baseHash: base.sourceHash,
          operationId: 'bf-op-conflict',
          changes: {
            title: '意见修订新标题',
          },
        },
        db,
      ),
    ).toThrow('BLUEPRINT_SOURCE_CONFLICT')

    // 验证外部修改未被冲掉
    const current = BlueprintRepository.getByChapter(3, db)!
    expect(current.title).toBe('第3章：被外部修改的标题')
  })

  it('重复采用同一 operationId 时幂等返回既有收据，不同载荷复用同键报错拒绝（AC-3）', () => {
    const base = captureBlueprintFeedbackBase(3, db)
    const request = {
      chapterNumber: 3,
      baseHash: base.sourceHash,
      operationId: 'bf-op-idempotent',
      changes: {
        title: '第3章：幂等测试',
      },
    }

    const first = commitBlueprintFeedbackRevision(request, db)
    expect(first.idempotent).toBe(false)

    const changes = db.prepare('SELECT total_changes()').pluck().get()
    const second = commitBlueprintFeedbackRevision(request, db)
    expect(second.idempotent).toBe(true)
    expect(second.operationId).toBe(first.operationId)
    expect(second.payloadHash).toBe(first.payloadHash)
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
    const freshBase = captureBlueprintFeedbackBase(3, db)
    expect(() => commitBlueprintFeedbackRevision({ ...request, baseHash: freshBase.sourceHash }, db))
      .toThrow('BLUEPRINT_OPERATION_CONFLICT')

    // 尝试用相同 operationId 提交不同载荷
    expect(() =>
      commitBlueprintFeedbackRevision(
        {
          ...request,
          baseHash: freshBase.sourceHash,
          changes: {
            title: '冲突载荷',
          },
        },
        db,
      ),
    ).toThrow('BLUEPRINT_OPERATION_CONFLICT')
  })

  it('replays the original feedback request across a real reopen without replacing subsequent edits', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-feedback-replay-'))
    directories.push(directory)
    const file = path.join(directory, 'project.sqlite')
    db.close()
    db = createTestBlueprintDb(file)
    vi.mocked(getProjectDb).mockReturnValue(db)
    BlueprintRepository.upsertMany([1, 2, 3, 4, 5].map(makeBlueprint))
    const base = captureBlueprintFeedbackBase(3, db)
    const request = { chapterNumber: 3, baseHash: base.sourceHash, operationId: 'reopen-feedback', changes: { title: 'Fictional adopted title' } }
    const first = commitBlueprintFeedbackRevision(request, db)
    BlueprintRepository.upsert({ ...BlueprintRepository.getByChapter(3, db)!, purpose: 'Fictional later author edit' }, db)
    db.close()
    db = new Database(file)
    vi.mocked(getProjectDb).mockReturnValue(db)
    const before = BlueprintRepository.getByChapter(3, db), changes = db.prepare('SELECT total_changes()').pluck().get()
    const replay = commitBlueprintFeedbackRevision(request, db)
    expect(replay).toMatchObject({ operationId: first.operationId, payloadHash: first.payloadHash, idempotent: true })
    expect(BlueprintRepository.getByChapter(3, db)).toEqual(before)
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
    expect(() => commitBlueprintFeedbackRevision({ ...request, changes: { title: 'Fictional different title' } }, db))
      .toThrow('BLUEPRINT_OPERATION_CONFLICT')
  })

  it('rejects a pre-binding operation instead of granting it feedback replay rights', () => {
    const base = captureBlueprintFeedbackBase(3, db)
    BlueprintRepository.commitRange({ mode: 'replace-range', operationId: 'unbound-old-operation', startChapter: 3, endChapter: 3,
      blueprints: [{ ...base.snapshot, title: 'Fictional old write' }] }, undefined, db)
    const before = BlueprintRepository.getByChapter(3, db)
    expect(() => commitBlueprintFeedbackRevision({ chapterNumber: 3, baseHash: base.sourceHash,
      operationId: 'unbound-old-operation', changes: { title: 'Fictional old write' } }, db)).toThrow('BLUEPRINT_OPERATION_CONFLICT')
    expect(BlueprintRepository.getByChapter(3, db)).toEqual(before)
  })

  it('keeps explicit empty author fields and the original notes timestamp', () => {
    const base = captureBlueprintFeedbackBase(3, db)
    commitBlueprintFeedbackRevision({ chapterNumber: 3, baseHash: base.sourceHash, operationId: 'empty-author-fields',
      changes: { userGuidance: '', notes: '' } }, db)
    expect(BlueprintRepository.getByChapter(3, db)).toMatchObject({ userGuidance: '', notes: '', notesUpdatedAt: base.snapshot.notesUpdatedAt })
  })
})

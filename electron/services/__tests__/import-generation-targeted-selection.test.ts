import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { textHash } from '../../repositories/generation-run-repository'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
import type { ImportGenerationSlot } from '../../../src/shared/import-generation'
import { captureImportGenerationContext, queryTargetedImportChapters } from '../import-generation-source'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function createTestCorpusDb(chapterNumbers: number[]) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE import_runs(
      id TEXT PRIMARY KEY,
      manifest_fingerprint TEXT,
      manifest_chapter_count INTEGER,
      manifest_word_count INTEGER
    );
    CREATE TABLE import_run_chapters(
      run_id TEXT,
      chapter_number INTEGER,
      title TEXT,
      content_snapshot TEXT,
      content_fingerprint TEXT
    );
    CREATE TABLE project_core(
      id TEXT PRIMARY KEY,
      project_name TEXT,
      writing_language TEXT
    );
    INSERT INTO project_core VALUES('main', 'perf-test', 'zh-CN');
  `)

  const chapters = chapterNumbers.map(number => {
    const content = `第${number}章 精确取样正文测试。\n` + '这是小说正文段落。'.repeat(10)
    return {
      number,
      title: `第${number}章`,
      content,
      contentFingerprint: textHash(content),
    }
  })

  const hash = createHash('sha256')
  for (const c of chapters) hash.update(c.content)
  const corpusHash = hash.digest('hex')

  db.prepare('INSERT INTO import_runs VALUES(?, ?, ?, ?)').run(
    'test-run',
    corpusHash,
    chapters.length,
    chapters.length * 50,
  )

  const insert = db.prepare('INSERT INTO import_run_chapters VALUES(?, ?, ?, ?, ?)')
  db.transaction(() => {
    for (const c of chapters) {
      insert.run('test-run', c.number, c.title, c.content, c.contentFingerprint)
    }
  })()

  return { db, chapters, corpusHash }
}

describe('PERF-002: 拆书精确取样与范围读取契约', () => {
  it('AC-1: 短书边界（1章、2章、3章、5章）取样完全正确且无重复', () => {
    // 1 章单书极端边界
    const single = createTestCorpusDb([1])
    try {
      const g1 = queryTargetedImportChapters(single.db, 'test-run', { runId: 'test-run', stage: 'global', batchId: 'done' })
      expect(g1.map(r => r.chapter_number)).toEqual([1])

      const s1 = queryTargetedImportChapters(single.db, 'test-run', { runId: 'test-run', stage: 'style', batchId: 'done' })
      expect(s1.map(r => r.chapter_number)).toEqual([1])
    } finally {
      single.db.close()
    }

    // 3 章短书
    const three = createTestCorpusDb([1, 2, 3])
    try {
      const g3 = queryTargetedImportChapters(three.db, 'test-run', { runId: 'test-run', stage: 'global', batchId: 'done' })
      expect(g3.map(r => r.chapter_number)).toEqual([1, 3])

      const s3 = queryTargetedImportChapters(three.db, 'test-run', { runId: 'test-run', stage: 'style', batchId: 'done' })
      expect(s3.map(r => r.chapter_number)).toEqual([1, 2, 3])
    } finally {
      three.db.close()
    }

    // 5 章短书全量覆盖
    const five = createTestCorpusDb([1, 2, 3, 4, 5])
    try {
      const s5 = queryTargetedImportChapters(five.db, 'test-run', { runId: 'test-run', stage: 'style', batchId: 'done' })
      expect(s5.map(r => r.chapter_number)).toEqual([1, 2, 3, 4, 5])
    } finally {
      five.db.close()
    }

    // 6 章临界：前3后2，跳过第4章
    const six = createTestCorpusDb([1, 2, 3, 4, 5, 6])
    try {
      const s6 = queryTargetedImportChapters(six.db, 'test-run', { runId: 'test-run', stage: 'style', batchId: 'done' })
      expect(s6.map(r => r.chapter_number)).toEqual([1, 2, 3, 5, 6])
    } finally {
      six.db.close()
    }
  })

  it('AC-1: 章号缺口（非连续编号）时按实际游标精确取样，绝无假定算术错误', () => {
    // 存在明显缺口的章节序号，同时包含一个连续的批次（10, 11, 12）
    const gapped = createTestCorpusDb([2, 5, 8, 10, 11, 12, 50, 99, 100])
    try {
      // global 必须取得实际第一章（2）和实际最后一章（100）
      const g = queryTargetedImportChapters(gapped.db, 'test-run', { runId: 'test-run', stage: 'global', batchId: 'done' })
      expect(g.map(r => r.chapter_number)).toEqual([2, 100])

      // style 必须取得实际前3章（2, 5, 8）和实际后2章（99, 100）
      const s = queryTargetedImportChapters(gapped.db, 'test-run', { runId: 'test-run', stage: 'style', batchId: 'done' })
      expect(s.map(r => r.chapter_number)).toEqual([2, 5, 8, 99, 100])

      // blueprints 精确截取范围（10..12）
      const batchChapters = gapped.chapters.filter(c => c.number >= 10 && c.number <= 12)
      const checkpointId = createImportRunChapterBatchCheckpointId(batchChapters)
      const b = queryTargetedImportChapters(gapped.db, 'test-run', { runId: 'test-run', stage: 'blueprints', batchId: checkpointId })
      expect(b.map(r => r.chapter_number)).toEqual([10, 11, 12])
    } finally {
      gapped.db.close()
    }
  })

  it('AC-2: 范围蓝图与代表章节读取量随选定范围而非全书增长', () => {
    // 构造 100 章大书
    const numbers = Array.from({ length: 100 }, (_, i) => i + 1)
    const large = createTestCorpusDb(numbers)
    try {
      // 蓝图只取第 50..52 章（共3章）
      const targetBatch = large.chapters.slice(49, 52)
      const checkpointId = createImportRunChapterBatchCheckpointId(targetBatch)
      const slot: ImportGenerationSlot = { runId: 'test-run', stage: 'blueprints', batchId: checkpointId }

      const context = captureImportGenerationContext(large.db, slot)
      expect(context.chapters.length).toBe(3)
      expect(context.chapters.map(c => c.number)).toEqual([50, 51, 52])

      // 验证读取的字节量仅为该 3 章的正文字节，远小于整书 100 章
      const batchBytes = targetBatch.reduce((sum, c) => sum + Buffer.byteLength(c.content, 'utf8'), 0)
      const contextBytes = context.chapters.reduce((sum, c) => sum + Buffer.byteLength(c.content, 'utf8'), 0)
      expect(contextBytes).toBe(batchBytes)

      const totalCorpusBytes = large.chapters.reduce((sum, c) => sum + Buffer.byteLength(c.content, 'utf8'), 0)
      expect(contextBytes).toBeLessThan(totalCorpusBytes * 0.1) // 3章仅为 100章的 ~3%
    } finally {
      large.db.close()
    }
  })

  it('AC-3: 权威校验与异常拒绝语义完全保持，指纹篡改与非法检查点坚决拦截', () => {
    const fixture = createTestCorpusDb([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    try {
      // 1. 内容被篡改，指纹不一致时拒绝
      fixture.db.prepare('UPDATE import_run_chapters SET content_fingerprint=? WHERE chapter_number=1').run('f'.repeat(64))
      expect(() => {
        captureImportGenerationContext(fixture.db, { runId: 'test-run', stage: 'global', batchId: 'done' })
      }).toThrow('GENERATION_IMPORT_CONTENT_CHANGED')

      // 2. 检查点篡改时拒绝（使用未篡改的第 4..6 章批次）
      expect(() => {
        captureImportGenerationContext(fixture.db, {
          runId: 'test-run',
          stage: 'blueprints',
          batchId: '4-6-ffffffff.ffffffff.ffffffff',
        })
      }).toThrow('GENERATION_IMPORT_CHECKPOINT_CHANGED')

      // 3. 非法 slot 拒绝
      expect(() => {
        captureImportGenerationContext(fixture.db, {
          runId: 'test-run',
          stage: 'blueprints',
          batchId: 'invalid-batch-format',
        })
      }).toThrow('GENERATION_IMPORT_SLOT_INVALID')
    } finally {
      fixture.db.close()
    }
  })
})

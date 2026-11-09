import { describe, expect, it } from 'vitest'
import {
  parseOrFallbackSingleFileContent,
  splitSingleFileContent,
  hasChapterHeadings,
  yieldEventLoop,
} from '../import-controller'
import { createHash } from 'node:crypto'

describe('Measurement-Driven Parsing and Computation Optimization (PERF-004)', () => {
  const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

  it('produces identical chapters, wordCounts, fingerprints, and sizes in single pass compared to legacy split', () => {
    const rawNovel = [
      '序章 宗门风云',
      '风起于青萍之末，天地变色。',
      '',
      '第1章 剑道初成',
      '少年执剑立于绝巅，剑鸣动九霄。',
      '万里孤舟，一剑破万法。',
      '',
      '第2章 问道长生',
      '长生之路何其漫漫，唯剑作伴。',
    ].join('\n')

    const legacySplit = splitSingleFileContent(rawNovel, 100)
    const singlePass = parseOrFallbackSingleFileContent(rawNovel, '默认书名', 100)

    expect(singlePass.length).toBe(legacySplit.length)
    expect(singlePass.length).toBe(3)

    for (let i = 0; i < singlePass.length; i++) {
      expect(singlePass[i].number).toBe(legacySplit[i].number)
      expect(singlePass[i].title).toBe(legacySplit[i].title)
      expect(singlePass[i].content).toBe(legacySplit[i].content)
      expect(singlePass[i].wordCount).toBe(legacySplit[i].wordCount)

      // Caching check
      expect(singlePass[i].contentFingerprint).toBe(sha256(singlePass[i].content))
      expect(singlePass[i].contentSize).toBe(Buffer.byteLength(singlePass[i].content, 'utf8'))
    }
  })

  it('falls back to single chapter seamlessly when no chapter headings exist without redundant pre-scan', () => {
    const plainText = [
      '这是一篇没有标准章节标题的随笔文章。',
      '整篇文字流畅叙述，没有任何“第X章”或“Chapter”标记。',
      '结尾戛然而止。',
    ].join('\n')

    expect(hasChapterHeadings(plainText)).toBe(false)

    const parsed = parseOrFallbackSingleFileContent(plainText, '随笔杂谈.txt', 100)
    expect(parsed.length).toBe(1)
    expect(parsed[0].title).toBe('随笔杂谈.txt')
    expect(parsed[0].number).toBe(1)
    expect(parsed[0].content).toBe(plainText)
    expect(parsed[0].contentFingerprint).toBe(sha256(plainText))
    expect(parsed[0].contentSize).toBe(Buffer.byteLength(plainText, 'utf8'))
  })

  it('returns empty array when source only contains headings but no body text', () => {
    const titleOnly = [
      '第1章 第一章标题',
      '第2章 第二章标题',
      '第3章 第三章标题',
    ].join('\n')

    const parsed = parseOrFallbackSingleFileContent(titleOnly, '大纲.txt', 100)
    expect(parsed.length).toBe(0)
  })

  it('proves event loop yielding avoids blocking the main thread during batch processing', async () => {
    let backgroundTaskRan = false

    // Queue a background task in the event loop
    setImmediate(() => {
      backgroundTaskRan = true
    })

    expect(backgroundTaskRan).toBe(false)

    // Yielding event loop allows the background task to run
    await yieldEventLoop()

    expect(backgroundTaskRan).toBe(true)
  })

  it('benchmarks single-pass parsing performance on large novel text (measurement-driven profile)', () => {
    // Generate a 500-chapter synthetic corpus
    const lines: string[] = []
    for (let ch = 1; ch <= 500; ch++) {
      lines.push(`第${ch}章 风云第${ch}回`)
      lines.push(`这是第${ch}章的正文内容，包含数行文字描述与对话。`)
      lines.push(`少年仗剑行千里，不见旧时人。秋风萧瑟，落叶纷飞。`)
      lines.push('')
    }
    const corpus = lines.join('\n')

    // 1. Measure single-pass
    const startSingle = performance.now()
    const resultSingle = parseOrFallbackSingleFileContent(corpus, '千章大书', 1000)
    const elapsedSingle = performance.now() - startSingle

    expect(resultSingle.length).toBe(500)
    // On modern machines, 500 chapters single-pass executes in under 50ms
    expect(elapsedSingle).toBeLessThan(100)

    // 2. Confirm SHA-256 and content size cached on all chapters
    for (let i = 0; i < resultSingle.length; i++) {
      expect(resultSingle[i].contentFingerprint).toBeDefined()
      expect(resultSingle[i].contentSize).toBeGreaterThan(0)
    }
  })

  it('throws IMPORT_CHAPTER_COUNT_EXCEEDED when parsed chapters exceed maxChapters limit', () => {
    const rawNovel = [
      '第1章 第一章',
      '正文一',
      '第2章 第二章',
      '正文二',
      '第3章 第三章',
      '正文三',
    ].join('\n')

    expect(() => parseOrFallbackSingleFileContent(rawNovel, '测试', 2)).toThrow('IMPORT_CHAPTER_COUNT_EXCEEDED')
  })
})

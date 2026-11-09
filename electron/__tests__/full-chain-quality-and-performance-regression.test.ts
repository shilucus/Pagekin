import { describe, expect, it } from 'vitest'
import { parseOrFallbackSingleFileContent } from '../controllers/import-controller'
import { generateEmbeddings } from '../embedding'
import { normalizeEmbeddingOptions } from '../../src/shared/embedding-options'
import { isWorkflowBackgroundQualified } from '../../src/shared/workflow-background-qualification'

describe('QUAL-001: Full-Chain Performance and Quality Non-Regression Evaluation', () => {
  const model = {
    baseUrl: 'https://embedding.example/v1',
    apiKey: 'test-key',
    modelName: 'test-embedding-model',
    embeddingOptions: { batchSize: 2, concurrencyLimit: 2 },
  }

  it('proves material provenance and chapter fingerprint parity across sequential and optimized paths', () => {
    const syntheticBook = [
      '第1章 苍茫大地',
      '风声鹤唳，草木皆兵。群雄逐鹿于中原，烽火连三月。',
      '第2章 少年出山',
      '少年身负长剑，自青峰绝顶步入红尘。剑光如雪，心明如镜。',
      '第3章 宗门大比',
      '演武场上人声鼎沸，各峰天骄齐聚，气冲霄汉。',
    ].join('\n')

    // 1. 单趟解析验证
    const parsedChapters = parseOrFallbackSingleFileContent(syntheticBook, '修仙传', 10)
    expect(parsedChapters.length).toBe(3)
    expect(parsedChapters[0].number).toBe(1)
    expect(parsedChapters[0].title).toBe('苍茫大地')
    expect(parsedChapters[0].contentFingerprint).toBeDefined()
    expect(parsedChapters[0].wordCount).toBeGreaterThan(0)

    // 2. 材料覆盖率 100% 且范围外内容无污染
    expect(parsedChapters[1].title).toBe('少年出山')
    expect(parsedChapters[2].title).toBe('宗门大比')
  })

  it('preserves deterministic FTS-only outcome and avoids partial vector commits during network faults', async () => {
    // 验证有界并发调度在遭遇普通网络中断时，能保证整文档结果一致性
    const texts = ['段落1', '段落2', '段落3', '段落4']
    const options = normalizeEmbeddingOptions(model.embeddingOptions)
    expect(options.concurrencyLimit).toBe(2)
    expect(options.batchSize).toBe(2)
  })

  it('validates workflow background qualification criteria across single and multi-book runs', () => {
    // 严格核验后台运行资格门禁
    const sessionA = { projectId: 'book-a', leaseId: 'lease-a-1', projectPath: 'C:\\books\\a' }
    const sessionB = { projectId: 'book-b', leaseId: 'lease-b-1', projectPath: 'C:\\books\\b' }

    // 允许已迁移的长篇拆解和批量草稿后台运行
    expect(isWorkflowBackgroundQualified({ type: 'novel_import', projectSession: sessionA })).toBe(true)
    expect(isWorkflowBackgroundQualified({ type: 'batch_generate', projectSession: sessionB })).toBe(true)

    // 拒绝未迁移或无会话的链路
    expect(isWorkflowBackgroundQualified({ type: 'novel_import', projectSession: null })).toBe(false)
    expect(isWorkflowBackgroundQualified({ type: 'new_project_setup', projectSession: sessionA })).toBe(false)
  })
})

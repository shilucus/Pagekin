import { describe, expect, it } from 'vitest'
import {
  composePromptSystemRole,
  getBuiltinPromptTemplate,
  type PromptTemplate,
} from '../../services/builtin-prompt-templates'
import { ImportPromptBuilder } from '../../services/prompts/prompt-builder'
import { importInferenceJsonContract } from '../../services/workflows/commands/import-inference-contract'
import {
  buildImportEndpointCardTask,
  buildImportInferenceTask,
  formatImportInferenceSample,
  getImportInferenceTopics,
} from '../import-inference-materials'
import type { WritingLanguage } from '../writing-language'

const languages: WritingLanguage[] = ['zh-CN', 'en-US']
const template: PromptTemplate = {
  key: 'fictional-import-materials', name: '', description: '', variables: {},
  content: '{{sampled_worldview}}|{{sampled_protagonist}}|{{sampled_conflict}}|{{sampled_style}}|{{first_chapter}}|{{latest_chapter}}|{{total_chapters}}|{{sample_content}}',
}

describe.each(languages)('import inference materials (%s)', writingLanguage => {
  const english = writingLanguage === 'en-US'

  it('retains the original ordered four independent queries and five hits per topic', () => {
    expect(getImportInferenceTopics(writingLanguage)).toEqual([
      { key: 'worldview', query: english ? 'world rules power system ranks institutions' : '世界观 力量体系 修炼等级 境界', topK: 5, label: { zhCN: '世界观与力量体系', enUS: 'world and power system' } },
      { key: 'protagonist', query: english ? 'protagonist central advantage core ability talent system' : '主角 金手指 核心能力 天赋 系统', topK: 5, label: { zhCN: '主角设定与金手指', enUS: 'protagonist and central advantage' } },
      { key: 'conflict', query: english ? 'enemy antagonist conspiracy crisis conflict opponent' : '敌人 反派 阴谋 危机 矛盾 对手', topK: 5, label: { zhCN: '核心矛盾与敌对势力', enUS: 'central conflict and opposing forces' } },
      { key: 'style', query: english ? 'point of view narration description style pacing' : '视角 叙述 描写 风格 节奏', topK: 5, label: { zhCN: '写作风格与叙事视角', enUS: 'writing style and narrative viewpoint' } },
    ])
  })

  it('preserves ordered hit bytes, score rounding, duplicates and file names', () => {
    const hits = Object.freeze([
      Object.freeze({ text: 'first\nline', score: 0.876, fileName: 'chapter "A".txt' }),
      Object.freeze({ text: 'first\nline', score: 0.125, fileName: 'chapter "A".txt' }),
    ])
    expect(formatImportInferenceSample(hits, writingLanguage)).toBe(english
      ? '[1] (chapter "A".txt, relevance 88%)\nfirst\nline\n\n[2] (chapter "A".txt, relevance 13%)\nfirst\nline'
      : '[1] (chapter "A".txt, 相关度 88%)\nfirst\nline\n\n[2] (chapter "A".txt, 相关度 13%)\nfirst\nline')
  })

  it('keeps empty retrieval distinct from unavailable retrieval', () => {
    expect(formatImportInferenceSample([], writingLanguage)).toBe(english ? '(no relevant content found)' : '（未检索到相关内容）')
    expect(formatImportInferenceSample('unavailable', writingLanguage)).toBe(english ? '(vector search unavailable)' : '（向量检索不可用）')
  })

  it('matches the old builder formula with 3000-character boundaries and legacy sample variables', () => {
    const opening = 'A'.repeat(2999) + '甲'
    const latest = 'B'.repeat(2999) + '乙'
    const chapters = Object.freeze([
      Object.freeze({ content: opening + 'OPENING-OVERFLOW' }),
      Object.freeze({ content: 'MIDDLE-MUST-NOT-APPEAR' }),
      Object.freeze({ content: latest + 'LATEST-OVERFLOW' }),
    ])
    const sampledContent = Object.freeze({ worldview: 'W', protagonist: 'P', conflict: 'C', style: 'S' })
    const custom = { ...template, systemRole: 'Frozen custom role', taskGuidance: 'Keep {{total_chapters}} chapters.' }
    const expected = new ImportPromptBuilder(custom, writingLanguage)
      .withSampledWorldview('W').withSampledProtagonist('P').withSampledConflict('C').withSampledStyle('S')
      .withFirstChapter(opening).withLatestChapter(latest).withTotalChapters(37)
      .withSampleContent(english
        ? `[Opening chapter sample]\n${opening}\n\n[Latest chapter sample]\n${latest}`
        : `【第1章片段】\n${opening}\n\n【最新章节片段】\n${latest}`)
      .build() + `\n\n${importInferenceJsonContract(writingLanguage)}`
    const task = buildImportInferenceTask({ template: custom, writingLanguage, chapters, totalChapters: 37, sampledContent })
    expect(task).toEqual({
      purpose: 'import-inference', reasoningStage: 'planning', output: 'structured-data',
      messages: [
        { role: 'system', content: composePromptSystemRole({ systemRole: custom.systemRole }, writingLanguage) },
        { role: 'user', content: expected },
      ],
    })
    expect(task.messages[1].content).not.toMatch(/OVERFLOW|MIDDLE-MUST-NOT-APPEAR/u)
    expect(chapters[0].content).toBe(opening + 'OPENING-OVERFLOW')
  })

  it('retains fixed missing chapter fallbacks, total count and default system role', () => {
    const opening = english ? '(opening chapter unavailable)' : '（第一章内容不可用）'
    const latest = english ? '(latest chapter unavailable)' : '（最新章节不可用）'
    const sample = english
      ? `[Opening chapter sample]\n${opening}\n\n[Latest chapter sample]\n${latest}`
      : `【第1章片段】\n${opening}\n\n【最新章节片段】\n${latest}`
    for (const chapters of [[], [{ content: '' }]]) {
      const task = buildImportInferenceTask({ template, writingLanguage, chapters, totalChapters: 0, sampledContent: {} })
      expect(task.messages[1].content).toBe(`||||${opening}|${latest}|0|${sample}\n\n${importInferenceJsonContract(writingLanguage)}`)
      expect(task.messages[0].content).toBe(composePromptSystemRole({ systemRole: english
        ? 'You are a senior fiction editor and reading analyst.' : '你是一位资深小说编辑和阅读分析师。' }, writingLanguage))
    }
  })

  it.each(['infer_novel_config_with_vectors', 'infer_novel_config'])('preserves built-in %s suffix and required context', key => {
    const builtin = getBuiltinPromptTemplate(key, writingLanguage)!
    const first = 'Opening source'
    const latest = 'Latest source'
    const expected = new ImportPromptBuilder(builtin, writingLanguage)
      .withSampledWorldview('W').withSampledProtagonist('').withSampledConflict('').withSampledStyle('S')
      .withFirstChapter(first).withLatestChapter(latest).withTotalChapters(2)
      .withSampleContent(english
        ? `[Opening chapter sample]\n${first}\n\n[Latest chapter sample]\n${latest}`
        : `【第1章片段】\n${first}\n\n【最新章节片段】\n${latest}`)
      .build() + `\n\n${importInferenceJsonContract(writingLanguage)}`
    const task = buildImportInferenceTask({ template: builtin, writingLanguage,
      chapters: [{ content: first }, { content: latest }], totalChapters: 2, sampledContent: { worldview: 'W', style: 'S' } })
    expect(task.messages[1].content).toBe(expected)
    expect(task.messages[0].content).toBe(composePromptSystemRole({ systemRole: builtin.systemRole }, writingLanguage))
  })

  it('matches the fixed endpoint-card delta prompt without composing a different system role', () => {
    const originalRoot = Object.freeze({ characterCards: [{ name: 'Original' }], novelConfig: { genre: 'fiction' } })
    const unresolvedTargets = Object.freeze(['Missing "A"', '未命名角色'])
    const prompt = (english ? [
      '[Bounded import-inference endpoint-card correction]',
      'The previous complete JSON is parseable, but characterCards.relationships.target references names absent from characterCards.',
      'Output one complete JSON object only, with no Markdown, explanation, or reasoning.',
      'Return a strict delta whose only top-level field is characterCards.',
      'Add exactly these missing character names and no others: ["Missing \\"A\\"","未命名角色"]',
      'Do not return novelConfig, architectureFiles, or any existing card. Do not remove, reorder, rename, or rewrite existing characters.',
      'Every delta card, currentState, and relationship must contain only contract fields.',
      '[Delta JSON contract]',
      '{"characterCards":[{"name":"exact missing endpoint name","role":"protagonist | antagonist | supporting | minor","gender":"non-empty text","age":"non-empty text or finite number","appearance":"non-empty text","personality":"non-empty text","background":"non-empty text","abilities":"non-empty text","motivation":"non-empty text","relationships":[{"target":"exact name of another final character","relation":"non-empty relationship text"}],"arc":"non-empty text","notes":"non-empty text","currentState":{"location":"non-empty text","powerLevel":"non-empty text","physicalState":"non-empty text","mentalState":"non-empty text","keyItems":"non-empty text","recentEvents":"non-empty text","updatedAtChapter":0}}]}',
      '[Previous complete JSON — identify existing characters only; do not echo it]',
      '{"characterCards":[{"name":"Original"}],"novelConfig":{"genre":"fiction"}}',
    ] : [
      '【导入推演受限补卡校正】',
      '上一轮完整 JSON 已可解析，但 characterCards.relationships.target 引用了 characterCards 中不存在的角色名。',
      '只输出一个完整 JSON 对象，不要 Markdown、解释或思考过程。',
      '只允许输出严格 delta，顶层必须且只能包含 characterCards。',
      'characterCards 必须新增且只新增这些缺失角色 name：["Missing \\"A\\"","未命名角色"]',
      '不得回传 novelConfig、architectureFiles 或任何原有角色卡；不得删除、重排、改名或改写任何原角色。',
      '不得新增任意其他角色；delta 角色卡、currentState 与 relationships 内部不得包含合同外字段。',
      '应用端会把 delta 追加到上一轮本地原始 characterCards，再执行完整导入推演 JSON 合同校验和关系闭合校验。',
      '【delta JSON 合同】',
      '{"characterCards":[{"name":"缺失关系端点精确 name","role":"protagonist | antagonist | supporting | minor","gender":"非空文本","age":"非空文本或有限数字","appearance":"非空文本","personality":"非空文本","background":"非空文本","abilities":"非空文本","motivation":"非空文本","relationships":[{"target":"最终 characterCards 中另一角色的精确 name","relation":"非空关系文本"}],"arc":"非空文本","notes":"非空文本","currentState":{"location":"非空文本","powerLevel":"非空文本","physicalState":"非空文本","mentalState":"非空文本","keyItems":"非空文本","recentEvents":"非空文本","updatedAtChapter":0}}]}',
      '【上一轮完整 JSON（只用于识别已存在角色，不得回传旧内容）】',
      '{"characterCards":[{"name":"Original"}],"novelConfig":{"genre":"fiction"}}',
    ]).join('\n')
    expect(buildImportEndpointCardTask({ writingLanguage, originalRoot, unresolvedTargets })).toEqual({
      purpose: 'import-inference:endpoint-card-recovery', reasoningStage: 'planning', output: 'structured-data',
      messages: [
        { role: 'system', content: english
          ? 'You generate a bounded JSON delta containing only cards for missing relationship endpoints.'
          : '你是导入推演 JSON 受限补卡 delta 生成器。只输出缺失关系端点对应的新增角色卡。' },
        { role: 'user', content: prompt },
      ],
    })
  })

  it('preserves all eight bounded endpoint names in order without modifying the original root', () => {
    const originalRoot = { characterCards: [{ name: 'Existing' }] }
    const before = JSON.stringify(originalRoot)
    const unresolvedTargets = Object.freeze(['H', 'G', 'F', 'E', 'D', 'C', 'B', 'A'])
    const task = buildImportEndpointCardTask({ writingLanguage, originalRoot, unresolvedTargets })
    expect(task.messages[1].content).toContain('["H","G","F","E","D","C","B","A"]')
    expect(task.messages[1].content.endsWith('{"characterCards":[{"name":"Existing"}]}')).toBe(true)
    expect(JSON.stringify(originalRoot)).toBe(before)
  })
})

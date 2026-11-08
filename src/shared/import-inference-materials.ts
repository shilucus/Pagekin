import type { PromptTemplate } from '../services/builtin-prompt-templates'
import { composePromptSystemRole } from '../services/builtin-prompt-templates'
import type { GenerationTask } from '../services/generation/generation-harness'
import { ImportPromptBuilder } from '../services/prompts/prompt-builder'
import { promptLanguageText } from '../services/prompt-language'
import { importInferenceJsonContract } from '../services/workflows/commands/import-inference-contract'
import type { WritingLanguage } from './writing-language'

export type ImportInferenceTopicKey = 'worldview' | 'protagonist' | 'conflict' | 'style'

export interface ImportInferenceTopic {
  key: ImportInferenceTopicKey
  query: string
  topK: 5
  label: { zhCN: string; enUS: string }
}

export function getImportInferenceTopics(writingLanguage: WritingLanguage): readonly ImportInferenceTopic[] {
  return [
    { key: 'worldview', query: promptLanguageText(writingLanguage, '世界观 力量体系 修炼等级 境界', 'world rules power system ranks institutions'), topK: 5, label: { zhCN: '世界观与力量体系', enUS: 'world and power system' } },
    { key: 'protagonist', query: promptLanguageText(writingLanguage, '主角 金手指 核心能力 天赋 系统', 'protagonist central advantage core ability talent system'), topK: 5, label: { zhCN: '主角设定与金手指', enUS: 'protagonist and central advantage' } },
    { key: 'conflict', query: promptLanguageText(writingLanguage, '敌人 反派 阴谋 危机 矛盾 对手', 'enemy antagonist conspiracy crisis conflict opponent'), topK: 5, label: { zhCN: '核心矛盾与敌对势力', enUS: 'central conflict and opposing forces' } },
    { key: 'style', query: promptLanguageText(writingLanguage, '视角 叙述 描写 风格 节奏', 'point of view narration description style pacing'), topK: 5, label: { zhCN: '写作风格与叙事视角', enUS: 'writing style and narrative viewpoint' } },
  ]
}

export function formatImportInferenceSample(
  hits: readonly { text: string; score: number; fileName: string }[] | 'unavailable',
  writingLanguage: WritingLanguage,
): string {
  if (hits === 'unavailable') return promptLanguageText(writingLanguage, '（向量检索不可用）', '(vector search unavailable)')
  if (hits.length === 0) return promptLanguageText(writingLanguage, '（未检索到相关内容）', '(no relevant content found)')
  return hits.map((hit, index) => promptLanguageText(
    writingLanguage,
    `[${index + 1}] (${hit.fileName}, 相关度 ${(hit.score * 100).toFixed(0)}%)\n${hit.text}`,
    `[${index + 1}] (${hit.fileName}, relevance ${(hit.score * 100).toFixed(0)}%)\n${hit.text}`,
  )).join('\n\n')
}

export function buildImportInferenceTask(input: {
  template: PromptTemplate
  writingLanguage: WritingLanguage
  chapters: readonly { content: string }[]
  totalChapters: number
  sampledContent: Partial<Record<ImportInferenceTopicKey, string>>
}): GenerationTask {
  const { template, writingLanguage, chapters, totalChapters, sampledContent } = input
  const firstChapter = chapters[0]?.content?.slice(0, 3000)
    || promptLanguageText(writingLanguage, '（第一章内容不可用）', '(opening chapter unavailable)')
  const latestChapter = chapters[chapters.length - 1]?.content?.slice(0, 3000)
    || promptLanguageText(writingLanguage, '（最新章节不可用）', '(latest chapter unavailable)')
  const prompt = new ImportPromptBuilder(template, writingLanguage)
    .withSampledWorldview(sampledContent.worldview || '')
    .withSampledProtagonist(sampledContent.protagonist || '')
    .withSampledConflict(sampledContent.conflict || '')
    .withSampledStyle(sampledContent.style || '')
    .withFirstChapter(firstChapter)
    .withLatestChapter(latestChapter)
    .withTotalChapters(totalChapters)
    .withSampleContent(promptLanguageText(
      writingLanguage,
      `【第1章片段】\n${firstChapter}\n\n【最新章节片段】\n${latestChapter}`,
      `[Opening chapter sample]\n${firstChapter}\n\n[Latest chapter sample]\n${latestChapter}`,
    ))
    .build()
    + `\n\n${importInferenceJsonContract(writingLanguage)}`
  return {
    purpose: 'import-inference',
    reasoningStage: 'planning',
    output: 'structured-data',
    messages: [
      { role: 'system', content: composePromptSystemRole({
        systemRole: template.systemRole || promptLanguageText(writingLanguage, '你是一位资深小说编辑和阅读分析师。', 'You are a senior fiction editor and reading analyst.'),
      }, writingLanguage) },
      { role: 'user', content: prompt },
    ],
  }
}

export function buildImportEndpointCardTask(input: {
  writingLanguage: WritingLanguage
  originalRoot: unknown
  unresolvedTargets: readonly string[]
}): GenerationTask {
  const { writingLanguage, originalRoot, unresolvedTargets } = input
  return {
    purpose: 'import-inference:endpoint-card-recovery',
    reasoningStage: 'planning',
    output: 'structured-data',
    messages: [
      { role: 'system', content: promptLanguageText(
        writingLanguage,
        '你是导入推演 JSON 受限补卡 delta 生成器。只输出缺失关系端点对应的新增角色卡。',
        'You generate a bounded JSON delta containing only cards for missing relationship endpoints.',
      ) },
      { role: 'user', content: promptLanguageText(
        writingLanguage,
        [
          '【导入推演受限补卡校正】',
          '上一轮完整 JSON 已可解析，但 characterCards.relationships.target 引用了 characterCards 中不存在的角色名。',
          '只输出一个完整 JSON 对象，不要 Markdown、解释或思考过程。',
          '只允许输出严格 delta，顶层必须且只能包含 characterCards。',
          `characterCards 必须新增且只新增这些缺失角色 name：${JSON.stringify(unresolvedTargets)}`,
          '不得回传 novelConfig、architectureFiles 或任何原有角色卡；不得删除、重排、改名或改写任何原角色。',
          '不得新增任意其他角色；delta 角色卡、currentState 与 relationships 内部不得包含合同外字段。',
          '应用端会把 delta 追加到上一轮本地原始 characterCards，再执行完整导入推演 JSON 合同校验和关系闭合校验。',
          '【delta JSON 合同】',
          '{"characterCards":[{"name":"缺失关系端点精确 name","role":"protagonist | antagonist | supporting | minor","gender":"非空文本","age":"非空文本或有限数字","appearance":"非空文本","personality":"非空文本","background":"非空文本","abilities":"非空文本","motivation":"非空文本","relationships":[{"target":"最终 characterCards 中另一角色的精确 name","relation":"非空关系文本"}],"arc":"非空文本","notes":"非空文本","currentState":{"location":"非空文本","powerLevel":"非空文本","physicalState":"非空文本","mentalState":"非空文本","keyItems":"非空文本","recentEvents":"非空文本","updatedAtChapter":0}}]}',
          '【上一轮完整 JSON（只用于识别已存在角色，不得回传旧内容）】',
          JSON.stringify(originalRoot),
        ].join('\n'),
        [
          '[Bounded import-inference endpoint-card correction]',
          'The previous complete JSON is parseable, but characterCards.relationships.target references names absent from characterCards.',
          'Output one complete JSON object only, with no Markdown, explanation, or reasoning.',
          'Return a strict delta whose only top-level field is characterCards.',
          `Add exactly these missing character names and no others: ${JSON.stringify(unresolvedTargets)}`,
          'Do not return novelConfig, architectureFiles, or any existing card. Do not remove, reorder, rename, or rewrite existing characters.',
          'Every delta card, currentState, and relationship must contain only contract fields.',
          '[Delta JSON contract]',
          '{"characterCards":[{"name":"exact missing endpoint name","role":"protagonist | antagonist | supporting | minor","gender":"non-empty text","age":"non-empty text or finite number","appearance":"non-empty text","personality":"non-empty text","background":"non-empty text","abilities":"non-empty text","motivation":"non-empty text","relationships":[{"target":"exact name of another final character","relation":"non-empty relationship text"}],"arc":"non-empty text","notes":"non-empty text","currentState":{"location":"non-empty text","powerLevel":"non-empty text","physicalState":"non-empty text","mentalState":"non-empty text","keyItems":"non-empty text","recentEvents":"non-empty text","updatedAtChapter":0}}]}',
          '[Previous complete JSON — identify existing characters only; do not echo it]',
          JSON.stringify(originalRoot),
        ].join('\n'),
      ) },
    ],
  }
}

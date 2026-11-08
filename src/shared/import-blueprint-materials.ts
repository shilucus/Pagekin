import type { PromptTemplate } from '../services/builtin-prompt-templates'
import { composePromptSystemRole } from '../services/builtin-prompt-templates'
import type { GenerationTask } from '../services/generation/generation-harness'
import { ImportPromptBuilder } from '../services/prompts/prompt-builder'
import { promptLanguageText } from '../services/prompt-language'
import { blueprintSemanticGenerationContract } from './blueprint-semantic-contract'
import type { WritingLanguage } from './writing-language'

export function buildImportBlueprintTask(input: {
  template: PromptTemplate
  writingLanguage: WritingLanguage
  items: readonly { number: number; title: string; content: string }[]
  validatedPrefix: readonly { chapterNumber: number; title: string; keyEvents: string }[]
  configSummary: string
}): GenerationTask {
  const { template, writingLanguage, items, validatedPrefix, configSummary } = input
  const activeChapterNumbers = items.map(item => item.number)
  const source = items.map(chapter => promptLanguageText(
    writingLanguage,
    `【第${chapter.number}章 ${chapter.title || '无标题'}】\n${chapter.content.slice(0, 6000)}`,
    `[Chapter ${chapter.number}: ${chapter.title || 'Untitled'}]\n${chapter.content.slice(0, 6000)}`,
  )).join('\n\n')
  const prior = validatedPrefix.slice(-10)
    .map(item => promptLanguageText(
      writingLanguage,
      `第${item.chapterNumber}章 ${item.title}：${item.keyEvents}`,
      `Chapter ${item.chapterNumber}: ${item.title} — ${item.keyEvents}`,
    ))
    .join('\n') || promptLanguageText(writingLanguage, '（无）', '(none)')
  const prompt = new ImportPromptBuilder(template, writingLanguage)
    .withChapterContent(source)
    .withChapterNumber(items[0]?.number ?? 1)
    .withChapterTitle(items.map(item => item.title).filter(Boolean).join(', '))
    .withNovelConfigSummary(promptLanguageText(
      writingLanguage,
      `${configSummary}\n\n【已验证前缀】\n${prior}`,
      `${configSummary}\n\n[Previously validated prefix]\n${prior}`,
    ))
    .build()
    + promptLanguageText(
      writingLanguage,
      '\n\n【最终不可变输出合同】\n本合同取代上述模板中的任何旧 JSON 示例或字段名，不得沿用缺少字段的旧示例。\n',
      '\n\n[Final immutable output contract]\nThis contract replaces every older JSON example or field name in the template.\n',
    )
    + `${blueprintSemanticGenerationContract(writingLanguage)}\n`
    + promptLanguageText(
      writingLanguage,
      `本批必须且只能完整返回以下 chapterNumber：${activeChapterNumbers.join('、')}。`,
      `Return complete items for exactly these chapterNumber values: ${activeChapterNumbers.join(', ')}.`,
    )
  return {
    purpose: 'import-chapter-blueprints',
    output: 'structured-data',
    messages: [
      { role: 'system', content: composePromptSystemRole({
        systemRole: template.systemRole || promptLanguageText(writingLanguage, '你是一位专业的小说结构分析师。', 'You are a professional fiction-structure analyst.'),
      }, writingLanguage) },
      { role: 'user', content: prompt },
    ],
  }
}

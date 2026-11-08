import { describe, expect, it } from 'vitest'
import {
  composePromptSystemRole,
  getBuiltinPromptTemplate,
  type PromptTemplate,
} from '../../services/builtin-prompt-templates'
import { ImportPromptBuilder } from '../../services/prompts/prompt-builder'
import { blueprintSemanticGenerationContract } from '../blueprint-semantic-contract'
import { buildImportBlueprintTask } from '../import-blueprint-materials'
import type { WritingLanguage } from '../writing-language'

const languages: WritingLanguage[] = ['zh-CN', 'en-US']
const template: PromptTemplate = {
  key: 'fictional-blueprint-materials', name: '', description: '', variables: {},
  content: 'SOURCE={{chapter_content}}\nNUMBER={{chapter_number}}\nTITLES={{chapter_title}}\nCONFIG={{novel_config_summary}}',
}

function finalContract(writingLanguage: WritingLanguage, chapters: number[]): string {
  return (writingLanguage === 'en-US'
    ? '\n\n[Final immutable output contract]\nThis contract replaces every older JSON example or field name in the template.\n'
    : '\n\n【最终不可变输出合同】\n本合同取代上述模板中的任何旧 JSON 示例或字段名，不得沿用缺少字段的旧示例。\n')
    + blueprintSemanticGenerationContract(writingLanguage) + '\n'
    + (writingLanguage === 'en-US'
      ? `Return complete items for exactly these chapterNumber values: ${chapters.join(', ')}.`
      : `本批必须且只能完整返回以下 chapterNumber：${chapters.join('、')}。`)
}

describe.each(languages)('import blueprint materials (%s)', writingLanguage => {
  const english = writingLanguage === 'en-US'

  it('matches the original built-in formula with 6000-character sources and the last ten validated items', () => {
    const builtin = getBuiltinPromptTemplate('infer_single_chapter_blueprint', writingLanguage)!
    const first = 'X'.repeat(5999) + '甲'
    const items = Object.freeze([
      Object.freeze({ number: 20, title: 'Twentieth', content: first + 'SOURCE-OVERFLOW' }),
      Object.freeze({ number: 21, title: '', content: 'Last source' }),
    ])
    const validatedPrefix = Object.freeze(Array.from({ length: 12 }, (_, index) => Object.freeze({
      chapterNumber: index + 1, title: `Title-${index + 1}`, keyEvents: `Event-${index + 1}`,
    })))
    const source = english
      ? `[Chapter 20: Twentieth]\n${first}\n\n[Chapter 21: Untitled]\nLast source`
      : `【第20章 Twentieth】\n${first}\n\n【第21章 无标题】\nLast source`
    const prior = Array.from({ length: 10 }, (_, index) => english
      ? `Chapter ${index + 3}: Title-${index + 3} — Event-${index + 3}`
      : `第${index + 3}章 Title-${index + 3}：Event-${index + 3}`).join('\n')
    const expected = new ImportPromptBuilder(builtin, writingLanguage)
      .withChapterContent(source).withChapterNumber(20).withChapterTitle('Twentieth')
      .withNovelConfigSummary(english ? `Frozen config\n\n[Previously validated prefix]\n${prior}` : `Frozen config\n\n【已验证前缀】\n${prior}`)
      .build() + finalContract(writingLanguage, [20, 21])
    const task = buildImportBlueprintTask({ template: builtin, writingLanguage, items, validatedPrefix, configSummary: 'Frozen config' })
    expect(task).toEqual({
      purpose: 'import-chapter-blueprints', output: 'structured-data',
      messages: [
        { role: 'system', content: composePromptSystemRole({ systemRole: builtin.systemRole || (english
          ? 'You are a professional fiction-structure analyst.' : '你是一位专业的小说结构分析师。') }, writingLanguage) },
        { role: 'user', content: expected },
      ],
    })
    expect(task).not.toHaveProperty('reasoningStage')
    expect(task.messages[1].content).not.toContain('SOURCE-OVERFLOW')
    expect(items[0].content).toBe(first + 'SOURCE-OVERFLOW')
    expect(validatedPrefix).toHaveLength(12)
  })

  it('retains fixed empty-prefix, untitled chapter and default role bytes', () => {
    const task = buildImportBlueprintTask({ template, writingLanguage, configSummary: 'Frozen core', validatedPrefix: [],
      items: [{ number: 7, title: '', content: 'Seventh' }, { number: 8, title: 'Eighth', content: '' }] })
    const prefix = english
      ? 'SOURCE=[Chapter 7: Untitled]\nSeventh\n\n[Chapter 8: Eighth]\n\nNUMBER=7\nTITLES=Eighth\nCONFIG=Frozen core\n\n[Previously validated prefix]\n(none)'
      : 'SOURCE=【第7章 无标题】\nSeventh\n\n【第8章 Eighth】\n\nNUMBER=7\nTITLES=Eighth\nCONFIG=Frozen core\n\n【已验证前缀】\n（无）'
    expect(task.messages[1].content).toBe(prefix + finalContract(writingLanguage, [7, 8]))
    expect(task.messages[0].content).toBe(composePromptSystemRole({ systemRole: english
      ? 'You are a professional fiction-structure analyst.' : '你是一位专业的小说结构分析师。' }, writingLanguage))
  })

  it('preserves all five requested chapter numbers, order and custom guidance without mutating inputs', () => {
    const items = Object.freeze(Array.from({ length: 5 }, (_, index) => Object.freeze({
      number: 40 + index, title: `Title ${index}`, content: `Body ${index}`,
    })))
    const custom = { ...template, systemRole: 'Frozen analyst', taskGuidance: 'Respect chapters {{chapter_number}} and {{chapter_title}}.' }
    const task = buildImportBlueprintTask({ template: custom, writingLanguage, items, validatedPrefix: [], configSummary: 'Core' })
    const source = items.map(item => english
      ? `[Chapter ${item.number}: ${item.title}]\n${item.content}`
      : `【第${item.number}章 ${item.title}】\n${item.content}`).join('\n\n')
    const expected = new ImportPromptBuilder(custom, writingLanguage)
      .withChapterContent(source).withChapterNumber(40).withChapterTitle('Title 0, Title 1, Title 2, Title 3, Title 4')
      .withNovelConfigSummary(english ? 'Core\n\n[Previously validated prefix]\n(none)' : 'Core\n\n【已验证前缀】\n（无）')
      .build() + finalContract(writingLanguage, [40, 41, 42, 43, 44])
    expect(task.messages[1].content).toBe(expected)
    expect(task.messages[0].content).toBe(composePromptSystemRole({ systemRole: 'Frozen analyst' }, writingLanguage))
    expect(items.map(item => item.number)).toEqual([40, 41, 42, 43, 44])
  })
})

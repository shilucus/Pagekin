import { composePromptSystemRole, type PromptTemplate } from '../services/builtin-prompt-templates'
import type { GenerationTask } from '../services/generation/generation-harness'
import { BasePromptBuilder } from '../services/prompts/prompt-builder'
import { writingLanguageText, type WritingLanguage } from './writing-language'

export interface ImportStyleChapter {
  number: number
  title: string
  content: string
}

export interface ImportStyleSampleOptions {
  sampleText?: string
  sampleTexts?: readonly string[]
  chapters?: readonly ImportStyleChapter[]
}

export function pickImportStyleChapters<T extends ImportStyleChapter>(chapters: readonly T[]): readonly T[] {
  if (chapters.length <= 5) return chapters
  const picked = new Map<number, T>()
  for (const chapter of chapters.slice(0, 3)) picked.set(chapter.number, chapter)
  for (const chapter of chapters.slice(-2)) picked.set(chapter.number, chapter)
  return Array.from(picked.values()).sort((a, b) => a.number - b.number)
}

export function collectImportStyleSamples(options: ImportStyleSampleOptions, writingLanguage: WritingLanguage): string[] {
  const samples: string[] = []
  if (options.sampleText?.trim()) samples.push(options.sampleText.trim().slice(0, 4000))
  if (options.sampleTexts) {
    for (const sample of options.sampleTexts) {
      if (sample.trim()) samples.push(sample.trim().slice(0, 4000))
    }
  }
  if (options.chapters) {
    for (const chapter of pickImportStyleChapters(options.chapters)) {
      if (chapter.content.trim()) {
        samples.push(writingLanguageText(writingLanguage,
          `第${chapter.number}章 ${chapter.title}\n${chapter.content.trim().slice(0, 2000)}`,
          `Chapter ${chapter.number}: ${chapter.title}\n${chapter.content.trim().slice(0, 2000)}`))
      }
    }
  }
  return samples
}

export function collectImportStyleAuthorInputs(options: ImportStyleSampleOptions): { id: string; text: string }[] {
  const inputs: { id: string; text: string }[] = []
  if (options.sampleText?.trim()) inputs.push({ id: 'style:sample', text: options.sampleText })
  options.sampleTexts?.forEach((text, index) => {
    if (text.trim()) inputs.push({ id: `style:sample:${index}`, text })
  })
  pickImportStyleChapters(options.chapters ?? []).forEach((chapter, index) => {
    if (chapter.content.trim()) inputs.push({ id: `style:imported-chapter:${index}:${chapter.number}`, text: chapter.content })
  })
  return inputs
}

class StylePromptBuilder extends BasePromptBuilder {
  constructor(template: PromptTemplate, writingLanguage: WritingLanguage, sampleText: string) {
    super(template, writingLanguage)
    this.variables = { sample_text: sampleText }
  }
}

export function buildImportStyleMaterial(template: PromptTemplate, sampleTexts: readonly string[], writingLanguage: WritingLanguage): {
  prompt: string
  systemRole: string
  task: GenerationTask
} {
  const prompt = new StylePromptBuilder(template, writingLanguage, sampleTexts.join('\n\n---\n\n')).build()
  const systemRole = composePromptSystemRole(template, writingLanguage)
  return { prompt, systemRole, task: { purpose: 'analyze-writing-style', reasoningStage: 'review', output: 'visible-text',
    messages: [{ role: 'system', content: systemRole }, { role: 'user', content: prompt }] } }
}

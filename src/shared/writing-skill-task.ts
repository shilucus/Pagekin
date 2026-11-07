import type { GenerationTask } from '../services/generation/generation-harness'
import type { WritingLanguage } from './writing-language'

export interface WritingSkillPromptMaterial {
  name: string
  content: string
}

/** Adds already selected stage guidance; selection and execution authority stay with the caller. */
export function injectWritingSkillPrompt(
  task: GenerationTask,
  writingLanguage: WritingLanguage,
  skill: WritingSkillPromptMaterial | null | undefined,
): { task: GenerationTask; skillName?: string } {
  if (!skill) return { task }
  const userMessageIndex = task.messages.findIndex(message => message.role === 'user')
  if (userMessageIndex < 0) return { task }
  const block = writingLanguage === 'en-US'
    ? `[Supplemental writing skill: ${skill.name}]\nThis guidance may improve craft, but author facts, the project writing language, and the output contract below always take priority.\n${skill.content}`
    : `【补充写作 Skill：${skill.name}】\n以下内容只能补充创作方法；作者事实、项目写作语言和后续输出合同始终优先。\n${skill.content}`
  const messages = task.messages.map((message, index) => index === userMessageIndex
    ? { ...message, content: `${block}\n\n${message.content}` }
    : message)
  const promptBudget = {
    limitUtf8Bytes: task.promptBudget?.limitUtf8Bytes
      ?? new TextEncoder().encode(messages.map(message => message.content).join('')).byteLength,
    sections: [
      { sectionName: 'writing-skill', displayName: skill.name, messageIndex: userMessageIndex, finalText: block },
      ...(task.promptBudget?.sections ?? []),
    ],
  }
  return { task: { ...task, messages, promptBudget }, skillName: skill.name }
}

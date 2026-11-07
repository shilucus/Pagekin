import type { ReviewRevisionContext } from '../../src/shared/review-revision-generation'
import { hashAuthorText } from '../../src/shared/source-ref'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { injectWritingSkillPrompt } from '../../src/shared/writing-skill-task'
import type { PromptTemplate } from '../../src/services/builtin-prompt-templates'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { buildOrdinaryReviewPrompt, buildReviewRebuildPrompt } from '../../src/services/prompts/review-chapter-prompt'
import type { ChapterMaterialIdentity } from '../../src/services/workflows/chapter-materials'
import { selectFrozenReviewRevisionMaterials } from '../../src/services/workflows/commands/review-revision-materials'

export interface WorkflowReviewMaterialInput {
  context: ReviewRevisionContext
  current: ChapterMaterialIdentity
  template: PromptTemplate
  skill?: { name: string; content: string }
}

function reviewTask(purpose: string, systemPrompt: string, prompt: string, language: WritingLanguage,
  skill: WorkflowReviewMaterialInput['skill']): GenerationTask {
  const task: GenerationTask = { purpose, output: 'structured-data', reasoningStage: 'review',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] }
  return injectWritingSkillPrompt(task, language, skill).task
}

/** Ordinary review only; the caller owns captured-source admission, execution and all receipts. */
export async function prepareWorkflowReviewMaterials(input: WorkflowReviewMaterialInput) {
  if (input.context.operation !== 'review-chapter' || input.context.recheck !== undefined) {
    throw new Error('GENERATION_ORDINARY_REVIEW_CONTEXT_REQUIRED')
  }
  const admission = await selectFrozenReviewRevisionMaterials(input.context, input.current)
  const { systemPrompt, prompt } = buildOrdinaryReviewPrompt({ context: input.context,
    template: input.template, admitted: admission.admitted })
  const rebuildPrompt = buildReviewRebuildPrompt(input.context.writingLanguage, prompt)
  const task = reviewTask('review-chapter', systemPrompt, prompt, input.context.writingLanguage, input.skill)
  const rebuildTask = reviewTask('review-chapter-rebuild', systemPrompt, rebuildPrompt, input.context.writingLanguage, input.skill)
  // Match bindMaterialDecision: hash the actual user message after captured Skill injection.
  const materialDecision = { ...admission.decision, promptHash: await hashAuthorText(task.messages[1].content) }
  return { admission, systemPrompt, prompt, rebuildPrompt, task, rebuildTask, materialDecision }
}

import { describe, expect, it } from 'vitest'
import type { ReviewFinalizedMaterial, ReviewRevisionContext } from '../../../src/shared/review-revision-generation'
import { hashAuthorText } from '../../../src/shared/source-ref'
import type { WritingLanguage } from '../../../src/shared/writing-language'
import { injectWritingSkillPrompt } from '../../../src/shared/writing-skill-task'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { buildOrdinaryReviewPrompt, buildReviewRebuildPrompt } from '../../../src/services/prompts/review-chapter-prompt'
import { ChapterMaterialCapacityError } from '../../../src/services/workflows/chapter-materials'
import { selectFrozenReviewRevisionMaterials } from '../../../src/services/workflows/commands/review-revision-materials'
import { prepareWorkflowReviewMaterials } from '../workflow-review-materials'

const current = { projectId: 'synthetic-review-project', epoch: 'main-captured-epoch' }

async function fixture(language: WritingLanguage = 'en-US') {
  const history = async (chapterNumber: number, content: string): Promise<ReviewFinalizedMaterial> => ({
    draftId: chapterNumber, chapterNumber, chapterTitle: `Chapter ${chapterNumber}`, content,
    identity: { projectId: current.projectId, sourceId: `finalized:${chapterNumber}`, revision: chapterNumber,
      contentHash: await hashAuthorText(content), provenance: 'finalized' },
  })
  const context: ReviewRevisionContext = {
    version: 1, operation: 'review-chapter', writingLanguage: language,
    uiLocale: language === 'en-US' ? 'zh-CN' : 'en-US',
    source: { id: 31, chapterNumber: 3, version: 1, status: 'draft', content: 'At noon, Mina read the letter.\n\nThe door stayed open.' },
    sourceHash: await hashAuthorText('At noon, Mina read the letter.\n\nThe door stayed open.'),
    config: { writingLanguage: language, genre: 'mystery', subGenre: '', targetAudience: 'adult', totalChapters: 10,
      wordsPerChapter: 1000, plotStructure: 'three_act', narrativePOV: 'third_limited',
      coreOutline: 'Find the letter without changing the meeting time.', worldSetting: 'The town has no electricity.',
      goldenFinger: '', protagonistProfile: 'Mina', globalGuidance: 'Preserve the author facts.' },
    authorInputs: [{ id: 'review-focus', text: 'Check the letter and the timing.' }],
    characterStates: 'Mina is inside at noon.', worldbuilding: 'The town has no electricity.',
    history: [await history(1, 'Earlier, Mina agreed to meet at noon.')],
    predecessor: await history(2, 'At noon, Mina opened the door.\n\nThe letter waited inside.'),
    blueprints: [{ chapterNumber: 3, title: 'The letter', role: 'development', purpose: 'Read the letter',
      keyEvents: 'Read the letter', characters: ['Mina'], suspenseHook: '', userGuidance: '', notes: '' }],
    frozenGoals: { chapterNumber: 3, coverage: 'complete', items: [{ id: 'letter', text: 'Read the letter.' }] },
    preflightFindings: [],
  }
  return { context, current: { ...current }, template: getBuiltinPromptTemplate('consistency_check', language)! }
}

describe('captured ordinary-review materials for main', () => {
  it.each(['zh-CN', 'en-US'] as const)('reuses the existing %s selection and exact prompt without renderer state', async language => {
    const input = await fixture(language)
    input.template = { ...input.template, taskGuidance: 'Captured guidance only.' }
    const before = JSON.stringify(input)
    const admission = await selectFrozenReviewRevisionMaterials(input.context, input.current)
    const ordinary = buildOrdinaryReviewPrompt({ context: input.context, template: input.template, admitted: admission.admitted })
    const prepared = await prepareWorkflowReviewMaterials(input)
    expect(prepared.admission).toEqual(admission)
    expect(prepared.systemPrompt).toBe(ordinary.systemPrompt)
    expect(prepared.prompt).toBe(ordinary.prompt)
    expect(prepared.rebuildPrompt).toBe(buildReviewRebuildPrompt(language, ordinary.prompt))
    expect(prepared.task).toEqual({ purpose: 'review-chapter', output: 'structured-data', reasoningStage: 'review',
      messages: [{ role: 'system', content: ordinary.systemPrompt }, { role: 'user', content: ordinary.prompt }] })
    expect(prepared.rebuildTask).toEqual({ ...prepared.task, purpose: 'review-chapter-rebuild',
      messages: [{ role: 'system', content: ordinary.systemPrompt }, { role: 'user', content: prepared.rebuildPrompt }] })
    expect(prepared.task).not.toHaveProperty('promptBudget')
    expect(prepared.task).not.toHaveProperty('responseFormat')
    expect(prepared.task).not.toHaveProperty('writingSkillStage')
    expect(prepared.materialDecision).toEqual({ ...admission.decision, promptHash: await hashAuthorText(ordinary.prompt) })
    expect(prepared.prompt).toContain(input.context.predecessor!.content)
    expect(JSON.stringify(input)).toBe(before)
  })

  it.each(['zh-CN', 'en-US'] as const)('hashes the final %s user bytes after the captured Skill, matching bindMaterialDecision', async language => {
    const input = { ...await fixture(language), skill: { name: 'Captured review skill', content: '  Compare events carefully.\nPreserve facts.  ' } }
    const before = JSON.stringify(input)
    const prepared = await prepareWorkflowReviewMaterials(input)
    const ordinaryTask = { ...prepared.task, messages: [
      { role: 'system' as const, content: prepared.systemPrompt }, { role: 'user' as const, content: prepared.prompt },
    ] }
    delete ordinaryTask.promptBudget
    const expected = injectWritingSkillPrompt(ordinaryTask, language, input.skill).task
    expect(prepared.task).toEqual(expected)
    const originalBindingTask = injectWritingSkillPrompt({ purpose: 'review-chapter', output: 'visible-text',
      messages: [{ role: 'user', content: prepared.prompt }] }, language, input.skill).task
    expect(prepared.task.messages[1].content).toBe(originalBindingTask.messages[0].content)
    expect(prepared.materialDecision.promptHash).toBe(await hashAuthorText(originalBindingTask.messages[0].content))
    expect(prepared.materialDecision.promptHash).not.toBe(await hashAuthorText(prepared.prompt))
    expect(prepared.rebuildTask).toEqual(injectWritingSkillPrompt({ purpose: 'review-chapter-rebuild',
      output: 'structured-data', reasoningStage: 'review', messages: [
        { role: 'system', content: prepared.systemPrompt }, { role: 'user', content: prepared.rebuildPrompt },
      ] }, language, input.skill).task)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('uses the saved predecessor and excludes stale derived claims while retaining its original prose', async () => {
    const input = await fixture()
    input.context.predecessor!.projection = { draftId: 2, chapterNumber: 2, chapterTitle: 'Door', chapterNotes: '', sourceStatus: 'stale',
      facts: [{ category: 'timeline', entities: ['Mina'], statement: 'STALE DERIVED CLAIM', sourceChapter: 2, evidence: 'the door' }] }
    const prepared = await prepareWorkflowReviewMaterials(input)
    expect(prepared.prompt).toContain('At noon, Mina opened the door.\n\nThe letter waited inside.')
    expect(prepared.prompt).not.toContain('STALE DERIVED CLAIM')
    expect(prepared.admission.admitted.find(item => item.identity.sourceId === 'finalized:2')?.required).toBe(true)
  })

  it('propagates a missing required predecessor identity instead of inventing provenance', async () => {
    const input = await fixture()
    delete input.context.predecessor!.identity
    await expect(prepareWorkflowReviewMaterials(input)).rejects.toBeInstanceOf(ChapterMaterialCapacityError)
  })

  it('uses the existing selector to omit optional unknown history without replacing it', async () => {
    const input = await fixture()
    input.context.history.push({ draftId: 9, chapterNumber: 1, chapterTitle: 'Unknown', content: 'UNKNOWN HISTORY MUST NOT ENTER' })
    const prepared = await prepareWorkflowReviewMaterials(input)
    expect(prepared.prompt).not.toContain('UNKNOWN HISTORY MUST NOT ENTER')
    expect(prepared.admission).toEqual(await selectFrozenReviewRevisionMaterials(input.context, input.current))
  })

  it.each(['refine-draft', 'refine-from-review'] as const)('rejects %s instead of silently preparing an ordinary review', async operation => {
    const input = await fixture()
    input.context.operation = operation
    await expect(prepareWorkflowReviewMaterials(input)).rejects.toThrow('GENERATION_ORDINARY_REVIEW_CONTEXT_REQUIRED')
  })

  it('leaves targeted recheck preparation to the existing command', async () => {
    const input = await fixture()
    input.context.recheck = { version: 2, cycleId: 'captured-cycle', comparisonVersion: 1,
      mergedHash: 'a'.repeat(64), findingSetHash: 'b'.repeat(64), findings: [] }
    await expect(prepareWorkflowReviewMaterials(input)).rejects.toThrow('GENERATION_ORDINARY_REVIEW_CONTEXT_REQUIRED')
  })
})

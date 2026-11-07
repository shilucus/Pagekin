import { describe, expect, it } from 'vitest'
import { WORKFLOW_BATCH_CHANNELS, WORKFLOW_BATCH_TEMPLATE, assertWorkflowBatchRequest,
  assertWorkflowBatchSlot, isWorkflowBatchChannel, parseStartWorkflowBatchRequest,
  parseWorkflowBatchIntent, parseWorkflowBatchRecipe, parseWorkflowBatchStepInput,
  workflowBatchRequiresView, type WorkflowBatchStepKind } from '../workflow-batch-contract'
import { DRAFT_SHORT_OUTLINE_PURPOSE } from '../draft-short-outline'
import { DRAFT_CONDENSE_PURPOSE } from '../draft-visible-text'

const uuid = '11111111-1111-4111-8111-111111111111'
const hash = 'a'.repeat(64)
const intent = () => ({ mode: 'draft_review' as const, range: { startChapter: 2, endChapter: 11 }, targetUnits: 100 })
const request = () => ({ operationKey: uuid, modelId: 'fictional-draft-model', reviewModelId: 'fictional-review-model',
  uiLocale: 'en-US' as const, intent: intent(), authorInputs: [{ id: 'draft:target-units', text: '100' }] })
const model = (purpose = 'chapter-draft', output: 'visible-text' | 'structured-data' = 'visible-text') => ({
  kind: 'model' as const, task: { purpose, output, messages: [{ role: 'user' as const, content: 'Fictional material' }] },
})

describe('closed planned batch v2 recipe and IPC', () => {
  it('retains only explicit start selections and canonicalizes the semantic recipe', () => {
    const start = request()
    expect(parseStartWorkflowBatchRequest(start)).toEqual(start)
    const recipe = { schemaVersion: 2, writingLanguage: 'zh-CN', uiLocale: start.uiLocale,
      intent: start.intent, authorInputs: start.authorInputs }
    expect(parseWorkflowBatchRecipe(recipe)).toEqual(recipe)
    expect(JSON.stringify(parseWorkflowBatchRecipe({ authorInputs: recipe.authorInputs, intent: recipe.intent,
      uiLocale: recipe.uiLocale, writingLanguage: recipe.writingLanguage, schemaVersion: 2 })))
      .toBe(JSON.stringify(parseWorkflowBatchRecipe(recipe)))
    expect(WORKFLOW_BATCH_TEMPLATE).toBe('prepared-batch-review-v2')
  })

  it.each(['recipe', 'tasks', 'writingLanguage', 'epoch', 'nonce', 'apiKey', 'capability', 'plan'])(
    'rejects caller-supplied start authority or prepared behavior %s', key => {
      expect(() => parseStartWorkflowBatchRequest({ ...request(), [key]: 'fictional-excluded' }))
        .toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    })

  it('bounds a nonempty contiguous range to ten chapters using the existing target interval', () => {
    expect(parseWorkflowBatchIntent(intent())).toEqual(intent())
    expect(parseWorkflowBatchIntent({ ...intent(), range: { startChapter: 1, endChapter: 1 }, targetUnits: 20_000 }))
      .toMatchObject({ targetUnits: 20_000 })
    for (const range of [{ startChapter: 0, endChapter: 1 }, { startChapter: 2, endChapter: 1 },
      { startChapter: 1, endChapter: 11 }, { startChapter: 1.5, endChapter: 2 }]) {
      expect(() => parseWorkflowBatchIntent({ ...intent(), range })).toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    }
    for (const targetUnits of [0, 99, 20_001, 100.5, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      expect(() => parseWorkflowBatchIntent({ ...intent(), targetUnits })).toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    }
    expect(() => parseWorkflowBatchIntent({ ...intent(), mode: 'auto-finalize' })).toThrow()
    expect(() => parseWorkflowBatchIntent({ ...intent(), range: { ...intent().range, candidateId: 1 } })).toThrow()
  })

  it('rejects missing or extra nested recipe fields without rewriting author text', () => {
    const recipe = { schemaVersion: 2, writingLanguage: 'en-US', uiLocale: 'zh-CN', intent: intent(),
      authorInputs: [{ id: 'fictional-fact', text: 'The fictional dialogue says "apiKey" and "epoch".' }] }
    expect(parseWorkflowBatchRecipe(recipe).authorInputs).toEqual(recipe.authorInputs)
    for (const difference of [{ schemaVersion: 1 }, { writingLanguage: 'fr-FR' }, { uiLocale: 'auto' },
      { authorInputs: [{ ...recipe.authorInputs[0], modelHash: hash }] }, { authorInputs: undefined }]) {
      expect(() => parseWorkflowBatchRecipe({ ...recipe, ...difference })).toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    }
  })

  it('accepts only the existing optional batch input assertions, never unconsumed author instructions', () => {
    expect(parseStartWorkflowBatchRequest({ ...request(), authorInputs: [] }).authorInputs).toEqual([])
    for (const authorInputs of [[{ id: 'fictional-new-instruction', text: 'Must not be silently ignored' }],
      [...request().authorInputs, ...request().authorInputs]]) {
      expect(() => parseStartWorkflowBatchRequest({ ...request(), authorInputs })).toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    }
  })

  it('keeps nine unique accepted artifacts, including the optional condense replacement', () => {
    const input = { kind: 'compose', artifactIds: Array.from({ length: 9 }, (_, index) => `fictional-artifact-${index}`),
      algorithm: 'draft-visible-v2', expectedTextHash: hash }
    expect(parseWorkflowBatchStepInput(input)).toEqual(input)
    expect(() => parseWorkflowBatchStepInput({ ...input, artifactIds: [...input.artifactIds, 'fictional-tenth'] })).toThrow()
    expect(() => parseWorkflowBatchStepInput({ ...input, artifactIds: [uuid, uuid] })).toThrow()
    expect(() => parseWorkflowBatchStepInput({ ...input, invocationNonce: uuid })).toThrow()
  })

  it.each([
    ['outline', 1, DRAFT_SHORT_OUTLINE_PURPOSE], ['draft', 0, 'chapter-draft'],
    ['continue', 6, 'chapter-draft-continuation'], ['continue', 6, 'chapter-draft-no-progress-recovery'],
    ['condense', 0, DRAFT_CONDENSE_PURPOSE],
  ] as const)('admits the existing %s purpose and exact slot bound', (kind, max, purpose) => {
    const input = parseWorkflowBatchStepInput(model(purpose))
    expect(() => assertWorkflowBatchSlot('draft', kind, max, input)).not.toThrow()
    expect(() => assertWorkflowBatchSlot('draft', kind, max + 1, input)).toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    expect(() => assertWorkflowBatchSlot('review', kind, max, input)).toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
  })

  it('does not accept the nonexistent continuation purpose or wrong output family', () => {
    expect(() => assertWorkflowBatchSlot('draft', 'continue', 0, model('chapter-draft-continue'))).toThrow()
    expect(() => assertWorkflowBatchSlot('draft', 'draft', 0, model('chapter-draft', 'structured-data'))).toThrow()
    expect(() => parseWorkflowBatchStepInput({ ...model(), task: { ...model().task, modelId: 'fictional' } })).toThrow()
  })

  it.each([['review', 'review-chapter'], ['review_rebuild', 'review-chapter-rebuild']] as const)(
    'allows only two structured requests for %s', (kind, purpose) => {
      const input = model(purpose, 'structured-data')
      expect(() => assertWorkflowBatchSlot('review', kind, 1, input)).not.toThrow()
      expect(() => assertWorkflowBatchSlot('review', kind, 2, input)).toThrow()
      expect(() => assertWorkflowBatchSlot('review', kind, 0, model(purpose))).toThrow()
    })

  it('separates model observations, accepted compositions and authoritative domain commits', () => {
    const inputs = [{ kind: 'compose', artifactIds: [uuid], algorithm: 'draft-visible-v2', expectedTextHash: hash },
      { kind: 'draft-commit', expectedCompositionHash: hash },
      { kind: 'review-commit', artifact: { artifactId: uuid, revision: 1, textHash: hash } }]
    for (const input of inputs) expect(parseWorkflowBatchStepInput(input)).toEqual(input)
    expect(() => assertWorkflowBatchSlot('draft', 'compose', 8, parseWorkflowBatchStepInput(inputs[0]))).not.toThrow()
    expect(() => assertWorkflowBatchSlot('draft', 'draft_commit', 0, parseWorkflowBatchStepInput(inputs[1]))).not.toThrow()
    expect(() => assertWorkflowBatchSlot('review', 'review_commit', 0, parseWorkflowBatchStepInput(inputs[2]))).not.toThrow()
    expect(() => assertWorkflowBatchSlot('draft', 'skipped' as WorkflowBatchStepKind, 0, model())).toThrow()
    expect(() => parseWorkflowBatchStepInput({ kind: 'review-commit', artifact: { artifactId: uuid, revision: 0, textHash: hash } })).toThrow()
    expect(() => parseWorkflowBatchStepInput({ kind: 'commit', chapterNumber: 1, expectedCompositionHash: hash })).toThrow()
  })

  it('keeps a literal versioned route set without approval or generic execution', () => {
    for (const channel of WORKFLOW_BATCH_CHANNELS) expect(isWorkflowBatchChannel(channel)).toBe(true)
    for (const channel of ['workflow-batch:v1:start', 'workflow-batch:v2:approve', 'workflow-batch:v2:execute', 'workflow-batch:start']) {
      expect(isWorkflowBatchChannel(channel)).toBe(false)
    }
    expect(WORKFLOW_BATCH_CHANNELS.filter(workflowBatchRequiresView)).toEqual([
      'workflow-batch:v2:start', 'workflow-batch:v2:reauthorize', 'workflow-batch:v2:read-history',
    ])
  })

  it.each(['read-receipt', 'pause', 'cancel', 'resume'] as const)('%s requires the exact capability-shaped public reference', action => {
    const channel = `workflow-batch:v2:${action}` as const
    const value = { reference: { projectId: 'fictional-project', taskId: uuid, revision: 1 } }
    expect(() => assertWorkflowBatchRequest(channel, value)).not.toThrow()
    for (const reference of [{ ...value.reference, epoch: uuid }, { ...value.reference, revision: 0 },
      { ...value.reference, taskId: 'not-a-task-uuid' }]) {
      expect(() => assertWorkflowBatchRequest(channel, { reference })).toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    }
    expect(() => assertWorkflowBatchRequest(channel, { ...value, leaseId: uuid })).toThrow()
  })
})

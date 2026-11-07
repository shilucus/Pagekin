import { describe, expect, it } from 'vitest'
import { WORKFLOW_DRIVER_CHANNELS, assertWorkflowDriverRequest, isWorkflowDriverChannel,
  parseWorkflowDriverRecipe, parseWorkflowDriverStepInput, parseWorkflowDriverTask,
  workflowDriverRequiresView } from '../workflow-driver-contract'
import { draftShortOutlineTask } from '../draft-short-outline'

const uuid = '11111111-1111-4111-8111-111111111111'
const hash = 'a'.repeat(64)
const task = () => ({ purpose: 'chapter-draft', output: 'visible-text' as const,
  messages: [{ role: 'system' as const, content: 'Fictional writer contract' },
    { role: 'user' as const, content: 'Fictional material and writing skill' }],
  reasoningStage: 'drafting' as const,
  budgetDemand: { kind: 'draft-units' as const, writingLanguage: 'en-US' as const, requestedUnits: 100, segmentable: true },
  promptBudget: { limitUtf8Bytes: 200, sections: [{ sectionName: 'writing-skill', messageIndex: 1, finalText: 'writing skill' }] } })
const recipe = () => ({ schemaVersion: 1, writingLanguage: 'en-US',
  outlineTask: draftShortOutlineTask('en-US', 'Fictional material'), baseDraftTask: task() })

describe('closed workflow driver semantic history and versioned IPC', () => {
  it('canonicalizes the same recipe irrespective of input property insertion order', () => {
    const input = recipe()
    const reordered = { baseDraftTask: input.baseDraftTask, writingLanguage: input.writingLanguage,
      outlineTask: input.outlineTask, schemaVersion: input.schemaVersion }
    expect(JSON.stringify(parseWorkflowDriverRecipe(reordered))).toBe(JSON.stringify(parseWorkflowDriverRecipe(input)))
    expect(parseWorkflowDriverRecipe(input)).toEqual(input)
  })

  it.each(['maxTokens', 'maxOutputTokens', 'responseFormat', 'thinking', 'plan', 'model', 'handle', 'epoch', 'nonce', 'apiKey'])(
    'rejects a physical or authority field %s instead of retaining its value or digest', field => {
      expect(() => parseWorkflowDriverTask({ ...task(), [field]: 'fictional-excluded' })).toThrow('WORKFLOW_DRIVER_PAYLOAD_INVALID')
    })

  it.each([
    (value: ReturnType<typeof task>) => Object.assign(value.messages[0]!, { handle: uuid }),
    (value: ReturnType<typeof task>) => Object.assign(value.budgetDemand, { modelId: 'fictional' }),
    (value: ReturnType<typeof task>) => Object.assign(value.promptBudget, { leaseId: uuid }),
    (value: ReturnType<typeof task>) => Object.assign(value.promptBudget.sections[0]!, { nonce: uuid }),
    (value: ReturnType<typeof task>) => { value.promptBudget.sections[0]!.messageIndex = 5 },
    (value: ReturnType<typeof task>) => { value.promptBudget.sections[0]!.finalText = 'absent-fragment' },
    (value: ReturnType<typeof task>) => { value.budgetDemand.requestedUnits = Number.NaN },
  ])('rejects a nested field or invalid protected fragment', change => {
    const value = task(); change(value)
    expect(() => parseWorkflowDriverTask(value)).toThrow('WORKFLOW_DRIVER_PAYLOAD_INVALID')
  })

  it('preserves supplied manuscript text without heuristic rewriting', () => {
    const value = task()
    value.messages[1]!.content += '\nThe fictional character says "handle" and "apiKey".'
    expect(parseWorkflowDriverTask(value).messages).toEqual(value.messages)
  })

  it('supports the existing structured demand without a new token refusal policy', () => {
    expect(parseWorkflowDriverTask({ purpose: 'fictional-review', output: 'structured-data', messages: [{ role: 'user', content: '' }],
      budgetDemand: { kind: 'structured-items', writingLanguage: 'en-US', requestedItems: 2 } })).toMatchObject({
      budgetDemand: { requestedItems: 2 } })
  })

  it('keeps exact closed inputs for model, composition and formal draft effects', () => {
    for (const input of [{ kind: 'model', task: task() },
      { kind: 'compose', artifactIds: [uuid], algorithm: 'draft-visible-v2', expectedTextHash: hash },
      { kind: 'commit', chapterNumber: 1, expectedCompositionHash: hash }]) {
      expect(parseWorkflowDriverStepInput(input)).toEqual(input)
      expect(() => parseWorkflowDriverStepInput({ ...input, invocationNonce: uuid })).toThrow('WORKFLOW_DRIVER_PAYLOAD_INVALID')
    }
    expect(() => parseWorkflowDriverStepInput({ kind: 'compose', artifactIds: [uuid, uuid],
      algorithm: 'draft-visible-v2', expectedTextHash: hash })).toThrow('WORKFLOW_DRIVER_PAYLOAD_INVALID')
  })

  it('uses an explicit channel set and never admits generic approval or arbitrary execution', () => {
    for (const channel of WORKFLOW_DRIVER_CHANNELS) expect(isWorkflowDriverChannel(channel)).toBe(true)
    for (const channel of ['workflow-driver:v2:start', 'workflow-driver:v1:approve', 'workflow-driver:v1:execute', 'workflow-driver:start']) {
      expect(isWorkflowDriverChannel(channel)).toBe(false)
    }
    expect(WORKFLOW_DRIVER_CHANNELS.filter(workflowDriverRequiresView)).toEqual([
      'workflow-driver:v1:prepare-context', 'workflow-driver:v1:start', 'workflow-driver:v1:reauthorize', 'workflow-driver:v1:read-history',
    ])
  })

  it.each(['read-receipt', 'pause', 'cancel', 'resume'] as const)('keeps %s capability-shaped and rejects invented authority', action => {
    const channel = `workflow-driver:v1:${action}` as const
    const value = { reference: { projectId: 'fictional-project', taskId: uuid, revision: 1 } }
    expect(() => assertWorkflowDriverRequest(channel, value)).not.toThrow()
    expect(() => assertWorkflowDriverRequest(channel, { ...value, leaseId: 'fictional' })).toThrow()
    expect(() => assertWorkflowDriverRequest(channel, { reference: { ...value.reference, executionEpoch: uuid } })).toThrow()
    expect(() => assertWorkflowDriverRequest(channel, { reference: { ...value.reference, revision: 0 } })).toThrow()
  })

  it('only admits a prepared first chapter without predecessor/candidate selections', () => {
    const value = { operationKey: uuid, recipe: recipe(), selection: { operation: 'chapter-draft', chapterNumber: 1,
      uiActionNonce: uuid, modelId: 'fictional', selectedDraftIds: [], selectedFinalizedDraftIds: [],
      promptKeys: ['draft'], skillStages: ['drafting'], output: 'visible-text', preparationId: uuid, materialDecision: {} } }
    expect(() => assertWorkflowDriverRequest('workflow-driver:v1:start', value)).not.toThrow()
    for (const difference of [{ chapterNumber: 2 }, { operation: 'agent-round' }, { selectedDraftIds: [1] },
      { selectedFinalizedDraftIds: [1] }, { parentRootActionId: uuid }, { batchId: uuid }, { importExecution: {} }]) {
      expect(() => assertWorkflowDriverRequest('workflow-driver:v1:start', { ...value,
        selection: { ...value.selection, ...difference } })).toThrow('WORKFLOW_DRIVER_PAYLOAD_INVALID')
    }
  })
})

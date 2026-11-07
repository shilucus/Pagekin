import { describe, expect, it, vi } from 'vitest'
import { draftShortOutlineBlock } from '../../../src/shared/draft-short-outline'
import { runWorkflowBatch, type WorkflowBatchEngineOptions } from '../workflow-batch-engine'

describe('workflow batch execution admission', () => {
  it('does not open a chapter or acknowledge effects after authority is revoked', async () => {
    const openDraft = vi.fn(), acknowledge = vi.fn()
    const options = {
      database: { transaction: (fn: () => void) => ({ immediate: fn }) },
      repository: { get: () => ({ recipe: { intent: { range: { startChapter: 1, endChapter: 1 } } } }),
        acknowledgeFromReceipt: acknowledge },
      owner: {}, runs: {}, ref: { taskId: 'task', revision: 1, batchRunId: 'root' }, openDraft,
      assertActive: () => { throw new Error('WORKFLOW_BATCH_REVOKED') },
    } as unknown as WorkflowBatchEngineOptions
    await expect(runWorkflowBatch(options)).rejects.toThrow('WORKFLOW_BATCH_REVOKED')
    expect(openDraft).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('never resends an already reserved invocation without a receipt', async () => {
    const execute = vi.fn(), handle = { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'run' }
    const outlineTask = { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [] }
    const step = { stepId: 'step', kind: 'outline', slot: 0, invocationNonce: 'nonce', input: { kind: 'model', task: outlineTask } }
    const options = {
      database: { transaction: (fn: () => void) => ({ immediate: fn }) },
      repository: { get: () => ({ recipe: { intent: { range: { startChapter: 1, endChapter: 1 } } } }),
        assertActive: vi.fn(), readSteps: () => [], bindStep: () => step, acknowledgeFromReceipt: () => null },
      runs: { get: () => ({ binding: { fingerprint: { modelLeaseRevision: 'model', policyHash: 'policy' } } }),
        findInvocation: () => ({ attemptId: 'attempt' }) },
      owner: { executeWorkflowDriver: execute }, ref: { taskId: 'task', revision: 1, batchRunId: 'root' },
      assertActive: vi.fn(), openDraft: async () => ({ handle, materials: { outlineTask } }),
    } as unknown as WorkflowBatchEngineOptions
    await expect(runWorkflowBatch(options)).rejects.toThrow('WORKFLOW_BATCH_ATTEMPT_UNRESOLVED')
    expect(execute).not.toHaveBeenCalled()
  })

  it('waits for physical transport to drain before inspecting or advancing its receipt', async () => {
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const draining = new Promise<void>(resolve => { entered = resolve })
    const acknowledge = vi.fn(() => null), execute = vi.fn(async () => ({}))
    const handle = { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'run' }
    const outlineTask = { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [] }
    const step = { stepId: 'step', kind: 'outline', slot: 0, invocationNonce: 'nonce', input: { kind: 'model', task: outlineTask } }
    const options = {
      database: { transaction: (fn: () => void) => ({ immediate: fn }) },
      repository: { get: () => ({ recipe: { intent: { range: { startChapter: 1, endChapter: 1 } } } }),
        assertActive: vi.fn(), readSteps: () => [], bindStep: () => step, acknowledgeFromReceipt: acknowledge },
      runs: { get: () => ({ binding: { fingerprint: { modelLeaseRevision: 'model', policyHash: 'policy' } } }),
        findInvocation: () => null },
      owner: { executeWorkflowDriver: execute, whenPhysicalIdle: () => { entered(); return gate }, read: () => ({}) },
      ref: { taskId: 'task', revision: 1, batchRunId: 'root' }, assertActive: vi.fn(),
      openDraft: async () => ({ handle, materials: { outlineTask } }),
      withKnowledge: async (_handle: unknown, operation: () => unknown) => operation(),
    } as unknown as WorkflowBatchEngineOptions
    const running = runWorkflowBatch(options)
    await draining
    expect(execute).toHaveBeenCalledTimes(1)
    expect(acknowledge).toHaveBeenCalledTimes(1)
    release()
    await expect(running).rejects.toThrow('WORKFLOW_BATCH_RECEIPT_MISSING')
    expect(acknowledge).toHaveBeenCalledTimes(2)
  })

  it.each([
    { language: 'zh-CN', recovery: false }, { language: 'zh-CN', recovery: true },
    { language: 'en-US', recovery: false }, { language: 'en-US', recovery: true },
  ] as const)('binds the completed outline into continuation and recovery for $language (recovery=$recovery)', async ({ language, recovery }) => {
    const handle = { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'run' }
    const outlineTask = { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [{ role: 'user', content: 'outline prompt' }] }
    const baseDraftTask = { purpose: 'chapter-draft', output: 'visible-text', messages: [
      { role: 'system', content: 'original system' }, { role: 'user', content: 'draft prompt' }] }
    type Input = { kind: string; task?: { purpose: string; messages: { role: string; content: string }[] } }
    const steps: { stepId: string; chapterNumber: number; kind: string; slot: number; invocationNonce: string; input: Input }[] = []
    const finished = new Map<string, string>(), receipts = new Map<string, unknown>()
    const materials = { outlineTask, baseDraftTask, writingLanguage: language, targetUnits: 100, writingSkill: null,
      previousEnding: '', systemPrompt: 'original system', promptMaterial: { chapterInfo: { chapterNumber: 1, title: 'one', role: 'development',
        purpose: '', characters: [], keyEvents: '', suspenseHook: '', userGuidance: '' }, globalGuidance: '', writingStyle: '',
      novelConfigFacts: '{}', chapterMaterials: '', reconciliation: 'earlier reconciliation' } }
    const repository = {
      get: () => ({ recipe: { intent: { range: { startChapter: 1, endChapter: 1 } } } }), assertActive: vi.fn(), readSteps: () => steps,
      bindStep: (_ref: unknown, input: { chapterNumber: number; kind: string; slot: number; input: Input }) => {
        const existing = steps.find(step => step.kind === input.kind && step.slot === input.slot)
        if (existing) { expect(input.input).toEqual(existing.input); return existing }
        const step = { ...input, stepId: `step-${steps.length}`, invocationNonce: `nonce-${steps.length}` }
        steps.push(step); return step
      },
      acknowledgeFromReceipt: (_ref: unknown, stepId: string) => {
        const attemptId = finished.get(stepId)
        return attemptId ? { receiptAttemptId: attemptId } : null
      },
      withEffectCommit: (_ref: unknown, _stepId: string, commit: () => unknown) => commit(),
    }
    const execute = vi.fn(async ({ invocationNonce }: { invocationNonce: string }) => {
      const step = steps.find(item => item.invocationNonce === invocationNonce)!, attemptId = `attempt-${step.stepId}`
      const lowProgress = step.kind === 'continue' && step.slot === 0 && recovery
      const text = step.kind === 'outline' ? 'completed outline' : step.kind === 'draft' ? '甲'.repeat(30)
        : lowProgress ? '丙'.repeat(3) : '乙'.repeat(50)
      receipts.set(attemptId, { result: { finishReason: step.kind === 'draft' || lowProgress ? 'length' : 'stop' },
        artifact: { artifactId: `artifact-${step.kind}-${step.slot}`, text } })
      finished.set(step.stepId, attemptId)
    })
    const owner = { executeWorkflowDriver: execute, whenPhysicalIdle: async () => {}, read: () => ({}),
      assertSourcesCurrent: vi.fn(), composeVisible: vi.fn(), commitDraft: vi.fn() }
    const options = { database: { transaction: (fn: () => void) => ({ immediate: fn }) }, repository, owner,
      runs: { get: () => ({ binding: { fingerprint: { modelLeaseRevision: 'model', policyHash: 'policy' }, sourceManifest: { modelReceipt: {} } } }),
        findInvocation: () => null, receipt: (id: string) => receipts.get(id) },
      ref: { taskId: 'task', revision: 1, batchRunId: 'root' }, assertActive: vi.fn(),
      openDraft: async () => ({ handle, materials }), openReview: async () => { throw new Error('REVIEW_REACHED') },
      withKnowledge: async (_handle: unknown, operation: () => unknown) => operation(),
    } as unknown as WorkflowBatchEngineOptions
    await expect(runWorkflowBatch(options)).rejects.toThrow('REVIEW_REACHED')
    const continuations = steps.filter(step => step.kind === 'continue')
    expect(continuations.map(step => step.input.task!.purpose)).toEqual(recovery
      ? ['chapter-draft-continuation', 'chapter-draft-no-progress-recovery'] : ['chapter-draft-continuation'])
    for (const step of continuations) {
      const messages = step.input.task!.messages
      expect(messages.filter(message => message.role === 'system')).toEqual([{ role: 'system', content: 'original system' }])
      expect(messages.find(message => message.role === 'user')!.content).toContain(
        `earlier reconciliation\n\n${draftShortOutlineBlock(language, 'completed outline')}`)
    }
    const calls = execute.mock.calls.length
    await expect(runWorkflowBatch(options)).rejects.toThrow('REVIEW_REACHED')
    expect(execute).toHaveBeenCalledTimes(calls)
  })

  it('never binds a draft or continuation when both outline attempts remain incomplete', async () => {
    const handle = { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'run' }
    const outlineTask = { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [{ role: 'user', content: 'outline prompt' }] }
    const steps: { stepId: string; kind: string; slot: number; invocationNonce: string; input: unknown }[] = []
    const finished = new Map<string, string>()
    const repository = {
      get: () => ({ recipe: { intent: { range: { startChapter: 1, endChapter: 1 } } } }), assertActive: vi.fn(), readSteps: () => steps,
      bindStep: (_ref: unknown, input: { kind: string; slot: number; input: unknown }) => {
        const step = { ...input, stepId: `step-${input.slot}`,
          invocationNonce: input.slot === 0 ? 'first' : 'draft-short-outline-retry:attempt-0' }
        steps.push(step); return step
      },
      acknowledgeFromReceipt: (_ref: unknown, id: string) => {
        const attemptId = finished.get(id)
        return attemptId ? { receiptAttemptId: attemptId } : null
      },
    }
    const execute = vi.fn(async () => { finished.set('step-0', 'attempt-0') })
    const retry = vi.fn(async () => { finished.set('step-1', 'attempt-1') })
    const options = { database: { transaction: (fn: () => void) => ({ immediate: fn }) }, repository,
      runs: { get: () => ({ binding: { fingerprint: { modelLeaseRevision: 'model', policyHash: 'policy' } } }),
        findInvocation: () => null, receipt: () => ({ result: { finishReason: 'length' }, artifact: { text: 'partial outline' } }) },
      owner: { executeWorkflowDriver: execute, retryWorkflowBatchShortOutline: retry, whenPhysicalIdle: async () => {}, read: () => ({}) },
      ref: { taskId: 'task', revision: 1, batchRunId: 'root' }, assertActive: vi.fn(),
      openDraft: async () => ({ handle, materials: { outlineTask } }),
      withKnowledge: async (_handle: unknown, operation: () => unknown) => operation(),
    } as unknown as WorkflowBatchEngineOptions
    await expect(runWorkflowBatch(options)).rejects.toThrow('GENERATION_DRAFT_SHORT_OUTLINE_FAILED')
    expect(steps.map(step => [step.kind, step.slot])).toEqual([['outline', 0], ['outline', 1]])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it.each(['GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', 'GENERATION_CONTEXT_LENGTH_EXCEEDED', 'OTHER_FAILURE'])(
    'only retains a completed original after the established condense failure %s', async failureCode => {
      const handle = { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'run' }
      const outlineTask = { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [{ role: 'user', content: 'outline' }] }
      const baseDraftTask = { purpose: 'chapter-draft', output: 'visible-text', messages: [
        { role: 'system', content: 'system' }, { role: 'user', content: 'draft' }] }
      const steps: { stepId: string; chapterNumber: number; kind: string; slot: number; invocationNonce: string; input: unknown }[] = []
      const finished = new Map<string, string>(), receipts = new Map<string, unknown>(), commitDraft = vi.fn()
      const materials = { outlineTask, baseDraftTask, writingLanguage: 'zh-CN', targetUnits: 100, writingSkill: null,
        previousEnding: '', systemPrompt: 'system', promptMaterial: { chapterInfo: { chapterNumber: 1, title: 'one', role: 'development',
          purpose: '', characters: [], keyEvents: '', suspenseHook: '', userGuidance: '' }, globalGuidance: '', writingStyle: '',
        novelConfigFacts: '{}', chapterMaterials: '' } }
      const repository = {
        get: () => ({ recipe: { intent: { range: { startChapter: 1, endChapter: 1 } } } }), assertActive: vi.fn(),
        readSteps: () => steps,
        bindStep: (_ref: unknown, input: { chapterNumber: number; kind: string; slot: number; input: unknown }) => {
          const step = { ...input, stepId: `step-${steps.length}`, invocationNonce: `nonce-${steps.length}` }
          steps.push(step); return step
        },
        acknowledgeFromReceipt: (_ref: unknown, stepId: string) => {
          const attemptId = finished.get(stepId)
          return attemptId ? { receiptAttemptId: attemptId } : null
        },
        withEffectCommit: (_ref: unknown, _stepId: string, commit: () => unknown) => commit(),
      }
      const owner = { executeWorkflowDriver: async ({ invocationNonce }: { invocationNonce: string }) => {
        const step = steps.find(item => item.invocationNonce === invocationNonce)!, attemptId = `attempt-${step.stepId}`
        const text = step.kind === 'outline' ? 'outline' : step.kind === 'draft' ? '文'.repeat(150) : ''
        receipts.set(attemptId, { failureCode: step.kind === 'condense' ? failureCode : undefined,
          result: { finishReason: step.kind === 'condense' ? null : 'stop' },
          artifact: { artifactId: `artifact-${step.kind}`, text } })
        finished.set(step.stepId, attemptId)
      }, whenPhysicalIdle: async () => {}, read: () => ({}), assertSourcesCurrent: vi.fn(), composeVisible: vi.fn(), commitDraft }
      const options = { database: { transaction: (fn: () => void) => ({ immediate: fn }) }, repository, owner,
        runs: { get: () => ({ binding: { fingerprint: { modelLeaseRevision: 'model', policyHash: 'policy' }, sourceManifest: { modelReceipt: {} } } }),
          findInvocation: () => null, receipt: (id: string) => receipts.get(id) },
        ref: { taskId: 'task', revision: 1, batchRunId: 'root' }, assertActive: vi.fn(),
        openDraft: async () => ({ handle, materials }), openReview: async () => { throw new Error('REVIEW_REACHED') },
        withKnowledge: async (_handle: unknown, operation: () => unknown) => operation(),
      } as unknown as WorkflowBatchEngineOptions
      const expected = failureCode === 'OTHER_FAILURE' ? 'WORKFLOW_BATCH_DRAFT_INCOMPLETE' : 'REVIEW_REACHED'
      await expect(runWorkflowBatch(options)).rejects.toThrow(expected)
      expect(commitDraft).toHaveBeenCalledTimes(failureCode === 'OTHER_FAILURE' ? 0 : 1)
      const condense = steps.find(step => step.kind === 'condense')!.input as { task: { messages: { role: string; content: string }[] } }
      expect(condense.task.messages.filter(message => message.role === 'system')).toEqual([{ role: 'system', content: 'system' }])
      expect(condense.task.messages.find(message => message.role === 'user')!.content)
        .toContain(draftShortOutlineBlock('zh-CN', 'outline'))
    },
  )
})

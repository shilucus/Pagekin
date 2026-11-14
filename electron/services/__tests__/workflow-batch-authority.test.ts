import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'
import type { StartWorkflowBatchRequest, WorkflowBatchReceipt } from '../../../src/shared/workflow-batch-contract'
import type { WorkflowBatchEffect, WorkflowBatchStep, WorkflowBatchTask } from '../../repositories/workflow-batch-repository'
import { textHash } from '../../repositories/generation-run-repository'
import type { ProjectRuntime } from '../project-runtime'
import type { WorkflowBatchEngineOptions } from '../workflow-batch-engine'
import type { WorkflowBatchAuthorityOptions, WorkflowBatchSubject } from '../workflow-batch-authority'

type ReadAttempt = { receipt: { run: { runId: string }; attempt: { attemptId: string;
  status: WorkflowBatchReceipt['attempts'][number]['status'] }; artifact: { artifactId: string } | null } }

const fixture = vi.hoisted(() => ({ task: null as WorkflowBatchTask | null,
  steps: [] as WorkflowBatchStep[], effects: [] as WorkflowBatchEffect[], history: false,
  transaction: false, occupied: false, missingChapter: false, commitFailure: false, revision: 1, modelHash: 'a'.repeat(64),
  failGet: false, failPause: false, failBlock: false,
  runs: new Map<string, { rootActionId: string; binding: { projectId: string; epoch: string;
    fingerprint: { modelLeaseRevision: string }; sourceManifest: Record<string, unknown> } }>(),
  engine: vi.fn<(options: WorkflowBatchEngineOptions) => Promise<void>>(),
  views: new Map<string, ReadAttempt[]>(), rowsByRun: new Map<string, unknown[]>(),
  assertDispatch: vi.fn(), frozenCoverage: vi.fn(), runsGet: vi.fn(), issue: vi.fn(), rows: [] as unknown[],
}))
vi.mock('../portable-runtime-freeze', () => ({ readPortableRuntimeFreeze: () => ({ isFrozen: () => fixture.history }) }))
vi.mock('../../migrations/ordinary-review-history', () => ({
  assertOrdinaryHistoryFreezeCoverage: (...args: unknown[]) => fixture.frozenCoverage(...args),
  readVerifiedOrdinaryHistory: () => ({ taskIds: fixture.history && fixture.task ? [fixture.task.taskId] : [], cycleIds: [] }),
  parseOrdinarySemanticHistory: (value: unknown) => value,
  readOrdinaryReviewHistoryReport: vi.fn(),
}))
vi.mock('../generation-source-binding', () => ({ generationModelReceiptHash: (receipt: { modelRevision: string }) => receipt.modelRevision }))
vi.mock('../workflow-batch-engine', () => ({ runWorkflowBatch: (options: WorkflowBatchEngineOptions) => fixture.engine(options) }))
vi.mock('../generation-draft-effects', () => ({ GenerationDraftEffects: class {
  readRecovery() { return { kind: 'absent' } }
} }))
vi.mock('../workflow-batch-materials', () => ({
  readWorkflowBatchChapter: ({ chapterNumber, targetUnits }: { chapterNumber: number; targetUnits: number }) => {
    if (fixture.missingChapter) throw new Error('GENERATION_DRAFT_BLUEPRINT_MISSING')
    return { core: { writingLanguage: 'en-US' }, authorInputs: [
      { id: 'draft:chapter-info', text: JSON.stringify({ chapterNumber }) },
      { id: 'draft:author-config', text: '{"writingLanguage":"en-US"}' },
      { id: 'draft:target-units', text: String(targetUnits) },
    ] }
  },
  prepareWorkflowBatchMaterials: vi.fn(), readWorkflowReviewAssets: vi.fn(),
}))
vi.mock('../../repositories/generation-run-repository', async importOriginal => {
  const original = await importOriginal<typeof import('../../repositories/generation-run-repository')>()
  return { ...original, GenerationRunRepository: class {
    get(id: string) { fixture.runsGet(id); const run = fixture.runs.get(id); if (!run) throw new Error('RUN_MISSING'); return run }
    readRunView(runId: string) { return { attempts: fixture.views.get(runId) ?? [] } }
    budget() { return { root: { status: 'active' } } }
  } }
})
vi.mock('../../repositories/workflow-batch-repository', () => ({ WorkflowBatchRepository: class {
  get() { if (fixture.failGet) throw new Error('FICTIONAL_GET_FAILED'); return fixture.task }
  getByOperation(key: string) { return fixture.task?.operationKey === key ? fixture.task : null }
  readSteps() { return fixture.steps }
  readEffects() { return fixture.effects }
  issue(input: { taskId: string; operationKey: string; requestHash: string; batchRunId: string;
    recipe: WorkflowBatchTask['recipe']; reviewModelId: string; reviewModelHash: string }) {
    if (!fixture.transaction) throw new Error('NATIVE_TRANSACTION_REQUIRED')
    fixture.issue(input)
    fixture.task = { ...input, projectId: 'project', template: 'prepared-batch-review-v2', revision: 1,
      state: 'ready', blockedCode: null, recipeHash: 'b'.repeat(64), createdAt: 1, updatedAt: 1 }
    return fixture.task
  }
  assertActive(ref: { revision: number }) {
    if (!fixture.transaction || !fixture.task || fixture.task.state !== 'ready' || ref.revision !== fixture.task.revision) throw new Error('INACTIVE')
    return fixture.task
  }
  assertDispatch(...args: unknown[]) { fixture.assertDispatch(...args) }
  acknowledgeFromReceipt() { return null }
  pause() { if (fixture.failPause) throw new Error('FICTIONAL_PAUSE_FAILED'); return this.change('paused') }
  cancel() { return this.change('cancelled') }
  resume() { return this.change('ready') }
  block(_ref: unknown, code: string) { if (fixture.failBlock) throw new Error('FICTIONAL_BLOCK_FAILED'); const task = this.change('blocked'); task.blockedCode = code; return task }
  change(state: WorkflowBatchTask['state']) {
    if (!fixture.task) throw new Error('MISSING')
    fixture.task = { ...fixture.task, state, revision: ++fixture.revision, blockedCode: null }
    return fixture.task
  }
} }))
import { WorkflowBatchAuthority, readWorkflowBatchReceipt } from '../workflow-batch-authority'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve() }
function subject() {
  let destroyed = false
  let listener = () => {}
  return { isDestroyed: () => destroyed, once: (_event: 'destroyed', value: () => void) => { listener = value },
    destroy: () => { destroyed = true; listener() } } satisfies WorkflowBatchSubject & { destroy(): void }
}
const request: StartWorkflowBatchRequest = { operationKey: '11111111-1111-4111-8111-111111111111',
  modelId: 'draft-model', reviewModelId: 'review-model', uiLocale: 'en-US',
  intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 100 }, authorInputs: [] }

function setup() {
  const engine = deferred(), physical = deferred()
  fixture.engine.mockReturnValue(engine.promise)
  let hooks!: Parameters<WorkflowBatchAuthorityOptions['createOwner']>[0]
  const release = vi.fn(), acquireWork = vi.fn(() => release), assertFresh = vi.fn()
  const database = { open: true, get inTransaction() { return fixture.transaction },
    prepare: () => ({ get: () => fixture.occupied ? { id: 1 } : undefined,
      all: (runId: string) => fixture.rowsByRun.get(runId) ?? fixture.rows }),
    transaction: (operation: () => unknown) => ({ immediate: () => {
      const task = fixture.task, runs = new Map(fixture.runs)
      fixture.transaction = true
      try {
        const result = operation()
        if (fixture.commitFailure) throw new Error('COMMIT_FAILED')
        return result
      } catch (error) {
        fixture.task = task; fixture.runs.clear()
        for (const [id, run] of runs) fixture.runs.set(id, run)
        throw error
      } finally { fixture.transaction = false }
    } }) }
  const runtime = { projectId: 'project', canonicalRoot: 'isolated-fiction', projectStorageRoot: 'isolated-storage',
    executionEpoch: 'epoch', database } as unknown as ProjectRuntime
  const owner = {
    beginWorkflowBatchRoot: vi.fn((input: { modelId: string; authorInputs: unknown[] }) => {
      expect(fixture.transaction).toBe(true)
      const handle: MainGenerationRunHandle = { projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'batch' }
      fixture.runs.set('batch', { rootActionId: 'root', binding: { projectId: 'project', epoch: 'epoch',
        fingerprint: { modelLeaseRevision: fixture.modelHash }, sourceManifest: { modelReceipt: { modelId: input.modelId }, authorInputs: input.authorInputs } } })
      return { handle }
    }),
    rollbackWorkflowDriverPreparation: vi.fn(), pauseWorkflowDriver: vi.fn(), hasPhysicalInFlight: vi.fn(() => false),
    whenPhysicalIdle: vi.fn(() => physical.promise), requestProjectClose: vi.fn(), suspendForProjectClose: vi.fn(),
    assertCleanupQuiescent: vi.fn(), assertRetirable: vi.fn(() => hooks.assertNoRuntimeClaims()), retireIdle: vi.fn(() => hooks.assertNoRuntimeClaims()),
    assertWorkflowDriverRecoverySources: vi.fn(), recoverWorkflowDriverRun: vi.fn(), resume: vi.fn(),
  }
  const createOwner = vi.fn((value: Parameters<WorkflowBatchAuthorityOptions['createOwner']>[0]) => {
    hooks = value
    return owner as unknown as ReturnType<WorkflowBatchAuthorityOptions['createOwner']>
  })
  const options: WorkflowBatchAuthorityOptions = { runtime, globalDataRoot: 'isolated-global',
    assertAdmission: vi.fn(), assertCapturedResources: vi.fn(), acquireWork,
    readSafeModelReceipt: vi.fn(() => ({ modelRevision: fixture.modelHash } as ReturnType<WorkflowBatchAuthorityOptions['readSafeModelReceipt']>)),
    captureKnowledge: vi.fn(), withKnowledge: async (_handle, operation) => operation(),
    withPreparedKnowledge: async (_preparation, _chapter, operation) => operation(), createOwner }
  const authority = new WorkflowBatchAuthority(options), caller = subject()
  return { authority, caller, runtime, owner, options, createOwner, acquireWork, release, engine, physical, assertFresh,
    hooks: () => hooks, finish: async () => { engine.resolve(); physical.resolve(); await flush() } }
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.task = null; fixture.steps = []; fixture.effects = []; fixture.history = false
  fixture.transaction = false; fixture.occupied = false; fixture.missingChapter = false; fixture.revision = 1
  fixture.commitFailure = false
  fixture.failGet = false; fixture.failPause = false; fixture.failBlock = false
  fixture.modelHash = 'a'.repeat(64); fixture.runs.clear(); fixture.rows = []; fixture.views.clear(); fixture.rowsByRun.clear()
})

describe('workflow batch private authority', () => {
  it('captures actual root inputs and freezes both asset stages inside native root issuance', async () => {
    const test = setup()
    const result = await test.authority.start(test.caller, request, test.assertFresh)
    expect(test.owner.beginWorkflowBatchRoot).toHaveBeenCalledWith(expect.objectContaining({
      authorInputs: [{ id: 'draft:author-config', text: '{"writingLanguage":"en-US"}' }, { id: 'draft:target-units', text: '100' }],
      promptKeys: ['first_chapter_draft', 'next_chapter_draft', 'consistency_check'], skillStages: ['drafting', 'review'],
    }))
    expect(result.reference?.revision).toBe(1)
    expect(test.acquireWork).toHaveBeenCalledTimes(1)
    expect(test.release).not.toHaveBeenCalled()
    await test.finish()
    expect(test.release).toHaveBeenCalledTimes(1)
  })
  it('rejects author assertions that the actual prompt inputs do not consume', async () => {
    const test = setup()
    await expect(test.authority.start(test.caller, { ...request,
      authorInputs: [{ id: 'draft:target-units', text: '101' }] }, test.assertFresh)).rejects.toThrow('WORKFLOW_BATCH_AUTHOR_INPUT_INVALID')
    expect(test.owner.beginWorkflowBatchRoot).not.toHaveBeenCalled()
    expect(fixture.issue).not.toHaveBeenCalled()
  })
  it('rolls back only its newly prepared lease and never publishes a capability after COMMIT failure', async () => {
    const test = setup()
    fixture.commitFailure = true
    await expect(test.authority.start(test.caller, request, test.assertFresh)).rejects.toThrow('COMMIT_FAILED')
    expect(test.owner.rollbackWorkflowDriverPreparation).toHaveBeenCalledExactlyOnceWith({
      projectId: 'project', epoch: 'epoch', rootActionId: 'root', runId: 'batch',
    })
    expect(test.authority.hasIssuance()).toBe(false)
    expect(test.acquireWork).toHaveBeenCalledTimes(1)
    expect(test.release).toHaveBeenCalledTimes(1)
    expect(fixture.task).toBeNull()
  })
  it('refuses occupied or unplanned targets before creating a real root', async () => {
    const test = setup()
    fixture.occupied = true
    await expect(test.authority.start(test.caller, request, test.assertFresh)).rejects.toThrow('WORKFLOW_BATCH_TARGET_NOT_EMPTY')
    fixture.occupied = false; fixture.missingChapter = true
    await expect(test.authority.start(test.caller, request, test.assertFresh)).rejects.toThrow('GENERATION_DRAFT_BLUEPRINT_MISSING')
    expect(test.owner.beginWorkflowBatchRoot).not.toHaveBeenCalled()
  })
  it('binds control to the actual sender while tolerating old read-only revisions', async () => {
    const test = setup(), result = await test.authority.start(test.caller, request, test.assertFresh)
    const reference = result.reference!
    expect(() => test.authority.readReceipt(subject(), reference)).toThrow('WORKFLOW_BATCH_CAPABILITY_REQUIRED')
    const paused = test.authority.pause(test.caller, reference)
    expect(paused.reference?.revision).toBe(2)
    expect(test.authority.readReceipt(test.caller, reference).task.state).toBe('paused')
    expect(() => test.authority.cancel(test.caller, reference)).toThrow('WORKFLOW_BATCH_REVISION_CONFLICT')
    await test.finish()
  })
  it('does not grant another sender authority through an idempotent start', async () => {
    const test = setup()
    await test.authority.start(test.caller, request, test.assertFresh)
    const duplicate = await test.authority.start(subject(), request, test.assertFresh)
    expect(duplicate.reference).toBeNull()
    expect(fixture.issue).toHaveBeenCalledTimes(1)
    await expect(test.authority.start(test.caller, { ...request, reviewModelId: 'different' }, test.assertFresh))
      .rejects.toThrow('WORKFLOW_BATCH_IDEMPOTENCY_CONFLICT')
    await test.finish()
  })
  it('admits only the exact persisted role run and model step to physical dispatch', async () => {
    const test = setup()
    await test.authority.start(test.caller, request, test.assertFresh)
    const task = { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [{ role: 'user', content: 'fiction' }] } as const
    fixture.steps = [{ taskId: fixture.task!.taskId, stepId: 'step', commandId: 'command', chapterNumber: 1,
      role: 'draft', kind: 'outline', slot: 0, runId: 'child', invocationNonce: 'nonce', inputHash: 'b'.repeat(64),
      input: { kind: 'model', task: { ...task, messages: [...task.messages] } } }]
    const dispatch = test.hooks().workflowDriver.assertDispatchAdmission
    expect(() => dispatch('batch', 'nonce', fixture.steps[0].input.kind === 'model' ? fixture.steps[0].input.task : neverInput())).toThrow('WORKFLOW_BATCH_DISPATCH_MISMATCH')
    expect(() => test.hooks().workflowDriver.assertActive('foreign')).toThrow('WORKFLOW_BATCH_CAPABILITY_REQUIRED')
    fixture.transaction = true
    try { dispatch('child', 'nonce', fixture.steps[0].input.kind === 'model' ? fixture.steps[0].input.task : neverInput()) }
    finally { fixture.transaction = false }
    expect(fixture.assertDispatch).toHaveBeenCalledWith(expect.objectContaining({ batchRunId: 'batch' }), 'step', 'nonce', expect.any(Object))
    fixture.steps = []
    await test.finish()
  })
  it('keeps the work claim until engine and physical finally both drain after sender destruction', async () => {
    const test = setup()
    await test.authority.start(test.caller, request, test.assertFresh)
    test.caller.destroy()
    expect(fixture.task?.state).toBe('paused')
    expect(test.owner.pauseWorkflowDriver).toHaveBeenCalledTimes(1)
    test.engine.resolve(); await flush()
    expect(test.authority.hasPhysicalInFlight()).toBe(true)
    expect(test.release).not.toHaveBeenCalled()
    expect(() => test.authority.assertRetirable()).toThrow('WORKFLOW_BATCH_OWNER_BUSY')
    test.physical.resolve(); await flush()
    expect(test.release).toHaveBeenCalledTimes(1)
    expect(test.authority.hasPhysicalInFlight()).toBe(false)
  })
  it('blocks and retains the diagnostic rather than rewriting an engine failure as paused', async () => {
    const test = setup()
    fixture.engine.mockRejectedValueOnce(new Error('WORKFLOW_BATCH_ATTEMPT_UNRESOLVED'))
    const result = await test.authority.start(test.caller, request, test.assertFresh)
    await flush()
    expect(fixture.task?.state).toBe('blocked')
    expect(fixture.task?.blockedCode).toBe('WORKFLOW_BATCH_ATTEMPT_UNRESOLVED')
    expect(test.authority.readReceipt(test.caller, result.reference!).task.blockedCode).toBe('WORKFLOW_BATCH_ATTEMPT_UNRESOLVED')
    test.physical.resolve(); await flush()
  })
  it('closes admission immediately and leaves ignored abort work owned until physical idle', async () => {
    const test = setup()
    await test.authority.start(test.caller, request, test.assertFresh)
    test.authority.requestProjectClose()
    expect(test.owner.requestProjectClose).toHaveBeenCalledTimes(1)
    await expect(test.authority.start(test.caller, { ...request, operationKey: '22222222-2222-4222-8222-222222222222' }, test.assertFresh))
      .rejects.toThrow('WORKFLOW_BATCH_OWNER_CLOSING')
    expect(test.authority.hasPhysicalInFlight()).toBe(true)
    await test.finish()
  })
  it('acquires work before creating the durable root, leaving no issuance when acquisition fails', async () => {
    const test = setup()
    test.acquireWork.mockImplementationOnce(() => { throw new Error('FICTIONAL_ACQUIRE_FAILED') })
    await expect(test.authority.start(test.caller, request, test.assertFresh)).rejects.toThrow('FICTIONAL_ACQUIRE_FAILED')
    expect(test.owner.beginWorkflowBatchRoot).not.toHaveBeenCalled()
    expect(fixture.issue).not.toHaveBeenCalled()
    expect(test.authority.hasIssuance()).toBe(false)
    expect(test.release).not.toHaveBeenCalled()
  })
  it('retains failed transaction rollback work for true-close cleanup retry', async () => {
    const test = setup()
    fixture.commitFailure = true
    test.owner.rollbackWorkflowDriverPreparation.mockImplementationOnce(() => { throw new Error('FICTIONAL_ROLLBACK_FAILED') })
    await expect(test.authority.start(test.caller, request, test.assertFresh)).rejects.toThrow()
    expect(test.release).not.toHaveBeenCalled()
    expect(test.authority.hasPhysicalInFlight()).toBe(true)
    fixture.commitFailure = false
    test.authority.requestProjectClose()
    await flush()
    expect(test.owner.rollbackWorkflowDriverPreparation).toHaveBeenCalledTimes(2)
    expect(test.release).toHaveBeenCalledTimes(1)
    expect(test.authority.hasPhysicalInFlight()).toBe(false)
  })
  it('retains pause persistence failure until a current authorized cleanup-only retry', async () => {
    const test = setup(), result = await test.authority.start(test.caller, request, test.assertFresh)
    fixture.failPause = true
    expect(() => test.authority.pause(test.caller, result.reference!)).toThrow()
    test.engine.resolve(); test.physical.resolve(); await flush()
    expect(test.release).not.toHaveBeenCalled()
    expect(test.authority.hasPhysicalInFlight()).toBe(true)
    expect(() => test.authority.pause(subject(), result.reference!)).toThrow('WORKFLOW_BATCH_CAPABILITY_REQUIRED')
    expect(() => test.authority.pause(test.caller, { ...result.reference!, revision: 999 })).toThrow('WORKFLOW_BATCH_REVISION_CONFLICT')
    expect(() => test.authority.pause(test.caller, result.reference!)).toThrow()
    fixture.failPause = false
    expect(test.authority.pause(test.caller, result.reference!).receipt.task.state).toBe('paused')
    await flush()
    expect(test.release).toHaveBeenCalledTimes(1)
    expect(test.owner.resume).not.toHaveBeenCalled()
    expect(fixture.engine).toHaveBeenCalledTimes(1)
  })
  it('revokes execution even when both task and root pause fail', async () => {
    const test = setup(), result = await test.authority.start(test.caller, request, test.assertFresh)
    fixture.failPause = true
    test.owner.pauseWorkflowDriver.mockImplementationOnce(() => { throw new Error('FICTIONAL_ROOT_FAILED') })
    expect(() => test.authority.pause(test.caller, result.reference!)).toThrow()
    expect(() => test.hooks().workflowDriver.assertActive('batch')).toThrow('WORKFLOW_BATCH_CAPABILITY_REQUIRED')
    expect(test.release).not.toHaveBeenCalled()
    test.engine.resolve(); test.physical.resolve(); await flush()
    fixture.failPause = false
    test.authority.pause(test.caller, result.reference!)
    expect(test.release).toHaveBeenCalledTimes(1)
  })
  it('retains cancelled intent when root cancellation persistence fails and never downgrades it', async () => {
    const test = setup(), result = await test.authority.start(test.caller, request, test.assertFresh)
    test.owner.pauseWorkflowDriver.mockImplementationOnce(() => { throw new Error('FICTIONAL_ROOT_FAILED') })
    expect(() => test.authority.cancel(test.caller, result.reference!)).toThrow()
    expect(fixture.task?.state).toBe('cancelled')
    test.engine.resolve(); test.physical.resolve(); await flush()
    expect(test.release).not.toHaveBeenCalled()
    const reference = { ...result.reference!, revision: fixture.task!.revision }
    test.authority.cancel(test.caller, reference)
    await flush()
    expect(fixture.task?.state).toBe('cancelled')
    expect(test.owner.pauseWorkflowDriver).toHaveBeenLastCalledWith(expect.anything(), true)
    expect(test.release).toHaveBeenCalledTimes(1)
  })
  it('upgrades failed pause cleanup to cancellation without later pause downgrading it', async () => {
    const test = setup(), result = await test.authority.start(test.caller, request, test.assertFresh)
    test.owner.pauseWorkflowDriver.mockImplementationOnce(() => { throw new Error('FICTIONAL_ROOT_FAILED') })
    expect(() => test.authority.pause(test.caller, result.reference!)).toThrow()
    expect(fixture.task?.state).toBe('paused')
    test.engine.resolve(); test.physical.resolve(); await flush()
    test.owner.pauseWorkflowDriver.mockImplementationOnce(() => { throw new Error('FICTIONAL_CANCEL_ROOT_FAILED') })
    expect(() => test.authority.cancel(test.caller, { ...result.reference!, revision: fixture.task!.revision })).toThrow()
    expect(fixture.task?.state).toBe('cancelled')
    test.authority.pause(test.caller, { ...result.reference!, revision: fixture.task!.revision })
    expect(test.owner.pauseWorkflowDriver).toHaveBeenLastCalledWith(expect.anything(), true)
    expect(fixture.task?.state).toBe('cancelled')
    expect(test.release).toHaveBeenCalledTimes(1)
  })
  it('retains work while full cleanup quiescence fails after physical idle', async () => {
    const test = setup(), result = await test.authority.start(test.caller, request, test.assertFresh)
    const paused = test.authority.pause(test.caller, result.reference!)
    test.owner.assertCleanupQuiescent.mockImplementation(() => { throw new Error('FICTIONAL_SERVICE_BUSY') })
    test.engine.resolve(); test.physical.resolve(); await flush()
    expect(test.release).not.toHaveBeenCalled()
    expect(() => test.authority.pause(test.caller, paused.reference!)).toThrow('FICTIONAL_SERVICE_BUSY')
    expect(test.authority.hasPhysicalInFlight()).toBe(true)
    test.owner.assertCleanupQuiescent.mockImplementation(() => {})
    test.authority.pause(test.caller, paused.reference!)
    expect(test.release).toHaveBeenCalledTimes(1)
  })
  it('retains an unknown engine block persistence failure without redispatch', async () => {
    const test = setup()
    fixture.failBlock = true
    fixture.engine.mockRejectedValueOnce(new Error('WORKFLOW_BATCH_ATTEMPT_UNRESOLVED'))
    const result = await test.authority.start(test.caller, request, test.assertFresh)
    test.physical.resolve(); await flush()
    expect(test.release).not.toHaveBeenCalled()
    expect(test.authority.hasPhysicalInFlight()).toBe(true)
    fixture.failBlock = false
    test.authority.pause(test.caller, result.reference!)
    await flush()
    expect(fixture.task?.state).toBe('blocked')
    expect(fixture.task?.blockedCode).toBe('WORKFLOW_BATCH_ATTEMPT_UNRESOLVED')
    expect(test.owner.resume).not.toHaveBeenCalled()
    expect(fixture.engine).toHaveBeenCalledTimes(1)
    expect(test.release).toHaveBeenCalledTimes(1)
  })
  it('retains destroyed sender cleanup failure and retries via true close', async () => {
    const test = setup()
    await test.authority.start(test.caller, request, test.assertFresh)
    fixture.failPause = true
    test.caller.destroy()
    test.engine.resolve(); test.physical.resolve(); await flush()
    expect(test.release).not.toHaveBeenCalled()
    expect(() => test.authority.requestProjectClose()).toThrow()
    fixture.failPause = false
    test.authority.requestProjectClose()
    await flush()
    expect(fixture.task?.state).toBe('paused')
    expect(test.release).toHaveBeenCalledTimes(1)
  })
  it('retains failed final read, physical drain failure and nonphysical work until explicit retry', async () => {
    const test = setup(), result = await test.authority.start(test.caller, request, test.assertFresh)
    const paused = test.authority.pause(test.caller, result.reference!)
    test.owner.whenPhysicalIdle.mockRejectedValueOnce(new Error('FICTIONAL_DRAIN_FAILED'))
    test.engine.resolve(); await flush()
    expect(test.release).not.toHaveBeenCalled()
    expect(test.authority.hasPhysicalInFlight()).toBe(true)
    test.physical.resolve()
    test.owner.hasPhysicalInFlight.mockReturnValue(true)
    expect(() => test.authority.pause(test.caller, paused.reference!)).toThrow()
    await flush()
    expect(test.release).not.toHaveBeenCalled()
    test.owner.hasPhysicalInFlight.mockReturnValue(false)
    fixture.failGet = true
    expect(() => test.authority.pause(test.caller, paused.reference!)).toThrow()
    expect(test.release).not.toHaveBeenCalled()
    fixture.failGet = false
    test.authority.pause(test.caller, paused.reference!)
    await flush()
    expect(test.release).toHaveBeenCalledTimes(1)
    test.authority.pause(test.caller, paused.reference!)
    expect(test.release).toHaveBeenCalledTimes(1)
  })
  it('reads a frozen partial history without creating an owner or hydrating excluded run bindings', async () => {
    const test = setup()
    await test.authority.start(test.caller, request, test.assertFresh)
    await test.finish()
    fixture.history = true; fixture.runsGet.mockClear()
    const receipt = readWorkflowBatchReceipt(test.runtime, fixture.task!.taskId, test.options.assertCapturedResources)
    expect(receipt.nonReplayable).toBe(true)
    expect(receipt.historicalArtifacts).toEqual([])
    expect(fixture.runsGet).not.toHaveBeenCalled()
    expect(test.createOwner).toHaveBeenCalledTimes(1)
    const restored = await test.authority.reauthorize(subject(), fixture.task!.taskId, test.assertFresh)
    expect(restored.reference).toBeNull()
    expect(test.owner.recoverWorkflowDriverRun).not.toHaveBeenCalled()
  })
  it('projects each shared-root attempt under its actual run exactly once, identically to historical run-filtered reads', async () => {
    const test = setup()
    await test.authority.start(test.caller, request, test.assertFresh)
    await test.finish()
    const step = (runId: string, chapterNumber: number, role: 'draft' | 'review'): WorkflowBatchStep => ({
      taskId: fixture.task!.taskId, stepId: `step-${runId}`, commandId: `command-${runId}`, chapterNumber,
      role, kind: role === 'draft' ? 'outline' : 'review', slot: 0, runId, invocationNonce: `nonce-${runId}`,
      inputHash: 'b'.repeat(64), input: { kind: 'model', task: { purpose: role === 'draft' ? 'chapter-draft-short-outline' : 'review-chapter',
        output: role === 'draft' ? 'visible-text' : 'structured-data', messages: [{ role: 'user', content: 'fiction' }] } },
    })
    fixture.steps = [step('draft-one', 1, 'draft'), step('draft-two', 2, 'draft'), step('review-one', 1, 'review')]
    const attempt = (runId: string, attemptId: string, status: ReadAttempt['receipt']['attempt']['status'] = 'settled'): ReadAttempt => ({
      receipt: { run: { runId }, attempt: { attemptId, status }, artifact: { artifactId: `artifact-${attemptId}` } },
    })
    const sharedRoot = [attempt('draft-one', 'first'), attempt('draft-one', 'continuation'), attempt('draft-two', 'unknown', 'unknown'),
      attempt('unselected-sibling', 'foreign')]
    // readRunView exposes every attempt in the shared root budget, including when reading its batch root.
    for (const runId of ['batch', 'draft-one', 'draft-two']) fixture.views.set(runId, sharedRoot)
    fixture.views.set('review-one', [attempt('review-one', 'review')])
    const expected: WorkflowBatchReceipt['attempts'] = [
      { runId: 'draft-one', attemptId: 'first', status: 'settled', artifactId: 'artifact-first' },
      { runId: 'draft-one', attemptId: 'continuation', status: 'settled', artifactId: 'artifact-continuation' },
      { runId: 'draft-two', attemptId: 'unknown', status: 'unknown', artifactId: 'artifact-unknown' },
      { runId: 'review-one', attemptId: 'review', status: 'settled', artifactId: 'artifact-review' },
    ]
    const live = readWorkflowBatchReceipt(test.runtime, fixture.task!.taskId, test.options.assertCapturedResources)
    expect(live.attempts).toEqual(expected)
    expect(new Set(live.attempts.map(value => value.attemptId)).size).toBe(expected.length)
    fixture.history = true
    for (const runId of ['batch', 'draft-one', 'draft-two', 'review-one']) fixture.rowsByRun.set(runId,
      expected.filter(value => value.runId === runId).map(value => ({ attempt_id: value.attemptId,
        attempt_json: JSON.stringify({ status: value.status }), artifact_id: value.artifactId, revision: 1,
        artifact_json: JSON.stringify({ text: value.attemptId, textHash: textHash(value.attemptId) }) })))
    const historical = readWorkflowBatchReceipt(test.runtime, fixture.task!.taskId, test.options.assertCapturedResources)
    expect(historical.attempts).toEqual(expected)
    expect(historical.attempts).toEqual(live.attempts)
  })
})

function neverInput(): never { throw new Error('invalid fixture') }

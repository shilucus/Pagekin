import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import type { ProjectRuntime } from '../project-runtime'
import { executeReferenceGlobal, ReferenceGlobalFailure } from '../reference-global-driver'
import { importGenerationFixture } from './import-generation-fixture'
import { getCurrentProjectPath } from '../../database'
import { EmbeddingDispatchBarrierError } from '../reference-embedding-dispatch-contract'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(),
  getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })

function options(f: ReturnType<typeof importGenerationFixture>, handle: MainGenerationRunHandle,
  execution: { owner: string; epoch: number }) {
  const root = getCurrentProjectPath()!
  const runtime = { database: f.db, projectId: handle.projectId, projectPath: root, projectStorageRoot: root,
    canonicalRoot: root, executionEpoch: handle.epoch, databaseIdentity: {}, phase: 'open' } as ProjectRuntime
  const events: string[] = []
  const hooks: Parameters<typeof executeReferenceGlobal>[0]['hooks'] = {
    opened: async () => { events.push('opened') }, committed: () => { events.push('committed') },
    log: value => { events.push(`log:${value.key}`) }, progress: value => { events.push(`progress:${value}`) },
    candidate: () => { events.push('candidate') }, promptBudget: () => {}, failureMessage: (code: string) => code,
  }
  const value = {
    runtime, owner: f.owner, viewEpoch: handle.epoch,
    request: { runId: '长篇导入', execution, modelId: 'synthetic' }, signal: new AbortController().signal,
    assertCurrent: () => {}, hooks, events,
  }
  return value
}

function validInference() {
  const card = (name: string, role: 'protagonist' | 'supporting' | 'antagonist') => ({
    name, role, gender: '未知', age: 18, appearance: '外貌明确', personality: '性格明确', background: '背景明确',
    abilities: '能力明确', motivation: '动机明确', relationships: [], arc: '角色弧光', notes: '待确认',
    currentState: { location: '城中', powerLevel: '普通', physicalState: '正常', mentalState: '警觉', keyItems: '无', recentEvents: '启程', updatedAtChapter: 1 },
  })
  return JSON.stringify({
    novelConfig: { genre: '现实', subGenre: '讽刺', targetAudience: '通用', plotStructure: 'three_act', narrativePOV: 'third_limited',
      coreOutline: '主角在冲突中逐步认识世界。', worldSetting: '现实社会。', goldenFinger: '无。', protagonistProfile: '敏感而倔强。', globalGuidance: '保持克制叙事。' },
    architectureFiles: { premise: '个人与环境持续冲突。', worldbuilding: '现实社会结构。', synopsis: '主角经历挫折并作出选择。' },
    characterCards: [card('陆舟', 'protagonist'), card('苏绾', 'supporting'), card('顾岩', 'antagonist')],
  })
}

async function started(f: ReturnType<typeof importGenerationFixture>) {
  const execution = ImportRunRepository.startOrResume('长篇导入', '导入全局事实测试').execution
  const handle = f.owner.begin({ operation: 'import-global-facts', uiActionNonce: 'global:长篇导入', modelId: 'synthetic',
    selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'],
    skillStages: ['planning'], authorInputs: [], output: 'structured-data',
    importSlot: { runId: '长篇导入', stage: 'global', batchId: 'done' }, importExecution: { owner: execution.owner, epoch: execution.epoch },
  } as BeginGenerationRequest).handle
  return { execution, handle }
}

describe('reference global driver', () => {
  it('waits for opened readiness before retrieval and commits the decoded global effect', async () => {
    const f = importGenerationFixture(cleanup, 2)
    const { execution, handle } = await started(f)
    const invoke = options(f, handle, { owner: execution.owner, epoch: execution.epoch })
    const materials = vi.spyOn(f.owner, 'prepareImportQueryMaterials').mockImplementation(async () => {
      invoke.events.push('query')
      return { version: 1, run: {} as never, topics: (['worldview', 'protagonist', 'conflict', 'style'] as const).map(key => ({ key, results: [] })) }
    })
    f.current.dispatch = async (_request, dispatchOptions) => {
      dispatchOptions.onVisible({ kind: 'delta', text: validInference() })
      return { finishReason: 'stop', usage: null }
    }
    const result = await executeReferenceGlobal(invoke)

    expect(invoke.events.indexOf('opened')).toBeLessThan(invoke.events.indexOf('query'))
    expect(materials).toHaveBeenCalledTimes(1)
    expect(result.receipt.state).toBe('committed')
    expect(result.run.stage).toBe('style')
    expect(invoke.events).toContain('committed')
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts WHERE invocation_nonce=?').pluck().get('import:0')).toBe(1)
    const savedLog = invoke.events.find(event => event === 'log:saved-proposals' || event === 'log:saved-roster')
    expect(savedLog).toBeDefined()
    expect(invoke.events.filter(event => event.startsWith('progress:') || event === 'log:calling-ai'
      || event === 'log:parsing' || event === 'candidate' || event === 'committed' || event === savedLog)).toEqual([
      'progress:5', 'progress:20', 'log:calling-ai', 'progress:25', 'progress:10', 'progress:90',
      'candidate', 'progress:70', 'log:parsing', 'committed', savedLog, 'progress:90', 'progress:100',
    ])
  })

  it('treats query admission failure as a hard barrier and never dispatches inference', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { execution, handle } = await started(f)
    const invoke = options(f, handle, { owner: execution.owner, epoch: execution.epoch })
    vi.spyOn(f.owner, 'prepareImportQueryMaterials').mockRejectedValue(new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_REQUIRED'))

    let failure: unknown
    try { await executeReferenceGlobal(invoke) } catch (error) { failure = error }

    expect(failure).toBeInstanceOf(ReferenceGlobalFailure)
    expect(failure).toMatchObject({ errorCode: 'GENERATION_IMPORT_QUERY_REQUIRED' })
    expect(f.spy).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT status FROM import_runs WHERE id=?').get('长篇导入')).toMatchObject({ status: 'failed' })
    expect(invoke.events.filter(event => event.startsWith('progress:') || event === 'log:retrieving'
      || event === 'log:calling-ai')).toEqual(['log:retrieving', 'progress:5'])
  })

  it('keeps an explicit query cancellation barrier classified as cancellation', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { execution, handle } = await started(f)
    const invoke = options(f, handle, { owner: execution.owner, epoch: execution.epoch })
    vi.spyOn(f.owner, 'prepareImportQueryMaterials').mockRejectedValue(new EmbeddingDispatchBarrierError('GENERATION_ACTION_CANCELLED'))

    let failure: unknown
    try { await executeReferenceGlobal(invoke) } catch (error) { failure = error }

    expect(failure).toBeInstanceOf(ReferenceGlobalFailure)
    expect(failure).toMatchObject({ errorCode: 'GENERATION_ACTION_CANCELLED' })
    expect(f.db.prepare('SELECT status FROM import_runs WHERE id=?').get('长篇导入')).toMatchObject({ status: 'cancelled' })
  })

  it('preserves bounded completion metadata and normalizes an unrelated raw error', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { execution, handle } = await started(f)
    const invoke = options(f, handle, { owner: execution.owner, epoch: execution.epoch })
    vi.spyOn(f.owner, 'prepareImportQueryMaterials').mockResolvedValue({
      version: 1, run: {} as never, topics: (['worldview', 'protagonist', 'conflict', 'style'] as const).map(key => ({ key, results: [] })),
    })
    f.current.dispatch = async () => ({ finishReason: 'length', usage: null })

    let boundedFailure: unknown
    try { await executeReferenceGlobal(invoke) } catch (error) { boundedFailure = error }

    expect(boundedFailure).toBeInstanceOf(ReferenceGlobalFailure)
    expect(boundedFailure).toMatchObject({ errorCode: 'GENERATION_REQUEST_FAILED', completionFailureCode: 'length' })
    expect((boundedFailure as ReferenceGlobalFailure).displayMessage).toBeTruthy()

    const rawFixture = importGenerationFixture(cleanup, 1)
    const rawStarted = await started(rawFixture)
    const rawInvoke = options(rawFixture, rawStarted.handle, { owner: rawStarted.execution.owner, epoch: rawStarted.execution.epoch })
    vi.spyOn(rawFixture.owner, 'prepareImportQueryMaterials').mockRejectedValue(new Error('FICTIONAL_PRIVATE_VALUE'))

    let normalizedFailure: unknown
    try { await executeReferenceGlobal(rawInvoke) } catch (error) { normalizedFailure = error }

    expect(normalizedFailure).toBeInstanceOf(ReferenceGlobalFailure)
    expect(normalizedFailure).toMatchObject({ errorCode: 'GENERATION_REQUEST_FAILED', displayMessage: 'GENERATION_REQUEST_FAILED' })
    expect((normalizedFailure as ReferenceGlobalFailure).completionFailureCode).toBeUndefined()
    expect((normalizedFailure as ReferenceGlobalFailure).displayMessage).not.toContain('FICTIONAL_PRIVATE_VALUE')
  })
})

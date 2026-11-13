import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const ipcMocks = vi.hoisted(() => ({ invoke: vi.fn(), actual: vi.fn(), revoke: vi.fn(), complete: vi.fn(), on: vi.fn() }))
const characterSyncMocks = vi.hoisted(() => ({ retry: vi.fn() }))
const commandMocks = vi.hoisted(() => ({
  blueprintContext: undefined as WorkflowContext | undefined,
  global: vi.fn(),
  style: vi.fn(),
}))
vi.mock('../../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: async (session: { projectPath: string }, channel: string, ...args: unknown[]) => {
      ipcMocks.actual(session, channel, ...args)
      if (channel === 'reference-knowledge:v1:resume') {
        const reference = args[0] as { runId: string }
        const result = await ipcMocks.invoke(session, 'db:import-run-start-resume', reference.runId, executionOwner, session.projectPath)
        return result.start
      }
      if (channel === 'reference-knowledge:v1:import') {
        const request = args[0] as { chapterNumber: number; reference: { runId: string }; execution: unknown }
        return ipcMocks.invoke(session, 'kb:import-reference-text', request.chapterNumber, request.reference.runId, request.execution)
      }
      if (channel === 'reference-knowledge:v1:complete') return ipcMocks.complete(...args)
      return ipcMocks.invoke(session, channel, ...args)
    },
    invoke: ipcMocks.revoke,
    on: ipcMocks.on,
  },
}))
vi.mock('../directory-character-sync-recovery', () => ({
  retryDirectoryCharacterSync: characterSyncMocks.retry,
}))
vi.mock('../commands/import-novel.command', () => ({
  InferGlobalSettingsCommand: class {
    constructor(_unused: unknown, private commit: (payload: unknown) => Promise<unknown>, private fillEmpty: boolean) {}
    async execute(params: { context: WorkflowContext }): Promise<void> {
      commandMocks.global(params.context, this.fillEmpty)
      await this.commit({ generated: 'global' })
    }
  },
  InferBlueprintsPerChapterCommand: class {
    async execute(params: { context: WorkflowContext }): Promise<void> {
      commandMocks.blueprintContext = params.context
      throw new Error('stop-after-blueprint-prompt-context')
    }
  },
}))
vi.mock('../commands/analyze-style.command', () => ({
  AnalyzeWritingStyleCommand: class {
    constructor(
      private options: unknown,
      _unused: unknown,
      private commit: (style: string) => Promise<string>,
    ) {}
    async execute(params: { context: WorkflowContext }): Promise<string> {
      commandMocks.style(this.options, params.context)
      return this.commit('sample style')
    }
  },
}))

import { createImportWorkflow as createActualWorkflow, estimateImportCost, loadAuthorImportChapterNumbers } from '../import-workflow'
import { ImportRunOrchestrator } from '../import-run-orchestrator'
import {
  IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
  type ImportRunEffectReceipt,
  type ImportRunSnapshot,
} from '../../../shared/import-run'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'

const session = { projectId: 'test-project', leaseId: 'lease-test-project', projectPath: 'C:\\test-project' }
const executionOwner = '00000000-0000-4000-8000-000000000001'

function createImportWorkflow(params: Parameters<typeof createActualWorkflow>[0]) {
  return createActualWorkflow({
    ...params,
    ...(params.run.purpose === 'reference' ? { referenceKnowledge: {
      reference: { projectId: params.projectSession.projectId, runId: params.run.id, grantId: '00000000-0000-4000-8000-000000000002', revision: 1 },
      execution: { owner: params.executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
    } } : {}),
  })
}

function run(overrides: Partial<ImportRunSnapshot> = {}): ImportRunSnapshot {
  return {
    id: 'import-run-1', purpose: 'reference', rootRunId: 'import-run-1', effectNamespace: 'import:reference:import-run-1',
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 20 }],
    locale: 'zh-CN', stage: 'knowledge', status: 'running', completedBatches: {},
    lastError: '', resumable: true, cancelRequested: false, totalChapters: 1,
    totalContentSize: 20, manifestChapterCount: 1, manifestContentSize: 20,
    manifestWordCount: 20, completedChapters: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
    ...overrides,
  }
}

const latinWord = /[A-Za-z]{3,}/u
const han = /\p{Script=Han}/u

const callbacks: StepCallbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }

function context(): WorkflowContext {
  return {
    runId: 'import-run-1', projectPath: session.projectPath, projectSession: session,
    writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ipcMocks.on.mockImplementation(() => () => {})
  ipcMocks.revoke.mockResolvedValue({ state: 'revoked' })
  ipcMocks.complete.mockResolvedValue({ state: 'completed' })
  characterSyncMocks.retry.mockResolvedValue({ operationId: 'sync-1' })
  useProjectStore.setState({
    currentProject: {
      id: 'test-project', sessionLease: 'lease-test-project', name: '测试项目', path: session.projectPath,
      novelConfig: {} as never, characterStates: '', createdAt: '', updatedAt: '',
    },
  })
})

afterEach(() => useProjectStore.setState({ currentProject: null }))

describe('createImportWorkflow', () => {
  it.each([
    ['reference', 'global', 1, 'global-facts', 'project-global-facts', 'style'],
    ['reference', 'style', 2, 'writing-style', 'project-writing-style', 'blueprints'],
    ['author-manuscript', 'global', 3, 'global-facts', 'project-global-facts', 'style'],
    ['author-manuscript', 'style', 4, 'writing-style', 'project-writing-style', 'blueprints'],
  ] as const)('uses representative chapters for the production %s %s step with its frozen session and durable commit', async (purpose, stage, stepIndex, effectKey, kind, nextStage) => {
    const author = purpose === 'author-manuscript'
    const snapshot = run({ purpose, authorInference: author, effectNamespace: `import:${purpose}:import-run-1`, stage, totalChapters: 10, manifestChapterCount: 10, manifestWordCount: 9000 })
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    const selected = [1, 2, 3, 9, 10].map(number => ({
      number, title: `Chapter ${number}`, content: `Content ${number}`,
      contentFingerprint: 'a'.repeat(64), contentSize: 10,
    }))
    let receipt: ImportRunEffectReceipt | null = null
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'db:import-run-get': return snapshot
        case 'db:import-run-start-resume': return { success: true, start: { run: snapshot, execution } }
        case 'db:import-run-renew-execution': return { success: true, execution }
        case 'db:import-run-list-representative-chapters': return selected
        case 'db:import-run-effect-receipt-get': return receipt
        case 'db:import-run-effect-receipt-prepare':
          receipt = {
            schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
            runId: snapshot.id, effectNamespace: snapshot.effectNamespace, effectKey, stage,
            batchId: 'done', kind, payloadHash: 'c'.repeat(64), state: 'prepared',
            payload: (args[0] as { payload: unknown }).payload,
            createdAt: '2026-01-01', updatedAt: '2026-01-01',
          }
          return { success: true, receipt }
        case 'db:import-run-effect-receipt-commit':
          receipt = { ...receipt!, state: 'committed', effectReceipt: stage === 'style' ? { writingStyle: 'sample style' } : {} }
          return { success: true, result: { receipt, run: snapshot, cancelApplied: false } }
        case 'db:import-run-advance-stage': return { success: true, run: { ...snapshot, stage: nextStage } }
        default: throw new Error(`Unexpected channel ${channel}`)
      }
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner, ...(author ? { authorChapterNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } : {}) })
    const stepContext = context()
    useProjectStore.setState({ currentProject: {
      id: 'project-b', sessionLease: 'lease-b', name: 'B', path: 'C:\\project-b',
      novelConfig: {} as never, characterStates: '', createdAt: '', updatedAt: '',
    } })

    await workflow.steps[stepIndex].executor({} as never, stepContext, callbacks)

    expect(ipcMocks.invoke).toHaveBeenCalledWith(session, 'db:import-run-list-representative-chapters', snapshot.id, session.projectPath)
    expect(ipcMocks.invoke.mock.calls.filter(call => call[1] === 'db:import-run-list-representative-chapters')).toHaveLength(1)
    expect(ipcMocks.invoke.mock.calls.some(call => call[1] === 'db:import-run-list-chapters')).toBe(false)
    expect(ipcMocks.invoke.mock.calls.every(call => call[0] === session)).toBe(true)
    const expectedChapters = selected.map(({ number, title, content }) => expect.objectContaining({ number, title, content }))
    expect(stepContext.data.importGenerationSlot).toEqual({ runId: snapshot.id, stage, batchId: 'done' })
    expect(stepContext.data.importRunPurpose).toBe(purpose)
    if (stage === 'global') {
      expect(commandMocks.global).toHaveBeenCalledWith(stepContext, author)
      expect(stepContext.data.chapters).toEqual(expectedChapters)
      expect(stepContext.data.importRunTotalChapters).toBe(10)
      expect(stepContext.data.importRunTotalWords).toBe(9000)
      expect(commandMocks.style).not.toHaveBeenCalled()
    } else {
      expect(commandMocks.style).toHaveBeenCalledWith({ chapters: expectedChapters, fillEmpty: author }, stepContext)
      expect(commandMocks.global).not.toHaveBeenCalled()
    }
    expect(ipcMocks.invoke).toHaveBeenCalledWith(session, 'db:import-run-effect-receipt-prepare', {
      runId: snapshot.id, stage, batchId: 'done', effectKey, kind,
      payload: stage === 'global' ? { generated: 'global' } : { writingStyle: 'sample style' },
    }, execution, session.projectPath)
    expect(ipcMocks.invoke).toHaveBeenCalledWith(session, 'db:import-run-effect-receipt-commit', snapshot.id, stage, 'done', execution, session.projectPath)
    expect(ipcMocks.invoke).toHaveBeenCalledWith(session, 'db:import-run-advance-stage', snapshot.id, stage, nextStage, execution, session.projectPath)
  })

  it.each([['global', 1, 'style'], ['style', 2, 'blueprints']] as const)(
    'does not rediscover chapters or regenerate a completed %s checkpoint', async (stage, stepIndex, nextStage) => {
      const snapshot = run({ stage, completedBatches: { [stage]: ['done'] } })
      const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
      ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
        switch (channel) {
          case 'db:import-run-get': return snapshot
          case 'db:import-run-start-resume': return { success: true, start: { run: snapshot, execution } }
          case 'db:import-run-renew-execution': return { success: true, execution }
          case 'db:import-run-advance-stage': return { success: true, run: { ...snapshot, stage: nextStage } }
          default: throw new Error(`Unexpected channel ${channel}`)
        }
      })
      const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })

      await workflow.steps[stepIndex].executor({} as never, context(), callbacks)

      expect(commandMocks.global).not.toHaveBeenCalled()
      expect(commandMocks.style).not.toHaveBeenCalled()
      expect(ipcMocks.invoke).toHaveBeenCalledWith(session, 'db:import-run-advance-stage', snapshot.id, stage, nextStage, execution, session.projectPath)
      expect(ipcMocks.invoke.mock.calls.some(call => call[1] === 'db:import-run-list-representative-chapters' || call[1] === 'db:import-run-list-chapters')).toBe(false)
    },
  )

  it('loads sparse frozen chapter numbers from a resumed author run manifest', async () => {
    const snapshot = run({
      purpose: 'author-manuscript',
      effectNamespace: 'import:author-manuscript:import-run-1',
      stage: 'author-publish',
      totalChapters: 2,
      manifestChapterCount: 2,
      authorityFingerprint: 'c'.repeat(64),
    })
    ipcMocks.invoke.mockImplementation(async (_session, _channel, _runId, after) => (
      after === 0
        ? [
            { number: 2, title: 'Second', contentFingerprint: 'a'.repeat(64), contentSize: 1, content: 'a' },
            { number: 7, title: 'Seventh', contentFingerprint: 'b'.repeat(64), contentSize: 1, content: 'b' },
          ]
        : []
    ))

    await expect(loadAuthorImportChapterNumbers(snapshot, session, session.projectPath))
      .resolves.toEqual([2, 7])
    expect(ipcMocks.invoke).toHaveBeenCalledWith(
      session,
      'db:import-run-list-chapters',
      snapshot.id,
      0,
      100,
      session.projectPath,
    )
    expect(ipcMocks.invoke).toHaveBeenCalledWith(
      session,
      'db:import-run-list-chapters',
      snapshot.id,
      7,
      100,
      session.projectPath,
    )
  })

  it('rejects an author manifest with durable rows beyond the declared chapter count', async () => {
    const snapshot = run({
      purpose: 'author-manuscript',
      effectNamespace: 'import:author-manuscript:import-run-1',
      stage: 'author-publish',
      totalChapters: 2,
      manifestChapterCount: 2,
      authorityFingerprint: 'c'.repeat(64),
    })
    ipcMocks.invoke.mockImplementation(async (_session, _channel, _runId, after) => {
      if (after === 0) return [
        { number: 2, title: 'Second', contentFingerprint: 'a'.repeat(64), contentSize: 1, content: 'a' },
        { number: 7, title: 'Seventh', contentFingerprint: 'b'.repeat(64), contentSize: 1, content: 'b' },
      ]
      if (after === 7) return [
        { number: 9, title: 'Ninth', contentFingerprint: 'd'.repeat(64), contentSize: 1, content: 'd' },
      ]
      return []
    })

    await expect(loadAuthorImportChapterNumbers(snapshot, session, session.projectPath))
      .rejects.toThrow('持久化章节清单不完整')
  })

  it('freezes the persisted run id, locale, session, and reference-only staged copy', () => {
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: run(), executionOwner })

    expect(workflow).toMatchObject({ runId: 'import-run-1', uiLocale: 'zh-CN', projectSession: session })
    expect(workflow.steps.map(step => step.name)).toEqual([
      '导入参照文本与构建知识库', 'AI 推演全局配置与架构', 'AI 拆解文风与仿写指南',
      'AI 分批推演章节蓝图', '刷新项目状态',
    ])
    expect(workflow.steps[0].description).toContain('不写入草稿或正文')
  })

  it('uses the run-start locale even when current UI state differs', () => {
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: run({ locale: 'en-US' }),
      executionOwner,
    })
    expect(workflow.title).toBe('Novel analysis and style study (1 chapter)')
    expect(workflow.steps[0].name).toBe('Import reference text and build the knowledge base')
  })

  it('builds blueprint prompt context in the frozen project writing language, not the UI locale', async () => {
    const snapshot = run({ stage: 'blueprints' })
    useProjectStore.setState({
      currentProject: {
        ...useProjectStore.getState().currentProject!,
        novelConfig: {
          writingLanguage: 'en-US',
          genre: 'Mystery',
          coreOutline: 'Find the missing witness',
          worldSetting: 'A coastal city',
          protagonistProfile: 'A patient investigator',
        } as never,
      },
    })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return {
        success: true,
        start: {
          run: snapshot,
          execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
        },
      }
      if (channel === 'db:import-run-renew-execution') return {
        success: true,
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
      }
      if (channel === 'db:import-run-list-chapters') {
        return (args[1] as number) === 0 ? [{
          number: 1, title: 'Start', content: 'frozen reference',
          contentFingerprint: 'c'.repeat(64), contentSize: 16,
        }] : []
      }
      if (channel === 'db:import-run-effect-receipt-get') return null
      if (channel === 'db:import-run-fail') return { success: true, run: { ...snapshot, status: 'failed' } }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner,
    })
    const frozenContext = { ...context(), writingLanguage: 'en-US' as const, uiLocale: 'zh-CN' as const }

    await expect(workflow.steps[3].executor({} as never, frozenContext, callbacks))
      .rejects.toThrow('stop-after-blueprint-prompt-context')

    expect(commandMocks.blueprintContext?.data.novelConfigSummary).toContain('Genre: Mystery')
    expect(commandMocks.blueprintContext?.data.novelConfigSummary).not.toContain('类型:')
    expect(commandMocks.blueprintContext?.data.importGenerationSlot).toEqual({ runId: snapshot.id, stage: 'blueprints', batchId: '1-1-cccccccc' })
    expect(commandMocks.blueprintContext?.data.importRunExecution).toMatchObject({ owner: executionOwner, epoch: 1 })
  })

  it('delegates knowledge to main, filters progress and retains the returned execution', async () => {
    const snapshot = run({ totalChapters: 2, manifestChapterCount: 2 })
    const reference = { projectId: session.projectId, runId: snapshot.id, grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const authority = { owner: executionOwner, epoch: 1 }
    const execution = { ...authority, expiresAt: Number.MAX_SAFE_INTEGER }
    const unsubscribe = vi.fn()
    let listener: (event: unknown) => void = () => { throw new Error('listener missing') }
    ipcMocks.on.mockImplementation((_channel, callback) => { listener = callback; return unsubscribe })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'reference-knowledge:v1:execute') {
        expect(ipcMocks.on).toHaveBeenCalledWith('reference-knowledge:v1:progress', expect.any(Function))
        listener({ reference, execution: authority, kind: 'chapter', chapterNumber: 1, idempotent: true })
        listener({ reference, execution: authority, kind: 'batch', progress: 42 })
        listener({ reference: { ...reference, revision: 2 }, execution: authority, kind: 'batch', progress: 30 })
        listener({ reference, execution: { ...authority, epoch: 2 }, kind: 'batch', progress: 31 })
        listener({ reference, execution: authority, kind: 'batch', progress: 100 })
        listener({ reference, execution: authority, kind: 'batch', progress: 32, extra: true })
        return { success: true, run: { ...snapshot, stage: 'global' }, execution }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    const stepContext = context()
    const stepCallbacks: StepCallbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
    await workflow.steps[0].executor({} as never, stepContext, stepCallbacks)
    expect(ipcMocks.actual).toHaveBeenCalledWith(session, 'reference-knowledge:v1:execute', { reference, execution: authority })
    expect(stepCallbacks.log).toHaveBeenCalledExactlyOnceWith('参照章节 1 已进入知识库（已存在）')
    expect(stepCallbacks.setProgress).toHaveBeenCalledExactlyOnceWith(42)
    expect(stepContext.data.importRunExecution).toEqual(execution)
    expect(unsubscribe).toHaveBeenCalledOnce()
    listener({ reference, execution: authority, kind: 'batch', progress: 50 })
    expect(stepCallbacks.setProgress).toHaveBeenCalledOnce()
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual(['db:import-run-get', 'reference-knowledge:v1:execute'])
  })

  it.each(['run', 'root', 'stage', 'owner', 'epoch', 'expiry', 'failure'] as const)(
    'rejects a malformed or mismatched main execution result: %s', async invalid => {
      const snapshot = run()
      const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
      const returnedRun = { ...snapshot, stage: 'global' as const }
      const reply: unknown = invalid === 'failure' ? { success: false, error: 'bad' } : {
        success: true,
        run: { ...returnedRun, ...(invalid === 'run' ? { id: 'other' } : {}),
          ...(invalid === 'root' ? { rootRunId: 'other' } : {}), ...(invalid === 'stage' ? { stage: 'knowledge' } : {}) },
        execution: { ...execution, ...(invalid === 'owner' ? { owner: 'other' } : {}),
          ...(invalid === 'epoch' ? { epoch: 2 } : {}), ...(invalid === 'expiry' ? { expiresAt: 0 } : {}) },
      }
      const unsubscribe = vi.fn()
      ipcMocks.on.mockReturnValue(unsubscribe)
      ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
        if (channel === 'db:import-run-get') return snapshot
        if (channel === 'reference-knowledge:v1:execute') return reply
        throw new Error(`Unexpected channel ${channel}`)
      })
      const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
      const stepContext = context()
      await expect(workflow.steps[0].executor({} as never, stepContext, callbacks)).rejects.toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
      expect(stepContext.data.importRunExecution).toBeUndefined()
      expect(unsubscribe).toHaveBeenCalledOnce()
      expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual(['db:import-run-get', 'reference-knowledge:v1:execute'])
    },
  )

  it('unsubscribes and does not terminate again when the execute IPC throws', async () => {
    const snapshot = run()
    const unsubscribe = vi.fn()
    ipcMocks.on.mockReturnValue(unsubscribe)
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'reference-knowledge:v1:execute') throw new Error('synthetic IPC failure')
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[0].executor({} as never, context(), callbacks)).rejects.toThrow('synthetic IPC failure')
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual(['db:import-run-get', 'reference-knowledge:v1:execute'])
  })

  it('does not re-execute knowledge after the persisted stage has advanced', async () => {
    const snapshot = run()
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return { ...snapshot, stage: 'global' }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await workflow.steps[0].executor({} as never, context(), callbacks)
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual(['db:import-run-get'])
    expect(ipcMocks.on).not.toHaveBeenCalled()
  })

  it('requires matching issuance without preparing implicitly and revokes before any step', async () => {
    const snapshot = run()
    const params = { projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }
    expect(() => createActualWorkflow(params)).toThrow('KNOWLEDGE_BASE_REFERENCE_ISSUANCE_REQUIRED')
    const reference = { projectId: session.projectId, runId: snapshot.id, grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    expect(() => createActualWorkflow({ ...params, referenceKnowledge: { reference: { ...reference, runId: 'other' }, execution } }))
      .toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
    const workflow = createActualWorkflow({ ...params, referenceKnowledge: { reference, execution } })
    reference.revision = 2
    await workflow.onCancelRequested!(context())
    expect(ipcMocks.revoke).toHaveBeenCalledExactlyOnceWith('reference-knowledge:v1:revoke', expect.objectContaining({ revision: 1 }))
    expect(ipcMocks.actual).not.toHaveBeenCalled()
  })

  it.each([false, true])('completes the durable run before grant completion; failure=%s', async fail => {
    const snapshot = run({ stage: 'refresh', completedBatches: { refresh: ['done'] } })
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return { success: true, start: { run: snapshot, execution } }
      if (channel === 'db:import-run-renew-execution') return { success: true, execution }
      if (channel === 'db:import-run-complete') return { success: true, run: { ...snapshot, status: 'completed' } }
      if (channel === 'db:import-run-fail') return { success: true, run: snapshot }
      throw new Error(`Unexpected channel ${channel}`)
    })
    if (fail) ipcMocks.complete.mockRejectedValue(new Error('fixture completion failed'))
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    const result = workflow.steps[4].executor({} as never, context(), callbacks)
    if (fail) await expect(result).rejects.toThrow('fixture completion failed')
    else await expect(result).resolves.toBeUndefined()
    const channels = ipcMocks.actual.mock.calls.map(call => call[1])
    expect(channels.indexOf('db:import-run-complete')).toBeGreaterThanOrEqual(0)
    expect(channels.indexOf('reference-knowledge:v1:complete')).toBeGreaterThan(channels.indexOf('db:import-run-complete'))
  })

  it('rejects a stale project lease before creating any task', () => {
    expect(() => createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: { ...session, leaseId: 'stale' },
      run: run(),
      executionOwner,
    })).toThrow('当前项目已切换')
  })

  it('re-reads and rejects a committed effect receipt that differs from durable storage', async () => {
    const snapshot = run({ stage: 'global' })
    const receipt: ImportRunEffectReceipt = {
      schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
      runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace,
      effectKey: 'global-facts',
      stage: 'global',
      batchId: 'done',
      kind: 'project-global-facts',
      payloadHash: 'c'.repeat(64),
      state: 'committed',
      payload: {},
      effectReceipt: {},
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    let receiptReads = 0
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return {
        success: true,
        start: {
          run: snapshot,
          execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
        },
      }
      if (channel === 'db:import-run-renew-execution') return {
        success: true,
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
      }
      if (channel === 'db:import-run-list-representative-chapters') return []
      if (channel === 'db:import-run-effect-receipt-get') {
        receiptReads += 1
        return receiptReads === 1 ? receipt : { ...receipt, payloadHash: 'd'.repeat(64) }
      }
      if (channel === 'db:import-run-effect-receipt-commit') return {
        success: true,
        result: { receipt, run: snapshot, cancelApplied: false },
      }
      if (channel === 'db:import-run-fail') return {
        success: true,
        run: { ...snapshot, status: 'failed' },
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: snapshot,
      executionOwner,
    })

    const failure = await workflow.steps[1].executor({} as never, context(), callbacks).catch((error: Error) => error)
    expect((failure as Error).message).toMatch(/^已提交的导入结果与保存的记录不一致/u)
    expect((failure as Error).message).not.toMatch(latinWord)
    expect(receiptReads).toBe(2)
  })

  it('resumes a checkpointed blueprint batch by completing its pending character sync without generation', async () => {
    const checkpoint = '1-1-cccccccc'
    let snapshot = run({
      stage: 'blueprints',
      completedBatches: { blueprints: [checkpoint] },
    })
    const receipt: ImportRunEffectReceipt = {
      schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
      runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace,
      effectKey: `blueprints:${checkpoint}`,
      stage: 'blueprints',
      batchId: checkpoint,
      kind: 'chapter-blueprint-range',
      payloadHash: 'c'.repeat(64),
      state: 'committed',
      payload: { blueprints: [{ chapterNumber: 1 }] },
      effectReceipt: { characterSyncOperation: { operationId: 'sync-1' } },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return {
        success: true,
        start: {
          run: snapshot,
          execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
        },
      }
      if (channel === 'db:import-run-renew-execution') return {
        success: true,
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
      }
      if (channel === 'db:import-run-list-chapters') {
        const after = args[1] as number
        return after === 0 ? [{
          number: 1,
          title: 'Start',
          content: 'frozen reference',
          contentFingerprint: 'c'.repeat(64),
          contentSize: 16,
        }] : []
      }
      if (channel === 'db:import-run-effect-receipt-get') return receipt
      if (channel === 'db:import-run-effect-receipt-commit') return {
        success: true,
        result: { receipt, run: snapshot, cancelApplied: false },
      }
      if (channel === 'db:import-run-advance-stage') {
        snapshot = { ...snapshot, stage: 'refresh' }
        return { success: true, run: snapshot }
      }
      if (channel === 'db:import-run-fail') return {
        success: true,
        run: { ...snapshot, status: 'failed' },
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: snapshot,
      executionOwner,
    })

    await workflow.steps[3].executor({} as never, context(), callbacks)

    expect(characterSyncMocks.retry).toHaveBeenCalledWith('sync-1', session.projectPath, session, 'zh-CN')
    expect(snapshot.stage).toBe('refresh')
    expect(ipcMocks.invoke.mock.calls.map(call => call[1])).not.toContain('llm:generate')
  })

  it('creates an author-only finalization plan without reference analysis stages', () => {
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: run({
        purpose: 'author-manuscript',
        effectNamespace: 'import:author-manuscript:import-run-1',
        stage: 'author-commit',
        authorityFingerprint: 'c'.repeat(64),
      }),
      executionOwner,
      authorChapterNumbers: [1],
    })

    expect(workflow.title).toBe('导入作者原稿（1 章）')
    expect(workflow.steps.map(step => step.name)).toEqual([
      '提交权威定稿快照', '发布实体正文', '更新连续性事实', '刷新项目状态',
    ])
    expect(workflow.steps.map(step => step.name).join('\n')).not.toMatch(/知识库|文风|蓝图/)
  })

  it('勾选反推的作者原稿：后处理之后接三个反推步骤，设定、架构、蓝图、角色名单都取写锁', () => {
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: run({
        purpose: 'author-manuscript', authorInference: true,
        effectNamespace: 'import:author-manuscript:import-run-1', stage: 'author-commit', authorityFingerprint: 'c'.repeat(64),
      }),
      executionOwner,
      authorChapterNumbers: [1],
    })

    expect(workflow.steps.map(step => step.name)).toEqual([
      '提交权威定稿快照', '发布实体正文', '更新连续性事实',
      '反推设定、架构与角色', '反推文风', '为没有蓝图的章反推蓝图', '刷新项目状态',
    ])
    expect(workflow.resourceKeys).toEqual(expect.arrayContaining(['novel-config', 'architecture', 'blueprints', 'character-roster']))
    expect(workflow.readResourceKeys ?? []).toEqual([])
  })

  it('不勾选反推的作者原稿：步骤与锁和以前一样，设定、架构、蓝图只取读锁', () => {
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: run({
        purpose: 'author-manuscript', authorInference: false,
        effectNamespace: 'import:author-manuscript:import-run-1', stage: 'author-commit', authorityFingerprint: 'c'.repeat(64),
      }),
      executionOwner,
      authorChapterNumbers: [1],
    })

    expect(workflow.steps).toHaveLength(4)
    expect(workflow.readResourceKeys).toEqual(['novel-config', 'architecture', 'blueprints'])
    expect(workflow.resourceKeys).not.toContain('novel-config')
  })

  it('persists author cancellation intent without owning its terminal boundary', async () => {
    const snapshot = run({
      purpose: 'author-manuscript',
      effectNamespace: 'import:author-manuscript:import-run-1',
      stage: 'author-publish',
      authorityFingerprint: 'c'.repeat(64),
    })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-request-cancel') return { success: true, run: { ...snapshot, cancelRequested: true } }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: snapshot,
      executionOwner,
      authorChapterNumbers: [1],
    })
    const workflowContext = context()
    workflowContext.data.importRunExecution = {
      owner: executionOwner,
      epoch: 1,
      expiresAt: Number.MAX_SAFE_INTEGER - 1,
    }

    expect(workflow.onCancelRequested).toBeTypeOf('function')
    expect(workflow.onCancelledAtBoundary).toBeUndefined()
    await workflow.onCancelRequested!(workflowContext)

    expect(ipcMocks.invoke.mock.calls.map(call => call[1])).toEqual(['db:import-run-request-cancel'])
  })

  it('keeps import workflow sources free of pseudo icon text', () => {
    const source = [
      'src/services/workflows/import-workflow.ts',
      'src/services/workflows/import-run-orchestrator.ts',
      'src/components/dialogs/ImportNovelDialog.tsx',
    ].map(file => readFileSync(resolve(process.cwd(), file), 'utf8')).join('\n')
    expect(source).not.toMatch(/[\u2600-\u27BF]/u)
    expect(source).not.toMatch(/\uFE0F/u)
    expect(source).not.toMatch(/[\p{Extended_Pictographic}]/u)
  })
})

describe('estimateImportCost', () => {
  it('returns the global and blueprint parts so the dialog can word them in either language', () => {
    expect(estimateImportCost(0, 10)).toEqual({
      globalTokens: 15_000,
      blueprintTokens: 40_000,
      estimatedTokens: 55_000,
      estimatedMinutes: 1,
    })
  })
})

describe('import workflow failure copy follows the import run locale (#484)', () => {
  const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }

  function stepFailure(
    snapshot: ImportRunSnapshot,
    step: number,
    channels: Record<string, (...args: unknown[]) => unknown>,
  ): Promise<Error> {
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channels[channel]) return channels[channel](...args)
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return { success: true, start: { run: snapshot, execution } }
      if (channel === 'db:import-run-renew-execution') return { success: true, execution }
      if (channel === 'db:import-run-list-chapters') return []
      if (channel === 'db:import-run-fail') return { success: true, run: { ...snapshot, status: 'failed' } }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: snapshot,
      executionOwner,
      ...(snapshot.purpose === 'author-manuscript' ? { authorChapterNumbers: [1] } : {}),
    })
    return workflow.steps[step].executor({} as never, { ...context(), uiLocale: snapshot.locale }, callbacks)
      .then(() => new Error('step did not fail'), (error: Error) => error)
  }

  const authorRun = (locale: ImportRunSnapshot['locale']) => run({
    locale,
    purpose: 'author-manuscript',
    effectNamespace: 'import:author-manuscript:import-run-1',
    stage: 'author-publish',
    authorityFingerprint: 'c'.repeat(64),
  })
  const preparedAuthorReceipt = (snapshot: ImportRunSnapshot): ImportRunEffectReceipt => ({
    schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
    runId: snapshot.id,
    effectNamespace: snapshot.effectNamespace,
    effectKey: 'author-commit',
    stage: 'author-commit',
    batchId: 'done',
    kind: 'author-finalized-batch',
    payloadHash: 'c'.repeat(64),
    state: 'prepared',
    payload: {},
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  })

  it('explains an author receipt that was never durably committed in Chinese for a Chinese run', async () => {
    const snapshot = authorRun('zh-CN')
    const failure = await stepFailure(snapshot, 1, {
      'db:import-run-effect-receipt-get': () => preparedAuthorReceipt(snapshot),
    })

    expect(failure.message).toMatch(han)
    expect(failure.message).not.toMatch(latinWord)
  })

  it('keeps the English explanation for an English run', async () => {
    const snapshot = authorRun('en-US')
    const failure = await stepFailure(snapshot, 1, {
      'db:import-run-effect-receipt-get': () => preparedAuthorReceipt(snapshot),
    })

    expect(failure.message).toMatch(/has not been durably committed/u)
    expect(failure.message).not.toMatch(han)
  })

  it.each([
    ['zh-CN', /^无法开始或继续这次导入/u],
    ['en-US', /^Could not start or resume the import run\.$/u],
  ] as const)('falls back to %s copy when the main process refuses without a reason', async (locale, expected) => {
    const snapshot = authorRun(locale)
    const failure = await stepFailure(snapshot, 1, {
      'db:import-run-start-resume': () => ({ success: false }),
    })

    expect(failure.message).toMatch(expected)
  })
})

describe('作者在一批参照章节导入途中取消（#587）', () => {
  // 主进程拥有执行期间的取消和失败终结。
  async function cancelDuringFirstChapter(reply: { success: false; error: string; errorCode: string }) {
    const snapshot = run({ totalChapters: 3, manifestChapterCount: 3 })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      switch (channel) {
        case 'db:import-run-get': return snapshot
        case 'reference-knowledge:v1:execute':
          useWorkflowStore.getState().cancelWorkflow(snapshot.id)
          return reply
        case 'fs:check-exists': return false
        default: throw new Error(`测试未配置桌面调用：${channel}`)
      }
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async (channel: string) => channel === 'skills:list-user' ? [] : false), on: vi.fn(() => () => {}), once: vi.fn() } })
    useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {} })
    const performanceKey = Symbol.for('pagekin.performance-baseline.renderer')
    const previousProbe = Object.getOwnPropertyDescriptor(globalThis, performanceKey)
    const record = vi.fn()
    Object.defineProperty(globalThis, performanceKey, { value: { now: () => performance.now(), record }, configurable: true })
    try {
      await useWorkflowStore.getState().startWorkflow(createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }))
    } finally {
      vi.unstubAllGlobals()
      if (previousProbe) Object.defineProperty(globalThis, performanceKey, previousProbe)
      else delete (globalThis as Record<symbol, unknown>)[performanceKey]
    }
    const channels = ipcMocks.invoke.mock.calls.map(call => call[1])
    expect(record).toHaveBeenCalledExactlyOnceWith('workflow.import.knowledge.ms', expect.any(Number))
    expect(record.mock.calls[0]![1]).toBeGreaterThanOrEqual(0)
    return { ended: useWorkflowStore.getState().history[0]!, channels }
  }

  it('主进程以取消码拒绝剩下的章节：运行记已取消，已取消的步骤写明停在了已保存的进度处', async () => {
    const { ended, channels } = await cancelDuringFirstChapter({ success: false, error: '导入已取消。', errorCode: 'IMPORT_RUN_CANCELLED' })

    expect(ended).toMatchObject({ status: 'cancelled' })
    expect(ended.steps[0]).toMatchObject({ status: 'cancelled', error: '导入已取消，停在了已保存的进度处。' })
    expect(ipcMocks.revoke.mock.calls.filter(call => call[0] === 'reference-knowledge:v1:revoke')).toEqual([[
      'reference-knowledge:v1:revoke',
      { projectId: session.projectId, runId: 'import-run-1', grantId: '00000000-0000-4000-8000-000000000002', revision: 1 },
    ]])
    expect(channels).not.toContain('db:import-run-cancel-at-boundary')
    expect(channels).not.toContain('db:import-run-fail')
  })

  it('取消请求之后剩下的章节因真实错误失败：运行记失败，带原错误码，导入运行记失败而不是已取消', async () => {
    const { ended, channels } = await cancelDuringFirstChapter({ success: false, error: '检索索引正在建立，请稍后再试。', errorCode: 'EMBEDDING_SPACE_BUSY' })

    expect(ended).toMatchObject({ status: 'failed', errorCode: 'EMBEDDING_SPACE_BUSY' })
    expect(ended.steps[0]).toMatchObject({ status: 'failed', errorCode: 'EMBEDDING_SPACE_BUSY' })
    expect(ipcMocks.revoke.mock.calls.filter(call => call[0] === 'reference-knowledge:v1:revoke')).toEqual([[
      'reference-knowledge:v1:revoke',
      { projectId: session.projectId, runId: 'import-run-1', grantId: '00000000-0000-4000-8000-000000000002', revision: 1 },
    ]])
    expect(channels).not.toContain('db:import-run-fail')
    expect(channels).not.toContain('db:import-run-cancel-at-boundary')
  })
})

describe('import stage performance observation', () => {
  const key = Symbol.for('pagekin.performance-baseline.renderer')
  let previous: PropertyDescriptor | undefined
  let execute: MockInstance<ImportRunOrchestrator['executeStage']>
  const stages = [
    ['knowledge', false, 0], ['global', false, 1], ['style', false, 2], ['blueprints', false, 3],
    ['author-commit', true, 0], ['author-publish', true, 1], ['author-postprocess', true, 2], ['refresh', false, 4],
  ] as const

  function install(sink: unknown): void {
    Object.defineProperty(globalThis, key, { value: sink, configurable: true, writable: true })
  }

  function step(stage: typeof stages[number][0], author: boolean, index: number) {
    const snapshot = run({
      stage, purpose: author ? 'author-manuscript' : 'reference',
      effectNamespace: `import:${author ? 'author-manuscript' : 'reference'}:import-run-1`,
    })
    return createImportWorkflow({
      projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner,
      ...(author ? { authorChapterNumbers: [1] } : {}),
    }).steps[index]!
  }

  beforeEach(() => {
    previous = Object.getOwnPropertyDescriptor(globalThis, key)
    delete (globalThis as Record<symbol, unknown>)[key]
    execute = vi.spyOn(ImportRunOrchestrator.prototype, 'executeStage').mockResolvedValue(undefined)
  })

  afterEach(() => {
    execute.mockRestore()
    if (previous) Object.defineProperty(globalThis, key, previous)
    else delete (globalThis as Record<symbol, unknown>)[key]
  })

  it.each(stages)('records the real %s step executor only when invoked', async (stage, author, index) => {
    const sink = { now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(35), record: vi.fn() }
    install(sink)
    const entered = step(stage, author, index)
    expect(sink.now).not.toHaveBeenCalled()
    expect(sink.record).not.toHaveBeenCalled()
    const ctx = context()
    await entered.executor({} as never, ctx, callbacks)
    expect(execute).toHaveBeenCalledExactlyOnceWith('import-run-1', stage, executionOwner, ctx, callbacks)
    expect(sink.record).toHaveBeenCalledExactlyOnceWith(`workflow.import.${stage}.ms`, 25)
  })

  it.each(['failed', 'cancelled'] as const)('preserves the original %s result and records elapsed stage time once', async outcome => {
    const original = Object.assign(new Error('private-stage-error'), { code: outcome === 'cancelled' ? 'WORKFLOW_CANCELLED' : 'FICTIONAL_STAGE_FAILED' })
    execute.mockRejectedValue(original)
    const sink = { now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(40), record: vi.fn() }
    install(sink)
    const ctx = context()
    ctx.cancelled = outcome === 'cancelled'
    await expect(step('knowledge', false, 0).executor({} as never, ctx, callbacks)).rejects.toBe(original)
    expect(sink.record).toHaveBeenCalledExactlyOnceWith('workflow.import.knowledge.ms', 40)
    expect(JSON.stringify(sink.record.mock.calls)).not.toContain('private-stage-error')
  })

  it('keeps zero elapsed time and samples only after the actual executor settles', async () => {
    let resolve!: () => void
    const gate = new Promise<void>(done => { resolve = done })
    execute.mockReturnValue(gate)
    const sink = { now: vi.fn(() => 5), record: vi.fn() }
    install(sink)
    const pending = step('knowledge', false, 0).executor({} as never, context(), callbacks)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(sink.record).not.toHaveBeenCalled()
    resolve()
    await pending
    expect(sink.record).toHaveBeenCalledExactlyOnceWith('workflow.import.knowledge.ms', 0)
  })

  it('executes without observation when no opt-in probe is installed', async () => {
    await expect(step('knowledge', false, 0).executor({} as never, context(), callbacks)).resolves.toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(Object.getOwnPropertyDescriptor(globalThis, key)).toBeUndefined()
  })

  it.each(['missing-record', 'missing-clock', 'start-throws', 'end-throws', 'invalid-start', 'invalid-end', 'sink-throws'] as const)(
    'keeps success and original failure unchanged when observation %s', async fault => {
      for (const fails of [false, true]) {
        const original = new Error('private-original-stage-error')
        if (fails) execute.mockRejectedValue(original)
        else execute.mockResolvedValue(undefined)
        const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(30)
        const record = vi.fn()
        if (fault === 'start-throws') now.mockReset().mockImplementation(() => { throw new Error('private-start-clock') })
        if (fault === 'end-throws') now.mockReset().mockReturnValueOnce(10).mockImplementation(() => { throw new Error('private-end-clock') })
        if (fault === 'invalid-start') now.mockReset().mockReturnValue(NaN)
        if (fault === 'invalid-end') now.mockReset().mockReturnValueOnce(10).mockReturnValueOnce(-1)
        if (fault === 'sink-throws') record.mockImplementation(() => { throw new Error('private-sink-error') })
        install({ ...(fault === 'missing-clock' ? {} : { now }), ...(fault === 'missing-record' ? {} : { record }) })
        const pending = step('knowledge', false, 0).executor({} as never, context(), callbacks)
        if (fails) await expect(pending).rejects.toBe(original)
        else await expect(pending).resolves.toBeUndefined()
        expect(record).toHaveBeenCalledTimes(fault === 'sink-throws' ? 1 : 0)
        if (fault === 'missing-record') expect(now).not.toHaveBeenCalled()
      }
    },
  )
})

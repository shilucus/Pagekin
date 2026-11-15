import { createHash } from 'node:crypto'
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
  ImportBlueprintPostCommitSyncError: class extends Error {
    readonly retryOperationId: string
    constructor(readonly commitReceipt: { characterSyncOperation: { operationId: string } }) {
      super('blueprint sync failed after commit')
      this.retryOperationId = commitReceipt.characterSyncOperation.operationId
    }
  },
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
import type { ReferenceStyleAckRequest } from '../../../shared/reference-style-contract'
import { globalEventBus } from '../../../shared/event-bus'
import { projectSessionContextFromProject } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore } from '../../../stores/character-store'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { createBoundedCompletionError } from '../bounded-completion'
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'
import { knownAppErrorMessage } from '../../../i18n/app-errors'
import * as modelRouting from '../../model-routing'

const session = { projectId: 'test-project', leaseId: 'lease-test-project', projectPath: 'C:\\test-project' }
const executionOwner = '00000000-0000-4000-8000-000000000001'

function createImportWorkflow(params: Parameters<typeof createActualWorkflow>[0]) {
  const workflow = createActualWorkflow({
    ...params,
    ...(params.run.purpose === 'reference' ? { referenceKnowledge: {
      reference: { projectId: params.projectSession.projectId, runId: params.run.id, grantId: '00000000-0000-4000-8000-000000000002', revision: 1 },
      execution: { owner: params.executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
    } } : {}),
  })
  if (params.run.purpose !== 'reference') return workflow
  const originalInvoke = ipcMocks.invoke.getMockImplementation()
  const originalOn = ipcMocks.on.getMockImplementation()
  const stages = ['knowledge', 'global', 'style', 'blueprints', 'refresh'] as const
  const progressChannels = ['reference-knowledge:v1:progress', 'import-generation:v1:global-progress',
    'import-generation:v1:style-progress', 'import-generation:v1:blueprints-progress', 'reference-knowledge:v1:refresh-progress']
  const executionChannels = ['reference-knowledge:v1:execute', 'import-generation:v1:global',
    'import-generation:v1:style', 'import-generation:v1:blueprints', 'reference-knowledge:v1:refresh']
  let requestedStep = 0
  let wholeListener: ((event: unknown) => void) | undefined
  let settleProjection: (() => void) | undefined
  ipcMocks.on.mockImplementation((channel, listener) => {
    if (channel === 'reference-run:v1:progress') { wholeListener = listener; return () => { wholeListener = undefined } }
    const startIndex = requestedStep === 0 ? Math.max(0, stages.indexOf(params.run.stage as typeof stages[number])) : requestedStep
    if (channel === progressChannels[startIndex]) return originalOn?.(channel, listener) ?? (() => {})
    return () => {}
  })
  ipcMocks.invoke.mockImplementation(async (currentSession, channel, ...args) => {
    if (channel === 'reference-run:v1:projection-ack') { settleProjection?.(); return { version: 1 } }
    if (channel !== 'reference-run:v1:execute') return originalInvoke?.(currentSession, channel, ...args)
    const request = args[0] as { reference: { runId: string }; execution: object; modelId: string | null }
    const index = requestedStep === 0 ? Math.max(0, stages.indexOf(params.run.stage as typeof stages[number])) : requestedStep
    const stage = stages[index]!
    const base = { reference: request.reference, execution: request.execution, leaseId: params.projectSession.leaseId }
    for (let prior = 0; prior < index; prior++) wholeListener?.({ ...base, sequence: prior + 1,
      kind: 'stage-skipped', stage: stages[prior], run: params.run, token: '00000000-0000-4000-8000-000000000003' })
    wholeListener?.({ ...base, sequence: index + 1, kind: 'stage-started', stage, run: params.run })
    await Promise.resolve()
    await Promise.resolve()
    const stageRequest = index === 0 || index === 4 ? { reference: request.reference, execution: request.execution }
      : { runId: params.run.id, execution: request.execution, modelId: request.modelId }
    const result: { success?: boolean; run?: ImportRunSnapshot; [key: string]: unknown } =
      await ipcMocks.invoke(currentSession, executionChannels[index], stageRequest)
    if (!result) {
      const error = index === 0 ? 'KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID' : 'GENERATION_REQUEST_FAILED'
      return { success: false, error, errorCode: error }
    }
    if (result.success !== true) return result
    if (!result.run || result.run.id !== request.reference.runId || result.run.rootRunId !== params.run.rootRunId)
      return { success: false, error: 'KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID', errorCode: 'KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID' }
    const completion = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'success'))
    const acknowledged = new Promise<void>(resolve => { settleProjection = resolve })
    wholeListener?.({ ...base, sequence: index + 2, kind: 'stage-completed',
      token: '00000000-0000-4000-8000-000000000003', completion: { stage, result: completion } })
    await acknowledged
    if (stage === 'refresh') return result
    return new Promise(() => {})
  })
  workflow.steps = workflow.steps.map((step, index) => ({ ...step, executor: (...args) => {
    requestedStep = index
    return step.executor(...args)
  } }))
  return workflow
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
    projectionSession: session,
    waitForProjectView: async () => session,
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
    loading: false,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  ipcMocks.invoke.mockReset()
  useProjectStore.setState({ currentProject: null, loading: false })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})

describe('whole reference run projection', () => {
  it.each(['success', 'dirty-cas'] as const)('projects the complete run with %s', async outcome => {
    const snapshot = run()
    const authority = { owner: executionOwner, epoch: 1 }
    const execution = { ...authority, expiresAt: Number.MAX_SAFE_INTEGER }
    const reference = { projectId: session.projectId, runId: snapshot.id,
      grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const token = '00000000-0000-4000-8000-000000000003'
    const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
    const globalReceipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace, effectKey: 'global-facts', stage: 'global', batchId: 'done',
      kind: 'project-global-facts', payloadHash: 'a'.repeat(64), state: 'committed', payload: {}, effectReceipt: {}, createdAt: 'now', updatedAt: 'now' }
    const batchId = '1-1-aaaaaaaa'
    const blueprintReceipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace, effectKey: `blueprints:${batchId}`, stage: 'blueprints', batchId,
      kind: 'chapter-blueprint-range', payloadHash: 'b'.repeat(64), state: 'committed', payload: {},
      effectReceipt: { operationId: 'op-1', snapshot: [{}], characterSyncOperation: { operationId: 'sync-1' } }, createdAt: 'now', updatedAt: 'now' }
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel) })
    vi.spyOn(modelRouting, 'routeModelId').mockReturnValue('selected-model')
    const persist = vi.spyOn(useProjectStore.getState(), 'commitGeneratedNovelConfig')
    let nextProjection!: (decision: string) => void
    let nextStyle!: () => void
    const stages = ['knowledge', 'global', 'style', 'blueprints', 'refresh'] as const
    const order: string[] = []
    let sequence = 0
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'generation:read') return { handle, artifacts: [], budget: {} }
      if (channel === 'db:import-run-effect-receipt-get') return args[1] === 'global' ? globalReceipt : blueprintReceipt
      if (channel === 'db:project-core-get') return { genre: 'canonical' }
      if (channel === 'import-generation:v1:style-ack') {
        const ack = args[0] as ReferenceStyleAckRequest
        order.push(`style-${ack.phase}-${ack.decision}`)
        if (outcome === 'dirty-cas' && ack.phase === 'commit') {
          const current = useProjectStore.getState().currentProject!
          useProjectStore.setState({ currentProject: { ...current, novelConfig: { ...current.novelConfig, writingStyle: 'new author draft' } } })
        }
        nextStyle()
        return { version: 1, savedWritingStyle: ack.phase === 'commit' ? 'saved style' : null }
      }
      if (channel === 'reference-run:v1:projection-ack') {
        const ack = args[0] as { stage: string; decision: string }
        order.push(`settled-${ack.stage}-${ack.decision}`)
        nextProjection(ack.decision)
        return { version: 1 }
      }
      if (channel !== 'reference-run:v1:execute') throw new Error(`Unexpected channel ${channel}`)
      expect(args[0]).toEqual({ reference, execution: authority, modelId: 'selected-model' })
      const base = { reference, execution: authority, leaseId: session.leaseId }
      const emit = (event: object) => listeners.get('reference-run:v1:progress')!({ ...base, sequence: ++sequence, ...event })
      const done = run({ stage: 'completed', status: 'completed' })
      for (const [index, stage] of stages.entries()) {
        const current = run({ stage })
        const next = stage === 'refresh' ? done : run({ stage: stages[index + 1]! })
        emit({ kind: 'stage-started', stage, run: current })
        if (stage === 'style') {
          const child = listeners.get('import-generation:v1:style-progress')!
          const identity = { projectId: session.projectId, leaseId: session.leaseId, runId: snapshot.id, execution: authority }
          let wait = new Promise<void>(resolve => { nextStyle = resolve })
          child({ ...identity, sequence: 1, kind: 'opened', token: 'open-token', handle, modelId: 'selected-model' })
          await wait
          wait = new Promise<void>(resolve => { nextStyle = resolve })
          child({ ...identity, sequence: 2, kind: 'commit-ready', token: 'commit-token', handle, writingStyle: 'generated style' })
          await wait
        }
        const result = stage === 'knowledge' ? { run: next, execution }
          : stage === 'global' ? { version: 1, run: next, execution, receipt: globalReceipt, handle: null, modelId: null, replayed: true }
          : stage === 'style' ? { version: 1, run: next, execution, savedWritingStyle: 'saved style', handle, modelId: 'selected-model', replayed: false }
          : stage === 'blueprints' ? { version: 1, run: next, execution, receipt: blueprintReceipt, handle: null, modelId: null, replayed: true }
          : { version: 1, run: next, execution: null, replayed: true }
        const settled = new Promise<string>(resolve => { nextProjection = resolve })
        emit({ kind: 'stage-completed', token, completion: { stage, result } })
        if (await settled !== 'settled') return { success: false, error: 'projection failed', errorCode: 'GENERATION_REQUEST_FAILED' }
      }
      return { success: true, version: 1, run: done, execution: null, replayed: true }
    })
    const workflow = createActualWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot,
      executionOwner, referenceKnowledge: { reference, execution } })
    const ctx = context()
    for (const [index, step] of workflow.steps.entries()) {
      const pending = step.executor({} as never, ctx, callbacks)
      if (outcome === 'dirty-cas' && index === 2) {
        await expect(pending).rejects.toThrow('GENERATION_SAVED_WITH_NEWER_AUTHOR_DRAFT')
        break
      }
      await pending
    }
    expect(persist).toHaveBeenCalledOnce()
    if (outcome === 'dirty-cas') expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle).toBe('new author draft')
    expect(order).toEqual(['settled-knowledge-settled', 'settled-global-settled', 'style-opened-accept', 'style-commit-accept',
      `settled-style-${outcome === 'success' ? 'settled' : 'projection-failed'}`,
      ...(outcome === 'success' ? ['settled-blueprints-settled', 'settled-refresh-settled'] : [])])
    expect(ipcMocks.actual.mock.calls.filter(call => call[1] === 'reference-run:v1:execute')).toHaveLength(1)
    expect(listeners.size).toBe(0)
  })

  it.each(['chosen-model', null] as const)('executes one resumed run with frozen model %s', async selected => {
    const batchId = '1-1-aaaaaaaa'
    const snapshot = run({ stage: 'refresh', completedBatches: { blueprints: [batchId] } })
    const completed = run({ stage: 'completed', status: 'completed' })
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => { listeners.delete(channel) } })
    vi.spyOn(modelRouting, 'routeModelId').mockReturnValue(null)
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
    vi.spyOn(useCharacterStore.getState(), 'loadCharacters').mockResolvedValue()
    vi.spyOn(useDraftStore.getState(), 'loadAllDrafts').mockResolvedValue()
    let releaseChild!: () => void, releaseProjection!: () => void
    const childAck = new Promise<void>(resolve => { releaseChild = resolve })
    const token = '00000000-0000-4000-8000-000000000003'
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'reference-run:v1:projection-ack') {
        expect(args[0]).toMatchObject({ token, decision: 'settled' })
        releaseProjection()
        return { version: 1 }
      }
      if (channel === 'reference-knowledge:v1:refresh-ack') { releaseChild(); return { version: 1 } }
      if (channel === 'db:project-core-get') return { genre: 'canonical' }
      if (channel === 'db:import-run-effect-receipt-get') {
        const global = args[1] === 'global'
        return { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id, effectNamespace: snapshot.effectNamespace,
          effectKey: global ? 'global-facts' : `blueprints:${batchId}`, stage: global ? 'global' : 'blueprints',
          batchId: global ? 'done' : batchId, kind: global ? 'project-global-facts' : 'chapter-blueprint-range',
          payloadHash: 'a'.repeat(64), state: 'committed', payload: {},
          effectReceipt: global ? {} : { operationId: 'op', snapshot: [{}], characterSyncOperation: { operationId: 'sync' } }, createdAt: 'now', updatedAt: 'now' }
      }
      if (channel !== 'reference-run:v1:execute') throw new Error(`Unexpected channel ${channel}`)
      const request = args[0] as { reference: object; execution: object; modelId: string | null }
      expect(request.modelId).toBe(selected)
      const base = { reference: request.reference, execution: request.execution, leaseId: session.leaseId }
      const emit = (event: object) => listeners.get('reference-run:v1:progress')!({ ...base, ...event })
      for (const [index, stage] of ['knowledge', 'global', 'style', 'blueprints'].entries()) {
        const ack = new Promise<void>(resolve => { releaseProjection = resolve })
        emit({ kind: 'stage-skipped', stage, run: snapshot, token, sequence: index + 1 })
        await ack
      }
      emit({ kind: 'stage-started', stage: 'refresh', run: snapshot, sequence: 5 })
      listeners.get('reference-knowledge:v1:refresh-progress')!({ ...base, kind: 'refresh', token, sequence: 1 })
      await childAck
      listeners.get('reference-knowledge:v1:refresh-progress')!({ ...base, kind: 'progress', progress: 100, sequence: 2 })
      const result = { version: 1, run: completed, execution: null, replayed: false }
      const projectionAck = new Promise<void>(resolve => { releaseProjection = resolve })
      emit({ kind: 'stage-completed', token, completion: { stage: 'refresh', result }, sequence: 6 })
      await projectionAck
      return { success: true, ...result }
    })
    const workflow = createActualWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner,
      referenceKnowledge: { reference: { projectId: session.projectId, runId: snapshot.id,
        grantId: '00000000-0000-4000-8000-000000000002', revision: 1 },
      execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER } } })
    const ctx = context()
    ctx.generationModelId = selected ?? undefined
    for (const step of workflow.steps) await step.executor({} as never, ctx, callbacks)
    const channels = ipcMocks.actual.mock.calls.map(call => call[1])
    expect(channels.filter(channel => channel === 'reference-run:v1:execute')).toHaveLength(1)
    for (const channel of ['reference-knowledge:v1:execute', 'reference-knowledge:v1:refresh',
      'import-generation:v1:global', 'import-generation:v1:style', 'import-generation:v1:blueprints',
      'reference-knowledge:v1:resume', 'db:import-run-advance-stage']) expect(channels).not.toContain(channel)
    expect(listeners.size).toBe(0)
  })

  it('waits for A reattachment before projecting a skipped reference stage and uses its new lease', async () => {
    const batchId = '1-1-aaaaaaaa'
    const snapshot = run({ stage: 'knowledge', completedBatches: { blueprints: [batchId] } })
    const completed = run({ stage: 'completed', status: 'completed' })
    const authority = { owner: executionOwner, epoch: 1 }
    const reference = { projectId: session.projectId, runId: snapshot.id,
      grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const token = '00000000-0000-4000-8000-000000000003'
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => { listeners.delete(channel) } })
    const a2 = { ...session, leaseId: 'lease-test-project-return' }
    const project = (view: typeof session, config: Record<string, unknown>) => ({
      id: view.projectId, path: view.projectPath, sessionLease: view.leaseId, name: view.projectId,
      novelConfig: config, characterStates: '', createdAt: '', updatedAt: '',
    })
    const bConfig = { genre: 'B unsaved config' }
    useProjectStore.setState({ currentProject: project(session, { writingStyle: 'A author buffer' }) as never })
    let releaseReturn!: () => void
    let notifyWaiting!: () => void
    const waiting = new Promise<void>(resolve => { notifyWaiting = resolve })
    const receipt: ImportRunEffectReceipt = {
      schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id, effectNamespace: snapshot.effectNamespace,
      effectKey: 'global-facts', stage: 'global', batchId: 'done', kind: 'project-global-facts', payloadHash: 'a'.repeat(64),
      state: 'committed', payload: {}, effectReceipt: {}, createdAt: 'now', updatedAt: 'now',
    }
    const blueprintReceipt: ImportRunEffectReceipt = {
      schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id, effectNamespace: snapshot.effectNamespace,
      effectKey: `blueprints:${batchId}`, stage: 'blueprints', batchId, kind: 'chapter-blueprint-range', payloadHash: 'b'.repeat(64),
      state: 'committed', payload: {}, effectReceipt: { operationId: 'op', snapshot: [{}], characterSyncOperation: { operationId: 'sync' } },
      createdAt: 'now', updatedAt: 'now',
    }
    const stageWaiters = new Map<string, () => void>()
    let sequence = 0
    ipcMocks.invoke.mockImplementation(async (_viewSession, channel: string, ...args: unknown[]) => {
      if (channel === 'reference-run:v1:projection-ack') {
        const ack = args[0] as { stage: string }
        if (ack.stage === 'knowledge') useProjectStore.setState({ currentProject: project(
          { projectId: 'project-b', projectPath: 'C:\\project-b', leaseId: 'lease-b' }, bConfig,
        ) as never })
        stageWaiters.get(ack.stage)?.()
        return { version: 1 }
      }
      if (channel === 'db:import-run-effect-receipt-get') return args[1] === 'global' ? receipt : blueprintReceipt
      if (channel === 'db:project-core-get') return { genre: 'A saved genre', writingStyle: 'A saved style' }
      if (channel === 'reference-run:v1:execute') {
        const request = args[0] as { reference: typeof reference; execution: typeof authority }
        const base = { reference: request.reference, execution: request.execution, leaseId: session.leaseId }
        for (const stage of ['knowledge', 'global', 'style', 'blueprints', 'refresh'] as const) {
          const acked = new Promise<void>(resolve => { stageWaiters.set(stage, resolve) })
          listeners.get('reference-run:v1:progress')!({ ...base, sequence: ++sequence, kind: 'stage-skipped', stage,
            run: run({ stage, completedBatches: { blueprints: [batchId] } }), token })
          await acked
        }
        return { success: true, version: 1, run: completed, execution: null, replayed: false }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createActualWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot,
      executionOwner, referenceKnowledge: { reference, execution: { ...authority, expiresAt: Number.MAX_SAFE_INTEGER } } })
    expect(workflow.backgroundExecution).toBe('reference-run')
    const ctx = context()
    ctx.waitForProjectView = async signal => {
      const current = projectSessionContextFromProject(useProjectStore.getState().currentProject)
      if (current?.projectId === session.projectId && !useProjectStore.getState().loading) {
        ctx.projectionSession = current
        return current
      }
      notifyWaiting()
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('WORKFLOW_CANCELLED'))
        signal?.addEventListener('abort', abort, { once: true })
        releaseReturn = () => {
          signal?.removeEventListener('abort', abort)
          ctx.projectionSession = a2
          resolve(a2)
        }
      })
    }
    await workflow.steps[0]!.executor({} as never, ctx, callbacks)
    const global = workflow.steps[1]!.executor({} as never, ctx, callbacks)
    try {
      await waiting
      expect(useProjectStore.getState().currentProject?.id).toBe('project-b')
      expect(ipcMocks.actual.mock.calls.some(([, channel, ...args]) => channel === 'db:project-core-get' && args[0] === session.projectPath)).toBe(false)
      expect(ipcMocks.actual.mock.calls.some(([, channel, ...args]) => channel === 'reference-run:v1:projection-ack' && (args[0] as { stage: string }).stage === 'global')).toBe(false)
    } finally {
      useProjectStore.setState({ currentProject: project(a2, { writingStyle: 'A saved style' }) as never })
      useProjectStore.getState().updateNovelConfig({ writingStyle: 'A author buffer after return' }, a2)
      releaseReturn()
      await global
      for (const step of workflow.steps.slice(2)) await step.executor({} as never, ctx, callbacks)
    }
    expect(useProjectStore.getState().currentProject?.novelConfig).toMatchObject({ genre: 'A saved genre', writingStyle: 'A author buffer after return' })
    expect(ctx.projectionSession).toEqual(a2)
    expect(bConfig).toEqual({ genre: 'B unsaved config' })
    expect(ipcMocks.actual.mock.calls.filter(([, channel]) => channel === 'reference-run:v1:projection-ack')
      .some(([view]) => (view as ProjectSessionContext).leaseId === a2.leaseId)).toBe(true)
    expect(listeners.size).toBe(0)
  })

  it('publishes the returned A lease before the first projection wait and uses it for workflow completion', async () => {
    const batchId = '1-1-aaaaaaaa'
    const snapshot = run({ completedBatches: { blueprints: [batchId] } })
    const completedRun = run({ stage: 'completed', status: 'completed', completedBatches: { blueprints: [batchId] } })
    const authority = { owner: executionOwner, epoch: 1 }
    const reference = { projectId: session.projectId, runId: snapshot.id,
      grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const token = '00000000-0000-4000-8000-000000000003'
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => {
      listeners.set(channel, listener)
      return () => { listeners.delete(channel) }
    })
    const a2 = { ...session, leaseId: 'lease-test-project-returned' }
    const project = (view: typeof session) => ({ id: view.projectId, path: view.projectPath,
      sessionLease: view.leaseId, name: view.projectId, novelConfig: {} as never,
      characterStates: '', createdAt: '', updatedAt: '' })
    const globalReceipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
      runId: snapshot.id, effectNamespace: snapshot.effectNamespace, effectKey: 'global-facts', stage: 'global',
      batchId: 'done', kind: 'project-global-facts', payloadHash: 'a'.repeat(64), state: 'committed', payload: {},
      effectReceipt: {}, createdAt: 'now', updatedAt: 'now' }
    const blueprintReceipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
      runId: snapshot.id, effectNamespace: snapshot.effectNamespace, effectKey: `blueprints:${batchId}`,
      stage: 'blueprints', batchId, kind: 'chapter-blueprint-range', payloadHash: 'b'.repeat(64), state: 'committed',
      payload: {}, effectReceipt: { operationId: 'op', snapshot: [{}], characterSyncOperation: { operationId: 'sync' } },
      createdAt: 'now', updatedAt: 'now' }
    const ackWaiters = new Map<string, () => void>()
    let sequence = 0
    ipcMocks.invoke.mockImplementation(async (_viewSession, channel: string, ...args: unknown[]) => {
      if (channel === 'fs:check-exists') return false
      if (channel === 'reference-run:v1:projection-ack') {
        ackWaiters.get((args[0] as { stage: string }).stage)?.()
        return { version: 1 }
      }
      if (channel === 'db:import-run-start-resume') {
        return { success: true, start: { run: snapshot, execution: { ...authority, expiresAt: Number.MAX_SAFE_INTEGER } } }
      }
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-renew-execution') {
        return { success: true, execution: { ...authority, expiresAt: Number.MAX_SAFE_INTEGER } }
      }
      if (channel === 'db:import-run-effect-receipt-get') {
        return args[1] === 'global' ? globalReceipt : blueprintReceipt
      }
      if (channel === 'db:project-core-get') return { genre: 'A saved genre', writingStyle: 'A saved style' }
      if (channel !== 'reference-run:v1:execute') throw new Error(`Unexpected channel ${channel}`)

      useProjectStore.setState({ currentProject: project({ ...session, projectId: 'project-b', projectPath: 'C:\\project-b', leaseId: 'lease-b' }) as never })
      useProjectStore.setState({ currentProject: project(a2) as never, loading: true })
      useProjectStore.setState({ loading: false })
      const base = { reference, execution: authority, leaseId: session.leaseId }
      const emit = (event: object) => listeners.get('reference-run:v1:progress')!({ ...base, sequence: ++sequence, ...event })
      const knowledgeAck = new Promise<void>(resolve => { ackWaiters.set('knowledge', resolve) })
      emit({ kind: 'stage-started', stage: 'knowledge', run: snapshot })
      emit({ kind: 'stage-completed', token, completion: { stage: 'knowledge', result: {
        run: run({ stage: 'global' }), execution: { ...authority, expiresAt: Number.MAX_SAFE_INTEGER }, replayed: false,
      } } })
      await knowledgeAck
      for (const stage of ['knowledge', 'global', 'style', 'blueprints'] as const) {
        if (stage === 'knowledge') continue
        const acked = new Promise<void>(resolve => { ackWaiters.set(stage, resolve) })
        emit({ kind: 'stage-skipped', stage, run: run({ stage, completedBatches: { blueprints: [batchId] } }), token })
        await acked
      }
      const refreshAck = new Promise<void>(resolve => { ackWaiters.set('refresh', resolve) })
      emit({ kind: 'stage-started', stage: 'refresh', run: run({ stage: 'refresh', completedBatches: { blueprints: [batchId] } }) })
      emit({ kind: 'stage-completed', token, completion: { stage: 'refresh', result: {
        version: 1, run: completedRun, execution: null, replayed: true,
      } } })
      await refreshAck
      return { success: true, version: 1, run: completedRun, execution: null }
    })
    useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {} })
    vi.stubGlobal('window', { aiNovelAPI: {
      invoke: vi.fn(async (channel: string) => channel === 'skills:list-user' ? [] : false),
      on: vi.fn(() => () => {}), once: vi.fn(),
    } })
    const completed = vi.fn()
    const unsubscribe = globalEventBus.on('WORKFLOW_COMPLETE', completed)
    try {
      await useWorkflowStore.getState().startWorkflow(createActualWorkflow({ projectPath: session.projectPath,
        projectSession: session, run: snapshot, executionOwner,
        referenceKnowledge: { reference, execution: { ...authority, expiresAt: Number.MAX_SAFE_INTEGER } } }))
    } finally {
      unsubscribe()
      vi.unstubAllGlobals()
    }
    expect(ipcMocks.actual.mock.calls.filter(([, channel]) => channel === 'reference-run:v1:projection-ack').map(([view]) => view))
      .toEqual(expect.arrayContaining([expect.objectContaining({ leaseId: a2.leaseId })]))
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ projectSession: a2, runId: snapshot.id }))
    expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')
    expect(listeners.size).toBe(0)
  })

  it.each(['ack-failure', 'cancelled'] as const)('does not advance knowledge after %s', async outcome => {
    const snapshot = run()
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    const reference = { projectId: session.projectId, runId: snapshot.id,
      grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel) })
    const token = '00000000-0000-4000-8000-000000000003'
    ipcMocks.invoke.mockImplementation(async (_session, channel, request) => {
      if (channel === 'reference-run:v1:projection-ack') {
        expect(request).toMatchObject({ stage: 'knowledge', token, decision: outcome === 'cancelled' ? 'cancelled' : 'settled' })
        if (outcome === 'ack-failure') throw new Error('projection ack failed')
        return { version: 1 }
      }
      if (channel !== 'reference-run:v1:execute') throw new Error(`Unexpected channel ${channel}`)
      const base = { reference, execution: { owner: execution.owner, epoch: execution.epoch }, leaseId: session.leaseId }
      const emit = listeners.get('reference-run:v1:progress')!
      emit({ ...base, sequence: 1, kind: 'stage-started', stage: 'knowledge', run: snapshot })
      emit({ ...base, sequence: 2, kind: 'stage-completed', token,
        completion: { stage: 'knowledge', result: { run: { ...snapshot, stage: 'global' }, execution } } })
      return new Promise(() => {})
    })
    const workflow = createActualWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot,
      executionOwner, referenceKnowledge: { reference, execution } })
    const ctx = context()
    ctx.cancelled = outcome === 'cancelled'
    const pending = workflow.steps[0].executor({} as never, ctx, callbacks)
    if (outcome === 'ack-failure') {
      await expect(pending).rejects.toThrow('projection ack failed')
      expect(ipcMocks.revoke).toHaveBeenCalledOnce()
      expect(listeners.size).toBe(0)
    } else await expect(pending).resolves.toBeUndefined()
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual(['reference-run:v1:execute', 'reference-run:v1:projection-ack'])
  })

  it('settles skipped global canonical projection before opening resumed style and preserves the author draft', async () => {
    const snapshot = run({ stage: 'style' })
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    const reference = { projectId: session.projectId, runId: snapshot.id,
      grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const authority = { owner: executionOwner, epoch: 1 }
    const token = '00000000-0000-4000-8000-000000000003'
    const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
    const receipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace, effectKey: 'global-facts', stage: 'global', batchId: 'done',
      kind: 'project-global-facts', payloadHash: 'a'.repeat(64), state: 'committed', payload: {}, effectReceipt: {}, createdAt: 'now', updatedAt: 'now' }
    useEditorStore.setState({ tabs: [{ id: 'config', name: 'config', type: 'config', projectKey: session.projectPath }], activeTabId: 'config', draftLedgers: {} })
    useProjectStore.getState().updateNovelConfig({ writingStyle: 'author draft' }, session)
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel) })
    const publish = vi.spyOn(useProjectStore.getState(), 'publishSavedNovelConfig')
    const persist = vi.spyOn(useProjectStore.getState(), 'commitGeneratedNovelConfig').mockImplementation(async (_generated, expected, _session, _handle, effect) => {
      expect(expected).toMatchObject({ genre: 'canonical genre', writingStyle: 'author draft' })
      await effect!()
      return true
    })
    let releaseCore!: () => void, releaseAck!: () => void, releaseStyle!: () => void
    const coreGate = new Promise<void>(resolve => { releaseCore = resolve })
    let styleStarted = false
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-effect-receipt-get') return receipt
      if (channel === 'db:project-core-get') { await coreGate; return { genre: 'canonical genre', writingStyle: 'saved style' } }
      if (channel === 'generation:read') return { handle, artifacts: [], budget: {} }
      if (channel === 'reference-run:v1:projection-ack') { releaseAck(); return { version: 1 } }
      if (channel === 'import-generation:v1:style-ack') {
        const ack = args[0] as ReferenceStyleAckRequest
        releaseStyle()
        return { version: 1, savedWritingStyle: ack.phase === 'commit' ? 'saved style' : null }
      }
      if (channel !== 'reference-run:v1:execute') throw new Error(`Unexpected channel ${channel}`)
      const base = { reference, execution: authority, leaseId: session.leaseId }
      const emit = (event: object) => listeners.get('reference-run:v1:progress')!({ ...base, ...event })
      let ack = new Promise<void>(resolve => { releaseAck = resolve })
      emit({ kind: 'stage-skipped', stage: 'knowledge', run: snapshot, token, sequence: 1 })
      await ack
      ack = new Promise<void>(resolve => { releaseAck = resolve })
      emit({ kind: 'stage-skipped', stage: 'global', run: snapshot, token, sequence: 2 })
      await ack
      styleStarted = true
      emit({ kind: 'stage-started', stage: 'style', run: snapshot, sequence: 3 })
      const child = listeners.get('import-generation:v1:style-progress')!
      const identity = { projectId: session.projectId, leaseId: session.leaseId, runId: snapshot.id, execution: authority }
      let styleAck = new Promise<void>(resolve => { releaseStyle = resolve })
      child({ ...identity, sequence: 1, kind: 'opened', token: 'open-token', handle, modelId: 'selected-model' })
      await styleAck
      styleAck = new Promise<void>(resolve => { releaseStyle = resolve })
      child({ ...identity, sequence: 2, kind: 'commit-ready', token: 'commit-token', handle, writingStyle: 'generated style' })
      await styleAck
      ack = new Promise<void>(resolve => { releaseAck = resolve })
      emit({ kind: 'stage-completed', token, sequence: 4, completion: { stage: 'style', result: {
        version: 1, run: { ...snapshot, stage: 'blueprints' }, execution, savedWritingStyle: 'saved style', handle, modelId: 'selected-model', replayed: false,
      } } })
      await ack
      return { success: false, error: 'stopped', errorCode: 'TEST_STOPPED' }
    })
    const workflow = createActualWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot,
      executionOwner, referenceKnowledge: { reference, execution } })
    const ctx = context()
    await workflow.steps[0].executor({} as never, ctx, callbacks)
    const global = workflow.steps[1].executor({} as never, ctx, callbacks)
    await Promise.resolve()
    expect(styleStarted).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    releaseCore()
    await global
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ genre: 'canonical genre' }), session, 'unsaved-edits')
    expect(useProjectStore.getState().currentProject?.novelConfig).toMatchObject({ genre: 'canonical genre', writingStyle: 'author draft' })
    await workflow.steps[2].executor({} as never, ctx, callbacks)
    expect(persist).toHaveBeenCalledOnce()
    expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle).toBe('author draft')
    await expect(workflow.steps[3].executor({} as never, ctx, callbacks)).rejects.toMatchObject({ code: 'TEST_STOPPED' })
    expect(listeners.size).toBe(0)
  })
})

describe('createImportWorkflow', () => {
  it.each([false, true])('projects an issued refresh in original order with tree failure=%s', async treeFails => {
    const snapshot = run({ stage: 'refresh', locale: 'en-US' })
    const order: string[] = []
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockImplementation(async () => {
      order.push('tree')
      if (treeFails) throw new Error('tree unavailable')
    })
    vi.spyOn(useCharacterStore.getState(), 'loadCharacters').mockImplementation(async () => { order.push('characters') })
    vi.spyOn(useDraftStore.getState(), 'loadAllDrafts').mockImplementation(async () => { order.push('drafts') })
    vi.spyOn(callbacks, 'log').mockImplementation(message => { order.push(message) })
    vi.spyOn(callbacks, 'setProgress').mockImplementation(value => { order.push(`progress:${value}`) })
    let listener: (event: unknown) => void = () => {}
    const unsubscribe = vi.fn()
    ipcMocks.on.mockImplementation((channel, callback) => {
      if (channel === 'reference-knowledge:v1:refresh-progress') listener = callback
      return unsubscribe
    })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'reference-knowledge:v1:refresh-ack') {
        order.push(`ack:${(args[0] as { decision: string }).decision}`)
        return { version: 1 }
      }
      if (channel === 'reference-knowledge:v1:refresh') {
        const request = args[0] as { reference: object; execution: object }
        const event = { ...request, leaseId: session.leaseId, sequence: 1, kind: 'refresh', token: '00000000-0000-4000-8000-000000000003' }
        listener({ ...event, leaseId: 'other-lease' })
        listener(event)
        listener(event)
        listener({ ...request, leaseId: session.leaseId, sequence: 2, kind: 'progress', progress: 100 })
        return { success: true, version: 1, run: { ...snapshot, stage: 'completed', status: 'completed' }, execution: null, replayed: false }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    const ctx = context()
    await workflow.steps[4].executor({} as never, ctx, callbacks)
    expect(order).toEqual([
      'Refreshing project data...', 'tree',
      ...(treeFails ? ['The derived import file tree did not refresh promptly and was skipped; the core import result is unaffected.'] : []),
      'characters', 'drafts', 'ack:completed', 'progress:100',
    ])
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(ctx.data.importRunExecution).toBeUndefined()
    const channels = ipcMocks.actual.mock.calls.map(call => call[1])
    expect(channels.filter(channel => channel === 'reference-knowledge:v1:refresh-ack')).toHaveLength(1)
    for (const channel of ['db:import-run-renew-execution', 'db:import-run-complete-batch', 'db:import-run-complete', 'db:import-run-fail', 'reference-knowledge:v1:complete']) {
      expect(channels).not.toContain(channel)
    }
  })

  it('retains the original local refresh error when main reports projection failure', async () => {
    const snapshot = run({ stage: 'refresh' })
    const ctx = context()
    const localError = new Error('fixture character projection failed')
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
    vi.spyOn(useCharacterStore.getState(), 'loadCharacters').mockRejectedValue(localError)
    const drafts = vi.spyOn(useDraftStore.getState(), 'loadAllDrafts').mockResolvedValue()
    let listener: (event: unknown) => void = () => {}
    let releaseAck: () => void = () => {}
    const acked = new Promise<void>(resolve => { releaseAck = resolve })
    ipcMocks.on.mockImplementation((_channel, callback) => { listener = callback; return () => {} })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'reference-knowledge:v1:refresh-ack') {
        expect(args[0]).toMatchObject({ decision: 'failed' })
        releaseAck()
        return { version: 1 }
      }
      if (channel === 'reference-knowledge:v1:refresh') {
        listener({ ...(args[0] as object), leaseId: session.leaseId, sequence: 1, kind: 'refresh', token: '00000000-0000-4000-8000-000000000003' })
        await acked
        ctx.cancelRequested = true
        return { success: false, error: 'safe main error', errorCode: 'IMPORT_RUN_REFRESH_PROJECTION_FAILED' }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[4].executor({} as never, ctx, callbacks)).rejects.toBe(localError)
    expect(drafts).not.toHaveBeenCalled()
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).not.toContain('db:import-run-fail')
  })

  it('keeps a hard main failure ahead of a local projection error', async () => {
    const snapshot = run({ stage: 'refresh' })
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
    vi.spyOn(useCharacterStore.getState(), 'loadCharacters').mockRejectedValue(new Error('local projection error'))
    let listener: (event: unknown) => void = () => {}
    let releaseAck: () => void = () => {}
    const acked = new Promise<void>(resolve => { releaseAck = resolve })
    ipcMocks.on.mockImplementation((_channel, callback) => { listener = callback; return () => {} })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'reference-knowledge:v1:refresh-ack') { releaseAck(); return { version: 1 } }
      if (channel === 'reference-knowledge:v1:refresh') {
        listener({ ...(args[0] as object), leaseId: session.leaseId, sequence: 1, kind: 'refresh', token: '00000000-0000-4000-8000-000000000003' })
        await acked
        return { success: false, error: 'storage failed', errorCode: 'IMPORT_RUN_STORAGE_FAILED' }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[4].executor({} as never, context(), callbacks)).rejects.toMatchObject({ message: 'storage failed', code: 'IMPORT_RUN_STORAGE_FAILED' })
  })

  it('delegates completed refresh history without installing a stale cancellation writer', async () => {
    const snapshot = run({ stage: 'completed', status: 'completed' })
    const ctx = context()
    const previous = vi.fn(async () => {})
    ctx.requestMainGenerationCancellation = previous
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'reference-knowledge:v1:refresh') {
        expect(ctx.requestMainGenerationCancellation).toBe(previous)
        return { success: true, version: 1, run: snapshot, execution: null, replayed: true }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await workflow.steps[4].executor({} as never, ctx, callbacks)
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).not.toContain('db:import-run-request-cancel')
  })

  it('requests cancellation with the original lease and acknowledges a cancelled projection', async () => {
    const snapshot = run({ stage: 'refresh' })
    const ctx = context()
    const tree = vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
    let listener: (event: unknown) => void = () => {}
    let releaseAck: () => void = () => {}
    const acked = new Promise<void>(resolve => { releaseAck = resolve })
    ipcMocks.on.mockImplementation((_channel, callback) => { listener = callback; return () => {} })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-request-cancel') {
        expect(args[1]).toMatchObject({ owner: executionOwner, epoch: 1 })
        return { success: true }
      }
      if (channel === 'reference-knowledge:v1:refresh-ack') {
        expect(args[0]).toMatchObject({ decision: 'cancelled' })
        releaseAck()
        return { version: 1 }
      }
      if (channel === 'reference-knowledge:v1:refresh') {
        await ctx.requestMainGenerationCancellation!()
        ctx.cancelRequested = true
        listener({ ...(args[0] as object), leaseId: session.leaseId, sequence: 1, kind: 'refresh', token: '00000000-0000-4000-8000-000000000003' })
        await acked
        return { success: false, error: 'hard failure', errorCode: 'IMPORT_RUN_STORAGE_FAILED' }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[4].executor({} as never, ctx, callbacks)).rejects.toMatchObject({ message: 'hard failure', code: 'IMPORT_RUN_STORAGE_FAILED' })
    expect(tree).not.toHaveBeenCalled()
    expect(ctx.requestMainGenerationCancellation).toBeUndefined()
  })

  it('delegates multiple blueprint ranges with readiness, filtered identity and canonical sync projection', async () => {
    const snapshot = run({ stage: 'blueprints', totalChapters: 2 })
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    const authority = { owner: executionOwner, epoch: 1 }
    const batches = ['1-1-aaaaaaaa', '2-2-bbbbbbbb']
    const handles = batches.map((_, index) => ({ projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: `generation-${index}` }))
    const receipts = batches.map((batchId, index): ImportRunEffectReceipt => ({ schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
      runId: snapshot.id, effectNamespace: snapshot.effectNamespace, effectKey: `blueprints:${batchId}`, stage: 'blueprints', batchId,
      kind: 'chapter-blueprint-range', payloadHash: 'a'.repeat(64), state: 'committed', payload: {},
      effectReceipt: { operationId: `op-${index}`, snapshot: [{}], characterSyncOperation: { operationId: `sync-${index}` } }, createdAt: 'now', updatedAt: 'now' }))
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel) })
    const acks: Array<() => void> = []
    const waits = batches.map(() => new Promise<void>(resolve => { acks.push(resolve) }))
    const order: string[] = []
    const refresh = vi.spyOn(globalEventBus, 'emit').mockImplementation(() => { order.push('refresh') })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'generation:read') {
        const handle = args[0] as typeof handles[number]
        const text = `raw-${handle.runId}`
        return { handle, artifacts: [{ ...handle, artifactId: handle.runId, attemptId: handle.runId,
          text, textHash: createHash('sha256').update(text).digest('hex'), revision: 1, durableRevision: 1, status: 'running' }], budget: {} }
      }
      if (channel === 'import-generation:v1:blueprints-ack') {
        const ack = args[0] as { batchId: string; decision: string }
        const index = batches.indexOf(ack.batchId)
        expect(ack.decision).toBe('accept')
        expect(ipcMocks.actual.mock.calls.some(call => call[1] === 'generation:read' && (call[2] as { runId?: string }).runId === handles[index]!.runId)).toBe(true)
        acks[index]!(); return { version: 1 }
      }
      if (channel === 'db:import-run-effect-receipt-get') return receipts[batches.indexOf(args[2] as string)]
      if (channel === 'db:blueprint-character-sync-get') {
        const operationId = args[0] as string, index = Number(operationId.at(-1))
        return { operationId, status: 'completed', completionReceipt: { operationId, blueprintCommitOperationId: `op-${index}`, status: 'proposal-staged' } }
      }
      if (channel === 'import-generation:v1:blueprints') {
        expect(args[0]).toEqual({ runId: snapshot.id, execution: authority, modelId: 'chosen' })
        const emit = listeners.get('import-generation:v1:blueprints-progress')!
        const identity = { projectId: session.projectId, leaseId: session.leaseId, runId: snapshot.id, execution: authority }
        emit({ ...identity, execution: { ...authority, epoch: 2 }, sequence: 99, kind: 'progress', progress: 99 })
        for (let index = 0; index < 2; index++) {
          const sequence = index * 6
          emit({ ...identity, sequence: sequence + 1, kind: 'opened', batchId: batches[index], token: `token-${index}`, handle: handles[index], modelId: 'chosen' })
          await waits[index]
          emit({ ...identity, sequence: sequence + 2, kind: 'range-committed', batchId: batches[index] })
          emit({ ...identity, sequence: sequence + 3, kind: 'range-synced', batchId: batches[index] })
          emit({ ...identity, sequence: sequence + 4, kind: 'log', value: { key: 'complete', count: 1 } })
          emit({ ...identity, sequence: sequence + 5, kind: 'progress', progress: 100 })
          emit({ ...identity, sequence: sequence + 6, kind: 'progress', progress: index === 0 ? 50 : 99 })
        }
        return { success: true, version: 1, run: { ...snapshot, stage: 'refresh' }, execution, receipt: receipts[1], handle: handles[1], modelId: 'chosen', replayed: false }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const ctx = context(); ctx.generationModelId = 'chosen'
    ctx.data = new Proxy(ctx.data, { set(target, key, value) {
      if (key === 'blueprintCommitReceipt') order.push('commit')
      if (key === 'blueprintCharacterSyncReceipt') order.push('sync')
      return Reflect.set(target, key, value)
    } })
    const local = {
      log: vi.fn((message: string) => { order.push(message.includes('蓝图推演完成') ? 'complete' : 'other-project') }),
      setProgress: vi.fn((progress: number) => { order.push(`progress:${progress}`) }), appendText: vi.fn(),
    }
    await createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }).steps[3].executor({} as never, ctx, local)
    expect(ctx.data.blueprintCommitReceipt).toEqual(receipts[1]!.effectReceipt)
    expect(ctx.data.blueprintCharacterSyncReceipt).toMatchObject({ operationId: 'sync-1' })
    expect(local.setProgress.mock.calls.map(call => call[0])).toEqual([100, 50, 100, 99])
    expect(local.log).toHaveBeenCalledTimes(2)
    expect(local.log).toHaveBeenCalledWith('蓝图推演完成：1 章已一次提交')
    expect(local.appendText.mock.calls.map(call => call[0]).filter(Boolean)).toEqual(['raw-generation-0', 'raw-generation-1'])
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledWith('REFRESH_RESOURCE', { resources: ['fileTree', 'blueprints'], projectPath: session.projectPath, projectSession: session })
    expect(order).toEqual([
      'commit', 'sync', 'complete', 'progress:100', 'refresh', 'progress:50',
      'commit', 'sync', 'complete', 'progress:100', 'refresh', 'progress:99',
    ])
    expect(ipcMocks.actual.mock.calls.some(call => ['db:import-run-fail', 'db:import-run-advance-stage', 'db:blueprint-character-sync-complete'].includes(call[1]))).toBe(false)
    expect([...listeners.keys()]).toEqual(['import-generation:v1:blueprints-progress'])
  })

  it.each([null, { projectId: session.projectId, epoch: 'old-lease', rootActionId: 'old-root', runId: 'old-generation' }])(
    'keeps historical blueprint replay read-only and clears the completed lease with handle %s', async historicalHandle => {
    const snapshot = run({ stage: 'completed', status: 'completed' })
    const batchId = '1-1-aaaaaaaa'
    const receipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace, effectKey: `blueprints:${batchId}`, stage: 'blueprints', batchId, kind: 'chapter-blueprint-range',
      payloadHash: 'a'.repeat(64), state: 'committed', payload: {}, effectReceipt: { operationId: 'old', snapshot: [{}], characterSyncOperation: { operationId: 'sync-old' } }, createdAt: 'now', updatedAt: 'now' }
    const refresh = vi.spyOn(globalEventBus, 'emit')
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-effect-receipt-get') return receipt
      if (channel === 'import-generation:v1:blueprints') return { success: true, version: 1, run: snapshot, execution: null, receipt, handle: historicalHandle, modelId: null, replayed: true }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const ctx = context(); ctx.data.importRunExecution = { owner: executionOwner, epoch: 1, expiresAt: 1 }
    ctx.data.blueprintCommitReceipt = 'existing'; ctx.data.blueprintCharacterSyncReceipt = 'existing-sync'
    await createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }).steps[3].executor({} as never, ctx, callbacks)
    expect(ctx.data.blueprintCommitReceipt).toBe('existing')
    expect(ctx.data.blueprintCharacterSyncReceipt).toBe('existing-sync')
    expect(ctx.data.importRunExecution).toBeUndefined()
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each([
    { stage: 'refresh' as const, status: 'running' as const, replayed: true },
    { stage: 'completed' as const, status: 'completed' as const, replayed: false },
  ])('rejects null blueprint execution outside completed replay: $stage/$replayed', async ({ stage, status, replayed }) => {
    const snapshot = run({ stage: 'blueprints' })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:blueprints') return { success: true, version: 1,
        run: { ...snapshot, stage, status }, execution: null, receipt: { batchId: '1-1-aaaaaaaa' }, handle: null, modelId: null, replayed }
      throw new Error(`Unexpected channel ${channel}`)
    })
    await expect(createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }).steps[3]
      .executor({} as never, context(), callbacks)).rejects.toThrow('GENERATION_REQUEST_FAILED')
    expect(ipcMocks.actual.mock.calls.some(call => call[1] === 'db:import-run-fail')).toBe(false)
  })

  it.each([
    { errorCode: 'GENERATION_REQUEST_FAILED', postCommitSyncBatchId: undefined },
    { errorCode: 'GENERATION_REQUEST_FAILED', postCommitSyncBatchId: 'not-a-batch' },
    { errorCode: 'GENERATION_PROVIDER_FAILED', postCommitSyncBatchId: '1-1-aaaaaaaa' },
  ])('rejects invalid postcommit metadata: $errorCode/$postCommitSyncBatchId', async failure => {
    const snapshot = run({ stage: 'blueprints' })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:blueprints') return { success: false, error: 'failure', ...failure }
      throw new Error(`Unexpected channel ${channel}`)
    })
    await expect(createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }).steps[3]
      .executor({} as never, context(), callbacks)).rejects.toThrow('GENERATION_REQUEST_FAILED')
  })

  it('reconstructs postcommit sync failure from the canonical blueprint receipt without a renderer writer', async () => {
    const snapshot = run({ stage: 'blueprints' }), batchId = '1-1-aaaaaaaa'
    const receipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace, effectKey: `blueprints:${batchId}`, stage: 'blueprints', batchId, kind: 'chapter-blueprint-range',
      payloadHash: 'a'.repeat(64), state: 'committed', payload: {}, effectReceipt: { operationId: 'op-1', snapshot: [{}], characterSyncOperation: { operationId: 'sync-1' } }, createdAt: 'now', updatedAt: 'now' }
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-effect-receipt-get') return receipt
      if (channel === 'import-generation:v1:blueprints') return { success: false, errorCode: 'GENERATION_REQUEST_FAILED', error: 'main sync failure', postCommitSyncBatchId: batchId }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const ctx = context()
    await expect(createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }).steps[3].executor({} as never, ctx, callbacks))
      .rejects.toMatchObject({ retryOperationId: 'sync-1', commitReceipt: receipt.effectReceipt })
    expect(ctx.data.blueprintCommitReceipt).toEqual(receipt.effectReceipt)
    expect(ipcMocks.actual.mock.calls.some(call => ['db:import-run-fail', 'db:import-run-cancel-at-boundary', 'db:blueprint-character-sync-complete'].includes(call[1]))).toBe(false)
  })

  it('keeps the main blueprint failure ahead of a prior receipt projection error', async () => {
    const snapshot = run({ stage: 'blueprints' })
    let emit: ((event: unknown) => void) | undefined
    ipcMocks.on.mockImplementation((channel, listener) => { if (channel === 'import-generation:v1:blueprints-progress') emit = listener; return () => {} })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-effect-receipt-get') throw new Error('projection failure')
      if (channel === 'import-generation:v1:blueprints') {
        emit?.({ projectId: session.projectId, leaseId: session.leaseId, runId: snapshot.id, execution: { owner: executionOwner, epoch: 1 }, sequence: 1, kind: 'range-committed', batchId: '1-1-aaaaaaaa' })
        return { success: false, errorCode: 'GENERATION_PROVIDER_FAILED', error: 'provider failure' }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    await expect(createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }).steps[3].executor({} as never, context(), callbacks))
      .rejects.toMatchObject({ message: 'provider failure', code: 'GENERATION_PROVIDER_FAILED' })
    expect(ipcMocks.actual.mock.calls.some(call => call[1] === 'db:import-run-fail')).toBe(false)
  })

  it('delegates issued global after snapshot readiness and projects committed facts without a draft gate', async () => {
    const snapshot = run({ stage: 'global' })
    useEditorStore.setState({ tabs: [{ id: 'config', name: 'config', type: 'config', projectKey: session.projectPath }], activeTabId: 'config', draftLedgers: {} })
    useProjectStore.getState().updateNovelConfig({ genre: 'author draft' }, session)
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    const authority = { owner: executionOwner, epoch: 1 }
    const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
    const receipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace, effectKey: 'global-facts', stage: 'global', batchId: 'done',
      kind: 'project-global-facts', payloadHash: 'a'.repeat(64), state: 'committed', payload: {}, effectReceipt: { core: { genre: 'A' } }, createdAt: 'now', updatedAt: 'now' }
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel) })
    let ready!: () => void
    const opened = new Promise<void>(resolve => { ready = resolve })
    const emitRefresh = vi.spyOn(globalEventBus, 'emit')
    const cas = vi.spyOn(useProjectStore.getState(), 'commitGeneratedNovelConfig')
    const event = (sequence: number, payload: object) => ({ projectId: session.projectId, leaseId: session.leaseId, runId: snapshot.id, execution: authority, sequence, ...payload })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, request: unknown) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'generation:read') return { handle, artifacts: [], budget: {} }
      if (channel === 'import-generation:v1:global-ack') {
        expect(request).toEqual({ runId: snapshot.id, execution: authority, token: 'open', decision: 'accept' })
        expect(ipcMocks.actual.mock.calls.some(call => call[1] === 'generation:read')).toBe(true)
        ready(); return { version: 1 }
      }
      if (channel === 'db:import-run-effect-receipt-get') return receipt
      if (channel === 'db:project-core-get') return { genre: 'B', coreOutline: 'outline' }
      if (channel === 'import-generation:v1:global') {
        expect(request).toEqual({ runId: snapshot.id, execution: authority, modelId: 'selected-model' })
        const emit = listeners.get('import-generation:v1:global-progress')!
        emit(event(1, { kind: 'opened', token: 'open', handle, modelId: 'selected-model' }))
        await opened
        emit(event(2, { kind: 'log', value: { key: 'retrieved', topic: 'worldview', count: 2 } }))
        emit(event(3, { kind: 'progress', progress: 70 }))
        emit(event(4, { kind: 'candidate', content: '{candidate}' }))
        emit(event(5, { kind: 'committed' }))
        return { success: true, version: 1, run: { ...snapshot, stage: 'style' }, execution, receipt, handle, modelId: 'selected-model', replayed: false }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    const ctx = context(); ctx.generationModelId = 'selected-model'
    await workflow.steps[1].executor({} as never, ctx, callbacks)
    expect(cas).not.toHaveBeenCalled()
    expect(useProjectStore.getState().currentProject?.novelConfig.genre).toBe('author draft')
    expect(ctx.data.importGlobalInferenceCandidate).toBe('{candidate}')
    expect(ctx.data.importGlobalFactsReceipt).toEqual(receipt.effectReceipt)
    expect(ctx.data.novelConfigSummary).toContain('B')
    expect(callbacks.log).toHaveBeenCalledWith('  已检索「世界观与力量体系」— 2 条结果')
    expect(callbacks.setProgress).toHaveBeenCalledWith(70)
    expect(emitRefresh).toHaveBeenCalledWith('REFRESH_RESOURCE', { resources: ['fileTree', 'characterCards'], projectPath: session.projectPath, projectSession: session })
    expect(ipcMocks.actual.mock.calls.some(call => ['db:import-run-effect-receipt-prepare', 'db:import-run-effect-receipt-commit', 'db:import-run-advance-stage', 'db:import-run-fail'].includes(call[1]))).toBe(false)
    expect([...listeners.keys()]).toEqual(['import-generation:v1:global-progress'])
  })

  it.each([false, true])('projects current core B rather than historical receipt A on global replay, dirty=%s', async dirty => {
    const snapshot = run({ stage: 'completed', status: 'completed', resumable: false })
    const receipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace, effectKey: 'global-facts', stage: 'global', batchId: 'done',
      kind: 'project-global-facts', payloadHash: 'a'.repeat(64), state: 'committed', payload: {}, effectReceipt: { core: { genre: 'A' } }, createdAt: 'now', updatedAt: 'now' }
    useEditorStore.setState({ tabs: [{ id: 'config', name: 'config', type: 'config', projectKey: session.projectPath }], activeTabId: 'config', draftLedgers: {} })
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, genre: 'B' } } })
    if (dirty) useProjectStore.getState().updateNovelConfig({ genre: 'C' }, session)
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:global') return { success: true, version: 1, run: snapshot, execution: null, receipt, handle: null, modelId: null, replayed: true }
      if (channel === 'db:import-run-effect-receipt-get') return receipt
      if (channel === 'db:project-core-get') return { genre: 'B' }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const ctx = context()
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await workflow.steps[1].executor({} as never, ctx, callbacks)
    expect(useProjectStore.getState().currentProject?.novelConfig.genre).toBe(dirty ? 'C' : 'B')
    expect(ctx.data.novelConfigSummary).toContain('B')
    if (dirty) { useProjectStore.getState().discardNovelConfigDraft(session.projectPath, session); expect(useProjectStore.getState().currentProject?.novelConfig.genre).toBe('B') }
  })

  it('keeps a raw global candidate and main failure ahead of projection failure', async () => {
    const snapshot = run({ stage: 'global' })
    let emit: ((event: unknown) => void) | undefined
    ipcMocks.on.mockImplementation((_channel, listener) => { emit = listener; return () => {} })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:global') {
        const identity = { projectId: session.projectId, leaseId: session.leaseId, runId: snapshot.id, execution: { owner: executionOwner, epoch: 1 } }
        emit?.({ ...identity, sequence: 1, kind: 'candidate', content: 'raw invalid candidate' })
        emit?.({ ...identity, sequence: 2, kind: 'committed' })
        return { success: false, error: 'provider failure', errorCode: 'GENERATION_PROVIDER_FAILED' }
      }
      if (channel === 'db:import-run-effect-receipt-get') throw new Error('projection failed')
      throw new Error(`Unexpected channel ${channel}`)
    })
    const ctx = context()
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[1].executor({} as never, ctx, callbacks)).rejects.toMatchObject({ message: 'provider failure', code: 'GENERATION_PROVIDER_FAILED' })
    expect(ctx.data.importGlobalInferenceCandidate).toBe('raw invalid candidate')
    expect(ipcMocks.actual.mock.calls.some(call => call[1] === 'db:import-run-fail')).toBe(false)
  })

  it('reports postcommit projection failure without writing a main terminal failure', async () => {
    const snapshot = run({ stage: 'style' })
    const receipt: ImportRunEffectReceipt = { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: snapshot.id,
      effectNamespace: snapshot.effectNamespace, effectKey: 'global-facts', stage: 'global', batchId: 'done',
      kind: 'project-global-facts', payloadHash: 'a'.repeat(64), state: 'committed', payload: {}, effectReceipt: {}, createdAt: 'now', updatedAt: 'now' }
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:global') return { success: true, version: 1, run: snapshot,
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }, receipt, handle: null, modelId: null, replayed: true }
      if (channel === 'db:import-run-effect-receipt-get') throw new Error('projection failed')
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[1].executor({} as never, context(), callbacks)).rejects.toThrow('projection failed')
    expect(ipcMocks.actual.mock.calls.some(call => call[1] === 'db:import-run-fail')).toBe(false)
  })

  it('rejects a null execution lease for a noncompleted global replay', async () => {
    const snapshot = run({ stage: 'style' })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:global') return { success: true, version: 1, run: snapshot,
        execution: null, receipt: {}, handle: null, modelId: null, replayed: true }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[1].executor({} as never, context(), callbacks)).rejects.toThrow('GENERATION_REQUEST_FAILED')
  })
  it('delegates issued style through opened and commit ACKs without renderer effect writers', async () => {
    const snapshot = run({ stage: 'style' })
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    const authority = { owner: executionOwner, epoch: 1 }
    const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel) })
    let opened!: () => void, committed!: () => void
    const openedAck = new Promise<void>(resolve => { opened = resolve })
    const commitAck = new Promise<void>(resolve => { committed = resolve })
    const persist = vi.spyOn(useProjectStore.getState(), 'commitGeneratedNovelConfig').mockImplementation(async (_generated, _expected, _session, _handle, effect) => {
      await effect!()
      return true
    })
    const event = (sequence: number, payload: object) => ({ projectId: session.projectId, leaseId: session.leaseId,
      runId: snapshot.id, execution: authority, sequence, ...payload })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, request: unknown) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'generation:read') return { handle, artifacts: [], budget: {} }
      if (channel === 'import-generation:v1:style-ack') {
        const ack = request as ReferenceStyleAckRequest
        if (ack.phase === 'opened') { expect(ack.decision).toBe('accept'); opened() }
        else { expect(ack.decision).toBe('accept'); committed() }
        return { version: 1, savedWritingStyle: ack.phase === 'commit' ? 'saved style' : null }
      }
      if (channel === 'import-generation:v1:style') {
        expect(request).toEqual({ runId: snapshot.id, execution: authority, modelId: 'selected-model' })
        const emit = listeners.get('import-generation:v1:style-progress')!
        emit(event(1, { kind: 'opened', token: 'open-token', handle, modelId: 'selected-model' }))
        await openedAck
        emit(event(2, { kind: 'progress', progress: 10 }))
        emit(event(3, { kind: 'commit-ready', token: 'commit-token', handle, writingStyle: 'generated style' }))
        await commitAck
        return { success: true, version: 1, run: { ...snapshot, stage: 'blueprints' }, execution,
          savedWritingStyle: 'saved style', handle, modelId: 'selected-model', replayed: false }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    const stepContext = context(); stepContext.generationModelId = 'selected-model'
    await workflow.steps[2].executor({} as never, stepContext, callbacks)
    expect(persist).toHaveBeenCalledOnce()
    expect(stepContext.data.importRunExecution).toEqual(execution)
    expect(stepContext.data.novelConfigSummary).toContain('类型:')
    expect(ipcMocks.actual.mock.calls.some(call => ['db:import-run-effect-receipt-prepare', 'db:import-run-effect-receipt-commit',
      'db:import-run-advance-stage', 'db:import-run-fail'].includes(call[1]))).toBe(false)
    expect([...listeners.keys()]).toEqual(['import-generation:v1:style-progress'])
  })

  it.each([[false, false], [false, true], [true, false], [true, true]])('projects current core for an old-view replay with completed=%s dirty=%s', async (completed, dirty) => {
    const snapshot = completed ? run({ stage: 'completed', status: 'completed', resumable: false, completedChapters: 1 }) : run({ stage: 'blueprints' })
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    useEditorStore.setState({ tabs: [{ id: 'config', name: 'config', type: 'config', projectKey: session.projectPath }], activeTabId: 'config', draftLedgers: {} })
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, writingStyle: 'B' } } })
    if (dirty) useProjectStore.getState().updateNovelConfig({ writingStyle: 'C' }, session)
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:style') return { success: true, version: 1, run: snapshot, execution: completed ? null : execution,
        savedWritingStyle: 'A', handle: { projectId: session.projectId, epoch: 'old-view', rootActionId: 'root', runId: 'generation' }, modelId: null, replayed: true }
      if (channel === 'db:project-core-get') return { writingStyle: 'B' }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const publish = vi.spyOn(useProjectStore.getState(), 'publishSavedNovelConfig')
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    const stepContext = context()
    stepContext.data.importRunExecution = execution
    await workflow.steps[2].executor({} as never, stepContext, callbacks)
    expect(stepContext.data.importRunExecution).toEqual(completed ? undefined : execution)
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ writingStyle: 'B' }), session, 'unsaved-edits')
    expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle).toBe(dirty ? 'C' : 'B')
    if (dirty) {
      useProjectStore.getState().discardNovelConfigDraft(session.projectPath, session)
      expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle).toBe('B')
    }
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual(['reference-run:v1:execute', 'db:project-core-get', 'reference-run:v1:projection-ack'])
  })

  it.each([
    { stage: 'blueprints', status: 'running' },
    { stage: 'completed', status: 'running' },
    { stage: 'blueprints', status: 'completed' },
  ] as const)('rejects a null lease outside completed replay: $stage / $status', async state => {
    const snapshot = run(state)
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:style') return { success: true, version: 1, run: snapshot, execution: null,
        savedWritingStyle: 'A', handle: null, modelId: null, replayed: true }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[2].executor({} as never, context(), callbacks)).rejects.toThrow('GENERATION_REQUEST_FAILED')
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).not.toContain('import-generation:v1:style')
  })

  it('rejects a null lease on a non-replayed result even with a valid opened handle', async () => {
    const snapshot = run({ stage: 'style' })
    const authority = { owner: executionOwner, epoch: 1 }
    const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel) })
    let opened!: () => void
    const openedAck = new Promise<void>(resolve => { opened = resolve })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'generation:read') return { handle, artifacts: [], budget: {} }
      if (channel === 'import-generation:v1:style-ack') { opened(); return { version: 1, savedWritingStyle: null } }
      if (channel === 'import-generation:v1:style') {
        listeners.get('import-generation:v1:style-progress')!({ projectId: session.projectId, leaseId: session.leaseId,
          runId: snapshot.id, execution: authority, sequence: 1, kind: 'opened', token: 'open-token', handle, modelId: 'selected-model' })
        await openedAck
        return { success: true, version: 1, run: { ...snapshot, stage: 'blueprints' }, execution: null,
          savedWritingStyle: 'A', handle, modelId: 'selected-model', replayed: false }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[2].executor({} as never, context(), callbacks)).rejects.toThrow('GENERATION_REQUEST_FAILED')
    expect(ipcMocks.actual.mock.calls.some(call => call[1] === 'db:project-core-get')).toBe(false)
  })

  it.each([
    { projectId: 'other-project', epoch: 'old-view', rootActionId: 'root', runId: 'generation' },
    { projectId: session.projectId, epoch: 'old-view', rootActionId: '', runId: 'generation' },
    { projectId: session.projectId, epoch: 'old-view', rootActionId: 'root', runId: '' },
  ])('rejects a malformed historical replay handle', async handle => {
    const snapshot = run({ stage: 'blueprints' })
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:style') return { success: true, version: 1, run: snapshot, execution,
        savedWritingStyle: 'A', handle, modelId: null, replayed: true }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[2].executor({} as never, context(), callbacks)).rejects.toThrow('GENERATION_REQUEST_FAILED')
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).not.toContain('import-generation:v1:style')
  })

  it.each(['draft-changed', 'saved-with-newer-draft'] as const)('keeps the %s CAS result separate from main terminal writes', async mode => {
    const snapshot = run({ stage: 'style' })
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    const authority = { owner: executionOwner, epoch: 1 }
    const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel) })
    let opened!: () => void, committed!: () => void
    const openedAck = new Promise<void>(resolve => { opened = resolve })
    const commitAck = new Promise<void>(resolve => { committed = resolve })
    vi.spyOn(useProjectStore.getState(), 'commitGeneratedNovelConfig').mockImplementation(async (_generated, _expected, _session, _handle, effect) => {
      if (mode === 'draft-changed') throw new Error('GENERATION_AUTHOR_DRAFT_CHANGED')
      await effect!()
      throw new Error('GENERATION_SAVED_WITH_NEWER_AUTHOR_DRAFT')
    })
    const event = (sequence: number, payload: object) => ({ projectId: session.projectId, leaseId: session.leaseId,
      runId: snapshot.id, execution: authority, sequence, ...payload })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string, request: unknown) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'generation:read') return { handle, artifacts: [], budget: {} }
      if (channel === 'import-generation:v1:style-ack') {
        const ack = request as ReferenceStyleAckRequest
        if (ack.phase === 'opened') opened()
        else { expect(ack.decision).toBe(mode === 'draft-changed' ? 'draft-changed' : 'accept'); committed() }
        return { version: 1, savedWritingStyle: ack.phase === 'commit' && ack.decision === 'accept' ? 'saved style' : null }
      }
      if (channel === 'import-generation:v1:style') {
        const emit = listeners.get('import-generation:v1:style-progress')!
        emit(event(1, { kind: 'opened', token: 'open-token', handle, modelId: 'selected-model' }))
        await openedAck
        emit(event(2, { kind: 'commit-ready', token: 'commit-token', handle, writingStyle: 'generated style' }))
        await commitAck
        if (mode === 'draft-changed') return { success: false, errorCode: 'GENERATION_AUTHOR_DRAFT_CHANGED', error: 'changed' }
        return { success: true, version: 1, run: { ...snapshot, stage: 'blueprints' }, execution,
          savedWritingStyle: 'saved style', handle, modelId: 'selected-model', replayed: false }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[2].executor({} as never, context(), callbacks)).rejects.toThrow(mode === 'draft-changed'
      ? 'GENERATION_AUTHOR_DRAFT_CHANGED' : 'GENERATION_SAVED_WITH_NEWER_AUTHOR_DRAFT')
    expect(ipcMocks.actual.mock.calls.some(call => ['db:import-run-fail', 'db:import-run-cancel-at-boundary'].includes(call[1]))).toBe(false)
  })

  it('preserves the main style error and code without renderer failure writes', async () => {
    const snapshot = run({ stage: 'style' })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:style') return { success: false, error: 'safe explanation', errorCode: 'IMPORT_STYLE_FAILED' }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[2].executor({} as never, context(), callbacks)).rejects.toMatchObject({ message: 'safe explanation', code: 'IMPORT_STYLE_FAILED' })
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).not.toContain('import-generation:v1:style')
  })

  it('preserves a main hard failure when an earlier projection has failed', async () => {
    const snapshot = run({ stage: 'style' })
    const authority = { owner: executionOwner, epoch: 1 }
    const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
    const listeners = new Map<string, (event: unknown) => void>()
    ipcMocks.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel) })
    let opened!: () => void
    const openedAck = new Promise<void>(resolve => { opened = resolve })
    let reads = 0
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'generation:read') {
        if (++reads > 1) throw new Error('late projection read failed')
        return { handle, artifacts: [], budget: {} }
      }
      if (channel === 'import-generation:v1:style-ack') { opened(); return { version: 1, savedWritingStyle: null } }
      if (channel === 'import-generation:v1:style') {
        const emit = listeners.get('import-generation:v1:style-progress')!
        const identity = { projectId: session.projectId, leaseId: session.leaseId, runId: snapshot.id, execution: authority }
        emit({ ...identity, sequence: 1, kind: 'opened', token: 'open-token', handle, modelId: 'selected-model' })
        await openedAck
        emit({ ...identity, sequence: 2, kind: 'log', log: 'calling-ai' })
        return { success: false, errorCode: 'GENERATION_PROVIDER_FAILED', error: 'safe provider failure' }
      }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    const failingCallbacks = { ...callbacks, log: () => { throw new Error('projection failed') } }
    await expect(workflow.steps[2].executor({} as never, context(), failingCallbacks)).rejects.toMatchObject({
      message: 'safe provider failure', code: 'GENERATION_PROVIDER_FAILED',
    })
    expect(reads).toBe(1)
    expect(ipcMocks.actual.mock.calls.some(call => ['db:import-run-fail', 'db:import-run-cancel-at-boundary'].includes(call[1]))).toBe(false)
  })

  it('uses the registered generation error for a malformed style response', async () => {
    const snapshot = run({ stage: 'style' })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:style') return { success: true, run: { ...snapshot, stage: 'blueprints' } }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[2].executor({} as never, context(), callbacks)).rejects.toThrow('GENERATION_REQUEST_FAILED')
  })

  it('rejects a style completion without the whole-run envelope identity', async () => {
    const snapshot = run({ stage: 'style' })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'import-generation:v1:style') return { success: true }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await expect(workflow.steps[2].executor({} as never, context(), callbacks)).rejects.toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
  })

  it.each([
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
    const workflow = createActualWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner, ...(author ? { authorChapterNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } : {}) })
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

  it.each([['global', 1, 'style']] as const)(
    'does not rediscover chapters or regenerate a completed %s checkpoint', async (stage, stepIndex, nextStage) => {
      const snapshot = run({ stage, completedBatches: { [stage]: ['done'] } })
      const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
      const receipt: ImportRunEffectReceipt = {
        schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION,
        runId: snapshot.id, effectNamespace: snapshot.effectNamespace, effectKey: 'global-facts',
        stage: 'global', batchId: 'done', kind: 'project-global-facts', payloadHash: 'c'.repeat(64),
        state: 'committed', payload: {}, effectReceipt: { core: { genre: 'saved' } },
        createdAt: '2026-01-01', updatedAt: '2026-01-01',
      }
      ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
        switch (channel) {
          case 'db:import-run-get': return snapshot
          case 'import-generation:v1:global': return { success: true, version: 1, run: { ...snapshot, stage: nextStage },
            execution, receipt, handle: null, modelId: null, replayed: true }
          case 'db:import-run-effect-receipt-get': return receipt
          case 'db:project-core-get': return { genre: 'saved' }
          default: throw new Error(`Unexpected channel ${channel}`)
        }
      })
      const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })

      await workflow.steps[stepIndex].executor({} as never, context(), callbacks)

      expect(commandMocks.global).not.toHaveBeenCalled()
      expect(commandMocks.style).not.toHaveBeenCalled()
      expect(ipcMocks.invoke).toHaveBeenCalledWith(session, 'import-generation:v1:global', expect.objectContaining({
        runId: snapshot.id, execution: { owner: executionOwner, epoch: 1 },
      }))
      expect(ipcMocks.invoke.mock.calls.some(call => ['db:import-run-list-representative-chapters', 'db:import-run-list-chapters',
        'generation:begin', 'import-generation:execute', 'db:import-run-advance-stage', 'db:import-run-effect-receipt-commit'].includes(call[1]))).toBe(false)
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

  it('builds author blueprint prompt context in the frozen project writing language, not the UI locale', async () => {
    const snapshot = run({ purpose: 'author-manuscript', authorInference: true, effectNamespace: 'import:author-manuscript:import-run-1', stage: 'blueprints' })
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
      if (channel === 'db:blueprint-get-all') return []
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
    const workflow = createActualWorkflow({
      projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner, authorChapterNumbers: [1],
    })
    const frozenContext = { ...context(), writingLanguage: 'en-US' as const, uiLocale: 'zh-CN' as const }

    await expect(workflow.steps[5].executor({} as never, frozenContext, callbacks))
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
    expect(ipcMocks.actual).toHaveBeenCalledWith(session, 'reference-run:v1:execute', expect.objectContaining({ reference, execution: authority }))
    expect(stepCallbacks.log).toHaveBeenCalledExactlyOnceWith('参照章节 1 已进入知识库（已存在）')
    expect(stepCallbacks.setProgress).toHaveBeenCalledExactlyOnceWith(42)
    expect(stepContext.data.importRunExecution).toEqual(execution)
    expect(unsubscribe).not.toHaveBeenCalled()
    listener({ reference, execution: authority, kind: 'batch', progress: 50 })
    expect(stepCallbacks.setProgress).toHaveBeenCalledOnce()
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual(['reference-run:v1:execute', 'reference-run:v1:projection-ack'])
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
      expect(ipcMocks.actual.mock.calls.map(call => call[1])).not.toContain('reference-knowledge:v1:execute')
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
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual(['reference-run:v1:execute'])
  })

  it('does not re-execute knowledge after the persisted stage has advanced', async () => {
    const snapshot = run({ stage: 'global' })
    ipcMocks.invoke.mockImplementation(async () => new Promise(() => {}))
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner })
    await workflow.steps[0].executor({} as never, context(), callbacks)
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual(['reference-run:v1:execute', 'reference-run:v1:projection-ack'])
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

  it('keeps the author refresh completion on the legacy path', async () => {
    const snapshot = run({ purpose: 'author-manuscript', stage: 'refresh', completedBatches: { refresh: ['done'] } })
    const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'db:import-run-start-resume') return { success: true, start: { run: snapshot, execution } }
      if (channel === 'db:import-run-renew-execution') return { success: true, execution }
      if (channel === 'db:import-run-complete') return { success: true, run: { ...snapshot, status: 'completed' } }
      if (channel === 'db:import-run-fail') return { success: true, run: snapshot }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner, authorChapterNumbers: [1] })
    await expect(workflow.steps[3].executor({} as never, context(), callbacks)).resolves.toBeUndefined()
    const channels = ipcMocks.actual.mock.calls.map(call => call[1])
    expect(channels.indexOf('db:import-run-complete')).toBeGreaterThanOrEqual(0)
    expect(channels).not.toContain('reference-knowledge:v1:complete')
    expect(channels).not.toContain('reference-knowledge:v1:refresh')
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
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:global') return { success: true, version: 1, run: { ...snapshot, stage: 'style' },
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }, receipt, handle: null, modelId: null, replayed: true }
      if (channel === 'db:import-run-effect-receipt-get') return { ...receipt, payloadHash: 'd'.repeat(64) }
      if (channel === 'db:project-core-get') return { genre: 'B' }
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: snapshot,
      executionOwner,
    })

    const failure = await workflow.steps[1].executor({} as never, context(), callbacks).catch((error: Error) => error)
    expect((failure as Error).message).toBe('GENERATION_REQUEST_FAILED')
  })

  it('resumes a checkpointed blueprint batch by completing its pending character sync without generation', async () => {
    const checkpoint = '1-1-cccccccc'
    const snapshot = run({
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
      effectReceipt: { operationId: 'op-1', snapshot: [{}], characterSyncOperation: { operationId: 'sync-1' } },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:blueprints') return {
        success: true, version: 1, run: { ...snapshot, stage: 'refresh' },
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER },
        receipt, handle: null, modelId: null, replayed: true,
      }
      if (channel === 'db:import-run-effect-receipt-get') return receipt
      throw new Error(`Unexpected channel ${channel}`)
    })
    const workflow = createImportWorkflow({
      projectPath: session.projectPath,
      projectSession: session,
      run: snapshot,
      executionOwner,
    })

    await workflow.steps[3].executor({} as never, context(), callbacks)

    expect(characterSyncMocks.retry).not.toHaveBeenCalled()
    expect(ipcMocks.actual.mock.calls.map(call => call[1])).toEqual([
      'reference-run:v1:execute', 'db:import-run-effect-receipt-get', 'reference-run:v1:projection-ack',
    ])
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

describe('issued global workflow failure projection', () => {
  async function failGlobal(locale: 'zh-CN' | 'en-US', reply: {
    success: false; error: string; errorCode: string; completionFailureCode?: unknown
  }) {
    const snapshot = run({ stage: 'global', locale })
    ipcMocks.invoke.mockImplementation(async (_session, channel: string) => {
      if (channel === 'db:import-run-get') return snapshot
      if (channel === 'import-generation:v1:global') return reply
      if (channel === 'fs:check-exists') return false
      throw new Error(`Unexpected channel ${channel}`)
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async (channel: string) => channel === 'skills:list-user' ? [] : false), on: vi.fn(() => () => {}), once: vi.fn() } })
    useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {} })
    try {
      await useWorkflowStore.getState().startWorkflow(createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }))
    } finally {
      vi.unstubAllGlobals()
    }
    const channels = ipcMocks.actual.mock.calls.map(call => call[1])
    expect(channels).toContain('reference-run:v1:execute')
    expect(channels).not.toContain('import-generation:v1:global')
    expect(channels).not.toContain('db:import-run-fail')
    expect(channels).not.toContain('db:import-run-cancel-at-boundary')
    expect(channels).not.toContain('db:import-run-advance-stage')
    return { ended: useWorkflowStore.getState().history[0]!, logs: useWorkflowStore.getState().globalLogs }
  }

  it.each([
    ['length', 'zh-CN'], ['length', 'en-US'],
    ['changed-syntax', 'zh-CN'], ['changed-syntax', 'en-US'],
    ['missing-field', 'zh-CN'], ['missing-field', 'en-US'],
  ] as const)('retains the trusted %s error in %s through the workflow store', async (kind, locale) => {
    const message = kind === 'length' ? createBoundedCompletionError('length', locale).message
      : kind === 'changed-syntax' ? locale === 'zh-CN' ? '导入推演 JSON 语法修复改变了候选事实，已拒绝写入'
        : 'The import-inference JSON syntax repair changed candidate facts, so the write was rejected.'
        : new StructuredContractDiagnostic('missing_field', 'novelConfig.genre').message
    const { ended, logs } = await failGlobal(locale, { success: false, error: message, errorCode: 'GENERATION_REQUEST_FAILED',
      ...(kind === 'length' ? { completionFailureCode: 'length' as const } : {}) })
    expect(ended).toMatchObject({ status: 'failed', error: message })
    expect(ended.steps[1]).toMatchObject({ status: 'failed', error: message })
    expect(logs.some(log => log.level === 'error' && log.message.includes(message))).toBe(true)
    if (kind === 'length') {
      expect(ended.failureCode).toBe('length')
      expect(ended.steps[1]!.failureCode).toBe('length')
    }
  })

  it.each(['zh-CN', 'en-US'] as const)('keeps the registered provider code and localized log in %s', async locale => {
    const { ended, logs } = await failGlobal(locale, { success: false, error: 'fictional provider failure', errorCode: 'GENERATION_PROVIDER_FAILED' })
    const message = knownAppErrorMessage(locale, 'GENERATION_PROVIDER_FAILED')
    expect(message).toBeTruthy()
    expect(ended).toMatchObject({ status: 'failed', errorCode: 'GENERATION_PROVIDER_FAILED' })
    expect(ended.steps[1]).toMatchObject({ status: 'failed', errorCode: 'GENERATION_PROVIDER_FAILED' })
    expect(logs.some(log => log.level === 'error' && log.message.includes(message!))).toBe(true)
  })

  it.each([
    ['stop', 'GENERATION_REQUEST_FAILED'],
    [null, 'GENERATION_REQUEST_FAILED'],
    [undefined, 'GENERATION_REQUEST_FAILED'],
    ['arbitrary', 'GENERATION_REQUEST_FAILED'],
    ['length', 'GENERATION_PROVIDER_FAILED'],
  ] as const)('rejects malformed completion metadata %s with %s', async (completionFailureCode, errorCode) => {
    const { ended } = await failGlobal('en-US', { success: false, error: 'untrusted failure details', errorCode, completionFailureCode })
    expect(ended).toMatchObject({ status: 'failed', error: 'GENERATION_REQUEST_FAILED' })
    expect(ended.steps[1]).toMatchObject({ status: 'failed', error: 'GENERATION_REQUEST_FAILED' })
    expect(ended.failureCode).toBeUndefined()
    expect(ended.steps[1]!.failureCode).toBeUndefined()
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
    if (!author) {
      const batchId = '1-1-aaaaaaaa'
      const resumed = run({ stage: 'refresh', completedBatches: { blueprints: [batchId] } })
      const completed = run({ stage: 'completed', status: 'completed' })
      let listener: (event: unknown) => void = () => {}
      let release!: () => void
      const acked = new Promise<void>(resolve => { release = resolve })
      ipcMocks.on.mockImplementation((channel, callback) => {
        if (channel === 'reference-run:v1:progress') listener = callback
        return () => {}
      })
      ipcMocks.invoke.mockImplementation(async (_session, channel, request, receiptStage) => {
        if (channel === 'reference-run:v1:projection-ack') { release(); return { version: 1 } }
        if (channel === 'db:project-core-get') return { genre: 'canonical' }
        if (channel === 'db:import-run-effect-receipt-get') {
          const global = receiptStage === 'global'
          return { schemaVersion: IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION, runId: resumed.id, effectNamespace: resumed.effectNamespace,
            effectKey: global ? 'global-facts' : `blueprints:${batchId}`, stage: global ? 'global' : 'blueprints',
            batchId: global ? 'done' : batchId, kind: global ? 'project-global-facts' : 'chapter-blueprint-range',
            payloadHash: 'a'.repeat(64), state: 'committed', payload: {},
            effectReceipt: global ? {} : { operationId: 'op', snapshot: [{}], characterSyncOperation: { operationId: 'sync' } }, createdAt: 'now', updatedAt: 'now' }
        }
        if (channel !== 'reference-run:v1:execute') throw new Error(`Unexpected channel ${channel}`)
        const base = { reference: request.reference, execution: request.execution, leaseId: session.leaseId }
        const names = ['knowledge', 'global', 'style', 'blueprints']
        names.forEach((name, position) => listener({ ...base, sequence: position + 1, kind: 'stage-skipped', stage: name, run: resumed,
          token: '00000000-0000-4000-8000-000000000003' }))
        if (stage !== 'refresh') return new Promise(() => {})
        listener({ ...base, sequence: 5, kind: 'stage-started', stage: 'refresh', run: resumed })
        const result = { version: 1, run: completed, execution: null, replayed: true }
        listener({ ...base, sequence: 6, kind: 'stage-completed', token: '00000000-0000-4000-8000-000000000003',
          completion: { stage: 'refresh', result } })
        await acked
        return { success: true, ...result }
      })
      return createActualWorkflow({ projectPath: session.projectPath, projectSession: session, run: resumed, executionOwner,
        referenceKnowledge: { reference: { projectId: session.projectId, runId: resumed.id,
          grantId: '00000000-0000-4000-8000-000000000002', revision: 1 },
        execution: { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER } } }).steps[index]!
    }
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
    if (author) expect(execute).toHaveBeenCalledExactlyOnceWith('import-run-1', stage, executionOwner, ctx, callbacks)
    else expect(execute).not.toHaveBeenCalled()
    expect(sink.record).toHaveBeenCalledExactlyOnceWith(`workflow.import.${stage}.ms`, 25)
  })

  it.each(['failed', 'cancelled'] as const)('preserves the original %s result and records elapsed stage time once', async outcome => {
    const original = Object.assign(new Error('private-stage-error'), { code: outcome === 'cancelled' ? 'WORKFLOW_CANCELLED' : 'FICTIONAL_STAGE_FAILED' })
    execute.mockRejectedValue(original)
    const sink = { now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(40), record: vi.fn() }
    install(sink)
    const ctx = context()
    ctx.cancelled = outcome === 'cancelled'
    await expect(step('author-commit', true, 0).executor({} as never, ctx, callbacks)).rejects.toBe(original)
    expect(sink.record).toHaveBeenCalledExactlyOnceWith('workflow.import.author-commit.ms', 40)
    expect(JSON.stringify(sink.record.mock.calls)).not.toContain('private-stage-error')
  })

  it('keeps zero elapsed time and samples only after the actual executor settles', async () => {
    let resolve!: () => void
    const gate = new Promise<void>(done => { resolve = done })
    execute.mockReturnValue(gate)
    const sink = { now: vi.fn(() => 5), record: vi.fn() }
    install(sink)
    const pending = step('author-commit', true, 0).executor({} as never, context(), callbacks)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(sink.record).not.toHaveBeenCalled()
    resolve()
    await pending
    expect(sink.record).toHaveBeenCalledExactlyOnceWith('workflow.import.author-commit.ms', 0)
  })

  it('executes without observation when no opt-in probe is installed', async () => {
    await expect(step('author-commit', true, 0).executor({} as never, context(), callbacks)).resolves.toBeUndefined()
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
        const pending = step('author-commit', true, 0).executor({} as never, context(), callbacks)
        if (fails) await expect(pending).rejects.toBe(original)
        else await expect(pending).resolves.toBeUndefined()
        expect(record).toHaveBeenCalledTimes(fault === 'sink-throws' ? 1 : 0)
        if (fault === 'missing-record') expect(now).not.toHaveBeenCalled()
      }
    },
  )
})

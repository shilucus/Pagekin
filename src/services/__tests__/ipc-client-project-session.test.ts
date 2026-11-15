import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  setActiveProjectSessionContext,
} from '../../shared/project-session-context'
import { ipc } from '../ipc-client'
import { PROJECT_RUNTIME_OPEN_BACKGROUND_VIEW_CHANNEL, PROJECT_RUNTIME_OPEN_VIEW_CHANNEL } from '../../shared/project-runtime-contract'
import type { AllInvokeChannels, ProjectSessionContext } from '../../shared/ipc-channels'
import type { PlanningFeedbackBlueprintChannel } from '../../shared/planning-feedback-ipc'

const invoke = vi.fn()

beforeEach(() => {
  invoke.mockReset()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      aiNovelAPI: {
        invoke,
        on: () => () => {},
        once: () => {},
        send: () => {},
        setZoomLevel: () => {},
        setZoomFactor: () => {},
        getZoomLevel: () => 0,
      },
    },
  })
  setActiveProjectSessionContext({
    projectId: 'project-A',
    leaseId: 'lease-A',
    projectPath: 'C:/projects/A',
  })
})

afterEach(() => {
  setActiveProjectSessionContext(null)
  Reflect.deleteProperty(globalThis, 'window')
})

describe('project-scoped IPC session transport', () => {
  it('keeps the whole reference run and mechanical projection ACK on the original frozen view', async () => {
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    const reference = { projectId: 'project-A', runId: 'fictional-run', grantId: '11111111-1111-4111-8111-111111111111', revision: 1 }
    const execution = { owner: '22222222-2222-4222-8222-222222222222', epoch: 1 }
    const request = { reference, execution, modelId: null }
    const ack = { reference, execution, stage: 'global' as const,
      token: '33333333-3333-4333-8333-333333333333', decision: 'settled' as const }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'reference-run:v1:execute', request)
    expect(invoke).toHaveBeenLastCalledWith('reference-run:v1:execute', request, frozen)
    await ipc.invokeWithProjectSession(frozen, 'reference-run:v1:projection-ack', ack)
    expect(invoke).toHaveBeenLastCalledWith('reference-run:v1:projection-ack', ack, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('reference-run:v1:execute', request)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(ipc.invoke('reference-run:v1:projection-ack', ack)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('keeps reference refresh and its projection ACK on the frozen view,never a replacement execution lease', async () => {
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    const reference = { projectId: 'project-A', runId: 'fictional-run', grantId: '11111111-1111-4111-8111-111111111111', revision: 1 }
    const entry = { reference, execution: { owner: '22222222-2222-4222-8222-222222222222', epoch: 1 } }
    const ack = { ...entry, token: '33333333-3333-4333-8333-333333333333', decision: 'completed' as const }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'reference-knowledge:v1:refresh', entry)
    expect(invoke).toHaveBeenLastCalledWith('reference-knowledge:v1:refresh', entry, frozen)
    await ipc.invokeWithProjectSession(frozen, 'reference-knowledge:v1:refresh-ack', ack)
    expect(invoke).toHaveBeenLastCalledWith('reference-knowledge:v1:refresh-ack', ack, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('reference-knowledge:v1:refresh', entry)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(ipc.invoke('reference-knowledge:v1:refresh-ack', ack)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('keeps multirange blueprint entry/readiness on the captured view without adding authority', async () => {
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    const execution = { owner: 'fictional-owner', epoch: 1 }
    const entry = { runId: 'fictional-import', execution, modelId: 'fictional-model' }
    const ack = { runId: entry.runId, execution, batchId: '1-1-12345678', token: 'fictional-token', decision: 'accept' as const }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'import-generation:v1:blueprints', entry)
    expect(invoke).toHaveBeenLastCalledWith('import-generation:v1:blueprints', entry, frozen)
    await ipc.invokeWithProjectSession(frozen, 'import-generation:v1:blueprints-ack', ack)
    expect(invoke).toHaveBeenLastCalledWith('import-generation:v1:blueprints-ack', ack, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('import-generation:v1:blueprints', entry)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(ipc.invoke('import-generation:v1:blueprints-ack', ack)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('keeps global execution and readiness ACK on the captured session without commit authority', async () => {
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    const execution = { owner: 'fictional-owner', epoch: 1 }
    const entry = { runId: 'fictional-import', execution, modelId: 'fictional-model' }
    const ack = { runId: entry.runId, execution, token: 'fictional-token', decision: 'accept' as const }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'import-generation:v1:global', entry)
    expect(invoke).toHaveBeenLastCalledWith('import-generation:v1:global', entry, frozen)
    await ipc.invokeWithProjectSession(frozen, 'import-generation:v1:global-ack', ack)
    expect(invoke).toHaveBeenLastCalledWith('import-generation:v1:global-ack', ack, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('import-generation:v1:global', entry)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(ipc.invoke('import-generation:v1:global-ack', ack)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('keeps style execution and automatic ACK on the captured project session', async () => {
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    const execution = { owner: 'fictional-owner', epoch: 1 }
    const entry = { runId: 'fictional-import', execution, modelId: 'fictional-model' }
    const ack = { runId: entry.runId, execution, token: 'fictional-token', phase: 'commit' as const, decision: 'accept' as const }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'import-generation:v1:style', entry)
    expect(invoke).toHaveBeenLastCalledWith('import-generation:v1:style', entry, frozen)
    await ipc.invokeWithProjectSession(frozen, 'import-generation:v1:style-ack', ack)
    expect(invoke).toHaveBeenLastCalledWith('import-generation:v1:style-ack', ack, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('import-generation:v1:style', entry)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(ipc.invoke('import-generation:v1:style-ack', ack)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('keeps the fixed import query entry on its captured project lease', async () => {
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    const request = { handle: { projectId: 'project-A', epoch: 'lease-A', rootActionId: 'root-A', runId: 'run-A' },
      execution: { owner: 'fictional-owner', epoch: 1 } }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'import-generation:v1:query-materials', request)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('import-generation:v1:query-materials', request, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('import-generation:v1:query-materials', request)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('keeps foreground reference issuance and effects view-bound while allowing only private revoke without a view', async () => {
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    const reference = { projectId: 'project-A', runId: 'fictional-run', grantId: '11111111-1111-4111-8111-111111111111', revision: 1 }
    const prepare = { operationId: reference.grantId, runId: reference.runId, executionOwner: '22222222-2222-4222-8222-222222222222' }
    const chapter = { reference, chapterNumber: 1, execution: { owner: prepare.executionOwner, epoch: 1 } }
    const execute = { reference, execution: chapter.execution }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'reference-knowledge:v1:prepare', prepare)
    expect(invoke).toHaveBeenLastCalledWith('reference-knowledge:v1:prepare', prepare, frozen)
    await ipc.invokeWithProjectSession(frozen, 'reference-knowledge:v1:import', chapter)
    expect(invoke).toHaveBeenLastCalledWith('reference-knowledge:v1:import', chapter, frozen)
    await ipc.invokeWithProjectSession(frozen, 'reference-knowledge:v1:execute', execute)
    expect(invoke).toHaveBeenLastCalledWith('reference-knowledge:v1:execute', execute, frozen)
    for (const channel of ['reference-knowledge:v1:resume', 'reference-knowledge:v1:complete'] as const) {
      await ipc.invokeWithProjectSession(frozen, channel, reference)
      expect(invoke).toHaveBeenLastCalledWith(channel, reference, frozen)
    }
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('reference-knowledge:v1:prepare', prepare)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(ipc.invoke('reference-knowledge:v1:import', chapter)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(ipc.invoke('reference-knowledge:v1:execute', execute)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    for (const channel of ['reference-knowledge:v1:resume', 'reference-knowledge:v1:complete'] as const) {
      await expect(ipc.invoke(channel, reference)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    }
    await ipc.invoke('reference-knowledge:v1:revoke', reference)
    expect(invoke).toHaveBeenLastCalledWith('reference-knowledge:v1:revoke', reference)
    await expect(ipc.invokeWithProjectSession(frozen, 'reference-knowledge:v1:revoke', reference)).rejects.toThrow('通道不属于项目会话范围')
    expect(invoke).toHaveBeenCalledTimes(6)
  })
  it('rejects a missing canonical bridge without invoking the legacy write API', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { velaAPI: { invoke } },
    })

    expect(ipc.isElectron).toBe(false)
    await expect(ipc.invoke('fs:grant-write-file', 'grant-1', '正文.txt', '中文正文')).rejects.toThrow('aiNovelAPI 未就绪')
    expect(() => ipc.send('window:close')).toThrow('aiNovelAPI 未就绪')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('appends the frozen active session to a project database request', async () => {
    invoke.mockResolvedValue([])

    await ipc.invoke('db:blueprint-get-all', 'C:/projects/A')

    expect(invoke).toHaveBeenCalledWith(
      'db:blueprint-get-all',
      'C:/projects/A',
      {
        projectId: 'project-A',
        leaseId: 'lease-A',
        projectPath: 'C:/projects/A',
      },
    )
  })

  it('allows a capability-grant filesystem request without an active project session', async () => {
    invoke.mockResolvedValue({ success: true })
    setActiveProjectSessionContext(null)

    await ipc.invoke('fs:grant-write-file', 'grant-export-1', 'chapter.txt', 'content')

    expect(invoke).toHaveBeenCalledWith(
      'fs:grant-write-file',
      'grant-export-1',
      'chapter.txt',
      'content',
    )
  })
  it('keeps representative reads on the captured project without borrowing a later active session', async () => {
    const frozen = Object.freeze({ projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' })
    const sample = [{ number: 2 }]
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    invoke.mockResolvedValueOnce(sample)
    await expect(ipc.invokeWithProjectSession(frozen, 'db:import-run-list-representative-chapters', 'fixture-run', frozen.projectPath)).resolves.toBe(sample)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('db:import-run-list-representative-chapters', 'fixture-run', frozen.projectPath, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('db:import-run-list-representative-chapters', 'fixture-run', frozen.projectPath)).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it.each([PROJECT_RUNTIME_OPEN_VIEW_CHANNEL, PROJECT_RUNTIME_OPEN_BACKGROUND_VIEW_CHANNEL])('%s admission uses its target grant and never borrows an active project lease', async channel => {
    const target = { grantId: 'fictional-open-grant', displayName: 'Fictional project' }
    invoke.mockResolvedValue({ success: true })
    await ipc.invoke(channel, target, 'fictional-request', null)
    expect(invoke).toHaveBeenLastCalledWith(channel, target, 'fictional-request', null)
    setActiveProjectSessionContext(null)
    await ipc.invoke(channel, target, 'fictional-next-request', null)
    expect(invoke).toHaveBeenLastCalledWith(channel, target, 'fictional-next-request', null)
    await expect(ipc.invokeWithProjectSession({ projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      channel, target, 'fictional-forged-request', null)).rejects.toThrow('通道不属于项目会话范围')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('requires a project session for planning-feedback channels instead of treating them as app-data', async () => {
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('planning-feedback:v1:capture', { target: 'premise' })).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('appends an explicitly captured planning-feedback session without substituting the active project', async () => {
    const frozen = Object.freeze({ projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' })
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    invoke.mockResolvedValue([])
    await ipc.invokeWithProjectSession(frozen, 'planning-feedback:v1:list-bases', { target: 'premise' })
    expect(invoke).toHaveBeenCalledExactlyOnceWith('planning-feedback:v1:list-bases', { target: 'premise' }, frozen)
  })

  it('requires and forwards a captured session for v2 range feedback without substituting the active project', async () => {
    const request = { target: { kind: 'plot-outline-range' as const, from: 3, to: 4 } }
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('planning-feedback:v2:list-bases', request)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    expect(invoke).not.toHaveBeenCalled()
    const frozen = Object.freeze({ projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' })
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    invoke.mockResolvedValue([])
    await ipc.invokeWithProjectSession(frozen, 'planning-feedback:v2:list-bases', request)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('planning-feedback:v2:list-bases', request, frozen)
  })

  it('requires a session for all v3 blueprint verbs and keeps an explicit capture instead of borrowing another active project', async () => {
    const target = { kind: 'blueprint-fields' as const, chapterNumber: 3, fields: ['title', 'notes'] as const }
    const handle = { projectId: 'project-A', epoch: 'lease-A', rootActionId: 'blueprint-root', runId: 'blueprint-run' }
    const input = { baseId: 'blueprint-base', feedback: 'Keep F0', constraints: ['Keep the lead'] }
    const requestFor = <C extends PlanningFeedbackBlueprintChannel>(channel: C, ...args: AllInvokeChannels[C]['args']) => ({
      channel,
      args,
      invoke: () => ipc.invoke(channel, ...args),
      invokeCaptured: (session: ProjectSessionContext) => ipc.invokeWithProjectSession(session, channel, ...args),
    })
    const requests = [
      requestFor('planning-feedback:v3:capture', { target }), requestFor('planning-feedback:v3:list-bases', { target }),
      requestFor('planning-feedback:v3:read-history', { baseId: input.baseId }),
      requestFor('planning-feedback:v3:begin', { input, modelId: 'fixture-model', uiActionNonce: 'fixture-nonce' }),
      requestFor('planning-feedback:v3:execute', { handle }), requestFor('planning-feedback:v3:read-run', { handle }),
      requestFor('planning-feedback:v3:list-runs', { baseId: input.baseId }), requestFor('planning-feedback:v3:cancel', { handle }),
      requestFor('planning-feedback:v3:stage', { ...input, runId: handle.runId, attemptId: 'fixture-attempt', artifactId: 'fixture-artifact' }),
      requestFor('planning-feedback:v3:relineage', { baseId: input.baseId, sourceCandidateId: 'old-candidate', feedback: 'Fresh author choice', constraints: [] }),
      requestFor('planning-feedback:v3:adopt', { candidateId: 'blueprint-candidate', idempotencyKey: 'author-nonce', decision: 'partial', text: '{"notes":""}' }),
    ]
    setActiveProjectSessionContext(null)
    for (const request of requests) {
      await expect(request.invoke()).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    }
    expect(invoke).not.toHaveBeenCalled()
    const frozen = Object.freeze({ projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' })
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    invoke.mockResolvedValue([])
    for (const request of requests) {
      await request.invokeCaptured(frozen)
      expect(invoke).toHaveBeenLastCalledWith(request.channel, ...request.args, frozen)
      expect(invoke.mock.lastCall?.[2]).toBe(frozen)
    }
    expect(invoke).toHaveBeenCalledTimes(11)
    setActiveProjectSessionContext(null)
    await ipc.invokeWithProjectSession(frozen, 'planning-feedback:v3:list-bases', { target })
    expect(invoke).toHaveBeenLastCalledWith('planning-feedback:v3:list-bases', { target }, frozen)
    expect(invoke).toHaveBeenCalledTimes(12)
  })

  it('keeps diagnostic reads bound to the captured project and rejects a missing session', async () => {
    const frozen = Object.freeze({ projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' })
    const handle = { projectId: 'project-A', epoch: 'lease-A', rootActionId: 'root-A', runId: 'run-A' }
    const report = { schemaVersion: 1 }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    invoke.mockResolvedValueOnce(report)
    await expect(ipc.invokeWithProjectSession(frozen, 'generation:read-diagnostics', { handle })).resolves.toBe(report)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('generation:read-diagnostics', { handle }, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('generation:read-diagnostics', { handle })).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('appends the active session to direct planning-feedback requests', async () => {
    invoke.mockResolvedValue([])
    await ipc.invoke('planning-feedback:v1:list-runs', { baseId: 'base-A' })
    expect(invoke).toHaveBeenCalledExactlyOnceWith('planning-feedback:v1:list-runs', { baseId: 'base-A' },
      { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' })
  })
  it('requires an explicit project session for runtime issuance and history, never for own-capability operations', async () => {
    const request = { operationId: '11111111-1111-4111-8111-111111111111',
      input: { baseId: 'base-A', feedback: 'Keep facts', constraints: [] }, modelId: 'fixture' }
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'runtime-feedback:v1:prepare', request)
    expect(invoke).toHaveBeenLastCalledWith('runtime-feedback:v1:prepare', request, frozen)
    await ipc.invokeWithProjectSession(frozen, 'runtime-feedback:v1:read-history', { grantId: 'grant-A' })
    expect(invoke).toHaveBeenLastCalledWith('runtime-feedback:v1:read-history', { grantId: 'grant-A' }, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('runtime-feedback:v1:prepare', request)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(ipc.invoke('runtime-feedback:v1:read-history', { grantId: 'grant-A' })).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    const reference = { projectId: 'project-A', grantId: 'grant-A', revision: 1 }
    for (const channel of ['runtime-feedback:v1:execute', 'runtime-feedback:v1:revoke'] as const) {
      await ipc.invoke(channel, reference)
      expect(invoke).toHaveBeenLastCalledWith(channel, reference)
    }
    await ipc.invoke('runtime-feedback:v1:read-receipt', { projectId: 'project-A', grantId: 'grant-A' })
    expect(invoke).toHaveBeenLastCalledWith('runtime-feedback:v1:read-receipt', { projectId: 'project-A', grantId: 'grant-A' })
    await ipc.invoke('runtime-feedback:v1:revoke-many', { references: [reference] })
    expect(invoke).toHaveBeenLastCalledWith('runtime-feedback:v1:revoke-many', { references: [reference] })
    await expect(ipc.invokeWithProjectSession(frozen, 'runtime-feedback:v1:execute', reference)).rejects.toThrow('通道不属于项目会话范围')
  })
  it('keeps fresh driver authorization separate from view-independent task control', async () => {
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    const taskId = '11111111-1111-4111-8111-111111111111'
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'workflow-driver:v1:reauthorize', { taskId })
    expect(invoke).toHaveBeenLastCalledWith('workflow-driver:v1:reauthorize', { taskId }, frozen)
    await ipc.invokeWithProjectSession(frozen, 'workflow-driver:v1:read-history', { taskId })
    expect(invoke).toHaveBeenLastCalledWith('workflow-driver:v1:read-history', { taskId }, frozen)
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('workflow-driver:v1:reauthorize', { taskId })).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(ipc.invoke('workflow-driver:v1:read-history', { taskId })).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    const request = { reference: { projectId: 'project-A', taskId, revision: 1 } }
    for (const channel of ['workflow-driver:v1:read-receipt', 'workflow-driver:v1:pause', 'workflow-driver:v1:cancel', 'workflow-driver:v1:resume'] as const) {
      await ipc.invoke(channel, request)
      expect(invoke).toHaveBeenLastCalledWith(channel, request)
    }
    await expect(ipc.invokeWithProjectSession(frozen, 'workflow-driver:v1:resume', request)).rejects.toThrow('通道不属于项目会话范围')
  })
  it('uses the captured author view only for v2 batch issuance or history, not task capability control', async () => {
    const frozen = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
    const taskId = '11111111-1111-4111-8111-111111111111'
    const start = { operationKey: taskId, modelId: 'fictional-draft', reviewModelId: 'fictional-review', uiLocale: 'en-US' as const,
      intent: { mode: 'draft_review' as const, range: { startChapter: 2, endChapter: 3 }, targetUnits: 100 }, authorInputs: [] }
    setActiveProjectSessionContext({ projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/projects/B' })
    await ipc.invokeWithProjectSession(frozen, 'workflow-batch:v2:start', start)
    expect(invoke).toHaveBeenLastCalledWith('workflow-batch:v2:start', start, frozen)
    for (const channel of ['workflow-batch:v2:reauthorize', 'workflow-batch:v2:read-history'] as const) {
      await ipc.invokeWithProjectSession(frozen, channel, { taskId })
      expect(invoke).toHaveBeenLastCalledWith(channel, { taskId }, frozen)
    }
    setActiveProjectSessionContext(null)
    await expect(ipc.invoke('workflow-batch:v2:start', start)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    for (const channel of ['workflow-batch:v2:reauthorize', 'workflow-batch:v2:read-history'] as const) {
      await expect(ipc.invoke(channel, { taskId })).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    }
    const request = { reference: { projectId: 'project-A', taskId, revision: 1 } }
    for (const channel of ['workflow-batch:v2:read-receipt', 'workflow-batch:v2:pause', 'workflow-batch:v2:cancel',
      'workflow-batch:v2:resume'] as const) {
      await ipc.invoke(channel, request)
      expect(invoke).toHaveBeenLastCalledWith(channel, request)
      await expect(ipc.invokeWithProjectSession(frozen, channel, request)).rejects.toThrow('通道不属于项目会话范围')
    }
  })
})

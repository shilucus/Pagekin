import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  setActiveProjectSessionContext,
} from '../../shared/project-session-context'
import { ipc } from '../ipc-client'
import { PROJECT_RUNTIME_OPEN_VIEW_CHANNEL } from '../../shared/project-runtime-contract'

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
  it('retained-view admission uses its target grant and never borrows an active project lease', async () => {
    const target = { grantId: 'fictional-open-grant', displayName: 'Fictional project' }
    invoke.mockResolvedValue({ success: true })
    await ipc.invoke(PROJECT_RUNTIME_OPEN_VIEW_CHANNEL, target, 'fictional-request', null)
    expect(invoke).toHaveBeenLastCalledWith(PROJECT_RUNTIME_OPEN_VIEW_CHANNEL, target, 'fictional-request', null)
    setActiveProjectSessionContext(null)
    await ipc.invoke(PROJECT_RUNTIME_OPEN_VIEW_CHANNEL, target, 'fictional-next-request', null)
    expect(invoke).toHaveBeenLastCalledWith(PROJECT_RUNTIME_OPEN_VIEW_CHANNEL, target, 'fictional-next-request', null)
    await expect(ipc.invokeWithProjectSession({ projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      PROJECT_RUNTIME_OPEN_VIEW_CHANNEL, target, 'fictional-forged-request', null)).rejects.toThrow('通道不属于项目会话范围')
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

import { describe, expect, it, vi } from 'vitest'
import type { ImportRunSnapshot } from '../../../shared/import-run'
import type { ReferenceRunProgress } from '../../../shared/reference-run-contract'
import type { NovelConfig } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'

const mocks = vi.hoisted(() => ({ on: vi.fn(), invoke: vi.fn() }))
vi.mock('../../ipc-client', () => ({ ipc: { on: mocks.on, invokeWithProjectSession: mocks.invoke } }))
import { ReferenceImportProjection } from '../reference-import-projection'

describe('reference whole-run projection', () => {
  it('subscribes before one execution, isolates identity, and buffers early events', async () => {
    const listeners = new Map<string, (event: unknown) => void>()
    mocks.on.mockReset().mockImplementation((channel: string, listener: (event: unknown) => void) => {
      listeners.set(channel, listener)
      return () => { listeners.delete(channel) }
    })
    let finish!: (value: unknown) => void
    mocks.invoke.mockReset().mockImplementation((_session: unknown, channel: string) => {
      if (channel === 'reference-run:v1:execute') return new Promise(resolve => { finish = resolve })
      return Promise.resolve({ version: 1 })
    })
    const session = { projectId: 'project-a', leaseId: 'lease-a', projectPath: 'C:\\project-a' }
    const reference = { projectId: 'project-a', runId: 'run-a', grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const execution = { owner: '00000000-0000-4000-8000-000000000001', epoch: 1 }
    const run = { id: 'run-a', rootRunId: 'root-a', purpose: 'reference', stage: 'global', status: 'running' } as ImportRunSnapshot
    const admitted = vi.fn()
    const projection = new ReferenceImportProjection(session, { reference, execution, modelId: null }, 'root-a', async () => session, admitted)
    expect(listeners.has('reference-run:v1:progress')).toBe(true)
    expect(listeners.has('import-generation:v1:global-progress')).toBe(true)
    for (const [channel, listener] of listeners) {
      if (channel === 'reference-run:v1:progress') continue
      expect(() => { listener(null); listener([]); listener({ reference: null, execution: null }) }).not.toThrow()
    }
    projection.start()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    const base = { reference, execution, leaseId: session.leaseId }
    const send = (event: ReferenceRunProgress) => listeners.get('reference-run:v1:progress')!(event)
    const token = '00000000-0000-4000-8000-000000000003'
    send({ ...base, reference: { ...reference, projectId: 'other' }, sequence: 1, kind: 'stage-skipped', stage: 'knowledge', run, token })
    send({ ...base, sequence: 1, kind: 'stage-skipped', stage: 'knowledge', run, token })
    expect((await projection.entry('knowledge')).kind).toBe('skipped')
    expect(admitted).not.toHaveBeenCalled()
    send({ ...base, sequence: 2, kind: 'stage-started', stage: 'global', run })
    expect(admitted).toHaveBeenCalledOnce()
    listeners.get('import-generation:v1:global-progress')!({ projectId: reference.projectId, leaseId: session.leaseId,
      runId: reference.runId, execution, sequence: 1, kind: 'progress', progress: 10 })
    const received = vi.fn()
    projection.on('import-generation:v1:global-progress', received)
    expect(received).toHaveBeenCalledOnce()
    expect((await projection.entry('global')).kind).toBe('started')
    finish({ success: false, error: 'stopped', errorCode: 'STOPPED' })
    await expect(projection.completion('global')).rejects.toMatchObject({ code: 'STOPPED' })
    projection.close()
    expect(listeners.size).toBe(0)
  })

  it('captures the style expected config synchronously while A is still foregrounded', async () => {
    const listeners = new Map<string, (event: unknown) => void>()
    mocks.on.mockReset().mockImplementation((channel: string, listener: (event: unknown) => void) => {
      listeners.set(channel, listener)
      return () => { listeners.delete(channel) }
    })
    const session = { projectId: 'project-a', leaseId: 'lease-a', projectPath: 'C:\\project-a' }
    const reference = { projectId: session.projectId, runId: 'run-a', grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const execution = { owner: '00000000-0000-4000-8000-000000000001', epoch: 1 }
    useProjectStore.setState({ currentProject: {
      id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: 'A',
      novelConfig: { writingStyle: 'captured before switch' } as NovelConfig, characterStates: '', createdAt: '', updatedAt: '',
    } as never, loading: false })
    const waitForProjectView = vi.fn(async () => session)
    const projection = new ReferenceImportProjection(session, { reference, execution, modelId: null }, 'root-a', waitForProjectView)
    listeners.get('import-generation:v1:style-progress')!({
      projectId: session.projectId, leaseId: session.leaseId, runId: reference.runId, execution, sequence: 1,
      kind: 'opened', token: '00000000-0000-4000-8000-000000000003',
      handle: { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }, modelId: 'model',
    })
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { writingStyle: 'edited after open' } as NovelConfig } })
    await expect(projection.openedStyle(1)).resolves.toEqual({ config: { writingStyle: 'captured before switch' } })
    expect(waitForProjectView).not.toHaveBeenCalled()
    projection.close()
    useProjectStore.setState({ currentProject: null })
  })

  it('captures the style expected config synchronously on A reattachment with a new lease', async () => {
    const listeners = new Map<string, (event: unknown) => void>()
    mocks.on.mockReset().mockImplementation((channel: string, listener: (event: unknown) => void) => {
      listeners.set(channel, listener)
      return () => { listeners.delete(channel) }
    })
    const session = { projectId: 'project-a', leaseId: 'lease-a-original', projectPath: 'C:\\project-a' }
    const viewSession = { ...session, leaseId: 'lease-a-reattached' }
    const reference = { projectId: session.projectId, runId: 'run-a', grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const execution = { owner: '00000000-0000-4000-8000-000000000001', epoch: 1 }
    useProjectStore.setState({ currentProject: {
      id: session.projectId, path: session.projectPath, sessionLease: viewSession.leaseId, name: 'A',
      novelConfig: { writingStyle: 'captured on returned A' } as NovelConfig, characterStates: '', createdAt: '', updatedAt: '',
    } as never, loading: false })
    const waitForProjectView = vi.fn(async () => viewSession)
    const projection = new ReferenceImportProjection(session, { reference, execution, modelId: null }, 'root-a', waitForProjectView)
    listeners.get('import-generation:v1:style-progress')!({
      projectId: session.projectId, leaseId: session.leaseId, runId: reference.runId, execution, sequence: 1,
      kind: 'opened', token: '00000000-0000-4000-8000-000000000003',
      handle: { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }, modelId: 'model',
    })
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { writingStyle: 'edited after reattach open' } as NovelConfig } })
    await expect(projection.openedStyle(1)).resolves.toEqual({ config: { writingStyle: 'captured on returned A' } })
    expect(waitForProjectView).not.toHaveBeenCalled()
    projection.close()
    useProjectStore.setState({ currentProject: null })
  })

  it('aborts a pending view wait when the main whole-run terminal fails', async () => {
    const listeners = new Map<string, (event: unknown) => void>()
    mocks.on.mockReset().mockImplementation((channel: string, listener: (event: unknown) => void) => {
      listeners.set(channel, listener)
      return () => { listeners.delete(channel) }
    })
    let finish!: (result: unknown) => void
    mocks.invoke.mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const session = { projectId: 'project-a', leaseId: 'lease-a', projectPath: 'C:\\project-a' }
    const reference = { projectId: session.projectId, runId: 'run-a', grantId: '00000000-0000-4000-8000-000000000002', revision: 1 }
    const execution = { owner: '00000000-0000-4000-8000-000000000001', epoch: 1 }
    let aborted = false
    const projection = new ReferenceImportProjection(session, { reference, execution, modelId: null }, 'root-a', signal => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    }))
    projection.start()
    const waiting = projection.waitForProjectView()
    finish({ success: false, error: 'failed', errorCode: 'FAILED' })
    await expect(waiting).rejects.toMatchObject({ code: 'FAILED' })
    expect(aborted).toBe(true)
    projection.close()
    expect(listeners.size).toBe(0)
  })
})

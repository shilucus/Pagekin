import { describe, expect, it, vi } from 'vitest'
import type { ImportRunSnapshot } from '../../../shared/import-run'
import type { ReferenceRunProgress } from '../../../shared/reference-run-contract'

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
    const projection = new ReferenceImportProjection(session, { reference, execution, modelId: null }, 'root-a')
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
    send({ ...base, sequence: 2, kind: 'stage-started', stage: 'global', run })
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
})

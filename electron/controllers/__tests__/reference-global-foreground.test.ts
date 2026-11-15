import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ProjectRuntime } from '../../services/project-runtime'
import type { createMainGenerationOwner } from '../../services/main-generation-owner'
import type { ReferenceGlobalProgress, ReferenceGlobalResult } from '../../../src/shared/reference-global-contract'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), release: vi.fn(), acquire: vi.fn(), acquireWork: vi.fn() }))
vi.mock('../../services/reference-global-driver', () => ({ executeReferenceGlobal: mocks.execute }))
vi.mock('../../services/project-runtime', () => ({ projectRuntimeHost: { acquireLegacyOperation: mocks.acquire, acquireWork: mocks.acquireWork } }))
vi.mock('../import-run-failure', () => ({ explainImportRunFailure: (code: string) => ({ error: `safe:${code}`, errorCode: code }) }))
import { ReferenceGlobalForeground } from '../reference-global-foreground'
import { acquireImportRunParentFlight, assertImportStageUnmanagedMutationAllowed } from '../../services/import-stage-flight'

class Sender extends EventEmitter {
  destroyed = false
  events: ReferenceGlobalProgress[] = []
  isDestroyed() { return this.destroyed }
  send(_channel: string, event: ReferenceGlobalProgress) { this.events.push(event) }
}
const session = { projectId: 'fictional-project', leaseId: 'fictional-view', projectPath: 'C:/fictional' }
const request = { runId: 'fictional-import', execution: { owner: 'fictional-owner', epoch: 1 }, modelId: 'fictional-model' }
const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'fictional-root', runId: 'fictional-generation' }
const owner = {} as ReturnType<typeof createMainGenerationOwner>
const result = { version: 1 } as ReferenceGlobalResult
const subject = (sender: Sender) => sender as unknown as WebContents
const runtime = () => ({ database: {}, projectId: session.projectId } as ProjectRuntime)
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
beforeEach(() => {
  mocks.execute.mockReset(); mocks.release.mockReset()
  mocks.acquire.mockReset().mockReturnValue(mocks.release); mocks.acquireWork.mockReset().mockReturnValue(mocks.release)
})
afterEach(() => { vi.restoreAllMocks() })

describe('foreground global readiness coordinator', () => {
  it('requires the same parent before joining a managed child and retains the parent after child drain', async () => {
    const coordinator = new ReferenceGlobalForeground(), book = runtime(), sender = new Sender(), drain = deferred()
    const parent = acquireImportRunParentFlight(book.database, request.runId)
    mocks.execute.mockImplementation(async () => { await drain.promise; return result })
    const operation = coordinator.execute(book, owner, subject(sender), session, request, () => {}, parent.token)
    expect(mocks.acquireWork).toHaveBeenCalledExactlyOnceWith(book)
    expect(mocks.acquire).not.toHaveBeenCalled()
    expect(() => coordinator.execute(book, owner, subject(sender), session, request, () => {})).toThrow('GENERATION_OWNER_BUSY')
    expect(coordinator.execute(book, owner, subject(sender), session, request, () => {}, parent.token)).toBe(operation)
    expect(() => parent.release()).toThrow('GENERATION_OWNER_BUSY')
    expect(mocks.release).not.toHaveBeenCalled()
    drain.resolve(); await operation
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(() => assertImportStageUnmanagedMutationAllowed(book.database, request.runId)).toThrow('GENERATION_OWNER_BUSY')
    parent.release()
  })
  it('joins exactly one sender/session/execution/model and permits only the original readiness token', async () => {
    const coordinator = new ReferenceGlobalForeground(), book = runtime(), sender = new Sender(), drain = deferred()
    mocks.execute.mockImplementation(async ({ hooks }) => { await hooks.opened({ handle, modelId: request.modelId }); await drain.promise; return result })
    const operation = coordinator.execute(book, owner, subject(sender), session, request, () => {})
    expect(coordinator.execute(book, owner, subject(sender), session, structuredClone(request), () => {})).toBe(operation)
    expect(() => coordinator.execute(book, owner, subject(new Sender()), session, request, () => {})).toThrow('GENERATION_OWNER_BUSY')
    expect(() => coordinator.execute(book, owner, subject(sender), session, { ...request, modelId: 'other' }, () => {})).toThrow('GENERATION_OWNER_BUSY')
    await vi.waitFor(() => expect(sender.events).toHaveLength(1))
    const opened = sender.events[0] as Extract<ReferenceGlobalProgress, { kind: 'opened' }>
    const ack = { runId: request.runId, execution: request.execution, token: opened.token, decision: 'accept' as const }
    expect(() => coordinator.acknowledge(book, subject(new Sender()), session, ack)).toThrow('GENERATION_IMPORT_ADMISSION_REQUIRED')
    expect(() => coordinator.acknowledge(book, subject(sender), { ...session, leaseId: 'other' }, ack)).toThrow('GENERATION_IMPORT_ADMISSION_REQUIRED')
    expect(() => coordinator.acknowledge(book, subject(sender), session, { ...ack, token: 'unknown' })).toThrow('GENERATION_IMPORT_ADMISSION_REQUIRED')
    const accepted = coordinator.acknowledge(book, subject(sender), session, ack)
    expect(coordinator.acknowledge(book, subject(sender), session, ack)).toBe(accepted)
    await expect(accepted).resolves.toEqual({ version: 1 })
    expect(() => assertImportStageUnmanagedMutationAllowed(book.database, request.runId)).toThrow('GENERATION_OWNER_BUSY')
    expect(mocks.release).not.toHaveBeenCalled()
    drain.resolve(); await expect(operation).resolves.toBe(result)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(() => assertImportStageUnmanagedMutationAllowed(book.database, request.runId)).not.toThrow()
    coordinator.release(book.database)
    expect(() => coordinator.acknowledge(book, subject(sender), session, ack)).toThrow('GENERATION_IMPORT_ADMISSION_REQUIRED')
  })
  it.each(['destroy', 'close'] as const)('unblocks %s but keeps all claims through physical drain', async stop => {
    const coordinator = new ReferenceGlobalForeground(), book = runtime(), sender = new Sender(), drain = deferred()
    mocks.execute.mockImplementation(async ({ hooks }) => {
      try { await hooks.opened({ handle, modelId: request.modelId }) }
      finally { await drain.promise }
      return result
    })
    const operation = coordinator.execute(book, owner, subject(sender), session, request, () => {}).catch(error => error)
    await vi.waitFor(() => expect(sender.events).toHaveLength(1))
    if (stop === 'destroy') { sender.destroyed = true; sender.emit('destroyed') } else coordinator.requestClose(book)
    await Promise.resolve()
    expect(() => coordinator.release(book.database)).toThrow('GENERATION_OWNER_BUSY')
    expect(() => assertImportStageUnmanagedMutationAllowed(book.database, request.runId)).toThrow('GENERATION_OWNER_BUSY')
    expect(mocks.release).not.toHaveBeenCalled()
    drain.resolve(); expect((await operation).message).toBe('GENERATION_ACTION_CANCELLED')
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
  it('treats committed/candidate/log notification failure as projection only', async () => {
    const coordinator = new ReferenceGlobalForeground(), book = runtime(), sender = new Sender()
    vi.spyOn(sender, 'send').mockImplementation(() => { throw new Error('fictional projection failure') })
    mocks.execute.mockImplementation(async ({ hooks, signal }) => {
      hooks.candidate('fictional candidate'); hooks.committed(); hooks.log({ key: 'saved-proposals', count: 1 }); hooks.progress(100)
      expect(signal.aborted).toBe(false)
      return result
    })
    await expect(coordinator.execute(book, owner, subject(sender), session, request, () => {})).resolves.toBe(result)
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
})

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ProjectRuntime } from '../../services/project-runtime'
import type { createMainGenerationOwner } from '../../services/main-generation-owner'
import type { ReferenceStyleProgress, ReferenceStyleResult } from '../../../src/shared/reference-style-contract'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), release: vi.fn(), acquire: vi.fn() }))
vi.mock('../../services/reference-style-driver', () => ({ executeReferenceStyle: mocks.execute }))
vi.mock('../../services/project-runtime', () => ({ projectRuntimeHost: { acquireLegacyOperation: mocks.acquire } }))
vi.mock('../import-run-failure', () => ({ explainImportRunFailure: (code: string) => ({ error: `safe:${code}`, errorCode: code }) }))
import { ReferenceStyleForeground } from '../reference-style-foreground'
import { assertImportStageUnmanagedMutationAllowed } from '../../services/import-stage-flight'

class Sender extends EventEmitter {
  destroyed = false
  events: ReferenceStyleProgress[] = []
  isDestroyed() { return this.destroyed }
  send(_channel: string, event: ReferenceStyleProgress) { this.events.push(event) }
}
const session = { projectId: 'fictional-project', leaseId: 'fictional-view', projectPath: 'C:/fictional' }
const request = { runId: 'fictional-import', execution: { owner: 'fictional-owner', epoch: 1 }, modelId: 'fictional-model' }
const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'fictional-root', runId: 'fictional-generation' }
const owner = {} as ReturnType<typeof createMainGenerationOwner>
const result = { version: 1, savedWritingStyle: 'fictional style' } as ReferenceStyleResult
const subject = (sender: Sender) => sender as unknown as WebContents
const runtime = () => ({ database: {}, projectId: session.projectId } as ProjectRuntime)
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
beforeEach(() => {
  mocks.execute.mockReset(); mocks.release.mockReset(); mocks.acquire.mockReset().mockReturnValue(mocks.release)
})
afterEach(() => { vi.restoreAllMocks() })

describe('foreground style handshake coordinator', () => {
  it('joins one operation, binds sender/phase/token, and acknowledges only the actual durable value', async () => {
    const coordinator = new ReferenceStyleForeground(), book = runtime(), sender = new Sender()
    const canCommit = gate(), canFinish = gate()
    mocks.execute.mockImplementation(async ({ hooks }) => {
      await hooks.opened({ handle, modelId: request.modelId })
      await hooks.commitReady(handle, 'fictional style')
      await canCommit.promise
      hooks.committed('actual saved style')
      await canFinish.promise
      return result
    })
    const operation = coordinator.execute(book, owner, subject(sender), session, request, () => {})
    expect(coordinator.execute(book, owner, subject(sender), session, structuredClone(request), () => {})).toBe(operation)
    await vi.waitFor(() => expect(sender.events).toHaveLength(1))
    const opened = sender.events[0] as Extract<ReferenceStyleProgress, { kind: 'opened' }>
    const openedAck = { runId: request.runId, execution: request.execution, token: opened.token, phase: 'opened' as const, decision: 'accept' as const }
    expect(() => coordinator.acknowledge(book, subject(new Sender()), session, openedAck)).toThrow('GENERATION_IMPORT_ADMISSION_REQUIRED')
    expect(() => coordinator.acknowledge(book, subject(sender), session, { ...openedAck, phase: 'commit' })).toThrow('GENERATION_IMPORT_ADMISSION_REQUIRED')
    expect(() => coordinator.acknowledge(book, subject(sender), { ...session, leaseId: 'other-view' }, openedAck)).toThrow('GENERATION_IMPORT_ADMISSION_REQUIRED')
    await expect(coordinator.acknowledge(book, subject(sender), session, openedAck)).resolves.toEqual({ version: 1, savedWritingStyle: null })
    await vi.waitFor(() => expect(sender.events).toHaveLength(2))
    const commit = sender.events[1] as Extract<ReferenceStyleProgress, { kind: 'commit-ready' }>
    const commitAck = { ...openedAck, token: commit.token, phase: 'commit' as const }
    const ack = coordinator.acknowledge(book, subject(sender), session, commitAck)
    expect(coordinator.acknowledge(book, subject(sender), session, commitAck)).toBe(ack)
    let acknowledged = false; void ack.then(() => { acknowledged = true })
    await Promise.resolve(); expect(acknowledged).toBe(false)
    expect(() => assertImportStageUnmanagedMutationAllowed(book.database, request.runId)).toThrow('GENERATION_OWNER_BUSY')
    canCommit.resolve()
    await expect(ack).resolves.toEqual({ version: 1, savedWritingStyle: 'actual saved style' })
    expect(mocks.release).not.toHaveBeenCalled()
    canFinish.resolve(); await expect(operation).resolves.toBe(result)
    expect(mocks.execute).toHaveBeenCalledTimes(1); expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(() => assertImportStageUnmanagedMutationAllowed(book.database, request.runId)).not.toThrow()
    await expect(coordinator.acknowledge(book, subject(sender), session, commitAck)).resolves.toEqual({ version: 1, savedWritingStyle: 'actual saved style' })
    coordinator.release(book.database)
    expect(() => coordinator.acknowledge(book, subject(sender), session, commitAck)).toThrow('GENERATION_IMPORT_ADMISSION_REQUIRED')
  })

  it.each(['destroy', 'close'] as const)('unblocks %s while retaining the stage/work guard through actual driver drain', async stop => {
    const coordinator = new ReferenceStyleForeground(), book = runtime(), sender = new Sender(), drain = gate()
    mocks.execute.mockImplementation(async ({ hooks }) => {
      try { await hooks.opened({ handle, modelId: request.modelId }) }
      finally { await drain.promise }
      return result
    })
    const operation = coordinator.execute(book, owner, subject(sender), session, request, () => {})
    const settled = operation.catch(error => error)
    await vi.waitFor(() => expect(sender.events).toHaveLength(1))
    if (stop === 'destroy') { sender.destroyed = true; sender.emit('destroyed') }
    else coordinator.requestClose(book)
    await Promise.resolve()
    expect(() => assertImportStageUnmanagedMutationAllowed(book.database, request.runId)).toThrow('GENERATION_OWNER_BUSY')
    expect(() => coordinator.release(book.database)).toThrow('GENERATION_OWNER_BUSY')
    expect(mocks.release).not.toHaveBeenCalled()
    drain.resolve()
    expect((await settled).message).toBe('GENERATION_ACTION_CANCELLED')
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(() => assertImportStageUnmanagedMutationAllowed(book.database, request.runId)).not.toThrow()
  })

  it('does not turn a saved-effect notification failure into a stop intent', async () => {
    const coordinator = new ReferenceStyleForeground(), book = runtime(), sender = new Sender()
    vi.spyOn(sender, 'send').mockImplementation(() => { throw new Error('fictional projection failure') })
    mocks.execute.mockImplementation(async ({ hooks, signal }) => {
      hooks.committed('actual saved style')
      hooks.log('saved')
      hooks.progress(100)
      expect(signal.aborted).toBe(false)
      return result
    })
    await expect(coordinator.execute(book, owner, subject(sender), session, request, () => {})).resolves.toBe(result)
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })
})

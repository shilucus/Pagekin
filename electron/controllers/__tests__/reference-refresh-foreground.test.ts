import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ProjectRuntime } from '../../services/project-runtime'
import type { ReferenceKnowledgeAuthority, ReferenceRefreshExecutionHooks } from '../../services/reference-knowledge-authority'
import type { ReferenceRefreshProgress, ReferenceRefreshRequest, ReferenceRefreshSuccess } from '../../../src/shared/reference-refresh-contract'

vi.mock('../import-run-failure', () => ({ explainImportRunFailure: (code: string) => ({ error: `safe:${code}`, errorCode: code }) }))
import { ReferenceRefreshForeground } from '../reference-refresh-foreground'

class Sender extends EventEmitter {
  destroyed = false
  events: ReferenceRefreshProgress[] = []
  isDestroyed() { return this.destroyed }
  send(_channel: string, event: ReferenceRefreshProgress) { this.events.push(event) }
}
const session = { projectId: 'fictional-project', leaseId: 'fictional-view', projectPath: 'C:/fictional' }
const request: ReferenceRefreshRequest = { reference: { projectId: session.projectId, runId: 'fictional-import',
  grantId: '11111111-1111-4111-8111-111111111111', revision: 1 }, execution: { owner: '22222222-2222-4222-8222-222222222222', epoch: 1 } }
const result = { version: 1, execution: null, replayed: false } as ReferenceRefreshSuccess
const subject = (sender: Sender) => sender as unknown as WebContents
const runtime = () => ({ database: {}, projectId: session.projectId } as ProjectRuntime)
const execute = vi.fn()
const authority = { executeRefresh: execute } as unknown as ReferenceKnowledgeAuthority
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
beforeEach(() => { execute.mockReset() })
afterEach(() => { vi.restoreAllMocks() })

describe('foreground reference refresh projection coordinator', () => {
  it('joins the exact flight and accepts only its original identity/token/decision', async () => {
    const coordinator = new ReferenceRefreshForeground(), book = runtime(), sender = new Sender(), drain = deferred()
    execute.mockImplementation(async (_sender, captured: ReferenceRefreshRequest, hooks: ReferenceRefreshExecutionHooks) => {
      expect(captured).toEqual(request)
      await hooks.refresh(); await drain.promise; hooks.progress(100)
      return result
    })
    const operation = coordinator.execute(book, authority, subject(sender), session, request, () => {})
    expect(coordinator.execute(book, authority, subject(sender), session, structuredClone(request), () => {})).toBe(operation)
    expect(() => coordinator.execute(book, authority, subject(new Sender()), session, request, () => {})).toThrow('GENERATION_OWNER_BUSY')
    await vi.waitFor(() => expect(sender.events).toHaveLength(1))
    const event = sender.events[0] as Extract<ReferenceRefreshProgress, { kind: 'refresh' }>
    expect(event).toMatchObject({ ...request, leaseId: session.leaseId, sequence: 1 })
    const ack = { ...request, token: event.token, decision: 'completed' as const }
    expect(() => coordinator.acknowledge(book, subject(new Sender()), session, ack)).toThrow('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    expect(() => coordinator.acknowledge(book, subject(sender), { ...session, leaseId: 'other' }, ack)).toThrow('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    expect(() => coordinator.acknowledge(book, subject(sender), session, { ...ack, execution: { ...request.execution, epoch: 2 } })).toThrow('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    expect(() => coordinator.acknowledge(book, subject(sender), session, { ...ack, token: 'other' })).toThrow('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    const accepted = coordinator.acknowledge(book, subject(sender), session, ack)
    expect(coordinator.acknowledge(book, subject(sender), session, ack)).toBe(accepted)
    await expect(accepted).resolves.toEqual({ version: 1 })
    expect(() => coordinator.acknowledge(book, subject(sender), session, { ...ack, decision: 'failed' })).toThrow('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    expect(() => coordinator.release(book.database)).toThrow('GENERATION_OWNER_BUSY')
    drain.resolve(); await expect(operation).resolves.toBe(result)
    expect(sender.events[1]).toMatchObject({ kind: 'progress', progress: 100, sequence: 2 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(sender.listenerCount('destroyed')).toBe(0)
    coordinator.release(book.database)
  })
  it.each(['destroy', 'close'] as const)('unblocks %s but waits for the authority-owned operation tail', async stop => {
    const coordinator = new ReferenceRefreshForeground(), book = runtime(), sender = new Sender(), drain = deferred()
    let signal: AbortSignal | undefined
    execute.mockImplementation(async (_sender, _request, hooks: ReferenceRefreshExecutionHooks) => {
      signal = hooks.signal
      try { await hooks.refresh() } finally { await drain.promise }
      return result
    })
    const operation = coordinator.execute(book, authority, subject(sender), session, request, () => {}).catch(error => error)
    await vi.waitFor(() => expect(sender.events).toHaveLength(1))
    if (stop === 'destroy') { sender.destroyed = true; sender.emit('destroyed') } else coordinator.requestClose(book)
    expect(signal?.aborted).toBe(true)
    expect(() => coordinator.release(book.database)).toThrow('GENERATION_OWNER_BUSY')
    drain.resolve()
    expect((await operation).message).toBe('IMPORT_RUN_CANCELLED')
    coordinator.release(book.database)
  })
  it('turns only a failed ACK into the finite projection failure without accepting arbitrary renderer text', async () => {
    const coordinator = new ReferenceRefreshForeground(), book = runtime(), sender = new Sender()
    execute.mockImplementation(async (_sender, _request, hooks: ReferenceRefreshExecutionHooks) => { await hooks.refresh(); return result })
    const operation = coordinator.execute(book, authority, subject(sender), session, request, () => {}).catch(error => error)
    await vi.waitFor(() => expect(sender.events).toHaveLength(1))
    const event = sender.events[0] as Extract<ReferenceRefreshProgress, { kind: 'refresh' }>
    await expect(coordinator.acknowledge(book, subject(sender), session, { ...request, token: event.token, decision: 'failed' })).resolves.toEqual({ version: 1 })
    expect((await operation).message).toBe('IMPORT_RUN_REFRESH_PROJECTION_FAILED')
  })
  it('preserves terminal success when only the progress notification fails', async () => {
    const coordinator = new ReferenceRefreshForeground(), book = runtime(), sender = new Sender()
    vi.spyOn(sender, 'send').mockImplementation(() => { throw new Error('fictional projection delivery failure') })
    execute.mockImplementation(async (_sender, _request, hooks: ReferenceRefreshExecutionHooks) => {
      hooks.progress(100); expect(hooks.signal.aborted).toBe(false); return result
    })
    await expect(coordinator.execute(book, authority, subject(sender), session, request, () => {})).resolves.toBe(result)
  })
  it('stops a projection wait when its required notification cannot be delivered', async () => {
    const coordinator = new ReferenceRefreshForeground(), book = runtime(), sender = new Sender()
    vi.spyOn(sender, 'send').mockImplementation(() => { throw new Error('fictional projection delivery failure') })
    execute.mockImplementation(async (_sender, _request, hooks: ReferenceRefreshExecutionHooks) => { await hooks.refresh(); return result })
    await expect(coordinator.execute(book, authority, subject(sender), session, request, () => {})).rejects.toThrow('IMPORT_RUN_CANCELLED')
  })
})

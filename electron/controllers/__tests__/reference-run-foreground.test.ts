import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ImportRunSnapshot } from '../../../src/shared/import-run'
import type { ReferenceRunProgress, ReferenceRunRequest } from '../../../src/shared/reference-run-contract'
import type { ReferenceRefreshSuccess } from '../../../src/shared/reference-refresh-contract'
import type { ExecuteReferenceImportMainRunOptions } from '../../services/reference-import-main-coordinator'
import type { ReferenceKnowledgeAuthority } from '../../services/reference-knowledge-authority'
import type { ProjectRuntime } from '../../services/project-runtime'
import { assertImportStageUnmanagedMutationAllowed } from '../../services/import-stage-flight'
import { ReferenceRunForeground, type ReferenceRunGenerationStages } from '../reference-run-foreground'
import { ReferenceRefreshForeground } from '../reference-refresh-foreground'

const mocks = vi.hoisted(() => ({ execute: vi.fn<(options: ExecuteReferenceImportMainRunOptions) => Promise<ReferenceRefreshSuccess>>(),
  get: vi.fn(), releaseWork: vi.fn() }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' } }))
vi.mock('../../services/reference-import-main-coordinator', () => ({ executeReferenceImportMainRun: mocks.execute }))
vi.mock('../../repositories/import-run-repository', () => ({ ImportRunRepository: { get: mocks.get } }))
vi.mock('../../services/project-runtime', () => ({ projectRuntimeHost: { acquireWork: () => mocks.releaseWork } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
class Sender extends EventEmitter {
  destroyed = false
  events: ReferenceRunProgress[] = []
  isDestroyed() { return this.destroyed }
  send(_channel: string, event: ReferenceRunProgress) { this.events.push(event) }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}
const session = { projectId: 'fictional-project', leaseId: 'fictional-view', projectPath: 'C:/fictional' }
const request: ReferenceRunRequest = { reference: { projectId: session.projectId, runId: 'fictional-run',
  grantId: '11111111-1111-4111-8111-111111111111', revision: 1 },
  execution: { owner: '22222222-2222-4222-8222-222222222222', epoch: 1 }, modelId: 'fictional-model' }
function snapshot(stage: ImportRunSnapshot['stage'] = 'global'): ImportRunSnapshot {
  return { id: request.reference.runId, purpose: 'reference', rootRunId: request.reference.runId, effectNamespace: 'fictional',
    sourceDisplay: [], locale: 'en-US', stage, status: stage === 'completed' ? 'completed' : 'running',
    completedBatches: {}, lastError: '', resumable: false, cancelRequested: false,
    totalChapters: 1, totalContentSize: 1, manifestChapterCount: 1, manifestContentSize: 1, manifestWordCount: 1,
    completedChapters: 1, createdAt: '', updatedAt: '' }
}
const result = (): ReferenceRefreshSuccess => ({ version: 1, run: snapshot('completed'), execution: null, replayed: false })
let sender: Sender, runtime: ProjectRuntime, foreground: ReferenceRunForeground
let run: ImportRunSnapshot, pending: Promise<ReferenceRefreshSuccess> | undefined
let releasePhysical: (() => void) | undefined
let releaseIssuance: ReturnType<typeof vi.fn>
let authority: {
  beginRun: ReturnType<typeof vi.fn>
  assertRunCurrent: ReturnType<typeof vi.fn>
  hasIssuance: ReturnType<typeof vi.fn>
  withRunHeartbeat: ReturnType<typeof vi.fn>
  cancelRunAtBoundary: ReturnType<typeof vi.fn>
}
const generation = { global: vi.fn(), style: vi.fn(), blueprints: vi.fn() } as ReferenceRunGenerationStages
const knowledge = { progress: vi.fn(), failureMessage: () => 'Fictional failure' }
function start(input: ReferenceRunRequest = request, subject = sender) {
  const operation = foreground.execute(runtime, authority as unknown as ReferenceKnowledgeAuthority,
    subject as unknown as WebContents, session, input, generation, knowledge, () => {})
  pending = operation
  void operation.catch(() => undefined)
  return operation
}
async function completion() {
  await vi.waitFor(() => expect(sender.events.some(event => event.kind === 'stage-completed')).toBe(true))
  return sender.events.find(event => event.kind === 'stage-completed')! as Extract<ReferenceRunProgress, { kind: 'stage-completed' }>
}
function ack(event: Extract<ReferenceRunProgress, { kind: 'stage-completed' }>, decision: 'settled' | 'cancelled' | 'projection-failed' = 'settled') {
  return foreground.acknowledge(runtime, sender as unknown as WebContents, session,
    { reference: request.reference, execution: request.execution, stage: event.completion.stage, token: event.token, decision })
}
beforeEach(() => {
  vi.clearAllMocks()
  sender = new Sender(); run = snapshot(); pending = undefined; releasePhysical = undefined
  mocks.get.mockImplementation(() => run)
  const database = { prepare: () => ({ get: () => ({ execution_owner: request.execution.owner, execution_epoch: request.execution.epoch }) }) }
  runtime = { database, projectId: session.projectId, canonicalRoot: session.projectPath } as unknown as ProjectRuntime
  releaseIssuance = vi.fn()
  authority = { beginRun: vi.fn(() => releaseIssuance), assertRunCurrent: vi.fn(), hasIssuance: vi.fn(() => true),
    withRunHeartbeat: vi.fn(async (_sender, _reference, _execution, _parent, operation: () => Promise<unknown>) => operation()),
    cancelRunAtBoundary: vi.fn() }
  foreground = new ReferenceRunForeground(new ReferenceRefreshForeground())
})
afterEach(async () => {
  releasePhysical?.()
  sender.destroy()
  if (pending) await pending.catch(() => undefined)
  foreground.release(runtime.database)
})

describe('whole reference foreground ownership and projection barrier', () => {
  it('accepts the original parent projection at a reattached view without accepting another subject or token', async () => {
    mocks.execute.mockImplementation(async options => {
      await options.hooks.stageCompleted({ stage: 'knowledge', result: { run,
        execution: { ...request.execution, expiresAt: Date.now() + 60_000 } } })
      return result()
    })
    const flight = start(), event = await completion()
    const attached = { ...session, leaseId: 'fictional-reattached-view' }
    const payload = { reference: request.reference, execution: request.execution,
      stage: event.completion.stage, token: event.token, decision: 'settled' as const }
    expect(() => foreground.acknowledge(runtime, new Sender() as unknown as WebContents, attached, payload))
      .toThrow('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    expect(() => foreground.acknowledge(runtime, sender as unknown as WebContents, attached,
      { ...payload, token: 'wrong-token' })).toThrow('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    expect(mocks.releaseWork).not.toHaveBeenCalled()
    await expect(foreground.acknowledge(runtime, sender as unknown as WebContents, attached, payload)).resolves.toEqual({ version: 1 })
    await flight
  })
  it('joins only identical immutable input and holds the parent through the actual operation', async () => {
    const physical = deferred<ReferenceRefreshSuccess>()
    releasePhysical = () => physical.resolve(result())
    mocks.execute.mockImplementation(async options => {
      expect(Object.isFrozen(options.request)).toBe(true)
      expect(Object.isFrozen(options.request.reference)).toBe(true)
      return physical.promise
    })
    const first = start()
    expect(start(structuredClone(request))).toBe(first)
    for (const changed of [{ ...request, modelId: 'other-model' }, { ...request, execution: { ...request.execution, epoch: 2 } },
      { ...request, reference: { ...request.reference, revision: 2 } }]) {
      expect(() => start(changed)).toThrow('GENERATION_OWNER_BUSY')
    }
    expect(() => start(request, new Sender())).toThrow('GENERATION_OWNER_BUSY')
    expect(() => assertImportStageUnmanagedMutationAllowed(runtime.database, request.reference.runId)).toThrow('GENERATION_OWNER_BUSY')
    expect(mocks.releaseWork).not.toHaveBeenCalled()
    physical.resolve(result()); await first
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(releaseIssuance).toHaveBeenCalledTimes(1)
    expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    expect(() => assertImportStageUnmanagedMutationAllowed(runtime.database, request.reference.runId)).not.toThrow()
  })
  it('keeps the original issuance heartbeat until the exact projection token settles', async () => {
    mocks.execute.mockImplementation(async options => {
      await options.hooks.stageCompleted({ stage: 'knowledge', result: { run,
        execution: { ...request.execution, expiresAt: Date.now() + 60_000 } } })
      return result()
    })
    const flight = start(), event = await completion()
    expect(authority.withRunHeartbeat).toHaveBeenCalledTimes(1)
    expect(() => foreground.acknowledge(runtime, sender as unknown as WebContents, session,
      { reference: request.reference, execution: request.execution, stage: 'style', token: event.token, decision: 'settled' }))
      .toThrow('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    expect(mocks.releaseWork).not.toHaveBeenCalled()
    await expect(ack(event)).resolves.toEqual({ version: 1 })
    await flight
  })
  it.each(['cancelled', 'projection-failed'] as const)('stops after a negative projection ACK: %s', async decision => {
    const later = vi.fn()
    mocks.execute.mockImplementation(async options => {
      await options.hooks.stageCompleted({ stage: 'knowledge', result: { run,
        execution: { ...request.execution, expiresAt: Date.now() + 60_000 } } })
      later()
      return result()
    })
    const flight = start(), event = await completion()
    await ack(event, decision)
    await expect(flight).rejects.toThrow(decision === 'cancelled' ? 'IMPORT_RUN_CANCELLED' : 'GENERATION_REQUEST_FAILED')
    expect(later).not.toHaveBeenCalled()
    expect(authority.cancelRunAtBoundary).toHaveBeenCalledTimes(decision === 'cancelled' ? 1 : 0)
  })
  it('waits for canonical projection of a skipped stage before starting the next child', async () => {
    const later = vi.fn()
    mocks.execute.mockImplementation(async options => {
      await options.hooks.stageSkipped('knowledge', run)
      later()
      return result()
    })
    const flight = start()
    await vi.waitFor(() => expect(sender.events.some(event => event.kind === 'stage-skipped')).toBe(true))
    const event = sender.events.find(event => event.kind === 'stage-skipped')! as Extract<ReferenceRunProgress, { kind: 'stage-skipped' }>
    expect(later).not.toHaveBeenCalled()
    expect(authority.withRunHeartbeat).toHaveBeenCalledTimes(1)
    await foreground.acknowledge(runtime, sender as unknown as WebContents, session,
      { reference: request.reference, execution: request.execution, stage: event.stage, token: event.token, decision: 'settled' })
    await flight
    expect(later).toHaveBeenCalledTimes(1)
  })
  it('reports a confirmed revoke during the projection wait as cancellation, not capability failure', async () => {
    mocks.execute.mockImplementation(async options => {
      await options.hooks.stageCompleted({ stage: 'knowledge', result: { run,
        execution: { ...request.execution, expiresAt: Date.now() + 60_000 } } })
      return result()
    })
    const flight = start(); await completion()
    run.cancelRequested = true
    authority.assertRunCurrent.mockImplementation(() => { throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED') })
    await expect(flight).rejects.toThrow('IMPORT_RUN_CANCELLED')
    expect(authority.cancelRunAtBoundary).toHaveBeenCalledTimes(1)
  })
  it('does not replace an actual source error with a later cancellation', async () => {
    mocks.execute.mockImplementation(async options => {
      await options.hooks.stageCompleted({ stage: 'knowledge', result: { run,
        execution: { ...request.execution, expiresAt: Date.now() + 60_000 } } })
      return result()
    })
    const flight = start(); await completion()
    run.cancelRequested = true
    authority.assertRunCurrent.mockImplementation(() => { throw new Error('SOURCE_FINGERPRINT_CHANGED') })
    await expect(flight).rejects.toThrow('SOURCE_FINGERPRINT_CHANGED')
    expect(authority.cancelRunAtBoundary).not.toHaveBeenCalled()
  })
  it('unblocks an impossible ACK on close but retains the parent until ignored-abort work drains', async () => {
    const physical = deferred<ReferenceRefreshSuccess>()
    releasePhysical = () => physical.resolve(result())
    mocks.execute.mockImplementation(async options => { await physical.promise; options.assertCurrent(); return result() })
    const flight = start()
    foreground.requestClose(runtime)
    expect(mocks.releaseWork).not.toHaveBeenCalled()
    expect(() => assertImportStageUnmanagedMutationAllowed(runtime.database, request.reference.runId)).toThrow('GENERATION_OWNER_BUSY')
    physical.resolve(result())
    await expect(flight).rejects.toThrow('IMPORT_RUN_CANCELLED')
    expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
  })
  it('retains a failed cleanup handle and both claims until close-time retry succeeds', async () => {
    releaseIssuance.mockImplementationOnce(() => { throw new Error('FICTIONAL_CANCEL_WRITE_FAILED') })
    mocks.execute.mockResolvedValue(result())
    await expect(start()).rejects.toThrow('FICTIONAL_CANCEL_WRITE_FAILED')
    expect(mocks.releaseWork).not.toHaveBeenCalled()
    expect(() => assertImportStageUnmanagedMutationAllowed(runtime.database, request.reference.runId)).toThrow('GENERATION_OWNER_BUSY')
    foreground.requestClose(runtime)
    expect(releaseIssuance).toHaveBeenCalledTimes(2)
    expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
  })
  it('retains the parent and work claim until a failed cancellation write succeeds', async () => {
    authority.cancelRunAtBoundary.mockImplementationOnce(() => { throw new Error('FICTIONAL_CANCEL_WRITE_FAILED') })
      .mockImplementationOnce(() => { throw new Error('FICTIONAL_CANCEL_RETRY_FAILED') })
    mocks.execute.mockImplementation(async options => {
      await options.hooks.stageCompleted({ stage: 'knowledge', result: { run,
        execution: { ...request.execution, expiresAt: Date.now() + 60_000 } } })
      return result()
    })
    const flight = start(), event = await completion()
    await ack(event, 'cancelled')
    const failure = await flight.catch(error => error)
    expect(failure).toMatchObject({ message: 'IMPORT_RUN_CANCELLED',
      secondaryErrors: [expect.objectContaining({ message: 'FICTIONAL_CANCEL_WRITE_FAILED' })] })
    expect(releaseIssuance).not.toHaveBeenCalled()
    expect(mocks.releaseWork).not.toHaveBeenCalled()
    expect(() => assertImportStageUnmanagedMutationAllowed(runtime.database, request.reference.runId)).toThrow('GENERATION_OWNER_BUSY')
    expect(() => foreground.requestClose(runtime)).toThrow('FICTIONAL_CANCEL_RETRY_FAILED')
    expect(releaseIssuance).not.toHaveBeenCalled()
    expect(mocks.releaseWork).not.toHaveBeenCalled()
    expect(() => assertImportStageUnmanagedMutationAllowed(runtime.database, request.reference.runId)).toThrow('GENERATION_OWNER_BUSY')
    foreground.requestClose(runtime)
    expect(authority.cancelRunAtBoundary).toHaveBeenCalledTimes(3)
    expect(releaseIssuance).toHaveBeenCalledTimes(1)
    expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
    expect(() => assertImportStageUnmanagedMutationAllowed(runtime.database, request.reference.runId)).not.toThrow()
  })
  it('preserves the primary operation error when cleanup also fails', async () => {
    const primary = new Error('FICTIONAL_SOURCE_FAILED')
    releaseIssuance.mockImplementationOnce(() => { throw new Error('FICTIONAL_CANCEL_WRITE_FAILED') })
    mocks.execute.mockRejectedValue(primary)
    await expect(start()).rejects.toBe(primary)
    expect(primary).toMatchObject({ secondaryErrors: [expect.objectContaining({ message: 'FICTIONAL_CANCEL_WRITE_FAILED' })] })
    expect(mocks.releaseWork).not.toHaveBeenCalled()
    foreground.release(runtime.database)
    expect(mocks.releaseWork).toHaveBeenCalledTimes(1)
  })
})

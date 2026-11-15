import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { WebContents } from 'electron'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { ReferenceStyleAckRequest, ReferenceStyleAckResult, ReferenceStyleProgress, ReferenceStyleRequest, ReferenceStyleResult } from '../../src/shared/reference-style-contract'
import { importGenerationStopMessage } from '../../src/i18n/app-errors'
import { executeReferenceStyle } from '../services/reference-style-driver'
import type { createMainGenerationOwner } from '../services/main-generation-owner'
import { acquireImportStageFlight, assertImportRunParentFlightAccess, type ImportRunParentFlightToken } from '../services/import-stage-flight'
import { projectRuntimeHost, type ProjectRuntime } from '../services/project-runtime'
import { explainImportRunFailure } from './import-run-failure'

type Owner = ReturnType<typeof createMainGenerationOwner>
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
interface Gate {
  phase: ReferenceStyleAckRequest['phase']
  token: string
  decision: ReferenceStyleAckRequest['decision'] | null
  ready: ReturnType<typeof deferred<void>>
  result: ReturnType<typeof deferred<ReferenceStyleAckResult>>
}
interface Flight {
  runtime: ProjectRuntime
  sender: WebContents
  session: ProjectSessionContext
  request: ReferenceStyleRequest
  stop: AbortController
  gates: Gate[]
  operation: Promise<ReferenceStyleResult>
  finished: boolean
  parentToken?: ImportRunParentFlightToken
  assertCurrent(): void
}
const sameExecution = (left: ReferenceStyleRequest['execution'], right: ReferenceStyleRequest['execution']) => left.owner === right.owner && left.epoch === right.epoch
const sameSession = (left: ProjectSessionContext, right: ProjectSessionContext) => left.projectId === right.projectId
  && left.leaseId === right.leaseId && left.projectPath === right.projectPath

/** The latest foreground operation per actual database retains at most its two ACK results. */
export class ReferenceStyleForeground {
  private readonly flights = new Map<Database.Database, Flight>()

  execute(runtime: ProjectRuntime, owner: Owner, sender: WebContents, session: ProjectSessionContext,
    request: ReferenceStyleRequest, assertCurrent: () => void, parentToken?: ImportRunParentFlightToken): Promise<ReferenceStyleResult> {
    assertImportRunParentFlightAccess(runtime.database, request.runId, parentToken)
    const prior = this.flights.get(runtime.database)
    if (prior && !prior.finished) {
      if (prior.sender !== sender || !sameSession(prior.session, session) || prior.request.runId !== request.runId
        || !sameExecution(prior.request.execution, request.execution) || prior.request.modelId !== request.modelId) throw new Error('GENERATION_OWNER_BUSY')
      return prior.operation
    }
    if (sender.isDestroyed()) throw new Error('GENERATION_ACTION_CANCELLED')
    assertCurrent()
    const releaseStage = acquireImportStageFlight(runtime.database, request.runId, 'style', parentToken)
    let releaseWork: () => void
    try { releaseWork = parentToken ? projectRuntimeHost.acquireWork(runtime) : projectRuntimeHost.acquireLegacyOperation('import-generation:v1:style') }
    catch (error) { releaseStage(); throw error }
    const flight: Flight = { runtime, sender, session: Object.freeze({ ...session }), request: structuredClone(request),
      stop: new AbortController(), gates: [], operation: undefined!, finished: false, parentToken, assertCurrent }
    this.flights.set(runtime.database, flight)
    const stop = () => {
      flight.stop.abort()
      for (const gate of flight.gates) {
        gate.ready.reject(new Error('GENERATION_ACTION_CANCELLED'))
        gate.result.reject(new Error('GENERATION_ACTION_CANCELLED'))
      }
    }
    const destroyed = () => stop()
    sender.once('destroyed', destroyed)
    let sequence = 0
    type Projection = ReferenceStyleProgress extends infer Event ? Event extends ReferenceStyleProgress
      ? Omit<Event, 'projectId' | 'leaseId' | 'runId' | 'execution' | 'sequence'> : never : never
    const emit = (event: Projection) => {
      if (sender.isDestroyed()) { stop(); return }
      const projection: ReferenceStyleProgress = { projectId: session.projectId, leaseId: session.leaseId,
        runId: request.runId, execution: { ...request.execution }, sequence: ++sequence, ...event } as ReferenceStyleProgress
      // A notification is a projection, never a replacement formal effect.
      try { sender.send('import-generation:v1:style-progress', projection) }
      catch { if (event.kind === 'opened' || event.kind === 'commit-ready') stop() }
    }
    const gate = (phase: Gate['phase']): Gate => {
      if (flight.stop.signal.aborted) throw new Error('GENERATION_ACTION_CANCELLED')
      const value: Gate = { phase, token: randomUUID(), decision: null, ready: deferred<void>(), result: deferred<ReferenceStyleAckResult>() }
      flight.gates.push(value)
      return value
    }
    flight.operation = Promise.resolve().then(() => executeReferenceStyle({ runtime, owner, viewEpoch: session.leaseId, request: flight.request,
      signal: flight.stop.signal, assertCurrent, hooks: {
        opened: async ({ handle, modelId }) => {
          const pending = gate('opened')
          emit({ kind: 'opened', token: pending.token, handle, modelId })
          await pending.ready.promise
        },
        commitReady: async (handle, writingStyle) => {
          const pending = gate('commit')
          emit({ kind: 'commit-ready', token: pending.token, handle, writingStyle })
          await pending.ready.promise
        },
        committed: savedWritingStyle => {
          flight.gates.find(value => value.phase === 'commit')?.result.resolve({ version: 1, savedWritingStyle })
        },
        log: (log, count) => {
          if (log === 'imported-samples' || log === 'sampled-finalized') emit({ kind: 'log', log, count: count! })
          else emit({ kind: 'log', log })
        },
        progress: progress => emit({ kind: 'progress', progress }),
        promptBudget: report => emit({ kind: 'prompt-budget', report }),
        failureMessage: (code, locale) => importGenerationStopMessage(locale, code, false, 'reference')
          ?? explainImportRunFailure(code, locale)?.error
          ?? explainImportRunFailure('GENERATION_REQUEST_FAILED', locale)!.error,
      } })).finally(() => {
        flight.finished = true
        sender.removeListener('destroyed', destroyed)
        for (const pending of flight.gates) {
          pending.ready.reject(new Error('GENERATION_REQUEST_FAILED'))
          pending.result.reject(new Error('GENERATION_REQUEST_FAILED'))
        }
        try { releaseWork() } finally { releaseStage() }
      })
    return flight.operation
  }

  acknowledge(runtime: ProjectRuntime, sender: WebContents, session: ProjectSessionContext,
    request: ReferenceStyleAckRequest): Promise<ReferenceStyleAckResult> {
    const flight = this.flights.get(runtime.database)
    if (!flight || flight.sender !== sender || sender.isDestroyed()
      || (flight.parentToken ? flight.session.projectId !== session.projectId || flight.session.projectPath !== session.projectPath : !sameSession(flight.session, session))
      || flight.request.runId !== request.runId || !sameExecution(flight.request.execution, request.execution)) {
      throw new Error('GENERATION_IMPORT_ADMISSION_REQUIRED')
    }
    const pending = flight.gates.find(value => value.token === request.token && value.phase === request.phase)
    if (!pending || pending.decision && pending.decision !== request.decision) throw new Error('GENERATION_IMPORT_ADMISSION_REQUIRED')
    if (flight.parentToken) { assertImportRunParentFlightAccess(runtime.database, request.runId, flight.parentToken); flight.assertCurrent() }
    if (pending.decision) return pending.result.promise
    pending.decision = request.decision
    if (request.decision === 'accept') {
      pending.ready.resolve()
      if (request.phase === 'opened') pending.result.resolve({ version: 1, savedWritingStyle: null })
    } else {
      const error = new Error(request.decision === 'draft-changed' ? 'GENERATION_AUTHOR_DRAFT_CHANGED'
        : request.decision === 'cancelled' ? 'GENERATION_ACTION_CANCELLED' : 'GENERATION_REQUEST_FAILED')
      pending.ready.reject(error)
      pending.result.reject(error)
    }
    return pending.result.promise
  }

  requestClose(runtime: ProjectRuntime): void {
    const flight = this.flights.get(runtime.database)
    if (!flight || flight.finished) return
    flight.stop.abort()
    for (const gate of flight.gates) {
      gate.ready.reject(new Error('GENERATION_ACTION_CANCELLED'))
      gate.result.reject(new Error('GENERATION_ACTION_CANCELLED'))
    }
  }

  release(database: Database.Database): void {
    const flight = this.flights.get(database)
    if (flight && !flight.finished) throw new Error('GENERATION_OWNER_BUSY')
    this.flights.delete(database)
  }
}

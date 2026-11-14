import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { WebContents } from 'electron'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { ReferenceGlobalAckRequest, ReferenceGlobalAckResult, ReferenceGlobalProgress, ReferenceGlobalRequest, ReferenceGlobalResult } from '../../src/shared/reference-global-contract'
import { importGenerationStopMessage } from '../../src/i18n/app-errors'
import { executeReferenceGlobal } from '../services/reference-global-driver'
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
interface Flight {
  sender: WebContents
  session: ProjectSessionContext
  request: ReferenceGlobalRequest
  stop: AbortController
  gate: { token: string; decision: ReferenceGlobalAckRequest['decision'] | null; ready: ReturnType<typeof deferred<void>>; result: ReturnType<typeof deferred<ReferenceGlobalAckResult>> } | null
  operation: Promise<ReferenceGlobalResult>
  finished: boolean
}
const sameExecution = (left: ReferenceGlobalRequest['execution'], right: ReferenceGlobalRequest['execution']) => left.owner === right.owner && left.epoch === right.epoch
const sameSession = (left: ProjectSessionContext, right: ProjectSessionContext) => left.projectId === right.projectId
  && left.leaseId === right.leaseId && left.projectPath === right.projectPath

/** The one foreground readiness token cannot reconstruct durable execution authority. */
export class ReferenceGlobalForeground {
  private readonly flights = new Map<Database.Database, Flight>()

  execute(runtime: ProjectRuntime, owner: Owner, sender: WebContents, session: ProjectSessionContext,
    request: ReferenceGlobalRequest, assertCurrent: () => void, parentToken?: ImportRunParentFlightToken): Promise<ReferenceGlobalResult> {
    assertImportRunParentFlightAccess(runtime.database, request.runId, parentToken)
    const prior = this.flights.get(runtime.database)
    if (prior && !prior.finished) {
      if (prior.sender !== sender || !sameSession(prior.session, session) || prior.request.runId !== request.runId
        || !sameExecution(prior.request.execution, request.execution) || prior.request.modelId !== request.modelId) throw new Error('GENERATION_OWNER_BUSY')
      return prior.operation
    }
    if (sender.isDestroyed()) throw new Error('GENERATION_ACTION_CANCELLED')
    assertCurrent()
    const releaseStage = acquireImportStageFlight(runtime.database, request.runId, 'global', parentToken)
    let releaseWork: () => void
    try { releaseWork = projectRuntimeHost.acquireLegacyOperation('import-generation:v1:global') }
    catch (error) { releaseStage(); throw error }
    const flight: Flight = { sender, session: Object.freeze({ ...session }), request: structuredClone(request),
      stop: new AbortController(), gate: null, operation: undefined!, finished: false }
    this.flights.set(runtime.database, flight)
    const stop = () => {
      flight.stop.abort()
      flight.gate?.ready.reject(new Error('GENERATION_ACTION_CANCELLED'))
      flight.gate?.result.reject(new Error('GENERATION_ACTION_CANCELLED'))
    }
    sender.once('destroyed', stop)
    let sequence = 0
    type Projection = ReferenceGlobalProgress extends infer Event ? Event extends ReferenceGlobalProgress
      ? Omit<Event, 'projectId' | 'leaseId' | 'runId' | 'execution' | 'sequence'> : never : never
    const emit = (event: Projection) => {
      if (sender.isDestroyed()) { stop(); return }
      const projection: ReferenceGlobalProgress = { projectId: session.projectId, leaseId: session.leaseId,
        runId: request.runId, execution: { ...request.execution }, sequence: ++sequence, ...event } as ReferenceGlobalProgress
      try { sender.send('import-generation:v1:global-progress', projection) }
      catch { if (event.kind === 'opened') stop() }
    }
    flight.operation = Promise.resolve().then(() => executeReferenceGlobal({ runtime, owner, viewEpoch: session.leaseId,
      request: flight.request, signal: flight.stop.signal, assertCurrent, hooks: {
        opened: async ({ handle, modelId }) => {
          if (flight.stop.signal.aborted) throw new Error('GENERATION_ACTION_CANCELLED')
          const gate = { token: randomUUID(), decision: null, ready: deferred<void>(), result: deferred<ReferenceGlobalAckResult>() }
          flight.gate = gate
          emit({ kind: 'opened', token: gate.token, handle, modelId })
          await gate.ready.promise
        },
        committed: () => emit({ kind: 'committed' }),
        candidate: content => emit({ kind: 'candidate', content }),
        log: value => emit({ kind: 'log', value }),
        progress: progress => emit({ kind: 'progress', progress }),
        promptBudget: report => emit({ kind: 'prompt-budget', report }),
        failureMessage: (code, locale) => importGenerationStopMessage(locale, code, false, 'reference')
          ?? explainImportRunFailure(code, locale)?.error ?? explainImportRunFailure('GENERATION_REQUEST_FAILED', locale)!.error,
      } })).finally(() => {
      flight.finished = true
      sender.removeListener('destroyed', stop)
      flight.gate?.ready.reject(new Error('GENERATION_REQUEST_FAILED'))
      flight.gate?.result.reject(new Error('GENERATION_REQUEST_FAILED'))
      try { releaseWork() } finally { releaseStage() }
    })
    return flight.operation
  }

  acknowledge(runtime: ProjectRuntime, sender: WebContents, session: ProjectSessionContext,
    request: ReferenceGlobalAckRequest): Promise<ReferenceGlobalAckResult> {
    const flight = this.flights.get(runtime.database), gate = flight?.gate
    if (!flight || !gate || flight.sender !== sender || sender.isDestroyed() || !sameSession(flight.session, session)
      || flight.request.runId !== request.runId || !sameExecution(flight.request.execution, request.execution)
      || gate.token !== request.token || gate.decision && gate.decision !== request.decision) throw new Error('GENERATION_IMPORT_ADMISSION_REQUIRED')
    if (gate.decision) return gate.result.promise
    gate.decision = request.decision
    if (request.decision === 'accept') { gate.ready.resolve(); gate.result.resolve({ version: 1 }) }
    else {
      const error = new Error(request.decision === 'cancelled' ? 'GENERATION_ACTION_CANCELLED' : 'GENERATION_REQUEST_FAILED')
      gate.ready.reject(error); gate.result.reject(error)
    }
    return gate.result.promise
  }

  requestClose(runtime: ProjectRuntime): void {
    const flight = this.flights.get(runtime.database)
    if (!flight || flight.finished) return
    flight.stop.abort()
    flight.gate?.ready.reject(new Error('GENERATION_ACTION_CANCELLED'))
    flight.gate?.result.reject(new Error('GENERATION_ACTION_CANCELLED'))
  }

  release(database: Database.Database): void {
    const flight = this.flights.get(database)
    if (flight && !flight.finished) throw new Error('GENERATION_OWNER_BUSY')
    this.flights.delete(database)
  }
}

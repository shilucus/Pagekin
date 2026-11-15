import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { WebContents } from 'electron'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { ReferenceBlueprintAckRequest, ReferenceBlueprintAckResult, ReferenceBlueprintProgress, ReferenceBlueprintRequest, ReferenceBlueprintResult } from '../../src/shared/reference-blueprint-contract'
import { importGenerationStopMessage } from '../../src/i18n/app-errors'
import { executeReferenceBlueprints } from '../services/reference-blueprint-driver'
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
  request: ReferenceBlueprintRequest
  stop: AbortController
  gate: { token: string; batchId: string; decision: ReferenceBlueprintAckRequest['decision'] | null; ready: ReturnType<typeof deferred<void>>; result: ReturnType<typeof deferred<ReferenceBlueprintAckResult>> } | null
  operation: Promise<ReferenceBlueprintResult>
  finished: boolean
  parentToken?: ImportRunParentFlightToken
  assertCurrent(): void
}
const sameExecution = (left: ReferenceBlueprintRequest['execution'], right: ReferenceBlueprintRequest['execution']) => left.owner === right.owner && left.epoch === right.epoch
const sameSession = (left: ProjectSessionContext, right: ProjectSessionContext) => left.projectId === right.projectId
  && left.leaseId === right.leaseId && left.projectPath === right.projectPath

/** Each range readiness token cannot reconstruct durable execution authority. */
export class ReferenceBlueprintForeground {
  private readonly flights = new Map<Database.Database, Flight>()

  execute(runtime: ProjectRuntime, owner: Owner, sender: WebContents, session: ProjectSessionContext,
    request: ReferenceBlueprintRequest, assertCurrent: () => void, parentToken?: ImportRunParentFlightToken): Promise<ReferenceBlueprintResult> {
    assertImportRunParentFlightAccess(runtime.database, request.runId, parentToken)
    const prior = this.flights.get(runtime.database)
    if (prior && !prior.finished) {
      if (prior.sender !== sender || !sameSession(prior.session, session) || prior.request.runId !== request.runId
        || !sameExecution(prior.request.execution, request.execution) || prior.request.modelId !== request.modelId) throw new Error('GENERATION_OWNER_BUSY')
      return prior.operation
    }
    if (sender.isDestroyed()) throw new Error('GENERATION_ACTION_CANCELLED')
    assertCurrent()
    const releaseStage = acquireImportStageFlight(runtime.database, request.runId, 'blueprints', parentToken)
    let releaseWork: () => void
    try { releaseWork = parentToken ? projectRuntimeHost.acquireWork(runtime) : projectRuntimeHost.acquireLegacyOperation('import-generation:v1:blueprints') }
    catch (error) { releaseStage(); throw error }
    const flight: Flight = { sender, session: Object.freeze({ ...session }), request: structuredClone(request),
      stop: new AbortController(), gate: null, operation: undefined!, finished: false, parentToken, assertCurrent }
    this.flights.set(runtime.database, flight)
    const stop = () => {
      flight.stop.abort()
      flight.gate?.ready.reject(new Error('GENERATION_ACTION_CANCELLED'))
      flight.gate?.result.reject(new Error('GENERATION_ACTION_CANCELLED'))
    }
    sender.once('destroyed', stop)
    let sequence = 0
    type Projection = ReferenceBlueprintProgress extends infer Event ? Event extends ReferenceBlueprintProgress
      ? Omit<Event, 'projectId' | 'leaseId' | 'runId' | 'execution' | 'sequence'> : never : never
    const emit = (event: Projection) => {
      if (sender.isDestroyed()) { stop(); return }
      const projection: ReferenceBlueprintProgress = { projectId: session.projectId, leaseId: session.leaseId,
        runId: request.runId, execution: { ...request.execution }, sequence: ++sequence, ...event } as ReferenceBlueprintProgress
      try { sender.send('import-generation:v1:blueprints-progress', projection) }
      catch { if (event.kind === 'opened') stop() }
    }
    flight.operation = Promise.resolve().then(() => executeReferenceBlueprints({ runtime, owner, viewEpoch: session.leaseId,
      request: flight.request, signal: flight.stop.signal, assertCurrent, hooks: {
        opened: async ({ batchId, handle, modelId }) => {
          if (flight.stop.signal.aborted) throw new Error('GENERATION_ACTION_CANCELLED')
          const gate = { token: randomUUID(), batchId, decision: null, ready: deferred<void>(), result: deferred<ReferenceBlueprintAckResult>() }
          flight.gate = gate
          emit({ kind: 'opened', batchId, token: gate.token, handle, modelId })
          await gate.ready.promise
        },
        rangeCommitted: batchId => emit({ kind: 'range-committed', batchId }),
        rangeSynced: batchId => emit({ kind: 'range-synced', batchId }),
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
    request: ReferenceBlueprintAckRequest): Promise<ReferenceBlueprintAckResult> {
    const flight = this.flights.get(runtime.database), gate = flight?.gate
    if (!flight || !gate || flight.sender !== sender || sender.isDestroyed()
      || (flight.parentToken ? flight.session.projectId !== session.projectId || flight.session.projectPath !== session.projectPath : !sameSession(flight.session, session))
      || flight.request.runId !== request.runId || !sameExecution(flight.request.execution, request.execution)
      || gate.token !== request.token || gate.batchId !== request.batchId || gate.decision && gate.decision !== request.decision) throw new Error('GENERATION_IMPORT_ADMISSION_REQUIRED')
    if (flight.parentToken) { assertImportRunParentFlightAccess(runtime.database, request.runId, flight.parentToken); flight.assertCurrent() }
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

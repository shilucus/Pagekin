import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { WebContents } from 'electron'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { ReferenceRefreshAckRequest, ReferenceRefreshAckResult, ReferenceRefreshProgress,
  ReferenceRefreshRequest, ReferenceRefreshSuccess } from '../../src/shared/reference-refresh-contract'
import type { ReferenceKnowledgeAuthority } from '../services/reference-knowledge-authority'
import type { ProjectRuntime } from '../services/project-runtime'
import { explainImportRunFailure } from './import-run-failure'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
const sameReference = (a: ReferenceRefreshRequest['reference'], b: ReferenceRefreshRequest['reference']) =>
  a.projectId === b.projectId && a.runId === b.runId && a.grantId === b.grantId && a.revision === b.revision
const sameExecution = (a: ReferenceRefreshRequest['execution'], b: ReferenceRefreshRequest['execution']) => a.owner === b.owner && a.epoch === b.epoch
const sameSession = (a: ProjectSessionContext, b: ProjectSessionContext) => a.projectId === b.projectId && a.leaseId === b.leaseId && a.projectPath === b.projectPath
interface Flight {
  sender: WebContents
  session: ProjectSessionContext
  request: ReferenceRefreshRequest
  stop: AbortController
  gate: { token: string; decision: ReferenceRefreshAckRequest['decision'] | null;
    ready: ReturnType<typeof deferred<void>>; result: ReturnType<typeof deferred<ReferenceRefreshAckResult>> } | null
  operation: Promise<ReferenceRefreshSuccess>
  finished: boolean
}

/** The authority owns durable writes and resource claims; this adapter owns only its view ACK. */
export class ReferenceRefreshForeground {
  private readonly flights = new Map<Database.Database, Flight>()

  execute(runtime: ProjectRuntime, authority: ReferenceKnowledgeAuthority, sender: WebContents,
    session: ProjectSessionContext, request: ReferenceRefreshRequest, assertCurrent: () => void): Promise<ReferenceRefreshSuccess> {
    assertCurrent()
    const prior = this.flights.get(runtime.database)
    if (prior && !prior.finished) {
      if (prior.sender !== sender || !sameSession(prior.session, session) || !sameReference(prior.request.reference, request.reference)
        || !sameExecution(prior.request.execution, request.execution)) throw new Error('GENERATION_OWNER_BUSY')
      return prior.operation
    }
    if (sender.isDestroyed()) throw new Error('IMPORT_RUN_CANCELLED')
    const flight: Flight = { sender, session: Object.freeze({ ...session }), request: structuredClone(request),
      stop: new AbortController(), gate: null, operation: undefined!, finished: false }
    this.flights.set(runtime.database, flight)
    const stop = () => {
      flight.stop.abort()
      flight.gate?.ready.reject(new Error('IMPORT_RUN_CANCELLED'))
      flight.gate?.result.reject(new Error('IMPORT_RUN_CANCELLED'))
    }
    sender.once('destroyed', stop)
    let sequence = 0
    const emit = (projection: { kind: 'refresh'; token: string } | { kind: 'progress'; progress: 100 }) => {
      if (sender.isDestroyed()) { stop(); return }
      const event: ReferenceRefreshProgress = { reference: structuredClone(flight.request.reference),
        execution: { ...flight.request.execution }, leaseId: session.leaseId, sequence: ++sequence, ...projection }
      try { sender.send('reference-knowledge:v1:refresh-progress', event) }
      catch { if (projection.kind === 'refresh') stop() }
    }
    flight.operation = Promise.resolve().then(() => authority.executeRefresh(sender, flight.request, {
      signal: flight.stop.signal, assertCurrent,
      refresh: async () => {
        if (flight.stop.signal.aborted) throw new Error('IMPORT_RUN_CANCELLED')
        const gate = { token: randomUUID(), decision: null, ready: deferred<void>(), result: deferred<ReferenceRefreshAckResult>() }
        flight.gate = gate
        emit({ kind: 'refresh', token: gate.token })
        await gate.ready.promise
      },
      progress: progress => emit({ kind: 'progress', progress }),
      failureMessage: (code, locale) => explainImportRunFailure(code, locale)!.error,
    })).finally(() => {
      flight.finished = true
      sender.removeListener('destroyed', stop)
      flight.gate?.ready.reject(new Error('KNOWLEDGE_BASE_REFERENCE_OPERATION_FAILED'))
      flight.gate?.result.reject(new Error('KNOWLEDGE_BASE_REFERENCE_OPERATION_FAILED'))
    })
    return flight.operation
  }

  acknowledge(runtime: ProjectRuntime, sender: WebContents, session: ProjectSessionContext,
    request: ReferenceRefreshAckRequest): Promise<ReferenceRefreshAckResult> {
    const flight = this.flights.get(runtime.database), gate = flight?.gate
    if (!flight || flight.finished || !gate || flight.sender !== sender || sender.isDestroyed()
      || !sameSession(flight.session, session) || !sameReference(flight.request.reference, request.reference)
      || !sameExecution(flight.request.execution, request.execution) || gate.token !== request.token
      || gate.decision && gate.decision !== request.decision) throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    if (gate.decision) return gate.result.promise
    gate.decision = request.decision
    if (request.decision === 'completed') gate.ready.resolve()
    else gate.ready.reject(new Error(request.decision === 'cancelled' ? 'IMPORT_RUN_CANCELLED' : 'IMPORT_RUN_REFRESH_PROJECTION_FAILED'))
    gate.result.resolve({ version: 1 })
    return gate.result.promise
  }

  requestClose(runtime: ProjectRuntime): void {
    const flight = this.flights.get(runtime.database)
    if (!flight || flight.finished) return
    flight.stop.abort()
    flight.gate?.ready.reject(new Error('IMPORT_RUN_CANCELLED'))
    flight.gate?.result.reject(new Error('IMPORT_RUN_CANCELLED'))
  }

  release(database: Database.Database): void {
    const flight = this.flights.get(database)
    if (flight && !flight.finished) throw new Error('GENERATION_OWNER_BUSY')
    this.flights.delete(database)
  }
}

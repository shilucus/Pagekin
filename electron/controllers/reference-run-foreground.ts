import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { WebContents } from 'electron'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import type { ReferenceRunCompletion, ReferenceRunProgress, ReferenceRunProjectionAck,
  ReferenceRunProjectionAckResult, ReferenceRunRequest, ReferenceRunStage } from '../../src/shared/reference-run-contract'
import type { ReferenceGlobalResult } from '../../src/shared/reference-global-contract'
import type { ReferenceStyleResult } from '../../src/shared/reference-style-contract'
import type { ReferenceBlueprintResult } from '../../src/shared/reference-blueprint-contract'
import type { ReferenceRefreshSuccess } from '../../src/shared/reference-refresh-contract'
import type { ImportRunSnapshot } from '../../src/shared/import-run'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { executeReferenceImportMainRun } from '../services/reference-import-main-coordinator'
import { acquireImportRunParentFlight, assertImportRunParentFlightCurrent,
  type ImportRunParentFlightToken } from '../services/import-stage-flight'
import type { ReferenceKnowledgeAuthority, ReferenceKnowledgeExecutionHooks } from '../services/reference-knowledge-authority'
import { projectRuntimeHost, type ProjectRuntime } from '../services/project-runtime'
import { ReferenceRefreshForeground } from './reference-refresh-foreground'

export interface ReferenceRunGenerationStages {
  global(modelId: string | null, parent: ImportRunParentFlightToken, assertCurrent: () => void): Promise<ReferenceGlobalResult>
  style(modelId: string | null, parent: ImportRunParentFlightToken, assertCurrent: () => void): Promise<ReferenceStyleResult>
  blueprints(modelId: string | null, parent: ImportRunParentFlightToken, assertCurrent: () => void): Promise<ReferenceBlueprintResult>
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
const sameSession = (a: ProjectSessionContext, b: ProjectSessionContext) => a.projectId === b.projectId
  && a.leaseId === b.leaseId && a.projectPath === b.projectPath
const sameReference = (a: ReferenceRunRequest['reference'], b: ReferenceRunRequest['reference']) =>
  a.projectId === b.projectId && a.runId === b.runId && a.grantId === b.grantId && a.revision === b.revision
const sameExecution = (a: ReferenceRunRequest['execution'], b: ReferenceRunRequest['execution']) => a.owner === b.owner && a.epoch === b.epoch
interface Gate {
  stage: ReferenceRunStage
  token: string
  decision: ReferenceRunProjectionAck['decision'] | null
  ready: ReturnType<typeof deferred<void>>
  result: ReturnType<typeof deferred<ReferenceRunProjectionAckResult>>
}
interface Flight {
  sender: WebContents
  session: ProjectSessionContext
  request: ReferenceRunRequest
  stop: AbortController
  gate: Gate | null
  operation: Promise<ReferenceRefreshSuccess>
  operationSettled: boolean
  cleanup(): void
  finished: boolean
}

function retainSecondaryFailure(primary: unknown, secondary: unknown): void {
  if (!(primary instanceof Error)) return
  const target = primary as Error & { secondaryErrors?: unknown[] }
  if (!target.secondaryErrors) target.secondaryErrors = []
  target.secondaryErrors.push(secondary)
}

/** Main owns the whole foreground run; child adapters retain their original author-buffer ACK gates. */
export class ReferenceRunForeground {
  private readonly flights = new Map<Database.Database, Flight>()

  constructor(private readonly refresh: ReferenceRefreshForeground) {}

  execute(runtime: ProjectRuntime, authority: ReferenceKnowledgeAuthority, sender: WebContents,
    session: ProjectSessionContext, request: ReferenceRunRequest, generation: ReferenceRunGenerationStages,
    knowledge: ReferenceKnowledgeExecutionHooks, assertViewCurrent: () => void): Promise<ReferenceRefreshSuccess> {
    assertViewCurrent()
    const prior = this.flights.get(runtime.database)
    if (prior && !prior.finished) {
      if (prior.sender !== sender || !sameSession(prior.session, session) || !sameReference(prior.request.reference, request.reference)
        || !sameExecution(prior.request.execution, request.execution) || prior.request.modelId !== request.modelId) {
        throw new Error('GENERATION_OWNER_BUSY')
      }
      return prior.operation
    }
    if (sender.isDestroyed()) throw new Error('IMPORT_RUN_CANCELLED')
    const frozen: ReferenceRunRequest = Object.freeze({ reference: Object.freeze({ ...request.reference }),
      execution: Object.freeze({ ...request.execution }), modelId: request.modelId })
    const parent = acquireImportRunParentFlight(runtime.database, frozen.reference.runId)
    let releaseWork: (() => void) | undefined
    let releaseIssuance: (() => void) | undefined
    let cancellationDebt = false
    try {
      releaseWork = projectRuntimeHost.acquireLegacyOperation('reference-run:v1:execute')
      // A completed run may only retry the retained original grant, or validate completed history without an issuance.
      if (authority.hasIssuance(frozen.reference.grantId)) {
        releaseIssuance = authority.beginRun(sender, frozen.reference, frozen.execution, parent.token)
      }
    } catch (error) {
      try { releaseWork?.() } finally { parent.release() }
      throw error
    }
    const flight: Flight = { sender, session: Object.freeze({ ...session }), request: frozen,
      stop: new AbortController(), gate: null, operation: undefined!, operationSettled: false,
      cleanup: () => {
        if (flight.finished) return
        if (cancellationDebt) {
          authority.cancelRunAtBoundary(sender, frozen.reference, frozen.execution, parent.token)
          cancellationDebt = false
        }
        // A failed issuance cleanup retains both the writer fence and runtime work claim for a close-time retry.
        releaseIssuance?.()
        parent.release()
        releaseWork?.()
        flight.finished = true
      }, finished: false }
    this.flights.set(runtime.database, flight)
    const stop = () => {
      flight.stop.abort()
      flight.gate?.ready.reject(new Error('IMPORT_RUN_CANCELLED'))
      flight.gate?.result.reject(new Error('IMPORT_RUN_CANCELLED'))
    }
    sender.once('destroyed', stop)
    const context = { database: runtime.database, canonicalRoot: runtime.canonicalRoot, projectId: runtime.projectId }
    const currentRun = () => ImportRunRepository.get(frozen.reference.runId, context)
    const assertCurrent = () => {
      assertViewCurrent()
      assertImportRunParentFlightCurrent(runtime.database, frozen.reference.runId, parent.token)
      if (flight.stop.signal.aborted || sender.isDestroyed()) throw new Error('IMPORT_RUN_CANCELLED')
      const run = currentRun()
      if (!run) throw new Error('IMPORT_RUN_NOT_FOUND')
      if (run.status !== 'completed') {
        try { authority.assertRunCurrent(sender, frozen.reference, frozen.execution, parent.token) }
        catch (error) {
          // A confirmed revoke sets cancel_requested before its private issuance becomes unavailable.
          if (error instanceof Error && error.message === 'KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED' && run.cancelRequested) {
            const row = runtime.database.prepare('SELECT execution_owner, execution_epoch FROM import_runs WHERE id=?')
              .get(frozen.reference.runId) as { execution_owner: string; execution_epoch: number } | undefined
            if (row?.execution_owner === frozen.execution.owner && row.execution_epoch === frozen.execution.epoch) {
              throw new Error('IMPORT_RUN_CANCELLED')
            }
          }
          throw error
        }
        if (run.cancelRequested) throw new Error('IMPORT_RUN_CANCELLED')
      }
    }
    let sequence = 0
    type Projection = { kind: 'stage-started'; stage: ReferenceRunStage; run: ImportRunSnapshot }
      | { kind: 'stage-skipped'; stage: ReferenceRunStage; run: ImportRunSnapshot; token: string }
      | { kind: 'stage-completed'; token: string; completion: ReferenceRunCompletion }
    const emit = (projection: Projection) => {
      if (sender.isDestroyed()) { stop(); throw new Error('IMPORT_RUN_CANCELLED') }
      const event: ReferenceRunProgress = { reference: { ...frozen.reference }, execution: { ...frozen.execution },
        leaseId: session.leaseId, sequence: ++sequence, ...projection }
      try { sender.send('reference-run:v1:progress', event) }
      catch { stop(); throw new Error('GENERATION_REQUEST_FAILED') }
    }
    const projectStage = async (stage: ReferenceRunStage, run: ImportRunSnapshot,
      projection: { kind: 'stage-completed'; completion: ReferenceRunCompletion }
        | { kind: 'stage-skipped'; stage: ReferenceRunStage; run: ImportRunSnapshot }) => {
      assertCurrent()
      const gate: Gate = { stage, token: randomUUID(), decision: null,
        ready: deferred<void>(), result: deferred<ReferenceRunProjectionAckResult>() }
      flight.gate = gate
      // Restore canonical projections before the next child captures its author buffer, including resumed stage skips.
      let timer: ReturnType<typeof setTimeout> | undefined
      const check = () => {
        try { assertCurrent() }
        catch (error) { gate.ready.reject(error); return }
        timer = setTimeout(check, 25)
      }
      emit({ ...projection, token: gate.token })
      check()
      try {
        if (run.status === 'completed') await gate.ready.promise
        else await authority.withRunHeartbeat(sender, frozen.reference, frozen.execution, parent.token, () => gate.ready.promise)
        assertCurrent()
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    let primaryFailure: unknown
    flight.operation = Promise.resolve().then(() => executeReferenceImportMainRun({ runtime, request: frozen, assertCurrent,
      runners: {
        knowledge: () => authority.executeKnowledge(sender, frozen, knowledge, parent.token),
        global: modelId => generation.global(modelId, parent.token, assertCurrent),
        style: modelId => generation.style(modelId, parent.token, assertCurrent),
        blueprints: modelId => generation.blueprints(modelId, parent.token, assertCurrent),
        refresh: () => this.refresh.execute(runtime, authority, sender, session, frozen, assertCurrent, parent.token),
      }, hooks: {
        stageStarted: (stage, run) => emit({ kind: 'stage-started', stage, run }),
        stageSkipped: (stage, run) => projectStage(stage, run, { kind: 'stage-skipped', stage, run }),
        stageCompleted: completion => projectStage(completion.stage, completion.result.run, { kind: 'stage-completed', completion }),
      } })).catch(error => {
      primaryFailure = error
      if (error instanceof Error && error.message === 'IMPORT_RUN_CANCELLED' && authority.hasIssuance(frozen.reference.grantId)) {
        try { authority.cancelRunAtBoundary(sender, frozen.reference, frozen.execution, parent.token) }
        catch (cleanupError) {
          cancellationDebt = true
          retainSecondaryFailure(error, cleanupError)
        }
      }
      throw error
    }).finally(() => {
      // Every runner settles only after its existing physical work drains; no release-and-await handoff gap.
      flight.operationSettled = true
      sender.removeListener('destroyed', stop)
      flight.gate?.ready.reject(new Error('GENERATION_REQUEST_FAILED'))
      flight.gate?.result.reject(new Error('GENERATION_REQUEST_FAILED'))
      try { if (!cancellationDebt) flight.cleanup() }
      catch (cleanupError) {
        if (primaryFailure !== undefined) retainSecondaryFailure(primaryFailure, cleanupError)
        else throw cleanupError
      }
    })
    return flight.operation
  }

  acknowledge(runtime: ProjectRuntime, sender: WebContents, session: ProjectSessionContext,
    request: ReferenceRunProjectionAck): Promise<ReferenceRunProjectionAckResult> {
    const flight = this.flights.get(runtime.database), gate = flight?.gate
    if (!flight || flight.finished || !gate || flight.sender !== sender || sender.isDestroyed()
      || !sameSession(flight.session, session) || !sameReference(flight.request.reference, request.reference)
      || !sameExecution(flight.request.execution, request.execution) || gate.stage !== request.stage || gate.token !== request.token
      || gate.decision && gate.decision !== request.decision) throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    if (gate.decision) return gate.result.promise
    gate.decision = request.decision
    if (request.decision === 'settled') gate.ready.resolve()
    else gate.ready.reject(new Error(request.decision === 'cancelled' ? 'IMPORT_RUN_CANCELLED' : 'GENERATION_REQUEST_FAILED'))
    gate.result.resolve({ version: 1 })
    return gate.result.promise
  }

  requestClose(runtime: ProjectRuntime): void {
    const flight = this.flights.get(runtime.database)
    if (!flight || flight.finished) return
    flight.stop.abort()
    flight.gate?.ready.reject(new Error('IMPORT_RUN_CANCELLED'))
    flight.gate?.result.reject(new Error('IMPORT_RUN_CANCELLED'))
    if (flight.operationSettled) flight.cleanup()
  }

  release(database: Database.Database): void {
    const flight = this.flights.get(database)
    if (flight?.operationSettled) flight.cleanup()
    if (flight && !flight.finished) throw new Error('GENERATION_OWNER_BUSY')
    this.flights.delete(database)
  }
}

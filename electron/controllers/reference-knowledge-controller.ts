import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  REFERENCE_KNOWLEDGE_CHANNELS, assertReferenceKnowledgeRequest, referenceKnowledgeRequiresView,
  type ExecuteReferenceKnowledgeRequest, type PrepareReferenceKnowledgeRequest, type ReferenceKnowledgeChannels,
  type ReferenceKnowledgeReference,
} from '../../src/shared/reference-knowledge-contract'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import { projectAccess } from '../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../services/project-runtime'
import { withLegacyProjectOperation } from '../services/project-runtime-compatibility'
import { ReferenceKnowledgeAuthority, ReferenceKnowledgeExecutionFailure } from '../services/reference-knowledge-authority'
import { knowledgeBaseLoader } from '../services/knowledge-base-loader'
import { assertKnowledgeBaseStoragePathSupported, projectStoragePreflightFailure } from '../services/project-storage-preflight'
import { getEmbeddingConfig, referenceImportDisplayName, explainReferenceImportFailure,
  isLegacyMigrationBlockedError, isLegacyMigrationBlockedResult, legacyMigrationBlockedFailure } from './kb-controller'
import { explainImportRunFailure, importRunLocale } from './import-run-failure'
import type { ReferenceRefreshAckRequest, ReferenceRefreshRequest } from '../../src/shared/reference-refresh-contract'
import { ReferenceRefreshForeground } from './reference-refresh-foreground'
import type { GenerationSchedulingAdmission } from '../services/generation-scheduler'
import { REFERENCE_RUN_CHANNELS, assertReferenceRunRequest, type ReferenceRunRequest,
  type ReferenceRunProjectionAck } from '../../src/shared/reference-run-contract'
import { ReferenceRunForeground } from './reference-run-foreground'
import { ReferenceGlobalFailure } from '../services/reference-global-driver'
import { ReferenceStyleFailure } from '../services/reference-style-driver'
import { ReferenceBlueprintFailure } from '../services/reference-blueprint-driver'
import { importGenerationStopMessage } from '../../src/i18n/app-errors'
import type { registerGenerationController } from './generation-controller'
import { ImportRunRepository } from '../repositories/import-run-repository'

const authorities = new Map<ProjectRuntime, ReferenceKnowledgeAuthority>()
const refreshForeground = new ReferenceRefreshForeground()
const runForeground = new ReferenceRunForeground(refreshForeground)
const IMPORT_FAILURE_CODE = /^(?:KNOWLEDGE_BASE_|IMPORT_RUN_|EMBEDDING_|REFERENCE_EMBEDDING_|REFERENCE_IMPORT_)[A-Z0-9_]+$/u
let lifecycleInstalled = false

function failureCode(error: unknown, importOperation: boolean): string {
  const code = error instanceof Error ? error.message : ''
  if (importOperation && IMPORT_FAILURE_CODE.test(code)) return code
  if (/^(?:KNOWLEDGE_BASE_REFERENCE_|IMPORT_RUN_)[A-Z0-9_]+$/u.test(code)) return code
  if (code === 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE'
    || error && typeof error === 'object' && 'code' in error && error.code === 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE') {
    return 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE'
  }
  return 'KNOWLEDGE_BASE_REFERENCE_AUTHORITY_REJECTED'
}

function capability(reference: ReferenceKnowledgeReference): ReferenceKnowledgeAuthority {
  for (const [runtime, authority] of authorities) {
    if (runtime.projectId === reference.projectId && authority.hasIssuance(reference.grantId)) return authority
  }
  throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
}

async function authorized(runtime: ProjectRuntime, fresh: () => void, scheduler?: GenerationSchedulingAdmission): Promise<ReferenceKnowledgeAuthority> {
  const retained = authorities.get(runtime)
  if (retained) return retained
  // Keep native loading lazy; the enclosing legacy lease prevents a foreground switch while awaiting it.
  const kb = await knowledgeBaseLoader.load()
  fresh()
  let authority = authorities.get(runtime)
  if (!authority) {
    authority = new ReferenceKnowledgeAuthority(runtime, {
      resources: kb.captureReferenceImportResources(runtime),
      captureEmbedding: () => getEmbeddingConfig() ?? {
        modelId: null, protocol: 'openai', model: { provider: '', baseUrl: '', apiKey: '' },
      },
      importReference: input => kb.importReferenceText(
        input.binding.content, referenceImportDisplayName(input.binding), input.binding.stableKey,
        input.binding.chapterNumber, input.runId, input.execution, runtime.canonicalRoot,
        input.embedding.protocol, input.embedding.model, input.resources, input.admission,
        scheduler ? { admission: scheduler, projectKey: runtime.executionEpoch, lane: 'background',
          assertActive: input.resources.assertResources } : undefined,
      ),
    })
    authorities.set(runtime, authority)
  }
  return authority
}

export function registerReferenceKnowledgeController(scheduler?: GenerationSchedulingAdmission,
  generation?: ReturnType<typeof registerGenerationController>): void {
  if (!lifecycleInstalled) {
    projectRuntimeHost.registerRetirementGuard(runtime => {
      const authority = authorities.get(runtime)
      if (authority && !authority.canRetire()) return false
      const database = runtime.database
      if (database.prepare("SELECT 1 FROM reference_embedding_budgets WHERE state='recovery_unknown' OR active_since_ms IS NOT NULL LIMIT 1").get()) return false
      if (database.prepare("SELECT 1 FROM reference_embedding_dispatches WHERE state IN ('dispatch_marked','transport_unknown') LIMIT 1").get()) return false
      if (database.prepare(`SELECT 1 FROM import_effect_ledger e JOIN import_runs r ON r.id=e.run_id
        WHERE r.purpose='reference' AND e.state='unknown' LIMIT 1`).get()) return false
      return true
    })
    projectRuntimeHost.onCloseRequested(runtime => {
      runForeground.requestClose(runtime)
      refreshForeground.requestClose(runtime)
      authorities.get(runtime)?.requestProjectClose()
    })
    projectRuntimeHost.onBeforeRelease(runtime => {
      runForeground.release(runtime.database)
      refreshForeground.release(runtime.database)
      authorities.get(runtime)?.retire()
      authorities.delete(runtime)
    })
    lifecycleInstalled = true
  }
  if (generation) for (const channel of REFERENCE_RUN_CHANNELS) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
      let runId: string | undefined
      try {
        const session = raw[1]
        if (raw.length !== 2 || !isProjectSessionContext(session)) throw new Error('KNOWLEDGE_BASE_REFERENCE_SESSION_REQUIRED')
        assertReferenceRunRequest(channel, raw[0])
        const body = raw[0]
        runId = body.reference.runId
        const runtime = projectAccess.assertViewContext(session)
        const database = runtime.database, identity = runtime.databaseIdentity, executionEpoch = runtime.executionEpoch
        const fresh = () => {
          if (projectAccess.assertViewContext(session) !== runtime) throw new Error('KNOWLEDGE_BASE_REFERENCE_RESOURCES_CHANGED')
          projectRuntimeHost.assertWorkAvailable(runtime)
          if (event.sender.isDestroyed()) throw new Error('IMPORT_RUN_CANCELLED')
        }
        fresh()
        assertKnowledgeBaseStoragePathSupported(runtime.canonicalRoot)
        if (channel === 'reference-run:v1:execute') {
          const request = body as ReferenceRunRequest
          const authority = authorities.get(runtime)
          if (request.reference.projectId !== runtime.projectId || !authority) {
            throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
          }
          const run = ImportRunRepository.get(request.reference.runId, {
            database: runtime.database, canonicalRoot: runtime.canonicalRoot, projectId: runtime.projectId,
          })
          if (run?.status !== 'completed') {
            authority.assertRunAdmission(event.sender, request.reference, request.execution)
            // Only the authorized run may initialize its captured owner before acquiring work.
            generation.prepareReferenceRun(runtime, event, session)
          }
        }
        return await (async () => {
          fresh()
          if (channel === 'reference-run:v1:projection-ack') {
            return runForeground.acknowledge(runtime, event.sender, session, body as ReferenceRunProjectionAck)
          }
          const request = body as ReferenceRunRequest
          const authority = authorities.get(runtime)
          if (request.reference.projectId !== runtime.projectId || !authority) {
            throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
          }
          const stageRequest = (modelId: string | null) => ({ runId: request.reference.runId,
            execution: request.execution, modelId })
          const result = await runForeground.execute(runtime, authority, event.sender, session, request, {
            global: (modelId, parent, current) => generation.referenceGlobal(runtime, event, session, stageRequest(modelId), parent, current),
            style: (modelId, parent, current) => generation.referenceStyle(runtime, event, session, stageRequest(modelId), parent, current),
            blueprints: (modelId, parent, current) => generation.referenceBlueprints(runtime, event, session, stageRequest(modelId), parent, current),
          }, {
            progress: progress => {
              if (event.sender.isDestroyed()) return
              try { event.sender.send('reference-knowledge:v1:progress', progress) }
              catch { /* The whole-flight lifecycle stops impossible view waits; facts remain owned by the authority. */ }
            },
            failureMessage: (code, locale, source) => {
              const failure = { success: false, error: code, errorCode: code }
              if (isLegacyMigrationBlockedResult(failure)) return legacyMigrationBlockedFailure().error
              if (source === 'result') return explainReferenceImportFailure(failure, runId!, locale).error!
              return explainImportRunFailure(code, locale)?.error
                ?? explainReferenceImportFailure(failure, runId!, locale).error!
            },
          }, () => {
            projectRuntimeHost.assertWorkAvailable(runtime)
            if (runtime.database !== database || runtime.databaseIdentity !== identity || runtime.executionEpoch !== executionEpoch
              || !database.open) throw new Error('KNOWLEDGE_BASE_REFERENCE_RESOURCES_CHANGED')
          })
          return { success: true, ...result }
        })()
      } catch (error) {
        if (error && typeof error === 'object' && 'secondaryErrors' in error
          && Array.isArray(error.secondaryErrors) && error.secondaryErrors.length) {
          console.error('[reference-run] terminal cleanup failed', { channel, secondaryErrorCount: error.secondaryErrors.length })
        }
        if (error instanceof ReferenceKnowledgeExecutionFailure || error instanceof ReferenceGlobalFailure
          || error instanceof ReferenceStyleFailure || error instanceof ReferenceBlueprintFailure) {
          return { success: false, error: error.displayMessage, errorCode: error.errorCode,
            ...(error instanceof ReferenceGlobalFailure && error.completionFailureCode ? { completionFailureCode: error.completionFailureCode } : {}),
            ...(error instanceof ReferenceBlueprintFailure && error.postCommitSyncBatchId ? { postCommitSyncBatchId: error.postCommitSyncBatchId } : {}) }
        }
        const boundary = isLegacyMigrationBlockedError(error) ? legacyMigrationBlockedFailure() : projectStoragePreflightFailure(error)
        if (boundary) return boundary
        const code = error instanceof Error && /^(?:GENERATION_|IMPORT_RUN_|REFERENCE_RUN_|KNOWLEDGE_BASE_REFERENCE_|ROOT_BUDGET_)[A-Z0-9_]+$/u.test(error.message)
          ? error.message : 'KNOWLEDGE_BASE_REFERENCE_AUTHORITY_REJECTED'
        if (!runId || channel === 'reference-run:v1:projection-ack') throw new Error(code)
        const locale = importRunLocale(runId)
        return { success: false, errorCode: code,
          error: importGenerationStopMessage(locale, code, false, 'reference')
            ?? explainImportRunFailure(code, locale)?.error
            ?? explainImportRunFailure('GENERATION_REQUEST_FAILED', locale)!.error }
      }
    })
  }
  for (const channel of REFERENCE_KNOWLEDGE_CHANNELS) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
      let runId: string | undefined
      try {
        const requiresView = referenceKnowledgeRequiresView(channel)
        if (raw.length !== (requiresView ? 2 : 1)) throw new Error('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID')
        const body = raw[0]
        assertReferenceKnowledgeRequest(channel, body)
        const hasExecution = channel === 'reference-knowledge:v1:import' || channel === 'reference-knowledge:v1:execute'
          || channel === 'reference-knowledge:v1:refresh' || channel === 'reference-knowledge:v1:refresh-ack'
        runId = hasExecution
          ? (body as ExecuteReferenceKnowledgeRequest).reference.runId
          : (body as PrepareReferenceKnowledgeRequest | ReferenceKnowledgeReference).runId
        if (!requiresView) return capability(body as ReferenceKnowledgeReference).revoke(event.sender, body as ReferenceKnowledgeReference)
        const session = raw[1]
        if (!isProjectSessionContext(session)) throw new Error('KNOWLEDGE_BASE_REFERENCE_SESSION_REQUIRED')
        const runtime = projectAccess.assertViewContext(session)
        const fresh = () => {
          if (projectAccess.assertViewContext(session) !== runtime) throw new Error('KNOWLEDGE_BASE_REFERENCE_RESOURCES_CHANGED')
          projectRuntimeHost.assertWorkAvailable(runtime)
          if (event.sender.isDestroyed()) throw new Error('KNOWLEDGE_BASE_REFERENCE_CALLER_DESTROYED')
        }
        fresh()
        assertKnowledgeBaseStoragePathSupported(runtime.canonicalRoot)
        if (channel === 'reference-knowledge:v1:refresh-ack' && refreshForeground.hasParent(runtime)) {
          return await refreshForeground.acknowledge(runtime, event.sender, session, body as ReferenceRefreshAckRequest)
        }
        return await withLegacyProjectOperation(channel, async () => {
          fresh()
          if (channel === 'reference-knowledge:v1:prepare') {
            const authority = await authorized(runtime, fresh, scheduler)
            return authority.prepare(event.sender, body as PrepareReferenceKnowledgeRequest, fresh)
          }
          const reference = hasExecution
            ? (body as ExecuteReferenceKnowledgeRequest).reference
            : body as ReferenceKnowledgeReference
          if (channel === 'reference-knowledge:v1:refresh' || channel === 'reference-knowledge:v1:refresh-ack') {
            const authority = authorities.get(runtime)
            if (reference.projectId !== runtime.projectId || !authority) {
              throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
            }
            if (channel === 'reference-knowledge:v1:refresh-ack') {
              return refreshForeground.acknowledge(runtime, event.sender, session, body as ReferenceRefreshAckRequest)
            }
            // Completed run/grant history has no issuance; the authority permits only its read-only branch.
            const result = await refreshForeground.execute(runtime, authority, event.sender, session, body as ReferenceRefreshRequest, fresh)
            return { success: true, ...result }
          }
          if (reference.projectId !== runtime.projectId || authorities.get(runtime) !== capability(reference)) {
            throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
          }
          const authority = authorities.get(runtime)!
          if (channel === 'reference-knowledge:v1:resume') return authority.resume(event.sender, reference)
          if (channel === 'reference-knowledge:v1:complete') return authority.complete(event.sender, reference)
          if (channel === 'reference-knowledge:v1:execute') {
            const result = await authority.executeKnowledge(event.sender, body as ExecuteReferenceKnowledgeRequest, {
              progress: progress => {
                if (event.sender.isDestroyed()) return
                try { event.sender.send('reference-knowledge:v1:progress', progress) }
                catch { /* A lost view projection cannot change committed receipts or stage ownership. */ }
              },
              failureMessage: (code, locale, source) => {
                const result = { success: false, error: code, errorCode: code }
                if (isLegacyMigrationBlockedResult(result)) return legacyMigrationBlockedFailure().error
                if (source === 'result') return explainReferenceImportFailure(result, runId!, locale).error!
                return explainImportRunFailure(code, locale)?.error
                  ?? explainReferenceImportFailure(result, runId!, locale).error!
              },
            })
            return { success: true, ...result }
          }
          const result = await authority.importChapter(event.sender,
            body as ReferenceKnowledgeChannels['reference-knowledge:v1:import']['args'][0])
          if (isLegacyMigrationBlockedResult(result)) return legacyMigrationBlockedFailure()
          if (!result.success) {
            const rawCode = result.errorCode ?? result.error
            const code = typeof rawCode === 'string'
              && IMPORT_FAILURE_CODE.test(rawCode)
              ? rawCode : 'KNOWLEDGE_BASE_REFERENCE_OPERATION_FAILED'
            return explainReferenceImportFailure({ ...result, error: code, errorCode: code }, runId!)
          }
          return explainReferenceImportFailure(result, runId!)
        })
      } catch (error) {
        const executing = channel === 'reference-knowledge:v1:execute' || channel === 'reference-knowledge:v1:refresh'
        if (executing && error instanceof ReferenceKnowledgeExecutionFailure) {
          return { success: false, error: error.displayMessage, errorCode: error.errorCode }
        }
        const boundaryFailure = isLegacyMigrationBlockedError(error) ? legacyMigrationBlockedFailure()
          : projectStoragePreflightFailure(error)
        if (boundaryFailure) {
          if (channel === 'reference-knowledge:v1:import' || executing) return boundaryFailure
          throw new Error(boundaryFailure.error ?? 'KNOWLEDGE_BASE_REFERENCE_AUTHORITY_REJECTED')
        }
        const code = failureCode(error, channel === 'reference-knowledge:v1:import' || executing)
        if (channel === 'reference-knowledge:v1:revoke' || !runId) throw new Error(code)
        const importFailure = explainImportRunFailure(code, () => importRunLocale(runId!))
        const result = importFailure ?? explainReferenceImportFailure({ success: false, error: code, errorCode: code }, runId)
        if (channel === 'reference-knowledge:v1:import' || executing) return { ...result, success: false }
        throw new Error(result.error ?? code)
      }
    })
  }
}

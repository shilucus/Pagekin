import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  REFERENCE_KNOWLEDGE_CHANNELS, assertReferenceKnowledgeRequest, referenceKnowledgeRequiresView,
  type PrepareReferenceKnowledgeRequest, type ReferenceKnowledgeChannels,
  type ReferenceKnowledgeReference,
} from '../../src/shared/reference-knowledge-contract'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import { projectAccess } from '../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../services/project-runtime'
import { withLegacyProjectOperation } from '../services/project-runtime-compatibility'
import { ReferenceKnowledgeAuthority } from '../services/reference-knowledge-authority'
import { knowledgeBaseLoader } from '../services/knowledge-base-loader'
import { assertKnowledgeBaseStoragePathSupported, projectStoragePreflightFailure } from '../services/project-storage-preflight'
import { getEmbeddingConfig, referenceImportDisplayName, explainReferenceImportFailure,
  isLegacyMigrationBlockedError, isLegacyMigrationBlockedResult, legacyMigrationBlockedFailure } from './kb-controller'
import { explainImportRunFailure, importRunLocale } from './import-run-failure'

const authorities = new Map<ProjectRuntime, ReferenceKnowledgeAuthority>()
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

async function authorized(runtime: ProjectRuntime, fresh: () => void): Promise<ReferenceKnowledgeAuthority> {
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
      ),
    })
    authorities.set(runtime, authority)
  }
  return authority
}

export function registerReferenceKnowledgeController(): void {
  if (!lifecycleInstalled) {
    projectRuntimeHost.onCloseRequested(runtime => authorities.get(runtime)?.requestProjectClose())
    projectRuntimeHost.onBeforeRelease(runtime => {
      authorities.get(runtime)?.retire()
      authorities.delete(runtime)
    })
    lifecycleInstalled = true
  }
  for (const channel of REFERENCE_KNOWLEDGE_CHANNELS) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
      let runId: string | undefined
      try {
        const requiresView = referenceKnowledgeRequiresView(channel)
        if (raw.length !== (requiresView ? 2 : 1)) throw new Error('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID')
        const body = raw[0]
        assertReferenceKnowledgeRequest(channel, body)
        runId = channel === 'reference-knowledge:v1:import'
          ? (body as ReferenceKnowledgeChannels['reference-knowledge:v1:import']['args'][0]).reference.runId
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
        return await withLegacyProjectOperation(channel, async () => {
          fresh()
          if (channel === 'reference-knowledge:v1:prepare') {
            const authority = await authorized(runtime, fresh)
            return authority.prepare(event.sender, body as PrepareReferenceKnowledgeRequest, fresh)
          }
          const reference = channel === 'reference-knowledge:v1:import'
            ? (body as ReferenceKnowledgeChannels['reference-knowledge:v1:import']['args'][0]).reference
            : body as ReferenceKnowledgeReference
          if (reference.projectId !== runtime.projectId || authorities.get(runtime) !== capability(reference)) {
            throw new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
          }
          const authority = authorities.get(runtime)!
          if (channel === 'reference-knowledge:v1:resume') return authority.resume(event.sender, reference)
          if (channel === 'reference-knowledge:v1:complete') return authority.complete(event.sender, reference)
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
        const boundaryFailure = isLegacyMigrationBlockedError(error) ? legacyMigrationBlockedFailure()
          : projectStoragePreflightFailure(error)
        if (boundaryFailure) {
          if (channel === 'reference-knowledge:v1:import') return boundaryFailure
          throw new Error(boundaryFailure.error ?? 'KNOWLEDGE_BASE_REFERENCE_AUTHORITY_REJECTED')
        }
        const code = failureCode(error, channel === 'reference-knowledge:v1:import')
        if (channel === 'reference-knowledge:v1:revoke' || !runId) throw new Error(code)
        const importFailure = explainImportRunFailure(code, () => importRunLocale(runId!))
        const result = importFailure ?? explainReferenceImportFailure({ success: false, error: code, errorCode: code }, runId)
        if (channel === 'reference-knowledge:v1:import') return { ...result, success: false }
        throw new Error(result.error ?? code)
      }
    })
  }
}

import type Database from 'better-sqlite3'
import { hasRequiredApiKey } from '../../src/shared/provider-presets'
import { getImportInferenceTopics } from '../../src/shared/import-inference-materials'
import type { ImportGenerationContext } from '../../src/shared/import-generation'
import type { ImportRunExecutionAuthority } from '../../src/shared/import-run'
import { importQueryContextFingerprint, importQueryHash, ImportQueryBarrierError, type ImportQueryBinding,
  type ImportQueryErrorCode, type ImportQueryTopic, type ImportQueryReceipt } from './import-query-contract'
import type { ImportQueryRepository } from '../repositories/import-query-repository'
import { captureReferenceImportKnowledgeSnapshot, verifyDurableReferenceImportKnowledgeSnapshot,
  type ReferenceImportResources } from '../knowledge-base'
import type { ReferenceImportKnowledgeSnapshot } from './reference-import-knowledge-source'
import type { SearchResult } from '../vector-store'
import { normalizeEmbeddingOptions, type EmbeddingModel } from '../../src/shared/embedding-options'
import { EmbeddingDispatchBarrierError } from './reference-embedding-dispatch-contract'
import type { GenerationSchedulingAdmission } from './generation-scheduler'
import type { SchedulerLane } from './main-process-scheduler'
import type { MainProcessSchedulerPermit } from './main-process-scheduler'
import { withKnowledgeSourceGate } from './knowledge-source-gate'
import { getProjectDataRoot } from './project-data-locator'

export interface ImportQueryConfiguration {
  modelId: string
  protocol: 'openai' | 'gemini'
  model: EmbeddingModel & { modelName: string }
}

export interface ImportQueryMaterials {
  version: 1
  topics: { key: ImportQueryTopic; results: SearchResult[] | null }[]
}

export interface ImportQueryMaterialsDependencies {
  database: Database.Database
  queries: ImportQueryRepository
  resources: () => ReferenceImportResources
  loadConfiguration: () => ImportQueryConfiguration | null
  scheduling: {
    admission: GenerationSchedulingAdmission
    projectKey: string
    lane: SchedulerLane
    quarantineAfterMs: number
  } | undefined
  beforeDispatch?: () => void
  onPhysicalStart?: (rootActionId: string) => () => void
}

export interface PrepareImportQueryMaterials {
  context: ImportGenerationContext
  generationRunId: string
  rootActionId: string
  execution: ImportRunExecutionAuthority
  assertActive: () => void
  signal: AbortSignal
}

function configurationFingerprint(configuration: ImportQueryConfiguration | null): string {
  if (!configuration) return importQueryHash(JSON.stringify({ state: 'unconfigured' }))
  const model = configuration.model
  return importQueryHash(JSON.stringify({
    modelId: configuration.modelId,
    protocol: configuration.protocol,
    model: {
      provider: model.provider,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      modelName: model.modelName,
      embeddingOptions: normalizeEmbeddingOptions(model.embeddingOptions),
    },
  }))
}

function durableSnapshot(snapshot: ReferenceImportKnowledgeSnapshot): ImportQueryReceipt & { state: 'available' } {
  const { projectStorageRoot: _root, runtimeEpoch: _epoch, ...material } = snapshot
  void _root; void _epoch
  return { version: 1, state: 'available', snapshot: material }
}

function isSearchUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === 'REFERENCE_IMPORT_KNOWLEDGE_SEARCH_UNAVAILABLE'
}

function barrier(error: unknown): never {
  if (error instanceof ImportQueryBarrierError) throw new EmbeddingDispatchBarrierError(error.code)
  if (error instanceof Error && importQueryErrorCodes.has(error.message as ImportQueryErrorCode)) {
    throw new EmbeddingDispatchBarrierError(error.message as ImportQueryErrorCode)
  }
  throw error
}

const importQueryErrorCodes = new Set<ImportQueryErrorCode>([
  'GENERATION_IMPORT_QUERY_REQUIRED', 'GENERATION_IMPORT_QUERY_INVALID', 'GENERATION_IMPORT_QUERY_PLAN_CONFLICT',
  'GENERATION_IMPORT_QUERY_ROOT_CHANGED', 'GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN', 'GENERATION_IMPORT_QUERY_RECEIPT_INVALID',
  'GENERATION_IMPORT_QUERY_PERSISTENCE_FAILED', 'GENERATION_IMPORT_QUERY_HISTORY_FROZEN', 'ROOT_BUDGET_EXHAUSTED',
  'GENERATION_DISPATCH_BLOCKED', 'GENERATION_ACTION_CANCELLED',
])

export class ImportQueryMaterialsService {
  constructor(private readonly dependencies: ImportQueryMaterialsDependencies) {}

  private async completeAvailable(plan: ReturnType<ImportQueryRepository['prepare']>, topic: ImportQueryTopic,
    receipt: ImportQueryReceipt & { state: 'available' }, assertActive: () => void): Promise<ImportQueryReceipt> {
    const resources = this.dependencies.resources()
    const release = resources.acquireWork()
    try {
      return await withKnowledgeSourceGate(getProjectDataRoot(resources.canonicalRoot), async () => {
        await verifyDurableReferenceImportKnowledgeSnapshot({ snapshot: receipt.snapshot, resources, assertAuthority: assertActive })
        assertActive()
        return this.dependencies.queries.complete(plan, topic, receipt, assertActive)
      })
    } finally { release() }
  }

  async prepare(input: PrepareImportQueryMaterials): Promise<ImportQueryMaterials> {
    try { return await this.prepareMaterials(input) }
    catch (error) { barrier(error) }
  }

  private async prepareMaterials(input: PrepareImportQueryMaterials): Promise<ImportQueryMaterials> {
    const { context, generationRunId, rootActionId, assertActive, signal } = input
    void input.execution
    const importRunId = context.slot.runId
    const topics = getImportInferenceTopics(context.core.writingLanguage)
    assertActive()
    this.dependencies.queries.preflight(importRunId)
    const previous = this.dependencies.queries.get(importRunId)
    let configuration: ImportQueryConfiguration | null = null
    if (!previous || previous.topics.some(topic => topic.state !== 'completed')) {
      const loaded = this.dependencies.loadConfiguration()
      configuration = loaded ? structuredClone(loaded) : null
    }
    const binding: ImportQueryBinding = {
      version: 1,
      slot: { stage: 'global', batchId: context.slot.batchId, writingLanguage: context.core.writingLanguage },
      contextFingerprint: importQueryContextFingerprint(context),
      configurationFingerprint: previous?.topics.every(topic => topic.state === 'completed')
        ? previous.binding.configurationFingerprint : configurationFingerprint(configuration),
      topics: topics.map(({ key, query, topK }) => ({ key, query, topK })),
    }
    const plan = this.dependencies.queries.prepare({ generationRunId, importRunId, binding, assertCurrent: assertActive })
    if (plan.record.root_action_id !== rootActionId) {
      throw new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_ROOT_CHANGED')
    }
    const materials: ImportQueryMaterials['topics'] = []
    for (const topic of topics) {
      assertActive()
      const receipt = this.dependencies.queries.readReceipt(plan, topic.key)
      if (receipt) {
        if (receipt.state === 'available') {
          try {
            await verifyDurableReferenceImportKnowledgeSnapshot({
              snapshot: receipt.snapshot,
              resources: this.dependencies.resources(),
              assertAuthority: assertActive,
            })
          } catch (error) { barrier(error) }
          materials.push({ key: topic.key, results: receipt.snapshot.results })
        } else {
          materials.push({ key: topic.key, results: null })
        }
        continue
      }

      let permit: MainProcessSchedulerPermit | undefined
      let flight: ReturnType<ImportQueryRepository['openFlight']> | undefined
      let releaseOwnerPhysical: (() => void) | undefined
      let repositoryPhysicalReleased = false
      let permitFinished = false
      let quarantineTimer: ReturnType<typeof setTimeout> | undefined
      let abortListener: (() => void) | undefined
      const releasePhysical = () => {
        if (quarantineTimer !== undefined) clearTimeout(quarantineTimer)
        if (abortListener) signal.removeEventListener('abort', abortListener)
        abortListener = undefined
        try {
          if (flight && !repositoryPhysicalReleased) {
            repositoryPhysicalReleased = true
            this.dependencies.queries.releasePhysical(flight)
          }
        } finally {
          const release = releaseOwnerPhysical
          releaseOwnerPhysical = undefined
          try { release?.() }
          finally {
            if (!permitFinished) {
              permitFinished = true
              permit?.finish()
            }
          }
        }
      }
      const canEmbed = !!configuration && hasRequiredApiKey(configuration.model) && topic.query.trim().length > 0
      if (canEmbed) {
        const scheduling = this.dependencies.scheduling
        const acquireEmbedding = scheduling?.admission.acquireEmbedding
        if (!scheduling || !acquireEmbedding) throw new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_REQUIRED')
        try {
          permit = await acquireEmbedding.call(scheduling.admission, {
            projectKey: scheduling.projectKey,
            configuration: { protocol: configuration!.protocol, model: configuration!.model },
            lane: scheduling.lane,
            signal,
          })
          assertActive()
          flight = this.dependencies.queries.openFlight(plan, topic.key)
        } catch (error) {
          permit?.finish()
          barrier(error)
        }
      }
      const observer = flight ? {
        forBatch: (batchOrdinal: number, inputCount: number) => {
          if (batchOrdinal !== 0 || inputCount !== 1) {
            throw new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_INVALID')
          }
          return {
            beforeDispatch: () => {
              assertActive()
              this.dependencies.beforeDispatch?.()
              const release = this.dependencies.onPhysicalStart?.(rootActionId)
              try {
                this.dependencies.queries.beforeDispatch(flight!, assertActive)
                releaseOwnerPhysical = release
                const quarantineAfterMs = this.dependencies.scheduling?.quarantineAfterMs
                if (permit && Number.isSafeInteger(quarantineAfterMs) && quarantineAfterMs! > 0) {
                  abortListener = () => {
                    quarantineTimer = setTimeout(() => { permit?.quarantine() }, quarantineAfterMs)
                  }
                  signal.addEventListener('abort', abortListener, { once: true })
                  if (signal.aborted) abortListener()
                }
              } catch (error) {
                release?.()
                barrier(error)
              }
            },
            settled: (outcome: Parameters<ImportQueryRepository['settle']>[1]) => {
              try { this.dependencies.queries.settle(flight!, outcome) }
              catch (error) { barrier(error) }
              finally { releasePhysical() }
              if (outcome.kind === 'transport_unknown') {
                throw new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN')
              }
            },
          }
        },
      } : undefined

      try {
        const snapshot = await captureReferenceImportKnowledgeSnapshot({
          query: topic.query,
          resources: this.dependencies.resources(),
          configuration: canEmbed ? { protocol: configuration!.protocol, model: configuration!.model } : null,
          topK: topic.topK,
          assertAuthority: assertActive,
          signal,
          observer,
        })
        releasePhysical()
        const completed = await this.completeAvailable(plan, topic.key, durableSnapshot(snapshot), assertActive)
        if (completed.state !== 'available') throw new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_INVALID')
        materials.push({ key: topic.key, results: completed.snapshot.results })
      } catch (error) {
        releasePhysical()
        if (isSearchUnavailable(error)) {
          const unavailable = this.dependencies.queries.complete(plan, topic.key, { version: 1, state: 'unavailable' }, assertActive)
          if (unavailable.state !== 'unavailable') throw new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_INVALID')
          materials.push({ key: topic.key, results: null })
          continue
        }
        barrier(error)
      }
    }
    return { version: 1, topics: materials }
  }

  async withSources<T>(input: { context: ImportGenerationContext; rootActionId: string; assertActive: () => void }, operation: () => T): Promise<T> {
    const importRunId = input.context.slot.runId
    input.assertActive()
    this.dependencies.queries.preflight(importRunId)
    const plan = this.dependencies.queries.get(importRunId)
    if (!plan) return operation()
    if (plan.record.root_action_id !== input.rootActionId
      || plan.binding.contextFingerprint !== importQueryContextFingerprint(input.context)) {
      throw new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_PLAN_CONFLICT')
    }
    const resources = this.dependencies.resources()
    const release = resources.acquireWork()
    try {
      let result!: T
      await withKnowledgeSourceGate(getProjectDataRoot(resources.canonicalRoot), async () => {
        input.assertActive()
        for (const topic of plan.binding.topics) {
          const receipt = this.dependencies.queries.readReceipt(plan, topic.key)
          if (!receipt) throw new EmbeddingDispatchBarrierError('GENERATION_IMPORT_QUERY_REQUIRED')
          if (receipt.state === 'available') {
            await verifyDurableReferenceImportKnowledgeSnapshot({ snapshot: receipt.snapshot, resources, assertAuthority: input.assertActive })
          }
        }
        input.assertActive()
        result = operation()
      })
      return result
    } catch (error) { barrier(error) }
    finally { release() }
  }
}

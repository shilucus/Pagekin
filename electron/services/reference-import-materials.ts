import { isDeepStrictEqual } from 'node:util'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import type { EmbeddingModel } from '../../src/shared/embedding-options'
import type { ImportGenerationContext } from '../../src/shared/import-generation'
import type { ImportRunExecutionAuthority } from '../../src/shared/import-run'
import { buildImportBlueprintTask } from '../../src/shared/import-blueprint-materials'
import { buildImportInferenceTask, formatImportInferenceSample, getImportInferenceTopics, type ImportInferenceTopicKey } from '../../src/shared/import-inference-materials'
import { buildImportStyleMaterial, collectImportStyleSamples } from '../../src/shared/import-style-materials'
import { captureReferenceImportKnowledgeSnapshot, captureReferenceImportResources, verifyReferenceImportKnowledgeSnapshot } from '../knowledge-base'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { captureImportGenerationContext } from './import-generation-source'
import type { ProjectRuntime } from './project-runtime'
import type { ReferenceImportKnowledgeSnapshot } from './reference-import-knowledge-source'

export interface ReferenceImportMaterialInput {
  runtime: ProjectRuntime
  context: ImportGenerationContext
  execution: ImportRunExecutionAuthority
  configuration: { protocol: 'openai' | 'gemini'; model: EmbeddingModel } | null
  /** The owning main driver must recheck its grant and frozen prompt/Skill binding. */
  assertActive: () => void
  blueprintBatch?: {
    chapterNumbers: readonly number[]
    validatedPrefix: readonly { chapterNumber: number; title: string; keyEvents: string }[]
  }
}

export interface ReferenceImportPreparedMaterial {
  /** Empty style samples still require the existing finalized-source fallback, not a completed effect. */
  state: 'ready' | 'style-finalized-samples-required'
  task: GenerationTask | null
  knowledge: readonly ReferenceImportKnowledgeSnapshot[]
  verifySources: () => Promise<void>
}

/** Internal material preparation only: neither the input nor the result is an execution grant. */
export async function prepareReferenceImportMaterials(input: ReferenceImportMaterialInput): Promise<ReferenceImportPreparedMaterial> {
  const runtime = input.runtime
  const resources = captureReferenceImportResources(runtime)
  const frozen = structuredClone(input.context)
  const execution = Object.freeze({ owner: input.execution.owner, epoch: input.execution.epoch })
  const configuration = structuredClone(input.configuration)
  const blueprintBatch = input.blueprintBatch && structuredClone(input.blueprintBatch)
  const assertActive = input.assertActive
  const expectedContext = { ...frozen, prompts: {} }
  const assertCurrent = () => {
    resources.assertResources()
    const checked: unknown = assertActive()
    if (checked && typeof (checked as { then?: unknown }).then === 'function') throw new Error('GENERATION_SOURCE_GUARD_ASYNC')
    resources.assertResources()
    const run = ImportRunRepository.get(frozen.slot.runId, runtime)
    if (!run || run.status !== 'running' || run.stage !== frozen.slot.stage) throw new Error('GENERATION_IMPORT_EXECUTION_STALE')
    if (run.cancelRequested) throw new Error('GENERATION_ACTION_CANCELLED')
    ImportRunRepository.assertExecutionAuthority(run.id, execution, undefined, resources.database)
    if (!isDeepStrictEqual(captureImportGenerationContext(resources.database, frozen.slot), expectedContext)) {
      throw new Error('GENERATION_IMPORT_CONTEXT_CHANGED')
    }
  }
  const withWork = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = resources.acquireWork()
    try {
      assertCurrent()
      const result = await operation()
      assertCurrent()
      return result
    } finally { release() }
  }
  const knowledge: ReferenceImportKnowledgeSnapshot[] = []
  const writingLanguage = frozen.core.writingLanguage
  const task = await withWork(async (): Promise<GenerationTask | null> => {
    if (frozen.slot.stage === 'global') {
      const sampledContent: Partial<Record<ImportInferenceTopicKey, string>> = {}
      for (const topic of getImportInferenceTopics(writingLanguage)) {
        assertCurrent()
        const snapshot = await captureReferenceImportKnowledgeSnapshot({
          query: topic.query, topK: topic.topK, resources, configuration, assertAuthority: assertCurrent,
        })
        assertCurrent()
        knowledge.push(structuredClone(snapshot))
        sampledContent[topic.key] = formatImportInferenceSample(snapshot.results, writingLanguage)
      }
      const template = frozen.prompts.infer_novel_config_with_vectors || frozen.prompts.infer_novel_config
      if (!template) throw new Error('GENERATION_IMPORT_PROMPT_REQUIRED')
      return buildImportInferenceTask({ template, writingLanguage, chapters: frozen.chapters, totalChapters: frozen.totalChapters, sampledContent })
    }
    if (frozen.slot.stage === 'style') {
      const samples = collectImportStyleSamples({ chapters: frozen.chapters }, writingLanguage)
      if (!samples.length) return null
      const template = frozen.prompts.analyze_writing_style
      if (!template) throw new Error('GENERATION_IMPORT_PROMPT_REQUIRED')
      return buildImportStyleMaterial(template, samples, writingLanguage).task
    }
    const numbers = blueprintBatch?.chapterNumbers
    if (!numbers?.length || numbers.length > 5
      || numbers.some((number, index) => !Number.isSafeInteger(number) || number !== numbers[0]! + index)) {
      throw new Error('GENERATION_IMPORT_BLUEPRINT_BATCH_INVALID')
    }
    const items = numbers.map(number => frozen.chapters.find(chapter => chapter.number === number))
    if (items.some(item => !item)) throw new Error('GENERATION_IMPORT_BLUEPRINT_BATCH_INVALID')
    const template = frozen.prompts.infer_single_chapter_blueprint
    if (!template) throw new Error('GENERATION_IMPORT_PROMPT_REQUIRED')
    return buildImportBlueprintTask({ template, writingLanguage, items: items as ImportGenerationContext['chapters'],
      validatedPrefix: blueprintBatch!.validatedPrefix, configSummary: JSON.stringify(frozen.core) })
  })
  return {
    state: task ? 'ready' : 'style-finalized-samples-required', task, knowledge: structuredClone(knowledge),
    verifySources: () => withWork(async () => {
      for (const snapshot of knowledge) {
        assertCurrent()
        await verifyReferenceImportKnowledgeSnapshot({ snapshot, resources, assertAuthority: assertCurrent })
        assertCurrent()
      }
    }),
  }
}

import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { GenerationTask } from '../services/generation/generation-harness'
import type { ProjectCoreData } from '../../electron/repositories/project-core-repository'
import type { PromptTemplate } from '../services/prompt-templates'
import type { ImportRunExecutionAuthority } from './import-run'
import type { ImportInferenceTopicKey } from './import-inference-materials'
import { REFERENCE_STYLE_CHANNELS } from './reference-style-contract'
import type { ReferenceStyleChannels } from './reference-style-contract'
import { REFERENCE_GLOBAL_CHANNELS } from './reference-global-contract'
import type { ReferenceGlobalChannels } from './reference-global-contract'

export const IMPORT_GENERATION_CHANNELS = ['import-generation:read', 'import-generation:execute', 'import-generation:v1:query-materials', ...REFERENCE_STYLE_CHANNELS, ...REFERENCE_GLOBAL_CHANNELS] as const
export function isImportGenerationChannel(value: string): value is typeof IMPORT_GENERATION_CHANNELS[number] {
  return (IMPORT_GENERATION_CHANNELS as readonly string[]).includes(value)
}
export interface ImportQueryMaterialsRequest {
  handle: MainGenerationRunHandle
  execution: ImportRunExecutionAuthority
}
export interface ImportQueryMaterialsResponse {
  version: 1
  run: MainGenerationRunView
  topics: { key: ImportInferenceTopicKey; results: { text: string; score: number; fileName: string }[] | null }[]
}
export function assertImportQueryMaterialsRequest(value: unknown): asserts value is ImportQueryMaterialsRequest {
  const record = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input)
  const keys = (input: unknown, fields: readonly string[]): input is Record<string, unknown> => record(input)
    && Object.keys(input).length === fields.length && Object.keys(input).every(key => fields.includes(key))
  const id = (input: unknown) => typeof input === 'string' && input.length > 0 && input.length <= 512 && input.trim() === input
  if (!keys(value, ['handle', 'execution']) || !keys(value.handle, ['projectId', 'epoch', 'rootActionId', 'runId'])
    || Object.values(value.handle).some(item => !id(item)) || !keys(value.execution, ['owner', 'epoch'])
    || !id(value.execution.owner) || !Number.isSafeInteger(value.execution.epoch) || (value.execution.epoch as number) < 1) {
    throw new Error('GENERATION_IMPORT_QUERY_INVALID')
  }
}

/** A durable import checkpoint, never a renderer-selected generation root. */
export interface ImportGenerationSlot {
  runId: string
  stage: 'global' | 'style' | 'blueprints'
  batchId: string
}
export interface ImportGenerationContext {
  slot: ImportGenerationSlot
  manifestFingerprint: string
  totalChapters: number
  totalWords: number
  core: ProjectCoreData
  prompts: Record<string, PromptTemplate>
  chapters: { number: number; title: string; content: string; contentFingerprint: string; wordCount: number }[]
}
export interface ImportGenerationRecovery {
  view: MainGenerationRunView
  modelId: string
  frozenContext: ImportGenerationContext
}
export interface ImportGenerationChannels extends ReferenceStyleChannels, ReferenceGlobalChannels {
  'import-generation:read': { args: [{ slot: ImportGenerationSlot; runId?: string }]; return: ImportGenerationRecovery | null }
  'import-generation:execute': { args: [{ handle: MainGenerationRunHandle; ordinal: number; task: GenerationTask; execution?: ImportRunExecutionAuthority }]; return: MainGenerationExecuteReceipt }
  'import-generation:v1:query-materials': { args: [ImportQueryMaterialsRequest]; return: ImportQueryMaterialsResponse }
}

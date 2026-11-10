import {
  GENERATION_DIAGNOSTIC_SOURCE_KINDS, MATERIAL_DECISION_CATEGORIES, MATERIAL_DECISION_MAX_INPUT_UNITS,
  MATERIAL_DECISION_MAX_SOURCES, MATERIAL_DECISION_OMISSION_REASONS, MATERIAL_DECISION_RECEIPT_VERSION,
  MATERIAL_DECISION_SOURCE_ID, MATERIAL_DECISION_UNIT_METHOD_VERSION,
  type GenerationDiagnosticSourceKind, type GenerationSourceSelectionDiagnostics,
  type MaterialDecisionIncludedSource, type MaterialDecisionOmittedSource,
} from '../../src/shared/generation-owner-contract'
import { parseImportRunChapterBatchCheckpointId } from '../../src/shared/import-run'
import type { RunBinding } from '../repositories/generation-run-repository'

function invalid(): never { throw new Error('GENERATION_DIAGNOSTICS_INVALID') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid()
  return value
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return invalid()
  return value
}
function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid()
  return value as T
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid()
  return value
}
const exactSourceKinds: Readonly<Record<string, GenerationDiagnosticSourceKind>> = {
  'project-core:main': 'project-core', 'planning-feedback:context': 'planning-feedback',
  'legacy-roster-context': 'legacy-roster', 'graph-generation-context': 'graph',
  'agent-blueprints:all': 'agent-blueprints', 'review-revision-context': 'review-revision',
  'characters:all': 'characters', 'character-relationships:all': 'relationships',
  'narrative-thread-context:all': 'narrative-thread', 'draft-continuity-catalog': 'continuity-catalog',
  'continuity-locators': 'continuity-locators', 'knowledge-selection': 'knowledge-selection',
  'plot-outline:origin': 'plot-outline', 'finalization-generation-context': 'finalization',
  'editor-inline:author-draft': 'editor-inline', 'agent-context': 'agent',
}
const prefixSourceKinds: readonly (readonly [string, GenerationDiagnosticSourceKind])[] = [
  ['author-action:', 'author-input'], ['draft-target:', 'draft-target'], ['blueprint:', 'blueprint'],
  ['finalized:', 'finalized'], ['draft:', 'draft'], ['project-guidance:', 'project-guidance'],
  ['kb:', 'knowledge-chunk'], ['import-manifest:', 'import'],
]
function sourceKind(value: unknown): GenerationDiagnosticSourceKind {
  if (typeof value !== 'string') return 'unknown'
  return Object.hasOwn(exactSourceKinds, value) ? exactSourceKinds[value]!
    : prefixSourceKinds.find(([prefix]) => value.startsWith(prefix))?.[1] ?? 'unknown'
}
function materialSource(value: unknown): Omit<MaterialDecisionIncludedSource, 'units'> {
  const source = record(value)
  if (typeof source.sourceId !== 'string' || !MATERIAL_DECISION_SOURCE_ID.test(source.sourceId)) return invalid()
  return { sourceId: source.sourceId, revision: count(source.revision), contentHash: hash(source.contentHash),
    category: member(source.category, MATERIAL_DECISION_CATEGORIES), required: boolean(source.required) }
}
function materialDecision(value: unknown): GenerationSourceSelectionDiagnostics['materialDecision'] {
  if (value == null) return { coverage: 'not_recorded', receipt: null }
  const decision = record(value), capacity = record(decision.capacity), coverage = record(decision.coverage)
  if (decision.version !== MATERIAL_DECISION_RECEIPT_VERSION || decision.verdict !== 'admitted'
    || !Array.isArray(decision.included) || !Array.isArray(decision.omitted)
    || decision.included.length + decision.omitted.length > MATERIAL_DECISION_MAX_SOURCES) return invalid()
  const included: MaterialDecisionIncludedSource[] = decision.included.map(value => ({ ...materialSource(value),
    units: count(record(value).units, 1, MATERIAL_DECISION_MAX_INPUT_UNITS) }))
  const omitted: MaterialDecisionOmittedSource[] = decision.omitted.map(value => ({ ...materialSource(value),
    reason: member(record(value).reason, MATERIAL_DECISION_OMISSION_REASONS) }))
  return { coverage: 'recorded', receipt: { version: MATERIAL_DECISION_RECEIPT_VERSION, verdict: 'admitted',
    promptHash: hash(decision.promptHash),
    capacity: { maxInputUnits: count(capacity.maxInputUnits, 1, MATERIAL_DECISION_MAX_INPUT_UNITS),
      methodVersion: member(capacity.methodVersion, [MATERIAL_DECISION_UNIT_METHOD_VERSION]),
      admittedUnits: count(capacity.admittedUnits, 0, MATERIAL_DECISION_MAX_INPUT_UNITS) },
    coverage: { required: count(coverage.required), included: count(coverage.included), complete: boolean(coverage.complete) },
    included, omitted } }
}
function importSource(value: unknown): GenerationSourceSelectionDiagnostics['import'] {
  if (value == null) return { coverage: 'not_recorded', source: null }
  const context = record(value), slot = record(context.slot)
  const stage = member(slot.stage, ['global', 'style', 'blueprints'])
  if (typeof slot.batchId !== 'string' || !Array.isArray(context.chapters)) return invalid()
  const range = stage === 'blueprints' ? parseImportRunChapterBatchCheckpointId(slot.batchId) : null
  if (stage === 'blueprints' ? !range : slot.batchId !== 'done') return invalid()
  return { coverage: 'recorded', source: { kind: 'import', manifestFingerprint: hash(context.manifestFingerprint),
    totalChapters: count(context.totalChapters), totalWords: count(context.totalWords),
    selectedChapters: context.chapters.map(value => {
      const chapter = record(value)
      return { number: count(chapter.number, 1), contentHash: hash(chapter.contentFingerprint), wordCount: count(chapter.wordCount) }
    }), checkpointRange: range ? { startChapter: range.startChapter, endChapter: range.endChapter } : null } }
}

/** Project only already frozen metadata; unknown namespaces never expose their original labels. */
export function projectGenerationSourceSelection(binding: Pick<RunBinding, 'sourceRefs' | 'sourceManifest'>): GenerationSourceSelectionDiagnostics {
  const counts = new Map<GenerationDiagnosticSourceKind, number>()
  if (Array.isArray(binding.sourceRefs)) for (const source of binding.sourceRefs) {
    const kind = sourceKind(source?.sourceId)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return {
    sourceRefs: Array.isArray(binding.sourceRefs) ? { coverage: 'recorded', counts: GENERATION_DIAGNOSTIC_SOURCE_KINDS
      .filter(kind => counts.has(kind)).map(kind => ({ kind, count: counts.get(kind)! })) } : { coverage: 'not_recorded', counts: null },
    materialDecision: materialDecision(binding.sourceManifest.materialDecision),
    import: importSource(binding.sourceManifest.importContext),
  }
}

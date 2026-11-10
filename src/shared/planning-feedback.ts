import { assertPlanningActionRange, type PlotOutlineRange } from './plot-outline-contract'

export const PLANNING_FEEDBACK_SCHEMA_VERSION = 1 as const

export const PLANNING_FEEDBACK_TARGETS = [
  'coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile',
  'globalGuidance', 'writingStyle', 'premise', 'worldbuilding',
] as const
export type PlanningFeedbackCoreTarget = typeof PLANNING_FEEDBACK_TARGETS[number]
export const BLUEPRINT_FEEDBACK_FIELDS = [
  'title', 'role', 'purpose', 'keyEvents', 'characters', 'suspenseHook', 'userGuidance', 'notes',
] as const
export type BlueprintFeedbackField = typeof BLUEPRINT_FEEDBACK_FIELDS[number]
export interface PlanningFeedbackBlueprintScope {
  kind: 'blueprint-fields'
  chapterNumber: number
  fields: readonly BlueprintFeedbackField[]
}
export type PlanningFeedbackTarget = PlanningFeedbackCoreTarget | 'plotOutlineRange' | 'blueprintFields'
export type PlanningFeedbackScope = { kind: 'field'; field: PlanningFeedbackCoreTarget }
  | { kind: 'plot-outline-range'; from: number; to: number }
  | PlanningFeedbackBlueprintScope
export type PlanningFeedbackCaptureTarget = PlanningFeedbackCoreTarget | Exclude<PlanningFeedbackScope, { kind: 'field' }>
export type PlanningFeedbackDecision = 'full' | 'partial' | 'edited'
export type PlanningFeedbackTable = 'planning_feedback_bases' | 'planning_feedback_candidates' | 'planning_feedback_adoptions'

export const PLANNING_FEEDBACK_CORE_COLUMNS = Object.freeze({
  projectName: 'project_name', genre: 'genre', subGenre: 'sub_genre', targetAudience: 'target_audience',
  totalChapters: 'total_chapters', wordsPerChapter: 'words_per_chapter', writingLanguage: 'writing_language',
  creativeStrategy: 'creative_strategy',
  plotStructure: 'plot_structure', narrativePov: 'narrative_pov', writingStyle: 'writing_style',
  referenceWorks: 'reference_works', globalGuidance: 'global_guidance', goldenFinger: 'golden_finger',
  coreOutline: 'core_outline', worldSetting: 'world_setting', protagonistProfile: 'protagonist_profile',
  premise: 'premise', worldbuilding: 'worldbuilding',
} as const)
export type PlanningFeedbackCoreSnapshot = Readonly<Record<keyof typeof PLANNING_FEEDBACK_CORE_COLUMNS, string | number>>
export interface PlanningFeedbackOutlineSource {
  core: PlanningFeedbackCoreSnapshot
  synopsis: string
  charactersArch: string
}
export type PlanningFeedbackBlueprintSnapshot = Record<Exclude<BlueprintFeedbackField, 'characters'>, string> & {
  chapterNumber: number
  characters: string[]
  notesUpdatedAt: string
}
export type PlanningFeedbackBlueprintChanges = Partial<Pick<PlanningFeedbackBlueprintSnapshot, BlueprintFeedbackField>>
export interface PlanningFeedbackBlueprintSource extends PlanningFeedbackOutlineSource {
  blueprint: PlanningFeedbackBlueprintSnapshot
}
export type PlanningFeedbackSource = PlanningFeedbackCoreSnapshot | PlanningFeedbackOutlineSource | PlanningFeedbackBlueprintSource

export function parsePlanningFeedbackScope(value: unknown): PlanningFeedbackScope {
  if (!value || typeof value !== 'object') throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
  if ((value as Record<string, unknown>).kind === 'field') {
    assertPlanningFeedbackObject(value, ['kind', 'field'])
    if (!isPlanningFeedbackCoreTarget(value.field)) throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
    return { kind: 'field', field: value.field }
  }
  if ((value as Record<string, unknown>).kind === 'blueprint-fields') {
    assertPlanningFeedbackObject(value, ['kind', 'chapterNumber', 'fields'])
    if (!Number.isSafeInteger(value.chapterNumber) || Number(value.chapterNumber) < 1
      || !Array.isArray(value.fields) || !value.fields.length
      || [...value.fields].some(field => typeof field !== 'string' || !(BLUEPRINT_FEEDBACK_FIELDS as readonly string[]).includes(field))
      || new Set(value.fields).size !== value.fields.length) throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
    const selected = value.fields
    return { kind: 'blueprint-fields', chapterNumber: Number(value.chapterNumber), fields: BLUEPRINT_FEEDBACK_FIELDS.filter(field => selected.includes(field)) }
  }
  assertPlanningFeedbackObject(value, ['kind', 'from', 'to'])
  if (value.kind !== 'plot-outline-range') throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
  assertPlanningActionRange(value as unknown as PlotOutlineRange)
  return { kind: 'plot-outline-range', from: Number(value.from), to: Number(value.to) }
}

export function parsePlanningFeedbackSource(target: PlanningFeedbackTarget, value: unknown): PlanningFeedbackSource {
  if (target === 'blueprintFields') {
    assertPlanningFeedbackObject(value, ['core', 'synopsis', 'charactersArch', 'blueprint'])
    assertPlanningFeedbackObject(value.core, Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS))
    assertPlanningFeedbackObject(value.blueprint, ['chapterNumber', ...BLUEPRINT_FEEDBACK_FIELDS, 'notesUpdatedAt'])
    if (typeof value.synopsis !== 'string' || typeof value.charactersArch !== 'string'
      || !Number.isSafeInteger(value.blueprint.chapterNumber) || Number(value.blueprint.chapterNumber) < 1
      || typeof value.blueprint.notesUpdatedAt !== 'string') throw new Error('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    const blueprint = blueprintFeedbackValues(value.blueprint, BLUEPRINT_FEEDBACK_FIELDS, true, 'PLANNING_FEEDBACK_INTEGRITY_FAILED', ['chapterNumber', 'notesUpdatedAt'])
    return { core: planningFeedbackCoreSnapshot(value.core), synopsis: value.synopsis, charactersArch: value.charactersArch,
      blueprint: { chapterNumber: Number(value.blueprint.chapterNumber), ...blueprint, notesUpdatedAt: value.blueprint.notesUpdatedAt } as PlanningFeedbackBlueprintSnapshot }
  }
  if (target === 'plotOutlineRange') {
    assertPlanningFeedbackObject(value, ['core', 'synopsis', 'charactersArch'])
    assertPlanningFeedbackObject(value.core, Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS))
    if (typeof value.synopsis !== 'string' || typeof value.charactersArch !== 'string') throw new Error('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    return { core: planningFeedbackCoreSnapshot(value.core), synopsis: value.synopsis, charactersArch: value.charactersArch }
  }
  if (!isPlanningFeedbackCoreTarget(target)) throw new Error('PLANNING_FEEDBACK_TARGET_INVALID')
  assertPlanningFeedbackObject(value, Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS))
  return planningFeedbackCoreSnapshot(value)
}

function blueprintFeedbackValues(value: unknown, fields: readonly BlueprintFeedbackField[], requireAllFields: boolean,
  error: string, extra: readonly string[] = []): PlanningFeedbackBlueprintChanges {
  assertPlanningFeedbackObject(value, requireAllFields ? fields : [], [...extra, ...(requireAllFields ? [] : fields)])
  const keys = Object.keys(value).filter(key => !extra.includes(key))
  if (!keys.length) throw new Error(error)
  for (const field of keys) {
    const item = value[field]
    if (field === 'characters') {
      if (!Array.isArray(item) || [...item].some(name => typeof name !== 'string' || !name.trim())
        || new Set(item.map(name => name.trim())).size !== item.length) throw new Error(error)
    } else if (typeof item !== 'string') throw new Error(error)
  }
  return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field))
    .map(field => {
      const item = value[field]
      return [field, Array.isArray(item) ? [...item] : item]
    })) as PlanningFeedbackBlueprintChanges
}

/** Generated text must cover the exact selection; author adoption may choose a nonempty subset. */
export function parsePlanningFeedbackBlueprintText(text: string, scope: PlanningFeedbackBlueprintScope,
  requireAllFields: boolean): PlanningFeedbackBlueprintChanges {
  try {
    const selected = parsePlanningFeedbackScope(scope)
    if (selected.kind !== 'blueprint-fields' || typeof text !== 'string') throw new Error('invalid')
    return blueprintFeedbackValues(JSON.parse(text), selected.fields, requireAllFields, 'PLANNING_FEEDBACK_TEXT_INVALID')
  } catch {
    throw new Error('PLANNING_FEEDBACK_TEXT_INVALID')
  }
}

/** The F0 value contains only selected persisted fields, in the whitelist order. */
export function planningFeedbackBlueprintValue(source: PlanningFeedbackBlueprintSource, scope: PlanningFeedbackBlueprintScope): string {
  const selected = parsePlanningFeedbackScope(scope)
  const parsed = parsePlanningFeedbackSource('blueprintFields', source) as PlanningFeedbackBlueprintSource
  if (selected.kind !== 'blueprint-fields' || selected.chapterNumber !== parsed.blueprint.chapterNumber) throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
  return JSON.stringify(Object.fromEntries(selected.fields.map(field => [field, parsed.blueprint[field]])))
}

export function planningFeedbackSourceCore(source: PlanningFeedbackSource): PlanningFeedbackCoreSnapshot {
  return planningFeedbackCoreSnapshot(Object.hasOwn(source, 'core') ? (source as PlanningFeedbackOutlineSource).core : source)
}

/** Only the author planning facts consumed by the v1 feedback context, not derived caches. */
export function planningFeedbackCoreSnapshot(value: unknown): PlanningFeedbackCoreSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PLANNING_FEEDBACK_CORE_MISSING')
  const source = value as Record<string, unknown>
  const entries = Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS).map(key => {
    const item = source[key]
    const numeric = key === 'totalChapters' || key === 'wordsPerChapter'
    if (numeric ? typeof item !== 'number' || !Number.isFinite(item) : typeof item !== 'string') {
      throw new Error('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    }
    return [key, item]
  })
  return Object.fromEntries(entries) as PlanningFeedbackCoreSnapshot
}

interface PlanningFeedbackBaseFacts {
  baseId: string
  projectId: string
  sourceRevision: number
  sourceHash: string
  value: string
  valueHash: string
  createdAt: number
  closedAt: number | null
  closedByAdoptionId: string | null
}
export type PlanningFeedbackBase = PlanningFeedbackBaseFacts & ({
  schemaVersion: 1
  target: PlanningFeedbackCoreTarget
  scope: Extract<PlanningFeedbackScope, { kind: 'field' }>
  source: PlanningFeedbackCoreSnapshot
} | {
  schemaVersion: 2
  target: 'plotOutlineRange'
  scope: Extract<PlanningFeedbackScope, { kind: 'plot-outline-range' }>
  source: PlanningFeedbackOutlineSource
} | {
  schemaVersion: 3
  target: 'blueprintFields'
  scope: PlanningFeedbackBlueprintScope
  source: PlanningFeedbackBlueprintSource
})

export type PlanningFeedbackOrigin = {
  kind: 'generated'
  runId: string
  attemptId: string
  artifactId: string
  modelLeaseRevision: string
  skillSnapshotHash: string
  contextSnapshotHash: string
} | {
  kind: 'copied'
  sourceCandidateId: string
  originProjectId: string
  sourceTextHash: string
} | {
  /** Read-only redacted archive history, never fresh generation evidence. */
  kind: 'portable-history'
  sourceKind: 'generated'
  runId: string
  attemptId: string
  artifactId: string
} | {
  kind: 'portable-history'
  sourceKind: 'copied'
  sourceCandidateId: string
  originProjectId: string
  sourceTextHash: string
}

export interface PlanningFeedbackCandidate {
  schemaVersion: 1 | 2 | 3
  candidateId: string
  projectId: string
  baseId: string
  parentCandidateId: string | null
  generationParentHash: string
  text: string
  textHash: string
  feedback: string
  constraints: readonly string[]
  origin: PlanningFeedbackOrigin
  createdAt: number
}

export interface StagePlanningFeedbackCandidate {
  baseId: string
  parentCandidateId?: string | null
  feedback: string
  constraints: readonly string[]
  runId: string
  attemptId: string
  artifactId: string
}

export interface RelineagePlanningFeedbackCandidate {
  baseId: string
  sourceCandidateId: string
  feedback: string
  constraints: readonly string[]
}

export interface AdoptPlanningFeedbackCandidate {
  candidateId: string
  idempotencyKey: string
  decision: PlanningFeedbackDecision
  text: string
  adoptedRange?: PlotOutlineRange
}

export interface PlanningFeedbackAdoption {
  schemaVersion: 1 | 2 | 3
  adoptionId: string
  projectId: string
  baseId: string
  candidateId: string
  idempotencyKey: string
  requestHash: string
  target: PlanningFeedbackTarget
  adoptedScope: PlanningFeedbackScope
  decision: PlanningFeedbackDecision
  decisionSource: 'author-action'
  text: string
  textHash: string
  beforeValue: string
  beforeHash: string
  sourceRevision: number
  committedRevision: number
  createdAt: number
}

export function isPlanningFeedbackTarget(value: unknown): value is PlanningFeedbackTarget {
  return value === 'blueprintFields' || value === 'plotOutlineRange' || isPlanningFeedbackCoreTarget(value)
}

export function isPlanningFeedbackCoreTarget(value: unknown): value is PlanningFeedbackCoreTarget {
  return typeof value === 'string' && (PLANNING_FEEDBACK_TARGETS as readonly string[]).includes(value)
}

export function assertPlanningFeedbackId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}._:@+-]{1,512}$/u.test(value)) throw new Error('PLANNING_FEEDBACK_ID_INVALID')
}

export function assertPlanningFeedbackObject(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error('PLANNING_FEEDBACK_PAYLOAD_INVALID')
  }
}

export function assertPlanningFeedbackInstructions(feedback: unknown, constraints: unknown): void {
  if (typeof feedback !== 'string' || !Array.isArray(constraints) || [...constraints].some(value => typeof value !== 'string')) {
    throw new Error('PLANNING_FEEDBACK_PAYLOAD_INVALID')
  }
}

export function assertPlanningFeedbackAdoption(value: unknown): asserts value is AdoptPlanningFeedbackCandidate {
  assertPlanningFeedbackObject(value, ['candidateId', 'idempotencyKey', 'decision', 'text'], ['adoptedRange'])
  assertPlanningFeedbackId(value.candidateId)
  assertPlanningFeedbackId(value.idempotencyKey)
  if (typeof value.decision !== 'string' || !['full', 'partial', 'edited'].includes(value.decision) || typeof value.text !== 'string') {
    throw new Error('PLANNING_FEEDBACK_PAYLOAD_INVALID')
  }
  if (Object.hasOwn(value, 'adoptedRange')) {
    assertPlanningFeedbackObject(value.adoptedRange, ['from', 'to'])
    assertPlanningActionRange(value.adoptedRange as unknown as PlotOutlineRange)
  }
}

export function planningFeedbackAdoptedScope(base: PlanningFeedbackBase, adoptedRange?: PlotOutlineRange, adoptedText?: string): PlanningFeedbackScope {
  if (base.schemaVersion === 3) {
    if (adoptedRange !== undefined || typeof adoptedText !== 'string') throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
    const changes = parsePlanningFeedbackBlueprintText(adoptedText, base.scope, false)
    return { kind: 'blueprint-fields', chapterNumber: base.scope.chapterNumber, fields: BLUEPRINT_FEEDBACK_FIELDS.filter(field => Object.hasOwn(changes, field)) }
  }
  if (base.target !== 'plotOutlineRange') {
    if (adoptedRange !== undefined) throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
    return base.scope
  }
  const selected = adoptedRange === undefined ? base.scope
    : parsePlanningFeedbackScope({ kind: 'plot-outline-range', ...adoptedRange })
  if (selected.kind !== 'plot-outline-range' || selected.from < base.scope.from || selected.to > base.scope.to) {
    throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
  }
  return selected
}

export function planningFeedbackAdoptionBinding(request: AdoptPlanningFeedbackCandidate, candidate: PlanningFeedbackCandidate,
  base: PlanningFeedbackBase, payloadHash: string): string {
  const adoptedScope = planningFeedbackAdoptedScope(base, request.adoptedRange, request.text)
  if (base.schemaVersion === 3 && request.decision === 'full'
    && (request.text !== candidate.text || JSON.stringify(adoptedScope) !== JSON.stringify(base.scope))) throw new Error('PLANNING_FEEDBACK_TEXT_INVALID')
  if (base.schemaVersion === 2 || base.schemaVersion === 3) return JSON.stringify([base.schemaVersion, candidate.candidateId, candidate.schemaVersion,
    base.baseId, base.projectId, base.target, base.scope, adoptedScope, base.sourceRevision, base.sourceHash,
    candidate.textHash, candidate.generationParentHash, request.decision, 'author-action', payloadHash])
  return JSON.stringify([PLANNING_FEEDBACK_SCHEMA_VERSION, candidate.candidateId, candidate.schemaVersion,
    base.baseId, base.projectId, base.target, 'field', base.sourceRevision, base.sourceHash,
    candidate.textHash, candidate.generationParentHash, request.decision, 'author-action', payloadHash])
}

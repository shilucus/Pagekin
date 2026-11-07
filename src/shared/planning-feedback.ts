import { assertPlanningActionRange, type PlotOutlineRange } from './plot-outline-contract'

export const PLANNING_FEEDBACK_SCHEMA_VERSION = 1 as const

export const PLANNING_FEEDBACK_TARGETS = [
  'coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile',
  'globalGuidance', 'writingStyle', 'premise', 'worldbuilding',
] as const
export type PlanningFeedbackCoreTarget = typeof PLANNING_FEEDBACK_TARGETS[number]
export type PlanningFeedbackTarget = PlanningFeedbackCoreTarget | 'plotOutlineRange'
export type PlanningFeedbackScope = { kind: 'field'; field: PlanningFeedbackCoreTarget }
  | { kind: 'plot-outline-range'; from: number; to: number }
export type PlanningFeedbackCaptureTarget = PlanningFeedbackCoreTarget | Extract<PlanningFeedbackScope, { kind: 'plot-outline-range' }>
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
export type PlanningFeedbackSource = PlanningFeedbackCoreSnapshot | PlanningFeedbackOutlineSource

export function parsePlanningFeedbackScope(value: unknown): PlanningFeedbackScope {
  if (!value || typeof value !== 'object') throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
  if ((value as Record<string, unknown>).kind === 'field') {
    assertPlanningFeedbackObject(value, ['kind', 'field'])
    if (!isPlanningFeedbackCoreTarget(value.field)) throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
    return { kind: 'field', field: value.field }
  }
  assertPlanningFeedbackObject(value, ['kind', 'from', 'to'])
  if (value.kind !== 'plot-outline-range') throw new Error('PLANNING_FEEDBACK_SCOPE_INVALID')
  assertPlanningActionRange(value as unknown as PlotOutlineRange)
  return { kind: 'plot-outline-range', from: Number(value.from), to: Number(value.to) }
}

export function parsePlanningFeedbackSource(target: PlanningFeedbackTarget, value: unknown): PlanningFeedbackSource {
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
  schemaVersion: 1 | 2
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
  schemaVersion: 1 | 2
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
  return value === 'plotOutlineRange' || isPlanningFeedbackCoreTarget(value)
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
  if (typeof feedback !== 'string' || !Array.isArray(constraints) || constraints.some(value => typeof value !== 'string')) {
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

export function planningFeedbackAdoptedScope(base: PlanningFeedbackBase, adoptedRange?: PlotOutlineRange): PlanningFeedbackScope {
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
  const adoptedScope = planningFeedbackAdoptedScope(base, request.adoptedRange)
  if (base.schemaVersion === 2) return JSON.stringify([2, candidate.candidateId, candidate.schemaVersion,
    base.baseId, base.projectId, base.target, base.scope, adoptedScope, base.sourceRevision, base.sourceHash,
    candidate.textHash, candidate.generationParentHash, request.decision, 'author-action', payloadHash])
  return JSON.stringify([PLANNING_FEEDBACK_SCHEMA_VERSION, candidate.candidateId, candidate.schemaVersion,
    base.baseId, base.projectId, base.target, 'field', base.sourceRevision, base.sourceHash,
    candidate.textHash, candidate.generationParentHash, request.decision, 'author-action', payloadHash])
}

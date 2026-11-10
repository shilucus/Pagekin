import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  assertPlanningFeedbackAdoption, assertPlanningFeedbackId,
  assertPlanningFeedbackInstructions, assertPlanningFeedbackObject, isPlanningFeedbackTarget, isPlanningFeedbackCoreTarget,
  planningFeedbackAdoptionBinding, planningFeedbackCoreSnapshot, planningFeedbackAdoptedScope,
  parsePlanningFeedbackScope, parsePlanningFeedbackSource,
  parsePlanningFeedbackBlueprintText, planningFeedbackBlueprintValue,
  type AdoptPlanningFeedbackCandidate, type PlanningFeedbackAdoption, type PlanningFeedbackBase,
  type PlanningFeedbackCandidate, type PlanningFeedbackCoreSnapshot, type PlanningFeedbackOrigin,
  type PlanningFeedbackCaptureTarget, type PlanningFeedbackSource, type PlanningFeedbackOutlineSource, type PlanningFeedbackScope, type PlanningFeedbackCoreTarget,
  type PlanningFeedbackTable, type PlanningFeedbackTarget, type RelineagePlanningFeedbackCandidate,
  type StagePlanningFeedbackCandidate,
  type PlanningFeedbackBlueprintScope, type PlanningFeedbackBlueprintSource,
} from '../../src/shared/planning-feedback'
import { isContentHash } from '../../src/shared/source-ref'
import { isGeneratedGlobalGuidanceValid } from '../../src/services/workflows/novel-config-expansion'
import { GenerationRunRepository, type GenerationExecutionReceipt } from './generation-run-repository'
import { ProjectCoreRepository } from './project-core-repository'
import { BlueprintRepository } from './blueprint-repository'
import { validPlotOutlineFeedbackRange } from '../../src/shared/plot-outline-contract'
import { readPlanningFeedbackOutlineSource, planningFeedbackOutlineValue, commitPlanningFeedbackOutline } from './planning-feedback-outline-adapter'
import type { PlanningFeedbackRangeScope, PlanningFeedbackRangeBaseSummary } from '../../src/shared/planning-feedback-ipc'

type Row = Record<string, unknown>
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
function fail(code: string): never { throw new Error(code) }
function parse(value: unknown): unknown {
  if (typeof value !== 'string') return fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  try { return JSON.parse(value) } catch { return fail('PLANNING_FEEDBACK_INTEGRITY_FAILED') }
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  return Number(value)
}
function text(value: unknown): string {
  if (typeof value !== 'string') return fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  return value
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !isContentHash(value)) return fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  return value
}
export function readPlanningFeedbackCoreSnapshot(db: Database.Database): PlanningFeedbackCoreSnapshot {
  return planningFeedbackCoreSnapshot(ProjectCoreRepository.get(db))
}

export function planningFeedbackSourceHash(source: PlanningFeedbackSource): string {
  return hash(JSON.stringify(parsePlanningFeedbackSource(Object.hasOwn(source, 'blueprint') ? 'blueprintFields'
    : Object.hasOwn(source, 'core') ? 'plotOutlineRange' : 'premise', source)))
}

export interface PlanningFeedbackBlueprintBaseSummary {
  baseId: string
  projectId: string
  target: 'blueprintFields'
  scope: PlanningFeedbackBlueprintScope
  createdAt: number
  closedAt: number | null
  closedByAdoptionId: string | null
}
function originSnapshot(value: unknown, frozenHistory = false): PlanningFeedbackOrigin {
  if (!value || typeof value !== 'object') return fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  const kind = (value as Row).kind
  if (kind === 'generated') {
    assertPlanningFeedbackObject(value, ['kind', 'runId', 'attemptId', 'artifactId', 'modelLeaseRevision', 'skillSnapshotHash', 'contextSnapshotHash'])
    for (const key of ['runId', 'attemptId', 'artifactId']) assertPlanningFeedbackId(value[key])
    for (const key of ['modelLeaseRevision', 'skillSnapshotHash', 'contextSnapshotHash']) digest(value[key])
  } else if (kind === 'copied') {
    assertPlanningFeedbackObject(value, ['kind', 'sourceCandidateId', 'originProjectId', 'sourceTextHash'])
    assertPlanningFeedbackId(value.sourceCandidateId)
    assertPlanningFeedbackId(value.originProjectId)
    digest(value.sourceTextHash)
  } else if (kind === 'portable-history' && frozenHistory) {
    const sourceKind = (value as Row).sourceKind
    if (sourceKind === 'generated') {
      assertPlanningFeedbackObject(value, ['kind', 'sourceKind', 'runId', 'attemptId', 'artifactId'])
      for (const key of ['runId', 'attemptId', 'artifactId']) assertPlanningFeedbackId(value[key])
    } else if (sourceKind === 'copied') {
      assertPlanningFeedbackObject(value, ['kind', 'sourceKind', 'sourceCandidateId', 'originProjectId', 'sourceTextHash'])
      assertPlanningFeedbackId(value.sourceCandidateId)
      assertPlanningFeedbackId(value.originProjectId)
      digest(value.sourceTextHash)
    } else fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  } else fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  return value as unknown as PlanningFeedbackOrigin
}

export interface PlanningFeedbackRepositoryOptions {
  projectId: string
  /** Main must verify the captured lease, canonical root and this exact DB handle. */
  assertCurrent(): void
  isFrozen(table: PlanningFeedbackTable, recordId: string): boolean
  /** Rebuild authoritative generation sources and check the actual frozen parent/model/Skill. */
  assertGenerationCurrent(receipt: GenerationExecutionReceipt, base: PlanningFeedbackBase,
    parent: PlanningFeedbackCandidate | null, request: StagePlanningFeedbackCandidate): void
  now?(): number
}

/** An explicit DB and mandatory authority/freeze guards; no global DB lookup or DDL. */
export class PlanningFeedbackRepository {
  constructor(private readonly db: Database.Database, private readonly options: PlanningFeedbackRepositoryOptions) {
    assertPlanningFeedbackId(options.projectId)
  }

  private current(): void {
    if (!this.db.open) fail('PLANNING_FEEDBACK_DATABASE_NOT_READY')
    this.options.assertCurrent()
  }

  private transaction<T>(operation: () => T): T {
    this.current()
    return this.db.transaction(() => { this.current(); return operation() }).immediate()
  }

  private now(): number { return integer((this.options.now ?? Date.now)()) }

  private mutable(table: PlanningFeedbackTable, id: string, projectId: string): void {
    if (projectId !== this.options.projectId || this.options.isFrozen(table, id)) fail('PLANNING_FEEDBACK_HISTORY_FROZEN')
  }

  private revision(target: PlanningFeedbackTarget = 'premise', scope?: PlanningFeedbackScope): number {
    if (target === 'blueprintFields') {
      if (scope?.kind !== 'blueprint-fields') fail('PLANNING_FEEDBACK_SCOPE_INVALID')
      const row = this.db.prepare('SELECT revision FROM planning_feedback_blueprint_revisions WHERE chapter_number=?').get(scope.chapterNumber) as Row | undefined
      if (!row) return fail('PLANNING_FEEDBACK_REVISION_MISSING')
      return integer(integer(row.revision) + this.revision('plotOutlineRange'))
    }
    const table = target === 'plotOutlineRange' ? 'planning_feedback_outline_revision' : 'planning_feedback_core_revision'
    const row = this.db.prepare(`SELECT revision FROM ${table} WHERE id=1`).get() as Row | undefined
    if (!row) return fail('PLANNING_FEEDBACK_REVISION_MISSING')
    return integer(row.revision)
  }

  private source(target: PlanningFeedbackTarget = 'premise', scope?: PlanningFeedbackScope): PlanningFeedbackSource {
    if (target === 'blueprintFields') {
      if (scope?.kind !== 'blueprint-fields') fail('PLANNING_FEEDBACK_SCOPE_INVALID')
      const blueprint = BlueprintRepository.getByChapter(scope.chapterNumber, this.db)
      if (!blueprint) fail('BLUEPRINT_NOT_FOUND')
      return parsePlanningFeedbackSource(target, { ...readPlanningFeedbackOutlineSource(this.db), blueprint })
    }
    return target === 'plotOutlineRange' ? readPlanningFeedbackOutlineSource(this.db) : readPlanningFeedbackCoreSnapshot(this.db)
  }

  readSource(target?: PlanningFeedbackCoreTarget): { source: PlanningFeedbackCoreSnapshot; sourceHash: string; sourceRevision: number }
  readSource(target: 'plotOutlineRange'): { source: PlanningFeedbackOutlineSource; sourceHash: string; sourceRevision: number }
  readSource(target: 'blueprintFields', scope: PlanningFeedbackBlueprintScope): { source: PlanningFeedbackBlueprintSource; sourceHash: string; sourceRevision: number }
  readSource(target: PlanningFeedbackTarget, scope?: PlanningFeedbackScope): { source: PlanningFeedbackSource; sourceHash: string; sourceRevision: number }
  readSource(target: PlanningFeedbackTarget = 'premise', scope?: PlanningFeedbackScope): { source: PlanningFeedbackSource; sourceHash: string; sourceRevision: number } {
    this.current()
    const selected = scope === undefined ? undefined : parsePlanningFeedbackScope(scope)
    const source = this.source(target, selected)
    return { source, sourceHash: planningFeedbackSourceHash(source), sourceRevision: this.revision(target, selected) }
  }

  assertBaseCurrent(baseId: string): PlanningFeedbackBase {
    const base = this.getBase(baseId)
    this.ready(base)
    return base
  }

  captureBase(input: PlanningFeedbackCoreTarget): Extract<PlanningFeedbackBase, { schemaVersion: 1 }>
  captureBase(input: Extract<PlanningFeedbackScope, { kind: 'plot-outline-range' }>): Extract<PlanningFeedbackBase, { schemaVersion: 2 }>
  captureBase(input: PlanningFeedbackBlueprintScope): Extract<PlanningFeedbackBase, { schemaVersion: 3 }>
  captureBase(input: PlanningFeedbackCaptureTarget): PlanningFeedbackBase
  captureBase(input: PlanningFeedbackCaptureTarget): PlanningFeedbackBase {
    if (typeof input === 'string' && !isPlanningFeedbackCoreTarget(input)) fail('PLANNING_FEEDBACK_TARGET_INVALID')
    const scope = parsePlanningFeedbackScope(typeof input === 'string' ? { kind: 'field', field: input } : input)
    if (typeof input !== 'string' && scope.kind === 'field') fail('PLANNING_FEEDBACK_SCOPE_INVALID')
    const target = scope.kind === 'field' ? scope.field : scope.kind === 'blueprint-fields' ? 'blueprintFields' : 'plotOutlineRange'
    return this.transaction(() => {
      const source = this.source(target, scope), value = scope.kind === 'plot-outline-range'
        ? planningFeedbackOutlineValue(source as PlanningFeedbackOutlineSource, scope)
        : scope.kind === 'blueprint-fields' ? planningFeedbackBlueprintValue(source as PlanningFeedbackBlueprintSource, scope)
          : text((source as PlanningFeedbackCoreSnapshot)[scope.field])
      const base = { schemaVersion: target === 'blueprintFields' ? 3 : target === 'plotOutlineRange' ? 2 : 1, baseId: randomUUID(), projectId: this.options.projectId,
        target, scope, sourceRevision: this.revision(target, scope), sourceHash: planningFeedbackSourceHash(source), source,
        value, valueHash: hash(value), createdAt: this.now(), closedAt: null, closedByAdoptionId: null } as PlanningFeedbackBase
      this.db.prepare(`INSERT INTO planning_feedback_bases
        (base_id,schema_version,project_id,target,source_revision,source_hash,source_json,value,value_hash,created_at,scope_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(base.baseId, base.schemaVersion, base.projectId, target, base.sourceRevision,
        base.sourceHash, JSON.stringify(source), value, base.valueHash, base.createdAt, base.schemaVersion === 1 ? null : JSON.stringify(scope))
      return base
    })
  }

  getBase(baseId: string): PlanningFeedbackBase {
    this.current()
    assertPlanningFeedbackId(baseId)
    const row = this.db.prepare('SELECT * FROM planning_feedback_bases WHERE base_id=?').get(baseId) as Row | undefined
    if (!row) return fail('PLANNING_FEEDBACK_BASE_MISSING')
    if (!isPlanningFeedbackTarget(row.target)
      || (row.target === 'blueprintFields' ? row.schema_version !== 3 : row.target === 'plotOutlineRange' ? row.schema_version !== 2 : row.schema_version !== 1 || row.scope_json !== null)) fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    const source = parsePlanningFeedbackSource(row.target, parse(row.source_json)), value = text(row.value)
    const scope = parsePlanningFeedbackScope(isPlanningFeedbackCoreTarget(row.target) ? { kind: 'field', field: row.target } : parse(row.scope_json))
    if ((row.target === 'plotOutlineRange') !== (scope.kind === 'plot-outline-range')
      || (row.target === 'blueprintFields') !== (scope.kind === 'blueprint-fields')) fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    const base = { schemaVersion: row.schema_version, baseId: text(row.base_id), projectId: text(row.project_id), scope,
      target: row.target, sourceRevision: integer(row.source_revision), sourceHash: digest(row.source_hash), source,
      value, valueHash: digest(row.value_hash), createdAt: integer(row.created_at),
      closedAt: row.closed_at === null ? null : integer(row.closed_at),
      closedByAdoptionId: row.closed_by_adoption_id === null ? null : text(row.closed_by_adoption_id) } as PlanningFeedbackBase
    const expectedValue = base.target === 'plotOutlineRange' ? planningFeedbackOutlineValue(base.source, base.scope)
      : base.target === 'blueprintFields' ? planningFeedbackBlueprintValue(base.source, base.scope) : base.source[base.target]
    if (planningFeedbackSourceHash(source) !== base.sourceHash || hash(value) !== base.valueHash || expectedValue !== value
      || (base.closedAt === null) !== (base.closedByAdoptionId === null)) fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    return base
  }

  listFieldBases(target: PlanningFeedbackCoreTarget): import('../../src/shared/planning-feedback-ipc').PlanningFeedbackBaseSummary[] {
    this.current()
    if (!isPlanningFeedbackCoreTarget(target)) fail('PLANNING_FEEDBACK_TARGET_INVALID')
    const rows = this.db.prepare('SELECT base_id,project_id,target,created_at,closed_at,closed_by_adoption_id FROM planning_feedback_bases WHERE schema_version=1 AND target=? ORDER BY created_at DESC,base_id').all(target) as Row[]
    return rows.filter(row => row.project_id === this.options.projectId || this.options.isFrozen('planning_feedback_bases', text(row.base_id)))
      .map(row => ({ baseId: text(row.base_id), projectId: text(row.project_id), target,
      createdAt: integer(row.created_at), closedAt: row.closed_at === null ? null : integer(row.closed_at),
      closedByAdoptionId: row.closed_by_adoption_id === null ? null : text(row.closed_by_adoption_id) }))
  }

  listRangeBases(target: PlanningFeedbackRangeScope): PlanningFeedbackRangeBaseSummary[] {
    this.current()
    const scope = parsePlanningFeedbackScope(target)
    if (scope.kind !== 'plot-outline-range') fail('PLANNING_FEEDBACK_SCOPE_INVALID')
    const rows = this.db.prepare(`SELECT base_id,project_id,target,scope_json,created_at,closed_at,closed_by_adoption_id
      FROM planning_feedback_bases WHERE schema_version=2 AND target='plotOutlineRange' ORDER BY created_at DESC,base_id`).all() as Row[]
    return rows.filter(row => row.project_id === this.options.projectId || this.options.isFrozen('planning_feedback_bases', text(row.base_id)))
      .flatMap(row => {
        const storedScope = parsePlanningFeedbackScope(parse(row.scope_json))
        if (storedScope.kind !== 'plot-outline-range') fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
        if (storedScope.from !== scope.from || storedScope.to !== scope.to) return []
        return [{ baseId: text(row.base_id), projectId: text(row.project_id), target: 'plotOutlineRange' as const, scope: storedScope,
          createdAt: integer(row.created_at), closedAt: row.closed_at === null ? null : integer(row.closed_at),
          closedByAdoptionId: row.closed_by_adoption_id === null ? null : text(row.closed_by_adoption_id) }]
      })
  }

  listBlueprintBases(target: PlanningFeedbackBlueprintScope): PlanningFeedbackBlueprintBaseSummary[] {
    this.current()
    const scope = parsePlanningFeedbackScope(target)
    if (scope.kind !== 'blueprint-fields') fail('PLANNING_FEEDBACK_SCOPE_INVALID')
    const rows = this.db.prepare(`SELECT base_id,project_id,scope_json,created_at,closed_at,closed_by_adoption_id
      FROM planning_feedback_bases WHERE schema_version=3 AND target='blueprintFields' ORDER BY created_at DESC,base_id`).all() as Row[]
    return rows.filter(row => row.project_id === this.options.projectId || this.options.isFrozen('planning_feedback_bases', text(row.base_id)))
      .flatMap(row => {
        const storedScope = parsePlanningFeedbackScope(parse(row.scope_json))
        if (storedScope.kind !== 'blueprint-fields') fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
        if (JSON.stringify(storedScope) !== JSON.stringify(scope)) return []
        return [{ baseId: text(row.base_id), projectId: text(row.project_id), target: 'blueprintFields' as const, scope: storedScope,
          createdAt: integer(row.created_at), closedAt: row.closed_at === null ? null : integer(row.closed_at),
          closedByAdoptionId: row.closed_by_adoption_id === null ? null : text(row.closed_by_adoption_id) }]
      })
  }

  private ready(base: PlanningFeedbackBase): void {
    this.mutable('planning_feedback_bases', base.baseId, base.projectId)
    if (base.closedAt !== null || this.revision(base.target, base.scope) !== base.sourceRevision
      || planningFeedbackSourceHash(this.source(base.target, base.scope)) !== base.sourceHash) fail('PLANNING_FEEDBACK_SOURCE_CONFLICT')
  }

  getCandidate(candidateId: string): PlanningFeedbackCandidate {
    this.current()
    assertPlanningFeedbackId(candidateId)
    const row = this.db.prepare('SELECT * FROM planning_feedback_candidates WHERE candidate_id=?').get(candidateId) as Row | undefined
    if (!row) return fail('PLANNING_FEEDBACK_CANDIDATE_MISSING')
    if (row.schema_version !== 1 && row.schema_version !== 2 && row.schema_version !== 3) fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    const constraints = parse(row.constraints_json)
    assertPlanningFeedbackInstructions(row.feedback, constraints)
    const candidate: PlanningFeedbackCandidate = { schemaVersion: row.schema_version, candidateId: text(row.candidate_id), projectId: text(row.project_id),
      baseId: text(row.base_id), parentCandidateId: row.parent_candidate_id === null ? null : text(row.parent_candidate_id),
      generationParentHash: digest(row.generation_parent_hash), text: text(row.text), textHash: digest(row.text_hash),
      feedback: text(row.feedback), constraints: constraints as string[],
      origin: originSnapshot(parse(row.origin_json), this.options.isFrozen('planning_feedback_candidates', candidateId)), createdAt: integer(row.created_at) }
    const base = this.getBase(candidate.baseId)
    if (hash(candidate.text) !== candidate.textHash || base.projectId !== candidate.projectId || candidate.schemaVersion !== base.schemaVersion
      || (base.target === 'plotOutlineRange' && !validPlotOutlineFeedbackRange(candidate.text, base.scope))) fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    if (base.target === 'blueprintFields') parsePlanningFeedbackBlueprintText(candidate.text, base.scope, true)
    const parent = candidate.parentCandidateId
      ? this.db.prepare('SELECT base_id,project_id,text,text_hash FROM planning_feedback_candidates WHERE candidate_id=?').get(candidate.parentCandidateId) as Row | undefined
      : undefined
    if (candidate.parentCandidateId && (!parent || parent.base_id !== candidate.baseId || parent.project_id !== candidate.projectId
      || hash(text(parent.text)) !== parent.text_hash)) fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    if (candidate.generationParentHash !== (parent?.text_hash ?? base.valueHash)) fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    return candidate
  }

  listCandidates(baseId: string): PlanningFeedbackCandidate[] {
    this.getBase(baseId)
    return (this.db.prepare('SELECT candidate_id FROM planning_feedback_candidates WHERE base_id=? ORDER BY created_at,candidate_id').all(baseId) as Row[])
      .map(row => this.getCandidate(text(row.candidate_id)))
  }

  candidateState(candidateId: string): 'ready' | 'conflict' | 'frozen' | 'adopted' {
    const candidate = this.getCandidate(candidateId), base = this.getBase(candidate.baseId)
    if (candidate.projectId !== this.options.projectId || this.options.isFrozen('planning_feedback_candidates', candidateId)
      || this.options.isFrozen('planning_feedback_bases', base.baseId)) return 'frozen'
    if (base.closedByAdoptionId) {
      const adoption = this.db.prepare('SELECT candidate_id FROM planning_feedback_adoptions WHERE adoption_id=?').get(base.closedByAdoptionId) as Row | undefined
      return adoption?.candidate_id === candidateId ? 'adopted' : 'conflict'
    }
    return this.revision(base.target, base.scope) === base.sourceRevision && planningFeedbackSourceHash(this.source(base.target, base.scope)) === base.sourceHash ? 'ready' : 'conflict'
  }

  private insertCandidate(base: PlanningFeedbackBase, parent: PlanningFeedbackCandidate | null, value: string,
    feedback: string, constraints: readonly string[], origin: Exclude<PlanningFeedbackOrigin, { kind: 'portable-history' }>): PlanningFeedbackCandidate {
    const candidate: PlanningFeedbackCandidate = { schemaVersion: base.schemaVersion, candidateId: randomUUID(), projectId: this.options.projectId,
      baseId: base.baseId, parentCandidateId: parent?.candidateId ?? null, generationParentHash: parent?.textHash ?? base.valueHash,
      text: value, textHash: hash(value), feedback, constraints: [...constraints], origin, createdAt: this.now() }
    this.db.prepare(`INSERT INTO planning_feedback_candidates
      (candidate_id,schema_version,project_id,base_id,parent_candidate_id,generation_parent_hash,text,text_hash,feedback,constraints_json,origin_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(candidate.candidateId, candidate.schemaVersion, candidate.projectId, base.baseId, candidate.parentCandidateId,
      candidate.generationParentHash, value, candidate.textHash, feedback, JSON.stringify(constraints), JSON.stringify(origin), candidate.createdAt)
    return candidate
  }

  stageCandidate(request: StagePlanningFeedbackCandidate): PlanningFeedbackCandidate {
    assertPlanningFeedbackObject(request, ['baseId', 'feedback', 'constraints', 'runId', 'attemptId', 'artifactId'], ['parentCandidateId'])
    for (const value of [request.baseId, request.runId, request.attemptId, request.artifactId]) assertPlanningFeedbackId(value)
    assertPlanningFeedbackInstructions(request.feedback, request.constraints)
    return this.transaction(() => {
      const base = this.getBase(request.baseId)
      this.ready(base)
      const parent = request.parentCandidateId == null ? null : this.getCandidate(request.parentCandidateId)
      if (parent) {
        this.mutable('planning_feedback_candidates', parent.candidateId, parent.projectId)
        if (parent.baseId !== base.baseId) fail('PLANNING_FEEDBACK_PARENT_CONFLICT')
      }
      const receipt = new GenerationRunRepository(() => this.db).receipt(request.attemptId)
      const artifact = receipt.artifact
      const discarded = this.db.prepare("SELECT 1 FROM generation_artifacts WHERE artifact_id=? AND status='discarded'").get(request.artifactId)
      if (!artifact || receipt.run.runId !== request.runId || artifact.artifactId !== request.artifactId
        || receipt.run.binding.projectId !== this.options.projectId
        || (receipt.attempt.status !== 'settled' && receipt.attempt.status !== 'unknown')
        || receipt.result?.finishReason !== 'stop'
        || receipt.failureCode || receipt.unsavedTail || receipt.budget.root.status === 'cancelled'
        || discarded || !artifact.text.trim()) fail('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
      if (base.target === 'globalGuidance' && !isGeneratedGlobalGuidanceValid(artifact.text)) fail('PLANNING_FEEDBACK_TEXT_INVALID')
      if (base.target === 'plotOutlineRange' && !validPlotOutlineFeedbackRange(artifact.text, base.scope)) fail('PLANNING_FEEDBACK_TEXT_INVALID')
      if (base.target === 'blueprintFields') parsePlanningFeedbackBlueprintText(artifact.text, base.scope, true)
      const proof: unknown = this.options.assertGenerationCurrent(receipt, base, parent, request)
      if (proof !== undefined) fail('PLANNING_FEEDBACK_ASYNC_PROOF_INVALID')
      this.current()
      this.ready(base)
      const fingerprint = artifact.fingerprint
      const origin = { kind: 'generated' as const, runId: request.runId, attemptId: request.attemptId,
        artifactId: artifact.artifactId, modelLeaseRevision: fingerprint.modelLeaseRevision,
        skillSnapshotHash: fingerprint.skillSnapshotHash, contextSnapshotHash: fingerprint.contextSnapshotHash }
      originSnapshot(origin)
      return this.insertCandidate(base, parent, artifact.text, request.feedback, request.constraints, origin)
    })
  }

  relineageCandidate(request: RelineagePlanningFeedbackCandidate): PlanningFeedbackCandidate {
    assertPlanningFeedbackObject(request, ['baseId', 'sourceCandidateId', 'feedback', 'constraints'])
    assertPlanningFeedbackId(request.baseId)
    assertPlanningFeedbackId(request.sourceCandidateId)
    assertPlanningFeedbackInstructions(request.feedback, request.constraints)
    return this.transaction(() => {
      const base = this.getBase(request.baseId)
      this.ready(base)
      const source = this.getCandidate(request.sourceCandidateId), sourceBase = this.getBase(source.baseId)
      if (sourceBase.target !== base.target || source.baseId === base.baseId || JSON.stringify(sourceBase.scope) !== JSON.stringify(base.scope)) fail('PLANNING_FEEDBACK_PARENT_CONFLICT')
      return this.insertCandidate(base, null, source.text, request.feedback, request.constraints, { kind: 'copied',
        sourceCandidateId: source.candidateId, originProjectId: source.projectId, sourceTextHash: source.textHash })
    })
  }

  private adoption(row: Row): PlanningFeedbackAdoption {
    if (!isPlanningFeedbackTarget(row.target) || row.decision_source !== 'author-action'
      || (row.target === 'blueprintFields' ? row.schema_version !== 3 : row.target === 'plotOutlineRange' ? row.schema_version !== 2 : row.schema_version !== 1 || row.adopted_scope_json !== null)) {
      return fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    }
    const adoptedScope = parsePlanningFeedbackScope(isPlanningFeedbackCoreTarget(row.target) ? { kind: 'field', field: row.target }
      : parse(row.adopted_scope_json))
    const portableHistory = this.options.isFrozen('planning_feedback_adoptions', text(row.adoption_id))
      && row.request_hash === '' && row.idempotency_key === `portable-history:${text(row.adoption_id)}`
    const result: PlanningFeedbackAdoption = { schemaVersion: row.target === 'blueprintFields' ? 3 : row.target === 'plotOutlineRange' ? 2 : 1, adoptionId: text(row.adoption_id), projectId: text(row.project_id), adoptedScope,
      baseId: text(row.base_id), candidateId: text(row.candidate_id), idempotencyKey: text(row.idempotency_key),
      requestHash: portableHistory ? '' : digest(row.request_hash),
      target: row.target, decision: row.decision as PlanningFeedbackAdoption['decision'], decisionSource: 'author-action',
      text: text(row.text), textHash: digest(row.text_hash),
      beforeValue: text(row.before_value), beforeHash: digest(row.before_hash), sourceRevision: integer(row.source_revision),
      committedRevision: integer(row.committed_revision), createdAt: integer(row.created_at) }
    const request: AdoptPlanningFeedbackCandidate = { candidateId: result.candidateId, idempotencyKey: result.idempotencyKey, decision: result.decision, text: result.text,
      ...(adoptedScope.kind === 'plot-outline-range' ? { adoptedRange: { from: adoptedScope.from, to: adoptedScope.to } } : {}) }
    assertPlanningFeedbackAdoption(request)
    const candidate = this.getCandidate(result.candidateId), base = this.getBase(result.baseId)
    if (hash(result.text) !== result.textHash || hash(result.beforeValue) !== result.beforeHash
      || base.projectId !== result.projectId || candidate.baseId !== base.baseId || result.target !== base.target
      || result.schemaVersion !== base.schemaVersion || candidate.schemaVersion !== base.schemaVersion
      || JSON.stringify(planningFeedbackAdoptedScope(base, request.adoptedRange, request.text)) !== JSON.stringify(adoptedScope)
      || (base.target === 'plotOutlineRange' && (adoptedScope.kind !== 'plot-outline-range' || !validPlotOutlineFeedbackRange(result.text, adoptedScope)
        || (result.decision === 'full' && (JSON.stringify(adoptedScope) !== JSON.stringify(base.scope) || result.text !== candidate.text))))
      || (base.target === 'blueprintFields' && result.decision === 'full'
        && (JSON.stringify(adoptedScope) !== JSON.stringify(base.scope) || result.text !== candidate.text))
      || result.sourceRevision !== base.sourceRevision || result.beforeValue !== base.value
      || (!portableHistory && hash(planningFeedbackAdoptionBinding(request, candidate, base, result.textHash)) !== result.requestHash)) fail('PLANNING_FEEDBACK_INTEGRITY_FAILED')
    return result
  }

  listAdoptions(baseId: string): PlanningFeedbackAdoption[] {
    this.getBase(baseId)
    return (this.db.prepare('SELECT * FROM planning_feedback_adoptions WHERE base_id=? ORDER BY created_at,adoption_id').all(baseId) as Row[])
      .map(row => this.adoption(row))
  }

  adopt(request: AdoptPlanningFeedbackCandidate): PlanningFeedbackAdoption {
    assertPlanningFeedbackAdoption(request)
    return this.transaction(() => {
      // Replay is checked before source CAS, so a lost reply never performs the write twice.
      const prior = this.db.prepare('SELECT * FROM planning_feedback_adoptions WHERE project_id=? AND idempotency_key=?')
        .get(this.options.projectId, request.idempotencyKey) as Row | undefined
      const candidate = this.getCandidate(request.candidateId), base = this.getBase(candidate.baseId)
      this.mutable('planning_feedback_candidates', candidate.candidateId, candidate.projectId)
      this.mutable('planning_feedback_bases', base.baseId, base.projectId)
      const adoptedScope = planningFeedbackAdoptedScope(base, request.adoptedRange, request.text)
      const payloadHash = hash(request.text), requestHash = hash(planningFeedbackAdoptionBinding(request, candidate, base, payloadHash))
      if (prior) {
        const receipt = this.adoption(prior)
        this.mutable('planning_feedback_adoptions', receipt.adoptionId, receipt.projectId)
        if (receipt.requestHash !== requestHash) fail('PLANNING_FEEDBACK_IDEMPOTENCY_CONFLICT')
        return receipt
      }
      this.ready(base)
      if (request.decision === 'full' && (request.text !== candidate.text || JSON.stringify(adoptedScope) !== JSON.stringify(base.scope))) fail('PLANNING_FEEDBACK_TEXT_INVALID')
      // Core/range author edits retain their existing contract; blueprint JSON is a closed selected-field subset.
      const adoptionId = randomUUID(), createdAt = this.now()
      let expectedSource: PlanningFeedbackSource
      if (base.target === 'plotOutlineRange') {
        if (adoptedScope.kind !== 'plot-outline-range') fail('PLANNING_FEEDBACK_SCOPE_INVALID')
        const synopsis = commitPlanningFeedbackOutline(this.db, base, adoptedScope, request.text)
        expectedSource = { ...base.source, synopsis }
      } else if (base.target === 'blueprintFields') {
        const changes = parsePlanningFeedbackBlueprintText(request.text, base.scope, false)
        const blueprint = { ...base.source.blueprint, ...changes }
        BlueprintRepository.commitRange({ mode: 'replace-range', operationId: `planning-feedback:${adoptionId}`,
          startChapter: base.scope.chapterNumber, endChapter: base.scope.chapterNumber, blueprints: [blueprint] },
        () => this.ready(base), this.db, 'replace', { authorFields: 'exact', feedbackRequestHash: requestHash })
        expectedSource = { ...base.source, blueprint }
      } else {
        ProjectCoreRepository.update({ [base.target]: request.text }, this.db)
        expectedSource = { ...base.source, [base.target]: request.text }
      }
      this.current()
      const expectedHash = planningFeedbackSourceHash(expectedSource)
      if (planningFeedbackSourceHash(this.source(base.target, base.scope)) !== expectedHash) fail('PLANNING_FEEDBACK_WRITE_FAILED')
      // A successful adoption consumes F0 even if its final text is unchanged; raw same-value edits do not.
      if (expectedHash === base.sourceHash) {
        if (base.target === 'blueprintFields') {
          // Raw JSON/NULL normalization can consume the writer revision without changing the semantic source hash.
          if (this.revision(base.target, base.scope) === base.sourceRevision) {
            const chapterRevision = base.sourceRevision - this.revision('plotOutlineRange')
            const consumed = this.db.prepare('UPDATE planning_feedback_blueprint_revisions SET revision=revision+1 WHERE chapter_number=? AND revision=?')
              .run(base.scope.chapterNumber, chapterRevision)
            if (consumed.changes !== 1) fail('PLANNING_FEEDBACK_SOURCE_CONFLICT')
          }
        } else {
          const table = base.target === 'plotOutlineRange' ? 'planning_feedback_outline_revision' : 'planning_feedback_core_revision'
          const consumed = this.db.prepare(`UPDATE ${table} SET revision=revision+1 WHERE id=1 AND revision=?`).run(base.sourceRevision)
          if (consumed.changes !== 1) fail('PLANNING_FEEDBACK_SOURCE_CONFLICT')
          if (base.target !== 'plotOutlineRange'
            && this.db.prepare('UPDATE planning_feedback_outline_revision SET revision=revision+1 WHERE id=1').run().changes !== 1) fail('PLANNING_FEEDBACK_WRITE_FAILED')
        }
      }
      const committedRevision = this.revision(base.target, base.scope)
      if (committedRevision !== base.sourceRevision + 1) fail('PLANNING_FEEDBACK_WRITE_FAILED')
      this.db.prepare(`INSERT INTO planning_feedback_adoptions
        (adoption_id,schema_version,project_id,base_id,candidate_id,idempotency_key,request_hash,target,decision,decision_source,text,text_hash,before_value,before_hash,source_revision,committed_revision,created_at,adopted_scope_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(adoptionId, base.schemaVersion, this.options.projectId, base.baseId, candidate.candidateId,
        request.idempotencyKey, requestHash, base.target, request.decision, 'author-action', request.text, payloadHash, base.value, base.valueHash,
        base.sourceRevision, committedRevision, createdAt, base.schemaVersion === 1 ? null : JSON.stringify(adoptedScope))
      const closed = this.db.prepare('UPDATE planning_feedback_bases SET closed_at=?,closed_by_adoption_id=? WHERE base_id=? AND closed_at IS NULL')
        .run(createdAt, adoptionId, base.baseId)
      if (closed.changes !== 1) fail('PLANNING_FEEDBACK_SOURCE_CONFLICT')
      return this.adoption(this.db.prepare('SELECT * FROM planning_feedback_adoptions WHERE adoption_id=?').get(adoptionId) as Row)
    })
  }
}

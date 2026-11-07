import type Database from 'better-sqlite3'
import { planningFeedbackCoreSnapshot, type PlanningFeedbackBase, type PlanningFeedbackOutlineSource,
  type PlanningFeedbackScope } from '../../src/shared/planning-feedback'
import { readExistingPlotOutlineRange, renderExistingPlotOutlineFeedbackRange,
  validPlotOutlineFeedbackRange } from '../../src/shared/plot-outline-contract'
import { ProjectCoreRepository, type ProjectCoreSynopsisExpected } from './project-core-repository'

type RangeScope = Extract<PlanningFeedbackScope, { kind: 'plot-outline-range' }>
type RangeBase = Extract<PlanningFeedbackBase, { target: 'plotOutlineRange' }>

export function readPlanningFeedbackOutlineSource(db: Database.Database): PlanningFeedbackOutlineSource {
  const current = ProjectCoreRepository.get(db)
  if (!current) throw new Error('PLANNING_FEEDBACK_CORE_MISSING')
  return { core: planningFeedbackCoreSnapshot(current), synopsis: current.synopsis, charactersArch: current.charactersArch }
}

export function planningFeedbackOutlineExpected(source: PlanningFeedbackOutlineSource): ProjectCoreSynopsisExpected {
  return { synopsis: source.synopsis, charactersArch: source.charactersArch,
    premise: String(source.core.premise), worldbuilding: String(source.core.worldbuilding), genre: String(source.core.genre),
    totalChapters: Number(source.core.totalChapters), wordsPerChapter: Number(source.core.wordsPerChapter),
    writingLanguage: source.core.writingLanguage as ProjectCoreSynopsisExpected['writingLanguage'],
    plotStructure: String(source.core.plotStructure), narrativePov: String(source.core.narrativePov), globalGuidance: String(source.core.globalGuidance) }
}

export function planningFeedbackOutlineValue(source: PlanningFeedbackOutlineSource, scope: RangeScope): string {
  return readExistingPlotOutlineRange(planningFeedbackOutlineExpected(source), scope)
}

/** Only this fixed synopsis writer is available; the caller owns authority, CAS and the history transaction. */
export function commitPlanningFeedbackOutline(db: Database.Database, base: RangeBase, scope: RangeScope, body: string): string {
  if (!db.inTransaction) throw new Error('PLANNING_FEEDBACK_TRANSACTION_REQUIRED')
  if (!validPlotOutlineFeedbackRange(body, scope)) throw new Error('PLANNING_FEEDBACK_TEXT_INVALID')
  const expected = planningFeedbackOutlineExpected(base.source)
  const synopsis = renderExistingPlotOutlineFeedbackRange(body, scope, expected)
  if (!ProjectCoreRepository.commitSynopsis({ synopsis, expected }, db)) throw new Error('PLANNING_FEEDBACK_SOURCE_CONFLICT')
  return synopsis
}

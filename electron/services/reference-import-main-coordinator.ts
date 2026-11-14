import type { ImportRunSnapshot, ImportRunStartResult } from '../../src/shared/import-run'
import type { ReferenceBlueprintResult } from '../../src/shared/reference-blueprint-contract'
import type { ReferenceGlobalResult } from '../../src/shared/reference-global-contract'
import type { ReferenceRefreshSuccess } from '../../src/shared/reference-refresh-contract'
import type { ReferenceRunCompletion, ReferenceRunRequest, ReferenceRunStage } from '../../src/shared/reference-run-contract'
import type { ReferenceStyleResult } from '../../src/shared/reference-style-contract'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { assertReferenceImportSkippedHistory } from './reference-import-history'
import type { ProjectRuntime } from './project-runtime'

export interface ReferenceImportMainCoordinatorRunners {
  knowledge(): Promise<ImportRunStartResult>
  global(modelId: string | null): Promise<ReferenceGlobalResult>
  style(modelId: string | null): Promise<ReferenceStyleResult>
  blueprints(modelId: string | null): Promise<ReferenceBlueprintResult>
  refresh(): Promise<ReferenceRefreshSuccess>
}

export interface ReferenceImportMainCoordinatorHooks {
  stageStarted(stage: ReferenceRunStage, run: ImportRunSnapshot): void
  stageSkipped(stage: ReferenceRunStage, run: ImportRunSnapshot): Promise<void>
  stageCompleted(completion: ReferenceRunCompletion): Promise<void>
}

export interface ExecuteReferenceImportMainRunOptions {
  runtime: ProjectRuntime
  request: ReferenceRunRequest
  assertCurrent(): void
  runners: ReferenceImportMainCoordinatorRunners
  hooks: ReferenceImportMainCoordinatorHooks
}

const STAGES: readonly ReferenceRunStage[] = ['knowledge', 'global', 'style', 'blueprints', 'refresh']

function assertIdentityAndStage(
  runtime: ProjectRuntime,
  request: ReferenceRunRequest,
  expectedStage: ReferenceRunStage | 'completed',
): ImportRunSnapshot {
  const { reference, execution } = request
  if (reference.projectId !== runtime.projectId) throw new Error('REFERENCE_RUN_PROJECT_MISMATCH')

  const run = ImportRunRepository.get(reference.runId, runtime)
  if (!run || run.id !== reference.runId || run.purpose !== 'reference') {
    throw new Error('REFERENCE_RUN_NOT_FOUND')
  }
  if (run.stage !== expectedStage) throw new Error('REFERENCE_RUN_STAGE_MISMATCH')

  const authority = runtime.database.prepare(`
    SELECT status, stage, execution_owner, execution_epoch, lease_expires_at
    FROM import_runs WHERE id=?
  `).get(reference.runId) as {
    status: string
    stage: string
    execution_owner: string
    execution_epoch: number
    lease_expires_at: number
  } | undefined
  if (!authority || authority.status !== run.status || authority.stage !== run.stage) {
    throw new Error('REFERENCE_RUN_STATE_MISMATCH')
  }

  if (expectedStage === 'completed') {
    if (run.status !== 'completed') throw new Error('REFERENCE_RUN_STATE_MISMATCH')
    return run
  }

  if (run.status !== 'running'
    || authority.status !== 'running'
    || authority.execution_owner !== execution.owner
    || authority.execution_epoch !== execution.epoch
    || authority.lease_expires_at <= Date.now()) {
    throw new Error('IMPORT_RUN_EXECUTION_STALE')
  }
  return run
}

function completionRun(completion: ReferenceRunCompletion): ImportRunSnapshot {
  return completion.result.run
}

function completionModelId(completion: ReferenceRunCompletion): string | null {
  if (completion.stage === 'knowledge' || completion.stage === 'refresh') return null
  return completion.result.modelId
}

function nextStage(stage: ReferenceRunStage): ReferenceRunStage | 'completed' {
  return STAGES[STAGES.indexOf(stage) + 1] ?? 'completed'
}

function assertCompletionTransition(completion: ReferenceRunCompletion, stage: ReferenceRunStage): void {
  const next = nextStage(stage)
  const run = completionRun(completion)
  if (completion.stage !== stage || run.purpose !== 'reference' || run.stage !== next) {
    throw new Error('REFERENCE_RUN_STAGE_TRANSITION_INVALID')
  }
  if (run.status !== (next === 'completed' ? 'completed' : 'running')) {
    throw new Error('REFERENCE_RUN_STATE_MISMATCH')
  }
}

/** Serially drives the existing foreground stage owners; it owns no lease or durable state. */
export async function executeReferenceImportMainRun({
  runtime,
  request,
  assertCurrent,
  runners,
  hooks,
}: ExecuteReferenceImportMainRunOptions): Promise<ReferenceRefreshSuccess> {
  if (request.reference.projectId !== runtime.projectId) throw new Error('REFERENCE_RUN_PROJECT_MISMATCH')

  assertCurrent()
  let run = ImportRunRepository.get(request.reference.runId, runtime)
  if (!run || run.id !== request.reference.runId || run.purpose !== 'reference') {
    throw new Error('REFERENCE_RUN_NOT_FOUND')
  }

  const completedReplay = run.status === 'completed' && run.stage === 'completed'
  if (completedReplay) {
    run = assertIdentityAndStage(runtime, request, 'completed')
    for (const stage of STAGES.slice(0, -1)) {
      assertCurrent()
      assertReferenceImportSkippedHistory(runtime, request.reference.runId, stage)
      await hooks.stageSkipped(stage, run)
      assertCurrent()
      run = assertIdentityAndStage(runtime, request, 'completed')
    }
  } else {
    if (run.status !== 'running' || !STAGES.includes(run.stage as ReferenceRunStage)) {
      throw new Error('IMPORT_RUN_EXECUTION_STALE')
    }
    const initialStage = run.stage as ReferenceRunStage
    run = assertIdentityAndStage(runtime, request, initialStage)
    for (const stage of STAGES.slice(0, STAGES.indexOf(initialStage))) {
      assertCurrent()
      assertReferenceImportSkippedHistory(runtime, request.reference.runId, stage)
      await hooks.stageSkipped(stage, run)
      assertCurrent()
      run = assertIdentityAndStage(runtime, request, initialStage)
    }
  }

  let modelId = request.modelId
  let refreshResult: ReferenceRefreshSuccess | undefined
  const firstStage = completedReplay ? 'refresh' : run.stage as ReferenceRunStage
  for (const stage of STAGES.slice(STAGES.indexOf(firstStage))) {
    assertCurrent()
    const expectedBefore = completedReplay ? 'completed' : stage
    run = assertIdentityAndStage(runtime, request, expectedBefore)
    hooks.stageStarted(stage, run)
    assertCurrent()
    run = assertIdentityAndStage(runtime, request, expectedBefore)

    let completion: ReferenceRunCompletion
    switch (stage) {
      case 'knowledge':
        completion = { stage, result: await runners.knowledge() }
        break
      case 'global':
        completion = { stage, result: await runners.global(modelId) }
        break
      case 'style':
        completion = { stage, result: await runners.style(modelId) }
        break
      case 'blueprints':
        completion = { stage, result: await runners.blueprints(modelId) }
        break
      case 'refresh':
        completion = { stage, result: await runners.refresh() }
        refreshResult = completion.result
        break
    }

    assertCurrent()
    assertCompletionTransition(completion, stage)
    const expectedNext = nextStage(stage)
    run = assertIdentityAndStage(runtime, request, expectedNext)
    if (run.id !== completionRun(completion).id || run.stage !== completionRun(completion).stage
      || run.status !== completionRun(completion).status) {
      throw new Error('REFERENCE_RUN_RESULT_STALE')
    }

    const actualModelId = completionModelId(completion)
    if (actualModelId) modelId = actualModelId

    await hooks.stageCompleted(completion)
    assertCurrent()
    run = assertIdentityAndStage(runtime, request, expectedNext)
  }

  if (run.status !== 'completed' || run.stage !== 'completed' || !refreshResult) {
    throw new Error('REFERENCE_RUN_NOT_COMPLETED')
  }
  return refreshResult
}

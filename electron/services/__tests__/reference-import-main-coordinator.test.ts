import { afterEach, describe, expect, it, vi } from 'vitest'
const skippedHistory = vi.hoisted(() => ({ assert: vi.fn() }))
vi.mock('../reference-import-history', () => ({ assertReferenceImportSkippedHistory: skippedHistory.assert }))
import type { ImportRunSnapshot, ImportRunStage } from '../../../src/shared/import-run'
import type { ReferenceBlueprintResult } from '../../../src/shared/reference-blueprint-contract'
import type { ReferenceGlobalResult } from '../../../src/shared/reference-global-contract'
import type { ReferenceRefreshSuccess } from '../../../src/shared/reference-refresh-contract'
import type { ReferenceRunCompletion, ReferenceRunRequest, ReferenceRunStage } from '../../../src/shared/reference-run-contract'
import type { ReferenceStyleResult } from '../../../src/shared/reference-style-contract'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import type { ProjectRuntime } from '../project-runtime'
import { executeReferenceImportMainRun } from '../reference-import-main-coordinator'

const OWNER = 'fixture-owner'
const EPOCH = 4
const RUN_ID = 'fixture-reference-run'

interface PersistedRun { stage: ImportRunStage | 'completed'; status: 'running' | 'completed'; owner: string; epoch: number; leaseExpiresAt: number }

function makeRun(stage: ImportRunStage | 'completed', status: 'running' | 'completed' = 'running'): ImportRunSnapshot {
  return { id: RUN_ID, purpose: 'reference', rootRunId: RUN_ID, effectNamespace: 'fixture', sourceDisplay: [], locale: 'en-US',
    stage, status, completedBatches: {}, lastError: '', resumable: false, cancelRequested: false,
    totalChapters: 1, totalContentSize: 1, manifestChapterCount: 1, manifestContentSize: 1, manifestWordCount: 1,
    completedChapters: 0, createdAt: '', updatedAt: '' }
}

function makeHarness(initialStage: ImportRunStage | 'completed' = 'knowledge') {
  skippedHistory.assert.mockReset()
  const terminal = initialStage === 'completed'
  let persisted: PersistedRun = { stage: initialStage, status: terminal ? 'completed' : 'running',
    owner: terminal ? '' : OWNER, epoch: terminal ? EPOCH + 1 : EPOCH,
    leaseExpiresAt: terminal ? 0 : Date.now() + 60_000 }
  const database = { prepare: vi.fn(() => ({ get: vi.fn(() => ({
    status: persisted.status, stage: persisted.stage, execution_owner: persisted.owner,
    execution_epoch: persisted.epoch, lease_expires_at: persisted.leaseExpiresAt,
  })) })) }
  const runtime = { projectId: 'fixture-project', database } as unknown as ProjectRuntime
  const request: ReferenceRunRequest = { reference: { projectId: 'fixture-project', runId: RUN_ID,
    grantId: 'fixture-grant', revision: 1 }, execution: { owner: OWNER, epoch: EPOCH }, modelId: null }
  const repositoryGet = vi.spyOn(ImportRunRepository, 'get').mockImplementation(() => makeRun(persisted.stage, persisted.status))
  const transition = (stage: ImportRunStage | 'completed', status: 'running' | 'completed' = 'running') => {
    persisted = { ...persisted, stage, status,
      ...(status === 'completed' ? { owner: '', epoch: EPOCH + 1, leaseExpiresAt: 0 } : {}) }
  }
  const runners = {
    knowledge: vi.fn(async () => {
      transition('global')
      return { run: makeRun('global'), execution: { owner: OWNER, epoch: EPOCH, expiresAt: persisted.leaseExpiresAt } }
    }),
    global: vi.fn<(modelId: string | null) => Promise<ReferenceGlobalResult>>(async () => {
      transition('style')
      return { run: makeRun('style'), modelId: 'global-model' } as ReferenceGlobalResult
    }),
    style: vi.fn<(modelId: string | null) => Promise<ReferenceStyleResult>>(async () => {
      transition('blueprints')
      return { run: makeRun('blueprints'), modelId: null } as ReferenceStyleResult
    }),
    blueprints: vi.fn<(modelId: string | null) => Promise<ReferenceBlueprintResult>>(async () => {
      transition('refresh')
      return { run: makeRun('refresh'), modelId: 'blueprint-model' } as ReferenceBlueprintResult
    }),
    refresh: vi.fn(async () => {
      transition('completed', 'completed')
      return { run: makeRun('completed', 'completed'), execution: null, replayed: terminal, version: 1 } as ReferenceRefreshSuccess
    }),
  }
  const started: ReferenceRunStage[] = []
  const skipped: ReferenceRunStage[] = []
  const completed: ReferenceRunCompletion[] = []
  const hooks = { stageStarted: vi.fn((stage: ReferenceRunStage) => started.push(stage)),
    stageSkipped: vi.fn(async (stage: ReferenceRunStage) => { skipped.push(stage) }),
    stageCompleted: vi.fn(async (value: ReferenceRunCompletion) => { completed.push(value) }) }
  return { runtime, request, persisted: () => persisted, transition, repositoryGet, runners,
    started, skipped, completed, hooks, assertCurrent: vi.fn() }
}

afterEach(() => vi.restoreAllMocks())

describe('executeReferenceImportMainRun', () => {
  it('runs the five existing owners serially and pins only non-null actual model IDs', async () => {
    const h = makeHarness()

    const result = await executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent,
      runners: h.runners, hooks: h.hooks })

    expect(h.started).toEqual(['knowledge', 'global', 'style', 'blueprints', 'refresh'])
    expect(h.skipped).toEqual([])
    expect(h.runners.global).toHaveBeenCalledWith(null)
    expect(h.runners.style).toHaveBeenCalledWith('global-model')
    expect(h.runners.blueprints).toHaveBeenCalledWith('global-model')
    expect(h.runners.refresh).toHaveBeenCalledTimes(1)
    expect(h.completed.map(value => value.stage)).toEqual(h.started)
    expect(result.run.stage).toBe('completed')
  })

  it('resumes at the persisted stage and reports only earlier stages as skipped', async () => {
    const h = makeHarness('style')

    await executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent, runners: h.runners, hooks: h.hooks })

    expect(h.skipped).toEqual(['knowledge', 'global'])
    expect(h.started).toEqual(['style', 'blueprints', 'refresh'])
    expect(h.runners.knowledge).not.toHaveBeenCalled()
    expect(h.runners.global).not.toHaveBeenCalled()
    expect(h.runners.blueprints).toHaveBeenCalledWith(null)
    expect(skippedHistory.assert.mock.calls).toEqual([
      [h.runtime, RUN_ID, 'knowledge'], [h.runtime, RUN_ID, 'global'],
    ])
  })

  it('propagates skipped-history failure before emitting a projection or starting the resumed owner', async () => {
    const h = makeHarness('style')
    skippedHistory.assert.mockImplementationOnce(() => { throw new Error('IMPORT_RUN_EFFECT_HISTORY_UNKNOWN') })

    await expect(executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent,
      runners: h.runners, hooks: h.hooks })).rejects.toThrow('IMPORT_RUN_EFFECT_HISTORY_UNKNOWN')

    expect(skippedHistory.assert).toHaveBeenCalledWith(h.runtime, RUN_ID, 'knowledge')
    expect(h.hooks.stageSkipped).not.toHaveBeenCalled()
    expect(h.runners.style).not.toHaveBeenCalled()
  })

  it('waits for each skipped-stage projection ACK before starting the persisted stage', async () => {
    const h = makeHarness('style')
    let settle!: () => void
    const projection = new Promise<void>(resolve => { settle = resolve })
    h.hooks.stageSkipped.mockImplementationOnce(async stage => { h.skipped.push(stage); await projection })

    const flight = executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent,
      runners: h.runners, hooks: h.hooks })

    expect(h.skipped).toEqual(['knowledge'])
    expect(h.runners.style).not.toHaveBeenCalled()
    settle()
    await flight
    expect(h.runners.style).toHaveBeenCalledTimes(1)
  })

  it('rechecks the persisted lease after a skipped-stage projection ACK', async () => {
    const h = makeHarness('style')
    let settle!: () => void
    const projection = new Promise<void>(resolve => { settle = resolve })
    h.hooks.stageSkipped.mockImplementationOnce(async stage => { h.skipped.push(stage); await projection })

    const flight = executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent,
      runners: h.runners, hooks: h.hooks })
    expect(h.runners.style).not.toHaveBeenCalled()
    h.persisted().leaseExpiresAt = 0
    settle()

    await expect(flight).rejects.toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(h.runners.style).not.toHaveBeenCalled()
  })

  it('replays completed history through refresh only and skips prior stages without a lease', async () => {
    const h = makeHarness('completed')

    const result = await executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent,
      runners: h.runners, hooks: h.hooks })

    expect(h.skipped).toEqual(['knowledge', 'global', 'style', 'blueprints'])
    expect(h.started).toEqual(['refresh'])
    expect(h.runners.knowledge).not.toHaveBeenCalled()
    expect(h.runners.global).not.toHaveBeenCalled()
    expect(h.runners.style).not.toHaveBeenCalled()
    expect(h.runners.blueprints).not.toHaveBeenCalled()
    expect(result.replayed).toBe(true)
  })

  it('rejects a non-adjacent durable transition before dispatching the next stage', async () => {
    const h = makeHarness('global')
    h.runners.global.mockImplementationOnce(async () => {
      h.transition('blueprints')
      return { run: makeRun('blueprints'), modelId: 'fixture-model' } as ReferenceGlobalResult
    })

    await expect(executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent,
      runners: h.runners, hooks: h.hooks })).rejects.toThrow('REFERENCE_RUN_STAGE_TRANSITION_INVALID')
    expect(h.runners.style).not.toHaveBeenCalled()
  })

  it('rejects durable state that skipped a stage even when the runner reports the expected next stage', async () => {
    const h = makeHarness('global')
    h.runners.global.mockImplementationOnce(async () => {
      h.transition('blueprints')
      return { run: makeRun('style'), modelId: 'fixture-model' } as ReferenceGlobalResult
    })

    await expect(executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent,
      runners: h.runners, hooks: h.hooks })).rejects.toThrow('REFERENCE_RUN_STAGE_MISMATCH')
    expect(h.runners.style).not.toHaveBeenCalled()
  })

  it('stops at a failed projection acknowledgement without dispatching a later stage', async () => {
    const h = makeHarness('global')
    h.hooks.stageCompleted.mockRejectedValueOnce(new Error('PROJECTION_ACK_FAILED'))

    await expect(executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent,
      runners: h.runners, hooks: h.hooks })).rejects.toThrow('PROJECTION_ACK_FAILED')
    expect(h.runners.style).not.toHaveBeenCalled()
  })

  it('stops before any runner when the current execution identity is stale or the lease expired', async () => {
    const stale = makeHarness()
    stale.transition('knowledge')
    stale.persisted().epoch += 1
    await expect(executeReferenceImportMainRun({ ...stale, assertCurrent: stale.assertCurrent,
      runners: stale.runners, hooks: stale.hooks })).rejects.toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(stale.runners.knowledge).not.toHaveBeenCalled()

    const expired = makeHarness()
    expired.persisted().leaseExpiresAt = 0
    await expect(executeReferenceImportMainRun({ ...expired, assertCurrent: expired.assertCurrent,
      runners: expired.runners, hooks: expired.hooks })).rejects.toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(expired.runners.knowledge).not.toHaveBeenCalled()
  })

  it('honors cancellation at a stage boundary and does not start the next owner', async () => {
    const h = makeHarness('global')
    h.assertCurrent.mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('FOREGROUND_CANCELLED') })

    await expect(executeReferenceImportMainRun({ ...h, assertCurrent: h.assertCurrent,
      runners: h.runners, hooks: h.hooks })).rejects.toThrow('FOREGROUND_CANCELLED')
    expect(h.runners.global).not.toHaveBeenCalled()
  })
})

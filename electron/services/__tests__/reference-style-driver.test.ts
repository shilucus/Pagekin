import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { type ProjectRuntime } from '../project-runtime'
import { executeReferenceStyle, ReferenceStyleFailure } from '../reference-style-driver'
import { importGenerationFixture, runGlobal } from './import-generation-fixture'
import { getCurrentProjectPath } from '../../database'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(),
  getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })

function options(f: ReturnType<typeof importGenerationFixture>, projectId: string, execution: { owner: string; epoch: number }) {
  const root = getCurrentProjectPath()!
  const runtime = { database: f.db, projectId, projectPath: root, projectStorageRoot: root, canonicalRoot: root,
    executionEpoch: 'epoch-1', databaseIdentity: {}, phase: 'open' } as ProjectRuntime
  const log: (name: string, count?: number) => void = () => {}
  return { runtime, owner: f.owner, viewEpoch: 'epoch-1',
    request: { runId: '长篇导入', execution, modelId: 'synthetic' }, signal: new AbortController().signal,
    assertCurrent: () => {}, hooks: {
      opened: async () => {}, commitReady: async () => {}, committed: () => {}, log, progress: () => {}, promptBudget: () => {},
      failureMessage: (code: string) => code,
    } }
}

async function startStyle(f: ReturnType<typeof importGenerationFixture>) {
  const rootHandle = await runGlobal(f)
  const lease = f.db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs WHERE id=?').get('长篇导入') as {
    execution_owner: string; execution_epoch: number; lease_expires_at: number
  }
  const execution = { owner: lease.execution_owner, epoch: lease.execution_epoch, expiresAt: lease.lease_expires_at }
  return { rootHandle, execution }
}

describe('reference style driver', () => {
  it('does not read unrelated finalized sources when imported samples are usable', async () => {
    const f = importGenerationFixture(cleanup, 2)
    const { rootHandle, execution } = await startStyle(f)
    const content = f.db.prepare("INSERT INTO contents(body) VALUES('unrelated corrupt finalized content')").run()
    f.db.prepare("INSERT INTO drafts_all(chapter_number,version,status,content_id) VALUES(99,1,'finalized',?)").run(content.lastInsertRowid)
    const log: { name: string; count?: number }[] = []
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    const readRecovery = vi.spyOn(f.owner, 'readImportGeneration')
    invoke.hooks.log = (name: string, count?: number) => log.push({ name, count })

    const result = await executeReferenceStyle(invoke)

    expect(result.savedWritingStyle).toBe('{"合成":"结果"}')
    expect(log).toContainEqual({ name: 'imported-samples', count: 2 })
    expect(log.some(event => event.name === 'sampling-finalized' || event.name === 'sampled-finalized')).toBe(false)
    expect(readRecovery).toHaveBeenCalledWith({ runId: '长篇导入', stage: 'global', batchId: 'done' })
    expect(readRecovery).toHaveBeenCalledWith({ runId: '长篇导入', stage: 'style', batchId: 'done' }, result.handle!.runId)
  })

  it('redacts unknown uppercase failures and does not persist them as cancellation', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    invoke.hooks.commitReady = async () => { throw new Error('IMPORT_RUN_PRIVATE_VALUE') }

    let failure: unknown
    try { await executeReferenceStyle(invoke) } catch (error) { failure = error }

    expect(failure).toBeInstanceOf(ReferenceStyleFailure)
    expect(failure).toMatchObject({ errorCode: 'GENERATION_REQUEST_FAILED', displayMessage: 'GENERATION_REQUEST_FAILED' })
    expect(String(failure)).not.toContain('IMPORT_RUN_PRIVATE_VALUE')
    expect(f.db.prepare('SELECT status,cancel_requested FROM import_runs WHERE id=?').get('长篇导入'))
      .toMatchObject({ status: 'failed', cancel_requested: 0 })
  })

  it('does not accept known codes wrapped in error text as exact safe codes', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    invoke.hooks.commitReady = async () => { throw new Error('Error: GENERATION_PROVIDER_FAILED') }

    await expect(executeReferenceStyle(invoke)).rejects.toMatchObject({ errorCode: 'GENERATION_REQUEST_FAILED' })
  })

  it('keeps a resolved hard attempt failure when stop arrives before its operation drains', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    const controller = new AbortController()
    invoke.signal = controller.signal
    let opened!: () => void
    const isOpened = new Promise<void>(resolve => { opened = resolve })
    invoke.hooks.opened = async () => { opened() }
    type Generated = Awaited<ReturnType<typeof f.owner.executeImportGeneration>>
    let settleGeneration!: (result: Generated) => void
    const operation = new Promise<Generated>(resolve => { settleGeneration = resolve })
    vi.spyOn(f.owner, 'executeImportGeneration').mockReturnValue(operation)

    const pending = executeReferenceStyle(invoke)
    await isOpened
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 40))
    settleGeneration({ outcome: { status: 'incomplete', content: '', finishReason: 'error',
      receipt: { failureCode: 'NETWORK_ERROR' } } } as unknown as Generated)

    await expect(pending).rejects.toMatchObject({ errorCode: 'NETWORK_ERROR' })
    expect(f.db.prepare('SELECT status,cancel_requested FROM import_runs WHERE id=?').get('长篇导入'))
      .toMatchObject({ status: 'failed', cancel_requested: 0 })
  })

  it('retains the primary error and reports a same-owner terminal writer failure safely', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    f.current.dispatch = async () => { throw new Error('GENERATION_PROVIDER_FAILED') }
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    const fail = vi.spyOn(ImportRunRepository, 'fail').mockImplementation(() => { throw new Error('GENERATION_PRIVATE_VALUE') })

    let failure: unknown
    try { await executeReferenceStyle(invoke) } catch (error) { failure = error }

    expect(fail).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({ errorCode: 'GENERATION_PROVIDER_FAILED', secondaryErrors: ['GENERATION_REQUEST_FAILED'] })
    expect(String(failure)).not.toContain('GENERATION_PRIVATE_VALUE')
  })

  it('does not start the style attempt when the existing root active-time budget is exhausted', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    const budget = JSON.parse(f.db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(rootHandle.rootActionId) as string)
    f.db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(budget.maxActiveElapsedMs, rootHandle.rootActionId)
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })

    let failure: unknown
    try { await executeReferenceStyle(invoke) } catch (error) { failure = error }

    expect(failure).toMatchObject({ errorCode: 'ROOT_BUDGET_EXHAUSTED' })
    expect(f.db.prepare('SELECT root_action_id FROM generation_runs ORDER BY rowid').pluck().all())
      .toEqual([rootHandle.rootActionId])
    expect(f.spy).toHaveBeenCalledOnce()
  })

  it('replays a completed committed style as a historical read without the old lease', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    const first = await executeReferenceStyle(invoke)
    f.db.prepare("UPDATE import_runs SET stage='completed',status='completed',execution_owner='',execution_epoch=execution_epoch+1,lease_expires_at=0 WHERE id=?")
      .run('长篇导入')
    const subsequent = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })

    const replay = await executeReferenceStyle(subsequent)

    expect(replay).toMatchObject({ replayed: true, execution: null, savedWritingStyle: first.savedWritingStyle })
    expect(f.spy).toHaveBeenCalledTimes(2)
  })

  it('replays a committed style under its current lease without renewing or advancing', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    const first = await executeReferenceStyle(invoke)
    const before = f.db.prepare('SELECT stage,status,execution_owner,execution_epoch,lease_expires_at FROM import_runs WHERE id=?')
      .get('长篇导入') as { stage: string; status: string; execution_owner: string; execution_epoch: number; lease_expires_at: number }
    const renew = vi.spyOn(ImportRunRepository, 'renewExecution')

    const replay = await executeReferenceStyle(invoke)

    expect(replay).toMatchObject({ replayed: true, savedWritingStyle: first.savedWritingStyle,
      execution: { owner: before.execution_owner, epoch: before.execution_epoch, expiresAt: before.lease_expires_at } })
    expect(replay.run.stage).toBe(before.stage)
    expect(replay.run.status).toBe(before.status)
    expect(renew).not.toHaveBeenCalled()
    expect(f.spy).toHaveBeenCalledTimes(2)
  })

  it('advances a committed style receipt when the stage advance was interrupted', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    const first = await executeReferenceStyle(invoke)
    f.db.prepare("UPDATE import_runs SET stage='style' WHERE id=?").run('长篇导入')
    const execute = vi.spyOn(f.owner, 'executeImportGeneration')
    const assertSources = vi.spyOn(f.owner, 'assertImportGenerationSources')

    const replay = await executeReferenceStyle(invoke)

    expect(replay).toMatchObject({ replayed: true, savedWritingStyle: first.savedWritingStyle, run: { stage: 'blueprints' } })
    expect(execute).not.toHaveBeenCalled()
    expect(assertSources).not.toHaveBeenCalled()
    expect(f.spy).toHaveBeenCalledTimes(2)
  })

  it('keeps the legacy no-finalized log sequence without an extra empty-samples event', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    vi.spyOn(ImportRunRepository, 'listRepresentativeChapters').mockReturnValue([])
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    const logs: string[] = []
    invoke.hooks.log = log => logs.push(log)

    await expect(executeReferenceStyle(invoke)).rejects.toMatchObject({ errorCode: 'GENERATION_REQUEST_FAILED' })

    expect(logs).toEqual(['sampling-finalized', 'no-finalized'])
  })

  it('logs an empty finalized sample window before reporting empty samples', async () => {
    const f = importGenerationFixture(cleanup, 1)
    const { rootHandle, execution } = await startStyle(f)
    vi.spyOn(ImportRunRepository, 'listRepresentativeChapters').mockReturnValue([])
    const content = f.db.prepare("INSERT INTO contents(body) VALUES('')").run()
    f.db.prepare("INSERT INTO drafts_all(chapter_number,version,status,content_id) VALUES(1,1,'finalized',?)").run(content.lastInsertRowid)
    const invoke = options(f, rootHandle.projectId, { owner: execution.owner, epoch: execution.epoch })
    const logs: string[] = []
    invoke.hooks.log = log => logs.push(log)

    await expect(executeReferenceStyle(invoke)).rejects.toMatchObject({ errorCode: 'GENERATION_REQUEST_FAILED' })

    expect(logs).toEqual(['sampling-finalized', 'sampled-finalized', 'empty-samples'])
  })
})

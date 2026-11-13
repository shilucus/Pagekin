import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { getCurrentProjectPath } from '../../database'
import { projectAccess } from '../project-access'
import type { ProjectRuntime } from '../project-runtime'
import { executeReferenceBlueprints, ReferenceBlueprintFailure } from '../reference-blueprint-driver'
import { importGenerationFixture, model, runGlobal, runStyle } from './import-generation-fixture'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(),
  getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))

const cleanup: (() => void)[] = []
const originalModelLimits = { maxTokens: model.maxTokens, capabilities: model.capabilities }
afterEach(() => {
  model.maxTokens = originalModelLimits.maxTokens
  model.capabilities = originalModelLimits.capabilities
  for (const dispose of cleanup.splice(0)) dispose()
  vi.restoreAllMocks()
})

function fixture(chapterCount: number) {
  model.maxTokens = 16_384
  model.capabilities = { contextWindowTokens: 16_384, maxOutputTokens: 16_384, reasoning: false,
    structuredOutput: true, usage: true }
  return importGenerationFixture(cleanup, chapterCount)
}

function options(f: ReturnType<typeof importGenerationFixture>, execution: { owner: string; epoch: number }) {
  const root = getCurrentProjectPath()!
  const project = projectAccess.probeExistingProject(f.root)
  if (project.kind !== 'manifest') throw new Error('fixture project identity missing')
  const runtime = { database: f.db, projectId: project.projectId, projectPath: root, projectStorageRoot: root,
    canonicalRoot: root, executionEpoch: 'epoch-1', databaseIdentity: {}, phase: 'open' } as ProjectRuntime
  const events: string[] = []
  const hooks: Parameters<typeof executeReferenceBlueprints>[0]['hooks'] = {
    opened: async ({ batchId }) => { events.push(`opened:${batchId}`) },
    rangeCommitted: batchId => { events.push(`committed:${batchId}`) },
    rangeSynced: batchId => { events.push(`synced:${batchId}`) },
    log: value => { events.push(`log:${value.key}`) }, progress: value => { events.push(`progress:${value}`) },
    promptBudget: () => {}, failureMessage: code => code,
  }
  return { runtime, owner: f.owner, viewEpoch: 'epoch-1', request: { runId: '长篇导入', execution, modelId: 'synthetic' },
    signal: new AbortController().signal, assertCurrent: () => {}, hooks, events }
}

function blueprintOutput(numbers: readonly number[]) {
  return JSON.stringify({ blueprints: numbers.map(chapterNumber => ({ chapterNumber, title: `章节${chapterNumber}`,
    role: 'setup', purpose: `推进第${chapterNumber}章`, keyEvents: `事件${chapterNumber}`,
    characters: ['林岚'], relationships: [], suspenseHook: `悬念${chapterNumber}` })) })
}

function lease(f: ReturnType<typeof importGenerationFixture>) {
  return f.db.prepare('SELECT execution_owner AS owner,execution_epoch AS epoch FROM import_runs WHERE id=?').get('长篇导入') as {
    owner: string; epoch: number
  }
}

function dispatchBlueprints(f: ReturnType<typeof importGenerationFixture>, groups: readonly (readonly number[])[]) {
  let call = 0
  f.current.dispatch = async (_request, dispatchOptions) => {
    const numbers = groups[call++]
    if (!numbers) throw new Error('unexpected synthetic dispatch')
    dispatchOptions.onVisible({ kind: 'delta', text: blueprintOutput(numbers) })
    return { finishReason: 'stop', usage: null }
  }
}

describe('reference blueprint driver', () => {
  it('creates the first blueprint root when the run has no prior generation history', async () => {
    const f = fixture(1)
    const execution = ImportRunRepository.startOrResume('长篇导入', '蓝图首建测试').execution
    f.db.prepare("UPDATE import_runs SET stage='blueprints' WHERE id=?").run('长篇导入')
    dispatchBlueprints(f, [[1]])
    const invoke = options(f, { owner: execution.owner, epoch: execution.epoch })
    const begin = vi.spyOn(f.owner, 'begin')

    const result = await executeReferenceBlueprints(invoke)

    expect(begin).toHaveBeenCalledWith(expect.objectContaining({ operation: 'import-blueprints',
      modelId: 'synthetic', importSlot: expect.objectContaining({ stage: 'blueprints' }) }))
    expect(Object.hasOwn(begin.mock.calls[0]![0], 'parentRootActionId')).toBe(false)
    expect(result.run.stage).toBe('refresh')
    expect(result.receipt.state).toBe('committed')
    expect(invoke.events.indexOf(invoke.events.find(event => event.startsWith('opened:'))!))
      .toBeLessThan(invoke.events.indexOf('log:inferring'))
  })

  it('keeps max-five ranges on the original root and restarts ordinals per range', async () => {
    const f = fixture(6)
    await runGlobal(f)
    await runStyle(f)
    dispatchBlueprints(f, [[1, 2, 3, 4, 5], [6]])
    const execution = lease(f)
    const invoke = options(f, execution)
    const execute = vi.spyOn(f.owner, 'executeImportGeneration')

    const result = await executeReferenceBlueprints(invoke)

    const blueprintRuns = f.db.prepare(`SELECT run_id,root_action_id FROM generation_runs
      WHERE json_extract(binding_json,'$.sourceManifest.importSlot.stage')='blueprints' ORDER BY rowid`).all() as {
        run_id: string; root_action_id: string
      }[]
    expect(blueprintRuns).toHaveLength(2)
    expect(new Set(blueprintRuns.map(run => run.root_action_id))).toEqual(new Set([blueprintRuns[0]!.root_action_id]))
    expect(f.db.prepare(`SELECT invocation_nonce FROM generation_attempts WHERE run_id IN (?,?) ORDER BY rowid`)
      .all(...blueprintRuns.map(run => run.run_id))).toEqual([{ invocation_nonce: 'import:0' }, { invocation_nonce: 'import:0' }])
    expect(execute).toHaveBeenCalledTimes(2)
    expect(result.run.stage).toBe('refresh')
    expect(result.replayed).toBe(false)
    const syncIndex = invoke.events.findIndex(event => event.startsWith('synced:'))
    expect(syncIndex).toBeLessThan(invoke.events.indexOf('log:complete'))
    expect(invoke.events.indexOf('log:complete')).toBeLessThan(invoke.events.indexOf('progress:100'))
  })

  it.each(['content_filter', 'unknown', 'error'] as const)(
    'preserves the structured executor failure for %s without committing a range', async finishReason => {
      const f = fixture(1)
      await runGlobal(f)
      await runStyle(f)
      let calls = 0
      f.current.dispatch = async () => { calls += 1; return { finishReason, usage: null } }
      const invoke = options(f, lease(f))

      let failure: unknown
      try { await executeReferenceBlueprints(invoke) } catch (error) { failure = error }

      expect(failure).toMatchObject({ errorCode: 'GENERATION_REQUEST_FAILED',
        displayMessage: `蓝图推演失败：结构化生成未正常完成：${finishReason}` })
      expect(calls).toBe(1)
      expect(f.db.prepare("SELECT COUNT(*) FROM import_run_receipts WHERE run_id=? AND stage='blueprints'").pluck().get('长篇导入')).toBe(0)
    },
  )

  it('preserves the terminal context-length receipt for the structured executor', async () => {
    const f = fixture(1)
    await runGlobal(f)
    await runStyle(f)
    let calls = 0
    f.current.dispatch = async () => { calls += 1; throw new Error('GENERATION_CONTEXT_LENGTH_EXCEEDED') }
    const invoke = options(f, lease(f))

    let failure: unknown
    try { await executeReferenceBlueprints(invoke) } catch (error) { failure = error }

    expect(failure).toBeInstanceOf(ReferenceBlueprintFailure)
    expect(failure).toMatchObject({ errorCode: 'GENERATION_CONTEXT_LENGTH_EXCEEDED' })
    expect(calls).toBe(1)
    expect(f.db.prepare(`SELECT json_extract(usage_receipt_json,'$.result.failureCode') FROM generation_attempts a
      JOIN generation_runs g ON g.run_id=a.run_id
      WHERE json_extract(g.binding_json,'$.sourceManifest.importSlot.stage')='blueprints'`).pluck().get())
      .toBe('GENERATION_CONTEXT_LENGTH_EXCEEDED')
    expect(f.db.prepare("SELECT COUNT(*) FROM import_run_receipts WHERE run_id=? AND stage='blueprints'").pluck().get('长篇导入')).toBe(0)
  })

  it('does not consume an ordinal when task-budget admission splits before a receipt', async () => {
    const f = fixture(2)
    await runGlobal(f)
    await runStyle(f)
    dispatchBlueprints(f, [[1], [2]])
    const invoke = options(f, lease(f))
    const execute = vi.spyOn(f.owner, 'executeImportGeneration').mockImplementationOnce(async () => {
      throw new Error('TASK_BUDGET_SCOPE_SPLIT_REQUIRED:1')
    })

    const result = await executeReferenceBlueprints(invoke)

    expect(result.run.stage).toBe('refresh')
    const rows = f.db.prepare(`SELECT a.invocation_nonce FROM generation_attempts a
      JOIN generation_runs g ON g.run_id=a.run_id
      WHERE json_extract(g.binding_json,'$.sourceManifest.importSlot.stage')='blueprints' ORDER BY a.rowid`).all()
    expect(rows).toEqual([{ invocation_nonce: 'import:0' }, { invocation_nonce: 'import:1' }])
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('keeps a syntax-repair incomplete response in the executor failure path', async () => {
    const f = fixture(1)
    await runGlobal(f)
    await runStyle(f)
    let calls = 0
    f.current.dispatch = async (_request, dispatchOptions) => {
      calls += 1
      if (calls === 1) {
        dispatchOptions.onVisible({ kind: 'delta', text: '{"blueprints":[' })
        return { finishReason: 'stop', usage: null }
      }
      return { finishReason: 'content_filter', usage: null }
    }
    const invoke = options(f, lease(f))

    let failure: unknown
    try { await executeReferenceBlueprints(invoke) } catch (error) { failure = error }

    expect(failure).toMatchObject({ errorCode: 'GENERATION_REQUEST_FAILED',
      displayMessage: '蓝图推演失败：结构化语法修复未正常完成：content_filter' })
    expect(calls).toBe(2)
    expect(f.db.prepare(`SELECT COUNT(*) FROM generation_attempts a JOIN generation_runs g ON g.run_id=a.run_id
      WHERE json_extract(g.binding_json,'$.sourceManifest.importSlot.stage')='blueprints'`).pluck().get()).toBe(2)
    expect(f.db.prepare("SELECT COUNT(*) FROM import_run_receipts WHERE run_id=? AND stage='blueprints'").pluck().get('长篇导入')).toBe(0)
  })
})

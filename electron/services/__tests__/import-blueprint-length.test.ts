import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PhysicalAttempt } from '../../../src/shared/generation-contract'
import type { ImportGenerationSlot } from '../../../src/shared/import-generation'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import type { GenerationProviderUsage, GenerationRunServiceDependencies } from '../generation-run-service'
import { blueprintEffect, blueprintSlot, importGenerationFixture, openSlot } from './import-generation-fixture'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))

const cleanup: (() => void)[] = []
const runId = '\u957f\u7bc7\u5bfc\u5165'
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })

const task: GenerationTask = { purpose: 'chapter-blueprint-directory', output: 'structured-data',
  messages: [{ role: 'user', content: 'Infer only the frozen fictional chapter blueprint.' }] }
const trustedUsage: GenerationProviderUsage = { promptTokens: 10, completionTokens: 4, totalTokens: 14,
  reasoningTokens: 0, accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true }

function fixture(dispatch: GenerationRunServiceDependencies['dispatch'], stage: ImportGenerationSlot['stage'] = 'blueprints', purpose = 'reference') {
  const f = importGenerationFixture(cleanup, 1, dispatch)
  f.db.prepare('UPDATE import_runs SET stage=?,purpose=? WHERE id=?').run(stage, purpose, runId)
  const execution = ImportRunRepository.startOrResume(runId, 'length-test-owner').execution
  const slot = stage === 'blueprints' ? blueprintSlot(runId, f.chapters) : { runId, stage, batchId: 'done' }
  const handle = openSlot(f, slot, execution)
  const repository = new GenerationRunRepository(() => f.db)
  const context = { database: f.db, canonicalRoot: f.root, projectId: handle.projectId }
  const request = { runId, stage: slot.stage, batchId: slot.batchId, ...blueprintEffect(runId, f.chapters)(handle) }
  const execute = (ordinal: number) => f.owner.executeImportGeneration({ handle, execution, ordinal,
    task: stage === 'style' ? { ...task, purpose: 'import-style', output: 'visible-text' } : task })
  return { ...f, execution, slot, handle, repository, context, request, execute }
}

function attemptRow(f: ReturnType<typeof fixture>, ordinal: number) {
  return f.db.prepare('SELECT * FROM generation_attempts WHERE run_id=? AND invocation_nonce=?').get(f.handle.runId, `import:${ordinal}`)
}

function receipt(f: ReturnType<typeof fixture>, ordinal: number) {
  const id = f.db.prepare('SELECT attempt_id FROM generation_attempts WHERE run_id=? AND invocation_nonce=?').pluck().get(f.handle.runId, `import:${ordinal}`) as string
  return f.repository.receipt(id)
}

function assertNoBlueprintCommit(f: ReturnType<typeof fixture>) {
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprints').pluck().get()).toBe(0)
  expect(f.db.prepare("SELECT COUNT(*) FROM import_run_receipts WHERE run_id=? AND state='committed'").pluck().get(runId)).toBe(0)
}

describe('reference blueprint length is a closed remote result, not usable output', () => {
  it.each([
    { label: 'billing-unknown null usage', usage: null, status: 'unknown' },
    { label: 'trusted settled usage', usage: trustedUsage, status: 'settled' },
  ] as const)('continues the original ordinal/root after $label and commits only after STOP', async ({ usage, status }) => {
    let calls = 0
    let completeText = ''
    const f = fixture(async (_request, options) => {
      const first = ++calls === 1
      options.onVisible({ kind: 'delta', text: first ? '{"truncated":' : completeText })
      return { finishReason: first ? 'length' : 'stop', usage }
    })
    completeText = JSON.stringify({ blueprints: f.request.payload.blueprints })
    const initial = await f.execute(0)
    expect(initial.outcome).toMatchObject({ status: 'incomplete', finishReason: 'length' })
    const truncated = receipt(f, 0)
    expect(truncated).toMatchObject({ attempt: { status }, result: { finishReason: 'length' } })
    expect(truncated.failureCode).toBeUndefined()
    const original = attemptRow(f, 0)
    expect(() => f.owner.assertImportGenerationSources(f.handle, f.slot)).toThrow('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    expect(() => ImportRunRepository.prepareEffectReceipt(f.request, f.execution, Date.now(), f.owner.assertImportGenerationSources, f.context))
      .toThrow('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    assertNoBlueprintCommit(f)

    // Explicit replay retains the incomplete receipt instead of sending again.
    expect((await f.execute(0)).outcome).toMatchObject({ status: 'incomplete', finishReason: 'length' })
    expect(f.spy).toHaveBeenCalledTimes(1)
    const completed = await f.execute(1)
    expect(completed.outcome).toMatchObject({ status: 'completed', finishReason: 'stop' })
    expect(completed.outcome.content).toBe(completeText)
    expect(completed.run.handle).toEqual(f.handle)
    expect(attemptRow(f, 0)).toEqual(original)
    expect(f.spy).toHaveBeenCalledTimes(2)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(1)
    expect(f.repository.budget(f.handle.rootActionId).attempts).toHaveLength(2)
    expect(receipt(f, 1).run.rootActionId).toBe(truncated.run.rootActionId)

    const prepared = ImportRunRepository.prepareEffectReceipt(f.request, f.execution, Date.now(), f.owner.assertImportGenerationSources, f.context)
    expect(prepared.state).toBe('prepared')
    const committed = ImportRunRepository.commitEffectReceipt(runId, 'blueprints', f.slot.batchId, f.execution, Date.now(), f.owner.assertImportGenerationSources, f.context)
    expect(committed.receipt.state).toBe('committed')
    expect(f.db.prepare('SELECT chapter_number FROM blueprints').pluck().all()).toEqual([1])
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', f.slot.batchId, f.context)?.state).toBe('committed')
    expect(attemptRow(f, 0)).toEqual(original)
  })

  it('cannot commit length-only output through either prepare or an already prepared effect', async () => {
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: '{"truncated":' })
      return { finishReason: 'length', usage: null }
    })
    await f.execute(0)
    expect(() => ImportRunRepository.prepareEffectReceipt(f.request, f.execution, Date.now(), f.owner.assertImportGenerationSources, f.context))
      .toThrow('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    ImportRunRepository.prepareEffectReceipt(f.request, f.execution, Date.now(), undefined, f.context)
    expect(() => ImportRunRepository.commitEffectReceipt(runId, 'blueprints', f.slot.batchId, f.execution, Date.now(), f.owner.assertImportGenerationSources, f.context))
      .toThrow('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', f.slot.batchId, f.context)?.state).toBe('prepared')
    expect(f.spy).toHaveBeenCalledTimes(1)
    assertNoBlueprintCommit(f)
  })
})

type InvalidReceipt = { label: string; status?: PhysicalAttempt['status']; finishReason?: string | null; failureCode?: string; missingResult?: boolean }
const invalidReceipts: InvalidReceipt[] = [
  { label: 'reserved with a result', status: 'reserved' },
  { label: 'dispatch-marked with a result', status: 'dispatch-marked' },
  { label: 'cancelled-before-dispatch with a result', status: 'cancelled-before-dispatch' },
  { label: 'missing result', missingResult: true },
  { label: 'unknown finish', finishReason: 'unknown' },
  { label: 'unrecognized finish', finishReason: 'unrecognized-terminal' },
  { label: 'missing finish', finishReason: null },
  { label: 'cancelled finish', finishReason: 'cancelled' },
  { label: 'content-filter finish', finishReason: 'content_filter' },
  { label: 'error finish', finishReason: 'error' },
  { label: 'length with provider failure', failureCode: 'GENERATION_PROVIDER_FAILED' },
  { label: 'length with storage failure', failureCode: 'GENERATION_STORAGE_FAILED' },
]

describe('length exception retains receipt and effect barriers', () => {
  it.each(invalidReceipts)('rejects $label even when another STOP artifact is usable', async invalid => {
    let calls = 0
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: '{"fictional":"visible"}' })
      return { finishReason: ++calls === 1 ? 'stop' : 'length', usage: null }
    })
    expect((await f.execute(0)).outcome.status).toBe('completed')
    expect((await f.execute(1)).outcome.finishReason).toBe('length')
    const closed = receipt(f, 1)
    const row = f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(closed.attempt.attemptId) as { attempt_json: string; usage_receipt_json: string }
    const attempt = JSON.parse(row.attempt_json) as PhysicalAttempt
    const usage = JSON.parse(row.usage_receipt_json) as Record<string, unknown> & { result?: Record<string, unknown> | null }
    // Model persisted boundary states without replacing real request/task/artifact identity.
    if (invalid.status) attempt.status = invalid.status
    if (invalid.missingResult) delete usage.result
    else usage.result = { ...usage.result, finishReason: invalid.finishReason === undefined ? 'length' : invalid.finishReason,
      ...(invalid.failureCode ? { failureCode: invalid.failureCode } : {}) }
    f.db.prepare('UPDATE generation_attempts SET attempt_json=?,usage_receipt_json=? WHERE attempt_id=?')
      .run(JSON.stringify(attempt), JSON.stringify(usage), closed.attempt.attemptId)
    const persisted = attemptRow(f, 1)
    await expect(f.execute(2)).rejects.toThrow('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
    expect(f.spy).toHaveBeenCalledTimes(2)
    expect(f.repository.budget(f.handle.rootActionId).attempts).toHaveLength(2)
    expect(attemptRow(f, 1)).toEqual(persisted)
    expect(() => ImportRunRepository.prepareEffectReceipt(f.request, f.execution, Date.now(), f.owner.assertImportGenerationSources, f.context))
      .toThrow('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    ImportRunRepository.prepareEffectReceipt(f.request, f.execution, Date.now(), undefined, f.context)
    expect(() => ImportRunRepository.commitEffectReceipt(runId, 'blueprints', f.slot.batchId, f.execution, Date.now(), f.owner.assertImportGenerationSources, f.context))
      .toThrow('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', f.slot.batchId, f.context)?.state).toBe('prepared')
    assertNoBlueprintCommit(f)
  })

  it.each([
    { stage: 'global', purpose: 'reference' },
    { stage: 'style', purpose: 'reference' },
    { stage: 'blueprints', purpose: 'author-manuscript' },
  ] as const)('does not extend length continuation to $purpose/$stage', async ({ stage, purpose }) => {
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: '{"truncated":' })
      return { finishReason: 'length', usage: null }
    }, stage, purpose)
    expect((await f.execute(0)).outcome.finishReason).toBe('length')
    await expect(f.execute(1)).rejects.toThrow('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
    expect(() => f.owner.assertImportGenerationSources(f.handle, f.slot)).toThrow('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    expect(f.spy).toHaveBeenCalledTimes(1)
    expect(f.repository.budget(f.handle.rootActionId).attempts).toHaveLength(1)
    assertNoBlueprintCommit(f)
  })
})

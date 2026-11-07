import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { generationOutputContract } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { PrepareRuntimeFeedbackRequest, RuntimeFeedbackReference } from '../../../src/shared/runtime-feedback-contract'
import { getCurrentProjectPath, getProjectDb } from '../../database'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { PlanningFeedbackRepository } from '../../repositories/planning-feedback-repository'
import { RuntimeFeedbackGrantRepository } from '../../repositories/runtime-feedback-grant-repository'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { createMainGenerationOwner } from '../main-generation-owner'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import type { ProjectRuntime } from '../project-runtime'
import { RuntimeFeedbackAuthority, readRuntimeFeedbackReceipt, type RuntimeFeedbackAuthorityOptions } from '../runtime-feedback-authority'

vi.mock('../../database', async original => ({ ...await original<typeof import('../../database')>(),
  getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
})

const usage = { promptTokens: 50, completionTokens: 20, totalTokens: 70, reasoningTokens: 0,
  accounting: 'included-in-completion' as const, totalIncludesReasoning: true, trusted: true }
const providerResult = () => ({ finishReason: 'stop', usage })

class Subject extends EventEmitter {
  private destroyed = false
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function fixture(provider?: GenerationRunServiceDependencies['dispatch']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-runtime-feedback-authority-'))
  prepareCanonicalStorageFixture(root)
  const storage = path.join(root, '.ai-novel'), db = new Database(path.join(storage, 'project.db'))
  db.pragma('foreign_keys=ON')
  const projectId = JSON.parse(fs.readFileSync(path.join(storage, 'project.json'), 'utf8')).projectId as string
  db.exec("INSERT INTO project_core(id,project_name,core_outline,world_setting) VALUES('main','Fictional authority book','F0 outline','F0 world')")
  const skillPath = path.join(storage, 'skills', 'fiction', 'SKILL.md')
  fs.mkdirSync(path.dirname(skillPath), { recursive: true })
  fs.writeFileSync(skillPath, '---\nname: fiction\nlanguage: bilingual\nstage: planning\n---\nPreserve the author facts.')
  fs.writeFileSync(path.join(storage, 'writing-skills.json'), JSON.stringify({ version: 1, bindings: { planning: 'project:fiction' } }))
  vi.mocked(getProjectDb).mockReturnValue(db)
  vi.mocked(getCurrentProjectPath).mockReturnValue(root)
  const runtime: ProjectRuntime = Object.freeze({ canonicalRoot: root, projectPath: root, projectStorageRoot: storage,
    projectId, database: db, databaseIdentity: Object.freeze({}), executionEpoch: randomUUID(), phase: 'open' })
  let open = true, resourcesCurrent = true, maintenance = false
  const assertCapturedResources = vi.fn(() => {
    if (!resourcesCurrent || !db.open || runtime.database !== db) throw new Error('FICTIONAL_RUNTIME_RESOURCES_STALE')
  })
  const assertOpen = vi.fn(() => { if (!open) throw new Error('FICTIONAL_RUNTIME_NOT_OPEN') })
  const assertAdmission = vi.fn(() => {
    assertOpen()
    if (maintenance) throw new Error('FICTIONAL_RUNTIME_MAINTENANCE')
  })
  const model: ModelProfile = { id: 'model', name: 'Synthetic authority model', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
    apiKey: 'synthetic-only', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
    capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: false, usage: true } }
  const loadModel = vi.fn((id: string) => id === model.id ? model : null)
  const leaseIds: string[] = []
  const leases = new ModelExecutionLeaseRegistry({ loadModel, createLeaseId: () => {
    const id = randomUUID(); leaseIds.push(id); return id
  } })
  const leaseBegin = vi.spyOn(leases, 'begin'), leaseClose = vi.spyOn(leases, 'close')
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(provider ?? (async (_request, options) => {
    options.onVisible({ kind: 'delta', text: 'Fictional candidate' })
    return providerResult()
  }))
  const owners: ReturnType<typeof createMainGenerationOwner>[] = [], authorities: RuntimeFeedbackAuthority[] = []
  const hooks: Parameters<RuntimeFeedbackAuthorityOptions['createOwner']>[0][] = []
  const createOwner = vi.fn<RuntimeFeedbackAuthorityOptions['createOwner']>(authorityHooks => {
    hooks.push(authorityHooks)
    const sourceDeps = { db, projectStorageRoot: storage, globalDataRoot: root,
      readBuiltinPrompt: () => { throw new Error('UNEXPECTED_BUILTIN_PROMPT') } }
    const owner = createMainGenerationOwner({ database: db, projectId, projectPath: root, epoch: runtime.executionEpoch,
      mode: 'runtime-feedback', recoverInterrupted: false, ...authorityHooks,
      assertCurrent: () => { assertOpen(); assertCapturedResources() }, assertRetirementResources: assertCapturedResources,
      leases, loadModel, dispatch,
      buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(sourceDeps,
        { ...selection, projectId, epoch: runtime.executionEpoch, modelReceipt, policy,
          outputContract: generationOutputContract(selection) }).binding,
      rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDeps, previous, runtime.executionEpoch,
        modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
    owners.push(owner)
    return owner
  })
  const makeAuthority = () => {
    const authority = new RuntimeFeedbackAuthority({ runtime, assertOpen, assertAdmission, assertCapturedResources, createOwner })
    authorities.push(authority)
    return authority
  }
  const authority = makeAuthority(), subject = new Subject()
  const planning = new PlanningFeedbackRepository(db, { projectId, assertCurrent: assertCapturedResources,
    isFrozen: () => false, assertGenerationCurrent: () => { throw new Error('UNEXPECTED_DIRECT_STAGE') } })
  const base = planning.captureBase('coreOutline')
  const request = (patch: Partial<PrepareRuntimeFeedbackRequest> = {}): PrepareRuntimeFeedbackRequest => ({ operationId: randomUUID(),
    input: { baseId: base.baseId, feedback: 'Preserve the facts', constraints: ['Keep the original title'] }, modelId: model.id, ...patch })
  const prepare = (input = request(), caller = subject) => {
    const result = authority.prepare(caller, input, () => {})
    if (!result.reference) throw new Error('EXPECTED_FRESH_RUNTIME_REFERENCE')
    return { ...result, reference: result.reference, request: input }
  }
  disposers.push(() => {
    for (const item of authorities) { try { item.suspendForProjectClose() } catch { /* A fault-injected tail can intentionally refuse close. */ } }
    for (const item of owners) { try { item.suspendForProjectClose() } catch { /* Already closed or deliberately fenced by retained tail. */ } }
    for (const id of leaseIds) leases.close(id)
    if (db.open) db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, db, runtime, projectId, model, authority, subject, request, prepare, leases, leaseIds, leaseBegin, leaseClose,
    loadModel, dispatch, createOwner, makeAuthority, assertOpen, assertAdmission, assertCapturedResources,
    get owner() { return owners.at(-1)! }, get hooks() { return hooks.at(-1)! },
    setOpen(value: boolean) { open = value }, setResourcesCurrent(value: boolean) { resourcesCurrent = value },
    setMaintenance(value: boolean) { maintenance = value } }
}

const receiptRef = (reference: RuntimeFeedbackReference) => ({ projectId: reference.projectId, grantId: reference.grantId })
const grantCount = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT COUNT(*) FROM runtime_feedback_grants').pluck().get()
const candidateCount = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT COUNT(*) FROM planning_feedback_candidates').pluck().get()

describe('runtime feedback authority publication and ownership', () => {
  it('publishes no execution capability or caller subscription until the real native COMMIT has returned', async () => {
    const f = fixture(), request = f.request()
    let beforeCommit: RuntimeFeedbackReference | undefined, capturedRunId = ''
    const freshView = vi.fn(() => {
      if (!f.db.inTransaction) return
      const row = f.db.prepare('SELECT grant_id,run_id FROM runtime_feedback_grants WHERE operation_key=?').get(request.operationId) as
        { grant_id: string; run_id: string }
      const reference: RuntimeFeedbackReference = { projectId: f.projectId, grantId: row.grant_id, revision: 1 }
      beforeCommit = reference
      capturedRunId = row.run_id
      expect(() => f.authority.readReceipt(f.subject, receiptRef(reference))).toThrow('RUNTIME_FEEDBACK_CAPABILITY_REQUIRED')
      expect(() => f.hooks.runtimeFeedback.assertActive(capturedRunId)).toThrow('RUNTIME_FEEDBACK_CAPABILITY_REQUIRED')
      expect(f.subject.listenerCount('destroyed')).toBe(0)
    })
    const prepared = f.authority.prepare(f.subject, request, freshView)
    expect(freshView).toHaveBeenCalledTimes(2)
    expect(prepared.reference).toEqual(beforeCommit)
    expect(f.db.inTransaction).toBe(false)
    expect(f.subject.listenerCount('destroyed')).toBe(1)
    f.hooks.runtimeFeedback.assertActive(capturedRunId)
    expect(() => f.authority.assertRetirable()).toThrow('RUNTIME_FEEDBACK_OWNER_BUSY')
    const result = await f.authority.execute(f.subject, prepared.reference!)
    expect(result.grant.state).toBe('completed')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    f.authority.assertRetirable()
  })

  it.each(['issue', 'commit'] as const)('a %s failure publishes no usable capability and releases only its failed preparation lease', failure => {
    const f = fixture(), live = f.prepare(), liveLease = f.leaseIds[0], begin = vi.spyOn(f.owner, 'beginRuntimeFieldFeedback')
    const rollback = vi.spyOn(f.owner, 'rollbackRuntimeFieldFeedbackPreparation'), request = f.request()
    let failedGrantId = ''
    if (failure === 'issue') {
      vi.spyOn(RuntimeFeedbackGrantRepository.prototype, 'issue').mockImplementationOnce(value => {
        failedGrantId = value.grantId
        throw new Error('FICTIONAL_ISSUE_FAILED')
      })
    } else {
      f.db.exec('CREATE TABLE fictional_commit_guard(run_id TEXT REFERENCES generation_runs(run_id) DEFERRABLE INITIALLY DEFERRED)')
    }
    expect(() => f.authority.prepare(f.subject, request, () => {
      if (failure !== 'commit' || !f.db.inTransaction) return
      failedGrantId = f.db.prepare('SELECT grant_id FROM runtime_feedback_grants WHERE operation_key=?').pluck().get(request.operationId) as string
      f.db.prepare('INSERT INTO fictional_commit_guard(run_id) VALUES(?)').run(randomUUID())
    })).toThrow(failure === 'issue' ? 'FICTIONAL_ISSUE_FAILED' : 'FOREIGN KEY constraint failed')
    const failedHandle = begin.mock.results[0]!.value!.handle
    expect(f.db.inTransaction).toBe(false)
    expect(grantCount(f)).toBe(1)
    expect(f.db.prepare('SELECT 1 FROM generation_runs WHERE run_id=?').get(failedHandle.runId)).toBeUndefined()
    expect(f.db.prepare('SELECT 1 FROM runtime_feedback_grants WHERE grant_id=?').get(failedGrantId)).toBeUndefined()
    expect(() => new GenerationRunRepository(() => f.db).get(failedHandle.runId)).toThrow('GENERATION_RUN_MISSING')
    expect(() => f.hooks.runtimeFeedback.assertActive(failedHandle.runId)).toThrow('RUNTIME_FEEDBACK_CAPABILITY_REQUIRED')
    expect(() => f.authority.readReceipt(f.subject, { projectId: f.projectId, grantId: failedGrantId })).toThrow('RUNTIME_FEEDBACK_CAPABILITY_REQUIRED')
    expect(rollback).toHaveBeenCalledExactlyOnceWith(failedHandle)
    expect(f.leaseClose).toHaveBeenCalledExactlyOnceWith(f.leaseIds[1])
    expect(() => f.leases.resolve(f.leaseIds[1]!)).toThrow('MODEL_EXECUTION_LEASE_INVALID')
    expect(f.leases.resolve(liveLease!).id).toBe(f.model.id)
    f.hooks.runtimeFeedback.assertActive(live.receipt.grant.runId)
    expect(f.authority.readReceipt(f.subject, receiptRef(live.reference)).grant.state).toBe('active')
    expect(f.subject.listenerCount('destroyed')).toBe(1)
    expect(f.dispatch).not.toHaveBeenCalled()
    if (failure === 'commit') expect(f.db.prepare('SELECT COUNT(*) FROM fictional_commit_guard').pluck().get()).toBe(0)
  })

  it('replays a lost prepare response only for its original sender without resigning or loading current model configuration', async () => {
    const f = fixture(), request = f.request(), original = f.prepare(request), other = new Subject()
    const begin = vi.spyOn(f.owner, 'beginRuntimeFieldFeedback')
    f.loadModel.mockClear()
    f.leaseBegin.mockClear()
    f.model.modelName = 'changed-current-configuration'
    const replay = f.authority.prepare(f.subject, { ...request, input: { ...request.input, parentCandidateId: null } }, () => {})
    expect(replay.reference).toEqual(original.reference)
    expect(replay.receipt).toEqual(original.receipt)
    expect(f.authority.prepare(other, request, () => {})).toMatchObject({ reference: null, receipt: original.receipt })
    expect(() => f.authority.prepare(f.subject, { ...request, input: { ...request.input, feedback: 'Different feedback' } }, () => {}))
      .toThrow('RUNTIME_FEEDBACK_IDEMPOTENCY_CONFLICT')
    expect(() => f.authority.prepare(f.subject, { ...request, modelId: 'different-model' }, () => {})).toThrow('RUNTIME_FEEDBACK_IDEMPOTENCY_CONFLICT')
    await expect(f.authority.execute(other, original.reference)).rejects.toThrow('RUNTIME_FEEDBACK_CAPABILITY_REQUIRED')
    expect(() => f.authority.readReceipt(other, receiptRef(original.reference))).toThrow('RUNTIME_FEEDBACK_CAPABILITY_REQUIRED')
    expect(begin).not.toHaveBeenCalled()
    expect(f.loadModel).not.toHaveBeenCalled()
    expect(f.leaseBegin).not.toHaveBeenCalled()
    expect(grantCount(f)).toBe(1)
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('sender destruction revokes and cancels only its active grants once while preserving completed and other-sender facts', async () => {
    const f = fixture(), completed = f.prepare(), cancel = vi.spyOn(f.owner, 'cancelRuntimeFieldFeedback')
    const candidate = await f.authority.execute(f.subject, completed.reference)
    const active = f.prepare(), other = new Subject(), otherGrant = f.prepare(f.request(), other)
    expect(f.subject.listenerCount('destroyed')).toBe(1)
    expect(() => f.authority.assertRetirable()).toThrow('RUNTIME_FEEDBACK_OWNER_BUSY')
    f.subject.destroy()
    f.subject.destroy()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0]![0].runId).toBe(active.receipt.grant.runId)
    const history = (id: string) => readRuntimeFeedbackReceipt(f.runtime, id, f.assertCapturedResources)
    expect(history(active.reference.grantId).grant).toMatchObject({ state: 'revoked', revision: 2 })
    expect(history(completed.reference.grantId)).toEqual(candidate)
    expect(history(otherGrant.reference.grantId).grant.state).toBe('active')
    expect(candidateCount(f)).toBe(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.authority.revoke(other, otherGrant.reference).grant.state).toBe('revoked')
    expect(f.authority.revoke(other, otherGrant.reference).grant.state).toBe('revoked')
    expect(cancel).toHaveBeenCalledTimes(2)
    f.authority.assertRetirable()
  })

  it('revocation before dispatch wins with zero physical requests or candidate effects and does not renew authority on replay', async () => {
    const f = fixture(), prepared = f.prepare(), cancel = vi.spyOn(f.owner, 'cancelRuntimeFieldFeedback')
    const revoked = f.authority.revoke(f.subject, prepared.reference)
    expect(revoked.grant).toMatchObject({ state: 'revoked', revision: 2, candidateId: null })
    expect(await f.authority.execute(f.subject, prepared.reference)).toEqual(revoked)
    expect(f.authority.prepare(f.subject, prepared.request, () => {}).receipt).toEqual(revoked)
    expect(f.authority.revoke(f.subject, prepared.reference)).toEqual(revoked)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(new GenerationRunRepository(() => f.db).attemptCount(prepared.receipt.grant.runId)).toBe(0)
    expect(candidateCount(f)).toBe(0)
    f.authority.assertRetirable()
  })

  it('rejects maintenance at prepare admission and before native COMMIT without publishing a grant or capability', () => {
    const f = fixture(), request = f.request(), begin = vi.spyOn(f.owner, 'beginRuntimeFieldFeedback')
    f.setMaintenance(true)
    expect(() => f.authority.prepare(f.subject, request, () => {})).toThrow('FICTIONAL_RUNTIME_MAINTENANCE')
    expect(begin).not.toHaveBeenCalled()
    expect(f.leaseBegin).not.toHaveBeenCalled()
    f.setMaintenance(false)
    let grantId = ''
    expect(() => f.authority.prepare(f.subject, request, () => {
      if (!f.db.inTransaction) return
      grantId = f.db.prepare('SELECT grant_id FROM runtime_feedback_grants WHERE operation_key=?').pluck().get(request.operationId) as string
      f.setMaintenance(true)
    })).toThrow('FICTIONAL_RUNTIME_MAINTENANCE')
    expect(grantId).not.toBe('')
    expect(f.authority.hasIssuance(grantId)).toBe(false)
    expect(grantCount(f)).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
    expect(f.subject.listenerCount('destroyed')).toBe(0)
    expect(f.leaseClose).toHaveBeenCalledExactlyOnceWith(f.leaseIds[0])
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('blocks a newly issued grant during maintenance with zero attempts while still allowing receipt reads and revoke', async () => {
    const f = fixture(), prepared = f.prepare(), cancel = vi.spyOn(f.owner, 'cancelRuntimeFieldFeedback')
    f.setMaintenance(true)
    await expect(f.authority.execute(f.subject, prepared.reference)).rejects.toThrow('FICTIONAL_RUNTIME_MAINTENANCE')
    expect(new GenerationRunRepository(() => f.db).attemptCount(prepared.receipt.grant.runId)).toBe(0)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(candidateCount(f)).toBe(0)
    expect(f.authority.readReceipt(f.subject, receiptRef(prepared.reference))).toEqual(prepared.receipt)
    const revoked = f.authority.revoke(f.subject, prepared.reference)
    expect(revoked.grant).toMatchObject({ state: 'revoked', revision: 2, candidateId: null })
    expect(f.authority.readReceipt(f.subject, receiptRef(prepared.reference))).toEqual(revoked)
    expect(cancel).toHaveBeenCalledTimes(1)
    f.authority.assertRetirable()
  })

  it('preserves a settled response but admits no candidate when maintenance starts before the provider returns', async () => {
    const started = deferred<void>(), response = deferred<ReturnType<typeof providerResult>>()
    const f = fixture((_request, options) => {
      options.onVisible({ kind: 'delta', text: 'Settled but not admitted candidate' })
      started.resolve()
      return response.promise
    })
    const prepared = f.prepare(), stage = vi.spyOn(f.owner, 'stageRuntimeFieldFeedback')
    const cancel = vi.spyOn(f.owner, 'cancelRuntimeFieldFeedback')
    const operation = f.authority.execute(f.subject, prepared.reference)
    const rejected = expect(operation).rejects.toThrow('FICTIONAL_RUNTIME_MAINTENANCE')
    try {
      await started.promise
      f.setMaintenance(true)
      response.resolve(providerResult())
      await rejected
      const receipt = f.authority.readReceipt(f.subject, receiptRef(prepared.reference))
      expect(receipt.grant).toMatchObject({ state: 'revoked', revision: 2, candidateId: null })
      expect(receipt.attempts).toHaveLength(1)
      expect(receipt.attempts[0]).toMatchObject({ status: 'settled', artifactId: expect.any(String) })
      const stored = f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE run_id=?')
        .get(prepared.receipt.grant.runId) as { attempt_json: string; usage_receipt_json: string }
      expect(JSON.parse(stored.attempt_json)).toMatchObject({ status: 'settled', actualTokens: usage.totalTokens })
      expect(JSON.parse(stored.usage_receipt_json).result).toMatchObject({ finishReason: 'stop', usage: { trusted: true } })
      expect(stage).not.toHaveBeenCalled()
      expect(candidateCount(f)).toBe(0)
      expect(f.dispatch).toHaveBeenCalledTimes(1)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(f.authority.revoke(f.subject, prepared.reference)).toEqual(receipt)
      expect(cancel).toHaveBeenCalledTimes(1)
      f.authority.assertRetirable()
    } finally { response.resolve(providerResult()); await operation.catch(() => {}) }
  })

  it('revocation after a completed physical response but before candidate admission wins without staging', async () => {
    const f = fixture(), prepared = f.prepare(), execute = f.owner.executeRuntimeFieldFeedback
    const stage = vi.spyOn(f.owner, 'stageRuntimeFieldFeedback'), cancel = vi.spyOn(f.owner, 'cancelRuntimeFieldFeedback')
    vi.spyOn(f.owner, 'executeRuntimeFieldFeedback').mockImplementation(async handle => {
      const result = await execute(handle)
      f.authority.revoke(f.subject, prepared.reference)
      return result
    })
    const result = await f.authority.execute(f.subject, prepared.reference)
    expect(result.grant).toMatchObject({ state: 'revoked', revision: 2, candidateId: null })
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]!.status).toBe('settled')
    expect(stage).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(candidateCount(f)).toBe(0)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it('a committed candidate wins over later revoke, duplicate execute and sender destruction', async () => {
    const f = fixture(), prepared = f.prepare(), stage = vi.spyOn(f.owner, 'stageRuntimeFieldFeedback')
    const cancel = vi.spyOn(f.owner, 'cancelRuntimeFieldFeedback'), first = await f.authority.execute(f.subject, prepared.reference)
    expect(first.grant).toMatchObject({ state: 'completed', revision: 1, candidateId: first.candidate!.candidateId })
    expect(f.authority.revoke(f.subject, prepared.reference)).toEqual(first)
    expect(await f.authority.execute(f.subject, prepared.reference)).toEqual(first)
    f.subject.destroy()
    expect(readRuntimeFeedbackReceipt(f.runtime, first.grant.grantId, f.assertCapturedResources)).toEqual(first)
    expect(stage).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(candidateCount(f)).toBe(1)
    expect(f.db.prepare("SELECT core_outline,world_setting FROM project_core WHERE id='main'").get())
      .toEqual({ core_outline: 'F0 outline', world_setting: 'F0 world' })
    f.authority.assertRetirable()
  })

  it('reads history without an owner or model and does not reconstruct a new issuance after idle handoff', async () => {
    const f = fixture(), prepared = f.prepare(), completed = await f.authority.execute(f.subject, prepared.reference)
    f.authority.retireIdle()
    f.createOwner.mockClear()
    f.loadModel.mockClear()
    f.leaseBegin.mockClear()
    expect(readRuntimeFeedbackReceipt(f.runtime, prepared.reference.grantId, f.assertCapturedResources)).toEqual(completed)
    expect(f.authority.readReceipt(f.subject, receiptRef(prepared.reference))).toEqual(completed)
    expect(await f.authority.execute(f.subject, prepared.reference)).toEqual(completed)
    expect(() => f.authority.prepare(f.subject, prepared.request, () => {})).toThrow('RUNTIME_FEEDBACK_OWNER_RETIRED')
    expect(f.createOwner).not.toHaveBeenCalled()
    expect(f.loadModel).not.toHaveBeenCalled()
    expect(f.leaseBegin).not.toHaveBeenCalled()
    const next = f.makeAuthority(), begin = vi.spyOn(f.owner, 'beginRuntimeFieldFeedback')
    f.createOwner.mockClear()
    expect(next.prepare(f.subject, prepared.request, () => {})).toEqual({ reference: null, receipt: completed })
    expect(() => next.prepare(f.subject, { ...prepared.request, modelId: 'different-model' }, () => {}))
      .toThrow('RUNTIME_FEEDBACK_IDEMPOTENCY_CONFLICT')
    expect(next.hasIssuance(prepared.reference.grantId)).toBe(false)
    await expect(next.execute(f.subject, prepared.reference)).rejects.toThrow('RUNTIME_FEEDBACK_CAPABILITY_REQUIRED')
    expect(() => next.readReceipt(f.subject, receiptRef(prepared.reference))).toThrow('RUNTIME_FEEDBACK_CAPABILITY_REQUIRED')
    expect(begin).not.toHaveBeenCalled()
    expect(f.createOwner).not.toHaveBeenCalled()
    expect(f.loadModel).not.toHaveBeenCalled()
    expect(f.leaseBegin).not.toHaveBeenCalled()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it('keeps retirement blocked until an abort-ignoring physical request actually settles', async () => {
    const started = deferred<void>(), response = deferred<ReturnType<typeof providerResult>>()
    const f = fixture((_request, options) => {
      options.onVisible({ kind: 'delta', text: 'Retained partial candidate' })
      started.resolve()
      return response.promise
    })
    const prepared = f.prepare(), operation = f.authority.execute(f.subject, prepared.reference)
    try {
      await started.promise
      expect(f.authority.hasPhysicalInFlight()).toBe(true)
      expect(() => f.authority.assertRetirable()).toThrow('GENERATION_OWNER_BUSY')
      f.authority.revoke(f.subject, prepared.reference)
      const revoked = await operation
      expect(revoked.grant.state).toBe('revoked')
      expect(f.authority.hasPhysicalInFlight()).toBe(true)
      expect(() => f.authority.retireIdle()).toThrow('GENERATION_OWNER_BUSY')
      expect(candidateCount(f)).toBe(0)
      response.resolve(providerResult())
      await vi.waitFor(() => expect(f.authority.hasPhysicalInFlight()).toBe(false))
      expect(readRuntimeFeedbackReceipt(f.runtime, prepared.reference.grantId, f.assertCapturedResources)).toEqual(revoked)
      expect(f.dispatch).toHaveBeenCalledTimes(1)
      f.authority.assertRetirable()
      f.authority.retireIdle()
    } finally { response.resolve(providerResult()); await operation }
  })

  it('aborts on sender destruction despite failed native revocation, retains the claim and retries only revoke during retirement', async () => {
    const started = deferred<void>(), response = deferred<ReturnType<typeof providerResult>>()
    let deferResponse = false, signal: AbortSignal | undefined
    const f = fixture((_request, options) => {
      options.onVisible({ kind: 'delta', text: deferResponse ? 'Partial abandoned candidate' : 'Completed candidate' })
      if (!deferResponse) return Promise.resolve(providerResult())
      signal = options.signal
      started.resolve()
      return response.promise
    })
    const completed = f.prepare(), completedReceipt = await f.authority.execute(f.subject, completed.reference)
    const active = f.prepare(), cancel = vi.spyOn(f.owner, 'cancelRuntimeFieldFeedback')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.db.exec(`CREATE TEMP TRIGGER fictional_revoke_block BEFORE UPDATE ON runtime_feedback_grants
      WHEN NEW.state='revoked' BEGIN SELECT RAISE(ABORT,'fictional revoke blocked'); END;`)
    deferResponse = true
    const operation = f.authority.execute(f.subject, active.reference).then(value => ({ value, error: null }), error => ({ value: null, error }))
    try {
      await started.promise
      f.subject.destroy()
      expect(signal?.aborted).toBe(true)
      expect(cancel).toHaveBeenCalledTimes(1)
      const logical = await operation
      expect(logical.error).not.toBeNull()
      expect(readRuntimeFeedbackReceipt(f.runtime, active.reference.grantId, f.assertCapturedResources).grant)
        .toMatchObject({ state: 'active', revision: 1, candidateId: null })
      expect(readRuntimeFeedbackReceipt(f.runtime, completed.reference.grantId, f.assertCapturedResources)).toEqual(completedReceipt)
      expect(f.authority.hasPhysicalInFlight()).toBe(true)
      response.resolve(providerResult())
      await vi.waitFor(() => expect(f.authority.hasPhysicalInFlight()).toBe(false))
      expect(() => f.authority.assertRetirable()).toThrow('RUNTIME_FEEDBACK_OWNER_BUSY')
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(readRuntimeFeedbackReceipt(f.runtime, active.reference.grantId, f.assertCapturedResources).grant.state).toBe('active')
      expect(() => f.authority.prepareRetirement()).toThrow('fictional revoke blocked')
      expect(() => f.authority.retireIdle()).toThrow('fictional revoke blocked')
      expect(cancel).toHaveBeenCalledTimes(1)
      f.db.exec('DROP TRIGGER fictional_revoke_block')
      f.authority.retireIdle()
      expect(readRuntimeFeedbackReceipt(f.runtime, active.reference.grantId, f.assertCapturedResources).grant)
        .toMatchObject({ state: 'revoked', revision: 2, candidateId: null })
      expect(readRuntimeFeedbackReceipt(f.runtime, completed.reference.grantId, f.assertCapturedResources)).toEqual(completedReceipt)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(f.dispatch).toHaveBeenCalledTimes(2)
      expect(candidateCount(f)).toBe(1)
    } finally {
      response.resolve(providerResult())
      await operation
      f.db.exec('DROP TRIGGER IF EXISTS fictional_revoke_block')
    }
  })

  it('does not retire a claim-free owner while its real service retains an unsaved artifact tail', async () => {
    const f = fixture(), prepared = f.prepare()
    const snapshot = vi.spyOn(GenerationRunRepository.prototype, 'snapshot').mockImplementation(() => { throw new Error('fictional disk full') })
    const result = await f.authority.execute(f.subject, prepared.reference)
    snapshot.mockRestore()
    expect(result.grant.state).toBe('revoked')
    expect(candidateCount(f)).toBe(0)
    expect(f.authority.hasPhysicalInFlight()).toBe(false)
    expect(() => f.authority.assertRetirable()).toThrow('GENERATION_UNSAVED_TAIL_PRESENT')
    expect(() => f.authority.retireIdle()).toThrow('GENERATION_UNSAVED_TAIL_PRESENT')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=(SELECT root_action_id FROM generation_runs WHERE run_id=?)')
      .pluck().get(prepared.receipt.grant.runId)).toBe('GENERATION_STORAGE_FAILED')
  })
})

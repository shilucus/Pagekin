import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { generationOutputContract } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { getCurrentProjectPath, getProjectDb } from '../../database'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { createMainGenerationOwner } from '../main-generation-owner'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { M10_RUNTIME_FEEDBACK_GRANTS_SQL } from '../../migrations/m10-runtime-feedback-grants'
import { RuntimeFeedbackGrantRepository } from '../../repositories/runtime-feedback-grant-repository'
import { textHash } from '../../repositories/generation-run-repository'
import type { MainGenerationOwnerDependencies } from '../main-generation-owner'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'

vi.mock('../../database', async original => ({ ...await original<typeof import('../../database')>(),
  getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const disposers: Array<() => void> = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.restoreAllMocks() })

const usage = { promptTokens: 50, completionTokens: 20, totalTokens: 70, reasoningTokens: 0,
  accounting: 'included-in-completion' as const, totalIncludesReasoning: true, trusted: true }
const skill = 'Use concise planning sentences.'

function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/planning-feedback-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  prepareCanonicalStorageFixture(root)
  const storage = path.join(root, '.ai-novel'), dbPath = path.join(storage, 'project.db')
  const projectId = JSON.parse(fs.readFileSync(path.join(storage, 'project.json'), 'utf8')).projectId as string
  const skillPath = path.join(storage, 'skills', 'fiction', 'SKILL.md')
  fs.mkdirSync(path.dirname(skillPath), { recursive: true })
  const writeSkill = (content: string) => fs.writeFileSync(skillPath, `---\nname: fiction\nlanguage: bilingual\nstage: planning\n---\n${content}`)
  writeSkill(skill)
  fs.writeFileSync(path.join(storage, 'writing-skills.json'), JSON.stringify({ version: 1, bindings: { planning: 'project:fiction' } }))
  vi.mocked(getCurrentProjectPath).mockReturnValue(root)
  let db = new Database(dbPath), epoch = 1
  vi.mocked(getProjectDb).mockImplementation(() => db)
  db.prepare("INSERT INTO project_core(id,project_name,core_outline,world_setting) VALUES('main','Fiction','F0 outline','F0 world')").run()
  const model: ModelProfile = { id: 'model', name: 'Synthetic', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
    apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048,
    purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: false, usage: true } }
  let sequence = 0
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => {
    options.onVisible({ kind: 'delta', text: `Candidate ${++sequence}` })
    return { finishReason: 'stop', usage }
  }))
  const owners: ReturnType<typeof createMainGenerationOwner>[] = []
  const makeOwner = (runtimeFeedback?: MainGenerationOwnerDependencies['runtimeFeedback'], handoff?: {
    assertLease: () => void; assertResources: () => void; leases?: ModelExecutionLeaseRegistry; beforeDispatch?: () => void
  }) => {
    const ownDb = db, ownEpoch = `epoch-${epoch}`
    const sourceDeps = { db: ownDb, projectStorageRoot: storage, globalDataRoot: root,
      readBuiltinPrompt: () => { throw new Error('UNEXPECTED_BUILTIN_PROMPT') } }
    const owner = createMainGenerationOwner({ database: ownDb, projectId, projectPath: root, epoch: ownEpoch,
      ...(runtimeFeedback ? { mode: 'runtime-feedback' as const, runtimeFeedback } : {}),
      ...(handoff ? { assertRetirementResources: handoff.assertResources } : {}),
      ...(handoff?.beforeDispatch ? { beforeDispatch: handoff.beforeDispatch } : {}),
      assertCurrent: () => { if (db !== ownDb || ownEpoch !== `epoch-${epoch}`) throw new Error('GENERATION_EPOCH_STALE'); handoff?.assertLease() },
      leases: handoff?.leases ?? new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
      buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(sourceDeps,
        { ...selection, projectId, epoch: ownEpoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
      rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDeps, previous, ownEpoch,
        modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
    owners.push(owner)
    return owner
  }
  const owner = makeOwner()
  const reopen = () => {
    owners.at(-1)!.suspendForProjectClose()
    db.close()
    db = new Database(dbPath)
    epoch++
    return makeOwner()
  }
  disposers.push(() => {
    for (const item of owners) { try { item.suspendForProjectClose() } catch { /* already closed */ } }
    if (db.open) db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, model, owner, spy, reopen, makeOwner, projectId, writeSkill, get db() { return db } }
}

type Owner = ReturnType<typeof createMainGenerationOwner>
it('releases only rolled-back runtime preparation leases after issue or commit failure', () => {
  const f = fixture()
  if (!f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_feedback_grants'").get()) f.db.exec(M10_RUNTIME_FEEDBACK_GRANTS_SQL)
  f.db.pragma('foreign_keys = ON')
  f.db.exec('CREATE TABLE test_commit_guard(run_id TEXT REFERENCES generation_runs(run_id) DEFERRABLE INITIALLY DEFERRED)')
  const base = f.owner.captureFieldFeedback('coreOutline')
  const grants = new RuntimeFeedbackGrantRepository(f.db, { projectId: f.projectId, assertCurrent: () => {}, isFrozen: () => false })
  const leaseIds: string[] = []
  const leases = new ModelExecutionLeaseRegistry({ loadModel: () => f.model, createLeaseId: () => { const id = randomUUID(); leaseIds.push(id); return id } })
  const runtime = f.makeOwner({ assertActive: () => {}, assertDispatchAdmission: () => {} }, { assertLease: () => {}, assertResources: () => {}, leases })
  const input = { baseId: base.baseId, feedback: 'revise', constraints: [] }
  const begin = () => runtime.beginRuntimeFieldFeedback({ input, modelId: 'model', uiActionNonce: randomUUID() }).handle
  const live = f.db.transaction(() => {
    const handle = begin()
    grants.issue({ grantId: randomUUID(), operationKey: randomUUID(), requestHash: textHash('live'), target: 'coreOutline',
      baseId: base.baseId, parentCandidateId: null, runId: handle.runId })
    return handle
  }).immediate()
  expect(() => runtime.rollbackRuntimeFieldFeedbackPreparation(live)).toThrow('GENERATION_RUNTIME_FEEDBACK_PREPARATION_DURABLE')
  let issueFailure!: MainGenerationRunHandle
  expect(() => f.db.transaction(() => { issueFailure = begin(); throw new Error('ISSUE_FAILED') }).immediate()).toThrow('ISSUE_FAILED')
  runtime.rollbackRuntimeFieldFeedbackPreparation(issueFailure)
  expect(() => leases.resolve(leaseIds[1])).toThrow('MODEL_EXECUTION_LEASE_INVALID')
  let commitFailure!: MainGenerationRunHandle
  expect(() => f.db.transaction(() => {
    commitFailure = begin()
    f.db.prepare('INSERT INTO test_commit_guard(run_id) VALUES(?)').run(randomUUID())
  }).immediate()).toThrow()
  runtime.rollbackRuntimeFieldFeedbackPreparation(commitFailure)
  expect(() => leases.resolve(leaseIds[2])).toThrow('MODEL_EXECUTION_LEASE_INVALID')
  expect(leases.resolve(leaseIds[0]).id).toBe('model')
  expect(grants.getByRun(live.runId)?.state).toBe('active')
  expect(() => runtime.rollbackRuntimeFieldFeedbackPreparation(issueFailure)).toThrow('GENERATION_RUNTIME_FEEDBACK_PREPARATION_INVALID')
})

it('rechecks the frozen model lease after beforeDispatch and before any runtime attempt', async () => {
  const f = fixture()
  if (!f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_feedback_grants'").get()) f.db.exec(M10_RUNTIME_FEEDBACK_GRANTS_SQL)
  const base = f.owner.captureFieldFeedback('coreOutline')
  let now = 0
  const leases = new ModelExecutionLeaseRegistry({ loadModel: () => f.model, now: () => now, ttlMs: 10 })
  const runtime = f.makeOwner({ assertActive: () => {}, assertDispatchAdmission: () => {} }, {
    assertLease: () => {}, assertResources: () => {}, leases, beforeDispatch: () => { now = 10 },
  })
  const view = runtime.beginRuntimeFieldFeedback({ input: { baseId: base.baseId, feedback: 'revise', constraints: [] }, modelId: 'model', uiActionNonce: randomUUID() })
  await expect(runtime.executeRuntimeFieldFeedback(view.handle)).rejects.toThrow('MODEL_EXECUTION_LEASE_EXPIRED')
  expect(f.spy).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(view.handle.runId)).toBe(0)
  expect(f.db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(view.handle.rootActionId)).toBeNull()
})

it.each(['core', 'skill', 'model'] as const)('rechecks runtime %s after beforeDispatch in dispatch admission', async change => {
  const f = fixture()
  if (!f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_feedback_grants'").get()) f.db.exec(M10_RUNTIME_FEEDBACK_GRANTS_SQL)
  const base = f.owner.captureFieldFeedback('coreOutline')
  const runtime = f.makeOwner({ assertActive: () => {}, assertDispatchAdmission: () => {} }, {
    assertLease: () => {}, assertResources: () => {}, beforeDispatch: () => {
      if (change === 'core') f.db.exec("UPDATE project_core SET core_outline='Changed during admission' WHERE id='main'")
      else if (change === 'skill') f.writeSkill('Changed during admission')
      else f.model.modelName = 'changed-model'
    },
  })
  const view = runtime.beginRuntimeFieldFeedback({ input: { baseId: base.baseId, feedback: 'revise', constraints: [] }, modelId: 'model', uiActionNonce: randomUUID() })
  await expect(runtime.executeRuntimeFieldFeedback(view.handle)).rejects.toThrow()
  expect(f.spy).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(view.handle.runId)).toBe(0)
  expect(f.db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(view.handle.rootActionId)).toBeNull()
})

it('retires an idle owner after its UI lease expires only while its captured resources remain current', () => {
  const f = fixture()
  let leaseValid = true, resourcesValid = true
  const owner = f.makeOwner(undefined, {
    assertLease: () => { if (!leaseValid) throw new Error('UI_LEASE_STALE') },
    assertResources: () => { if (!resourcesValid) throw new Error('RUNTIME_CLOSED') },
  })
  leaseValid = false
  expect(() => owner.captureFieldFeedback('coreOutline')).toThrow('UI_LEASE_STALE')
  resourcesValid = false
  expect(() => owner.retireIdle()).toThrow('RUNTIME_CLOSED')
  resourcesValid = true
  owner.assertRetirable()
  owner.retireIdle()
  expect(() => owner.assertRetirable()).toThrow('GENERATION_OWNER_CLOSED')
})

it('keeps runtime feedback grant runs out of legacy recovery and generic access', async () => {
  let finish!: (result: { finishReason: string; usage: typeof usage }) => void
  const f = fixture((_request, options) => {
    options.onVisible({ kind: 'delta', text: 'isolated candidate' })
    return new Promise(resolve => { finish = resolve })
  })
  if (!f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_feedback_grants'").get()) f.db.exec(M10_RUNTIME_FEEDBACK_GRANTS_SQL)
  const base = f.owner.captureFieldFeedback('coreOutline')
  const grants = new RuntimeFeedbackGrantRepository(f.db, { projectId: f.projectId, assertCurrent: () => {}, isFrozen: () => false })
  let grantId = '', runId = ''
  const runtime = f.makeOwner({ assertActive: id => { if (id !== runId) throw new Error('CAPABILITY_INVALID') },
    assertDispatchAdmission: id => { grants.assertActive({ grantId, revision: 1, runId: id }) } })
  const input = { baseId: base.baseId, feedback: 'revise', constraints: [] }
  const view = runtime.beginRuntimeFieldFeedback({ input, modelId: 'model', uiActionNonce: randomUUID() })
  runId = view.handle.runId
  grantId = randomUUID()
  grants.issue({ grantId, operationKey: randomUUID(), requestHash: textHash('author input'), target: 'coreOutline',
    baseId: base.baseId, parentCandidateId: null, runId })
  expect(view.budget.maxAttempts).toBe(1)
  const operation = runtime.executeRuntimeFieldFeedback(view.handle)
  expect(() => runtime.assertRetirable()).toThrow('GENERATION_OWNER_BUSY')
  const legacy = f.makeOwner()
  expect(() => legacy.read(view.handle)).toThrow('GENERATION_RUNTIME_FEEDBACK_ACCESS_DENIED')
  expect(legacy.list().some(item => item.handle.runId === runId)).toBe(false)
  expect(JSON.parse(f.db.prepare('SELECT attempt_json FROM generation_attempts WHERE run_id=?').pluck().get(runId) as string).status).toBe('dispatch-marked')
  finish({ finishReason: 'stop', usage })
  const result = await operation
  const artifact = result.outcome.receipt.visibleArtifact!
  expect(() => legacy.stagePlanningFeedback({ ...input, runId, attemptId: artifact.attemptId, artifactId: artifact.artifactId }))
    .toThrow('GENERATION_RUNTIME_FEEDBACK_ACCESS_DENIED')
  await runtime.executeRuntimeFieldFeedback(view.handle)
  expect(f.spy).toHaveBeenCalledTimes(1)
  runtime.assertRetirable()
  runtime.retireIdle()
})

async function generate(owner: Owner, baseId: string, nonce: string, parentCandidateId?: string) {
  const input = { baseId, ...(parentCandidateId ? { parentCandidateId } : {}), feedback: 'Make it vivid', constraints: ['Keep F0'] }
  const view = owner.beginPlanningFeedback({ input, modelId: 'model', uiActionNonce: nonce })
  const executed = await owner.executePlanningFeedback(view.handle)
  const artifact = executed.outcome.receipt.visibleArtifact!
  return { input, view, executed, stage: () => owner.stagePlanningFeedback({ ...input, runId: view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId }) }
}

it('enforces dedicated admission and durable nonce identity', async () => {
  const f = fixture(), base = f.owner.capturePlanningFeedbackBase('coreOutline')
  const input = { baseId: base.baseId, feedback: 'Focus', constraints: [] }
  expect(() => f.owner.begin({ operation: 'planning-feedback', uiActionNonce: 'generic', modelId: 'model',
    selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['planning-feedback-v1'], skillStages: ['planning'], output: 'visible-text' }))
    .toThrow('GENERATION_FEEDBACK_ADMISSION_REQUIRED')
  const first = f.owner.beginPlanningFeedback({ input, modelId: 'model', uiActionNonce: 'same' })
  expect(f.owner.beginPlanningFeedback({ input, modelId: 'model', uiActionNonce: 'same' }).handle).toEqual(first.handle)
  expect(() => f.owner.beginPlanningFeedback({ input: { ...input, feedback: 'other' }, modelId: 'model', uiActionNonce: 'same' }))
    .toThrow('GENERATION_NONCE_CONFLICT')
  await expect(f.owner.execute({ handle: first.handle, invocationNonce: 'generic', task: { purpose: 'planning-feedback',
    output: 'visible-text', messages: [{ role: 'user', content: 'forged' }] } })).rejects.toThrow('GENERATION_FEEDBACK_ADMISSION_REQUIRED')
  expect(f.spy).not.toHaveBeenCalled()
})

it('freezes F0, actual parent, instructions and installed Skill through C1 to C2 and adopts once', async () => {
  const f = fixture(), base = f.owner.capturePlanningFeedbackBase('coreOutline')
  const one = await generate(f.owner, base.baseId, 'one'), c1 = one.stage()
  const two = await generate(f.owner, base.baseId, 'two', c1.candidateId), c2 = two.stage()
  const sent = (f.spy.mock.calls[1]![0] as { task: GenerationTask }).task
  expect(JSON.stringify(sent)).toContain(skill)
  const context = JSON.parse(sent.messages.find(message => message.role === 'user')!.content)
  expect(context).toMatchObject({ baseId: base.baseId, parentCandidateId: c1.candidateId,
    parentText: c1.text, feedback: 'Make it vivid', constraints: ['Keep F0'], source: { coreOutline: 'F0 outline' } })
  const row = f.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck()
    .get(two.executed.outcome.receipt.visibleArtifact!.attemptId) as string
  expect(JSON.parse(row).replayTask).toEqual(sent)
  expect(f.db.prepare("SELECT core_outline FROM project_core WHERE id='main'").pluck().get()).toBe('F0 outline')
  const request = { candidateId: c2.candidateId, idempotencyKey: 'adopt-action', decision: 'full' as const, text: c2.text }
  const receipt = f.owner.adoptPlanningFeedback(request)
  expect(f.owner.adoptPlanningFeedback(request)).toEqual(receipt)
  expect(receipt.decisionSource).toBe('author-action')
  expect(f.db.prepare("SELECT core_outline,world_setting FROM project_core WHERE id='main'").get())
    .toEqual({ core_outline: c2.text, world_setting: 'F0 world' })
})

it.each(['author-aba', 'skill', 'model'] as const)('rejects changed %s before dispatch', async change => {
  const f = fixture(), base = f.owner.capturePlanningFeedbackBase('coreOutline')
  const view = f.owner.beginPlanningFeedback({ input: { baseId: base.baseId, feedback: '', constraints: [] }, modelId: 'model', uiActionNonce: 'change' })
  if (change === 'author-aba') {
    f.db.prepare("UPDATE project_core SET core_outline='changed' WHERE id='main'").run()
    f.db.prepare("UPDATE project_core SET core_outline='F0 outline' WHERE id='main'").run()
  } else if (change === 'skill') f.writeSkill('Changed planning style.')
  else f.model.modelName = 'another-synthetic-model'
  await expect(f.owner.executePlanningFeedback(view.handle)).rejects.toThrow()
  expect(f.spy).not.toHaveBeenCalled()
})

it('ignores unrelated caches and synopsis when rebuilding the consumed source', async () => {
  const f = fixture(), base = f.owner.capturePlanningFeedbackBase('coreOutline')
  const view = f.owner.beginPlanningFeedback({ input: { baseId: base.baseId, feedback: '', constraints: [] }, modelId: 'model', uiActionNonce: 'cache' })
  f.db.prepare("UPDATE project_core SET character_states='cache',plot_tree_snapshot='cache',synopsis='derived' WHERE id='main'").run()
  expect((await f.owner.executePlanningFeedback(view.handle)).outcome.status).toBe('completed')
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('does not resend unknown outcomes after reopening', async () => {
  const f = fixture(async () => { throw new Error('synthetic uncertain transport') })
  const base = f.owner.capturePlanningFeedbackBase('coreOutline')
  const first = await generate(f.owner, base.baseId, 'unknown')
  expect(first.executed.outcome.status).toBe('incomplete')
  const next = f.reopen()
  const replay = await next.executePlanningFeedback(first.view.handle)
  expect(replay.outcome.status).toBe('incomplete')
  expect(f.spy).toHaveBeenCalledTimes(1)
  const artifact = f.db.prepare('SELECT attempt_id,artifact_id FROM generation_artifacts WHERE run_id=?').get(first.view.handle.runId) as
    { attempt_id: string; artifact_id: string }
  expect(() => next.stagePlanningFeedback({ ...first.input, runId: first.view.handle.runId,
    attemptId: artifact.attempt_id, artifactId: artifact.artifact_id })).toThrow()
})

it.each(['absent', 'untrusted'] as const)('stages complete stop with %s usage without changing unknown accounting or redispatching', async kind => {
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: 'Complete candidate' })
    return { finishReason: 'stop', usage: kind === 'absent' ? null : { ...usage, trusted: false } }
  })
  const base = f.owner.capturePlanningFeedbackBase('coreOutline')
  const first = await generate(f.owner, base.baseId, `stop-${kind}`)
  const artifact = first.executed.outcome.receipt.visibleArtifact!
  expect(first.executed.outcome.status).toBe('completed')
  const snapshot = () => f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(artifact.attemptId) as
    { attempt_json: string; usage_receipt_json: string }
  const before = snapshot()
  expect(JSON.parse(before.attempt_json).status).toBe('unknown')
  const next = f.reopen()
  const replay = await next.executePlanningFeedback(first.view.handle)
  expect(replay.outcome.status).toBe('completed')
  const candidate = next.stagePlanningFeedback({ ...first.input, runId: first.view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId })
  const adoption = next.adoptPlanningFeedback({ candidateId: candidate.candidateId, idempotencyKey: `adopt-${kind}`,
    decision: 'full', text: candidate.text })
  expect(adoption.text).toBe('Complete candidate')
  expect(snapshot()).toEqual(before)
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('keeps cancelled partial output and ledger unchanged when a provider later reports stop', async () => {
  let started!: () => void
  let finish!: (result: { finishReason: string; usage: typeof usage }) => void
  let lateVisible!: () => void
  const dispatched = new Promise<void>(resolve => { started = resolve })
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: 'Partial' })
    lateVisible = () => options.onVisible({ kind: 'delta', text: 'Late' })
    started()
    return await new Promise(resolve => { finish = resolve })
  })
  const base = f.owner.capturePlanningFeedbackBase('coreOutline')
  const input = { baseId: base.baseId, feedback: '', constraints: [] }
  const view = f.owner.beginPlanningFeedback({ input, modelId: 'model', uiActionNonce: 'late' })
  const running = f.owner.executePlanningFeedback(view.handle)
  await dispatched
  f.owner.cancel(view.handle)
  const stopped = await running
  const row = () => f.db.prepare(`SELECT a.attempt_id,a.attempt_json,a.usage_receipt_json,b.artifact_id,b.artifact_json
    FROM generation_attempts a JOIN generation_artifacts b ON b.attempt_id=a.attempt_id WHERE a.run_id=?`).get(view.handle.runId) as
    { attempt_id: string; attempt_json: string; usage_receipt_json: string; artifact_id: string; artifact_json: string }
  const before = row()
  expect(stopped.outcome.status).toBe('incomplete')
  lateVisible()
  finish({ finishReason: 'stop', usage })
  await Promise.resolve()
  await Promise.resolve()
  expect(row()).toEqual(before)
  expect(() => f.owner.stagePlanningFeedback({ ...input, runId: view.handle.runId,
    attemptId: before.attempt_id, artifactId: before.artifact_id })).toThrow()
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('stages a settled stop receipt after reopening and never automatically rebases old lineage', async () => {
  const f = fixture(), base = f.owner.capturePlanningFeedbackBase('coreOutline')
  const first = await generate(f.owner, base.baseId, 'before-reopen'), next = f.reopen()
  const artifact = first.executed.outcome.receipt.visibleArtifact!
  const candidate = next.stagePlanningFeedback({ ...first.input, runId: first.view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId })
  f.db.prepare("UPDATE project_core SET core_outline='New F0' WHERE id='main'").run()
  expect(() => next.preparePlanningFeedback({ ...first.input, parentCandidateId: candidate.candidateId })).toThrow()
  const current = next.capturePlanningFeedbackBase('coreOutline')
  expect(() => next.preparePlanningFeedback({ ...first.input, baseId: current.baseId, parentCandidateId: candidate.candidateId })).toThrow()
  const copied = next.relineagePlanningFeedback({ baseId: current.baseId, sourceCandidateId: candidate.candidateId, feedback: '', constraints: [] })
  expect(copied.parentCandidateId).toBeNull()
  expect(copied.origin).toMatchObject({ kind: 'copied', sourceCandidateId: candidate.candidateId })
})

it('does not stage a length-limited result and does not dispatch after cancellation', async () => {
  const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text: 'Partial' }); return { finishReason: 'length', usage } })
  const base = f.owner.capturePlanningFeedbackBase('coreOutline'), partial = await generate(f.owner, base.baseId, 'partial')
  expect(() => partial.stage()).toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
  const cancelled = f.owner.beginPlanningFeedback({ input: { baseId: base.baseId, feedback: '', constraints: [] }, modelId: 'model', uiActionNonce: 'cancel' })
  f.owner.cancel(cancelled.handle)
  await expect(f.owner.executePlanningFeedback(cancelled.handle)).rejects.toThrow()
  expect(f.spy).toHaveBeenCalledTimes(1)
})

const originalOutline = '# 情节大纲\n\n## 第1章：旧一\n旧一正文\n\n## 第2章：旧二\n旧二正文\n\n## 第3章：旧三\n旧三正文\n\n## 第4章：旧四\n旧四正文\n\n## 第5章：旧五\n旧五正文'
const firstRange = '## 第3章：候选三\n候选三正文\n\n## 第4章：候选四\n候选四正文'
const secondRange = '## 第3章：新三\n新三正文\n\n## 第4章：新四\n新四正文'
const chapterThree = '## 第3章：新三\n新三正文'

it('keeps range F0 through C1 and C2, resumes its proof, and adopts only chapter 3', async () => {
  let calls = 0
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: ++calls === 1 ? firstRange : secondRange })
    return { finishReason: 'stop', usage }
  })
  f.db.prepare("UPDATE project_core SET synopsis=?,characters_arch='F0 cast' WHERE id='main'").run(originalOutline)
  const scope = { kind: 'plot-outline-range' as const, from: 3, to: 4 }
  const base = f.owner.capturePlanningFeedbackBase(scope)
  const first = await generate(f.owner, base.baseId, 'range-one'), c1 = first.stage()
  const second = await generate(f.owner, base.baseId, 'range-two', c1.candidateId)
  const task = (f.spy.mock.calls[1]![0] as { task: GenerationTask }).task
  const context = JSON.parse(task.messages.find(message => message.role === 'user')!.content)
  expect(context).toMatchObject({ schemaVersion: 2, target: 'plotOutlineRange', scope,
    source: { core: { coreOutline: 'F0 outline' }, synopsis: originalOutline, charactersArch: 'F0 cast' },
    parentCandidateId: c1.candidateId, parentText: firstRange })
  expect(JSON.stringify(task)).toContain(skill)
  expect(f.db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()).toBe(originalOutline)
  const artifact = second.executed.outcome.receipt.visibleArtifact!
  const next = f.reopen()
  const c2 = next.stagePlanningFeedback({ ...second.input, runId: second.view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId })
  expect(c2.text).toBe(secondRange)
  const request = { candidateId: c2.candidateId, idempotencyKey: 'range-adopt', decision: 'partial' as const,
    adoptedRange: { from: 3, to: 3 }, text: chapterThree }
  const adopted = next.adoptPlanningFeedback(request)
  expect(adopted.adoptedScope).toEqual({ kind: 'plot-outline-range', from: 3, to: 3 })
  expect(next.adoptPlanningFeedback(request)).toEqual(adopted)
  expect(f.db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get())
    .toBe(originalOutline.replace('## 第3章：旧三\n旧三正文', chapterThree))
  expect(f.spy).toHaveBeenCalledTimes(2)
})

it.each([
  '## 第3章：三\n正文',
  '## 第3章：三\n正文\n\n## 第3章：重复\n正文\n\n## 第4章：四\n正文',
  '## 第3章：三\n正文\n\n## 第4章：四\n正文\n\n## 第5章：越界\n正文',
  '## 第3章：三\n正文\n\n## 第4章：四\n',
])('rejects incomplete, duplicate or out-of-range outline candidate %#', async text => {
  const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason: 'stop', usage } })
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.capturePlanningFeedbackBase({ kind: 'plot-outline-range', from: 3, to: 4 })
  const attempt = await generate(f.owner, base.baseId, 'invalid-range')
  expect(() => attempt.stage()).toThrow()
  expect(f.db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()).toBe(originalOutline)
})

it('rejects outline source ABA before dispatch', async () => {
  const f = fixture()
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.capturePlanningFeedbackBase({ kind: 'plot-outline-range', from: 3, to: 4 })
  const input = { baseId: base.baseId, feedback: '', constraints: [] }
  const view = f.owner.beginPlanningFeedback({ input, modelId: 'model', uiActionNonce: 'outline-aba' })
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline + '\nchanged')
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  await expect(f.owner.executePlanningFeedback(view.handle)).rejects.toThrow()
  expect(f.spy).not.toHaveBeenCalled()
})

it('rejects a v1 prompt key bound to a v2 range before dispatch', async () => {
  const f = fixture()
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.capturePlanningFeedbackBase({ kind: 'plot-outline-range', from: 3, to: 4 })
  const view = f.owner.beginPlanningFeedback({ input: { baseId: base.baseId, feedback: '', constraints: [] },
    modelId: 'model', uiActionNonce: 'wrong-version' })
  const row = f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').get(view.handle.runId) as { binding_json: string }
  const binding = JSON.parse(row.binding_json)
  expect(binding.sourceManifest.promptKeys).toEqual(['planning-feedback-v2'])
  binding.sourceManifest.promptKeys = ['planning-feedback-v1']
  f.db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify(binding), view.handle.runId)
  await expect(f.owner.executePlanningFeedback(view.handle)).rejects.toThrow()
  expect(f.spy).not.toHaveBeenCalled()
})

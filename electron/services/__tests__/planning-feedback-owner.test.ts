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
import { GenerationRunRepository, textHash } from '../../repositories/generation-run-repository'
import type { MainGenerationOwnerDependencies } from '../main-generation-owner'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'
import { BlueprintRepository, type BlueprintData } from '../../repositories/blueprint-repository'
import { buildPlanningFeedbackTask, readPlanningFeedbackTask } from '../planning-feedback-generation'

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

async function generateRange(owner: Owner, baseId: string, nonce: string, parentCandidateId?: string) {
  const input = { baseId, ...(parentCandidateId ? { parentCandidateId } : {}), feedback: 'Make it vivid', constraints: ['Keep F0'] }
  const view = owner.beginRangeFeedback({ input, modelId: 'model', uiActionNonce: nonce })
  const executed = await owner.executeRangeFeedback(view.handle)
  const artifact = executed.outcome.receipt.visibleArtifact!
  return { input, view, executed, stage: () => owner.stageRangeFeedback({ ...input, runId: view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId }) }
}

it('keeps range F0 through C1 and C2, resumes its proof, and adopts only chapter 3', async () => {
  let calls = 0
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: ++calls === 1 ? firstRange : secondRange })
    return { finishReason: 'stop', usage }
  })
  f.db.prepare("UPDATE project_core SET synopsis=?,characters_arch='F0 cast' WHERE id='main'").run(originalOutline)
  const scope = { kind: 'plot-outline-range' as const, from: 3, to: 4 }
  const base = f.owner.captureRangeFeedback(scope)
  expect(f.owner.listRangeFeedbackBases(scope).map(item => item.baseId)).toContain(base.baseId)
  const first = await generateRange(f.owner, base.baseId, 'range-one'), c1 = first.stage()
  const second = await generateRange(f.owner, base.baseId, 'range-two', c1.candidateId)
  expect(f.owner.listRangeFeedbackRuns(base.baseId).map(item => item.handle.runId)).toEqual(expect.arrayContaining([first.view.handle.runId, second.view.handle.runId]))
  expect(f.owner.readRangeFeedbackRun(second.view.handle)).toMatchObject({ input: second.input, sourceStatus: 'current' })
  expect(f.owner.readRangeFeedbackHistory(base.baseId).candidates.map(item => item.candidate.candidateId)).toEqual([c1.candidateId])
  const task = (f.spy.mock.calls[1]![0] as { task: GenerationTask }).task
  const context = JSON.parse(task.messages.find(message => message.role === 'user')!.content)
  expect(context).toMatchObject({ schemaVersion: 2, target: 'plotOutlineRange', scope,
    source: { core: { coreOutline: 'F0 outline' }, synopsis: originalOutline, charactersArch: 'F0 cast' },
    parentCandidateId: c1.candidateId, parentText: firstRange })
  expect(JSON.stringify(task)).toContain(skill)
  expect(f.db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()).toBe(originalOutline)
  const artifact = second.executed.outcome.receipt.visibleArtifact!
  const next = f.reopen()
  const c2 = next.stageRangeFeedback({ ...second.input, runId: second.view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId })
  expect(c2.text).toBe(secondRange)
  const request = { candidateId: c2.candidateId, idempotencyKey: 'range-adopt', decision: 'partial' as const,
    adoptedRange: { from: 3, to: 3 }, text: chapterThree }
  const adopted = next.adoptRangeFeedback(request)
  expect(adopted.adoptedScope).toEqual({ kind: 'plot-outline-range', from: 3, to: 3 })
  expect(next.adoptRangeFeedback(request)).toEqual(adopted)
  expect(next.readRangeFeedbackRun(second.view.handle).sourceStatus).toBe('conflict')
  expect(next.readRangeFeedbackHistory(base.baseId).adoptions).toEqual([adopted])
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
  const base = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const attempt = await generateRange(f.owner, base.baseId, 'invalid-range')
  expect(() => attempt.stage()).toThrow()
  expect(f.db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()).toBe(originalOutline)
})

it('rejects outline source ABA before dispatch', async () => {
  const f = fixture()
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const input = { baseId: base.baseId, feedback: '', constraints: [] }
  const view = f.owner.beginRangeFeedback({ input, modelId: 'model', uiActionNonce: 'outline-aba' })
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline + '\nchanged')
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  expect(f.owner.readRangeFeedbackRun(view.handle).sourceStatus).toBe('conflict')
  await expect(f.owner.executeRangeFeedback(view.handle)).rejects.toThrow()
  expect(f.spy).not.toHaveBeenCalled()
})

it('rejects a v1 prompt key bound to a v2 range before dispatch', async () => {
  const f = fixture()
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const view = f.owner.beginRangeFeedback({ input: { baseId: base.baseId, feedback: '', constraints: [] },
    modelId: 'model', uiActionNonce: 'wrong-version' })
  const row = f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').get(view.handle.runId) as { binding_json: string }
  const binding = JSON.parse(row.binding_json)
  expect(binding.sourceManifest.promptKeys).toEqual(['planning-feedback-v2'])
  binding.sourceManifest.promptKeys = ['planning-feedback-v1']
  f.db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify(binding), view.handle.runId)
  await expect(f.owner.executeRangeFeedback(view.handle)).rejects.toThrow()
  expect(f.spy).not.toHaveBeenCalled()
})

it.each(['invalid-range', 'source-cas', 'source-aba'] as const)('rejects range adoption %s without changing the formal outline', async change => {
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: firstRange })
    return { finishReason: 'stop', usage }
  })
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const attempt = await generateRange(f.owner, base.baseId, `adopt-${change}`), candidate = attempt.stage()
  if (change !== 'invalid-range') {
    f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline + '\nAuthor changed source')
    if (change === 'source-aba') f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  }
  const before = f.db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()
  expect(() => f.owner.adoptRangeFeedback({ candidateId: candidate.candidateId, idempotencyKey: `adopt-${change}`,
    decision: 'partial', adoptedRange: change === 'invalid-range' ? { from: 5, to: 5 } : { from: 3, to: 4 },
    text: firstRange })).toThrow()
  expect(f.db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()).toBe(before)
  expect(f.owner.readRangeFeedbackHistory(base.baseId).adoptions).toEqual([])
})

it('explicitly relineages an old range candidate only onto a new current base', async () => {
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: firstRange })
    return { finishReason: 'stop', usage }
  })
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const scope = { kind: 'plot-outline-range' as const, from: 3, to: 4 }
  const base = f.owner.captureRangeFeedback(scope), first = await generateRange(f.owner, base.baseId, 'copy-range')
  const candidate = first.stage()
  f.db.prepare("UPDATE project_core SET core_outline='Author changed core' WHERE id='main'").run()
  expect(f.owner.readRangeFeedbackHistory(base.baseId).candidates[0]?.state).toBe('conflict')
  const next = f.owner.captureRangeFeedback(scope)
  const copied = f.owner.relineageRangeFeedback({ baseId: next.baseId, sourceCandidateId: candidate.candidateId,
    feedback: 'Author copies this candidate', constraints: [] })
  expect(copied).toMatchObject({ baseId: next.baseId, parentCandidateId: null, text: firstRange,
    origin: { kind: 'copied', sourceCandidateId: candidate.candidateId } })
  expect(f.db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()).toBe(originalOutline)
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('rebinds an explicitly executed old pending range run after reopening', async () => {
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: firstRange })
    return { finishReason: 'stop', usage }
  })
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const view = f.owner.beginRangeFeedback({ input: { baseId: base.baseId, feedback: '', constraints: [] }, modelId: 'model', uiActionNonce: 'pending-range' })
  const next = f.reopen()
  expect(next.readRangeFeedbackRun(view.handle).sourceStatus).toBe('current')
  expect((await next.executeRangeFeedback(view.handle)).outcome.status).toBe('completed')
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('does not resend an unknown range outcome after reopening', async () => {
  const f = fixture(async () => { throw new Error('synthetic uncertain range transport') })
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const first = await generateRange(f.owner, base.baseId, 'unknown-range')
  expect(first.executed.outcome.status).toBe('incomplete')
  const next = f.reopen()
  expect((await next.executeRangeFeedback(first.view.handle)).outcome.status).toBe('incomplete')
  expect(next.readRangeFeedbackHistory(base.baseId).candidates).toEqual([])
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('cancels a range run before dispatch without changing the formal outline', async () => {
  const f = fixture()
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const view = f.owner.beginRangeFeedback({ input: { baseId: base.baseId, feedback: '', constraints: [] }, modelId: 'model', uiActionNonce: 'cancel-range' })
  f.owner.cancelRangeFeedback(view.handle)
  await expect(f.owner.executeRangeFeedback(view.handle)).rejects.toThrow()
  expect(f.spy).not.toHaveBeenCalled()
  expect(f.db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get()).toBe(originalOutline)
})

it('keeps field and range bases, candidates and runs in separate facades', async () => {
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: firstRange })
    return { finishReason: 'stop', usage }
  })
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const field = f.owner.captureFieldFeedback('coreOutline')
  const range = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const fieldAttempt = await generate(f.owner, field.baseId, 'field-crosswire'), fieldCandidate = fieldAttempt.stage()
  const rangeAttempt = await generateRange(f.owner, range.baseId, 'range-crosswire'), rangeCandidate = rangeAttempt.stage()
  expect(() => f.owner.readFieldFeedbackHistory(range.baseId)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.readRangeFeedbackHistory(field.baseId)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.readFieldFeedbackRun(rangeAttempt.view.handle)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.readRangeFeedbackRun(fieldAttempt.view.handle)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.beginRangeFeedback({ input: fieldAttempt.input, modelId: 'model', uiActionNonce: 'wrong-range' })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.beginFieldFeedback({ input: rangeAttempt.input, modelId: 'model', uiActionNonce: 'wrong-field' })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  const fieldArtifact = fieldAttempt.executed.outcome.receipt.visibleArtifact!
  expect(() => f.owner.stageRangeFeedback({ ...rangeAttempt.input, runId: fieldAttempt.view.handle.runId,
    attemptId: fieldArtifact.attemptId, artifactId: fieldArtifact.artifactId })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  const rangeArtifact = rangeAttempt.executed.outcome.receipt.visibleArtifact!
  expect(() => f.owner.stageFieldFeedback({ ...fieldAttempt.input, runId: rangeAttempt.view.handle.runId,
    attemptId: rangeArtifact.attemptId, artifactId: rangeArtifact.artifactId })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.readRangeFeedbackRun({ ...rangeAttempt.view.handle, projectId: 'another-project' })).toThrow('GENERATION_RUN_IDENTITY_MISMATCH')
  expect(() => f.owner.beginRangeFeedback({ input: { ...rangeAttempt.input, parentCandidateId: fieldCandidate.candidateId },
    modelId: 'model', uiActionNonce: 'wrong-parent' })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.adoptRangeFeedback({ candidateId: fieldCandidate.candidateId, idempotencyKey: 'wrong-adopt-range', decision: 'full', text: fieldCandidate.text })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.adoptFieldFeedback({ candidateId: rangeCandidate.candidateId, idempotencyKey: 'wrong-adopt-field', decision: 'full', text: rangeCandidate.text })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.captureRangeFeedback('coreOutline' as never)).toThrow()
})

it.each(['scope', 'scope-extra', 'project', 'operation', 'schema'] as const)('rejects range run context crosswire %s before exposing input or dispatching', kind => {
  const f = fixture()
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const view = f.owner.beginRangeFeedback({ input: { baseId: base.baseId, feedback: '', constraints: [] }, modelId: 'model', uiActionNonce: `context-${kind}` })
  const row = f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').get(view.handle.runId) as { binding_json: string }
  const binding = JSON.parse(row.binding_json)
  if (kind === 'scope') binding.sourceManifest.planningFeedbackContext.scope = { kind: 'plot-outline-range', from: 4, to: 4 }
  if (kind === 'scope-extra') binding.sourceManifest.planningFeedbackContext.scope.extra = true
  if (kind === 'project') binding.sourceManifest.planningFeedbackContext.projectId = 'another-project'
  if (kind === 'operation') binding.sourceManifest.operation = 'chapter-draft'
  if (kind === 'schema') binding.sourceManifest.planningFeedbackContext.schemaVersion = 1
  f.db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify(binding), view.handle.runId)
  expect(() => f.owner.readRangeFeedbackRun(view.handle)).toThrow()
  expect(() => f.owner.executeRangeFeedback(view.handle)).toThrow()
  expect(f.spy).not.toHaveBeenCalled()
})

it('never infers range inputs from a redacted historical run', () => {
  const f = fixture()
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const base = f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 })
  const view = f.owner.beginRangeFeedback({ input: { baseId: base.baseId, feedback: '', constraints: [] }, modelId: 'model', uiActionNonce: 'redacted-range' })
  const row = f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').get(view.handle.runId) as { binding_json: string }
  const binding = JSON.parse(row.binding_json)
  delete binding.sourceManifest.planningFeedbackInput
  delete binding.sourceManifest.planningFeedbackContext
  delete binding.sourceManifest.planningFeedbackTask
  f.db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify(binding), view.handle.runId)
  expect(f.owner.listRangeFeedbackRuns(base.baseId)).toEqual([])
  expect(() => f.owner.readRangeFeedbackRun(view.handle)).toThrow()
  expect(() => f.owner.executeRangeFeedback(view.handle)).toThrow()
  expect(f.spy).not.toHaveBeenCalled()
})

const blueprintScope = { kind: 'blueprint-fields' as const, chapterNumber: 1,
  fields: ['title', 'userGuidance', 'notes'] as Array<'title' | 'userGuidance' | 'notes'> }
const originalBlueprint: BlueprintData = { chapterNumber: 1, title: 'F0 title', role: 'Setup', purpose: 'F0 purpose',
  keyEvents: 'F0 event', characters: ['Fictional lead'], suspenseHook: 'F0 hook', userGuidance: 'F0 guidance',
  notes: 'F0 notes', notesUpdatedAt: 'F0-notes-stamp' }
function seedFeedbackBlueprints(f: ReturnType<typeof fixture>) {
  BlueprintRepository.upsert(originalBlueprint, f.db)
  BlueprintRepository.upsert({ ...originalBlueprint, chapterNumber: 2, title: 'Outside scope' }, f.db)
}

async function generateBlueprint(owner: Owner, baseId: string, nonce: string, parentCandidateId?: string) {
  const input = { baseId, ...(parentCandidateId ? { parentCandidateId } : {}), feedback: 'Make it vivid', constraints: ['Keep F0'] }
  const view = owner.beginBlueprintFeedback({ input, modelId: 'model', uiActionNonce: nonce })
  const executed = await owner.executeBlueprintFeedback(view.handle)
  const artifact = executed.outcome.receipt.visibleArtifact!
  return { input, view, executed, stage: () => owner.stageBlueprintFeedback({ ...input, runId: view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId }) }
}

it('executes all eleven dedicated blueprint facades with actual F0-C1-C2, reopen, subset adoption, explicit relineage and cancellation', async () => {
  let sequence = 0
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: JSON.stringify({ title: `Dedicated candidate ${++sequence}`, userGuidance: '', notes: '' }) })
    return { finishReason: 'stop', usage }
  })
  seedFeedbackBlueprints(f)
  const original = BlueprintRepository.getAll(f.db), characters = f.db.prepare('SELECT * FROM characters').all()
  const base = f.owner.captureBlueprintFeedback({ ...blueprintScope, fields: ['notes', 'title', 'userGuidance'] })
  expect(base.schemaVersion).toBe(3)
  expect(base.scope).toEqual(blueprintScope)
  expect(f.owner.listBlueprintFeedbackBases(blueprintScope)).toEqual([{ baseId: base.baseId, projectId: f.projectId,
    target: 'blueprintFields', scope: blueprintScope, createdAt: base.createdAt, closedAt: null, closedByAdoptionId: null }])
  const one = await generateBlueprint(f.owner, base.baseId, 'dedicated-blueprint-c1'), c1 = one.stage()
  const two = await generateBlueprint(f.owner, base.baseId, 'dedicated-blueprint-c2', c1.candidateId)
  expect(f.owner.listBlueprintFeedbackRuns(base.baseId).map(item => item.handle.runId).sort())
    .toEqual([one.view.handle.runId, two.view.handle.runId].sort())
  expect(f.owner.readBlueprintFeedbackRun(two.view.handle)).toMatchObject({ input: two.input, sourceStatus: 'current' })
  expect(f.owner.readBlueprintFeedbackHistory(base.baseId).candidates).toEqual([{ candidate: c1, state: 'ready' }])
  const task = (f.spy.mock.calls[1]![0] as { task: GenerationTask }).task
  expect(JSON.parse(task.messages.find(message => message.role === 'user')!.content)).toMatchObject({ schemaVersion: 3,
    target: 'blueprintFields', scope: blueprintScope, baseId: base.baseId, parentCandidateId: c1.candidateId,
    parentText: c1.text, source: { blueprint: originalBlueprint } })
  expect(BlueprintRepository.getAll(f.db)).toEqual(original)
  const artifact = two.executed.outcome.receipt.visibleArtifact!, reopened = f.reopen()
  expect(() => f.owner.captureBlueprintFeedback(blueprintScope)).toThrow('GENERATION_OWNER_CLOSED')
  const c2 = reopened.stageBlueprintFeedback({ ...two.input, runId: two.view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId })
  const request = { candidateId: c2.candidateId, idempotencyKey: 'dedicated-blueprint-adopt', decision: 'partial' as const, text: '{"notes":""}' }
  const receipt = reopened.adoptBlueprintFeedback(request)
  expect(receipt.adoptedScope).toEqual({ kind: 'blueprint-fields', chapterNumber: 1, fields: ['notes'] })
  const changes = f.db.prepare('SELECT total_changes()').pluck().get()
  expect(reopened.adoptBlueprintFeedback(request)).toEqual(receipt)
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  expect(reopened.readBlueprintFeedbackRun(two.view.handle).sourceStatus).toBe('conflict')
  expect(reopened.readBlueprintFeedbackHistory(base.baseId).adoptions).toEqual([receipt])
  expect(BlueprintRepository.getAll(f.db)).toEqual([{ ...originalBlueprint, notes: '' }, original[1]])
  expect(f.db.prepare('SELECT * FROM characters').all()).toEqual(characters)
  expect(BlueprintRepository.listPendingCharacterSyncOperations(f.db)).toHaveLength(1)
  const fresh = reopened.captureBlueprintFeedback(blueprintScope)
  const copied = reopened.relineageBlueprintFeedback({ baseId: fresh.baseId, sourceCandidateId: c1.candidateId,
    feedback: 'Explicit fresh lineage', constraints: [] })
  expect(copied).toMatchObject({ baseId: fresh.baseId, parentCandidateId: null, origin: { kind: 'copied', sourceCandidateId: c1.candidateId } })
  const pending = reopened.beginBlueprintFeedback({ input: { baseId: fresh.baseId, parentCandidateId: copied.candidateId, feedback: '', constraints: [] },
    modelId: 'model', uiActionNonce: 'dedicated-blueprint-cancel' })
  expect(reopened.cancelBlueprintFeedback(pending.handle).status).toBe('cancelled')
  await expect(reopened.executeBlueprintFeedback(pending.handle)).rejects.toThrow()
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(pending.handle.runId)).toBe(0)
  expect(f.spy).toHaveBeenCalledTimes(2)
})

it('runs persistent blueprint F0-C1-C2 through the actual owner and adopts only the explicit field subset', async () => {
  let sequence = 0
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: JSON.stringify({ title: `Candidate ${++sequence}`, userGuidance: '', notes: '' }) })
    return { finishReason: 'stop', usage }
  })
  seedFeedbackBlueprints(f)
  const original = BlueprintRepository.getAll(f.db), identities = f.db.prepare('SELECT * FROM characters').all()
  const base = f.owner.capturePlanningFeedbackBase(blueprintScope)
  expect(base.schemaVersion).toBe(3)
  const one = await generate(f.owner, base.baseId, 'blueprint-c1'), c1 = one.stage()
  const two = await generate(f.owner, base.baseId, 'blueprint-c2', c1.candidateId)
  const task = (f.spy.mock.calls[1]![0] as { task: GenerationTask }).task
  const context = JSON.parse(task.messages.find(message => message.role === 'user')!.content)
  expect(context).toMatchObject({ schemaVersion: 3, target: 'blueprintFields', scope: blueprintScope,
    source: { core: { coreOutline: 'F0 outline' }, blueprint: originalBlueprint },
    parentCandidateId: c1.candidateId, parentText: c1.text })
  expect(JSON.stringify(task)).toContain(skill)
  expect(BlueprintRepository.getAll(f.db)).toEqual(original)
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
  const artifact = two.executed.outcome.receipt.visibleArtifact!
  const reopened = f.reopen()
  const c2 = reopened.stagePlanningFeedback({ ...two.input, runId: two.view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId })
  const request = { candidateId: c2.candidateId, idempotencyKey: 'blueprint-subset-adopt', decision: 'partial' as const,
    text: JSON.stringify({ notes: '' }) }
  const adopted = reopened.adoptPlanningFeedback(request)
  expect(adopted.adoptedScope).toEqual({ kind: 'blueprint-fields', chapterNumber: 1, fields: ['notes'] })
  expect(BlueprintRepository.getAll(f.db)).toEqual([{ ...originalBlueprint, notes: '' }, original[1]])
  expect(f.db.prepare('SELECT * FROM characters').all()).toEqual(identities)
  const committed = f.db.prepare('SELECT character_sync_input FROM blueprint_commit_operations').pluck().get() as string
  expect(JSON.parse(committed)).toEqual([{ ...originalBlueprint, notes: '' }])
  expect(BlueprintRepository.listPendingCharacterSyncOperations(f.db)).toHaveLength(1)
  expect(() => reopened.adoptPlanningFeedback({ candidateId: c1.candidateId, idempotencyKey: 'old-blueprint-lineage',
    decision: 'full', text: c1.text })).toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
  const next = f.reopen(), beforeReplay = BlueprintRepository.getAll(f.db)
  expect(next.adoptPlanningFeedback(request)).toEqual(adopted)
  expect(BlueprintRepository.getAll(f.db)).toEqual(beforeReplay)
  expect(f.db.prepare('SELECT COUNT(*) FROM planning_feedback_adoptions').pluck().get()).toBe(1)
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(1)
  expect(f.spy).toHaveBeenCalledTimes(2)
})

it.each(['target-aba', 'upstream-aba', 'skill', 'model'] as const)('rejects blueprint %s before physical dispatch', async change => {
  const f = fixture()
  seedFeedbackBlueprints(f)
  const base = f.owner.captureBlueprintFeedback(blueprintScope)
  const view = f.owner.beginBlueprintFeedback({ input: { baseId: base.baseId, feedback: 'Revise', constraints: [] },
    modelId: 'model', uiActionNonce: `blueprint-changed-${change}` })
  if (change === 'target-aba') {
    f.db.exec("UPDATE blueprints SET title='Changed' WHERE chapter_number=1")
    f.db.prepare('UPDATE blueprints SET title=? WHERE chapter_number=1').run(originalBlueprint.title)
  } else if (change === 'upstream-aba') {
    f.db.exec("UPDATE project_core SET core_outline='Changed' WHERE id='main'")
    f.db.exec("UPDATE project_core SET core_outline='F0 outline' WHERE id='main'")
  } else if (change === 'skill') f.writeSkill('Changed planning Skill')
  else f.model.modelName = 'changed-model'
  expect(f.owner.readBlueprintFeedbackRun(view.handle).sourceStatus).toBe('conflict')
  await expect(f.owner.executeBlueprintFeedback(view.handle)).rejects.toThrow()
  expect(f.spy).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(view.handle.runId)).toBe(0)
  expect(BlueprintRepository.getByChapter(1, f.db)).toEqual(originalBlueprint)
})

it.each([
  '{"title":"Missing selected fields"}',
  '{"title":"Candidate","userGuidance":"","notes":"","chapterNumber":1}',
  '{"title":"Candidate","userGuidance":"","notes":"","relationshipHints":[]}',
  '{"title":7,"userGuidance":"","notes":""}',
])('preserves actual blueprint artifacts but rejects malformed generated field JSON: %s', async content => {
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: content })
    return { finishReason: 'stop', usage }
  })
  seedFeedbackBlueprints(f)
  const base = f.owner.captureBlueprintFeedback(blueprintScope)
  const result = await generateBlueprint(f.owner, base.baseId, 'blueprint-invalid-json')
  expect(f.db.prepare("SELECT json_extract(artifact_json,'$.text') FROM generation_artifacts WHERE artifact_id=?")
    .pluck().get(result.executed.outcome.receipt.visibleArtifact!.artifactId)).toBe(content)
  expect(() => result.stage()).toThrow()
  expect(BlueprintRepository.getByChapter(1, f.db)).toEqual(originalBlueprint)
  expect(f.db.prepare('SELECT COUNT(*) FROM planning_feedback_candidates').pluck().get()).toBe(0)
  expect(f.db.prepare('SELECT COUNT(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
})

it('keeps delivery-unknown blueprint execution frozen across reopen without resending', async () => {
  const f = fixture(async () => { throw new Error('Synthetic delivery unknown') })
  seedFeedbackBlueprints(f)
  const base = f.owner.captureBlueprintFeedback(blueprintScope)
  const view = f.owner.beginBlueprintFeedback({ input: { baseId: base.baseId, feedback: 'Revise', constraints: [] },
    modelId: 'model', uiActionNonce: 'blueprint-unknown' })
  const result = await f.owner.executeBlueprintFeedback(view.handle)
  expect(result.outcome.status).toBe('incomplete')
  const rows = () => f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE run_id=?').all(view.handle.runId)
  const before = rows(), reopened = f.reopen()
  expect((await reopened.executeBlueprintFeedback(view.handle)).outcome.status).toBe('incomplete')
  expect(rows()).toEqual(before)
  expect(f.spy).toHaveBeenCalledTimes(1)
  expect(BlueprintRepository.getByChapter(1, f.db)).toEqual(originalBlueprint)
  expect(f.db.prepare('SELECT COUNT(*) FROM planning_feedback_candidates').pluck().get()).toBe(0)
})

it('stages complete blueprint stop despite unknown usage accounting without redispatching or changing ledger', async () => {
  const content = JSON.stringify({ title: 'Complete candidate', userGuidance: '', notes: '' })
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: content })
    return { finishReason: 'stop', usage: null }
  })
  seedFeedbackBlueprints(f)
  const base = f.owner.captureBlueprintFeedback(blueprintScope)
  const result = await generateBlueprint(f.owner, base.baseId, 'blueprint-stop-unknown-usage')
  expect(result.executed.outcome.status).toBe('completed')
  const artifact = result.executed.outcome.receipt.visibleArtifact!
  const rows = () => f.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(artifact.attemptId)
  const before = rows() as { attempt_json: string }
  expect(JSON.parse(before.attempt_json).status).toBe('unknown')
  const reopened = f.reopen()
  const candidate = reopened.stageBlueprintFeedback({ ...result.input, runId: result.view.handle.runId,
    attemptId: artifact.attemptId, artifactId: artifact.artifactId })
  expect(candidate.text).toBe(content)
  expect(rows()).toEqual(before)
  expect(f.spy).toHaveBeenCalledTimes(1)
  expect(BlueprintRepository.getByChapter(1, f.db)).toEqual(originalBlueprint)
})

it('does not grant blueprint IDs or runs to the existing field and outline-range facades', async () => {
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: JSON.stringify({ title: 'Candidate', userGuidance: '', notes: '' }) })
    return { finishReason: 'stop', usage }
  })
  seedFeedbackBlueprints(f)
  const base = f.owner.capturePlanningFeedbackBase(blueprintScope)
  const result = await generate(f.owner, base.baseId, 'blueprint-crosswire'), candidate = result.stage()
  expect(() => f.owner.readFieldFeedbackHistory(base.baseId)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.readRangeFeedbackHistory(base.baseId)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.beginFieldFeedback({ input: result.input, modelId: 'model', uiActionNonce: 'blueprint-to-field' })).toThrow()
  expect(() => f.owner.beginRangeFeedback({ input: result.input, modelId: 'model', uiActionNonce: 'blueprint-to-range' })).toThrow()
  expect(() => f.owner.readFieldFeedbackRun(result.view.handle)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.readRangeFeedbackRun(result.view.handle)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  const changes = f.db.prepare('SELECT total_changes()').pluck().get()
  const artifact = result.executed.outcome.receipt.visibleArtifact!
  const stage = { ...result.input, runId: result.view.handle.runId, attemptId: artifact.attemptId, artifactId: artifact.artifactId }
  for (const execute of [f.owner.executeFieldFeedback, f.owner.executeRangeFeedback]) {
    expect(() => execute(result.view.handle)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  }
  for (const cancel of [f.owner.cancelFieldFeedback, f.owner.cancelRangeFeedback]) {
    expect(() => cancel(result.view.handle)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  }
  for (const stageCandidate of [f.owner.stageFieldFeedback, f.owner.stageRangeFeedback]) {
    expect(() => stageCandidate(stage)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  }
  for (const relineage of [f.owner.relineageFieldFeedback, f.owner.relineageRangeFeedback]) {
    expect(() => relineage({ baseId: base.baseId, sourceCandidateId: candidate.candidateId, feedback: '', constraints: [] }))
      .toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  }
  const adopt = { candidateId: candidate.candidateId, idempotencyKey: 'blueprint-wrong-facade', decision: 'full' as const, text: candidate.text }
  expect(() => f.owner.adoptFieldFeedback(adopt)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => f.owner.adoptRangeFeedback(adopt)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  expect(BlueprintRepository.getByChapter(1, f.db)).toEqual(originalBlueprint)
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each([[1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2]] as const)('rejects v%s identities at every v%s facade before any durable or dispatch effect', async (from, to) => {
  const text = from === 1 ? 'Field candidate' : from === 2 ? '## 第3章：新三\n新三正文\n\n## 第4章：新四\n新四正文'
    : JSON.stringify({ title: 'Blueprint candidate', userGuidance: '', notes: '' })
  const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason: 'stop', usage } })
  seedFeedbackBlueprints(f)
  f.db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(originalOutline)
  const facades = {
    1: { base: f.owner.captureFieldFeedback('coreOutline'), begin: f.owner.beginFieldFeedback, history: f.owner.readFieldFeedbackHistory,
      runs: f.owner.listFieldFeedbackRuns, read: f.owner.readFieldFeedbackRun, execute: f.owner.executeFieldFeedback,
      cancel: f.owner.cancelFieldFeedback, stage: f.owner.stageFieldFeedback, relineage: f.owner.relineageFieldFeedback, adopt: f.owner.adoptFieldFeedback },
    2: { base: f.owner.captureRangeFeedback({ kind: 'plot-outline-range', from: 3, to: 4 }), begin: f.owner.beginRangeFeedback, history: f.owner.readRangeFeedbackHistory,
      runs: f.owner.listRangeFeedbackRuns, read: f.owner.readRangeFeedbackRun, execute: f.owner.executeRangeFeedback,
      cancel: f.owner.cancelRangeFeedback, stage: f.owner.stageRangeFeedback, relineage: f.owner.relineageRangeFeedback, adopt: f.owner.adoptRangeFeedback },
    3: { base: f.owner.captureBlueprintFeedback(blueprintScope), begin: f.owner.beginBlueprintFeedback, history: f.owner.readBlueprintFeedbackHistory,
      runs: f.owner.listBlueprintFeedbackRuns, read: f.owner.readBlueprintFeedbackRun, execute: f.owner.executeBlueprintFeedback,
      cancel: f.owner.cancelBlueprintFeedback, stage: f.owner.stageBlueprintFeedback, relineage: f.owner.relineageBlueprintFeedback, adopt: f.owner.adoptBlueprintFeedback },
  }
  const source = facades[from], target = facades[to], input = { baseId: source.base.baseId, feedback: 'Revision', constraints: [] }
  const view = source.begin({ input, modelId: 'model', uiActionNonce: 'cross-version-source' })
  const executed = await source.execute(view.handle), artifact = executed.outcome.receipt.visibleArtifact!
  const request = { ...input, runId: view.handle.runId, attemptId: artifact.attemptId, artifactId: artifact.artifactId }
  const candidate = source.stage(request), changes = f.db.prepare('SELECT total_changes()').pluck().get()
  expect(() => target.history(source.base.baseId)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => target.runs(source.base.baseId)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => target.begin({ input, modelId: 'model', uiActionNonce: 'cross-version-base' })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => target.begin({ input: { ...input, baseId: target.base.baseId, parentCandidateId: candidate.candidateId },
    modelId: 'model', uiActionNonce: 'cross-version-parent' })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => target.read(view.handle)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => target.execute(view.handle)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => target.cancel(view.handle)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => target.stage(request)).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => target.stage({ ...request, baseId: target.base.baseId })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(() => target.stage({ ...request, baseId: target.base.baseId, parentCandidateId: candidate.candidateId }))
    .toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  for (const baseId of [source.base.baseId, target.base.baseId]) {
    expect(() => target.relineage({ baseId, sourceCandidateId: candidate.candidateId, feedback: 'Copy', constraints: [] }))
      .toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  }
  expect(() => target.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'cross-version-adopt', decision: 'full', text: candidate.text }))
    .toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each(['source', 'revision', 'parent-text', 'scope-order', 'scope-extra', 'input-feedback', 'input-constraints', 'input-extra',
  'task', 'prompt-version', 'foreign-operation', 'schema', 'redacted'] as const)('rejects blueprint frozen identity tampering %s before read/execute/cancel/stage effects', async kind => {
  const text = JSON.stringify({ title: 'Actual candidate', userGuidance: '', notes: '' })
  const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason: 'stop', usage } })
  seedFeedbackBlueprints(f)
  const base = f.owner.captureBlueprintFeedback(blueprintScope), first = await generateBlueprint(f.owner, base.baseId, 'identity-parent'), parent = first.stage()
  const input = { baseId: base.baseId, parentCandidateId: parent.candidateId, feedback: 'Actual feedback', constraints: ['Actual constraint'] }
  const view = f.owner.beginBlueprintFeedback({ input, modelId: 'model', uiActionNonce: `identity-${kind}` })
  const binding = JSON.parse(f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(view.handle.runId) as string)
  const manifest = binding.sourceManifest, context = manifest.planningFeedbackContext
  if (kind === 'source') { context.source.blueprint.role = 'Forged frozen fact'; context.sourceHash = textHash(JSON.stringify(context.source)) }
  if (kind === 'revision') context.sourceRevision++
  if (kind === 'parent-text') { context.parentText = JSON.stringify({ title: 'Forged parent', userGuidance: '', notes: '' }); context.parentTextHash = textHash(context.parentText) }
  // These three forgeries remain task/context/hash self-consistent; only the actual durable F0/parent comparison rejects them.
  if (kind === 'source' || kind === 'revision' || kind === 'parent-text') {
    manifest.planningFeedbackContextHash = textHash(JSON.stringify(context))
    manifest.planningFeedbackTask = buildPlanningFeedbackTask(context, manifest.planningFeedbackSkillText)
    manifest.planningFeedbackTaskHash = textHash(JSON.stringify(manifest.planningFeedbackTask))
  }
  if (kind === 'scope-order') context.scope.fields.reverse()
  if (kind === 'scope-extra') context.scope.extra = true
  if (kind === 'input-feedback') manifest.planningFeedbackInput.feedback = 'Forged input feedback'
  if (kind === 'input-constraints') manifest.planningFeedbackInput.constraints = ['Forged input constraint']
  if (kind === 'input-extra') manifest.planningFeedbackInput.proof = 'caller-supplied'
  if (kind === 'task') { manifest.planningFeedbackTask.messages[0].content = 'Forged fixed task'; manifest.planningFeedbackTaskHash = textHash(JSON.stringify(manifest.planningFeedbackTask)) }
  if (kind === 'prompt-version') manifest.promptKeys = ['planning-feedback-v2']
  if (kind === 'foreign-operation') manifest.operation = 'chapter-draft'
  if (kind === 'schema') context.schemaVersion = 2
  if (kind === 'redacted') { delete manifest.planningFeedbackInput; delete manifest.planningFeedbackContext; delete manifest.planningFeedbackTask }
  f.db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify(binding), view.handle.runId)
  if (kind === 'source' || kind === 'revision' || kind === 'parent-text') {
    expect(readPlanningFeedbackTask(new GenerationRunRepository(() => f.db).get(view.handle.runId))).toEqual(manifest.planningFeedbackTask)
  }
  const changes = f.db.prepare('SELECT total_changes()').pluck().get(), original = BlueprintRepository.getAll(f.db)
  expect(() => f.owner.readBlueprintFeedbackRun(view.handle)).toThrow()
  expect(() => f.owner.executeBlueprintFeedback(view.handle)).toThrow()
  expect(() => f.owner.cancelBlueprintFeedback(view.handle)).toThrow()
  expect(() => f.owner.stageBlueprintFeedback({ ...input, runId: view.handle.runId, attemptId: 'not-issued', artifactId: 'not-issued' })).toThrow()
  if (kind === 'redacted' || kind === 'foreign-operation' || kind === 'schema') {
    expect(f.owner.listBlueprintFeedbackRuns(base.baseId).map(item => item.handle.runId)).toEqual([first.view.handle.runId])
  } else expect(() => f.owner.listBlueprintFeedbackRuns(base.baseId)).toThrow()
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  expect(BlueprintRepository.getAll(f.db)).toEqual(original)
  expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(view.handle.runId)).toBe(0)
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('retains the physical permit and ignores late provider effects after dedicated blueprint cancellation', async () => {
  let started!: () => void, finish!: (result: { finishReason: string; usage: typeof usage }) => void, lateVisible!: () => void
  const dispatched = new Promise<void>(resolve => { started = resolve })
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: '{"title":"Partial' })
    lateVisible = () => options.onVisible({ kind: 'delta', text: ' late","userGuidance":"","notes":""}' })
    started()
    return await new Promise(resolve => { finish = resolve })
  })
  seedFeedbackBlueprints(f)
  const base = f.owner.captureBlueprintFeedback(blueprintScope), input = { baseId: base.baseId, feedback: '', constraints: [] }
  const view = f.owner.beginBlueprintFeedback({ input, modelId: 'model', uiActionNonce: 'dedicated-cancel-tail' })
  const running = f.owner.executeBlueprintFeedback(view.handle)
  await dispatched
  expect(f.owner.cancelBlueprintFeedback(view.handle).status).toBe('cancelled')
  const stopped = await running
  expect(stopped.outcome.status).toBe('incomplete')
  const rows = () => f.db.prepare(`SELECT a.attempt_id,a.attempt_json,a.usage_receipt_json,b.artifact_id,b.artifact_json
    FROM generation_attempts a JOIN generation_artifacts b ON b.attempt_id=a.attempt_id WHERE a.run_id=?`).get(view.handle.runId) as
    { attempt_id: string; attempt_json: string; usage_receipt_json: string; artifact_id: string; artifact_json: string }
  const businessRows = () => Object.fromEntries((f.db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'llm_calls' ORDER BY name`).pluck().all() as string[])
    .map(name => [name, f.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]))
  const before = rows(), businessBefore = businessRows(), changes = f.db.prepare('SELECT total_changes()').pluck().get() as number
  const rootBefore = (businessBefore.generation_roots as { root_action_id: string; active_since_ms: number | null; active_elapsed_ms: number }[])
    .filter(root => root.root_action_id === view.handle.rootActionId)
  expect(rootBefore).toHaveLength(1)
  expect(Number.isSafeInteger(rootBefore[0].active_since_ms)).toBe(true)
  expect(rootBefore[0].active_since_ms).toBeGreaterThanOrEqual(0)
  expect(Number.isSafeInteger(rootBefore[0].active_elapsed_ms)).toBe(true)
  expect(rootBefore[0].active_elapsed_ms).toBeGreaterThanOrEqual(0)
  expect(f.db.prepare('SELECT * FROM llm_calls').all()).toEqual([])
  let physicalIdle = false
  const drained = f.owner.whenPhysicalIdle().then(() => { physicalIdle = true })
  await Promise.resolve()
  expect(physicalIdle).toBe(false)
  lateVisible()
  expect(rows()).toEqual(before)
  expect(businessRows()).toEqual(businessBefore)
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  finish({ finishReason: 'stop', usage })
  await drained
  expect(rows()).toEqual(before)
  const businessAfter = businessRows()
  const rootsAfter = businessAfter.generation_roots as { root_action_id: string; active_since_ms: number | null; active_elapsed_ms: number }[]
  const rootAfter = rootsAfter.filter(root => root.root_action_id === view.handle.rootActionId)
  expect(rootAfter).toHaveLength(1)
  expect(rootAfter[0].active_since_ms).toBeNull()
  expect(Number.isSafeInteger(rootAfter[0].active_elapsed_ms)).toBe(true)
  expect(rootAfter[0].active_elapsed_ms).toBeGreaterThanOrEqual(rootBefore[0].active_elapsed_ms)
  expect({ ...businessAfter, generation_roots: rootsAfter.map(root => root.root_action_id === view.handle.rootActionId
    ? { ...root, active_since_ms: rootBefore[0].active_since_ms, active_elapsed_ms: rootBefore[0].active_elapsed_ms }
    : root) }).toEqual(businessBefore)
  // Physical completion may record its diagnostic, but cannot rewrite logical cancellation or domain facts.
  expect(f.db.prepare('SELECT * FROM llm_calls').all()).toEqual([expect.objectContaining({ model_id: 'model',
    purpose: 'planning-feedback', prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, success: 1, error_message: '' })])
  expect(() => f.owner.stageBlueprintFeedback({ ...input, runId: view.handle.runId, attemptId: before.attempt_id, artifactId: before.artifact_id })).toThrow()
  expect(businessRows()).toEqual(businessAfter)
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes + 2)
  expect(BlueprintRepository.getByChapter(1, f.db)).toEqual(originalBlueprint)
  expect(f.spy).toHaveBeenCalledTimes(1)
})

it('accepts only the four fixed author-adoption fields at the blueprint facade without inferring scope or proof', async () => {
  const text = JSON.stringify({ title: 'Candidate', userGuidance: '', notes: '' })
  const f = fixture(async (_request, options) => { options.onVisible({ kind: 'delta', text }); return { finishReason: 'stop', usage } })
  seedFeedbackBlueprints(f)
  const base = f.owner.captureBlueprintFeedback(blueprintScope), generated = await generateBlueprint(f.owner, base.baseId, 'closed-adoption'), candidate = generated.stage()
  const request = { candidateId: candidate.candidateId, idempotencyKey: 'closed-adoption', decision: 'full' as const, text: candidate.text }
  const changes = f.db.prepare('SELECT total_changes()').pluck().get()
  for (const key of ['adoptedRange', 'adoptedFields', 'scope', 'proof', 'output', 'decisionSource']) {
    expect(() => f.owner.adoptBlueprintFeedback({ ...request, [key]: 'not-authorized' })).toThrow('PLANNING_FEEDBACK_PAYLOAD_INVALID')
  }
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
  const receipt = f.owner.adoptBlueprintFeedback(request)
  expect(receipt.decisionSource).toBe('author-action')
  expect(BlueprintRepository.getByChapter(1, f.db)).toEqual({ ...originalBlueprint, title: 'Candidate', userGuidance: '', notes: '' })
})

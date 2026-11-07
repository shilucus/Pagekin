import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
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
  const makeOwner = () => {
    const ownDb = db, ownEpoch = `epoch-${epoch}`
    const sourceDeps = { db: ownDb, projectStorageRoot: storage, globalDataRoot: root,
      readBuiltinPrompt: () => { throw new Error('UNEXPECTED_BUILTIN_PROMPT') } }
    const owner = createMainGenerationOwner({ database: ownDb, projectId, epoch: ownEpoch,
      assertCurrent: () => { if (db !== ownDb || ownEpoch !== `epoch-${epoch}`) throw new Error('GENERATION_EPOCH_STALE') },
      leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
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
  return { root, model, owner, spy, reopen, writeSkill, get db() { return db } }
}

type Owner = ReturnType<typeof createMainGenerationOwner>
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

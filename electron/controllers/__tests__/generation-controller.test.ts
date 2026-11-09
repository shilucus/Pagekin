import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generationOutputContract, type GenerationOwnerChannels, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { PlanningFeedbackChannels } from '../../../src/shared/planning-feedback-ipc'
import type { FinalizedCharacterGenerationChannels } from '../../../src/shared/finalized-character-generation'
import type { FinalizationGenerationChannels } from '../../../src/shared/finalization-generation'
import type { ReviewRevisionGenerationInvokeChannels, ReviewRevisionOperation } from '../../../src/shared/review-revision-generation'
import { createHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief, serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import { ipc } from '../../../src/services/ipc-client'
import { createPlanningFeedbackClient } from '../../../src/services/planning-feedback-client'
import { setActiveProjectSessionContext } from '../../../src/shared/project-session-context'
import { ReviewRepository } from '../../repositories/review-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
import type { ModelProfile, ProjectSessionContext, NovelConfig } from '../../../src/shared/ipc-channels'
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))
import { generationIpcErrorCode, registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import { PlanningFeedbackService } from '../../services/planning-feedback-service'
import { createMainGenerationOwner } from '../../services/main-generation-owner'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../../services/generation-source-binding'
import { readMainGenerationPolicy } from '../../services/main-generation-plan'
import { getProjectDataRoot } from '../../services/project-data-locator'
import { withKnowledgeSourceGate } from '../../services/knowledge-source-gate'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb, onProjectDatabaseBeforeClose } from '../../database'
import { textHash } from '../../repositories/generation-run-repository'
import { KnowledgeBaseUnavailableError, knowledgeBaseLoader } from '../../services/knowledge-base-loader'
import { LegacyVectorMigrationBlockedError } from '../../services/knowledge-base-migration-error'
import { GeneratePlotArchitectureCommand } from '../../../src/services/workflows/commands/architecture.command'
import { ReviewChapterCommand } from '../../../src/services/workflows/commands/review-chapter.command'
import { RefineDraftCommand } from '../../../src/services/workflows/commands/refine-draft.command'
import { useProjectStore } from '../../../src/stores/project-store'
import { useWorkflowStore, type WorkflowContext, type StepCallbacks } from '../../../src/stores/workflow-store'
import { useLocaleStore } from '../../../src/stores/locale-store'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'
import { PLOT_OUTLINE_PROTOCOL, renderPlotOutlineSynopsis } from '../../../src/shared/plot-outline-contract'
import { clearProjectCustomPrompts } from '../../../src/services/prompt-templates'
import { exportPortableProject } from '../../services/project-archive-service'
import { restorePortableProject } from '../../services/project-restore-service'
import { readPortableRuntimeFreeze } from '../../services/portable-runtime-freeze'
import * as performanceDiagnostics from '../../services/performance-diagnostics'

const model: ModelProfile = { id: 'fixture', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 1024, temperature: 0.7, purposes: ['generation'] }
const sender = { isDestroyed: () => false, send: vi.fn() }
let root: string, session: ProjectSessionContext
let openedProject: ReturnType<typeof projectAccess.createProject>
const request: BeginGenerationRequest = { operation: 'draft', uiActionNonce: 'click', modelId: 'fixture',
  selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'], skillStages: [], output: 'visible-text' }
const materialDecision = (prompt = '合成初始提示词'): NonNullable<BeginGenerationRequest['materialDecision']> => ({
  version: 1, verdict: 'admitted', promptHash: textHash(prompt),
  capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 },
  coverage: { required: 1, included: 1, complete: true },
  included: [{ sourceId: 'author:required', revision: 1, contentHash: 'a'.repeat(64), category: 'author', required: true, units: 12 }],
  omitted: [],
})
beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, applyProxyConfig: () => {} })
  registerDatabaseController()
})
beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/t12c')
  fs.mkdirSync(cache, { recursive: true })
  root = fs.mkdtempSync(path.join(cache, 'ipc-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, '合成小说')
  openedProject = project
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.exec("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','合成小说','保留作者事实')")
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
  sender.send.mockClear()
})
afterEach(() => { closeProjectDatabase(); projectAccess.invalidateCurrentSession(); useProjectStore.setState({ currentProject: null }); setActiveProjectSessionContext(null); clearProjectCustomPrompts(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
type TestedChannels = PlanningFeedbackChannels & GenerationOwnerChannels & FinalizedCharacterGenerationChannels & ReviewRevisionGenerationInvokeChannels & FinalizationGenerationChannels
function invoke<C extends keyof TestedChannels>(channel: C, ...args: TestedChannels[C]['args']) {
  return mocks.handlers.get(channel)!({ sender }, ...args, { ...session }) as Promise<TestedChannels[C]['return']>
}
function stream(content = '中文候选', reasoning?: string) {
  const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
    controller.close()
  } }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
describe('planning feedback v1 registered IPC', () => {
  async function completedFeedback(nonce = 'fixture') {
    const base = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const input = { baseId: base.baseId, feedback: 'Keep the facts', constraints: ['Do not alter the setting'] }
    const view = await invoke('planning-feedback:v1:begin', { input, modelId: model.id, uiActionNonce: nonce })
    const result = await invoke('planning-feedback:v1:execute', { handle: view.handle })
    const artifact = result.outcome.receipt.visibleArtifact!
    const stage = { ...input, runId: view.handle.runId, attemptId: artifact.attemptId, artifactId: artifact.artifactId }
    const candidate = await invoke('planning-feedback:v1:stage', stage)
    return { base, input, view, result, stage, candidate }
  }

  function reopenFeedbackProject() {
    closeProjectDatabase()
    projectAccess.invalidateCurrentSession()
    initProjectDatabase(session.projectPath)
    session = { ...session, leaseId: projectAccess.beginSession(openedProject).leaseId }
  }

  function delayedStream() {
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.fn(async () => {
      markStarted()
      await gate
      return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Late fictional result' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
        controller.close()
      } }) }
    })
    vi.stubGlobal('fetch', fetch)
    return { started, release, fetch }
  }

  it('settles an already dispatched A request only in A after switching the view to B', async () => {
    const base = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const input = { baseId: base.baseId, feedback: 'Revise the fictional outline', constraints: [] }
    const run = await invoke('planning-feedback:v1:begin', { input, modelId: model.id, uiActionNonce: 'runtime-a' })
    const runtimeA = projectRuntimeHost.getActiveView()!
    const runtimeEpoch = runtimeA.executionEpoch
    const sessionA = { ...session }
    expect(run.handle.epoch).toBe(sessionA.leaseId)
    const delayed = delayedStream()
    const execution = invoke('planning-feedback:v1:execute', { handle: run.handle })
    const rejected = expect(execution).rejects.toThrow()
    await delayed.started
    expect(() => projectRuntimeHost.releaseIdle(runtimeA)).toThrow('PROJECT_RUNTIME_BUSY')
    const projectB = projectAccess.createProject(root, 'Fiction B')
    createProjectDatabase(projectB.rootPath)
    initProjectDatabase(projectB.rootPath)
    const runtimeB = projectRuntimeHost.getActiveView()!
    runtimeB.database.exec("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fiction B','B original')")
    session = { projectId: projectB.projectId, projectPath: projectB.rootPath, leaseId: projectAccess.beginSession(projectB).leaseId }
    const beforeB = runtimeB.database.prepare('SELECT * FROM project_core').all()
    const beforeA = runtimeA.database.prepare('SELECT * FROM project_core').all()
    const sentBeforeLateResult = sender.send.mock.calls.length
    try {
      await expect(mocks.handlers.get('planning-feedback:v1:execute')!({ sender }, { handle: run.handle }, sessionA)).rejects.toThrow()
      delayed.release()
      await rejected
      expect(delayed.fetch).toHaveBeenCalledTimes(1)
      expect(sender.send).toHaveBeenCalledTimes(sentBeforeLateResult)
      expect(runtimeA.database.prepare('SELECT * FROM project_core').all()).toEqual(beforeA)
      expect(runtimeB.database.prepare('SELECT * FROM project_core').all()).toEqual(beforeB)
      expect(runtimeB.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
      const attempts = runtimeA.database.prepare('SELECT attempt_json FROM generation_attempts').all() as { attempt_json: string }[]
      expect(attempts).toHaveLength(1)
      expect(JSON.parse(attempts[0].attempt_json).status).toBe('unknown')
      projectRuntimeHost.activateView(runtimeA)
      session = { ...sessionA, leaseId: projectAccess.beginSession(openedProject).leaseId }
      expect(runtimeA.executionEpoch).toBe(runtimeEpoch)
      expect(session.leaseId).not.toBe(run.handle.epoch)
      const replay = await invoke('planning-feedback:v1:execute', { handle: run.handle })
      expect(replay.outcome.status).toBe('completed')
      expect(delayed.fetch).toHaveBeenCalledTimes(1)
    } finally {
      delayed.release()
      await execution.catch(() => undefined)
      projectRuntimeHost.activateView(runtimeA)
      session = { ...sessionA, leaseId: projectAccess.beginSession(openedProject).leaseId }
      projectRuntimeHost.releaseIdle(runtimeB)
    }
  })

  it('keeps A busy after cancellation until an abort-ignoring provider physically returns', async () => {
    const base = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const run = await invoke('planning-feedback:v1:begin', { input: { baseId: base.baseId, feedback: 'Fiction', constraints: [] },
      modelId: model.id, uiActionNonce: 'physical-after-cancel' })
    const runtimeA = projectRuntimeHost.getActiveView()!, sessionA = { ...session }
    const delayed = delayedStream()
    const running = invoke('planning-feedback:v1:execute', { handle: run.handle })
    await delayed.started
    await invoke('planning-feedback:v1:cancel', { handle: run.handle })
    const outcome = await running
    expect(outcome.outcome.status).toBe('incomplete')
    const attemptsBeforeLate = runtimeA.database.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts').all() as { attempt_json: string; usage_receipt_json: string }[]
    expect(attemptsBeforeLate).toHaveLength(1)
    expect(JSON.parse(attemptsBeforeLate[0].attempt_json).status).toBe('unknown')
    const closedA = vi.fn()
    const removeCloseListener = onProjectDatabaseBeforeClose(({ database }) => { if (database === runtimeA.database) closedA() })
    let runtimeB: ReturnType<typeof projectRuntimeHost.getActiveView> = null
    try {
      expect(() => projectRuntimeHost.releaseIdle(runtimeA)).toThrow('PROJECT_RUNTIME_BUSY')
      expect(closedA).not.toHaveBeenCalled()
      const projectB = projectAccess.createProject(root, 'Cancelled B')
      createProjectDatabase(projectB.rootPath)
      initProjectDatabase(projectB.rootPath)
      runtimeB = projectRuntimeHost.getActiveView()!
      session = { projectId: projectB.projectId, projectPath: projectB.rootPath, leaseId: projectAccess.beginSession(projectB).leaseId }
      projectRuntimeHost.activateView(runtimeA)
      session = { ...sessionA, leaseId: projectAccess.beginSession(openedProject).leaseId }
      await expect(invoke('planning-feedback:v1:read-run', { handle: run.handle })).rejects.toThrow('GENERATION_OWNER_BUSY')
      expect(() => projectRuntimeHost.releaseIdle(runtimeA)).toThrow('PROJECT_RUNTIME_BUSY')
      expect(closedA).not.toHaveBeenCalled()
      delayed.release()
      await vi.waitFor(async () => {
        await expect(invoke('planning-feedback:v1:read-run', { handle: run.handle })).resolves.toBeDefined()
      })
      expect(runtimeA.database.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts').all()).toEqual(attemptsBeforeLate)
      expect(runtimeB.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
      await expect(invoke('planning-feedback:v1:execute', { handle: run.handle })).resolves.toMatchObject({ outcome: { status: 'incomplete' } })
      expect(delayed.fetch).toHaveBeenCalledTimes(1)
      expect(closedA).not.toHaveBeenCalled()
    } finally {
      delayed.release()
      await running.catch(() => undefined)
      removeCloseListener()
      projectRuntimeHost.activateView(runtimeA)
      session = { ...sessionA, leaseId: projectAccess.beginSession(openedProject).leaseId }
      if (runtimeB) projectRuntimeHost.releaseIdle(runtimeB)
    }
  })

  it('runs the production client through the registered bridge to two candidates and explicit adoption', async () => {
    const fetch = stream('Client candidate')
    const bridge = vi.fn((channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args))
    vi.stubGlobal('window', { aiNovelAPI: { invoke: bridge } })
    setActiveProjectSessionContext(session)
    const client = createPlanningFeedbackClient(session)
    const before = ProjectCoreRepository.get(getProjectDb()!)!
    const base = await client.capture({ target: 'premise' })
    const input = { baseId: base.baseId, feedback: 'Keep the original facts', constraints: ['Keep the setting'] }
    const c1 = await client.generateCandidate({ input, modelId: model.id, uiActionNonce: 'client-one' })
    const c2 = await client.generateCandidate({ input: { ...input, parentCandidateId: c1.candidateId }, modelId: model.id, uiActionNonce: 'client-two' })
    expect(c2.parentCandidateId).toBe(c1.candidateId)
    expect(ProjectCoreRepository.get(getProjectDb()!)).toEqual(before)
    expect((await client.readHistory({ baseId: base.baseId })).candidates).toHaveLength(2)
    await client.adopt({ candidateId: c2.candidateId, idempotencyKey: 'client-adopt', decision: 'full', text: c2.text })
    const after = ProjectCoreRepository.get(getProjectDb()!)!
    expect(after.premise).toBe(c2.text)
    for (const key of Object.keys(before) as (keyof typeof before)[]) if (key !== 'premise') expect(after[key]).toEqual(before[key])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(bridge.mock.calls.some(([channel]) => channel === 'planning-feedback:v1:stage')).toBe(true)
  })
  it.each(['coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile', 'globalGuidance', 'writingStyle', 'premise', 'worldbuilding'] as const)(
    'generates two candidates and adopts only %s', async target => {
      const output = '第一条规则\n第二条规则\n第三条规则\n第四条规则'
      const fetch = stream(output)
      const before = ProjectCoreRepository.get(getProjectDb()!)!
      const base = await invoke('planning-feedback:v1:capture', { target })
      const input = { baseId: base.baseId, feedback: '保留原意', constraints: ['只改目标'], parentCandidateId: undefined }
      const first = await invoke('planning-feedback:v1:begin', { input, modelId: model.id, uiActionNonce: 'first' })
      expect((await invoke('planning-feedback:v1:begin', { input, modelId: model.id, uiActionNonce: 'first' })).handle).toEqual(first.handle)
      await expect(invoke('planning-feedback:v1:begin', { input: { ...input, feedback: 'different' }, modelId: model.id, uiActionNonce: 'first' })).rejects.toThrow()
      const result1 = await invoke('planning-feedback:v1:execute', { handle: first.handle })
      const artifact1 = result1.outcome.receipt.visibleArtifact!
      const c1 = await invoke('planning-feedback:v1:stage', { ...input, runId: first.handle.runId,
        attemptId: artifact1.attemptId, artifactId: artifact1.artifactId })
      const secondInput = { ...input, parentCandidateId: c1.candidateId }
      const second = await invoke('planning-feedback:v1:begin', { input: secondInput, modelId: model.id, uiActionNonce: 'second' })
      const result2 = await invoke('planning-feedback:v1:execute', { handle: second.handle })
      const artifact2 = result2.outcome.receipt.visibleArtifact!
      const c2 = await invoke('planning-feedback:v1:stage', { ...secondInput, runId: second.handle.runId,
        attemptId: artifact2.attemptId, artifactId: artifact2.artifactId })
      expect(c2.parentCandidateId).toBe(c1.candidateId)
      expect(ProjectCoreRepository.get(getProjectDb()!)).toEqual(before)
      expect((await invoke('planning-feedback:v1:list-bases', { target })).map(item => item.baseId)).toContain(base.baseId)
      expect((await invoke('planning-feedback:v1:list-runs', { baseId: base.baseId })).map(item => item.handle.runId)).toContain(second.handle.runId)
      expect((await invoke('planning-feedback:v1:read-run', { handle: second.handle })).input).toEqual(secondInput)
      const request = { candidateId: c2.candidateId, idempotencyKey: 'adopt', decision: 'full' as const, text: c2.text }
      const adopted = await invoke('planning-feedback:v1:adopt', request)
      expect(await invoke('planning-feedback:v1:adopt', request)).toEqual(adopted)
      const after = ProjectCoreRepository.get(getProjectDb()!)!
      expect(after[target]).toBe(output)
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        if (key !== target) expect(after[key]).toEqual(before[key])
      }
      expect((await invoke('planning-feedback:v1:read-history', { baseId: base.baseId })).candidates).toHaveLength(2)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

  it('rejects forged fields and stale sessions without disclosing unknown errors', async () => {
    const base = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const handler = mocks.handlers.get('planning-feedback:v1:begin')!
    await expect(handler({ sender }, { input: { baseId: base.baseId, feedback: '', constraints: [], task: 'forged' }, modelId: model.id, uiActionNonce: 'x' }, session)).rejects.toThrow()
    await expect(handler({ sender }, { input: { baseId: base.baseId, feedback: '', constraints: [] }, modelId: model.id, uiActionNonce: 'x' }, { ...session, leaseId: 'stale' })).rejects.toThrow()
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(generationIpcErrorCode('planning-feedback:v1:stage', new Error('private fictional content'))).toBe('GENERATION_REQUEST_FAILED')
    expect(diagnostic).toHaveBeenCalled()
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private fictional content')
  })

  it('rejects a range base and an unrelated generation handle at the registered boundary', async () => {
    getProjectDb()!.prepare("UPDATE project_core SET synopsis=?,characters_arch='cast',total_chapters=4 WHERE id='main'")
      .run('# Outline\n\n## 第1章：旧一\n旧一正文\n\n## 第2章：旧二\n旧二正文\n\n## 第3章：旧三\n旧三正文\n\n## 第4章：旧四\n旧四正文')
    const internal = new PlanningFeedbackService({ database: getProjectDb()!, projectId: session.projectId, projectPath: session.projectPath,
      assertCurrent: () => {}, assertGenerationBindingCurrent: () => {} })
    const range = internal.captureBase({ kind: 'plot-outline-range', from: 3, to: 4 })
    await expect(invoke('planning-feedback:v1:read-history', { baseId: range.baseId })).rejects.toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
    await expect(invoke('planning-feedback:v1:list-runs', { baseId: range.baseId })).rejects.toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
    await expect(invoke('planning-feedback:v1:begin', { input: { baseId: range.baseId, feedback: '', constraints: [] },
      modelId: model.id, uiActionNonce: 'range' })).rejects.toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
    const unrelated = await invoke('generation:begin', request)
    for (const channel of ['planning-feedback:v1:read-run', 'planning-feedback:v1:execute', 'planning-feedback:v1:cancel'] as const) {
      await expect(invoke(channel, { handle: unrelated.handle })).rejects.toThrow('GENERATION_FEEDBACK_ADMISSION_REQUIRED')
    }
  })

  it('rejects real range candidate and range run IDs at every v1 entry', async () => {
    const db = getProjectDb()!
    db.prepare("UPDATE project_core SET synopsis=?,characters_arch='cast',total_chapters=4 WHERE id='main'")
      .run('# Outline\n\n## 第1章：旧一\n旧一正文\n\n## 第2章：旧二\n旧二正文\n\n## 第3章：旧三\n旧三正文\n\n## 第4章：旧四\n旧四正文')
    const sourceDeps = { db, projectStorageRoot: getProjectDataRoot(session.projectPath), globalDataRoot: mocks.globalRoot,
      readBuiltinPrompt: () => { throw new Error('Unexpected template') } }
    const epoch = session.leaseId
    const owner = createMainGenerationOwner({ database: db, projectId: session.projectId, projectPath: session.projectPath, epoch,
      assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model,
      dispatch: async (_request, options) => {
        options.onVisible({ kind: 'delta', text: '## 第3章：新三\n三正文\n\n## 第4章：新四\n四正文' })
        return { finishReason: 'stop', usage: null }
      },
      buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(sourceDeps,
        { ...selection, projectId: session.projectId, epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
      rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDeps, previous, epoch,
        modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
    try {
      const range = owner.capturePlanningFeedbackBase({ kind: 'plot-outline-range', from: 3, to: 4 })
      const input = { baseId: range.baseId, feedback: 'Revise', constraints: [] }
      const run = owner.beginPlanningFeedback({ input, modelId: model.id, uiActionNonce: 'real-range' })
      const executed = await owner.executePlanningFeedback(run.handle)
      const artifact = executed.outcome.receipt.visibleArtifact!
      const stage = { ...input, runId: run.handle.runId, attemptId: artifact.attemptId, artifactId: artifact.artifactId }
      const candidate = owner.stagePlanningFeedback(stage)
      const field = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
      await expect(invoke('planning-feedback:v1:stage', stage)).rejects.toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
      await expect(invoke('planning-feedback:v1:adopt', { candidateId: candidate.candidateId, idempotencyKey: 'range-adopt',
        decision: 'full', text: candidate.text })).rejects.toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
      await expect(invoke('planning-feedback:v1:relineage', { baseId: field.baseId, sourceCandidateId: candidate.candidateId,
        feedback: '', constraints: [] })).rejects.toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
      await expect(invoke('planning-feedback:v1:begin', { input: { baseId: field.baseId, parentCandidateId: candidate.candidateId,
        feedback: '', constraints: [] }, modelId: model.id, uiActionNonce: 'range-parent' })).rejects.toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
      for (const channel of ['planning-feedback:v1:read-run', 'planning-feedback:v1:execute', 'planning-feedback:v1:cancel'] as const) {
        await expect(invoke(channel, { handle: run.handle })).rejects.toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
      }
    } finally { owner.suspendForProjectClose() }
  })

  it('discovers a completed run after reopening without redispatch and preserves idempotent adoption', async () => {
    const fetch = stream('Recovered candidate')
    const first = await completedFeedback('restart')
    const attempts = getProjectDb()!.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
    reopenFeedbackProject()
    expect((await invoke('planning-feedback:v1:list-bases', { target: 'coreOutline' })).map(item => item.baseId)).toContain(first.base.baseId)
    expect((await invoke('planning-feedback:v1:list-runs', { baseId: first.base.baseId })).map(item => item.handle.runId)).toContain(first.view.handle.runId)
    expect((await invoke('planning-feedback:v1:read-run', { handle: first.view.handle })).input).toEqual(first.input)
    await invoke('planning-feedback:v1:execute', { handle: first.view.handle })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getProjectDb()!.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    const request = { candidateId: first.candidate.candidateId, idempotencyKey: 'restart-adopt', decision: 'full' as const, text: first.candidate.text }
    const receipt = await invoke('planning-feedback:v1:adopt', request)
    expect(await invoke('planning-feedback:v1:adopt', request)).toEqual(receipt)
  })

  it('does not resend a dispatched unknown outcome, including after reopening', async () => {
    const fetch = vi.fn(async () => { throw new Error('synthetic transport failure') })
    vi.stubGlobal('fetch', fetch)
    const base = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const input = { baseId: base.baseId, feedback: 'Focus', constraints: [] }
    const view = await invoke('planning-feedback:v1:begin', { input, modelId: model.id, uiActionNonce: 'unknown' })
    const initial = await invoke('planning-feedback:v1:execute', { handle: view.handle })
    expect(initial.outcome.status).toBe('incomplete')
    const count = fetch.mock.calls.length
    expect(count).toBeGreaterThan(0)
    reopenFeedbackProject()
    const replay = await invoke('planning-feedback:v1:execute', { handle: view.handle })
    expect(replay.outcome.status).toBe('incomplete')
    expect(fetch).toHaveBeenCalledTimes(count)
  })

  it.each(['unchanged', 'changed'] as const)('revalidates an undispatched run after reopening when source is %s', async source => {
    const fetch = stream('Recovered after restart')
    const base = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const view = await invoke('planning-feedback:v1:begin', { input: { baseId: base.baseId, feedback: 'Focus', constraints: [] },
      modelId: model.id, uiActionNonce: `undispatched-${source}` })
    reopenFeedbackProject()
    if (source === 'changed') {
      getProjectDb()!.exec("UPDATE project_core SET core_outline='Changed by author' WHERE id='main'")
      await expect(invoke('planning-feedback:v1:execute', { handle: view.handle })).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
    } else {
      const result = await invoke('planning-feedback:v1:execute', { handle: view.handle })
      expect(result.run.handle.epoch).toBe(session.leaseId)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('cancels before dispatch and rejects subsequent execution', async () => {
    const fetch = stream()
    const base = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const view = await invoke('planning-feedback:v1:begin', { input: { baseId: base.baseId, feedback: '', constraints: [] },
      modelId: model.id, uiActionNonce: 'cancel' })
    await invoke('planning-feedback:v1:cancel', { handle: view.handle })
    await expect(invoke('planning-feedback:v1:execute', { handle: view.handle })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps historical run readable when planning Skill bindings become invalid', async () => {
    const fetch = stream('Historical candidate')
    const first = await completedFeedback('skill-history')
    const pending = await invoke('planning-feedback:v1:begin', { input: first.input, modelId: model.id, uiActionNonce: 'skill-pending' })
    fs.writeFileSync(path.join(getProjectDataRoot(session.projectPath), 'writing-skills.json'), '{invalid fixture')
    const recovered = await invoke('planning-feedback:v1:read-run', { handle: first.view.handle })
    expect(recovered.input).toEqual(first.input)
    expect(recovered.sourceStatus).toBe('conflict')
    expect(recovered.view.artifacts.some(artifact => artifact.text === first.candidate.text)).toBe(true)
    await expect(invoke('planning-feedback:v1:execute', { handle: pending.handle })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps historical output readable when Skill bindings change during source observation', async () => {
    const file = path.join(getProjectDataRoot(session.projectPath), 'writing-skills.json')
    const original = JSON.stringify({ version: 1, bindings: {} })
    fs.writeFileSync(file, original)
    const fetch = stream('Observed historical candidate')
    const first = await completedFeedback('skill-race-history')
    const pending = await invoke('planning-feedback:v1:begin', { input: first.input, modelId: model.id, uiActionNonce: 'skill-race-pending' })
    const attempts = getProjectDb()!.prepare('SELECT attempt_id,attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
    const readFile = fs.readFileSync
    const armRace = () => {
      fs.writeFileSync(file, original)
      let reads = 0
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
        const result = readFile(...args)
        if (String(args[0]) === file && ++reads === 1) fs.writeFileSync(file, `${original}\n`)
        return result
      })
      return { spy, reads: () => reads }
    }
    const historyRace = armRace()
    const recovered = await invoke('planning-feedback:v1:read-run', { handle: first.view.handle })
    historyRace.spy.mockRestore()
    expect(historyRace.reads()).toBeGreaterThanOrEqual(2)
    expect(recovered.input).toEqual(first.input)
    expect(recovered.sourceStatus).toBe('conflict')
    expect(recovered.view.artifacts.some(artifact => artifact.text === first.candidate.text)).toBe(true)
    const executionRace = armRace()
    await expect(invoke('planning-feedback:v1:execute', { handle: pending.handle })).rejects.toThrow('GENERATION_ASSET_CHANGED_DURING_SNAPSHOT')
    executionRace.spy.mockRestore()
    expect(executionRace.reads()).toBeGreaterThanOrEqual(2)
    expect(getProjectDb()!.prepare('SELECT attempt_id,attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps historical output readable when core facts change during source observation', async () => {
    const file = path.join(getProjectDataRoot(session.projectPath), 'writing-skills.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, bindings: {} }))
    const fetch = stream('Historical source race candidate')
    const first = await completedFeedback('source-race-history')
    const pending = await invoke('planning-feedback:v1:begin', { input: first.input, modelId: model.id, uiActionNonce: 'source-race-pending' })
    const db = getProjectDb()!
    const attempts = db.prepare('SELECT attempt_id,attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
    const readFile = fs.readFileSync
    let reads = 0
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      const result = readFile(...args)
      if (String(args[0]) === file && ++reads === 1) db.prepare("UPDATE project_core SET world_setting='Changed during snapshot' WHERE id='main'").run()
      return result
    })
    const recovered = await invoke('planning-feedback:v1:read-run', { handle: first.view.handle })
    spy.mockRestore()
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(recovered.input).toEqual(first.input)
    expect(recovered.sourceStatus).toBe('conflict')
    expect(recovered.view.artifacts.some(artifact => artifact.text === first.candidate.text)).toBe(true)
    await expect(invoke('planning-feedback:v1:execute', { handle: pending.handle })).rejects.toThrow()
    expect(db.prepare('SELECT attempt_id,attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not replace a database handle while its provider request is in flight', async () => {
    const delayed = delayedStream()
    const base = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const view = await invoke('planning-feedback:v1:begin', { input: { baseId: base.baseId, feedback: '', constraints: [] },
      modelId: model.id, uiActionNonce: 'database-replaced' })
    const running = invoke('planning-feedback:v1:execute', { handle: view.handle })
    await delayed.started
    const old = getProjectDb()
    expect(() => closeProjectDatabase()).toThrow('PROJECT_RUNTIME_BUSY')
    expect(getProjectDb()).toBe(old)
    delayed.release()
    await running
    closeProjectDatabase()
    initProjectDatabase(session.projectPath)
    expect(getProjectDb()).not.toBe(old)
    expect(ProjectCoreRepository.get(getProjectDb()!)!.coreOutline).toBe(base.value)
    expect(delayed.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps a cancelled in-flight result out of formal facts', async () => {
    const delayed = delayedStream()
    const base = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const view = await invoke('planning-feedback:v1:begin', { input: { baseId: base.baseId, feedback: '', constraints: [] },
      modelId: model.id, uiActionNonce: 'late-cancel' })
    const running = invoke('planning-feedback:v1:execute', { handle: view.handle })
    await delayed.started
    await invoke('planning-feedback:v1:cancel', { handle: view.handle })
    delayed.release()
    await running.catch(() => undefined)
    expect(ProjectCoreRepository.get(getProjectDb()!)!.coreOutline).toBe(base.value)
    expect((await invoke('planning-feedback:v1:read-history', { baseId: base.baseId })).candidates).toHaveLength(0)
    expect(delayed.fetch).toHaveBeenCalledTimes(1)
  })

  it('discovers portable candidate history but never restores its execution authority', async () => {
    stream('Portable candidate')
    const original = await completedFeedback('portable')
    const archivePath = path.join(root, 'feedback.ainovel'), restoredRoot = path.join(root, 'feedback-restored')
    await exportPortableProject({ sourceProjectRoot: session.projectPath, projectSession: session, targetArchivePath: archivePath,
      attemptParentPath: root, assertCurrentContext: context => { expect(context).toEqual(session) },
      assets: { snapshot: () => ({ files: [], verifyUnchanged: () => {} }) } })
    await restorePortableProject({ archivePath, targetProjectRoot: restoredRoot })
    closeProjectDatabase()
    projectAccess.invalidateCurrentSession()
    const project = projectAccess.probeExistingProject(restoredRoot)
    if (project.kind !== 'manifest' || project.storageFormat !== 'canonical') throw new Error('Expected restored project')
    initProjectDatabase(project.rootPath)
    const lease = projectAccess.beginSession(project)
    session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
    expect(session.projectId).not.toBe(original.base.projectId)
    expect((await invoke('planning-feedback:v1:list-bases', { target: 'coreOutline' })).map(item => item.baseId)).toContain(original.base.baseId)
    const history = await invoke('planning-feedback:v1:read-history', { baseId: original.base.baseId })
    expect(history.candidates).toMatchObject([{ candidate: { candidateId: original.candidate.candidateId, text: original.candidate.text }, state: 'frozen' }])
    expect(getProjectDb()!.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(original.view.handle.runId)).toBe('{}')
    for (const channel of ['planning-feedback:v1:read-run', 'planning-feedback:v1:execute', 'planning-feedback:v1:cancel'] as const) {
      await expect(invoke(channel, { handle: original.view.handle })).rejects.toThrow()
    }
    await expect(invoke('planning-feedback:v1:stage', original.stage)).rejects.toThrow()
    await expect(invoke('planning-feedback:v1:adopt', { candidateId: original.candidate.candidateId, idempotencyKey: 'portable-adopt',
      decision: 'full', text: original.candidate.text })).rejects.toThrow()
    await expect(invoke('planning-feedback:v1:relineage', { baseId: original.base.baseId, sourceCandidateId: original.candidate.candidateId,
      feedback: '', constraints: [] })).rejects.toThrow()
    const fresh = await invoke('planning-feedback:v1:capture', { target: 'coreOutline' })
    const copied = await invoke('planning-feedback:v1:relineage', { baseId: fresh.baseId, sourceCandidateId: original.candidate.candidateId,
      feedback: '', constraints: [] })
    expect(copied).toMatchObject({ baseId: fresh.baseId, parentCandidateId: null, text: original.candidate.text, origin: { kind: 'copied' } })
  })
})
describe('generation public IPC with actual project authority and SQLite', () => {
  it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)('routes %s through the renderer client, registered IPC, owner and actual formal repository', async operation => {
    const body = '林岚到达海港，发现了留下的信。'
    const revisedBody = '林岚到达海港，发现了父亲留下的信。'
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'海港'); INSERT INTO contents(id,body) VALUES(1,''); INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,18)")
    getProjectDb()!.prepare('UPDATE contents SET body=? WHERE id=1').run(body)
    vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args) } })
    const source = { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, content: body }
    const prepare = (op: ReviewRevisionOperation, confirmation?: { reviewSourceId: number; confirmedReviewContent: string }) => ipc.invokeWithProjectSession(session, 'review-revision:prepare', {
      operation: op, draftId: 1, expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(body) },
      authorInputs: [], uiLocale: 'zh-CN', ...confirmation,
    })
    const report = JSON.stringify({ summary: '保持正文来源', items: [{ category: '连贯性', severity: 'pass', description: '正文与计划相符。' }] })
    const runStage = async (op: ReviewRevisionOperation, prepared: Awaited<ReturnType<typeof prepare>>) => {
      stream(op === 'review-chapter' ? report : revisedBody)
      const prompt = '仅处理原稿与作者确认意见。'
      const run = await ipc.invokeWithProjectSession(session, 'generation:begin', { operation: op, uiActionNonce: `明确作者动作:${op}`,
        modelId: prepared.modelId ?? model.id, chapterNumber: 1, selectedDraftIds: [1], selectedFinalizedDraftIds: [],
        promptKeys: [op === 'review-chapter' ? 'consistency_check' : op === 'refine-draft' ? 'refine_chapter' : 'refine_from_review'],
        skillStages: [op === 'review-chapter' ? 'review' : 'refinement'], output: op === 'review-chapter' ? 'structured-data' : 'visible-text',
        reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }],
        ...(prepared.parentRootActionId ? { parentRootActionId: prepared.parentRootActionId } : {}) })
      const confirmation = prepared.context.confirmation
      const reviewBrief = confirmation ? renderHumanConfirmedReviewBrief(confirmation.snapshot, prepared.context.writingLanguage) : ''
      const decision = confirmation
        ? { ...materialDecision(prompt), capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1' as const, admittedUnits: Buffer.byteLength(reviewBrief) },
          included: [{ sourceId: `review:confirmed:${confirmation.reviewSourceId}`, revision: confirmation.reviewSourceId,
            contentHash: textHash(reviewBrief), category: 'author' as const, required: true, units: Buffer.byteLength(reviewBrief) }] }
        : { ...materialDecision(prompt), capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1' as const, admittedUnits: 0 },
          coverage: { required: 0, included: 0, complete: true }, included: [] }
      const bound = await ipc.invokeWithProjectSession(session, 'generation:bind-material-decision', { handle: run.handle, materialDecision: decision })
      expect((await ipc.invokeWithProjectSession(session, 'generation:bind-material-decision', { handle: run.handle, materialDecision: decision })).handle)
        .toEqual(bound.handle)
      await expect(ipc.invokeWithProjectSession(session, 'generation:bind-material-decision', { handle: run.handle,
        materialDecision: { ...decision, promptHash: textHash('被替换的提示词') } })).rejects.toThrow('GENERATION_MATERIAL_DECISION_CONFLICT')
      const result = await ipc.invokeWithProjectSession(session, 'generation:execute', { handle: run.handle, invocationNonce: `实际请求:${op}`, task: {
        purpose: op, output: op === 'review-chapter' ? 'structured-data' : 'visible-text', messages: [{ role: 'user', content: prompt }],
      } })
      return { run, artifact: result.run.artifacts.at(-1)! }
    }
    let confirmation: { reviewSourceId: number; confirmedReviewContent: string } | undefined, originalRoot: string | undefined
    if (operation === 'refine-from-review') {
      const prepared = await prepare('review-chapter'), { run, artifact } = await runStage('review-chapter', prepared)
      const saved = await ipc.invokeWithProjectSession(session, 'review-revision:commit-review', { contextId: prepared.contextId, handle: run.handle,
        artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })
      const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: saved.id, sourceDraft: source, summary: '', authorGuidance: '保留叙述视角',
        items: [{ category: '连贯性', severity: 'warning', description: '检查信件内容', quote: '留下的信', decision: 'apply', origin: 'author' }] })!
      const content = serializeHumanConfirmedReviewSnapshot(snapshot)
      const row = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: source }, getProjectDb())
      confirmation = { reviewSourceId: row.id, confirmedReviewContent: content }; originalRoot = run.handle.rootActionId
    }
    const prepared = await prepare(operation, confirmation), { run, artifact } = await runStage(operation, prepared)
    if (operation !== 'review-chapter') expect(artifact.text).toBe(revisedBody)
    if (originalRoot) expect(run.handle.rootActionId).toBe(originalRoot)
    const reference = { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }
    if (operation !== 'review-chapter') await ipc.invokeWithProjectSession(session, 'generation:compose-visible', run.handle, [artifact.artifactId], artifact.textHash)
    const save = () => operation === 'review-chapter'
      ? ipc.invokeWithProjectSession(session, 'review-revision:commit-review', { contextId: prepared.contextId, handle: run.handle, artifact: reference })
      : ipc.invokeWithProjectSession(session, 'review-revision:commit-revision', { contextId: prepared.contextId, handle: run.handle, expectedCompositionHash: artifact.textHash })
    if (operation === 'review-chapter') {
      const create = ReviewRepository.create
      vi.spyOn(ReviewRepository, 'create').mockImplementationOnce((params, db) => {
        db!.prepare('UPDATE contents SET body=? WHERE id=1').run('保存事务内源稿已变化')
        return create(params, db)
      })
      await expect(save()).rejects.toThrow('SOURCE_DRAFT_CHANGED')
      expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(0)
      expect((await invoke('generation:read', run.handle)).candidates).toHaveLength(1)
    }
    const receipt = await save()
    const table = operation === 'review-chapter' ? 'reviews' : 'revisions'
    expect(receipt).toMatchObject({ success: true, kind: operation === 'review-chapter' ? 'review' : 'revision', source })
    expect(getProjectDb()!.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(1)
    expect(getProjectDb()!.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe(body)
    getProjectDb()!.prepare('UPDATE contents SET body=? WHERE id=1').run('作者后来修改源稿')
    expect(await save()).toEqual(receipt)
    const recovered = await ipc.invokeWithProjectSession(session, 'review-revision:read-recovery', { handle: run.handle })
    expect(recovered).toMatchObject({ sourceStatus: 'conflict', saved: receipt })
    expect((await invoke('generation:read', run.handle)).ledger?.physicalRequests).toBe(originalRoot ? 2 : 1)
  })
  it.each(['zh-CN', 'en-US'] as const)('localizes actual prepare source drift for review and refinement in %s', async uiLocale => {
    getProjectDb()!.exec("INSERT INTO contents(id,body) VALUES(1,'作者已保存的新稿'); INSERT INTO drafts_all(id,chapter_number,version,status,content_id) VALUES(1,1,1,'draft',1)")
    useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath,
      name: '合成小说', sessionLease: session.leaseId, characterStates: '', createdAt: '', updatedAt: '',
      novelConfig: { genre: '', subGenre: '', targetAudience: '', totalChapters: 1, wordsPerChapter: 2000,
        plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '' } } })
    vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args) } })
    const fetch = stream()
    const source = { draftPath: 'ai-novel://draft/1', draftContent: '选择时的旧稿', chapterNumber: 1,
      sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, contentRevision: 1 } }
    await expect(invoke('review-revision:prepare', { operation: 'review-chapter', draftId: 1,
      expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(source.draftContent) },
      authorInputs: [], uiLocale })).rejects.toThrow('GENERATION_REVIEW_SOURCE_CHANGED')
    const context: WorkflowContext = { runId: 'stale-review-source', projectPath: session.projectPath, projectSession: session,
      writingLanguage: 'zh-CN', uiLocale, cancelled: false, data: {} }
    const callbacks: StepCallbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
    const commands = [new ReviewChapterCommand(source), new RefineDraftCommand({ ...source,
      chapterInfo: { projectPath: session.projectPath, chapterNumber: 1, title: '', role: '', purpose: '', keyEvents: '', characters: [] } })]
    const messages = uiLocale === 'zh-CN'
      ? ['源草稿在 AI 审稿期间已变化。审稿报告未保存，请重新打开当前草稿后再次执行 AI 审稿。',
        '源草稿在 AI 修稿期间已变化。修订未保存，请重新打开当前草稿后再次执行 AI 修稿。']
      : ['The source draft changed during AI review. The review report was not saved. Reopen the current draft and run AI review again.',
        'The source draft changed during AI refinement. The revision was not saved. Reopen the current draft and run AI refinement again.']
    for (const [index, command] of commands.entries()) {
      await expect(command.execute({ step: {}, context, callbacks })).rejects.toMatchObject({ code: 'SOURCE_DRAFT_CHANGED', message: messages[index] })
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe('作者已保存的新稿')
  })
  async function finalizedCharacterFixture() {
    const body = '林岚来到北塔。', characterId = 'character-fixture'
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔'); INSERT INTO characters(character_id,name) VALUES('character-fixture','林岚'); INSERT INTO contents(id,body) VALUES(1,'旧稿'); INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
    FinalizationRepository.commit({ finalizationId: 'ipc-finalized', draftId: 1, chapterNumber: 1, chapterTitle: '北塔',
      content: body, contentHash: textHash(body), contentRevision: 1, targetFileName: '第一章.txt' })
    const prepared = await invoke('finalized-character:read-context', { draftId: 1 })
    const fetch = stream(JSON.stringify({ updates: [{ characterId, currentState: { location: '北塔' }, evidence: { start: 0, end: body.length, text: body } }] }))
    const selection: BeginGenerationRequest = { ...request, operation: 'finalized-character-state', chapterNumber: 1, selectedFinalizedDraftIds: [1],
      output: 'structured-data', finalizedCharacterContextId: prepared.contextId, authorInputs: [{ id: 'finalized-character-context', text: JSON.stringify(prepared.context) }] }
    return { prepared, selection, fetch, characterId, slot: { source: prepared.context.source, stepKey: 'character_cards' as const } }
  }
  it('commits finalized character state through the registered context, generation and effect IPC', async () => {
    const f = await finalizedCharacterFixture()
    await expect(invoke('generation:begin', { ...f.selection, finalizedCharacterContextId: 'forged' })).rejects.toThrow('GENERATION_FINALIZATION_ADMISSION_REQUIRED')
    expect(f.fetch).not.toHaveBeenCalled()
    const { view: run } = await invoke('finalization-generation:begin', { slot: f.slot, modelId: model.id })
    const receipt = await invoke('finalization-generation:execute', { handle: run.handle })
    const artifact = receipt.run.artifacts.at(-1)!
    await expect(invoke('finalization-generation:commit', { handle: run.handle,
      artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })).resolves.toMatchObject({ applied: 1, unresolved: [] })
    expect(getProjectDb()!.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('北塔')
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it('reports the registered field-conflict boundary and preserves the durable candidate', async () => {
    const f = await finalizedCharacterFixture(), { view: run } = await invoke('finalization-generation:begin', { slot: f.slot, modelId: model.id })
    const receipt = await invoke('finalization-generation:execute', { handle: run.handle })
    const artifact = receipt.run.artifacts.at(-1)!
    getProjectDb()!.prepare('UPDATE characters SET cs_location=? WHERE character_id=?').run('作者确认的新地点', f.characterId)
    await expect(invoke('finalization-generation:commit', { handle: run.handle,
      artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })).rejects.toThrow('FINALIZED_CHARACTER_FIELD_CONFLICT')
    expect((await invoke('generation:read', run.handle)).candidates).toHaveLength(1)
    expect(getProjectDb()!.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('作者确认的新地点')
  })
  it('routes durable finalized state candidate decisions through the captured project owner', async () => {
    const body = '林岚来到北塔。', characterId = 'candidate-character'
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔'); INSERT INTO characters(character_id,name,cs_location,cs_provenance) VALUES('candidate-character','林岚','作者地点','{\"location\":{\"kind\":\"author\",\"chapterNumber\":0,\"revision\":1}}'); INSERT INTO contents(id,body) VALUES(1,'旧稿'); INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
    FinalizationRepository.commit({ finalizationId: 'ipc-state-candidate', draftId: 1, chapterNumber: 1, chapterTitle: '北塔',
      content: body, contentHash: textHash(body), contentRevision: 1, targetFileName: '第一章.txt' })
    const context = SummaryRepository.readFinalizedCharacterContext(1, { projectId: session.projectId, epoch: session.leaseId }, getProjectDb()!)
    SummaryRepository.saveFinalizedContinuity({ draftId: 1, chapterNumber: 1, chapterNotes: '定稿摘要', facts: [],
      source: context.source, projectionGeneration: context.projectionGeneration }, getProjectDb()!)
    SummaryRepository.commitFinalizedCharacterStates(context, { updates: [{ characterId, currentState: { location: '北塔' },
      evidence: { start: 0, end: body.length, text: body } }], unresolved: [] }, getProjectDb()!)

    const [summary] = await invoke('finalized-character:list-state-candidates')
    expect(summary).toMatchObject({ draftId: 1, characterId, field: 'location' })
    const candidate = await invoke('finalized-character:read-state-candidate', { draftId: summary.draftId, candidateKey: summary.candidateKey })
    const receipt = await invoke('finalized-character:decide-state-candidate', { draftId: summary.draftId,
      candidateKey: candidate.candidateKey, characterId: candidate.characterId, field: candidate.field,
      expectedFieldRevision: candidate.expectedFieldRevision, expectedFieldValueHash: candidate.expectedFieldValueHash,
      operationId: 'ipc-decline-state-candidate', decision: 'decline' })
    expect(receipt).toMatchObject({ decision: 'decline', idempotent: false })
    expect(await invoke('finalized-character:list-state-candidates')).toEqual([])
    expect(getProjectDb()!.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(characterId)).toBe('作者地点')
  })
  const draftInputs = [{ id: 'draft:target-units', text: '10' }]
  async function prepareDraft() {
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'灯塔')")
    const preparation = await invoke('generation:prepare-draft-context', { chapterNumber: 1, modelId: model.id,
      promptKeys: request.promptKeys, skillStages: [], authorInputs: draftInputs, query: '灯塔', selectedDraftIds: [] })
    const selection = { ...request, operation: 'chapter-draft', chapterNumber: 1, authorInputs: draftInputs,
      selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6], preparationId: preparation.preparationId,
      materialDecision: materialDecision() }
    return { preparation, selection }
  }
  async function seedKnowledge() {
    const lance = await import('@lancedb/lancedb')
    const connection = await lance.connect(path.join(getProjectDataRoot(session.projectPath), 'lancedb'))
    const chunks = await connection.createTable('chunks', [{ id: '灯塔片段', docId: '原始资料', text: '灯塔位于旧城北岸。', fileName: '设定资料.md', chunkIndex: 0, totalChunks: 1, corpusKind: 'project-knowledge' }])
    const documents = await connection.createTable('documents', [{ id: '原始资料', fileName: '设定资料.md', chunkCount: 1, corpusKind: 'project-knowledge' }])
    chunks.close(); documents.close(); connection.close()
  }
  it('routes the explicit outline retry through project authority and SQLite without accepting renderer task or nonce', async () => {
    const { selection } = await prepareDraft()
    const prompt = '保留作者事实，规划细纲。'
    selection.materialDecision = { ...materialDecision(), shortOutlinePromptHash: textHash(prompt) }
    let physicalCalls = 0
    const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
      const retried = ++physicalCalls === 2
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: retried ? '完整的细纲。' : '' }, finish_reason: retried ? 'stop' : 'length' }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n`))
      controller.close()
    } }) }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args) } })
    const run = await invoke('generation:begin', selection)
    const failed = await invoke('generation:execute', { handle: run.handle, invocationNonce: 'original',
      task: { purpose: 'chapter-draft-short-outline', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    const failedAttemptId = failed.outcome.receipt.visibleArtifact!.attemptId
    await invoke('generation:pause', run.handle)
    const resumed = await invoke('generation:resume', run.handle)
    const before = getProjectDb()!.prepare('SELECT * FROM generation_attempts WHERE attempt_id=?').get(failedAttemptId)
    const payload = { handle: resumed.handle, failedAttemptId, invocationNonce: 'renderer-chosen', task: { messages: [{ role: 'user', content: '替换原提示' }] } }
    await expect(mocks.handlers.get('generation:retry-draft-short-outline')!({ sender }, payload, { ...session, leaseId: 'stale' })).rejects.toThrow()
    const retried = await ipc.invokeWithProjectSession(session, 'generation:retry-draft-short-outline', payload)
    expect(retried.outcome).toMatchObject({ status: 'completed', content: '完整的细纲。' })
    expect(retried.run.handle.rootActionId).toBe(run.handle.rootActionId)
    expect(getProjectDb()!.prepare('SELECT * FROM generation_attempts WHERE attempt_id=?').get(failedAttemptId)).toEqual(before)
    expect(getProjectDb()!.prepare('SELECT invocation_nonce FROM generation_attempts ORDER BY rowid').pluck().all())
      .toEqual(['original', `draft-short-outline-retry:${failedAttemptId}`])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  async function selectedSourceFixture() {
    const database = getProjectDb()!
    database.exec("INSERT INTO blueprints(chapter_number,title) VALUES(1,'北岸'),(2,'灯塔'),(3,'港口')")
    const create = async (version: number) => {
      const result = await mocks.handlers.get('db:draft-create')!({ sender }, { chapterNumber: 1, version,
        source: 'write', content: `作者前章版本${version}`, wordCount: 7 }, session.projectPath, session) as { success: boolean; id: number }
      expect(result.success).toBe(true)
      return result.id
    }
    const selectedId = await create(1), archivedId = await create(2)
    database.prepare("UPDATE drafts_all SET status='archived' WHERE id=?").run(archivedId)
    const prepareRequest = { chapterNumber: 2, modelId: model.id, promptKeys: ['next_chapter_draft'],
      skillStages: [], authorInputs: draftInputs, query: '灯塔', selectedDraftIds: [selectedId] }
    const selectionFor = (preparationId: string): BeginGenerationRequest => ({ ...request, chapterNumber: 2,
      promptKeys: prepareRequest.promptKeys, authorInputs: draftInputs, selectedDraftIds: [selectedId],
      operation: 'chapter-draft', uiActionNonce: '明确开始', selectedBlueprintChapterNumbers: [2, 3, 4, 5, 6, 7], preparationId,
      materialDecision: materialDecision() })
    const editSource = () => database.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('作者后来改写的前章', selectedId)
    return { selectedId, prepareRequest, selectionFor, editSource }
  }
  async function importKnowledgeText(content: string, fileName: string) {
    const kb = await knowledgeBaseLoader.load()
    return kb.importText(content, fileName, session.projectPath, 'openai', { provider: '', baseUrl: '', apiKey: '' })
  }
  /** 照定稿后处理的顺序：先提交定稿，再导入知识库，最后登记文档身份。 */
  async function finalizeIntoKnowledge(chapterNumber: number, title: string, content: string, link = true) {
    const draftId = DraftRepository.create({ chapterNumber, source: 'write', content, wordCount: content.length })
    const targetFileName = `第${chapterNumber}章 ${title}.txt`
    FinalizationRepository.commit({ finalizationId: `final-${chapterNumber}`, draftId, chapterNumber, chapterTitle: title,
      content, contentHash: textHash(content), contentRevision: 1, targetFileName })
    const imported = await importKnowledgeText(content, targetFileName)
    expect(imported.success).toBe(true)
    const linkDocument = () => FinalizationRepository.linkKnowledgeDocument(draftId, imported.docId!)
    if (link) linkDocument()
    return linkDocument
  }
  it('keeps finalized text of the drafted chapter and later chapters out of the writing knowledge snapshot', async () => {
    const importText = importKnowledgeText
    const finalize = finalizeIntoKnowledge
    await finalize(1, '雾港', '沈砚在雾港听见钟楼的钟声。')
    await finalize(2, '旧信', '沈砚读完旧信，决定夜里去钟楼。')
    await finalize(4, '钟楼暗格', '沈砚在钟楼暗格里找到铜钥匙。')
    await finalize(5, '军火', '钟楼下的货单写着偷运军火。')
    expect((await importText('钟楼建于旧城北岸，共九层。', '钟楼设定.md')).success).toBe(true)
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(3,'夜探')")

    const preparation = await invoke('generation:prepare-draft-context', { chapterNumber: 3, modelId: model.id,
      promptKeys: ['next_chapter_draft'], skillStages: [], authorInputs: draftInputs, query: '钟楼', selectedDraftIds: [] })

    expect(preparation.knowledgeSnapshot.items.map(item => item.fileName).sort())
      .toEqual(['第1章 雾港.txt', '第2章 旧信.txt', '钟楼设定.md'])
  })
  it('rejects a draft whose prepared knowledge holds a later chapter linked after preparation', async () => {
    const fetch = stream()
    await finalizeIntoKnowledge(2, '旧信', '沈砚读完旧信，决定夜里去钟楼。')
    const linkLaterChapter = await finalizeIntoKnowledge(4, '钟楼暗格', '沈砚在钟楼暗格里找到铜钥匙。', false)
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(3,'夜探')")
    const preparation = await invoke('generation:prepare-draft-context', { chapterNumber: 3, modelId: model.id,
      promptKeys: request.promptKeys, skillStages: [], authorInputs: draftInputs, query: '钟楼', selectedDraftIds: [] })
    expect(preparation.knowledgeSnapshot.items.map(item => item.fileName)).toContain('第4章 钟楼暗格.txt')
    linkLaterChapter()

    await expect(invoke('generation:begin', { ...request, operation: 'chapter-draft', chapterNumber: 3, authorInputs: draftInputs,
      selectedBlueprintChapterNumbers: [3, 4, 5, 6, 7, 8], preparationId: preparation.preparationId, materialDecision: materialDecision() }))
      .rejects.toThrow('GENERATION_KNOWLEDGE_SOURCE_STALE')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects a draft when a later chapter is linked while admission waits for the knowledge source gate', async () => {
    const fetch = stream()
    await finalizeIntoKnowledge(2, '旧信', '沈砚读完旧信，决定夜里去钟楼。')
    const linkLaterChapter = await finalizeIntoKnowledge(4, '钟楼暗格', '沈砚在钟楼暗格里找到铜钥匙。', false)
    getProjectDb()!.exec("INSERT INTO blueprints(chapter_number,title) VALUES(3,'夜探')")
    const preparation = await invoke('generation:prepare-draft-context', { chapterNumber: 3, modelId: model.id,
      promptKeys: request.promptKeys, skillStages: [], authorInputs: draftInputs, query: '钟楼', selectedDraftIds: [] })
    let entered!: () => void, release!: () => void
    const holding = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const holder = withKnowledgeSourceGate(getProjectDataRoot(session.projectPath), async () => { entered(); await released })
    await holding

    const begun = invoke('generation:begin', { ...request, operation: 'chapter-draft', chapterNumber: 3, authorInputs: draftInputs,
      selectedBlueprintChapterNumbers: [3, 4, 5, 6, 7, 8], preparationId: preparation.preparationId, materialDecision: materialDecision() })
    linkLaterChapter()
    release()
    await holder

    await expect(begun).rejects.toThrow('GENERATION_KNOWLEDGE_SOURCE_STALE')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  /**
   * 写正文的请求停在知识库门闩上时作者点了取消：取消照产品里的路径走（store 取消 → 主进程取消生成根），
   * inWindow 是同一时刻主进程里发生的事。请求放行后的拒绝原样交给 store，看运行最后记成什么。
   */
  async function draftRejectedAfterCancel(inWindow: (handle: MainGenerationRunHandle) => Promise<unknown>) {
    await seedKnowledge()
    const fetch = stream()
    const { selection } = await prepareDraft()
    const run = await invoke('generation:begin', selection)
    vi.stubGlobal('window', { aiNovelAPI: { invoke: async (channel: string, ...args: unknown[]) => {
      const handler = mocks.handlers.get(channel)
      if (handler) return handler({ sender }, ...args)
      return channel === 'skills:list-user' ? [] : false
    }, on: () => () => {}, once: () => {} } })
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useProjectStore.setState({ currentProject: { id: session.projectId, name: '合成小说', path: session.projectPath, sessionLease: session.leaseId, novelConfig: {} } as never })
    useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {} })
    let entered!: () => void, release!: () => void
    const holding = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const holder = withKnowledgeSourceGate(getProjectDataRoot(session.projectPath), async () => { entered(); await released })
    await holding
    let rejection: unknown
    await useWorkflowStore.getState().startWorkflow({ runId: '取消窗口', type: 'chapter_creation', title: '写第 1 章', projectPath: session.projectPath, projectSession: session,
      steps: [{ name: '写正文', description: '', executor: async (_step, context) => {
        let mainSide: Promise<unknown> | undefined
        context.requestMainGenerationCancellation = async () => { mainSide = inWindow(run.handle) }
        const executing = ipc.invokeWithProjectSession(session, 'generation:execute', { handle: run.handle, invocationNonce: '正文',
          task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: '合成初始提示词' }] } })
        useWorkflowStore.getState().cancelWorkflow('取消窗口')
        await mainSide
        release()
        await holder
        await executing.catch(error => { rejection = error; throw error })
        return undefined
      } }] })
    return { run, fetch, rejection, ended: useWorkflowStore.getState().history[0]! }
  }
  it('作者在请求等知识库校验时取消：运行记已取消，主进程报取消码，不发请求也不阻断生成根', async () => {
    const { run, fetch, rejection, ended } = await draftRejectedAfterCancel(handle => invoke('generation:cancel', handle))

    expect(rejection).toMatchObject({ message: 'GENERATION_ACTION_CANCELLED' })
    expect(ended).toMatchObject({ status: 'cancelled' })
    expect(ended.steps[0]).toMatchObject({ status: 'cancelled' })
    expect(useWorkflowStore.getState().globalLogs.filter(log => log.level === 'error')).toEqual([])
    const view = await invoke('generation:read', run.handle)
    expect(view).toMatchObject({ status: 'cancelled', ledger: { physicalRequests: 0, blockedCode: null } })
    expect(fetch).not.toHaveBeenCalled()
    await expect(invoke('generation:execute', { handle: run.handle, invocationNonce: '取消后再发',
      task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: '合成初始提示词' }] } }))
      .rejects.toThrow('GENERATION_ACTION_CANCELLED')
  })
  it('取消窗口里生成根被真实阻断（没有取消）：运行照常记失败，带原错误码', async () => {
    const { rejection, ended, fetch } = await draftRejectedAfterCancel(async handle => {
      getProjectDb()!.prepare('UPDATE generation_roots SET blocked_code=? WHERE root_action_id=?').run('ROOT_BUDGET_EXHAUSTED', handle.rootActionId)
    })

    expect(rejection).toMatchObject({ message: 'GENERATION_DISPATCH_BLOCKED' })
    expect(ended).toMatchObject({ status: 'failed', error: 'GENERATION_DISPATCH_BLOCKED' })
    expect(ended.steps[0]).toMatchObject({ status: 'failed', error: 'GENERATION_DISPATCH_BLOCKED' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([new KnowledgeBaseUnavailableError(new Error('native missing')),new LegacyVectorMigrationBlockedError('untrusted details')])('preserves known knowledge failure code before drafting',async error=>{
    const fixture=await selectedSourceFixture()
    vi.spyOn(knowledgeBaseLoader,'load').mockRejectedValueOnce(error)
    await expect(invoke('generation:prepare-draft-context',fixture.prepareRequest)).rejects.toThrow(error.code)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  })
  it('requires an issued preparation and rejects source changes before opening a drafting root', async () => {
    const fetch = stream()
    await expect(invoke('generation:begin', { ...request, operation: 'chapter-draft', chapterNumber: 1 })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_REQUIRED')
    const { selection } = await prepareDraft()
    await expect(invoke('generation:begin', { ...selection, preparationId: '伪造凭据' })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_REQUIRED')
    getProjectDb()!.exec("UPDATE project_core SET global_guidance='作者修改后的指导'")
    await expect(invoke('generation:begin', selection)).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  })
  it.each(['edit', 'omit'] as const)('cannot replace a prepared source hidden behind an archived version: %s', async change => {
    const fetch = stream(), fixture = await selectedSourceFixture()
    const prepared = await invoke('generation:prepare-draft-context', fixture.prepareRequest)
    expect(prepared.selectedDrafts[0].content).toBe('作者前章版本1')
    const selection = fixture.selectionFor(prepared.preparationId)
    if (change === 'edit') fixture.editSource()
    else selection.selectedDraftIds = []
    await expect(invoke('generation:begin', selection)).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('admits a chapter draft that carries the sanitized material decision of its own admission', async () => {
    // S10B 步骤 3：写稿入口在 prepare 之后才拿到准入裁决，所以收据必须能与已签发的
    // preparation 并存——它不属于「准备期冻结源」，但必须被冻进运行并折进上下文指纹。
    const fetch = stream(), fixture = await selectedSourceFixture()
    const prepared = await invoke('generation:prepare-draft-context', fixture.prepareRequest)
    const decision = materialDecision()
    const run = await invoke('generation:begin', { ...fixture.selectionFor(prepared.preparationId), materialDecision: decision })
    const binding = JSON.parse(getProjectDb()!.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(run.handle.runId) as string) as {
      sourceManifest: Record<string, unknown>; fingerprint: { contextSnapshotHash: string }; contextSnapshotId: string }
    expect(binding.sourceManifest.materialDecision).toEqual(decision)
    expect(binding.sourceManifest.materialDecisionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(binding.contextSnapshotId).toBe(`context:${binding.fingerprint.contextSnapshotHash}`)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a prepared chapter draft that omits the material decision before opening a root', async () => {
    const fetch = stream(), fixture = await selectedSourceFixture()
    const prepared = await invoke('generation:prepare-draft-context', fixture.prepareRequest)
    const selection = fixture.selectionFor(prepared.preparationId)
    delete selection.materialDecision
    await expect(invoke('generation:begin', selection)).rejects.toThrow('GENERATION_MATERIAL_DECISION_REQUIRED')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('checks the selected source across asynchronous knowledge preparation', async () => {
    const fixture = await selectedSourceFixture(), knowledgeBase = await knowledgeBaseLoader.load()
    vi.spyOn(knowledgeBaseLoader, 'load').mockImplementationOnce(async () => {
      fixture.editSource()
      return knowledgeBase
    })
    await expect(invoke('generation:prepare-draft-context', fixture.prepareRequest)).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
  })
  it('does not begin knowledge capture after its original view loses authority', async () => {
    const fixture = await selectedSourceFixture(), kb = await knowledgeBaseLoader.load()
    const capture = vi.fn(kb.captureWritingKnowledgeSnapshot)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(knowledgeBaseLoader, 'load').mockImplementationOnce(async () => {
      entered()
      await gate
      return { ...kb, captureWritingKnowledgeSnapshot: capture }
    })
    const runtimeA = projectRuntimeHost.getActiveView()!, sessionA = { ...session }
    const pending = invoke('generation:prepare-draft-context', fixture.prepareRequest)
    const rejected = expect(pending).rejects.toThrow()
    await started
    const projectB = projectAccess.createProject(root, 'Knowledge B')
    createProjectDatabase(projectB.rootPath)
    initProjectDatabase(projectB.rootPath)
    const runtimeB = projectRuntimeHost.getActiveView()!
    session = { projectId: projectB.projectId, projectPath: projectB.rootPath, leaseId: projectAccess.beginSession(projectB).leaseId }
    try {
      expect(() => projectRuntimeHost.releaseIdle(runtimeA)).toThrow('PROJECT_RUNTIME_BUSY')
      release()
      await rejected
      expect(capture).not.toHaveBeenCalled()
    } finally {
      release()
      await pending.catch(() => undefined)
      projectRuntimeHost.activateView(runtimeA)
      session = { ...sessionA, leaseId: projectAccess.beginSession(openedProject).leaseId }
      projectRuntimeHost.releaseIdle(runtimeB)
    }
  })
  it('keeps the original root active when a restart preparation is rejected', async () => {
    const fixture = await selectedSourceFixture()
    const prepared = await invoke('generation:prepare-draft-context', fixture.prepareRequest)
    const originalSelection = fixture.selectionFor(prepared.preparationId)
    const run = await invoke('generation:begin', originalSelection)
    const before = getProjectDb()!.prepare('SELECT * FROM generation_roots').all()
    fixture.editSource()
    await expect(invoke('generation:restart', run.handle, { ...originalSelection, uiActionNonce: '明确重新开始' })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
    expect(getProjectDb()!.prepare('SELECT * FROM generation_roots').all()).toEqual(before)
    const context = await invoke('generation:read-context', { handle: run.handle })
    expect(context.selectedDraftIds).toEqual([fixture.selectedId])
    expect(context.selectedDrafts).toBeUndefined()
  })
  it('rejects source edits while knowledge preparation is awaiting its reader', async () => {
    const fetch = stream(), knowledgeBase = await knowledgeBaseLoader.load()
    vi.spyOn(knowledgeBaseLoader, 'load').mockImplementationOnce(async () => {
      getProjectDb()!.exec("UPDATE project_core SET global_guidance='读取资料期间的作者修改'")
      return knowledgeBase
    })
    await expect(prepareDraft()).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
  })
  it.each(['begin', 'restart'] as const)('rechecks prepared knowledge at %s before changing generation roots', async action => {
    await seedKnowledge()
    const fetch = stream(), old = action === 'restart' ? await invoke('generation:begin', request) : null
    const { selection } = await prepareDraft()
    const beforeRoots = getProjectDb()!.prepare('SELECT * FROM generation_roots').all()
    if (old) {
      await expect(invoke('generation:restart', old.handle, { ...selection, uiActionNonce: '重新开始', preparationId: undefined })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_REQUIRED')
      await expect(invoke('generation:restart', old.handle, { ...selection, uiActionNonce: '重新开始', preparationId: '伪造凭据' })).rejects.toThrow('GENERATION_DRAFT_PREPARATION_REQUIRED')
    }
    const lance = await import('@lancedb/lancedb')
    const connection = await lance.connect(path.join(getProjectDataRoot(session.projectPath), 'lancedb'))
    const table = await connection.openTable('chunks')
    await table.update({ where: "id='灯塔片段'", values: { text: '准备后作者修改：灯塔在东岸。' } })
    table.close(); connection.close()
    const operation = old ? invoke('generation:restart', old.handle, { ...selection, uiActionNonce: '重新开始' }) : invoke('generation:begin', selection)
    await expect(operation).rejects.toThrow('GENERATION_KNOWLEDGE_SOURCE_STALE')
    expect(getProjectDb()!.prepare('SELECT * FROM generation_roots').all()).toEqual(beforeRoots)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('persists the main knowledge snapshot and reads a saved acknowledgement without new generation after reopen', async () => {
    await seedKnowledge()
    const fetch = stream('林岚沿旧城门走向灯塔。')
    const { selection, preparation } = await prepareDraft()
    expect(preparation.knowledgeSnapshot.items[0]?.documentId).toBe('原始资料')
    preparation.knowledgeSnapshot.items.length = 0
    const prompt = '保留灯塔设定，继续故事。'
    selection.materialDecision = materialDecision(prompt)
    const run = await invoke('generation:begin', selection)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: '正文', task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    await invoke('generation:compose-visible', run.handle, [result.run.artifacts[0].artifactId], textHash(result.outcome.content), 'draft-visible-v1')
    const commit = { handle: run.handle, expectedCompositionHash: textHash(result.outcome.content), chapterNumber: 1, source: 'write' as const }
    const saved = await invoke('generation:commit-draft', commit)
    expect((await invoke('generation:read-context', { handle: run.handle })).knowledgeSnapshot?.items).toHaveLength(1)
    const projectPath = session.projectPath
    closeProjectDatabase(); projectAccess.invalidateCurrentSession()
    const project = projectAccess.probeExistingProject(projectPath)
    if (project.kind !== 'manifest') throw new Error('合成项目清单缺失')
    initProjectDatabase(projectPath)
    const lease = projectAccess.beginSession(project)
    session = { projectId: project.projectId, projectPath, leaseId: lease.leaseId }
    getProjectDb()!.exec("UPDATE project_core SET global_guidance='保存后作者修改'")
    expect(await invoke('generation:commit-draft', commit)).toEqual(saved)
    expect((await invoke('generation:read-context', { handle: run.handle })).draftSave).toEqual({ kind: 'current', receipt: saved })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('reads changed saved history but rejects all four generation actions before effects', async () => {
    const fetch = stream('林岚沿旧城门走向灯塔。')
    const { selection } = await prepareDraft()
    const run = await invoke('generation:begin', selection)
    const execution = { handle: run.handle, invocationNonce: '正文', task: { purpose: 'chapter-draft',
      output: 'visible-text' as const, messages: [{ role: 'user' as const, content: '合成初始提示词' }] } }
    const result = await invoke('generation:execute', execution)
    await invoke('generation:compose-visible', run.handle, [result.run.artifacts[0].artifactId], textHash(result.outcome.content), 'draft-visible-v1')
    const commit = { handle: run.handle, expectedCompositionHash: textHash(result.outcome.content), chapterNumber: 1, source: 'write' as const }
    const saved = await invoke('generation:commit-draft', commit)
    const db = getProjectDb()!
    db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM drafts WHERE id=?)').run('作者修改后的当前正文。', saved.id)
    const attempts = db.prepare('SELECT * FROM generation_attempts').all()
    expect((await invoke('generation:read-context', { handle: run.handle })).draftSave).toEqual({ kind: 'changed' })
    await expect(invoke('generation:execute', { ...execution, invocationNonce: '不得重发' })).rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    await expect(invoke('generation:retry-draft-short-outline', { handle: run.handle, failedAttemptId: result.run.artifacts[0].attemptId }))
      .rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    await expect(invoke('generation:commit-draft', commit)).rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    await expect(invoke('generation:resume', run.handle)).rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
    expect(db.prepare('SELECT * FROM generation_attempts').all()).toEqual(attempts)
    expect(db.prepare('SELECT body FROM contents JOIN drafts ON drafts.content_id=contents.id WHERE drafts.id=?').pluck().get(saved.id))
      .toBe('作者修改后的当前正文。')
    expect(db.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('retains generated prose when its knowledge source changes before saving', async () => {
    await seedKnowledge()
    stream('林岚在灯塔前停下，仔细检查那扇紧闭的木门。')
    const { selection } = await prepareDraft()
    const prompt = '根据资料继续故事。'
    selection.materialDecision = materialDecision(prompt)
    const run = await invoke('generation:begin', selection)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: '正文', task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } })
    await invoke('generation:compose-visible', run.handle, [result.run.artifacts[0].artifactId], textHash(result.outcome.content), 'draft-visible-v1')
    const lance = await import('@lancedb/lancedb')
    const connection = await lance.connect(path.join(getProjectDataRoot(session.projectPath), 'lancedb'))
    const table = await connection.openTable('chunks')
    await table.update({ where: "id='灯塔片段'", values: { text: '作者修订：灯塔位于东岸。' } })
    table.close(); connection.close()
    await expect(invoke('generation:commit-draft', { handle: run.handle, expectedCompositionHash: textHash(result.outcome.content), chapterNumber: 1, source: 'write' })).rejects.toThrow('GENERATION_KNOWLEDGE_SOURCE_STALE')
    expect((await invoke('generation:read', run.handle)).artifacts[0].text).toBe(result.outcome.content)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
  })
  it.each(['core', 'template'])('rejects a changed %s at the actual formal commit channel and keeps the candidate', async source => {
    stream()
    const template = path.join(getProjectDataRoot(session.projectPath), 'prompts/first_chapter_draft.json')
    fs.mkdirSync(path.dirname(template), { recursive: true })
    fs.writeFileSync(template, JSON.stringify({ key: 'first_chapter_draft', content: '作者模板原文' }))
    const run = await invoke('generation:begin', request)
    await invoke('generation:execute', { handle: run.handle, invocationNonce: 'candidate', task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '中文正文' }] } })
    if (source === 'core') getProjectDb()!.exec("UPDATE project_core SET global_guidance='作者更新约束'")
    else fs.writeFileSync(template, JSON.stringify({ key: 'first_chapter_draft', content: '作者新模板' }))
    const before = ProjectCoreRepository.get()
    const result = await mocks.handlers.get('db:project-core-commit-generated')!({ sender },
      { data: { worldbuilding: '不得覆盖的生成设定' }, generationRunHandle: run.handle }, session.projectPath, session)
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('GENERATION_SOURCE_CHANGED') })
    expect(ProjectCoreRepository.get()).toEqual(before)
    expect((await invoke('generation:read', run.handle)).candidates?.[0].text).toBe('中文候选')
  })
  it('checks live source bytes and writes once in the same actual SQLite transaction', async () => {
    const template = path.join(getProjectDataRoot(session.projectPath), 'prompts/first_chapter_draft.json')
    fs.mkdirSync(path.dirname(template), { recursive: true })
    fs.writeFileSync(template, JSON.stringify({ key: 'first_chapter_draft', content: '原始模板' }))
    const run = await invoke('generation:begin', request), database = getProjectDb()!
    const originalRead = fs.readFileSync, sourceTransactions: boolean[] = []
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === template) sourceTransactions.push(database.inTransaction)
      return originalRead(...args)
    })
    const originalUpdate = ProjectCoreRepository.update
    const writes = vi.spyOn(ProjectCoreRepository, 'update').mockImplementation(data => {
      expect(database.inTransaction).toBe(true)
      return originalUpdate(data)
    })
    expect(await mocks.handlers.get('db:project-core-commit-generated')!({ sender },
      { data: { worldbuilding: '正式设定', narrativePov: 'first_person' }, generationRunHandle: run.handle }, session.projectPath, session)).toEqual({ success: true })
    expect(writes).toHaveBeenCalledTimes(1)
    expect(sourceTransactions.length).toBeGreaterThan(0)
    expect(sourceTransactions.every(Boolean)).toBe(true)
    expect(ProjectCoreRepository.get()).toMatchObject({ worldbuilding: '正式设定', narrativePov: 'first_person' })
  })
  it('combines the synopsis CAS and source guard in one registered transaction', async () => {
    const run = await invoke('generation:begin', request), database = getProjectDb()!, expected = ProjectCoreRepository.get()!
    const original = ProjectCoreRepository.commitSynopsis
    const commit = vi.spyOn(ProjectCoreRepository, 'commitSynopsis').mockImplementation(input => {
      expect(database.inTransaction).toBe(true)
      return original(input)
    })
    const handler = mocks.handlers.get('db:project-core-synopsis-commit')!
    expect(await handler({ sender }, { synopsis: '过期值', expected: { ...expected, synopsis: '错误旧稿' }, generationRunHandle: run.handle }, session.projectPath, session)).toMatchObject({ success: false })
    expect(ProjectCoreRepository.get()?.synopsis).toBe(expected.synopsis)
    expect(await handler({ sender }, { synopsis: '正式大纲', expected, generationRunHandle: run.handle }, session.projectPath, session)).toEqual({ success: true })
    expect(ProjectCoreRepository.get()?.synopsis).toBe('正式大纲')
    commit.mockClear()
    expect(await handler({ sender }, { synopsis: '重复旧候选', expected, generationRunHandle: run.handle }, session.projectPath, session)).toMatchObject({ success: false, error: expect.stringContaining('GENERATION_SOURCE_CHANGED') })
    expect(commit).not.toHaveBeenCalled()
  })
  it('exposes begin, execute, read, list and durable snapshot without leaking model credentials', async () => {
    const fetch = stream('中文候选', '临时推理'), run = await invoke('generation:begin', request)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: 'physical-one',
      task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '中文正文' }] } })
    expect(result.outcome.content).toBe('中文候选')
    expect(result.run.ledger?.physicalRequests).toBe(1)
    expect((await invoke('generation:list'))[0].handle).toEqual(run.handle)
    expect((await invoke('generation:read', run.handle)).artifacts[0].text).toBe('中文候选')
    expect(sender.send).toHaveBeenCalledWith('generation:snapshot', expect.objectContaining({ text: '中文候选', durableRevision: 1, status: 'completed' }))
    expect(sender.send).toHaveBeenCalledWith('generation:reasoning', expect.objectContaining({ ...run.handle, text: '临时推理' }))
    expect(JSON.stringify(result)).not.toContain('临时推理')
    expect(JSON.stringify(result)).not.toContain(model.apiKey)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['0', '1'] as const)('records snapshot application payload bytes only when diagnostics are %s', async enabled => {
    vi.stubEnv('PAGEKIN_PERFORMANCE_BASELINE', enabled)
    const before = performanceDiagnostics.readPerformanceDiagnostics().metrics
    try {
      stream('中文候选', '不计入快照的推理')
      const run = await invoke('generation:begin', request)
      const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: 'diagnostic-payload',
        task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '中文正文' }] } })
      const snapshots = sender.send.mock.calls.filter(([channel]) => channel === 'generation:snapshot')
      expect(snapshots.length).toBeGreaterThan(0)
      const after = performanceDiagnostics.readPerformanceDiagnostics().metrics
      const expectedCalls = enabled === '1' ? snapshots.length : 0
      const expectedBytes = enabled === '1' ? snapshots.reduce((sum, [, payload]) => sum + Buffer.byteLength(JSON.stringify(payload), 'utf8'), 0) : 0
      expect((after['ipc.snapshot.calls']?.sum ?? 0) - (before['ipc.snapshot.calls']?.sum ?? 0)).toBe(expectedCalls)
      expect((after['ipc.snapshot.utf8_bytes']?.sum ?? 0) - (before['ipc.snapshot.utf8_bytes']?.sum ?? 0)).toBe(expectedBytes)
      expect(result.outcome.content).toBe('中文候选')
      expect(JSON.stringify(after)).not.toContain('中文候选')
      expect(JSON.stringify(after)).not.toContain(model.apiKey)
    } finally { vi.unstubAllEnvs() }
  })
  it.each(['count', 'bytes'] as const)('does not change successful snapshot delivery when diagnostic %s recording throws', async failure => {
    const count = performanceDiagnostics.recordPerformanceCount
    const computed = performanceDiagnostics.recordPerformanceComputedMetric
    const counter = vi.spyOn(performanceDiagnostics, 'recordPerformanceCount').mockImplementation((name, amount) => {
      if (failure === 'count' && name === 'ipc.snapshot.calls') throw new Error('private diagnostic failure')
      count(name, amount)
    })
    const bytes = vi.spyOn(performanceDiagnostics, 'recordPerformanceComputedMetric').mockImplementation((name, sample) => {
      if (failure === 'bytes' && name === 'ipc.snapshot.utf8_bytes') throw new Error('private diagnostic failure')
      computed(name, sample)
    })
    stream('中文候选')
    const run = await invoke('generation:begin', request)
    const result = await invoke('generation:execute', { handle: run.handle, invocationNonce: 'diagnostic-failure',
      task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '中文正文' }] } })
    expect(result.outcome.content).toBe('中文候选')
    expect(sender.send).toHaveBeenCalledWith('generation:snapshot', expect.objectContaining({ text: '中文候选', status: 'completed' }))
    expect(failure === 'count' ? counter : bytes).toHaveBeenCalled()
  })
  it('logs an uncoded failure without request arguments before returning the generic code', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(generationIpcErrorCode('generation:commit-draft', new TypeError(`坏收据${'长'.repeat(400)}`))).toBe('GENERATION_REQUEST_FAILED')
    expect(error).toHaveBeenCalledTimes(1)
    const [label, detail] = error.mock.calls[0] as [string, { channel: string; name: string; message: string }]
    expect(label).toBe('[generation] unmapped failure')
    expect(detail).toMatchObject({ channel: 'generation:commit-draft', name: 'TypeError' })
    expect(detail.message.length).toBeLessThanOrEqual(200)
    expect(generationIpcErrorCode('generation:commit-draft', new Error('GENERATION_DRAFT_DEPENDENCY_STALE'))).toBe('GENERATION_DRAFT_DEPENDENCY_STALE')
    expect(error).toHaveBeenCalledTimes(1)
    generationIpcErrorCode('generation:commit-draft', new Error('第一行\n    at 第二行正文不该进日志'))
    const { stack } = error.mock.calls[1][1] as { stack: string }
    expect(stack).not.toContain('第二行正文')
    expect(stack.split('\n').every(line => /^\s+at /u.test(line))).toBe(true)
  })
  it('rejects missing, stale, foreign-root and forged handle authority before touching an owner', async () => {
    const fetch = stream()
    await expect(mocks.handlers.get('generation:begin')!({ sender }, request)).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const invalid of [{ ...session, leaseId: 'forged' }, { ...session, projectPath: mocks.globalRoot }, { ...session, projectId: 'foreign' }]) {
      await expect(mocks.handlers.get('generation:begin')!({ sender }, request, invalid)).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    }
    expect(warn).toHaveBeenCalledWith('[generation] stale project session rejected', { channel: 'generation:begin' })
    const run = await invoke('generation:begin', request)
    await expect(invoke('generation:read', { ...run.handle, rootActionId: 'foreign' })).rejects.toThrow('GENERATION_RUN_IDENTITY_MISMATCH')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('reads safe diagnostic receipts through the production client without another request or ledger write', async () => {
    const fetch = stream('private fictional candidate')
    const run = await invoke('generation:begin', request)
    await invoke('generation:execute', { handle: run.handle, invocationNonce: 'diagnostic-read',
      task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: 'private fictional prompt' }] } })
    const database = getProjectDb()!
    const changes = database.prepare('SELECT total_changes()').pluck().get()
    const bridge = vi.fn((channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args))
    vi.stubGlobal('window', { aiNovelAPI: { invoke: bridge } })
    const diagnostics = await ipc.invokeWithProjectSession(session, 'generation:read-diagnostics', { handle: run.handle })
    // This generic fixture label is outside the domain allowlist and omits trusted usage.
    expect(diagnostics).toMatchObject({ schemaVersion: 1, handle: run.handle, operation: 'unknown', parametersCoverage: 'not_recorded',
      attempts: [{ status: 'unknown', purpose: null, actual: null }] })
    expect(diagnostics.source.fingerprint.skillSnapshotHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(diagnostics.source.modelIdHash).toBe(textHash(model.id))
    expect(diagnostics.source.modelReceiptHash).toMatch(/^[a-f0-9]{64}$/u)
    const encoded = JSON.stringify(diagnostics)
    for (const forbidden of ['private fictional candidate', 'private fictional prompt', model.apiKey, model.baseUrl!, session.projectPath, 'authorInputs', 'replayTask', 'sourceManifest']) {
      expect(encoded).not.toContain(forbidden)
    }
    expect(database.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(bridge).toHaveBeenCalledExactlyOnceWith('generation:read-diagnostics', { handle: run.handle }, session)
  })
  it('requires the current project lease and exact run identity for diagnostics', async () => {
    const fetch = stream()
    const run = await invoke('generation:begin', request)
    const handler = mocks.handlers.get('generation:read-diagnostics')!
    await expect(handler({ sender }, { handle: run.handle })).rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    for (const invalid of [{ ...session, leaseId: 'stale' }, { ...session, projectPath: mocks.globalRoot }, { ...session, projectId: 'foreign' }]) {
      await expect(handler({ sender }, { handle: run.handle }, invalid)).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    }
    for (const invalid of [{ ...run.handle, projectId: 'foreign' }, { ...run.handle, rootActionId: 'foreign' }, { ...run.handle, epoch: 'foreign' }, { ...run.handle, extra: true }]) {
      await expect(handler({ sender }, { handle: invalid }, session)).rejects.toThrow('GENERATION_RUN_IDENTITY_MISMATCH')
    }
    const old = { ...session }
    session = { ...session, leaseId: projectAccess.beginSession(openedProject).leaseId }
    await expect(handler({ sender }, { handle: run.handle }, old)).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([null, [], 42, 'invalid', {}, { handle: null, extra: 'fixture-private-extra' }])('rejects malformed diagnostic requests before owner admission: %j', async payload => {
    const admission = vi.spyOn(projectAccess, 'assertViewContext')
    await expect(mocks.handlers.get('generation:read-diagnostics')!({ sender }, payload, session)).rejects.toThrow('GENERATION_DIAGNOSTICS_INVALID')
    expect(admission).not.toHaveBeenCalled()
  })
  it('does not log corrupt receipt fragments while returning a diagnostic failure', async () => {
    const fetch = stream('fictional candidate')
    const run = await invoke('generation:begin', request)
    await invoke('generation:execute', { handle: run.handle, invocationNonce: 'diagnostic-corrupt',
      task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: 'fictional prompt' }] } })
    const logging = vi.spyOn(console, 'error').mockImplementation(() => {})
    const marker = 'fixture-private-receipt-fragment'
    getProjectDb()!.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE run_id=?').run(`{"${marker}":`, run.handle.runId)
    await expect(invoke('generation:read-diagnostics', { handle: run.handle })).rejects.toThrow('GENERATION_REQUEST_FAILED')
    expect(logging).toHaveBeenCalledExactlyOnceWith('[generation] diagnostic read failed', { channel: 'generation:read-diagnostics', name: 'Error' })
    expect(JSON.stringify(logging.mock.calls)).not.toContain(marker)
    expect(logging.mock.calls[0][1]).not.toHaveProperty('message')
    expect(logging.mock.calls[0][1]).not.toHaveProperty('stack')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('requires source revalidation for public resume and leaves stale candidates readable', async () => {
    stream()
    const run = await invoke('generation:begin', request)
    await invoke('generation:execute', { handle: run.handle, invocationNonce: 'one', task: { purpose: 'draft', output: 'visible-text', messages: [{ role: 'user', content: '中文正文' }] } })
    await invoke('generation:pause', run.handle)
    getProjectDb()!.exec("UPDATE project_core SET global_guidance='作者更新规则'")
    await expect(invoke('generation:resume', run.handle)).rejects.toThrow('GENERATION_RECOVERY_UNAUTHORIZED')
    const read = await invoke('generation:read', run.handle)
    expect(read.candidates?.[0].text).toBe('中文候选')
    expect(read.nonReplayable).toBe(true)
    await invoke('generation:discard-candidate', run.handle, read.candidates![0].artifactId)
    expect((await invoke('generation:read', run.handle)).candidates).toHaveLength(0)
  })
})

describe('chapter outline command through registered main IPC and formal CAS', () => {
  type Crash = 'normal-saved' | 'composition-saved' | 'complete-before-cas' | 'cas-reply-lost'
  function outlineFixture(options: { chapters?: number; crash?: Crash; crashCall?: number; compact?: 'once' | 'fails'; customTemplate?: boolean } = {}) {
    const chapters = options.chapters ?? 3
    const premise = `${'前提原文。'.repeat(40)}前提尾部：证据原件必须留在岛上。`
    const characters = `${'角色原文。'.repeat(40)}角色尾部：林岚左手不能持重物。`
    const world = `${'世界原文。'.repeat(40)}世界尾部：渡口在日落后关闭。`
    const guidance = `${'作者指导。'.repeat(40)}指导尾部：结尾必须归还借来的钥匙。`
    const config: NovelConfig = { genre: '悬疑', subGenre: '', targetAudience: '', totalChapters: chapters, wordsPerChapter: 2000,
      plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '配置硬事实：受害者始终活着。',
      worldSetting: '配置背景：调查只在岛内开展。', goldenFinger: '', protagonistProfile: '', globalGuidance: guidance, writingLanguage: 'zh-CN' }
    getProjectDb()!.prepare('UPDATE project_core SET synopsis=?,premise=?,characters_arch=?,worldbuilding=?,genre=?,total_chapters=?,words_per_chapter=?,global_guidance=?')
      .run('旧正式大纲', premise, characters, world, config.genre, chapters, config.wordsPerChapter, guidance)
    const expected = ProjectCoreRepository.get()!
    if (options.customTemplate) {
      const dir = path.join(getProjectDataRoot(session.projectPath), 'prompts')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'synopsis.json'), JSON.stringify({ key: 'synopsis', name: '作者自定义', content: '以行动和后果组织当前章。', variables: {} }))
    }
    const syncProject = () => useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath,
      name: '合成小说', sessionLease: session.leaseId, novelConfig: config, characterStates: '', createdAt: '', updatedAt: '' } })
    syncProject()
    let fault = options.crash, calls = 0
    const prompts: string[] = [], accepted = (chapter: number) => `## 第${chapter}章：证词${chapter}\n林岚核对证词${chapter}，保留原件，并约定下一步。`
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] }
      const prompt = body.messages.find(message => message.role === 'user')!.content
      prompts.push(prompt)
      const chapter = Number(/本次只写第 (\d+) 章/u.exec(prompt)![1])
      const call = calls++
      const failed = !!options.compact && (call === 0 || options.compact === 'fails')
      const content = failed ? '## 第1–2章：FAILED-CANDIDATE\n不可采用的章组。' : accepted(chapter)
      return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: failed ? 'length' : 'stop' }] })}\n\ndata: [DONE]\n\n`))
        controller.close()
      } }) }
    })
    vi.stubGlobal('fetch', fetch)
    const bridge = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return fs.existsSync(String(args[0]))
      if (channel === 'fs:list-dir') return fs.readdirSync(String(args[0]), { withFileTypes: true }).map(item => ({ name: item.name, path: path.join(String(args[0]), item.name), isDir: item.isDirectory() }))
      if (channel === 'fs:read-file') return { success: true, content: fs.readFileSync(String(args[0]), 'utf8') }
      if (channel === 'fs:read-json') return fs.existsSync(String(args[0])) ? { success: true, data: JSON.parse(fs.readFileSync(String(args[0]), 'utf8')) } : { success: false }
      if (channel === 'fs:write-json') { fs.mkdirSync(path.dirname(String(args[0])), { recursive: true }); fs.writeFileSync(String(args[0]), JSON.stringify(args[1])); return { success: true } }
      if (channel === 'db:project-core-synopsis-commit' && fault === 'complete-before-cas') { fault = undefined; throw new Error('TEST_TRANSPORT_LOST_BEFORE_CAS') }
      const handler = mocks.handlers.get(channel)
      if (!handler) throw new Error(`UNEXPECTED_TEST_TRANSPORT:${channel}`)
      const result = await handler({ sender }, ...args)
      if (channel === 'generation:execute' && fault === 'normal-saved' && calls === (options.crashCall ?? 1)
        || channel === 'generation:compose-visible' && fault === 'composition-saved'
        || channel === 'db:project-core-synopsis-commit' && fault === 'cas-reply-lost') {
        fault = undefined
        throw new Error('TEST_TRANSPORT_REPLY_LOST')
      }
      return result
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke: bridge, on: () => () => {} } })
    const callbacks: StepCallbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn(), replaceText: vi.fn() }
    const execute = (resumeHandle?: MainGenerationRunHandle) => {
      const context: WorkflowContext = { runId: resumeHandle ? 'outline-resumed' : 'outline-original', projectPath: session.projectPath,
        projectSession: session, generationModelId: model.id, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', cancelled: false,
        data: { stepGuidance: { synopsis: '步骤尾部：最终章必须归还借来的钥匙。' } } }
      const command = new GeneratePlotArchitectureCommand(['synopsis'], { expectedProjectPath: session.projectPath, novelConfig: config }, undefined,
        resumeHandle ? { resumeSynopsis: true, resumeHandle } : { synopsisRange: { from: 1, to: chapters } })
      return command.execute({ step: {}, context, callbacks })
    }
    const reopen = () => {
      closeProjectDatabase(); projectAccess.invalidateCurrentSession(); initProjectDatabase(session.projectPath)
      session = { ...session, leaseId: projectAccess.beginSession(openedProject).leaseId }
      syncProject()
    }
    const navigation = () => JSON.parse(fs.readFileSync(path.join(getProjectDataRoot(session.projectPath), 'partial_arch.json'), 'utf8')) as { synopsis_generation_handle: MainGenerationRunHandle; synopsis_incomplete: boolean; synopsis_protocol: string; synopsis_result?: string }
    const target = renderPlotOutlineSynopsis(Array.from({ length: chapters }, (_, index) => accepted(index + 1)).join('\n\n'), chapters, expected)
    return { execute, reopen, navigation, target, accepted, fetch, bridge, prompts, expected, facts: [premise, characters, world, guidance, config.coreOutline, config.worldSetting] }
  }

  it('rebuilds once from complete original facts and accepts six chapters before a single formal CAS', async () => {
    const f = outlineFixture({ chapters: 6, compact: 'once', customTemplate: true })
    const original = ProjectCoreRepository.commitSynopsis
    const commit = vi.spyOn(ProjectCoreRepository, 'commitSynopsis').mockImplementation(input => {
      expect(getProjectDb()!.inTransaction).toBe(true)
      expect(ProjectCoreRepository.get()?.synopsis).toBe('旧正式大纲')
      return original(input)
    })
    await f.execute()
    expect(f.fetch).toHaveBeenCalledTimes(7)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(ProjectCoreRepository.get()?.synopsis).toBe(f.target)
    expect(f.navigation()).toMatchObject({ synopsis_protocol: PLOT_OUTLINE_PROTOCOL, synopsis_incomplete: false })
    expect(f.prompts[1]).toContain('本次从原始冻结事实和已接受前缀重新构建此章')
    for (const prompt of f.prompts) {
      for (const fact of f.facts) expect(prompt.split(fact)).toHaveLength(2)
      expect(prompt).toContain('步骤尾部：最终章必须归还借来的钥匙。')
      expect(prompt).not.toContain('FAILED-CANDIDATE')
    }
    expect(f.prompts[2]).toContain(f.accepted(1))
    const view = await invoke('generation:read', f.navigation().synopsis_generation_handle)
    expect(view.plotOutline?.composition?.artifactIds).toHaveLength(6)
    expect(view.ledger!.tokenLiability).toBeGreaterThan(7 * model.maxTokens!)
  })

  it('saves an author recovery prefix under the current lease without model calls or changing the old responsibility', async () => {
    const f = outlineFixture({ chapters: 3, compact: 'fails' })
    await expect(f.execute()).rejects.toThrow('attempts-exhausted')
    const handle = f.navigation().synopsis_generation_handle
    const attempts = getProjectDb()!.prepare('SELECT attempt_json FROM generation_attempts ORDER BY rowid').all()
    f.reopen()
    const roots = getProjectDb()!.prepare('SELECT * FROM generation_roots').all()
    const context = await invoke('generation:read-context', { handle })
    expect(context.plotOutlineRecovery).toMatchObject({ sourceHandle: handle, leaseEpoch: session.leaseId,
      completeChapters: [], writeState: { kind: 'ready' } })
    expect(context.plotOutlineRecovery!.draft).toContain('FAILED-CANDIDATE')
    const synopsis = renderPlotOutlineSynopsis('## 第1章：作者补齐\n作者核对证词，归还钥匙。', 1, context.plotOutline!.sourceExpected)
    const payload = { synopsis, expected: context.plotOutline!.sourceExpected,
      authorRecovery: { sourceHandle: handle, leaseEpoch: session.leaseId, operationId: 'author-recovery-1', committedRange: { from: 1, to: 1 } } }
    const commit = mocks.handlers.get('db:project-core-synopsis-commit')!
    expect(await commit({ sender }, { ...payload, authorRecovery: { ...payload.authorRecovery, leaseEpoch: handle.epoch } }, session.projectPath, session))
      .toMatchObject({ success: false, error: expect.stringContaining('GENERATION_EPOCH_STALE') })
    const saved = await commit({ sender }, payload, session.projectPath, session)
    expect(saved).toMatchObject({ success: true, receipt: { kind: 'author-edit', committedRange: { from: 1, to: 1 }, remainingRange: { from: 2, to: 3 }, idempotent: false } })
    expect(await commit({ sender }, payload, session.projectPath, session)).toMatchObject({ success: true, receipt: { idempotent: true } })
    expect(ProjectCoreRepository.get()?.synopsis).toBe(synopsis)
    expect(getProjectDb()!.prepare('SELECT attempt_json FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(getProjectDb()!.prepare('SELECT * FROM generation_roots').all()).toEqual(roots)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    await expect(invoke('generation:resume', handle)).rejects.toThrow('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED')
    f.reopen()
    const recovered = await invoke('generation:read-context', { handle })
    expect(recovered.plotOutlineRecovery).toMatchObject({ draft: synopsis, writeState: { kind: 'blocked', reason: 'author-saved' }, saved: { operationId: 'author-recovery-1' } })
    expect(await commit({ sender }, { ...payload, authorRecovery: { ...payload.authorRecovery, leaseEpoch: session.leaseId } }, session.projectPath, session))
      .toMatchObject({ success: true, receipt: { idempotent: true } })
    const archivePath = path.join(root, 'outline-author.zip'), restoredRoot = path.join(root, 'restored-author')
    await exportPortableProject({ sourceProjectRoot: session.projectPath, projectSession: session, targetArchivePath: archivePath,
      attemptParentPath: root, assertCurrentContext: context => { expect(context).toEqual(session) },
      assets: { snapshot: () => ({ files: [], verifyUnchanged: () => {} }) } })
    await restorePortableProject({ archivePath, targetProjectRoot: restoredRoot })
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
    const restored = new Database(path.join(restoredRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      expect(ProjectCoreRepository.get(restored)!.synopsis).toBe(synopsis)
      expect(restored.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(handle.runId)).toBe('{}')
      expect(readPortableRuntimeFreeze(restoredRoot).isFrozen('generation_runs', handle.runId)).toBe(true)
      expect(() => readPortableRuntimeFreeze(restoredRoot).assertMutable('generation_roots', handle.rootActionId)).toThrow('PORTABLE_RUNTIME_FROZEN')
    } finally { restored.close() }
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['normal-saved', 'composition-saved', 'complete-before-cas', 'cas-reply-lost'] as const)('recovers %s through actual command, transport and a new project lease', async crash => {
    const f = outlineFixture({ crash }), commit = vi.spyOn(ProjectCoreRepository, 'commitSynopsis')
    await expect(f.execute()).rejects.toThrow('TEST_TRANSPORT_')
    const handle = f.navigation().synopsis_generation_handle
    const before = await invoke('generation:read', handle)
    expect(before.plotOutline!.cursor.kind).toBe(crash === 'normal-saved' ? 'accept' : crash === 'composition-saved' ? 'request' : 'complete')
    expect(ProjectCoreRepository.get()?.synopsis).toBe(crash === 'cas-reply-lost' ? f.target : '旧正式大纲')
    const attempts = getProjectDb()!.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const binding = getProjectDb()!.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(handle.runId)
    f.reopen()
    expect(session.leaseId).not.toBe(handle.epoch)
    await f.execute(handle)
    expect(ProjectCoreRepository.get()?.synopsis).toBe(f.target)
    expect(f.fetch).toHaveBeenCalledTimes(3)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(f.navigation().synopsis_incomplete).toBe(false)
    if (crash === 'cas-reply-lost') {
      expect(getProjectDb()!.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
      expect(getProjectDb()!.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(handle.runId)).toBe(binding)
      expect(f.bridge.mock.calls.filter(([channel]) => channel === 'generation:cancel')).toHaveLength(0)
      await expect(invoke('generation:execute', { handle, invocationNonce: 'historical-execution', task: { purpose: 'plot-outline:chapter:1:normal', output: 'visible-text', messages: [] } })).rejects.toThrow()
    }
  })

  it('keeps both failed whole-chapter candidates and the formal original after double LENGTH', async () => {
    const f = outlineFixture({ compact: 'fails' }), commit = vi.spyOn(ProjectCoreRepository, 'commitSynopsis')
    await expect(f.execute()).rejects.toThrow('attempts-exhausted')
    expect(ProjectCoreRepository.get()?.synopsis).toBe('旧正式大纲')
    expect(commit).not.toHaveBeenCalled()
    const handle = f.navigation().synopsis_generation_handle
    const view = await invoke('generation:read', handle)
    expect(view.candidates).toHaveLength(2)
    expect(view.plotOutline!.composition).toBeNull()
    f.reopen()
    await expect(f.execute(handle)).rejects.toThrow('attempts-exhausted')
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(ProjectCoreRepository.get()?.synopsis).toBe('旧正式大纲')
  })

  it.each(['third-text', 'other-core', 'prompt', 'model'] as const)('refuses lost-CAS-response recovery when %s changed', async changed => {
    const f = outlineFixture({ crash: 'cas-reply-lost' })
    await expect(f.execute()).rejects.toThrow('TEST_TRANSPORT_REPLY_LOST')
    const handle = f.navigation().synopsis_generation_handle
    const temperature = model.temperature
    if (changed === 'third-text') getProjectDb()!.prepare('UPDATE project_core SET synopsis=?').run('作者第三种正文')
    if (changed === 'other-core') getProjectDb()!.prepare('UPDATE project_core SET worldbuilding=?').run('作者更新世界观')
    if (changed === 'prompt') {
      const dir = path.join(getProjectDataRoot(session.projectPath), 'prompts')
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'synopsis.json'), JSON.stringify({ key: 'synopsis', content: '新模板' }))
    }
    if (changed === 'model') model.temperature = 0.1
    const saved = ProjectCoreRepository.get()!
    try {
      f.reopen()
      await expect(f.execute(handle)).rejects.toThrow(/GENERATION_(?:SOURCE_CHANGED|RECOVERY_UNAUTHORIZED|MODEL_CHANGED)/u)
      expect(ProjectCoreRepository.get()).toEqual(saved)
      expect(f.fetch).toHaveBeenCalledTimes(3)
    } finally { model.temperature = temperature }
  })
})

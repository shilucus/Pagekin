import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { BeginGenerationRequest, GenerationOwnerChannels } from '../../../src/shared/generation-owner-contract'
import type { PreparedReviewRevisionContext, ReviewRevisionGenerationInvokeChannels, ReviewRevisionOperation } from '../../../src/shared/review-revision-generation'
import { createHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief, serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import type { StartWorkflowBatchRequest, WorkflowBatchChannels, WorkflowBatchReference,
  WorkflowBatchReceipt } from '../../../src/shared/workflow-batch-contract'
import { WORKFLOW_BATCH_CHANNELS } from '../../../src/shared/workflow-batch-contract'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { composeDraftVisibleContinuation, DRAFT_VISIBLE_TEXT_VERSION } from '../../../src/shared/draft-visible-text'
import { textHash } from '../../repositories/generation-run-repository'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))

import { registerGenerationController } from '../generation-controller'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'
import { exportPortableProject } from '../../services/project-archive-service'
import { restorePortableProject } from '../../services/project-restore-service'
import { ReviewRepository } from '../../repositories/review-repository'
import { ReviewCycleRepository } from '../../repositories/review-cycle-repository'
import { RevisionRepository } from '../../repositories/revision-repository'

type Channels = WorkflowBatchChannels & GenerationOwnerChannels & ReviewRevisionGenerationInvokeChannels
const model: ModelProfile = { id: 'fictional-batch', name: 'Synthetic batch model', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 2048,
  temperature: 0.7, purposes: ['generation'] }
class Sender extends EventEmitter {
  send = vi.fn()
  private destroyed = false
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}
let root: string, session: ProjectSessionContext, sender: Sender, runtime: ProjectRuntime
let project: ReturnType<typeof projectAccess.createProject>
const prose = [
  'Mara reached the harbor before dawn. A courier stood beside the iron gate, holding a sealed letter. She checked his badge against the number in her notebook and asked him to wait. The tide had carried a broken crate onto the landing. Inside it lay a brass key wrapped in blue cloth. Mara recorded the discovery without opening the letter. Across the channel, a small ferry sounded its bell. She secured the gate, placed the key in her satchel, and followed the courier toward the customs house.',
  'At the observatory, Ivo adjusted a silver dial until the upper lens faced east. Dust rose from the wooden floor as his assistant moved the covered instruments. They needed a clear reading before the clouds arrived. A faint line appeared across the glass, followed by a second mark near the rim. Ivo copied both measurements onto a fresh sheet. His assistant compared them with the previous chart and pointed to an empty column. Together they checked the clock, verified the scale, and began recording another careful observation.',
]
const report = JSON.stringify({ summary: 'Fictional machine review', items: [{ category: 'continuity',
  severity: 'pass', description: 'Compared the supplied fictional source with its frozen plan.' }], goalReviews: [] })
const outputs = ['Fictional outline: deliver the sealed letter.', prose[0]!,
  'Fictional outline: measure the observatory lens.', prose[1]!, report, report]

beforeAll(() => registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
  loadModel: () => model, applyProxyConfig: () => {} }))
beforeEach(() => {
  const base = path.resolve('.runtime/.cache/wbi')
  fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, 'f-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  project = projectAccess.createProject(root, 'A')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  runtime = projectRuntimeHost.getActiveView()!
  getProjectDb()!.exec(`INSERT INTO project_core(id,project_name,global_guidance,writing_language,words_per_chapter,total_chapters)
    VALUES('main','Fictional batch A','Preserve fictional author facts','en-US',100,2);
    INSERT INTO blueprints(chapter_number,title) VALUES(1,'Fictional letter'),(2,'Fictional observatory')`)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: projectAccess.beginSession(project).leaseId }
  sender = new Sender()
})
afterEach(async () => {
  sender?.destroy()
  for (const opened of projectRuntimeHost.getOpenRuntimes()) await projectRuntimeHost.requestClose(opened)
  closeProjectDatabase(); projectAccess.invalidateCurrentSession()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  const base = path.resolve('.runtime/.cache/wbi'), absolute = path.resolve(root)
  if (path.relative(base, absolute).startsWith('..') || fs.lstatSync(absolute).isSymbolicLink()) throw new Error('FIXTURE_CLEANUP_UNSAFE')
  fs.rmSync(absolute, { recursive: true, force: true })
})
function call<C extends keyof Channels>(channel: C, arg: Channels[C]['args'][0], caller = sender, view?: ProjectSessionContext) {
  return mocks.handlers.get(channel)!({ sender: caller }, arg, ...(view ? [{ ...view }] : [])) as Promise<Channels[C]['return']>
}
function request(): StartWorkflowBatchRequest {
  return { operationKey: randomUUID(), modelId: model.id, reviewModelId: model.id, uiLocale: 'en-US',
    intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 100 }, authorInputs: [] }
}
function stream(options: { hold?: boolean; finishReason?: 'stop' | 'unknown'; output?: readonly string[];
  finishReasons?: readonly ('stop' | 'length' | 'unknown')[]; includeUsage?: boolean } = {}) {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let requests = 0
  const prompts: string[] = []
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const ordinal = requests++
    prompts.push(String(init?.body ?? ''))
    if (ordinal === 0) { entered(); if (options.hold) await gate }
    const content = (options.output ?? outputs)[ordinal]
    if (content === undefined) throw new Error('FICTIONAL_RESPONSE_COUNT_EXCEEDED')
    return { ok: true, body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: options.finishReasons?.[ordinal] ?? options.finishReason ?? 'stop' }] })}\n\n`
        + (options.includeUsage ? 'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":12,"total_tokens":62}}\n\n' : '')
        + 'data: [DONE]\n\n'))
      controller.close()
    } }) }
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, started, release, prompts }
}
async function terminal(reference: WorkflowBatchReference): Promise<WorkflowBatchReceipt> {
  let result: WorkflowBatchReceipt | undefined
  await vi.waitFor(async () => {
    result = await call('workflow-batch:v2:read-receipt', { reference })
    expect(result.task.state).not.toBe('ready')
  }, { timeout: 20_000 })
  return result!
}
function counts() {
  return { tasks: runtime.database.prepare('SELECT COUNT(*) FROM workflow_batch_tasks').pluck().get(),
    runs: runtime.database.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get(),
    attempts: runtime.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get(),
    effects: runtime.database.prepare('SELECT COUNT(*) FROM workflow_batch_effects').pluck().get(),
    drafts: runtime.database.prepare('SELECT COUNT(*) FROM drafts').pluck().get(),
    reviews: runtime.database.prepare('SELECT COUNT(*) FROM reviews').pluck().get() }
}

describe('planned batch registered main IPC and real native effects', () => {
  it('continues a batch review through explicit author confirmation, revision, merge and recheck', async () => {
    const quote = 'holding a sealed letter', replacement = 'holding an opened letter'
    const revised = prose[0]!.replace(quote, replacement)
    runtime.database.prepare('UPDATE blueprints SET key_events=? WHERE chapter_number=1').run('Clarify the letter.')
    const warning = JSON.stringify({ summary: 'Fictional review', items: [{ category: 'continuity', severity: 'pass',
      description: 'The rest of the scene is consistent.' }], goalReviews: [{ id: 'ch1:keyEvents:1',
      evidence: [{ quote }], description: 'The letter still needs clarification.', status: 'unmet' }] })
    const batchTransport = stream({ output: [outputs[0]!, prose[0]!, warning] })
    const start = request(); start.intent.range.endChapter = 1
    const issued = await call('workflow-batch:v2:start', start, sender, session)
    const batch = await terminal(issued.reference!)
    expect(batch.task.state).toBe('waiting_review')
    expect(batchTransport.fetch).toHaveBeenCalledTimes(3)
    const savedReview = batch.chapters[0]!.review!
    expect(savedReview).toMatchObject({ success: true, kind: 'review', source: { content: prose[0] } })
    const cycle = runtime.database.prepare('SELECT cycle_id,root_action_id,review_id FROM review_cycles WHERE review_id=?')
      .get(savedReview.id) as { cycle_id: string; root_action_id: string; review_id: number }
    const finding = runtime.database.prepare('SELECT finding_id,target_id FROM review_findings WHERE cycle_id=? AND target_id IS NOT NULL')
      .get(cycle.cycle_id) as { finding_id: string; target_id: string }
    expect(finding).toBeDefined()
    const reviewRun = batch.steps.find(step => step.kind === 'review')!.runId
    const batchHandle = { projectId: project.projectId, epoch: runtime.executionEpoch, rootActionId: cycle.root_action_id, runId: reviewRun }
    const batchRoot = runtime.database.prepare('SELECT root_action_id FROM generation_runs WHERE run_id=?').pluck().get(batch.task.batchRunId) as string
    const rootHandle = { ...batchHandle, rootActionId: batchRoot, runId: batch.task.batchRunId }
    await vi.waitFor(() => expect(() => projectRuntimeHost.assertTaskAvailable(runtime)).not.toThrow(), { timeout: 10_000 })
    await expect(call('generation:read', batchHandle, sender, session)).rejects.toThrow('GENERATION_WORKFLOW_DRIVER_ACCESS_DENIED')
    await expect(call('generation:read', rootHandle, sender, session)).rejects.toThrow('GENERATION_WORKFLOW_DRIVER_ACCESS_DENIED')
    const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: savedReview.id, sourceDraft: savedReview.source, cycleId: cycle.cycle_id,
      summary: 'Author confirms the finding', authorGuidance: 'Keep the scene concise', items: [{ category: 'continuity',
        severity: 'warning', description: 'Clarify the letter.', quote, goalId: 'ch1:keyEvents:1', findingId: finding.finding_id,
        decision: 'apply', origin: 'ai' }] })!
    expect(snapshot.schemaVersion).toBe(2)
    const confirmationContent = serializeHumanConfirmedReviewSnapshot(snapshot)
    const confirmation = runtime.database.transaction(() => {
      const saved = ReviewRepository.create({ baseDraftId: savedReview.source.id, content: confirmationContent,
        expectedSource: savedReview.source }, runtime.database)
      ReviewCycleRepository.commitAuthorConfirmation({ cycleId: cycle.cycle_id, confirmationReviewId: saved.id }, runtime.database)
      return saved
    })()
    expect(runtime.database.prepare('SELECT confirmation_review_id FROM review_cycles WHERE cycle_id=?').pluck().get(cycle.cycle_id)).toBe(confirmation.id)
    const persistedConfirmation = runtime.database.prepare('SELECT c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?')
      .pluck().get(confirmation.id) as string
    expect(JSON.parse(persistedConfirmation)).toMatchObject({ schemaVersion: 2, cycleId: cycle.cycle_id,
      items: [{ findingId: finding.finding_id }] })
    const prepareRevision = await call('review-revision:prepare', { operation: 'refine-from-review', draftId: savedReview.source.id,
      expectedDraft: { chapterNumber: 1, version: savedReview.source.version, status: 'draft', contentHash: textHash(prose[0]!) },
      reviewSourceId: confirmation.id, confirmedReviewContent: confirmationContent, authorInputs: [], uiLocale: 'en-US' }, sender, session)
    expect(prepareRevision.parentRootActionId).toBe(cycle.root_action_id)
    const followupTransport = stream({ output: [revised] })
    async function runStage(operation: ReviewRevisionOperation, prepared: PreparedReviewRevisionContext) {
      const prompt = operation === 'review-chapter' ? 'Recheck the confirmed finding.' : 'Apply the confirmed finding.'
      const run = await call('generation:begin', { operation, uiActionNonce: randomUUID(), modelId: prepared.modelId ?? model.id,
        chapterNumber: 1, selectedDraftIds: [savedReview.source.id], selectedFinalizedDraftIds: [],
        promptKeys: [operation === 'review-chapter' ? 'consistency_check' : 'refine_from_review'],
        skillStages: [operation === 'review-chapter' ? 'review' : 'refinement'],
        output: operation === 'review-chapter' ? 'structured-data' : 'visible-text', reviewRevisionContextId: prepared.contextId,
        authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }],
        ...(prepared.parentRootActionId ? { parentRootActionId: prepared.parentRootActionId } : {}) }, sender, session)
      expect(run.handle.rootActionId).toBe(cycle.root_action_id)
      const brief = prepared.context.confirmation ? renderHumanConfirmedReviewBrief(prepared.context.confirmation.snapshot, prepared.context.writingLanguage) : ''
      const materialDecision: NonNullable<BeginGenerationRequest['materialDecision']> = {
        version: 1, verdict: 'admitted', promptHash: textHash(prompt),
        capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: Buffer.byteLength(brief) },
        coverage: { required: brief ? 1 : 0, included: brief ? 1 : 0, complete: true },
        included: brief ? [{ sourceId: `review:confirmed:${confirmation.id}`, revision: confirmation.id, contentHash: textHash(brief),
          category: 'author', required: true, units: Buffer.byteLength(brief) }] : [], omitted: [] }
      await call('generation:bind-material-decision', { handle: run.handle, materialDecision }, sender, session)
      const result = await call('generation:execute', { handle: run.handle, invocationNonce: randomUUID(), task: {
        purpose: operation, output: operation === 'review-chapter' ? 'structured-data' : 'visible-text',
        messages: [{ role: 'user', content: prompt }] } }, sender, session)
      return { run, artifact: result.run.artifacts.at(-1)! }
    }
    const revision = await runStage('refine-from-review', prepareRevision)
    await mocks.handlers.get('generation:compose-visible')!({ sender }, revision.run.handle, [revision.artifact.artifactId],
      revision.artifact.textHash, undefined, { ...session })
    const revisionCommit = { contextId: prepareRevision.contextId, handle: revision.run.handle,
      expectedCompositionHash: revision.artifact.textHash }
    const savedRevision = await call('review-revision:commit-revision', revisionCommit, sender, session)
    expect(savedRevision).toMatchObject({ kind: 'revision', revisionStatus: 'pending', content: revised })
    expect(runtime.database.prepare('SELECT revision_status,revision_id FROM review_cycles WHERE cycle_id=?').get(cycle.cycle_id))
      .toEqual({ revision_status: 'generated', revision_id: savedRevision.id })
    expect(await call('review-revision:commit-revision', revisionCommit, sender, session)).toEqual(savedRevision)
    const merged = RevisionRepository.mergeIntoDraft({ revisionId: savedRevision.id, targetDraftId: savedReview.source.id,
      expectedDraftContent: prose[0]!, mergedContent: revised, wordCount: countDraftUnits(revised) }, runtime.database)
    expect(merged.reviewCycle).toMatchObject({ cycleId: cycle.cycle_id, mergedHash: textHash(revised), disposition: 'required' })
    const plan = ReviewCycleRepository.planRecheck(cycle.cycle_id, runtime.database)
    expect(plan.disposition).toBe('required')
    const prepareRecheck = await call('review-revision:prepare', { operation: 'review-chapter', draftId: savedReview.source.id,
      expectedDraft: { chapterNumber: 1, version: savedReview.source.version, status: 'revised', contentHash: textHash(revised) },
      reviewCycleId: cycle.cycle_id, expectedMergedHash: textHash(revised), authorInputs: [], uiLocale: 'en-US' }, sender, session)
    expect(prepareRecheck.parentRootActionId).toBe(cycle.root_action_id)
    const recheckTransport = stream({ output: [JSON.stringify({ summary: 'Rechecked', items: [{ findingId: finding.finding_id,
      targetId: finding.target_id, resolved: true, evidenceQuote: replacement, reason: 'The letter is now opened.' }] })] })
    const recheck = await runStage('review-chapter', prepareRecheck)
    const commit = { contextId: prepareRecheck.contextId, handle: recheck.run.handle, artifact: {
      artifactId: recheck.artifact.artifactId, revision: recheck.artifact.revision, textHash: recheck.artifact.textHash } }
    const savedRecheck = await call('review-revision:commit-review', commit, sender, session)
    expect(savedRecheck.reviewCycle).toMatchObject({ cycleId: cycle.cycle_id, recheckCount: 1, disposition: 'completed' })
    expect(savedRecheck.source.content).toBe(revised)
    expect(await call('review-revision:commit-review', commit, sender, session)).toEqual(savedRecheck)
    expect(followupTransport.fetch).toHaveBeenCalledTimes(1)
    expect(recheckTransport.fetch).toHaveBeenCalledTimes(1)
    expect(runtime.database.prepare("SELECT COUNT(*) FROM drafts WHERE status='finalized'").pluck().get()).toBe(0)
    expect(runtime.database.prepare('SELECT COUNT(*) FROM review_cycles WHERE confirmation_review_id=?').pluck().get(confirmation.id)).toBe(1)
    await expect(call('generation:read', batchHandle, sender, session)).rejects.toThrow('GENERATION_WORKFLOW_DRIVER_ACCESS_DENIED')
    await expect(call('generation:read', rootHandle, sender, session)).rejects.toThrow('GENERATION_WORKFLOW_DRIVER_ACCESS_DENIED')
  })
  it('reuses the original short-outline retry nonce only after a genuinely settled truncated attempt', async () => {
    const transport = stream({ output: ['Truncated fictional outline', outputs[0]!, prose[0]!, report],
      finishReasons: ['length', 'stop', 'stop', 'stop'], includeUsage: true })
    const start = request(); start.intent.range.endChapter = 1
    const issued = await call('workflow-batch:v2:start', start, sender, session)
    const receipt = await terminal(issued.reference!)
    expect(receipt.task.blockedCode).toBeNull()
    expect(receipt.task.state).toBe('waiting_review')
    expect(receipt.chapters[0]!.draftSave).toMatchObject({ kind: 'current', receipt: { content: prose[0] } })
    const steps = receipt.steps.filter(step => step.kind === 'outline')
    expect(steps.map(step => step.slot)).toEqual([0, 1])
    const retry = runtime.database.prepare("SELECT invocation_nonce FROM workflow_batch_steps WHERE kind='outline' AND slot=1").pluck().get()
    expect(retry).toBe(`draft-short-outline-retry:${steps[0]!.effect!.receiptAttemptId}`)
    expect(receipt.attempts.every(attempt => attempt.status === 'settled')).toBe(true)
    expect(transport.fetch).toHaveBeenCalledTimes(4)
  })

  it.each([false, true])('keeps accepted continuation lineage with low-progress recovery=%s', async recovery => {
    const words = prose[0]!.split(' '), prefix = words.slice(0, 30).join(' '), ending = words.slice(30).join(' ')
    const discarded = 'A brief discarded fragment.'
    const expected = composeDraftVisibleContinuation(prefix, ending, DRAFT_VISIBLE_TEXT_VERSION)
    const transport = stream({ output: recovery ? [outputs[0]!, prefix, discarded, ending, report] : [outputs[0]!, prefix, ending, report],
      finishReasons: recovery ? ['stop', 'length', 'length', 'stop', 'stop'] : ['stop', 'length', 'stop', 'stop'] })
    const start = request(); start.intent.range.endChapter = 1
    const issued = await call('workflow-batch:v2:start', start, sender, session)
    const receipt = await terminal(issued.reference!)
    expect(receipt.task.blockedCode).toBeNull()
    expect(receipt.task.state).toBe('waiting_review')
    expect(receipt.chapters[0]!.draftSave).toMatchObject({ kind: 'current', receipt: { content: expected } })
    expect(receipt.chapters[0]!.review?.source.content).toBe(expected)
    expect(receipt.steps.filter(step => step.kind === 'compose').map(step => step.slot)).toEqual(recovery ? [0, 2] : [0, 1])
    const continuations = runtime.database.prepare("SELECT input_json FROM workflow_batch_steps WHERE kind='continue' ORDER BY slot").pluck().all() as string[]
    expect(continuations.map(value => (JSON.parse(value) as { task: { purpose: string } }).task.purpose))
      .toEqual(recovery ? ['chapter-draft-continuation', 'chapter-draft-no-progress-recovery'] : ['chapter-draft-continuation'])
    expect(expected).not.toContain(discarded)
    const composition = runtime.database.prepare("SELECT input_json FROM workflow_batch_steps WHERE kind='compose' ORDER BY slot DESC LIMIT 1").pluck().get() as string
    expect((JSON.parse(composition) as { artifactIds: string[] }).artifactIds).toHaveLength(2)
    expect(transport.fetch).toHaveBeenCalledTimes(recovery ? 5 : 4)
    expect(receipt.steps.every(step => step.effect !== null)).toBe(true)
  })

  it('accepts condense through the original multi-artifact composition lineage', async () => {
    const transport = stream({ output: [outputs[0]!, [prose[0], prose[0], prose[0]].join('\n\n'), prose[0]!, report],
      finishReasons: ['stop', 'length', 'stop', 'stop'] })
    const start = request(); start.intent.range.endChapter = 1
    const issued = await call('workflow-batch:v2:start', start, sender, session)
    const receipt = await terminal(issued.reference!)
    expect(receipt.task.blockedCode).toBeNull()
    expect(receipt.task.state).toBe('waiting_review')
    expect(receipt.chapters[0]!.draftSave).toMatchObject({ kind: 'current', receipt: { content: prose[0] } })
    expect(receipt.chapters[0]!.review?.source.content).toBe(prose[0])
    expect(receipt.steps.filter(step => step.kind === 'compose').map(step => step.slot)).toEqual([0, 8])
    expect(receipt.steps.filter(step => step.kind === 'condense')).toHaveLength(1)
    const composition = runtime.database.prepare("SELECT input_json FROM workflow_batch_steps WHERE kind='compose' AND slot=8").pluck().get() as string
    expect((JSON.parse(composition) as { artifactIds: string[] }).artifactIds).toHaveLength(2)
    expect(transport.fetch).toHaveBeenCalledTimes(4)
  })

  it.each(['length', 'invalid'] as const)('uses the original ordinary-review replacement stage for %s output', async kind => {
    const partial = kind === 'length' ? '{"summary":"visible fictional partial' : 'Invalid fictional report.'
    const transport = stream({ output: [outputs[0]!, prose[0]!, partial, report],
      finishReasons: ['stop', 'stop', kind === 'length' ? 'length' : 'stop', 'stop'] })
    const start = request(); start.intent.range.endChapter = 1
    const issued = await call('workflow-batch:v2:start', start, sender, session)
    const receipt = await terminal(issued.reference!)
    expect(receipt.task.state).toBe('waiting_review')
    expect(receipt.chapters[0]!.review).toMatchObject({ success: true, kind: 'review', source: { content: prose[0] } })
    expect(receipt.steps.filter(step => step.kind === (kind === 'length' ? 'review' : 'review_rebuild')).map(step => step.slot))
      .toEqual(kind === 'length' ? [0, 1] : [0])
    if (kind === 'length') {
      expect(JSON.parse(transport.prompts[3]!).messages[1].content).toContain('Rebuild and return the complete JSON from the beginning')
      expect(JSON.parse(transport.prompts[3]!).messages[1].content).toContain(partial)
      expect(receipt.steps.some(step => step.kind === 'review_rebuild')).toBe(false)
    }
    expect(transport.fetch).toHaveBeenCalledTimes(4)
  })

  it('does not turn two truncated ordinary reviews into another rebuild or a successful review', async () => {
    const transport = stream({ output: [outputs[0]!, prose[0]!, '{"summary":"first', '{"summary":"second'],
      finishReasons: ['stop', 'stop', 'length', 'length'] })
    const start = request(); start.intent.range.endChapter = 1
    const issued = await call('workflow-batch:v2:start', start, sender, session)
    const receipt = await terminal(issued.reference!)
    expect(receipt.task.state).toBe('blocked')
    expect(receipt.chapters[0]!.draftSave.kind).toBe('current')
    expect(receipt.chapters[0]!.review).toBeNull()
    expect(receipt.steps.some(step => step.kind === 'review_rebuild')).toBe(false)
    expect(counts().reviews).toBe(0)
    expect(transport.fetch).toHaveBeenCalledTimes(4)
  })

  it('runs every draft before ordinary reviews while the author views another book', async () => {
    for (const body of prose) expect(countDraftUnits(body)).toBeGreaterThanOrEqual(70)
    const start = request(), transport = stream({ hold: true })
    const issued = await call('workflow-batch:v2:start', start, sender, session)
    const reference = issued.reference!
    try {
      await transport.started
      expect((await call('workflow-batch:v2:start', start, sender, session)).reference).toEqual(reference)
      const b = projectAccess.createProject(root, 'B')
      createProjectDatabase(b.rootPath)
      const runtimeB = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareRetainedOpen(b))
      projectRuntimeHost.activateView(runtimeB); projectAccess.beginSession(b)
      await expect(call('workflow-batch:v2:start', start, sender, session)).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
      await expect(call('workflow-batch:v2:read-receipt', { reference }, new Sender())).rejects.toThrow('WORKFLOW_BATCH_CAPABILITY_REQUIRED')
      transport.release()
      const receipt = await terminal(reference)
      expect(receipt.task.state).toBe('waiting_review')
      expect(receipt.chapters.map(chapter => chapter.chapterNumber)).toEqual([1, 2])
      for (const [index, chapter] of receipt.chapters.entries()) {
        expect(chapter.draftSave).toMatchObject({ kind: 'current', receipt: { content: prose[index] } })
        expect(chapter.review).toMatchObject({ success: true, kind: 'review' })
      }
      expect(receipt.steps).toHaveLength(12)
      expect(receipt.steps.every(step => step.effect !== null)).toBe(true)
      expect(transport.fetch).toHaveBeenCalledTimes(6)
      expect(counts()).toEqual({ tasks: 1, runs: 5, attempts: 6, effects: 12, drafts: 2, reviews: 2 })
      const sequence = runtime.database.prepare('SELECT chapter_number,role,kind FROM workflow_batch_steps ORDER BY rowid').all() as {
        chapter_number: number; role: string; kind: string
      }[]
      const reviewStart = sequence.findIndex(step => step.role === 'review')
      expect(sequence.filter(step => step.kind === 'draft_commit')).toHaveLength(2)
      expect(sequence.every((step, index) => step.kind !== 'draft_commit' || index < reviewStart)).toBe(true)
      expect(runtimeB.database.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
      expect(runtime.database.prepare("SELECT COUNT(*) FROM drafts_all WHERE status='finalized'").pluck().get()).toBe(0)
      expect(runtime.database.prepare('SELECT COUNT(*) FROM review_cycles WHERE confirmation_review_id IS NOT NULL').pluck().get()).toBe(0)
      projectRuntimeHost.activateView(runtime)
      session = { ...session, leaseId: projectAccess.beginSession(project).leaseId }
      const history = await call('workflow-batch:v2:read-history', { taskId: reference.taskId }, sender, session)
      expect(history).toEqual(receipt)
      expect((await call('workflow-batch:v2:resume', { reference })).receipt).toEqual(receipt)
      expect(transport.fetch).toHaveBeenCalledTimes(6)
    } finally { transport.release() }
  })

  it('registers only the explicit batch routes and rejects malformed view or capability payloads before writes', async () => {
    const start = request(), before = counts()
    expect([...mocks.handlers.keys()].filter(channel => channel.startsWith('workflow-batch:'))).toEqual([...WORKFLOW_BATCH_CHANNELS])
    await expect(call('workflow-batch:v2:start', start)).rejects.toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    await expect(mocks.handlers.get('workflow-batch:v2:start')!({ sender }, start, null))
      .rejects.toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    await expect(mocks.handlers.get('workflow-batch:v2:start')!({ sender }, { ...start, apiKey: 'fictional' }, session))
      .rejects.toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    await expect(mocks.handlers.get('workflow-batch:v2:start')!({ sender }, start, session, 'extra'))
      .rejects.toThrow('WORKFLOW_BATCH_PAYLOAD_INVALID')
    const reference = { projectId: project.projectId, taskId: randomUUID(), revision: 1 }
    await expect(call('workflow-batch:v2:resume', { reference })).rejects.toThrow('WORKFLOW_BATCH_CAPABILITY_REQUIRED')
    expect(counts()).toEqual(before)
  })

  it('rolls back the batch root and publishes no capability when task issuance fails', async () => {
    const start = request(), transport = stream()
    runtime.database.exec("CREATE TRIGGER reject_batch_issue BEFORE INSERT ON workflow_batch_tasks BEGIN SELECT RAISE(ABORT,'fictional-private-write-failure'); END")
    await expect(call('workflow-batch:v2:start', start, sender, session)).rejects.toThrow('GENERATION_REQUEST_FAILED')
    expect(counts()).toEqual({ tasks: 0, runs: 0, attempts: 0, effects: 0, drafts: 0, reviews: 0 })
    expect(transport.fetch).not.toHaveBeenCalled()
    runtime.database.exec('DROP TRIGGER reject_batch_issue')
    const retry = await call('workflow-batch:v2:start', start, sender, session)
    expect((await terminal(retry.reference!)).task.state).toBe('waiting_review')
  })

  it('rejects a changed operation request without creating a second run or model request', async () => {
    const start = request(), transport = stream({ hold: true })
    const issued = await call('workflow-batch:v2:start', start, sender, session)
    try {
      await transport.started
      const before = counts()
      await expect(call('workflow-batch:v2:start', { ...start, intent: { ...start.intent, targetUnits: 200 } }, sender, session))
        .rejects.toThrow('WORKFLOW_BATCH_IDEMPOTENCY_CONFLICT')
      expect(counts()).toEqual(before)
      expect(transport.fetch).toHaveBeenCalledTimes(1)
    } finally { transport.release() }
    expect((await terminal(issued.reference!)).task.state).toBe('waiting_review')
  })

  it('preserves a genuinely unknown delivery and never resends its persisted model step', async () => {
    const transport = stream({ finishReason: 'unknown' })
    const start = request(), issued = await call('workflow-batch:v2:start', start, sender, session)
    expect((await terminal(issued.reference!)).task.state).toBe('blocked')
    const before = counts()
    for (let index = 0; index < 2; index++) {
      const refreshed = await call('workflow-batch:v2:start', start, sender, session)
      await call('workflow-batch:v2:resume', { reference: refreshed.reference! })
      expect((await terminal(issued.reference!)).task.state).toBe('blocked')
    }
    expect(counts()).toEqual(before)
    expect(transport.fetch).toHaveBeenCalledTimes(1)
    expect(before.drafts).toBe(0)
  })

  it.each(['pause', 'cancel'] as const)('keeps the physical slot through ignored abort after %s', async action => {
    const transport = stream({ hold: true })
    const issued = await call('workflow-batch:v2:start', request(), sender, session)
    try {
      await transport.started
      const changed = await call(`workflow-batch:v2:${action}`, { reference: issued.reference! })
      expect(changed.receipt.task.state).toBe(action === 'pause' ? 'paused' : 'cancelled')
      await expect(call('workflow-batch:v2:start', request(), sender, session)).rejects.toThrow('WORKFLOW_BATCH_TASK_BUSY')
      if (action === 'pause') await expect(call('workflow-batch:v2:resume', { reference: changed.reference! }))
        .rejects.toThrow('WORKFLOW_BATCH_TASK_BUSY')
      expect(transport.fetch).toHaveBeenCalledTimes(1)
    } finally { transport.release() }
    await vi.waitFor(() => expect(() => projectRuntimeHost.assertTaskAvailable(runtime)).not.toThrow(), { timeout: 10_000 })
    expect((await call('workflow-batch:v2:read-receipt', { reference: issued.reference! })).task.state)
      .toBe(action === 'pause' ? 'paused' : 'cancelled')
    expect(counts().drafts).toBe(0)
    expect(transport.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the native database open through true close until ignored abort physically drains', async () => {
    const transport = stream({ hold: true })
    await call('workflow-batch:v2:start', request(), sender, session)
    try {
      await transport.started
      await expect(projectRuntimeHost.requestClose(runtime, { timeoutMs: 0 })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
      expect(runtime.database.open).toBe(true)
      expect(transport.fetch).toHaveBeenCalledTimes(1)
      expect(counts().drafts).toBe(0)
      transport.release()
      await projectRuntimeHost.requestClose(runtime)
      expect(runtime.database.open).toBe(false)
      expect(transport.fetch).toHaveBeenCalledTimes(1)
    } finally { transport.release() }
  })

  it('reopens the original project under a new execution epoch and reconciles an unknown step without resending', async () => {
    const transport = stream({ finishReason: 'unknown' })
    const issued = await call('workflow-batch:v2:start', request(), sender, session)
    const before = await terminal(issued.reference!)
    expect(before.task.state).toBe('blocked')
    await vi.waitFor(() => expect(() => projectRuntimeHost.assertTaskAvailable(runtime)).not.toThrow(), { timeout: 10_000 })
    const oldEpoch = runtime.executionEpoch
    await projectRuntimeHost.requestClose(runtime)
    initProjectDatabase(project.rootPath)
    runtime = projectRuntimeHost.getActiveView()!
    expect(runtime.executionEpoch).not.toBe(oldEpoch)
    session = { ...session, leaseId: projectAccess.beginSession(project).leaseId }
    const saved = counts()
    const rebound = await call('workflow-batch:v2:reauthorize', { taskId: issued.reference!.taskId }, sender, session)
    expect(rebound.reference).not.toBeNull()
    await call('workflow-batch:v2:resume', { reference: rebound.reference! })
    const after = await terminal(rebound.reference!)
    expect(after.task.state).toBe('blocked')
    expect(after.attempts).toEqual(before.attempts)
    expect(counts()).toEqual(saved)
    expect(transport.fetch).toHaveBeenCalledTimes(1)
    expect(counts().drafts).toBe(0)
  })

  it.each([false, true])('reads actual portable driver history over IPC without granting execution, unknown=%s', async unknown => {
    const transport = stream(unknown ? { finishReason: 'unknown' } : {})
    const issued = await call('workflow-batch:v2:start', request(), sender, session)
    const original = await terminal(issued.reference!)
    expect(original.task.state).toBe(unknown ? 'blocked' : 'waiting_review')
    await vi.waitFor(() => expect(() => projectRuntimeHost.assertTaskAvailable(runtime)).not.toThrow(), { timeout: 10_000 })
    await projectRuntimeHost.requestClose(runtime)
    const archivePath = path.join(root, 'history.ainovel'), attemptParentPath = path.join(root, 'exports')
    fs.mkdirSync(attemptParentPath)
    await exportPortableProject({ sourceProjectRoot: project.rootPath, projectSession: session,
      targetArchivePath: archivePath, attemptParentPath, assertCurrentContext: () => {},
      assets: { snapshot: () => ({ files: [], verifyUnchanged: () => {} }) } })
    const targetProjectRoot = path.join(root, 'copy')
    const restored = await restorePortableProject({ archivePath, targetProjectRoot })
    const copiedProject = projectAccess.probeExistingProject(targetProjectRoot)
    if (copiedProject.kind !== 'manifest') throw new Error('FICTIONAL_COPY_MANIFEST_REQUIRED')
    project = copiedProject
    initProjectDatabase(targetProjectRoot)
    runtime = projectRuntimeHost.getActiveView()!
    session = { projectId: restored.targetProjectId, projectPath: targetProjectRoot, leaseId: projectAccess.beginSession(project).leaseId }
    const before = counts(), changes = runtime.database.prepare('SELECT total_changes()').pluck().get()
    const fetchCalls = transport.fetch.mock.calls.length
    const history = await call('workflow-batch:v2:read-history', { taskId: issued.reference!.taskId }, sender, session)
    expect(history.nonReplayable).toBe(true)
    expect(history.task.state).toBe(original.task.state)
    expect(history.attempts.map(attempt => attempt.artifactId)).toEqual(original.attempts.map(attempt => attempt.artifactId))
    const rebound = await call('workflow-batch:v2:reauthorize', { taskId: issued.reference!.taskId }, sender, session)
    expect(rebound.reference).toBeNull()
    expect(rebound.receipt).toEqual(history)
    const copiedReference = { ...issued.reference!, projectId: restored.targetProjectId }
    await expect(call('workflow-batch:v2:resume', { reference: copiedReference })).rejects.toThrow('WORKFLOW_BATCH_CAPABILITY_REQUIRED')
    await expect(call('workflow-batch:v2:resume', { reference: issued.reference! })).rejects.toThrow()
    expect((await call('workflow-batch:v2:read-history', { taskId: issued.reference!.taskId }, sender, session))).toEqual(history)
    expect(counts()).toEqual(before)
    expect(runtime.database.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
    expect(transport.fetch).toHaveBeenCalledTimes(fetchCalls)
  })

  it('pauses on sender destruction without freeing an abort-ignoring physical request early', async () => {
    const transport = stream({ hold: true })
    await call('workflow-batch:v2:start', request(), sender, session)
    try {
      await transport.started
      sender.destroy()
      expect(runtime.database.prepare('SELECT state FROM workflow_batch_tasks').pluck().get()).toBe('paused')
      expect(() => projectRuntimeHost.assertTaskAvailable(runtime)).toThrow()
      expect(transport.fetch).toHaveBeenCalledTimes(1)
    } finally { transport.release() }
    await vi.waitFor(() => expect(() => projectRuntimeHost.assertTaskAvailable(runtime)).not.toThrow(), { timeout: 10_000 })
    expect(counts().drafts).toBe(0)
    expect(transport.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not commit a draft after author facts change during a physical request', async () => {
    const transport = stream({ hold: true })
    const issued = await call('workflow-batch:v2:start', request(), sender, session)
    try {
      await transport.started
      runtime.database.exec("UPDATE project_core SET global_guidance='Changed fictional author fact' WHERE id='main'")
    } finally { transport.release() }
    expect((await terminal(issued.reference!)).task.state).toBe('blocked')
    expect(counts().drafts).toBe(0)
    expect(transport.fetch).toHaveBeenCalledTimes(1)
    const step = runtime.database.prepare("SELECT input_hash,input_json FROM workflow_batch_steps WHERE kind='outline'").get() as {
      input_hash: string; input_json: string
    }
    expect(step.input_hash).toBe(textHash(step.input_json))
  })
})

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { draftShortOutlineBlock } from '../../../src/shared/draft-short-outline.ts'
import { DRAFT_VISIBLE_TEXT_VERSION } from '../../../src/shared/draft-visible-text.ts'
import { buildWorkflowDriverScenarioRequest, runWorkflowDriverScenario, runWorkflowDriverUnknownScenario,
  WORKFLOW_DRIVER_SCENARIOS } from '../workflow-driver-scenario.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const clone = value => structuredClone(value)

// This fixture verifies the scenario's assertions and cleanup, not the production owner or transport.
function fixture(options = {}) {
  const projects = [], calls = [], cores = new Map()
  let active, lease = 0, requests = 0, task, request, completion, review, stream, prepareCount = 0
  const fake = { chats: [], streamLog: [],
    replyReview(value) { review = value }, streamProse(value) { stream = value },
    gate: { waiting: 0, held: false,
      hold() { this.held = true },
      release() {
        if (!this.held) return
        this.held = false; this.waiting = 0
        if (!task || task.task.state !== 'ready') return
        if (options.blockAfterDetach) { task.task.state = 'blocked'; task.task.blockedCode = 'FICTIONAL_BLOCKED'; task.task.revision++; return }
        const outline = review(request.recipe.outlineTask.messages.find(message => message.role === 'user').content)
        const body = stream.chunks.join(''), contentHash = hash(body)
        requests++
        fake.chats.push({ messages: clone(request.recipe.outlineTask.messages) }, { messages: request.recipe.baseDraftTask.messages.map(message => message.role === 'user'
          ? { ...message, content: `${message.content}\n\n${draftShortOutlineBlock('en-US', outline)}` } : clone(message)) })
        fake.streamLog.push({ count: stream.chunks.length })
        task.task.state = 'waiting_review'
        task.attempts = [{ attemptId: 'attempt-outline', status: 'settled', artifactId: 'artifact-outline' },
          { attemptId: 'attempt-draft', status: 'settled', artifactId: 'artifact-draft' }]
        task.steps.forEach((step, index) => { step.effect = { receiptKind: ['model', 'model', 'composition', 'draft_commit'][index],
          receiptAttemptId: index ? 'attempt-draft' : 'attempt-outline', contentHash: index ? contentHash : hash(outline) } })
        task.composition = { runId: task.task.runId, artifactIds: ['artifact-draft'], text: body, textHash: contentHash, algorithm: DRAFT_VISIBLE_TEXT_VERSION }
        task.draftSave = { kind: 'current', receipt: { success: true, id: 1, version: 1, content: body, contentHash } }
        if (options.missingEffect) task.steps[2].effect = null
        if (options.extraRequest) requests++
        if (options.wrongSavedBody) task.draftSave.receipt.content += ' Wrong body.'
        completion = clone(task)
      },
    },
  }
  const reference = () => ({ projectId: task.task.projectId, taskId: task.task.taskId, revision: task.task.revision })
  function requireView(session) {
    if (!options.allowStale && (session.projectId !== active.projectId || session.leaseId !== active.leaseId)) throw new Error('GENERATION_PROJECT_SESSION_STALE')
  }
  function requireReference(value, checkRevision = true) {
    if (!options.allowWrongProject && value.projectId !== task.task.projectId) throw new Error('WORKFLOW_DRIVER_CAPABILITY_REQUIRED')
    if (value.taskId !== task.task.taskId || checkRevision && value.revision !== task.task.revision) throw new Error('WORKFLOW_DRIVER_REVISION_CONFLICT')
  }
  const invoke = async (_page, channel, ...args) => {
    calls.push({ channel, args: clone(args), active: active?.projectId })
    if (channel === 'project:create') {
      if (options.createError) return { success: false, error: options.createError }
      const project = { projectId: `project-${projects.length}`, projectPath: `/fixture/${projects.length}` }
      projects.push(project); cores.set(project.projectPath, '')
      return { success: true, ...project }
    }
    if (channel === 'project-runtime:v1:open-view') {
      const project = projects.find(item => item.projectPath === args[0])
      active = { ...project, leaseId: `lease-${++lease}` }
      return { success: true, project: { sessionLease: active.leaseId, novelConfig: { genre: 'Mystery', subGenre: '',
        targetAudience: 'Adults', totalChapters: 2, wordsPerChapter: 80, plotStructure: 'three_act', narrativePOV: 'third_limited' } } }
    }
    if (channel === 'llm:save-model') return { success: true }
    if (channel === 'project:update-config') { requireView(args[3]); cores.set(args[2], args[1].novelConfig.coreOutline); return { success: true } }
    if (channel === 'db:blueprint-upsert') { requireView(args[2]); return { success: true } }
    if (channel === 'fs:write-file') {
      requireView(args[3]); expect(args[0].replaceAll('\\', '/')).toBe(`${args[2]}/.ai-novel/writing-skills.json`)
      expect(JSON.parse(args[1])).toEqual({ version: 1, bindings: { drafting: 'builtin:long-form-continuity' } })
      return { success: true, commitState: 'committed' }
    }
    if (channel === 'db:project-core-update') { requireView(args[2]); cores.set(args[1], args[0].coreOutline); return { success: true } }
    if (channel === 'db:project-core-get') { requireView(args[1]); return { coreOutline: cores.get(args[0]) } }
    if (channel === 'db:close') { requireView(args[1]); if (options.failClose) throw new Error('FICTIONAL_CLOSE_FAILED'); return { success: true } }
    if (channel === 'workflow-driver:v1:prepare-context') {
      expect(args).toHaveLength(2); requireView(args[1]); prepareCount++
      return { preparationId: 'preparation-original', selectedDrafts: [], knowledgeSnapshot: {
        version: 1, state: 'empty', storageState: 'absent', query: args[0].request.query, topK: 5,
        canonicalRevision: null, documentsRevision: null, items: [],
      } }
    }
    if (channel === 'workflow-driver:v1:start') {
      expect(args).toHaveLength(2); requireView(args[1]); request = args[0]
      expect(request.selection.preparationId).toBe('preparation-original')
      expect(request.selection.materialDecision.promptHash).toBe(hash(request.recipe.baseDraftTask.messages.find(message => message.role === 'user').content))
      expect(request.selection.materialDecision.shortOutlinePromptHash).toBe(hash(request.recipe.outlineTask.messages.find(message => message.role === 'user').content))
      task = { task: { taskId: 'task-original', projectId: active.projectId, runId: 'run-original', revision: 1,
        template: 'prepared-first-chapter-v1', state: 'ready', blockedCode: null, createdAt: 1, updatedAt: 1 },
      steps: ['outline', 'draft', 'compose', 'commit'].map((kind, ordinal) => ({ stepId: `step-${ordinal}`, commandId: `command-${ordinal}`,
        kind, ordinal, inputHash: null, effect: null })), attempts: [{ attemptId: 'attempt-outline', status: 'dispatch-marked', artifactId: null }],
      composition: null, draftSave: { kind: 'absent' }, nonReplayable: true }
      requests++; fake.gate.waiting = options.extraGate ? 2 : 1
      return { reference: reference(), receipt: clone(task) }
    }
    if (channel === 'workflow-driver:v1:read-history') {
      expect(args).toHaveLength(2); requireView(args[1]); expect(args[0].taskId).toBe(task.task.taskId)
      return clone(task)
    }
    if (channel === 'workflow-driver:v1:reauthorize') {
      expect(args).toHaveLength(2); requireView(args[1]); expect(args[0].taskId).toBe(task.task.taskId)
      if (task.task.state === 'waiting_review' || task.task.state === 'cancelled') return { reference: options.resign ? reference() : null, receipt: clone(task) }
      return { reference: reference(), receipt: clone(task) }
    }
    if (channel.startsWith('workflow-driver:v1:')) {
      expect(args).toHaveLength(1); requireReference(args[0].reference, channel !== 'workflow-driver:v1:read-receipt')
      if (channel === 'workflow-driver:v1:read-receipt') return clone(task)
      if (channel === 'workflow-driver:v1:pause') {
        task.task.state = 'paused'; task.task.revision++; task.attempts[0].status = 'unknown'
        return { reference: reference(), receipt: clone(task) }
      }
      if (channel === 'workflow-driver:v1:resume') {
        if (options.redispatch) requests++
        task.task.revision += 2; task.task.state = 'blocked'; task.task.blockedCode = 'WORKFLOW_DRIVER_RECEIPT_NOT_COMMITTED'
        return { reference: reference(), receipt: clone(task) }
      }
      if (channel === 'workflow-driver:v1:cancel') {
        task.task.state = 'cancelled'; task.task.blockedCode = null; task.task.revision++
        return { reference: reference(), receipt: clone(task) }
      }
    }
    throw new Error(`UNEXPECTED_TEST_CHANNEL:${channel}`)
  }
  const context = { app: {}, page: {}, roots: { projects: '/fixture' }, invoke, fake }
  const dependencies = { grantDirectory: async () => ({ grantId: 'directory-grant' }), requestCount: async () => requests,
    awaitGate: async (gate, waiting) => expect(Boolean(gate.waiting)).toBe(waiting) }
  return { context, dependencies, calls, projects, get requests() { return requests }, get completion() { return completion },
    get task() { return clone(task) }, get prepareCount() { return prepareCount } }
}

describe('workflow driver registered-IPC scenario assertions (mock orchestration only)', () => {
  it('registers two bounded scenarios without real-model qualification', () => {
    expect(Object.keys(WORKFLOW_DRIVER_SCENARIOS)).toEqual(['workflow-driver-v1', 'workflow-driver-unknown-v1'])
    for (const scenario of Object.values(WORKFLOW_DRIVER_SCENARIOS)) expect(scenario).toMatchObject({ model: true, shell: 'stage', timeout: 120000 })
  })
  it('requires two physical requests, all four effects and a committed draft while A has no view', async () => {
    const f = fixture(), receipt = await runWorkflowDriverScenario(f.context, f.dependencies)
    expect(receipt).toMatchObject({ guardedFetchAttempts: 2, completedSteps: 4, state: 'waiting_review',
      detachedWorkContinued: true, resubscribedFromReceipt: true, writingSkillBound: 'builtin:long-form-continuity',
      wordContractSatisfied: true, viewDetach: 'open-B-detaches-A-not-runtime-close' })
    expect(receipt.notCovered).toContain('full-production-workflow-002')
    expect(f.requests).toBe(2)
    expect(f.completion.steps.every(step => step.effect)).toBe(true)
    const readsBeforeReattach = f.calls.filter(call => call.channel === 'workflow-driver:v1:read-receipt' && call.active === f.projects[1].projectId)
    expect(readsBeforeReattach.length).toBeGreaterThanOrEqual(2)
    expect(f.calls.filter(call => call.channel === 'db:close')).toHaveLength(2)
  })
  it('pauses an unknown request, rereads its receipt, refuses replay on resume and cancels it', async () => {
    const f = fixture(), receipt = await runWorkflowDriverUnknownScenario(f.context, f.dependencies)
    expect(f.calls.filter(call => call.channel === 'project:create').map(call => call.args[0].name))
      .toEqual(['Driver U A', 'Driver U B'])
    expect(receipt).toMatchObject({ guardedFetchAttempts: 1, pausedInFlight: true, unknownNotReplayed: true,
      resumedFromReceipts: true, cancelled: true })
    expect(f.requests).toBe(1)
    expect(f.task.task.state).toBe('cancelled')
    expect(f.task.attempts).toEqual([{ attemptId: 'attempt-outline', status: 'unknown', artifactId: null }])
    expect(f.task.steps.every(step => step.effect === null)).toBe(true)
    expect(new Set(f.calls.filter(call => call.channel.startsWith('workflow-driver:v1:')).map(call => call.channel))).toEqual(new Set([
      'workflow-driver:v1:prepare-context', 'workflow-driver:v1:start', 'workflow-driver:v1:read-receipt', 'workflow-driver:v1:pause',
      'workflow-driver:v1:read-history', 'workflow-driver:v1:reauthorize', 'workflow-driver:v1:resume', 'workflow-driver:v1:cancel',
    ]))
  })
  it.each([runWorkflowDriverScenario, runWorkflowDriverUnknownScenario])(
    'uses durable and server-arrival proof while response headers are held: %s', async run => {
      const f = fixture()
      const requestCount = async () => {
        if (f.context.fake.gate.waiting) throw new Error('RESPONSE_HEADER_LOG_NOT_YET_COMPLETE')
        return f.requests
      }
      await run(f.context, { ...f.dependencies, requestCount })
    })
  it.each([runWorkflowDriverScenario, runWorkflowDriverUnknownScenario])(
    'rejects more than one server arrival while held: %s', async run => {
      const f = fixture({ extraGate: true })
      await expect(run(f.context, f.dependencies)).rejects.toThrow('held workflow must have exactly one received request')
    })
  it.each([
    ['allowStale', true, undefined], ['allowWrongProject', true, undefined],
    ['missingEffect', true, 'registration is not completion evidence'],
    ['extraRequest', true, 'workflow did not use exactly outline and draft requests'],
    ['resign', true, undefined], ['wrongSavedBody', true, undefined],
    ['blockAfterDetach', true, 'workflow blocked: FICTIONAL_BLOCKED'],
  ])('rejects the %s regression instead of recording completion', async (key, value, message) => {
    const f = fixture({ [key]: value })
    const result = runWorkflowDriverScenario(f.context, f.dependencies)
    if (message) await expect(result).rejects.toThrow(message)
    else await expect(result).rejects.toThrow()
    expect(f.context.fake.gate.waiting).toBe(0)
    expect(f.calls.filter(call => call.channel === 'db:close')).toHaveLength(2)
  })
  it('rejects a redispatched unknown attempt', async () => {
    const f = fixture({ redispatch: true })
    await expect(runWorkflowDriverUnknownScenario(f.context, f.dependencies)).rejects.toThrow('unknown attempt was redispatched')
    expect(f.task.task.state).toBe('cancelled')
    expect(f.context.fake.gate.waiting).toBe(0)
  })
  it('retains creation failures and does not close projects it never opened', async () => {
    const f = fixture({ createError: 'FICTIONAL_CREATE_FAILED' })
    await expect(runWorkflowDriverScenario(f.context, f.dependencies)).rejects.toThrow('FICTIONAL_CREATE_FAILED')
    expect(f.calls.some(call => call.channel === 'db:close')).toBe(false)
  })
  it('preserves scenario and cleanup failures independently', async () => {
    const f = fixture({ missingEffect: true, failClose: true })
    await expect(runWorkflowDriverScenario(f.context, f.dependencies)).rejects.toMatchObject({
      message: 'WORKFLOW_DRIVER_SCENARIO_AND_CLEANUP_FAILED', errors: [expect.any(Error),
        expect.objectContaining({ message: 'WORKFLOW_DRIVER_SCENARIO_CLEANUP_FAILED' })],
    })
  })
})

describe('workflow driver scenario production prompt helpers', () => {
  it('uses closed production tasks, source selection, word contract and the bound builtin skill', async () => {
    const f = fixture()
    await runWorkflowDriverScenario(f.context, f.dependencies)
    const request = f.calls.find(call => call.channel === 'workflow-driver:v1:start').args[0]
    expect(request.recipe.outlineTask).toMatchObject({ purpose: 'chapter-draft-short-outline', output: 'visible-text',
      reasoningStage: 'planning', budgetDemand: { kind: 'draft-units', requestedUnits: 500, segmentable: false } })
    expect(request.recipe.baseDraftTask).toMatchObject({ purpose: 'chapter-draft', output: 'visible-text', reasoningStage: 'drafting' })
    expect(request.recipe.outlineTask.promptBudget.sections[0].sectionName).toBe('writing-skill')
    const user = request.recipe.baseDraftTask.messages.find(message => message.role === 'user').content
    expect(user).toContain('[Chapter length contract]')
    expect(user).toContain('[Author material (verbatim; character state is time-bound, not permanent)]')
    expect(user).toContain('[Supplemental writing skill:')
    expect(request.selection.materialDecision).toMatchObject({ version: 1, verdict: 'admitted', coverage: { complete: true } })
    expect(request.selection.materialDecision.included.some(source => source.sourceId === 'author:required' && source.required)).toBe(true)
    expect(request.recipe).not.toHaveProperty('modelId')
    expect(request.recipe).not.toHaveProperty('handle')
    expect(request.recipe).not.toHaveProperty('epoch')
  })
  it('rejects a preparation for a different knowledge query before constructing a start request', async () => {
    await expect(buildWorkflowDriverScenarioRequest({ session: { projectId: 'fictional', leaseId: 'fictional-view' },
      prepared: { knowledgeSnapshot: { query: 'wrong query', items: [] }, selectedDrafts: [] }, novelConfig: {} })).rejects.toThrow('prepared knowledge query changed')
  })
})

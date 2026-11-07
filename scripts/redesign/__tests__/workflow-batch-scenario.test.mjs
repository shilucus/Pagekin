import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertProjectStoragePathSupported } from '../../../electron/services/project-storage-preflight.ts'
import { runWorkflowBatchScenario, runWorkflowBatchUnknownScenario, runWorkflowBatchRestartScenario, WORKFLOW_BATCH_SCENARIOS } from '../workflow-batch-scenario.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const clone = value => structuredClone(value)

// This fixture tests scenario assertions and cleanup only, not the production IPC or writer.
function fixture(options = {}) {
  const projects = [], calls = [], cores = new Map()
  let active, lease = 0, requests = 0, task, reply, generation = 0, killed = false, issuance = true, newRequests = 0, newDispatches = 0
  const fake = { chats: [], streamProse() {}, replyReview(value) { reply = value }, gate: {
    held: false, waiting: 0,
    hold() { this.held = true },
    release() {
      if (!this.held) return
      this.held = false; this.waiting = 0
      if (!task) return
      if (killed) { fake.chats.push({ messages: [{ role: 'user', content: 'killed request' }] }); return }
      if (task.task.state === 'paused') { task.attempts[0].status = 'unknown'; return }
      if (task.task.state !== 'ready') return
      const outputs = Array.from({ length: 6 }, () => reply('fictional prompt'))
      requests += 5 + (options.extraRequest ? 1 : 0)
      fake.chats.push(...[
        'Prepare a short chapter execution outline, not prose.', 'draft one',
        'Prepare a short chapter execution outline, not prose.', 'draft two',
        `[Strict evidence-anchor constraint] ${outputs[1]}`, `[Strict evidence-anchor constraint] ${outputs[3]}`,
      ].map(content => ({ messages: [{ role: 'user', content }] })))
      if (options.reviewBeforeDraft) fake.chats[3] = clone(fake.chats[4])
      task.steps = [1, 2].flatMap(chapterNumber => ['outline', 'draft', 'compose', 'draft_commit', 'review', 'review_commit']
        .map((kind, index) => ({ stepId: `${chapterNumber}-${kind}`, commandId: `command-${chapterNumber}-${index}`, chapterNumber,
          kind, role: kind.startsWith('review') ? 'review' : 'draft', effect: { receiptKind: kind === 'compose' ? 'composition'
            : ['draft_commit', 'review_commit'].includes(kind) ? kind : 'model', receiptAttemptId: `attempt-${chapterNumber}-${index}`, contentHash: hash(kind) } })))
      if (options.missingEffect) task.steps[0].effect = null
      task.attempts = Array.from({ length: 6 }, (_, index) => ({ runId: `run-${index}`, attemptId: `attempt-${index}`, status: 'settled', artifactId: `artifact-${index}` }))
      task.chapters = [1, 2].map((chapterNumber, index) => ({ chapterNumber,
        draftSave: { kind: 'current', receipt: { id: chapterNumber, version: 1, content: outputs[index * 2 + 1], contentHash: hash(outputs[index * 2 + 1]) } },
        review: { success: true, kind: 'review', content: 'fictional review', contentHash: hash('fictional review'),
          source: { id: chapterNumber, version: 1, chapterNumber, content: outputs[index * 2 + 1] } } }))
      if (options.wrongBody) task.chapters[1].draftSave.receipt.content += ' changed'
      if (options.wrongReviewSource) task.chapters[1].review.source.id = 1
      task.task.state = 'waiting_review'
    },
  } }
  const reference = () => ({ projectId: task.task.projectId, taskId: task.task.taskId, revision: task.task.revision })
  function requireView(session) {
    if (!options.allowStale && (session.projectId !== active.projectId || session.leaseId !== active.leaseId)) throw new Error('GENERATION_PROJECT_SESSION_STALE')
  }
  function requireReference(value, checkRevision = true) {
    if (!options.allowWrongProject && value.projectId !== task.task.projectId) throw new Error('WORKFLOW_BATCH_CAPABILITY_REQUIRED')
    if (value.taskId !== task.task.taskId || checkRevision && value.revision !== task.task.revision) throw new Error('WORKFLOW_BATCH_REVISION_CONFLICT')
  }
  const invoke = async (_page, channel, ...args) => {
    calls.push({ channel, args: clone(args), active: active?.projectId, generation, page: _page })
    if (options.restart && _page !== context.page) throw new Error('STALE_PAGE')
    if (channel === 'project:create') {
      if (options.createError) return { success: false, error: options.createError }
      const project = { projectId: `project-${projects.length}`, projectPath: `/fictional/${projects.length}` }
      projects.push(project); cores.set(project.projectPath, '')
      return { success: true, ...project }
    }
    if (channel === 'project-runtime:v1:open-view') {
      const project = projects.find(item => item.projectPath === args[0])
      active = { ...project, leaseId: `lease-${++lease}` }
      return { success: true, project: { sessionLease: active.leaseId, novelConfig: {} } }
    }
    if (channel === 'llm:save-model') return { success: true }
    if (channel === 'project:update-config') { requireView(args[3]); cores.set(args[2], args[1].novelConfig.coreOutline); return { success: true } }
    if (channel === 'db:blueprint-upsert') { requireView(args[2]); return { success: true } }
    if (channel === 'db:project-core-update') { requireView(args[2]); cores.set(args[1], args[0].coreOutline); return { success: true } }
    if (channel === 'db:project-core-get') { requireView(args[1]); return { coreOutline: cores.get(args[0]) } }
    if (channel === 'db:close') { requireView(args[1]); if (options.failClose) throw new Error('FICTIONAL_CLOSE_FAILED'); return { success: true } }
    if (channel === 'workflow-batch:v2:start') {
      requireView(args[1])
      expect(args[0]).toMatchObject({ uiLocale: 'en-US', authorInputs: [], intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 100 } })
      task = { task: { taskId: 'task', projectId: active.projectId, revision: 1, state: 'ready', blockedCode: null },
        steps: [{ stepId: 'outline', effect: null }], attempts: [{ runId: 'run', attemptId: 'attempt', status: 'dispatch-marked', artifactId: 'artifact' }],
        chapters: [1, 2].map(chapterNumber => ({ chapterNumber, draftSave: { kind: 'absent' }, review: null })) }
      requests++; fake.gate.waiting = options.extraGate ? 2 : 1
      return { reference: reference(), receipt: clone(task) }
    }
    if (channel === 'workflow-batch:v2:read-history') { requireView(args[1]); return clone(task) }
    if (channel === 'workflow-batch:v2:reauthorize') {
      requireView(args[1])
      if (killed && task.attempts[0].status === 'dispatch-marked') {
        task.attempts[0].status = 'unknown'; task.task.state = 'paused'; task.task.revision++
      }
      issuance = true
      return { reference: ['waiting_review', 'cancelled'].includes(task.task.state) && !options.resign ? null : reference(), receipt: clone(task) }
    }
    if (channel.startsWith('workflow-batch:v2:')) {
      const value = args[0].reference
      if (!issuance && !options.acceptOldCapability) throw new Error(options.wrongCapabilityError ? 'OTHER_ERROR' : 'WORKFLOW_BATCH_CAPABILITY_REQUIRED')
      requireReference(value, channel !== 'workflow-batch:v2:read-receipt')
      if (channel.endsWith('read-receipt')) return clone(task)
      if (channel.endsWith('pause')) { task.task.state = 'paused'; task.task.revision++; return { reference: reference(), receipt: clone(task) } }
      if (channel.endsWith('resume')) {
        if (options.redispatch) { requests++; if (generation) { newRequests++; newDispatches++ } }
        task.task.state = 'blocked'; task.task.blockedCode = 'WORKFLOW_BATCH_ATTEMPT_UNRESOLVED'; task.task.revision++
        return { reference: reference(), receipt: clone(task) }
      }
      if (channel.endsWith('cancel')) {
        if (generation && options.lateDispatch) newDispatches++
        task.task.state = 'cancelled'; task.task.revision++; return { reference: reference(), receipt: clone(task) }
      }
    }
    throw new Error(`UNEXPECTED_TEST_CHANNEL:${channel}`)
  }
  const context = { app: { process: () => ({ pid: 10 }) }, page: {}, roots: { projects: '/fictional' }, invoke, fake }
  context.restart = async ({ killed: requestedKill, beforeLaunch }) => {
    calls.push({ channel: 'restart', requestedKill })
    if (!requestedKill) throw new Error('PROCESS_NOT_KILLED')
    killed = true; issuance = false
    await beforeLaunch()
    if (options.launchFails) throw new Error('FICTIONAL_LAUNCH_FAILED')
    generation++
    context.app = { process: () => ({ pid: options.samePid ? 10 : 11 }) }
    context.page = {}
  }
  return { context, calls,
    dependencies: { grantDirectory: async () => ({ grantId: 'directory-grant' }),
      requestCount: async () => options.restart ? generation ? newRequests : 0 : requests,
      installDispatchCounter: async () => {}, dispatchCount: async () => generation ? newDispatches : requests,
      runtimeEpoch: async () => generation && !options.sameEpoch ? 'epoch-new' : 'epoch-old',
      awaitGate: async (gate, waiting) => expect(Boolean(gate.waiting)).toBe(waiting) }, get requests() { return requests } }
}

describe('workflow batch scenario assertions (mock orchestration only)', () => {
  it('registers all isolated bounded scenarios', () => {
    expect(Object.keys(WORKFLOW_BATCH_SCENARIOS)).toEqual(['workflow-batch-v2', 'workflow-batch-unknown-v2', 'workflow-batch-restart-v2'])
    for (const scene of Object.values(WORKFLOW_BATCH_SCENARIOS)) expect(scene).toMatchObject({ model: true, shell: 'stage', timeout: 120000 })
  })
  it('requires actual-looking per-chapter draft and review receipts after detaching', async () => {
    const f = fixture(), receipt = await runWorkflowBatchScenario(f.context, f.dependencies)
    expect(receipt).toMatchObject({ guardedFetchAttempts: 6, completedSteps: 12, state: 'waiting_review', detachedWorkContinued: true })
    expect(receipt.notCovered).toContain('formal-finalization-and-author-confirmation-counts')
    expect(f.calls.filter(call => call.channel === 'db:close')).toHaveLength(2)
  })
  it('pauses, preserves unknown without replay, then cancels', async () => {
    const f = fixture(), receipt = await runWorkflowBatchUnknownScenario(f.context, f.dependencies)
    expect(receipt).toMatchObject({ guardedFetchAttempts: 1, unknownNotReplayed: true, cancelled: true })
    expect(f.requests).toBe(1)
    expect(f.calls.filter(call => call.channel === 'db:close')).toHaveLength(2)
  })
  it('kills the owned process, uses the new context, and does not replay unknown', async () => {
    const f = fixture({ restart: true }), oldPage = f.context.page
    const receipt = await runWorkflowBatchRestartScenario(f.context, f.dependencies)
    expect(receipt).toMatchObject({ processRestarted: true, runtimeEpochChanged: true, oldReferenceRejected: true,
      unknownNotReplayed: true, fakeProviderRequests: 1, dispatchStartsBeforeKill: 1, dispatchStartsAfterRestart: 0,
      guardedFetchAttemptsBeforeKill: 0, guardedFetchAttemptsAfterRestart: 0 })
    expect(f.calls.filter(call => call.channel === 'restart')).toEqual([{ channel: 'restart', requestedKill: true }])
    expect(f.calls.filter(call => call.channel === 'db:close')).toHaveLength(1)
    expect(f.calls.filter(call => call.generation === 1).every(call => call.page !== oldPage)).toBe(true)
    expect(f.requests).toBe(1)
    // Match the native path budget without using a real profile as a fixture.
    const parent = path.win32.join('C:\\', 'p'.repeat(60), 'projects')
    for (const call of f.calls.filter(call => call.channel === 'project:create')) {
      expect(() => assertProjectStoragePathSupported(path.win32.join(parent, call.args[0].name), { platform: 'win32' })).not.toThrow()
    }
  })
  it('reads the cached canonical main entry without dynamic import, query or fragment for the default epoch diagnostic', async () => {
    const f = fixture({ restart: true })
    delete f.dependencies.runtimeEpoch
    let calls = 0
    const installDiagnosticMock = () => {
      f.context.app.evaluate = async (reader, projectId) => {
        const source = reader.toString()
        expect(source).toContain('fs.realpathSync.native')
        expect(source).toContain("path.join(directory, 'main.js')")
        expect(source).toContain("process.getBuiltinModule('node:module')")
        expect(source).toContain('createRequire(filename)(filename)')
        expect(source).not.toContain('import(')
        expect(source).not.toMatch(/[?#]/u)
        expect(projectId).toBe('project-0')
        return ++calls === 1 ? 'epoch-old' : 'epoch-new'
      }
    }
    installDiagnosticMock()
    const restart = f.context.restart
    f.context.restart = async options => { await restart(options); installDiagnosticMock() }
    await runWorkflowBatchRestartScenario(f.context, f.dependencies)
    expect(calls).toBe(2)
  })
  it.each(['samePid', 'sameEpoch', 'acceptOldCapability', 'wrongCapabilityError', 'redispatch', 'lateDispatch'])('rejects restart regression %s', async key => {
    const f = fixture({ restart: true, [key]: true })
    await expect(runWorkflowBatchRestartScenario(f.context, f.dependencies)).rejects.toThrow()
    expect(f.context.fake.gate.waiting).toBe(0)
    expect(f.calls.filter(call => call.channel === 'db:close').every(call => call.generation === 1)).toBe(true)
  })
  it('does not close dead runtimes when relaunch fails', async () => {
    const f = fixture({ restart: true, launchFails: true })
    await expect(runWorkflowBatchRestartScenario(f.context, f.dependencies)).rejects.toThrow('FICTIONAL_LAUNCH_FAILED')
    expect(f.calls.filter(call => call.channel === 'db:close')).toHaveLength(0)
    expect(f.context.fake.gate.waiting).toBe(0)
  })
  it.each(['allowStale', 'allowWrongProject', 'missingEffect', 'extraRequest', 'wrongBody', 'wrongReviewSource', 'reviewBeforeDraft', 'resign', 'extraGate'])(
    'rejects the %s fixture regression', async key => {
      const f = fixture({ [key]: true })
      await expect(runWorkflowBatchScenario(f.context, f.dependencies)).rejects.toThrow()
      expect(f.context.fake.gate.waiting).toBe(0)
      expect(f.calls.filter(call => call.channel === 'db:close')).toHaveLength(2)
    },
  )
  it('rejects redispatch of an unknown invocation', async () => {
    const f = fixture({ redispatch: true })
    await expect(runWorkflowBatchUnknownScenario(f.context, f.dependencies)).rejects.toThrow('unknown attempt was redispatched')
  })
  it('preserves both the scenario failure and cleanup failure', async () => {
    const f = fixture({ missingEffect: true, failClose: true })
    await expect(runWorkflowBatchScenario(f.context, f.dependencies)).rejects.toMatchObject({
      message: 'WORKFLOW_BATCH_SCENARIO_AND_CLEANUP_FAILED', errors: [expect.any(Error), expect.objectContaining({ message: 'WORKFLOW_BATCH_SCENARIO_CLEANUP_FAILED' })],
    })
  })
  it('does not close a project whose creation failed', async () => {
    const f = fixture({ createError: 'FICTIONAL_CREATE_FAILED' })
    await expect(runWorkflowBatchScenario(f.context, f.dependencies)).rejects.toThrow('FICTIONAL_CREATE_FAILED')
    expect(f.calls.some(call => call.channel === 'db:close')).toBe(false)
  })
  it('retains creation errors and never restarts after fixture admission fails', async () => {
    const f = fixture({ restart: true, createError: 'FICTIONAL_CREATE_FAILED' })
    await expect(runWorkflowBatchRestartScenario(f.context, f.dependencies)).rejects.toThrow('FICTIONAL_CREATE_FAILED')
    expect(f.calls.some(call => ['db:close', 'restart', 'workflow-batch:v2:start'].includes(call.channel))).toBe(false)
    expect(f.requests).toBe(0)
  })
})

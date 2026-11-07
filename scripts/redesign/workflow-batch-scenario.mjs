import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const prose = [
  'Mara reached the harbor before dawn. A courier stood beside the iron gate, holding a sealed letter. She checked his badge against the number in her notebook and asked him to wait. The tide had carried a broken crate onto the landing. Inside it lay a brass key wrapped in blue cloth. Mara recorded the discovery without opening the letter. Across the channel, a small ferry sounded its bell. She secured the gate, placed the key in her satchel, and followed the courier toward the customs house.',
  'At the observatory, Ivo adjusted a silver dial until the upper lens faced east. Dust rose from the wooden floor as his assistant moved the covered instruments. They needed a clear reading before the clouds arrived. A faint line appeared across the glass, followed by a second mark near the rim. Ivo copied both measurements onto a fresh sheet. His assistant compared them with the previous chart and pointed to an empty column. Together they checked the clock, verified the scale, and began recording another careful observation.',
]
const report = JSON.stringify({ summary: 'Fictional machine review', items: [{ category: 'continuity', severity: 'pass',
  description: 'Compared the supplied fictional source with its frozen plan.' }], goalReviews: [] })
const outputs = ['Fictional outline: deliver the sealed letter.', prose[0],
  'Fictional outline: measure the observatory lens.', prose[1], report, report]
const blueprints = [
  { chapterNumber: 1, title: 'Fictional letter', role: 'opening', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '' },
  { chapterNumber: 2, title: 'Fictional observatory', role: 'development', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '' },
]

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`WORKFLOW_BATCH_SCENARIO_TIMEOUT:${label}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
async function waitGate(gate, waiting) { await waitFor(() => Boolean(gate.waiting) === waiting, 'fake-gate') }
async function guardedRequestCount(app) {
  return app.evaluate(() => {
    if (!Array.isArray(globalThis.__driveModelRequests)) throw new Error('WORKFLOW_BATCH_SCENARIO_REQUEST_LOG_MISSING')
    return globalThis.__driveModelRequests.filter(entry => entry.path === '/v1/chat/completions').length
  })
}
async function afterDrain(operation) {
  return waitFor(async () => {
    try { return await operation() } catch (error) {
      if (!/WORKFLOW_BATCH_TASK_BUSY/u.test(String(error?.message ?? error))) throw error
      return false
    }
  }, 'physical-drain')
}

async function runScenario(context, dependencies, unknown) {
  const { app, page, roots, invoke, fake } = context
  const grantDirectory = dependencies.grantDirectory ?? chooseProjectDirectoryGrant
  const requestCount = dependencies.requestCount ?? guardedRequestCount
  const awaitGate = dependencies.awaitGate ?? waitGate
  const opened = new Map(), records = []
  let outcome
  async function open(project) {
    const view = await invoke(page, 'project-runtime:v1:open-view', project.projectPath, randomUUID(), null)
    assert.equal(view?.success, true, 'fictional project open failed')
    opened.set(project.projectPath, project)
    return { session: { projectId: project.projectId, projectPath: project.projectPath, leaseId: view.project.sessionLease }, project: view.project }
  }
  async function create(name) {
    const grant = await grantDirectory(app, page, roots.projects)
    const created = await invoke(page, 'project:create', { parentGrantId: grant.grantId, name,
      genre: 'Fictional mystery', targetAudience: 'Fictional adults', writingLanguage: 'en-US' }, randomUUID(), null)
    assert.equal(created?.success, true, `fictional project creation failed: ${created?.error ?? 'no receipt'}`)
    return { projectId: created.projectId, projectPath: created.projectPath }
  }
  async function history(project, session, taskId) {
    const receipt = await invoke(page, 'workflow-batch:v2:read-history', { taskId }, session)
    assert.equal(receipt.task.projectId, project.projectId)
    assert.equal(receipt.task.taskId, taskId)
    return receipt
  }
  async function cleanup() {
    const failures = []
    try { fake?.gate?.release() } catch (error) { failures.push(error) }
    try { if (fake?.gate) await awaitGate(fake.gate, false) } catch (error) { failures.push(error) }
    for (const record of records) {
      try {
        const { session } = await open(record.project), receipt = await history(record.project, session, record.taskId)
        if (!['cancelled', 'waiting_review'].includes(receipt.task.state)) {
          const result = await afterDrain(() => invoke(page, 'workflow-batch:v2:cancel', {
            reference: { ...record.reference, revision: receipt.task.revision },
          }))
          assert.equal(result.receipt.task.state, 'cancelled', 'cleanup did not cancel unfinished batch')
        }
      } catch (error) { failures.push(error) }
    }
    for (const project of [...opened.values()]) {
      try {
        const { session } = await open(project)
        const closed = await invoke(page, 'db:close', project.projectPath, session)
        assert.equal(closed?.success, true, 'fictional runtime close failed')
        opened.delete(project.projectPath)
      } catch (error) { failures.push(error) }
    }
    try { fake?.replyReview?.(null); fake?.streamProse?.(null) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'WORKFLOW_BATCH_SCENARIO_CLEANUP_FAILED')
  }
  try {
    assert.ok(fake?.gate && fake?.replyReview && fake?.streamProse, 'WORKFLOW_BATCH_SCENARIO_FAKE_REQUIRED')
    let outputIndex = 0
    fake.replyReview(() => outputs[outputIndex++] ?? null)
    fake.streamProse(null)
    const initial = await requestCount(app), chatStart = fake.chats.length
    const a = await create(unknown ? 'Batch U A' : 'Batch A'), b = await create(unknown ? 'Batch U B' : 'Batch B')
    assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
    const aView = await open(a), sessionA = aView.session
    const novelConfig = { ...aView.project.novelConfig, writingLanguage: 'en-US', wordsPerChapter: 100, totalChapters: 2,
      coreOutline: 'Fictional people find a key and later observe the sky.', worldSetting: 'A fictional harbor and observatory.',
      globalGuidance: 'Preserve fictional author facts.', writingStyle: 'Use concrete actions.' }
    assert.equal((await invoke(page, 'project:update-config', a.projectId, { novelConfig }, a.projectPath, sessionA)).success, true)
    for (const blueprint of blueprints) assert.equal((await invoke(page, 'db:blueprint-upsert', blueprint, a.projectPath, sessionA)).success, true)
    const request = { operationKey: randomUUID(), modelId: FAKE_MODEL.id, reviewModelId: FAKE_MODEL.id, uiLocale: 'en-US',
      intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 100 }, authorInputs: [] }
    fake.gate.hold()
    let result = await invoke(page, 'workflow-batch:v2:start', request, sessionA)
    assert.ok(result.reference, 'batch start returned no execution reference')
    const taskId = result.receipt.task.taskId
    records.push({ project: a, taskId, reference: result.reference })
    await awaitGate(fake.gate, true)
    const { session: sessionB } = await open(b)
    assert.equal((await invoke(page, 'db:project-core-update', { coreOutline: 'Fictional B remains independent.' }, b.projectPath, sessionB)).success, true)
    await assert.rejects(invoke(page, 'workflow-batch:v2:start', { ...request, operationKey: randomUUID() }, sessionA))
    await assert.rejects(invoke(page, 'workflow-batch:v2:read-receipt', { reference: { ...result.reference, projectId: b.projectId } }))
    const held = await invoke(page, 'workflow-batch:v2:read-receipt', { reference: result.reference })
    assert.equal(held.task.taskId, taskId)
    assert.equal(held.attempts.length, 1, 'held batch must have exactly one durable attempt')
    assert.equal(held.attempts[0].status, 'dispatch-marked')
    assert.equal(fake.gate.waiting, 1, 'held batch must have exactly one received request')
    assert.equal(held.steps.filter(step => step.effect).length, 0)
    if (unknown) {
      result = await invoke(page, 'workflow-batch:v2:pause', { reference: result.reference })
      assert.equal(result.receipt.task.state, 'paused')
      fake.gate.release(); await awaitGate(fake.gate, false)
      const paused = await waitFor(async () => {
        const receipt = await invoke(page, 'workflow-batch:v2:read-receipt', { reference: result.reference })
        return receipt.attempts[0]?.status === 'unknown' ? receipt : false
      }, 'unknown-receipt')
      assert.equal(paused.attempts.length, 1)
      assert.ok(paused.chapters.every(chapter => chapter.draftSave.kind === 'absent' && chapter.review === null))
      const { session: freshA } = await open(a)
      const recovered = await afterDrain(() => invoke(page, 'workflow-batch:v2:reauthorize', { taskId }, freshA))
      assert.ok(recovered.reference)
      result = await invoke(page, 'workflow-batch:v2:resume', { reference: recovered.reference })
      const blocked = await waitFor(async () => {
        const receipt = await history(a, freshA, taskId)
        return receipt.task.state === 'blocked' ? receipt : false
      }, 'blocked-unknown-resume')
      assert.equal(blocked.attempts.length, 1)
      assert.equal(blocked.attempts[0].status, 'unknown')
      assert.equal(await requestCount(app), initial + 1, 'unknown attempt was redispatched')
      const final = await afterDrain(() => invoke(page, 'workflow-batch:v2:reauthorize', { taskId }, freshA))
      assert.ok(final.reference)
      const cancelled = await invoke(page, 'workflow-batch:v2:cancel', { reference: final.reference })
      assert.equal(cancelled.receipt.task.state, 'cancelled')
      assert.equal(await requestCount(app), initial + 1, 'cancel redispatched the unknown attempt')
      outcome = { receipt: { scenario: 'workflow-batch-unknown-v2', source: 'isolated-electron-registered-ipc-main-owner',
        taskId, guardedFetchAttempts: 1, pausedInFlight: true, unknownNotReplayed: true, cancelled: true,
        notCovered: ['real-model-quality', 'process-restart', 'native-platform-qualification', 'formal-finalization-and-author-confirmation-counts'] } }
    } else {
      fake.gate.release(); await awaitGate(fake.gate, false)
      const completed = await waitFor(async () => {
        const receipt = await invoke(page, 'workflow-batch:v2:read-receipt', { reference: result.reference })
        assert.notEqual(receipt.task.state, 'blocked', `batch blocked: ${receipt.task.blockedCode}`)
        return receipt.task.state === 'waiting_review' ? receipt : false
      }, 'waiting-review')
      assert.equal((await invoke(page, 'db:project-core-get', b.projectPath, sessionB)).coreOutline, 'Fictional B remains independent.')
      assert.equal(completed.steps.length, 12, 'batch does not contain twelve effect steps')
      assert.ok(completed.steps.every(step => step.effect), 'registration is not completion evidence')
      assert.deepEqual(completed.steps.map(step => step.kind).sort(),
        ['outline', 'draft', 'compose', 'draft_commit', 'review', 'review_commit'].flatMap(kind => [kind, kind]).sort())
      for (const chapterNumber of [1, 2]) {
        const chapterSteps = completed.steps.filter(step => step.chapterNumber === chapterNumber)
        assert.deepEqual(chapterSteps.map(step => step.kind).sort(), ['outline', 'draft', 'compose', 'draft_commit', 'review', 'review_commit'].sort())
        for (const step of chapterSteps) {
          const expected = step.kind === 'compose' ? 'composition' : ['draft_commit', 'review_commit'].includes(step.kind) ? step.kind : 'model'
          assert.equal(step.effect.receiptKind, expected)
          assert.ok(step.effect.receiptAttemptId && step.effect.contentHash)
        }
      }
      assert.deepEqual(completed.chapters.map(chapter => chapter.chapterNumber), [1, 2])
      for (const [index, chapter] of completed.chapters.entries()) {
        assert.equal(chapter.draftSave.kind, 'current')
        assert.equal(chapter.draftSave.receipt.content, prose[index])
        assert.equal(chapter.draftSave.receipt.contentHash, hash(prose[index]))
        assert.equal(chapter.review?.success, true)
        assert.equal(chapter.review.kind, 'review')
        assert.equal(chapter.review.source.id, chapter.draftSave.receipt.id)
        assert.equal(chapter.review.source.version, chapter.draftSave.receipt.version)
        assert.equal(chapter.review.source.chapterNumber, chapter.chapterNumber)
        assert.equal(chapter.review.source.content, chapter.draftSave.receipt.content)
        assert.ok(chapter.review.content)
        assert.equal(chapter.review.contentHash, hash(chapter.review.content))
      }
      assert.equal(completed.attempts.length, 6)
      assert.ok(completed.attempts.every(attempt => attempt.status === 'settled' && attempt.artifactId))
      assert.equal(await requestCount(app), initial + 6, 'batch did not use exactly six requests')
      const chats = fake.chats.slice(chatStart)
      assert.equal(chats.length, 6)
      const prompt = chat => chat.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
      assert.ok(prompt(chats[0]).includes('Prepare a short chapter execution outline, not prose.'))
      assert.ok(prompt(chats[2]).includes('Prepare a short chapter execution outline, not prose.'))
      assert.ok(!prompt(chats[1]).includes('[Strict evidence-anchor constraint]'))
      assert.ok(!prompt(chats[3]).includes('[Strict evidence-anchor constraint]'))
      for (const [index, chat] of chats.slice(4).entries()) {
        assert.ok(prompt(chat).includes('[Strict evidence-anchor constraint]'), 'review request must follow both draft requests')
        assert.ok(prompt(chat).includes(prose[index]), 'review request must use its committed draft')
      }
      assert.equal(outputIndex, 6)
      const { session: freshA } = await open(a)
      assert.notEqual(freshA.leaseId, sessionA.leaseId)
      assert.deepEqual(await invoke(page, 'workflow-batch:v2:read-receipt', { reference: result.reference }), completed)
      assert.deepEqual(await history(a, freshA, taskId), completed)
      assert.deepEqual(await invoke(page, 'workflow-batch:v2:reauthorize', { taskId }, freshA), { reference: null, receipt: completed })
      assert.equal(await requestCount(app), initial + 6, 'reading completed history sent another request')
      outcome = { receipt: { scenario: 'workflow-batch-v2', source: 'isolated-electron-registered-ipc-main-owner', taskId,
        state: 'waiting_review', guardedFetchAttempts: 6, completedSteps: 12, detachedWorkContinued: true,
        resubscribedFromReceipt: true, otherProjectPreserved: true, contentHashes: prose.map(hash),
        notCovered: ['real-model-quality', 'process-restart', 'native-platform-qualification', 'formal-finalization-and-author-confirmation-counts'] } }
    }
  } catch (error) { outcome = { error } }
  try { await cleanup() } catch (error) {
    if ('error' in outcome) throw new AggregateError([outcome.error, error], 'WORKFLOW_BATCH_SCENARIO_AND_CLEANUP_FAILED')
    throw error
  }
  if ('error' in outcome) throw outcome.error
  return outcome.receipt
}

export const runWorkflowBatchScenario = (context, dependencies = {}) => runScenario(context, dependencies, false)
export const runWorkflowBatchUnknownScenario = (context, dependencies = {}) => runScenario(context, dependencies, true)
async function readRuntimeEpoch(app, project) {
  return app.evaluate(({ app: electronApp }, projectId) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const { createRequire } = process.getBuiltinModule('node:module')
    const directory = fs.realpathSync.native(path.join(electronApp.getAppPath(), 'dist-electron'))
    const filename = fs.realpathSync.native(path.join(directory, 'main.js'))
    if (path.dirname(filename) !== directory || path.basename(filename) !== 'main.js') throw new Error('WORKFLOW_BATCH_RUNTIME_ENTRY_INVALID')
    const entry = createRequire(filename)(filename)
    if (typeof entry.readProjectRuntimeEpochForDiagnostics !== 'function') throw new Error('WORKFLOW_BATCH_RUNTIME_EPOCH_DIAGNOSTIC_REQUIRED')
    return entry.readProjectRuntimeEpochForDiagnostics(projectId)
  }, project.projectId)
}

async function installDispatchCounter(app) {
  await app.evaluate(() => {
    const original = globalThis.fetch
    globalThis.__workflowBatchDispatchStarts = 0
    globalThis.fetch = function (...args) {
      try {
        const input = args[0]
        const url = new URL(String(input instanceof Request ? input.url : input))
        if (url.pathname === '/v1/chat/completions') {
          globalThis.__workflowBatchDispatchStarts = Math.min(129, globalThis.__workflowBatchDispatchStarts + 1)
        }
      } catch { /* The original fetch remains responsible for input errors. */ }
      return Reflect.apply(original, this, args)
    }
  })
}
async function dispatchCount(app) {
  return app.evaluate(() => {
    if (!Number.isInteger(globalThis.__workflowBatchDispatchStarts)) throw new Error('WORKFLOW_BATCH_DISPATCH_LOG_MISSING')
    return globalThis.__workflowBatchDispatchStarts
  })
}

export async function runWorkflowBatchRestartScenario(context, dependencies = {}) {
  const { roots, invoke, fake } = context
  const grantDirectory = dependencies.grantDirectory ?? chooseProjectDirectoryGrant
  const requestCount = dependencies.requestCount ?? guardedRequestCount
  const awaitGate = dependencies.awaitGate ?? waitGate
  const runtimeEpoch = dependencies.runtimeEpoch ?? readRuntimeEpoch
  const installCounter = dependencies.installDispatchCounter ?? installDispatchCounter
  const countDispatches = dependencies.dispatchCount ?? dispatchCount
  const opened = new Map()
  let task, oldProcessDead = false, restarted = false, outcome
  async function open(project) {
    const view = await invoke(context.page, 'project-runtime:v1:open-view', project.projectPath, randomUUID(), null)
    assert.equal(view?.success, true, 'fictional project open failed')
    opened.set(project.projectPath, project)
    return { session: { projectId: project.projectId, projectPath: project.projectPath, leaseId: view.project.sessionLease }, project: view.project }
  }
  async function create(name) {
    const grant = await grantDirectory(context.app, context.page, roots.projects)
    const created = await invoke(context.page, 'project:create', { parentGrantId: grant.grantId, name,
      genre: 'Fictional mystery', targetAudience: 'Fictional adults', writingLanguage: 'en-US' }, randomUUID(), null)
    assert.equal(created?.success, true, `fictional project creation failed: ${created?.error ?? 'no receipt'}`)
    return { projectId: created.projectId, projectPath: created.projectPath }
  }
  async function history(project, session) {
    const receipt = await invoke(context.page, 'workflow-batch:v2:read-history', { taskId: task.id }, session)
    assert.equal(receipt.task.projectId, project.projectId)
    assert.equal(receipt.task.taskId, task.id)
    return receipt
  }
  async function cleanup() {
    const failures = []
    try { fake?.gate?.release(); if (fake?.gate) await awaitGate(fake.gate, false) } catch (error) { failures.push(error) }
    if (!oldProcessDead || restarted) {
      if (task) {
        try {
          const { session } = await open(task.project), receipt = await history(task.project, session)
          if (!['cancelled', 'waiting_review'].includes(receipt.task.state)) {
            const authorization = await afterDrain(() => invoke(context.page, 'workflow-batch:v2:reauthorize', { taskId: task.id }, session))
            assert.ok(authorization.reference, 'cleanup could not reauthorize unfinished batch')
            const result = await afterDrain(() => invoke(context.page, 'workflow-batch:v2:cancel', { reference: authorization.reference }))
            assert.equal(result.receipt.task.state, 'cancelled')
          }
        } catch (error) { failures.push(error) }
      }
      for (const project of [...opened.values()]) {
        try {
          const { session } = await open(project)
          assert.equal((await invoke(context.page, 'db:close', project.projectPath, session))?.success, true)
          opened.delete(project.projectPath)
        } catch (error) { failures.push(error) }
      }
    }
    try { fake?.replyReview?.(null); fake?.streamProse?.(null) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'WORKFLOW_BATCH_SCENARIO_CLEANUP_FAILED')
  }
  try {
    assert.ok(fake?.gate && fake?.replyReview && fake?.streamProse && context.restart, 'WORKFLOW_BATCH_SCENARIO_FAKE_REQUIRED')
    await installCounter(context.app)
    assert.equal(await countDispatches(context.app), 0)
    fake.replyReview(() => outputs[0]); fake.streamProse(null)
    const initialGuard = await requestCount(context.app), chatStart = fake.chats.length
    const a = await create('Batch R A'), b = await create('Batch R B')
    assert.equal((await invoke(context.page, 'llm:save-model', FAKE_MODEL)).success, true)
    const aView = await open(a), sessionA = aView.session
    const novelConfig = { ...aView.project.novelConfig, writingLanguage: 'en-US', wordsPerChapter: 100, totalChapters: 2,
      coreOutline: 'Fictional people find a key and later observe the sky.', worldSetting: 'A fictional harbor and observatory.',
      globalGuidance: 'Preserve fictional author facts.', writingStyle: 'Use concrete actions.' }
    assert.equal((await invoke(context.page, 'project:update-config', a.projectId, { novelConfig }, a.projectPath, sessionA)).success, true)
    for (const blueprint of blueprints) assert.equal((await invoke(context.page, 'db:blueprint-upsert', blueprint, a.projectPath, sessionA)).success, true)
    const oldEpoch = await runtimeEpoch(context.app, a), oldApp = context.app, oldPage = context.page
    const oldPid = oldApp.process().pid
    assert.ok(typeof oldEpoch === 'string' && oldEpoch && Number.isInteger(oldPid))
    fake.gate.hold()
    const started = await invoke(context.page, 'workflow-batch:v2:start', { operationKey: randomUUID(), modelId: FAKE_MODEL.id,
      reviewModelId: FAKE_MODEL.id, uiLocale: 'en-US', intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 100 },
      authorInputs: [] }, sessionA)
    assert.ok(started.reference)
    task = { id: started.receipt.task.taskId, project: a }
    await awaitGate(fake.gate, true)
    const held = await invoke(context.page, 'workflow-batch:v2:read-receipt', { reference: started.reference })
    assert.equal(held.attempts.length, 1)
    assert.equal(held.attempts[0].status, 'dispatch-marked')
    assert.ok(held.attempts[0].artifactId)
    assert.equal(fake.gate.waiting, 1)
    await open(b)
    const oldGuard = await requestCount(oldApp)
    assert.equal(await countDispatches(oldApp), 1, 'held request did not produce exactly one dispatch start')
    await context.restart({ killed: true, beforeLaunch: async () => {
      oldProcessDead = true; opened.clear()
      fake.gate.release(); await awaitGate(fake.gate, false)
      await waitFor(() => fake.chats.length === chatStart + 1, 'killed-request-arrival')
    } })
    restarted = true
    assert.notEqual(context.app, oldApp); assert.notEqual(context.page, oldPage)
    const newPid = context.app.process().pid
    assert.ok(Number.isInteger(newPid)); assert.notEqual(newPid, oldPid)
    await installCounter(context.app)
    assert.equal(await countDispatches(context.app), 0)
    const { session: freshA } = await open(a)
    const newEpoch = await runtimeEpoch(context.app, a)
    assert.ok(typeof newEpoch === 'string' && newEpoch); assert.notEqual(newEpoch, oldEpoch)
    await assert.rejects(invoke(context.page, 'workflow-batch:v2:resume', { reference: started.reference }), /WORKFLOW_BATCH_CAPABILITY_REQUIRED/u)
    const recovered = await afterDrain(() => invoke(context.page, 'workflow-batch:v2:reauthorize', { taskId: task.id }, freshA))
    assert.ok(recovered.reference)
    assert.equal(recovered.receipt.attempts.length, 1)
    assert.equal(recovered.receipt.attempts[0].status, 'unknown')
    assert.deepEqual({ ...recovered.receipt.attempts[0], status: held.attempts[0].status }, held.attempts[0])
    await invoke(context.page, 'workflow-batch:v2:resume', { reference: recovered.reference })
    const blocked = await waitFor(async () => {
      const receipt = await history(a, freshA)
      return receipt.task.state === 'blocked' ? receipt : false
    }, 'restart-unknown-resume')
    assert.equal(blocked.attempts.length, 1); assert.equal(blocked.attempts[0].status, 'unknown')
    assert.equal(blocked.attempts[0].artifactId, held.attempts[0].artifactId)
    assert.ok(blocked.chapters.every(chapter => chapter.draftSave.kind === 'absent' && chapter.review === null))
    const newGuard = await requestCount(context.app)
    assert.equal(newGuard, 0, 'unknown attempt was redispatched after restart')
    assert.equal(fake.chats.length, chatStart + 1, 'fake provider received another request')
    const final = await afterDrain(() => invoke(context.page, 'workflow-batch:v2:reauthorize', { taskId: task.id }, freshA))
    assert.ok(final.reference)
    assert.equal(await countDispatches(context.app), 0, 'unknown attempt was dispatched after restart')
    assert.equal((await invoke(context.page, 'workflow-batch:v2:cancel', { reference: final.reference })).receipt.task.state, 'cancelled')
    assert.equal(await requestCount(context.app), 0, 'cancel redispatched the unknown attempt')
    assert.equal(await countDispatches(context.app), 0, 'cancel dispatched the unknown attempt')
    assert.equal(fake.chats.length, chatStart + 1)
    outcome = { receipt: { scenario: 'workflow-batch-restart-v2', source: 'isolated-electron-registered-ipc-main-owner', taskId: task.id,
      processRestarted: true, runtimeEpochChanged: true, oldReferenceRejected: true, unknownNotReplayed: true, cancelled: true,
      fakeProviderRequests: 1, dispatchStartsBeforeKill: 1, dispatchStartsAfterRestart: 0,
      guardedFetchAttemptsBeforeKill: oldGuard - initialGuard, guardedFetchAttemptsAfterRestart: newGuard,
      notCovered: ['real-model-quality', 'native-platform-qualification', 'formal-finalization-and-author-confirmation-counts'] } }
  } catch (error) { outcome = { error } }
  try { await cleanup() } catch (error) {
    if ('error' in outcome) throw new AggregateError([outcome.error, error], 'WORKFLOW_BATCH_SCENARIO_AND_CLEANUP_FAILED')
    throw error
  }
  if ('error' in outcome) throw outcome.error
  return outcome.receipt
}
export const WORKFLOW_BATCH_SCENARIOS = {
  'workflow-batch-v2': { model: true, shell: 'stage', timeout: 120_000, run: runWorkflowBatchScenario },
  'workflow-batch-unknown-v2': { model: true, shell: 'stage', timeout: 120_000, run: runWorkflowBatchUnknownScenario },
  'workflow-batch-restart-v2': { model: true, shell: 'stage', timeout: 120_000, run: runWorkflowBatchRestartScenario },
}

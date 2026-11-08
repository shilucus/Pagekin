import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex')
const books = ['A', 'B', 'C'].map(letter => ({ letter, marker: `SCHEDMARK${letter}`,
  prose: `SCHEDMARK${letter} Mara reached the harbor before dawn. A courier stood beside the iron gate, holding a sealed letter. She checked his badge against the number in her notebook and asked him to wait. The tide had carried a broken crate onto the landing. Inside it lay a brass key wrapped in blue cloth. Mara recorded the discovery without opening the letter. Across the channel, a small ferry sounded its bell. She secured the gate, placed the key in her satchel, and followed the courier toward the customs house.` }))
const review = JSON.stringify({ summary: 'Fictional machine review', items: [{ category: 'continuity', severity: 'pass', description: 'Compared the supplied fictional source with its frozen plan.' }], goalReviews: [] })

async function waitFor(check, label, timeout = 60_000) {
  const end = Date.now() + timeout
  for (;;) {
    const result = await check()
    if (result) return result
    if (Date.now() >= end) throw new Error(`SCHEDULED_GENERATION_TIMEOUT:${label}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
async function afterDrain(operation) {
  return waitFor(async () => {
    try { return await operation() } catch (error) {
      if (!/WORKFLOW_BATCH_TASK_BUSY|PROJECT_RUNTIME_BUSY/u.test(String(error?.message ?? error))) throw error
      return false
    }
  }, 'physical-drain')
}
async function guardedRequestCount(app) {
  return app.evaluate(() => {
    if (!Array.isArray(globalThis.__driveModelRequests)) throw new Error('SCHEDULED_GENERATION_REQUEST_LOG_MISSING')
    return globalThis.__driveModelRequests.filter(entry => entry.path === '/v1/chat/completions').length
  })
}
function assertSetupSuccess(result, channel, book) {
  const detail = result?.errorCode ?? result?.error ?? (result == null ? 'NO_RECEIPT' : 'NO_ERROR_DETAIL')
  assert.equal(result?.success, true, `SCHEDULED_GENERATION_SETUP_FAILED:${channel}:${book}:${detail}`)
}

export async function runScheduledGenerationScenario(context, dependencies = {}) {
  const { app, page, roots, invoke, fake } = context
  const grantDirectory = dependencies.grantDirectory ?? chooseProjectDirectoryGrant
  const requestCount = dependencies.requestCount ?? guardedRequestCount
  const wait = dependencies.waitFor ?? waitFor
  const observeQueue = dependencies.observeQueue ?? (() => new Promise(resolve => setTimeout(resolve, 250)))
  const opened = new Map(), records = []
  let outcome
  async function open(book) {
    const result = await invoke(page, 'project-runtime:v1:open-view', book.projectPath, randomUUID(), null)
    assert.equal(result?.success, true, 'fictional project open failed')
    opened.set(book.projectPath, book)
    return { session: { projectId: book.projectId, projectPath: book.projectPath, leaseId: result.project.sessionLease }, project: result.project }
  }
  async function create(book) {
    const grant = await grantDirectory(app, page, roots.projects)
    const result = await invoke(page, 'project:create', { parentGrantId: grant.grantId, name: `Sched ${book.letter}`,
      genre: 'Fictional mystery', targetAudience: 'Fictional adults', writingLanguage: 'en-US' }, randomUUID(), null)
    assert.equal(result?.success, true, `fictional project creation failed: ${result?.error ?? 'no receipt'}`)
    Object.assign(book, { projectId: result.projectId, projectPath: result.projectPath })
  }
  async function receipt(record) { return invoke(page, 'workflow-batch:v2:read-receipt', { reference: record.reference }) }
  async function cleanup() {
    const failures = []
    try { fake?.gate?.release() } catch (error) { failures.push(error) }
    for (const record of records) {
      try {
        const current = await receipt(record)
        if (!['cancelled', 'waiting_review'].includes(current.task.state)) {
          const stopped = await afterDrain(() => invoke(page, 'workflow-batch:v2:cancel', {
            reference: { ...record.reference, revision: current.task.revision },
          }))
          assert.equal(stopped.receipt.task.state, 'cancelled')
        }
      } catch (error) { failures.push(error) }
    }
    try { if (fake?.gate) await wait(() => fake.gate.waiting === 0, 'cleanup-gate') } catch (error) { failures.push(error) }
    for (const book of [...opened.values()]) {
      try {
        const { session } = await open(book)
        const closed = await afterDrain(() => invoke(page, 'db:close', book.projectPath, session))
        assert.equal(closed?.success, true, 'fictional runtime close failed')
        opened.delete(book.projectPath)
      } catch (error) { failures.push(error) }
    }
    try { fake?.replyReview?.(null); fake?.streamProse?.(null) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'SCHEDULED_GENERATION_CLEANUP_FAILED')
  }
  try {
    assert.ok(fake?.gate && fake?.replyReview && fake?.streamProse, 'SCHEDULED_GENERATION_FAKE_REQUIRED')
    fake.streamProse(null)
    fake.replyReview(prompt => {
      const matches = books.filter(book => prompt.includes(book.marker))
      assert.equal(matches.length, 1, 'request must identify exactly one fictional project')
      const book = matches[0]
      if (prompt.includes('[Strict evidence-anchor constraint]')) return review
      if (prompt.includes('Prepare a short chapter execution outline, not prose.')) return `${book.marker} fictional outline: deliver the letter.`
      return book.prose
    })
    const initial = await requestCount(app), chatStart = fake.chats.length
    const activeBooks = books.map(book => ({ ...book }))
    for (const book of activeBooks) await create(book)
    assertSetupSuccess(await invoke(page, 'llm:save-model', FAKE_MODEL), 'llm:save-model', 'models')
    for (const book of activeBooks) {
      const { session, project } = await open(book)
      const novelConfig = { ...project.novelConfig, writingLanguage: 'en-US', wordsPerChapter: 100, totalChapters: 1,
        coreOutline: `${book.marker} fictional people deliver a letter.`, worldSetting: `${book.marker} fictional harbor.`,
        globalGuidance: `Preserve ${book.marker} author facts.`, writingStyle: 'Use concrete actions.' }
      assertSetupSuccess(await invoke(page, 'project:update-config', book.projectId, { novelConfig }, book.projectPath, session), 'project:update-config', book.letter)
      const blueprint = { chapterNumber: 1, title: `${book.marker} letter`, role: 'opening', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '' }
      assertSetupSuccess(await invoke(page, 'db:blueprint-upsert', blueprint, book.projectPath, session), 'db:blueprint-upsert', book.letter)
      // Legacy blueprint preparation requires one runtime; retain multiple books only after setup.
      assertSetupSuccess(await invoke(page, 'db:close', book.projectPath, session), 'db:close', book.letter)
      opened.delete(book.projectPath)
    }
    fake.gate.hold()
    for (const [index, book] of activeBooks.entries()) {
      const { session } = await open(book)
      const started = await invoke(page, 'workflow-batch:v2:start', { operationKey: randomUUID(), modelId: FAKE_MODEL.id,
        reviewModelId: FAKE_MODEL.id, uiLocale: 'en-US', intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 1 }, targetUnits: 100 }, authorInputs: [] }, session)
      assert.ok(started.reference, 'batch start returned no execution reference')
      records.push({ book, reference: started.reference, taskId: started.receipt.task.taskId })
      if (index < 2) await wait(() => fake.gate.waiting === index + 1, `gate-${index + 1}`)
    }
    assert.equal(fake.gate.waiting, 2, 'expected two simultaneous fake arrivals')
    await observeQueue()
    assert.equal(fake.gate.waiting, 2, 'queued project reached the fake provider')
    for (const record of records.slice(0, 2)) {
      const held = await receipt(record)
      assert.equal(held.task.projectId, record.book.projectId)
      assert.equal(held.attempts.length, 1)
      assert.equal(held.attempts[0].status, 'dispatch-marked')
      assert.equal(held.steps.filter(step => step.effect).length, 0)
    }
    const queued = await receipt(records[2])
    assert.equal(queued.attempts.length, 0, 'queued project created an attempt')
    assert.equal(queued.steps.filter(step => step.effect).length, 0)
    // The guard records responses only after headers return; held arrivals are counted by the fake gate.
    assert.equal(await requestCount(app), initial, 'request returned response headers while fake arrivals were held')
    const cancelled = await invoke(page, 'workflow-batch:v2:cancel', { reference: records[2].reference })
    assert.equal(cancelled.receipt.task.state, 'cancelled')
    assert.equal(cancelled.receipt.attempts.length, 0)
    assert.equal(cancelled.receipt.steps.filter(step => step.effect).length, 0)
    assert.equal(fake.gate.waiting, 2)
    fake.gate.release()
    await wait(() => fake.gate.waiting === 0, 'gate-release')
    const completed = []
    for (const record of records.slice(0, 2)) {
      const done = await wait(async () => {
        const value = await receipt(record)
        assert.notEqual(value.task.state, 'blocked', `batch blocked: ${value.task.blockedCode}`)
        return value.task.state === 'waiting_review' ? value : false
      }, `waiting-review-${record.book.letter}`)
      assert.equal(done.steps.length, 6)
      assert.deepEqual(done.steps.map(step => step.kind).sort(), ['outline', 'draft', 'compose', 'draft_commit', 'review', 'review_commit'].sort())
      assert.ok(done.steps.every(step => step.effect?.receiptAttemptId && step.effect.contentHash
        && step.effect.receiptKind === (step.kind === 'compose' ? 'composition' : ['draft_commit', 'review_commit'].includes(step.kind) ? step.kind : 'model')))
      assert.equal(done.attempts.length, 3)
      assert.ok(done.attempts.every(attempt => attempt.status === 'settled' && attempt.artifactId))
      const chapter = done.chapters[0]
      assert.equal(done.chapters.length, 1)
      assert.equal(chapter.draftSave.kind, 'current')
      assert.equal(chapter.draftSave.receipt.content, record.book.prose)
      assert.equal(chapter.draftSave.receipt.contentHash, hash(record.book.prose))
      assert.equal(chapter.review?.success, true)
      assert.equal(chapter.review.kind, 'review')
      assert.equal(chapter.review.source.id, chapter.draftSave.receipt.id)
      assert.equal(chapter.review.source.version, chapter.draftSave.receipt.version)
      assert.equal(chapter.review.source.chapterNumber, 1)
      assert.equal(chapter.review.source.content, record.book.prose)
      assert.equal(chapter.review.contentHash, hash(chapter.review.content))
      const { session } = await open(record.book)
      assert.deepEqual(await invoke(page, 'workflow-batch:v2:read-history', { taskId: record.taskId }, session), done)
      assert.deepEqual(await afterDrain(() => invoke(page, 'workflow-batch:v2:reauthorize', { taskId: record.taskId }, session)), { reference: null, receipt: done })
      assert.equal((await invoke(page, 'db:project-core-get', record.book.projectPath, session)).coreOutline, `${record.book.marker} fictional people deliver a letter.`)
      completed.push(done)
    }
    assert.notEqual(hash(activeBooks[0].prose), hash(activeBooks[1].prose))
    assert.equal(await requestCount(app), initial + 6)
    assert.equal(fake.chats.length - chatStart, 6)
    const cFinal = await receipt(records[2])
    assert.equal(cFinal.task.state, 'cancelled')
    assert.equal(cFinal.attempts.length, 0)
    assert.equal(cFinal.steps.filter(step => step.effect).length, 0)
    assert.ok(cFinal.chapters.every(chapter => chapter.draftSave.kind === 'absent' && chapter.review === null))
    const { session: cSession } = await open(activeBooks[2])
    assert.equal((await invoke(page, 'db:project-core-get', activeBooks[2].projectPath, cSession)).coreOutline, `${activeBooks[2].marker} fictional people deliver a letter.`)
    outcome = { receipt: { scenario: 'scheduled-generation-v1', source: 'isolated-electron-registered-ipc-main-owner',
      simultaneousFakeArrivals: 2, queuedAttempts: 0, queuedEffects: 0, cancelledQueued: true,
      guardedFetchAttempts: 6, fakeProviderRequests: 6, completedEffects: completed.map(value => value.steps.length),
      taskIds: records.map(record => record.taskId), contentHashes: activeBooks.slice(0, 2).map(book => hash(book.prose)),
      detachedHistoryRecovered: true, otherBookUnchanged: true,
      notCovered: ['real-model-quality', 'performance', 'full-scheduler-qualification', 'native-platform-qualification'] } }
  } catch (error) { outcome = { error } }
  try { await cleanup() } catch (error) {
    if ('error' in outcome) throw new AggregateError([outcome.error, error], 'SCHEDULED_GENERATION_SCENARIO_AND_CLEANUP_FAILED')
    throw error
  }
  if ('error' in outcome) throw outcome.error
  return outcome.receipt
}

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { appendPerformanceFailureDiagnostic, assertPerformanceProbeCoverage, performanceMetadata, readModelRequestSummary, startPerformanceBaseline, stopPerformanceBaseline } from './performance-baseline.mjs'

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex')
const delayMs = 500
const orders = [['serial', 'parallel'], ['parallel', 'serial'], ['serial', 'parallel']]
export const fixtures = {
  A: { marker: 'CMPBOOKA', prose: 'CMPBOOKA Mara reached the harbor before dawn, carrying the brass ledger her mother had sealed beneath the floorboards. The tide had withdrawn from the eastern pier, exposing a narrow line of fresh footprints between the mooring posts. She compared their spacing with the watchman chart, then noted the missing lantern oil and the untouched lock on the customs cabinet. A gull cried above the warehouse roofs. Mara copied the hour into her notebook, folded the chart, and waited beside the gate until the ferry returned. When the ferry bell sounded, she checked the ink once more and stepped aboard without showing the ledger to anyone.' },
  B: { marker: 'CMPBOOKB', prose: 'CMPBOOKB Ivo entered the observatory while rain softened the path below the hill. He adjusted the brass lens until its reflection crossed the north marker on the glass. A second reading disagreed with the chart beside the clock, so he asked Nera to check the instrument without moving its stand. They recorded both measurements, compared the ink with the notes from last night, and found a fresh scratch along the dial. Ivo covered the telescope, locked the shutters, and carried the copied figures downstairs to the keeper. At the stairwell, Nera compared the figures against the station log and circled the minute when the signal had changed.' },
}
const review = JSON.stringify({ summary: 'Fictional review.', items: [{ category: 'continuity', severity: 'pass', description: 'Compared fictional source and plan.' }], goalReviews: [] })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function waitForComparison(check, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  for (;;) { const value = await check(); if (value) return value; if (Date.now() >= end) throw new Error('PERFORMANCE_COMPARISON_TIMEOUT'); await sleep(50) }
}
export function checkTimings(items, count) {
  assert.equal(items.length, count, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
  assert.ok(items.every(item => item?.completed === true && item.statusCode === 200 && Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs >= item.startMs), 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
}
export function assertComparisonCutoff(items, timingCount, capturedTimingCount, fakeRequestCount, capturedFakeRequestCount, failed) {
  assert.equal(capturedTimingCount, timingCount, 'PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED')
  assert.equal(capturedFakeRequestCount, fakeRequestCount, 'PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED')
  assert.ok(items.every(item => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs >= item.startMs), 'PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED')
  if (!failed) checkTimings(items, 36)
}
export function overlap(items) {
  const events = items.flatMap(x => [{ at: x.startMs, d: 1 }, { at: x.endMs, d: -1 }]).sort((a, b) => a.at - b.at || a.d - b.d)
  let n = 0, max = 0; for (const event of events) { n += event.d; max = Math.max(max, n) } return max
}
export function requestHashes(chats, expectedSlots = ['A', 'B']) {
  const result = { A: [], B: [] }
  for (const chat of chats) {
    const matches = Object.entries(fixtures).filter(([, f]) => JSON.stringify(chat.messages).includes(f.marker))
    assert.equal(matches.length, 1, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
    const [slot] = matches[0]
    assert.match(chat.requestParametersHash ?? '', /^[a-f0-9]{64}$/u, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
    result[slot].push({ messages: hash(chat.messages), parameters: chat.requestParametersHash })
  }
  for (const slot of expectedSlots) assert.equal(result[slot].length, 3, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
  return result
}
export function recordCompletedBook(pair, mode, evidence) {
  pair[mode].books.push(evidence)
  pair[mode].completedBooks++
  pair.completedBooks++
}
export function markComparisonFailure(pair, mode) {
  if (pair?.[mode]?.status === 'running') pair[mode].status = 'failed'
  if (pair?.status === 'running') pair.status = 'failed'
}
export function receiptEvidence(receipt, slot, requests) {
  assert.equal(receipt?.task?.state, 'waiting_review', 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(receipt.attempts?.length, 3, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.ok(receipt.attempts.every(x => x.status === 'settled' && x.artifactId), 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(receipt.steps?.length, 6, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.deepEqual(receipt.steps.map(x => x.kind).sort(), ['compose', 'draft', 'draft_commit', 'outline', 'review', 'review_commit'].sort(), 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  const kinds = { compose: 'composition', draft_commit: 'draft_commit', review_commit: 'review_commit' }
  const attemptById = new Map(receipt.attempts.map(x => [x.attemptId, x]))
  assert.equal(attemptById.size, 3, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.ok(receipt.steps.every(step => {
    const effect = step.effect, attempt = effect && attemptById.get(effect.receiptAttemptId)
    return effect && effect.receiptKind === (kinds[step.kind] ?? 'model') && /^[a-f0-9]{64}$/u.test(effect.contentHash ?? '')
      && attempt?.runId === step.runId && attempt.artifactId
  }), 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  const effect = kind => receipt.steps.find(step => step.kind === kind)?.effect
  const outlineAttempt = effect('outline')?.receiptAttemptId
  const draftAttempt = effect('draft')?.receiptAttemptId
  const reviewAttempt = effect('review')?.receiptAttemptId
  assert.equal(new Set([outlineAttempt, draftAttempt, reviewAttempt]).size, 3, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(effect('compose')?.receiptAttemptId, draftAttempt, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(effect('draft_commit')?.receiptAttemptId, draftAttempt, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(effect('review_commit')?.receiptAttemptId, reviewAttempt, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(effect('outline')?.contentHash, hash(fixtures[slot].marker + ' fictional outline.'), 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(effect('draft')?.contentHash, hash(fixtures[slot].prose), 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(effect('review')?.contentHash, hash(review), 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  const chapter = receipt.chapters?.[0]
  assert.equal(receipt.chapters?.length, 1, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(chapter?.draftSave?.kind, 'current', 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  const draft = chapter.draftSave.receipt
  assert.equal(draft.contentHash, hash(draft.content), 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(draft.content, fixtures[slot].prose, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(chapter?.review?.success, true, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(chapter.review.contentHash, hash(chapter.review.content), 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(chapter.review.source.id, draft.id, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(chapter.review.source.version, draft.version, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(chapter.review.source.chapterNumber, 1, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  const sourceHash = hash(chapter.review.source.content)
  assert.equal(sourceHash, draft.contentHash, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(effect('compose')?.contentHash, draft.contentHash, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(effect('draft_commit')?.contentHash, draft.contentHash, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  assert.equal(effect('review_commit')?.contentHash, chapter.review.contentHash, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  for (const artifact of receipt.historicalArtifacts ?? []) {
    const step = receipt.steps.find(item => ['outline', 'draft', 'continue', 'condense', 'review', 'review_rebuild'].includes(item.kind)
      && item.runId === artifact.runId && item.effect?.receiptAttemptId === artifact.attemptId)
    if (step?.effect) assert.equal(step.effect.contentHash, artifact.textHash, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
  }
  return { slot, state: 'waiting_review', attempts: 3, effects: 6, draftContentHash: draft.contentHash,
    reviewContentHash: chapter.review.contentHash, reviewSourceContentHash: sourceHash,
    requestMessagesHashes: requests[slot].map(x => x.messages), parameterHashes: requests[slot].map(x => x.parameters) }
}

export async function runWorkflowBatchComparisonScenario(context, dependencies = {}) {
  const { app, page, roots, invoke, fake } = context
  const invokeIPC = dependencies.invoke ?? invoke
  const grantDirectory = dependencies.grantDirectory ?? chooseProjectDirectoryGrant
  const ensureParentDirectory = dependencies.ensureParentDirectory ?? (parent => fs.mkdir(parent, { recursive: true }))
  const requestCount = dependencies.requestCount ?? (async () => app.evaluate(() => {
    const rows = globalThis.__driveModelRequests
    if (!Array.isArray(rows)) throw new Error('PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
    return rows.filter(x => x.path === '/v1/chat/completions').length
  }))
  const startProbe = dependencies.startProbe ?? startPerformanceBaseline
  const stopProbe = dependencies.stopProbe ?? stopPerformanceBaseline
  const readRequests = dependencies.readRequests ?? readModelRequestSummary
  const round = () => ({ status: 'not_started', startedBooks: 0, completedBooks: 0, wallMs: null, peakInFlight: null, guardedFetchRequests: null, fakeProviderRequests: null, books: [] })
  const opened = new Map(), records = [], pairs = orders.map((order, index) => ({ pair: index + 1, order, status: 'not_started', startedBooks: 0, completedBooks: 0, serial: round(), parallel: round() }))
  const report = { metadata: { ...performanceMetadata(12), books: 12 }, scenario: 'workflow-batch-serial-parallel-v1', attempted: 1, failed: 0, success: false, failureStage: null, cleanupFailures: 0, failureDiagnostics: [], measurements: null, requestSummary: null, finalRequestSummary: null, requestsAfterMeasurement: null, requestSummaryCutoff: 'after_drain_probe_stop', fixtureAcceptedRequests: null, finalFixtureAcceptedRequests: null, elapsedMs: null,
    fixture: { kind: 'local-openai-compatible-fiction', protocol: 'openai', model: FAKE_MODEL.modelName, temperature: FAKE_MODEL.temperature, configuredMaxTokens: FAKE_MODEL.maxTokens, skill: 'isolated-fixture-default-no-custom-install', corpusSha256: hash(fixtures) },
    requestEvidence: 'local-guarded-fetch-observation-not-remote-execution', limitations: ['fixed-fictional-provider-output-not-literary-quality', 'cache-uncontrolled', 'no-real-model',
      'three-local-pairs-not-statistical-qualification', 'not-real-model-speed-or-p95'] }
  const began = performance.now(), timingStart = fake?.chatTimings?.length ?? 0, chatStart = fake?.chats?.length ?? 0
  let failure = null, stage = 'fixture', probeStarted = false, initialRequests = 0, activePair = null, activeRound = null, activeRoundStart = null, activeRoundWindow = null
  let cutoffTimingCount = null, cutoffFakeRequestCount = null
  const captureRoundCounts = async window => {
    if (!window) return
    if (Number.isSafeInteger(window.requestAt)) {
      try {
        const current = await requestCount()
        if (Number.isSafeInteger(current) && current >= window.requestAt) window.round.guardedFetchRequests = current - window.requestAt
      } catch { /* Missing observation remains null. */ }
    }
    if (Number.isSafeInteger(window.timingAt) && Array.isArray(fake?.chatTimings)) {
      const timings = fake.chatTimings.slice(window.timingAt)
      window.round.fakeProviderRequests = timings.length
      if (timings.length > 0 && timings.every(item => Number.isFinite(item.startMs) && Number.isFinite(item.endMs)))
        window.round.peakInFlight = overlap(timings)
    }
  }
  async function open(book) {
    const view = await invokeIPC(page, 'project-runtime:v1:open-view', book.projectPath, randomUUID(), null)
    assert.equal(view?.success, true, 'PERFORMANCE_COMPARISON_SETUP_FAILED')
    opened.set(book.projectPath, book)
    return { project: view.project, session: { projectId: book.projectId, projectPath: book.projectPath, leaseId: view.project.sessionLease } }
  }
  async function close(book) {
    const { session } = await open(book)
    assert.equal((await invokeIPC(page, 'db:close', book.projectPath, session))?.success, true, 'PERFORMANCE_COMPARISON_CLEANUP_FAILED')
    opened.delete(book.projectPath)
  }
  const readReceipt = record => invokeIPC(page, 'workflow-batch:v2:read-receipt', { reference: record.reference })
  async function cleanup() {
    const errors = []
    try { fake?.gate?.release() } catch (error) { errors.push(error) }
    for (const record of records) {
      try {
        const current = await readReceipt(record)
        if (!['cancelled', 'waiting_review'].includes(current?.task?.state)) {
          const stopped = await invokeIPC(page, 'workflow-batch:v2:cancel', { reference: { ...record.reference, revision: current.task.revision } })
          assert.equal(stopped?.receipt?.task?.state, 'cancelled')
        }
      } catch (error) { errors.push(error) }
    }
    try { await waitForComparison(() => fake?.gate?.waiting === 0, 15_000) } catch (error) { errors.push(error) }
    try {
      await waitForComparison(() => fake.chatTimings.slice(timingStart).every(item => Number.isFinite(item.endMs)), 15_000)
      cutoffTimingCount = fake.chatTimings.length - timingStart
      cutoffFakeRequestCount = fake.requests.length
    } catch (error) { errors.push(error) }
    for (const book of [...opened.values()]) { try { await close(book) } catch (error) { errors.push(error) } }
    try { fake?.replyReview?.(null); fake?.streamProse?.(null); fake?.setChatDelay?.(0) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'PERFORMANCE_COMPARISON_CLEANUP_FAILED')
  }
  context.finalizePerformanceEvidence = async () => {
    try {
      report.finalRequestSummary = await readRequests(app)
      report.finalFixtureAcceptedRequests = fake.requests.length
      report.requestSummaryCutoff = 'before_quit'
      assert.equal(report.finalRequestSummary?.coverage, 'guarded_fetch_attempts', 'PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED')
      report.requestsAfterMeasurement = Object.fromEntries(['/v1/chat/completions', '/v1/embeddings', '/v1/messages'].map(route => [route, report.finalRequestSummary.byRoute[route].count - report.requestSummary.byRoute[route].count]))
      assert.ok(Object.values(report.requestsAfterMeasurement).every(x => x === 0), 'PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED')
      assert.equal(report.finalFixtureAcceptedRequests, report.fixtureAcceptedRequests, 'PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED')
      assertComparisonCutoff(fake.chatTimings.slice(timingStart), fake.chatTimings.length - timingStart, cutoffTimingCount, fake.requests.length, cutoffFakeRequestCount, Boolean(failure))
    } catch (cause) {
      report.success = false; report.failed = 1; report.failureStage ??= 'final_request_summary'; report.cleanupFailures++
      appendPerformanceFailureDiagnostic(report.failureDiagnostics, new Error('PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED'), 'cleanup', 'final_request_summary')
      const error = new Error('PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED', { cause }); error.performanceBaseline = report; throw error
    }
  }
  try {
    assert.ok(fake?.setChatDelay && fake?.chatTimings && fake?.gate && fake?.replyReview && fake?.streamProse, 'PERFORMANCE_COMPARISON_SETUP_FAILED')
    fake.streamProse(null); fake.setChatDelay(delayMs)
    fake.replyReview(prompt => {
      const matches = Object.entries(fixtures).filter(([, item]) => prompt.includes(item.marker))
      assert.equal(matches.length, 1, 'PERFORMANCE_COMPARISON_INPUT_MISMATCH')
      if (prompt.includes('[Strict evidence-anchor constraint]')) return review
      if (prompt.includes('Prepare a short chapter execution outline, not prose.')) return matches[0][1].marker + ' fictional outline.'
      return matches[0][1].prose
    })
    report.metadata.appRuntime = await app.evaluate(() => ({ electron: process.versions.electron ?? null, node: process.versions.node, chrome: process.versions.chrome ?? null }))
    initialRequests = await requestCount()
    stage = 'probe_start'; await startProbe(app, page); probeStarted = true
    for (const [index, order] of orders.entries()) {
      const pairResult = pairs[index]
      pairResult.status = 'running'; activePair = pairResult
      for (const mode of order) {
        const roundResult = pairResult[mode]
        roundResult.status = 'running'; activeRound = roundResult; activeRoundStart = null
        stage = 'workflow'
        const chatAt = Number.isSafeInteger(fake?.chats?.length) ? fake.chats.length : null
        const timingAt = Number.isSafeInteger(fake?.chatTimings?.length) ? fake.chatTimings.length : null
        activeRoundWindow = { round: roundResult, requestAt: null, chatAt, timingAt }
        activeRoundWindow.requestAt = await requestCount()
        const parent = path.join(roots.projects, (mode === 'serial' ? 's' : 'p') + (index + 1))
        await ensureParentDirectory(parent)
        const books = ['A', 'B'].map(slot => ({ slot, ...fixtures[slot] }))
        for (const book of books) {
          const grant = await grantDirectory(app, page, parent)
          const created = await invokeIPC(page, 'project:create', { parentGrantId: grant.grantId, name: 'Compare ' + book.slot, genre: 'Fictional mystery', targetAudience: 'Fictional adults', writingLanguage: 'en-US' }, randomUUID(), null)
          assert.equal(created?.success, true, 'PERFORMANCE_COMPARISON_SETUP_FAILED')
          Object.assign(book, { projectId: created.projectId, projectPath: created.projectPath })
        }
        if (index === 0 && mode === order[0]) assert.equal((await invokeIPC(page, 'llm:save-model', FAKE_MODEL))?.success, true, 'PERFORMANCE_COMPARISON_SETUP_FAILED')
        for (const book of books) {
          const { project, session } = await open(book)
          const novelConfig = { ...project.novelConfig, writingLanguage: 'en-US', wordsPerChapter: 100, totalChapters: 1, coreOutline: book.marker + ' fictional facts.', worldSetting: book.marker + ' fictional setting.', globalGuidance: 'Preserve ' + book.marker + ' facts.', writingStyle: 'Use concrete actions.' }
          assert.equal((await invokeIPC(page, 'project:update-config', book.projectId, { novelConfig }, book.projectPath, session))?.success, true, 'PERFORMANCE_COMPARISON_SETUP_FAILED')
          const blueprint = { chapterNumber: 1, title: book.marker + ' chapter', role: 'opening', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '' }
          assert.equal((await invokeIPC(page, 'db:blueprint-upsert', blueprint, book.projectPath, session))?.success, true, 'PERFORMANCE_COMPARISON_SETUP_FAILED')
          await close(book)
        }
        const live = []
        const start = async book => {
          const { session } = await open(book)
          const result = await invokeIPC(page, 'workflow-batch:v2:start', { operationKey: randomUUID(), modelId: FAKE_MODEL.id, reviewModelId: FAKE_MODEL.id, uiLocale: 'en-US', intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 1 }, targetUnits: 100 }, authorInputs: [] }, session)
          assert.ok(result?.reference && result.receipt?.task?.taskId, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
          const record = { book, reference: result.reference }; records.push(record); live.push(record)
          roundResult.startedBooks++; pairResult.startedBooks++
          return record
        }
        const waiting = async record => {
          return waitForComparison(async () => {
            const value = await readReceipt(record)
            assert.notEqual(value?.task?.state, 'blocked', 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
            return value?.task?.state === 'waiting_review' ? value : false
          })
        }
        const { requestAt } = activeRoundWindow
        const beganMode = performance.now()
        activeRoundStart = beganMode
        const markComplete = (record, receipt, chatList) => {
          const evidence = requestHashes(chatList, [record.book.slot])
          const item = receiptEvidence(receipt, record.book.slot, evidence)
          recordCompletedBook(pairResult, mode, item)
        }
        if (mode === 'serial') {
          await start(books[0])
          markComplete(live[0], await waiting(live[0]), fake.chats.slice(chatAt))
          await start(books[1])
          markComplete(live[1], await waiting(live[1]), fake.chats.slice(chatAt))
        } else {
          await start(books[0]); await start(books[1])
          for (const record of live) markComplete(record, await waiting(record), fake.chats.slice(chatAt))
        }
        const selectedTimings = fake.chatTimings.slice(timingAt)
        checkTimings(selectedTimings, 6)
        const booksEvidence = [...roundResult.books].sort((a, b) => a.slot.localeCompare(b.slot))
        const currentRequestCount = await requestCount()
        roundResult.guardedFetchRequests = Number.isSafeInteger(currentRequestCount) && Number.isSafeInteger(requestAt) && currentRequestCount >= requestAt ? currentRequestCount - requestAt : null
        roundResult.fakeProviderRequests = selectedTimings.length
        assert.equal(currentRequestCount, requestAt + 6, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
        const peakInFlight = overlap(selectedTimings)
        assert.equal(peakInFlight, mode === 'parallel' ? 2 : 1, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
        Object.assign(roundResult, { status: 'completed', wallMs: performance.now() - beganMode, peakInFlight, books: booksEvidence })
        activeRound = null; activeRoundStart = null
        for (const book of books) {
          await close(book)
          const ownedIndex = records.findIndex(item => item.book.projectId === book.projectId)
          if (ownedIndex >= 0) records.splice(ownedIndex, 1)
        }
        activeRoundWindow = null
      }
      for (const slot of ['A', 'B']) {
        const serial = pairResult.serial.books.find(book => book.slot === slot), parallel = pairResult.parallel.books.find(book => book.slot === slot)
        assert.deepEqual([serial.draftContentHash, serial.reviewContentHash, serial.reviewSourceContentHash], [parallel.draftContentHash, parallel.reviewContentHash, parallel.reviewSourceContentHash], 'PERFORMANCE_COMPARISON_INPUT_MISMATCH')
        assert.deepEqual(serial.requestMessagesHashes, parallel.requestMessagesHashes, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
        assert.deepEqual(serial.parameterHashes, parallel.parameterHashes, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
      }
      pairResult.status = 'completed'; activePair = null
    }
    assert.equal(pairs.every(pair => pair.status === 'completed' && pair.startedBooks === 4 && pair.completedBooks === 4), true, 'PERFORMANCE_COMPARISON_RECEIPT_INVALID')
    assert.equal(fake.chats.length - chatStart, 36, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
    checkTimings(fake.chatTimings.slice(timingStart), 36)
    assert.equal(await requestCount(), initialRequests + 36, 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
    stage = 'drain'
    await waitForComparison(() => fake.gate.waiting === 0)
  } catch (error) {
    failure = error
    if (activeRound?.status === 'running') {
      markComparisonFailure(activePair, activeRound === activePair?.serial ? 'serial' : 'parallel')
      if (activeRoundStart !== null) activeRound.wallMs = performance.now() - activeRoundStart
    }
    else if (activePair?.status === 'running') activePair.status = 'failed'
    appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'scenario', stage)
  }
  try { await cleanup() } catch (error) {
    report.cleanupFailures++
    appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'cleanup', 'cleanup')
    failure ??= new Error('PERFORMANCE_COMPARISON_CLEANUP_FAILED', { cause: error })
  }
  await captureRoundCounts(activeRoundWindow)
  if (probeStarted) {
    try {
      report.measurements = await stopProbe(app, page)
      assertPerformanceProbeCoverage(report.measurements)
    } catch (error) {
      report.cleanupFailures++
      appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'cleanup', 'probe_stop')
      failure ??= error
    }
  }
  report.elapsedMs = performance.now() - began
  try {
    report.requestSummary = await readRequests(app)
    report.fixtureAcceptedRequests = fake.requests.length
    assert.equal(report.requestSummary?.coverage, 'guarded_fetch_attempts', 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
  } catch (error) { failure ??= error; appendPerformanceFailureDiagnostic(report.failureDiagnostics, error, 'scenario', 'request_summary') }
  report.pairedComparison = { schemaVersion: 1, samples: 3, booksPerRound: 2, plannedBooks: 12,
    startedBooks: pairs.reduce((sum, pair) => sum + pair.startedBooks, 0), completedBooks: pairs.reduce((sum, pair) => sum + pair.completedBooks, 0),
    responseDelayMs: delayMs, source: 'isolated-electron-registered-ipc-main-owner',
    sampling: 'three-local-pairs-not-statistical-qualification', pairs, sameInputHashes: pairs.every(pair => pair.status === 'completed') && !failure }
  report.failed = failure ? 1 : 0; report.success = !failure
  if (failure) {
    report.failureStage ??= stage
    const allowed = ['PERFORMANCE_COMPARISON_TIMEOUT', 'PERFORMANCE_COMPARISON_SETUP_FAILED', 'PERFORMANCE_COMPARISON_INPUT_MISMATCH', 'PERFORMANCE_COMPARISON_RECEIPT_INVALID', 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH', 'PERFORMANCE_COMPARISON_CLEANUP_FAILED', 'PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED', 'PERFORMANCE_PROBE_COVERAGE_UNAVAILABLE', 'ERR_ASSERTION']
    const code = allowed.includes(failure?.code) ? failure.code : allowed.includes(failure?.message) ? failure.message : 'PERFORMANCE_COMPARISON_SETUP_FAILED'
    const wrapped = new Error(code, { cause: failure }); wrapped.code = code
    wrapped.performanceBaseline = report
    throw wrapped
  }
  return report
}

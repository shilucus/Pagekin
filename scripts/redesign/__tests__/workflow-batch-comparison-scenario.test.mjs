import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { countDraftUnits, draftTargetUnitRange } from '../../../src/shared/draft-units.ts'
import { assertProjectStoragePathSupported } from '../../../electron/services/project-storage-preflight.ts'
import { assertComparisonCutoff, checkTimings, fixtures, markComparisonFailure, overlap, receiptEvidence, recordCompletedBook, requestHashes, runWorkflowBatchComparisonScenario, waitForComparison } from '../workflow-batch-comparison-scenario.mjs'

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex')
const validReceipt = () => {
  const draftContent = fixtures.A.prose
  const reviewContent = JSON.stringify({ summary: 'Fictional review.', items: [{ category: 'continuity', severity: 'pass', description: 'Compared fictional source and plan.' }], goalReviews: [] })
  const draftHash = hash(draftContent), reviewHash = hash(reviewContent)
  const draftRunId = 'draft-run', reviewRunId = 'review-run'
  const attempts = [
    { runId: draftRunId, attemptId: 'outline-attempt', status: 'settled', artifactId: 'outline-artifact' },
    { runId: draftRunId, attemptId: 'draft-attempt', status: 'settled', artifactId: 'draft-artifact' },
    { runId: reviewRunId, attemptId: 'review-attempt', status: 'settled', artifactId: 'review-artifact' },
  ]
  const step = (kind, runId, attemptId, receiptKind, contentHash) => ({ stepId: kind, commandId: kind, chapterNumber: 1, role: kind.startsWith('review') ? 'review' : 'draft', kind, slot: 0, runId, inputHash: hash(kind), effect: { receiptKind, receiptAttemptId: attemptId, contentHash } })
  const receipt = {
    task: { state: 'waiting_review' }, attempts,
    steps: [
      step('outline', draftRunId, 'outline-attempt', 'model', hash(fixtures.A.marker + ' fictional outline.')),
      step('draft', draftRunId, 'draft-attempt', 'model', draftHash),
      step('compose', draftRunId, 'draft-attempt', 'composition', draftHash),
      step('draft_commit', draftRunId, 'draft-attempt', 'draft_commit', draftHash),
      step('review', reviewRunId, 'review-attempt', 'model', hash(reviewContent)),
      step('review_commit', reviewRunId, 'review-attempt', 'review_commit', reviewHash),
    ],
    chapters: [{ chapterNumber: 1, draftSave: { kind: 'current', receipt: { id: 'draft-id', version: 1, content: draftContent, contentHash: draftHash } },
      review: { success: true, content: reviewContent, contentHash: reviewHash, source: { id: 'draft-id', version: 1, chapterNumber: 1, content: draftContent } } }],
  }
  return { receipt, requests: { A: [{ messages: hash('messages'), parameters: hash('parameters') }], B: [] } }
}
function createScenarioFailureFixture({ failAt, unavailableRoundBaseline = false }) {
  const projects = new Map(), receipt = validReceipt().receipt
  const parents = [], createdNames = []
  let nextProject = 0, starts = 0, requestTotal = 0
  const fake = { chats: [], chatTimings: [], requests: [], gate: { waiting: 0, release() {} },
    setChatDelay() {}, streamProse() {}, replyReview() {} }
  const summary = () => ({ coverage: 'guarded_fetch_attempts', byRoute: {
    '/v1/chat/completions': { count: requestTotal }, '/v1/embeddings': { count: 0 }, '/v1/messages': { count: 0 } } })
  const invoke = async (_page, channel, ...args) => {
    if (channel === 'project:create') {
      createdNames.push(args[0].name)
      if (failAt === 'create') return { success: false }
      const projectId = 'project-' + (++nextProject), projectPath = 'C:/comparison-fixture/' + projectId
      projects.set(projectPath, { projectId, projectPath, slot: args[0].name.endsWith('A') ? 'A' : 'B', novelConfig: {} })
      return { success: true, projectId, projectPath }
    }
    if (channel === 'project-runtime:v1:open-view') {
      const project = projects.get(args[0])
      return { success: true, project: { ...project, sessionLease: 'lease-' + project.projectId } }
    }
    if (['llm:save-model', 'project:update-config', 'db:blueprint-upsert', 'db:close'].includes(channel)) return { success: true }
    if (channel === 'workflow-batch:v2:start') {
      starts++
      if (failAt === 'second-start' && starts === 2) return {}
      const project = [...projects.values()].find(item => item.projectId === args.at(-1).projectId)
      for (let index = 0; index < 3; index++) {
        const startMs = index * 2
        fake.chatTimings.push({ index, startMs, endMs: startMs + 1, statusCode: 200, completed: true })
        fake.chats.push({ messages: [{ role: 'user', content: fixtures[project.slot].marker + ' request ' + index }], requestParametersHash: 'a'.repeat(64) })
        fake.requests.push('chat')
        requestTotal++
      }
      return { reference: { taskId: 'task-' + starts, revision: 1 }, receipt: { task: { taskId: 'task-' + starts } } }
    }
    if (channel === 'workflow-batch:v2:read-receipt') return receipt
    throw new Error('Unexpected fixture IPC channel: ' + channel)
  }
  const context = { app: { evaluate: async () => ({ electron: 'fixture', node: 'fixture', chrome: 'fixture' }) },
    page: {}, roots: { projects: 'C:/comparison-fixture' }, invoke, fake }
  let requestCountCalls = 0
  const dependencies = {
    ensureParentDirectory: async parent => { parents.push(parent) },
    grantDirectory: async () => ({ grantId: 'grant' }),
    invoke,
    requestCount: async () => {
      requestCountCalls++
      if (unavailableRoundBaseline && requestCountCalls > 1) throw new Error('fixture observation unavailable')
      return requestTotal
    },
    startProbe: async () => {},
    stopProbe: async () => ({ stopFailures: { main: 0, renderer: 0 }, coverage: { main: 'live_zero_events', renderer: 'live_zero_events' },
      main: { eventLoop: { count: 1 } }, renderer: { heartbeat: { count: 1 } } }),
    readRequests: async () => summary(),
  }
  return { context, dependencies, parents, createdNames, counters: () => ({ starts, requestTotal }) }
}

// Injected scenarios cover local control flow only, not registered Electron or production executor wiring.
describe('workflow batch comparison evidence helpers', () => {
  it('groups exact messages by fictional book marker and retains parameter identity', () => {
    const chats = ['A', 'B'].flatMap(slot => [1, 2, 3].map(index => ({ model: 'gpt-4.1', maxTokens: 4096, temperature: 0.7, requestParametersHash: String(index).repeat(64),
      messages: [{ role: 'user', content: 'CMPBOOK' + slot + ' request ' + index }] })))
    const result = requestHashes(chats)
    expect(result.A).toHaveLength(3)
    expect(result.B).toHaveLength(3)
    expect(new Set(result.A.map(item => item.messages)).size).toBe(3)
    expect(result.A.map(item => item.parameters)).toEqual(['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)])
  })
  it('rejects missing, ambiguous or unassigned request evidence', () => {
    expect(() => requestHashes([])).toThrow('PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
    expect(() => requestHashes([{ messages: [{ content: 'CMPBOOKA CMPBOOKB' }] }])).toThrow('PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
  })
  it('counts only completed overlapping provider response windows', () => {
    const items = [{ startMs: 1, endMs: 6, completed: true, statusCode: 200 }, { startMs: 2, endMs: 4, completed: true, statusCode: 200 },
      { startMs: 6, endMs: 8, completed: true, statusCode: 200 }]
    expect(overlap(items)).toBe(2)
    expect(() => checkTimings(items, 3)).not.toThrow()
    expect(() => checkTimings([{ ...items[0], completed: false }], 1)).toThrow('PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
    expect(() => checkTimings(items, 2)).toThrow('PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
  })
  it('bounds a wait instead of leaving a scenario promise pending forever', async () => {
    await expect(waitForComparison(() => false, 0)).rejects.toThrow('PERFORMANCE_COMPARISON_TIMEOUT')
  })
  it('retains a completed serial round when the parallel round fails partway', () => {
    const serialEvidence = ['A', 'B'].map(slot => ({ slot, state: 'waiting_review', attempts: 3, effects: 6 }))
    const parallelPrefix = [{ ...serialEvidence[0] }]
    const pair = { status: 'running', completedBooks: 0,
      serial: { status: 'running', completedBooks: 0, books: [] },
      parallel: { status: 'running', completedBooks: 0, books: [] } }
    recordCompletedBook(pair, 'serial', serialEvidence[0])
    recordCompletedBook(pair, 'serial', serialEvidence[1])
    pair.serial.status = 'completed'
    recordCompletedBook(pair, 'parallel', parallelPrefix[0])
    markComparisonFailure(pair, 'parallel')
    expect(pair).toMatchObject({ status: 'failed', completedBooks: 3,
      serial: { status: 'completed', completedBooks: 2, books: serialEvidence },
      parallel: { status: 'failed', completedBooks: 1, books: parallelPrefix } })
  })
  it('retains zero-started early failures without requiring a full successful sample at final cutoff', () => {
    const pair = { status: 'running', startedBooks: 0, completedBooks: 0, serial: { status: 'running', startedBooks: 0, completedBooks: 0, books: [] } }
    markComparisonFailure(pair, 'serial')
    expect(pair).toMatchObject({ status: 'failed', startedBooks: 0, completedBooks: 0, serial: { status: 'failed', startedBooks: 0, completedBooks: 0, books: [] } })
    expect(() => assertComparisonCutoff([], 0, 0, 0, 0, true)).not.toThrow()
    expect(() => assertComparisonCutoff([{ startMs: 2, endMs: 8, completed: false }], 1, 1, 0, 0, true)).not.toThrow()
    expect(() => assertComparisonCutoff([], 0, 0, 0, 0, false)).toThrow('PERFORMANCE_COMPARISON_REQUEST_MISMATCH')
  })
  it('captures actual request counters after drain when the second serial start fails', async () => {
    const fixture = createScenarioFailureFixture({ failAt: 'second-start' })
    let error
    try { await runWorkflowBatchComparisonScenario(fixture.context, fixture.dependencies) } catch (caught) { error = caught }
    expect(error?.performanceBaseline).toBeDefined()
    const report = error.performanceBaseline
    const pair = report.pairedComparison.pairs[0]
    expect(pair).toMatchObject({ status: 'failed', startedBooks: 1, completedBooks: 1,
      serial: { status: 'failed', startedBooks: 1, completedBooks: 1, guardedFetchRequests: 3, fakeProviderRequests: 3,
        books: [{ slot: 'A', state: 'waiting_review' }] },
      parallel: { status: 'not_started', guardedFetchRequests: null, fakeProviderRequests: null } })
    await fixture.context.finalizePerformanceEvidence()
    expect(report.cleanupFailures).toBe(0)
    expect(fixture.counters()).toMatchObject({ starts: 2, requestTotal: 3 })
  })
  it('records observed zero requests for a real early setup failure', async () => {
    const fixture = createScenarioFailureFixture({ failAt: 'create' })
    let error
    try { await runWorkflowBatchComparisonScenario(fixture.context, fixture.dependencies) } catch (caught) { error = caught }
    expect(error?.performanceBaseline).toBeDefined()
    const report = error.performanceBaseline
    expect(report.pairedComparison.pairs[0]).toMatchObject({ status: 'failed', startedBooks: 0, completedBooks: 0,
      serial: { status: 'failed', startedBooks: 0, completedBooks: 0, guardedFetchRequests: 0, fakeProviderRequests: 0, books: [] },
      parallel: { status: 'not_started', guardedFetchRequests: null, fakeProviderRequests: null } })
    await fixture.context.finalizePerformanceEvidence()
    expect(report.cleanupFailures).toBe(0)
  })
  it('fits the Windows derived-storage gate at a 72-character isolated projects root', async () => {
    const fixture = createScenarioFailureFixture({ failAt: 'create' })
    await expect(runWorkflowBatchComparisonScenario(fixture.context, fixture.dependencies)).rejects.toThrow()
    const parent = path.basename(fixture.parents[0])
    expect(parent).toBe('s1')
    const root = path.win32.join('C:\\' + 'f'.repeat(69), parent, fixture.createdNames[0])
    expect(root).toHaveLength(85)
    expect(() => assertProjectStoragePathSupported(root, { platform: 'win32' })).not.toThrow()
    const oldRoot = path.win32.join('C:\\' + 'f'.repeat(69), 'workflow-comparison-1-serial', fixture.createdNames[0])
    expect(() => assertProjectStoragePathSupported(oldRoot, { platform: 'win32' })).toThrow()
  })
  it('leaves a failed-round counter null when its baseline observation is unavailable', async () => {
    const fixture = createScenarioFailureFixture({ failAt: 'create', unavailableRoundBaseline: true })
    let error
    try { await runWorkflowBatchComparisonScenario(fixture.context, fixture.dependencies) } catch (caught) { error = caught }
    expect(error?.performanceBaseline).toBeDefined()
    const report = error.performanceBaseline
    expect(report.pairedComparison.pairs[0].serial).toMatchObject({ status: 'failed', guardedFetchRequests: null, fakeProviderRequests: 0 })
    await fixture.context.finalizePerformanceEvidence()
    expect(report.cleanupFailures).toBe(0)
  })
  it('uses the production draft-unit range for both fixed fictional chapter inputs', () => {
    const range = draftTargetUnitRange(100)
    for (const fixture of Object.values(fixtures)) expect(countDraftUnits(fixture.prose)).toBeGreaterThanOrEqual(range.minimum)
    for (const fixture of Object.values(fixtures)) expect(countDraftUnits(fixture.prose)).toBeLessThanOrEqual(range.maximum)
  })
  it('binds receipts to settled attempts, model artifacts and committed draft/review hashes', () => {
    const { receipt, requests } = validReceipt()
    expect(receipt).not.toHaveProperty('historicalArtifacts')
    expect(receiptEvidence(receipt, 'A', requests)).toMatchObject({ state: 'waiting_review', draftContentHash: receipt.chapters[0].draftSave.receipt.contentHash })
    const forgedAttempt = structuredClone(receipt)
    forgedAttempt.steps.find(item => item.kind === 'outline').effect.receiptAttemptId = 'draft-attempt'
    expect(() => receiptEvidence(forgedAttempt, 'A', requests)).toThrow('PERFORMANCE_COMPARISON_RECEIPT_INVALID')
    const forgedDerivedAttempt = structuredClone(receipt)
    forgedDerivedAttempt.steps.find(item => item.kind === 'compose').effect.receiptAttemptId = 'outline-attempt'
    expect(() => receiptEvidence(forgedDerivedAttempt, 'A', requests)).toThrow('PERFORMANCE_COMPARISON_RECEIPT_INVALID')
    for (const kind of ['outline', 'draft', 'review', 'compose', 'draft_commit', 'review_commit']) {
      const forgedCommit = structuredClone(receipt)
      forgedCommit.steps.find(item => item.kind === kind).effect.contentHash = hash('forged committed content')
      expect(() => receiptEvidence(forgedCommit, 'A', requests)).toThrow('PERFORMANCE_COMPARISON_RECEIPT_INVALID')
    }
  })
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'vitest'

import { REAL_SCENARIOS } from '../real-scenarios.mjs'

const SESSION = { projectId: 'fictional-project', leaseId: 'fictional-lease', projectPath: 'fictional-path' }
const BASE_ID = 'fictional-base'
const CANDIDATE_ID = 'fictional-candidate'
const BASE_TEXT = 'Fictional saved premise'
const CANDIDATE_TEXT = 'Fictional adopted premise with the lighthouse and map.'
const CORE = { projectName: 'Fictional', genre: 'mystery', subGenre: '', targetAudience: 'adult', totalChapters: 8,
  wordsPerChapter: 800, writingLanguage: 'en-US', creativeStrategy: '', plotStructure: '', narrativePov: '', writingStyle: '',
  referenceWorks: '', globalGuidance: '', goldenFinger: '', coreOutline: '', worldSetting: '', protagonistProfile: '',
  premise: BASE_TEXT, worldbuilding: '' }

const baseSummary = { baseId: BASE_ID, projectId: SESSION.projectId, target: 'premise', createdAt: 1, closedAt: null, closedByAdoptionId: null }
const base = { schemaVersion: 1, ...baseSummary, sourceRevision: 1, sourceHash: 'fictional-source-hash',
  scope: { kind: 'field', field: 'premise' }, value: BASE_TEXT, valueHash: 'fictional-base-value-hash', source: CORE }
const candidate = { schemaVersion: 1, candidateId: CANDIDATE_ID, projectId: SESSION.projectId, baseId: BASE_ID,
  parentCandidateId: null, generationParentHash: 'fictional-generation-parent-hash', text: CANDIDATE_TEXT,
  textHash: 'fictional-candidate-hash', feedback: 'Fictional author feedback', constraints: [],
  origin: { kind: 'generated', runId: 'fictional-run', attemptId: 'fictional-attempt', artifactId: 'fictional-artifact',
    modelLeaseRevision: 'fictional-model-revision', skillSnapshotHash: 'fictional-skill-hash', contextSnapshotHash: 'fictional-context-hash' },
  createdAt: 2 }
const adoption = { schemaVersion: 1, adoptionId: 'fictional-adoption', projectId: SESSION.projectId, baseId: BASE_ID,
  candidateId: CANDIDATE_ID, idempotencyKey: 'fictional-operation', requestHash: 'fictional-request-hash', target: 'premise',
  adoptedScope: { kind: 'field', field: 'premise' }, decision: 'full', decisionSource: 'author-action', text: CANDIDATE_TEXT,
  textHash: 'fictional-candidate-hash', beforeValue: BASE_TEXT, beforeHash: 'fictional-base-value-hash',
  sourceRevision: 1, committedRevision: 2, createdAt: 3 }
const readyHistory = { base, candidates: [{ candidate, state: 'ready' }], adoptions: [] }
const adoptedHistory = { base: { ...base, closedAt: 3, closedByAdoptionId: adoption.adoptionId },
  candidates: [{ candidate, state: 'adopted' }], adoptions: [adoption] }

function makeContext({ malformedBaseSummary = false } = {}) {
  const events = []
  const page = {
    getByRole(role, options) {
      if (role === 'navigation') {
        assert.equal(options.name, '创作流程')
        return { getByRole: (buttonRole, buttonOptions) => {
          assert.equal(buttonRole, 'button')
          assert.ok(buttonOptions.name.test('架构'))
          return { click: async () => events.push('open-architecture') }
        } }
      }
      assert.equal(role, 'dialog')
      assert.equal(options.name, '意见修订：故事前提')
      return dialog
    },
    locator(selector) {
      assert.equal(selector, '.arch-section[data-section="premise"]')
      return { getByRole: (role, options) => {
        assert.equal(role, 'button')
        assert.equal(options.name, '意见修订')
        return { click: async () => events.push('open-feedback') }
      } }
    },
  }
  const dialog = {
    getByLabel() {
      throw new Error('FEEDBACK_LABEL_IS_NOT_PROGRAMMATICALLY_ASSOCIATED')
    },
    getByRole(role, options) {
      if (role === 'textbox') {
        assert.deepEqual(options, { name: '例如：节奏加快，增加反转，语言风格更具压迫感…', exact: true })
        return { fill: async value => events.push(['feedback', value]) }
      }
      assert.equal(role, 'button')
      if (options.name === '生成候选') return { click: async () => events.push('generate') }
      if (options.name === '采用此候选') return {
        waitFor: async ({ state }) => { assert.equal(state, 'visible'); events.push('candidate-ready') },
        click: async () => events.push('adopt'),
      }
      throw new Error(`Unexpected dialog button ${options.name}`)
    },
    waitFor: async ({ state }) => { assert.equal(state, 'hidden'); events.push('dialog-closed') },
  }
  let coreReads = 0
  let historyReads = 0
  let appEvaluations = 0
  const calls = []
  const app = { evaluate: async () => {
    appEvaluations++
    return appEvaluations <= 5 ? SESSION : [{ path: '/v1/chat/completions', status: 200, ms: 12 }]
  } }
  const invoke = async (...args) => {
    calls.push(args)
    const [, channel, request, projectPathOrSession, maybeSession] = args
    if (channel === 'db:project-core-get') {
      assert.equal(request, SESSION.projectPath)
      assert.deepEqual(projectPathOrSession, SESSION)
      assert.equal(maybeSession, undefined)
      coreReads++
      return { ...CORE, premise: coreReads === 1 ? BASE_TEXT : CANDIDATE_TEXT }
    }
    assert.deepEqual(projectPathOrSession, SESSION)
    assert.equal(maybeSession, undefined, `${channel} accepts request and session, not a projectPath`)
    if (channel === 'planning-feedback:v1:list-bases') {
      assert.deepEqual(request, { target: 'premise' })
      return [malformedBaseSummary ? { ...baseSummary, baseId: undefined } : baseSummary]
    }
    assert.equal(channel, 'planning-feedback:v1:read-history')
    if (malformedBaseSummary && request.baseId === undefined) throw new Error('PLANNING_FEEDBACK_BASE_ID_REQUIRED')
    if (request.baseId !== BASE_ID) throw new Error('PLANNING_FEEDBACK_BASE_NOT_FOUND')
    historyReads++
    return historyReads === 1 ? readyHistory : adoptedHistory
  }
  const context = { page, app, invoke, maxRealRequests: 1, shoot: async name => events.push(`screenshot:${name}`) }
  return { context, events, calls }
}

it('executes the real feedback scene through generation, author adoption, core persistence and receipt assertions', async () => {
  const { context, events, calls } = makeContext()
  const result = await REAL_SCENARIOS['real-feedback-adopt'].run(context)

  assert.deepEqual(events, ['open-architecture', 'open-feedback',
    ['feedback', '保留林岚、旧港与雾钟，把父亲留下的地图线索写得更悬疑。'], 'generate', 'candidate-ready',
    'screenshot:real-feedback-candidate', 'adopt', 'dialog-closed', 'screenshot:real-feedback-adopted'])
  assert.deepEqual(calls.filter(([, channel]) => channel === 'planning-feedback:v1:list-bases')
    .map(([, , request, session]) => [request, session]), [[{ target: 'premise' }, SESSION]])
  assert.deepEqual(calls.filter(([, channel]) => channel === 'planning-feedback:v1:read-history')
    .map(([, , request, session]) => [request, session]), [[{ baseId: BASE_ID }, SESSION], [{ baseId: BASE_ID }, SESSION]])
  assert.equal(result.candidateId, CANDIDATE_ID)
  assert.equal(result.adoptionId, adoption.adoptionId)
  assert.equal(result.requestCount, 1)
  assert.deepEqual(result.requestPaths, ['/v1/chat/completions'])
})

it('rejects a malformed base-summary identity before clicking adopt', async () => {
  const { context, events } = makeContext({ malformedBaseSummary: true })
  await assert.rejects(REAL_SCENARIOS['real-feedback-adopt'].run(context), /PLANNING_FEEDBACK_BASE_ID_REQUIRED/)
  assert.ok(events.includes('generate'), 'the malformed response follows the generation result')
  assert.ok(!events.includes('adopt'), 'invalid history identity cannot reach author adoption')
})

const ROUND_FEEDBACK = [
  '保留林岚、旧港与雾钟，把父亲留下的地图线索写得更悬疑。',
  '在第一轮候选基础上，让地图线索与雾钟的时间偏差形成更清楚的因果，保留林岚和旧港。',
]
const digest = value => createHash('sha256').update(value).digest('hex')

function makeMultiroundContext({ wrongParent = false, wrongParentHash = false, earlyFormalWrite = false,
  lostHistory = false, extraRequestOnReopen = false, unknownFirstGeneration = false } = {}) {
  const events = [], calls = [], requests = []
  let generated = 0, adopted = false, opens = 0, closed = false
  const captured = { ...base, valueHash: digest(BASE_TEXT) }
  const first = { ...candidate, textHash: digest(CANDIDATE_TEXT), generationParentHash: captured.valueHash,
    feedback: ROUND_FEEDBACK[0] }
  const secondText = 'Fictional second-round premise connecting the map and the bell.'
  const second = { ...candidate, candidateId: 'fictional-second-candidate', text: secondText, textHash: digest(secondText),
    feedback: ROUND_FEEDBACK[1], parentCandidateId: wrongParent ? null : first.candidateId,
    generationParentHash: wrongParentHash ? captured.valueHash : first.textHash,
    origin: { ...candidate.origin, runId: 'fictional-second-run', attemptId: 'fictional-second-attempt', artifactId: 'fictional-second-artifact' },
    createdAt: 3 }
  const adoptedReceipt = { ...adoption, candidateId: second.candidateId, text: second.text,
    textHash: second.textHash, beforeHash: captured.valueHash }
  const reopened = { ...captured, baseId: 'fictional-reopened-base', value: second.text, valueHash: second.textHash,
    source: { ...CORE, premise: second.text }, sourceRevision: adoptedReceipt.committedRevision }
  const history = () => ({
    base: adopted ? { ...captured, closedAt: 4, closedByAdoptionId: adoptedReceipt.adoptionId } : captured,
    candidates: (generated === 1 ? [first] : [first, second]).map(item => ({ candidate: item,
      state: adopted ? item === second ? 'adopted' : 'conflict' : 'ready' })),
    adoptions: adopted ? [adoptedReceipt] : [],
  })
  const dialog = {
    getByRole(role, options) {
      if (role === 'textbox') {
        assert.deepEqual(options, { name: '例如：节奏加快，增加反转，语言风格更具压迫感…', exact: true })
        return { fill: async text => events.push(['feedback', text]) }
      }
      if (role === 'tab') {
        if (!options) return { count: async () => { assert.equal(opens, 2); return 0 } }
        const round = options.name === '第 1 轮 (C1)' ? 1 : options.name === '第 2 轮 (C2)' ? 2 : 0
        assert.ok(round)
        return { waitFor: async () => {
          if (unknownFirstGeneration && round === 1) throw new Error('FICTIONAL_UNKNOWN_OUTCOME')
          assert.equal(generated, round); events.push(`round-${round}-visible`)
        },
          getAttribute: async name => { assert.equal(name, 'data-active'); return generated === round ? 'true' : 'false' } }
      }
      assert.equal(role, 'button')
      if (options.name === '生成候选') return { click: async () => {
        generated++
        assert.ok(generated <= 2, 'no third generation is allowed')
        requests.push({ path: '/v1/chat/completions', status: 200, ms: 12 })
        events.push(`generate-${generated}`)
      } }
      if (options.name === '基于此候选继续提意见 (开启新一轮)') return { click: async () => {
        assert.equal(generated, 1); assert.equal(adopted, false); events.push('iterate-from-first')
      } }
      if (options.name === '采用此候选') return {
        waitFor: async () => assert.equal(generated, 2),
        click: async () => { assert.equal(generated, 2); adopted = true; events.push('adopt-second') },
      }
      if (options.name === '放弃 / 关闭') return { click: async () => { closed = true; events.push('dismiss-reopened') } }
      throw new Error(`Unexpected dialog button ${options.name}`)
    },
    getByText: text => ({ waitFor: async () => {
      assert.equal(text, '基于选定候选追加修改意见：'); events.push('parent-feedback-visible')
    } }),
    waitFor: async ({ state }) => { assert.equal(state, 'hidden'); assert.ok(adopted || closed); events.push('dialog-closed') },
  }
  const page = {
    getByRole(role, options) {
      if (role === 'navigation') return { getByRole: () => ({ click: async () => events.push('open-architecture') }) }
      assert.equal(role, 'dialog'); assert.equal(options.name, '意见修订：故事前提'); return dialog
    },
    locator(selector) {
      assert.equal(selector, '.arch-section[data-section="premise"]')
      return { getByRole: (role, options) => {
        assert.equal(role, 'button'); assert.equal(options.name, '意见修订')
        return { click: async () => {
          opens++; events.push(`open-feedback-${opens}`)
          if (opens === 2 && extraRequestOnReopen) requests.push({ path: '/v1/chat/completions', status: 200, ms: 12 })
        } }
      } }
    },
  }
  const context = {
    page, maxRealRequests: 2,
    app: { evaluate: async fn => {
      if (String(fn).includes('__driveModelRequests')) return structuredClone(requests)
      assert.ok(String(fn).includes('__driveOpened'), 'the scene only reads the tracked session or model log')
      return SESSION
    } },
    invoke: async (...args) => {
      calls.push(args)
      const [, channel, request, projectPathOrSession, maybeSession] = args
      if (channel === 'db:project-core-get') {
        assert.equal(request, SESSION.projectPath); assert.deepEqual(projectPathOrSession, SESSION)
        return { ...CORE, premise: adopted ? second.text : earlyFormalWrite && generated ? first.text : BASE_TEXT }
      }
      assert.deepEqual(projectPathOrSession, SESSION); assert.equal(maybeSession, undefined)
      if (channel === 'planning-feedback:v1:list-bases') {
        assert.deepEqual(request, { target: 'premise' })
        return opens === 2 ? [{ ...baseSummary, baseId: reopened.baseId }, { ...baseSummary,
          closedAt: 4, closedByAdoptionId: adoptedReceipt.adoptionId }] : [baseSummary]
      }
      assert.equal(channel, 'planning-feedback:v1:read-history', 'the scene cannot inject or adopt through IPC')
      if (request.baseId === reopened.baseId) return { base: reopened, candidates: [], adoptions: [] }
      assert.equal(request.baseId, BASE_ID)
      const snapshot = history()
      if (opens === 2 && lostHistory) snapshot.candidates = []
      return structuredClone(snapshot)
    },
    restart: async () => { throw new Error('MULTIROUND_MUST_NOT_RESTART') },
    shoot: async name => events.push(`screenshot:${name}`),
  }
  return { context, events, calls, first, second, adoptedReceipt }
}

it('drives two fictional parent-linked UI rounds, adopts only the second and reads original history after reopen', async () => {
  const { context, events, calls, first, second, adoptedReceipt } = makeMultiroundContext()
  const result = await REAL_SCENARIOS['real-feedback-multiround'].run(context)
  assert.equal(events.filter(event => event === 'adopt-second').length, 1)
  assert.ok(events.indexOf('iterate-from-first') > events.indexOf('generate-1'))
  assert.ok(events.indexOf('generate-2') > events.indexOf('iterate-from-first'))
  assert.ok(events.indexOf('adopt-second') > events.indexOf('generate-2'))
  assert.ok(events.includes('open-feedback-2'))
  assert.ok(events.includes('dismiss-reopened'))
  assert.deepEqual(events.filter(Array.isArray).filter(([name]) => name === 'feedback').slice(0, 2),
    ROUND_FEEDBACK.map(text => ['feedback', text]))
  assert.deepEqual(result.rounds.map(round => [round.candidateId, round.parentCandidateId, round.generationParentHash]),
    [[first.candidateId, null, digest(BASE_TEXT)], [second.candidateId, first.candidateId, first.textHash]])
  assert.equal(result.adoptionId, adoptedReceipt.adoptionId)
  assert.equal(result.requestCount, 2)
  assert.equal(result.reopenCapturedNewBase, true)
  assert.equal(result.oldBaseHistoryVisibleInUi, false)
  assert.ok(calls.filter(([, channel]) => channel === 'planning-feedback:v1:read-history').length >= 4)
})

it.each([
  ['wrong-parent', { wrongParent: true }], ['wrong-parent-hash', { wrongParentHash: true }],
  ['early-formal-write', { earlyFormalWrite: true }],
])('rejects %s before the sole author adoption', async (_name, options) => {
  const { context, events } = makeMultiroundContext(options)
  await assert.rejects(REAL_SCENARIOS['real-feedback-multiround'].run(context))
  assert.ok(!events.includes('adopt-second'))
})

it.each([
  ['lost-original-history', { lostHistory: true }], ['third-request-on-reopen', { extraRequestOnReopen: true }],
])('does not claim persistence or the two-request boundary for %s', async (_name, options) => {
  const { context } = makeMultiroundContext(options)
  await assert.rejects(REAL_SCENARIOS['real-feedback-multiround'].run(context))
})

it('stops after an unconfirmed first generation without a retry, second round or adoption', async () => {
  const { context, events } = makeMultiroundContext({ unknownFirstGeneration: true })
  await assert.rejects(REAL_SCENARIOS['real-feedback-multiround'].run(context), /FICTIONAL_UNKNOWN_OUTCOME/)
  assert.deepEqual(events.filter(event => typeof event === 'string' && event.startsWith('generate-')), ['generate-1'])
  assert.ok(!events.includes('iterate-from-first'))
  assert.ok(!events.includes('adopt-second'))
})

it('rejects a direct scene call without the exact two-request budget before touching the author project', async () => {
  const { context, events, calls } = makeMultiroundContext()
  context.maxRealRequests = 1
  await assert.rejects(REAL_SCENARIOS['real-feedback-multiround'].run(context), /两个物理请求预算/)
  assert.deepEqual(events, [])
  assert.deepEqual(calls, [])
})

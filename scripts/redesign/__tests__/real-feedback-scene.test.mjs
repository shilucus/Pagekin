import assert from 'node:assert/strict'
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

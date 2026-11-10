import { describe, expect, it } from 'vitest'
import { PLANNING_FEEDBACK_TARGETS } from '../planning-feedback'
import { assertPlanningFeedbackRequest, PLANNING_FEEDBACK_IPC_VERSION, PLANNING_FEEDBACK_RANGE_IPC_VERSION,
  type PlanningFeedbackChannel, type PlanningFeedbackChannels, type PlanningFeedbackFieldChannel,
  type PlanningFeedbackRangeChannel } from '../planning-feedback-ipc'

const handle = { projectId: 'project-A', epoch: 'lease-A', rootActionId: 'root-A', runId: 'run-A' }
const input = { baseId: 'base-A', parentCandidateId: 'candidate-A', feedback: 'Remove the repeated sentence', constraints: ['Keep the author facts'] }
const requests = {
  'planning-feedback:v1:capture': { target: 'coreOutline' },
  'planning-feedback:v1:list-bases': { target: 'premise' },
  'planning-feedback:v1:read-history': { baseId: 'base-A' },
  'planning-feedback:v1:begin': { input, modelId: 'synthetic-model', uiActionNonce: 'author-action-A' },
  'planning-feedback:v1:execute': { handle },
  'planning-feedback:v1:read-run': { handle },
  'planning-feedback:v1:list-runs': { baseId: 'base-A' },
  'planning-feedback:v1:cancel': { handle },
  'planning-feedback:v1:stage': { ...input, runId: 'run-A', attemptId: 'attempt-A', artifactId: 'artifact-A' },
  'planning-feedback:v1:relineage': { baseId: 'base-A', sourceCandidateId: 'candidate-A', feedback: 'Explicit copy', constraints: [] },
  'planning-feedback:v1:adopt': { candidateId: 'candidate-A', idempotencyKey: 'adopt-A', decision: 'edited', text: 'Author final text\r\n' },
} satisfies { [C in PlanningFeedbackFieldChannel]: PlanningFeedbackChannels[C]['args'][0] }
const channels = Object.keys(requests) as PlanningFeedbackFieldChannel[]
const rangeTarget = { kind: 'plot-outline-range', from: 3, to: 4 } as const
const rangeRequests = {
  'planning-feedback:v2:capture': { target: rangeTarget },
  'planning-feedback:v2:list-bases': { target: rangeTarget },
  'planning-feedback:v2:read-history': { baseId: 'range-base-A' },
  'planning-feedback:v2:begin': { input, modelId: 'synthetic-model', uiActionNonce: 'author-action-A' },
  'planning-feedback:v2:execute': { handle },
  'planning-feedback:v2:read-run': { handle },
  'planning-feedback:v2:list-runs': { baseId: 'range-base-A' },
  'planning-feedback:v2:cancel': { handle },
  'planning-feedback:v2:stage': { ...input, runId: 'run-A', attemptId: 'attempt-A', artifactId: 'artifact-A' },
  'planning-feedback:v2:relineage': { baseId: 'range-base-A', sourceCandidateId: 'range-candidate-A', feedback: 'Explicit copy', constraints: [] },
  'planning-feedback:v2:adopt': { candidateId: 'range-candidate-A', idempotencyKey: 'range-adopt-A', decision: 'partial',
    text: 'Author range text\r\n', adoptedRange: { from: 3, to: 3 } },
} satisfies { [C in PlanningFeedbackRangeChannel]: PlanningFeedbackChannels[C]['args'][0] }
const rangeChannels = Object.keys(rangeRequests) as PlanningFeedbackRangeChannel[]

describe('closed planning feedback IPC v1', () => {
  it('exposes exactly eleven dedicated commands, independently of persisted task versions', () => {
    expect(PLANNING_FEEDBACK_IPC_VERSION).toBe(1)
    expect(channels.map(channel => channel.replace('planning-feedback:v1:', '')))
      .toEqual(['capture', 'list-bases', 'read-history', 'begin', 'execute', 'read-run', 'list-runs', 'cancel', 'stage', 'relineage', 'adopt'])
    for (const channel of channels) expect(() => assertPlanningFeedbackRequest(channel, requests[channel])).not.toThrow()
    expect(() => assertPlanningFeedbackRequest('planning-feedback:v3:capture' as PlanningFeedbackChannel, { target: 'premise' })).toThrow()
  })

  it.each(channels)('rejects absent bodies and unknown authority or task fields on %s', channel => {
    expect(() => assertPlanningFeedbackRequest(channel, undefined)).toThrow()
    for (const key of ['task', 'output', 'proof', 'source', 'generated', 'decisionSource', 'session']) {
      expect(() => assertPlanningFeedbackRequest(channel, { ...requests[channel], [key]: 'renderer-declaration' })).toThrow()
    }
  })

  it.each(PLANNING_FEEDBACK_TARGETS)('allows the original field target %s for capture and history discovery', target => {
    for (const channel of ['planning-feedback:v1:capture', 'planning-feedback:v1:list-bases'] as const) {
      expect(() => assertPlanningFeedbackRequest(channel, { target })).not.toThrow()
    }
  })

  it.each(['plotOutlineRange', 'synopsis', 'charactersArch', 'blueprint', { kind: 'plot-outline-range', from: 3, to: 4 }])('does not leak range or structured writers through field capture: %j', target => {
    expect(() => assertPlanningFeedbackRequest('planning-feedback:v1:capture', { target })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
    expect(() => assertPlanningFeedbackRequest('planning-feedback:v1:list-bases', { target })).toThrow('PLANNING_FEEDBACK_TARGET_INVALID')
  })

  it('rejects unscoped or malformed handles instead of accepting a runId as authority', () => {
    for (const channel of ['planning-feedback:v1:execute', 'planning-feedback:v1:read-run', 'planning-feedback:v1:cancel'] as const) {
      for (const value of [{}, { runId: 'run-A' }, { handle: { ...handle, epoch: undefined } },
        { handle: { ...handle, runId: 'C:/private.sqlite' } }, { handle: { ...handle, source: 'renderer' } }]) {
        expect(() => assertPlanningFeedbackRequest(channel, value)).toThrow()
      }
    }
  })

  it('validates nested begin inputs without accepting task, output or source overrides', () => {
    const request = requests['planning-feedback:v1:begin']
    for (const key of ['task', 'output', 'source', 'proof', 'modelId']) {
      expect(() => assertPlanningFeedbackRequest('planning-feedback:v1:begin', { ...request, input: { ...input, [key]: 'renderer' } })).toThrow()
    }
    for (const bad of [{ ...request, modelId: '' }, { ...request, uiActionNonce: ' ' }, { ...request, uiActionNonce: 'x'.repeat(257) },
      { ...request, input: { ...input, constraints: [{ text: 'not a string' }] } }, { ...request, input: { ...input, parentCandidateId: '../candidate' } }]) {
      expect(() => assertPlanningFeedbackRequest('planning-feedback:v1:begin', bad)).toThrow()
    }
  })

  it.each(['planning-feedback:v1:begin', 'planning-feedback:v1:stage', 'planning-feedback:v1:relineage'] as const)('rejects sparse constraints while retaining dense and empty arrays on %s', channel => {
    const payload = (constraints: readonly string[]) => channel === 'planning-feedback:v1:begin'
      ? { ...requests[channel], input: { ...input, constraints } }
      : { ...requests[channel], constraints }
    const partlySparse = new Array<string>(3)
    partlySparse[1] = 'Keep the author facts'
    for (const constraints of [new Array<string>(1), partlySparse]) {
      expect(Object.keys(constraints).length).toBeLessThan(constraints.length)
      expect(() => assertPlanningFeedbackRequest(channel, payload(constraints))).toThrow('PLANNING_FEEDBACK_PAYLOAD_INVALID')
    }
    for (const constraints of [[], ['Keep the author facts', 'Preserve these bytes\r\n']]) {
      const before = JSON.stringify(constraints)
      expect(() => assertPlanningFeedbackRequest(channel, payload(constraints))).not.toThrow()
      expect(JSON.stringify(constraints)).toBe(before)
    }
  })

  it('stages only artifact references and keeps author adoption free of generated or self-approved flags', () => {
    const stage = requests['planning-feedback:v1:stage'], adopt = requests['planning-feedback:v1:adopt']
    for (const key of ['text', 'textHash', 'origin', 'task']) {
      expect(() => assertPlanningFeedbackRequest('planning-feedback:v1:stage', { ...stage, [key]: 'renderer-content' })).toThrow()
    }
    for (const extra of [{ decisionSource: 'author-action' }, { generated: true }, { adoptedRange: { from: 3, to: 4 } }]) {
      expect(() => assertPlanningFeedbackRequest('planning-feedback:v1:adopt', { ...adopt, ...extra })).toThrow()
    }
    expect(() => assertPlanningFeedbackRequest('planning-feedback:v1:adopt', { ...adopt, decision: { toString: (): string => 'full' } })).toThrow()
    expect(adopt.text).toBe('Author final text\r\n')
  })
})

describe('closed planning feedback range IPC v2', () => {
  it('adds eleven separate commands without changing the v1 wire version or fields', () => {
    expect(PLANNING_FEEDBACK_IPC_VERSION).toBe(1)
    expect(PLANNING_FEEDBACK_RANGE_IPC_VERSION).toBe(2)
    expect(rangeChannels.map(channel => channel.replace('planning-feedback:v2:', '')))
      .toEqual(channels.map(channel => channel.replace('planning-feedback:v1:', '')))
    for (const channel of rangeChannels) expect(() => assertPlanningFeedbackRequest(channel, rangeRequests[channel])).not.toThrow()
    for (const channel of channels) expect(() => assertPlanningFeedbackRequest(channel, requests[channel])).not.toThrow()
  })

  it.each(rangeChannels)('rejects missing payloads and authority or output smuggling on %s', channel => {
    expect(() => assertPlanningFeedbackRequest(channel, undefined)).toThrow()
    for (const key of ['task', 'output', 'proof', 'source', 'generated', 'decisionSource', 'session', 'projectId', 'modelLease']) {
      expect(() => assertPlanningFeedbackRequest(channel, { ...rangeRequests[channel], [key]: 'renderer-declaration' })).toThrow()
    }
  })

  it.each(['planning-feedback:v2:capture', 'planning-feedback:v2:list-bases'] as const)(
    'accepts only a closed, bounded plot-outline-range scope on %s', channel => {
      for (const target of ['coreOutline', 'plotOutlineRange', null, {}, { kind: 'field', field: 'coreOutline' },
        { kind: 'blueprint', from: 3, to: 4 }, { ...rangeTarget, from: 0 }, { ...rangeTarget, to: 2 },
        { ...rangeTarget, from: 3.5 }, { ...rangeTarget, to: '4' }, { ...rangeTarget, from: Number.NaN },
        { ...rangeTarget, to: Number.POSITIVE_INFINITY }, { ...rangeTarget, to: 13 },
        { ...rangeTarget, to: Number.MAX_SAFE_INTEGER + 1 }, { ...rangeTarget, source: 'renderer' }]) {
        expect(() => assertPlanningFeedbackRequest(channel, { target })).toThrow()
      }
      for (const target of [rangeTarget, { kind: 'plot-outline-range', from: 1, to: 10 },
        { kind: 'plot-outline-range', from: 30, to: 30 }]) {
        const before = structuredClone(target)
        expect(() => assertPlanningFeedbackRequest(channel, { target })).not.toThrow()
        expect(target).toEqual(before)
      }
      expect(() => assertPlanningFeedbackRequest(channel, { target: rangeTarget, from: 3, to: 4 })).toThrow()
    },
  )

  it('validates nested inputs and artifact-only staging without accepting task or scope overrides', () => {
    for (const key of ['task', 'output', 'source', 'proof', 'modelId', 'target', 'scope', 'adoptedRange']) {
      expect(() => assertPlanningFeedbackRequest('planning-feedback:v2:begin', {
        ...rangeRequests['planning-feedback:v2:begin'], input: { ...input, [key]: 'renderer' },
      })).toThrow()
    }
    for (const key of ['text', 'textHash', 'origin', 'task', 'scope', 'target']) {
      expect(() => assertPlanningFeedbackRequest('planning-feedback:v2:stage', {
        ...rangeRequests['planning-feedback:v2:stage'], [key]: 'renderer',
      })).toThrow()
    }
    for (const channel of ['planning-feedback:v2:begin', 'planning-feedback:v2:stage', 'planning-feedback:v2:relineage'] as const) {
      const constraints = new Array<string>(1)
      const payload = channel === 'planning-feedback:v2:begin'
        ? { ...rangeRequests[channel], input: { ...input, constraints } }
        : { ...rangeRequests[channel], constraints }
      expect(() => assertPlanningFeedbackRequest(channel, payload)).toThrow('PLANNING_FEEDBACK_PAYLOAD_INVALID')
    }
  })

  it('retains closed handles and IDs on all range history, generation and lineage commands', () => {
    for (const channel of ['planning-feedback:v2:execute', 'planning-feedback:v2:read-run', 'planning-feedback:v2:cancel'] as const) {
      for (const value of [{ runId: 'run-A' }, { handle: { ...handle, epoch: undefined } },
        { handle: { ...handle, runId: 'C:/private.sqlite' } }, { handle: { ...handle, source: 'renderer' } }]) {
        expect(() => assertPlanningFeedbackRequest(channel, value)).toThrow()
      }
    }
    for (const channel of ['planning-feedback:v2:read-history', 'planning-feedback:v2:list-runs'] as const) {
      expect(() => assertPlanningFeedbackRequest(channel, { baseId: '../range-base' })).toThrow('PLANNING_FEEDBACK_ID_INVALID')
    }
    expect(() => assertPlanningFeedbackRequest('planning-feedback:v2:stage', {
      ...rangeRequests['planning-feedback:v2:stage'], artifactId: '../artifact',
    })).toThrow('PLANNING_FEEDBACK_ID_INVALID')
    expect(() => assertPlanningFeedbackRequest('planning-feedback:v2:relineage', {
      ...rangeRequests['planning-feedback:v2:relineage'], sourceCandidateId: '../candidate',
    })).toThrow('PLANNING_FEEDBACK_ID_INVALID')
  })

  it('allows an explicit bounded adoptedRange only in v2, never author approval or extra range keys', () => {
    const adopt = rangeRequests['planning-feedback:v2:adopt']
    const withoutRange = { candidateId: adopt.candidateId, idempotencyKey: adopt.idempotencyKey,
      decision: adopt.decision, text: adopt.text }
    expect(() => assertPlanningFeedbackRequest('planning-feedback:v2:adopt', withoutRange)).not.toThrow()
    expect(() => assertPlanningFeedbackRequest('planning-feedback:v1:adopt', adopt)).toThrow()
    for (const adoptedRange of [null, undefined, { from: 3 }, { from: 0, to: 3 }, { from: 4, to: 3 },
      { from: 3, to: 13 }, { from: 3, to: 3, kind: 'plot-outline-range' }, { from: 3, to: 3, source: 'author' }]) {
      expect(() => assertPlanningFeedbackRequest('planning-feedback:v2:adopt', { ...adopt, adoptedRange })).toThrow()
    }
    for (const extra of [{ decisionSource: 'author-action' }, { generated: true }, { humanConfirmed: true },
      { target: rangeTarget }, { textHash: 'a'.repeat(64) }]) {
      expect(() => assertPlanningFeedbackRequest('planning-feedback:v2:adopt', { ...adopt, ...extra })).toThrow()
    }
    expect(adopt.text).toBe('Author range text\r\n')
  })
})

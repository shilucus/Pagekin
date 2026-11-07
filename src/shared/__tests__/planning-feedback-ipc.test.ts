import { describe, expect, it } from 'vitest'
import { PLANNING_FEEDBACK_TARGETS } from '../planning-feedback'
import { assertPlanningFeedbackRequest, PLANNING_FEEDBACK_IPC_VERSION,
  type PlanningFeedbackChannel, type PlanningFeedbackChannels } from '../planning-feedback-ipc'

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
} satisfies { [C in PlanningFeedbackChannel]: PlanningFeedbackChannels[C]['args'][0] }
const channels = Object.keys(requests) as PlanningFeedbackChannel[]

describe('closed planning feedback IPC v1', () => {
  it('exposes exactly eleven dedicated commands, independently of persisted task versions', () => {
    expect(PLANNING_FEEDBACK_IPC_VERSION).toBe(1)
    expect(channels.map(channel => channel.replace('planning-feedback:v1:', '')))
      .toEqual(['capture', 'list-bases', 'read-history', 'begin', 'execute', 'read-run', 'list-runs', 'cancel', 'stage', 'relineage', 'adopt'])
    for (const channel of channels) expect(() => assertPlanningFeedbackRequest(channel, requests[channel])).not.toThrow()
    expect(() => assertPlanningFeedbackRequest('planning-feedback:v2:capture' as PlanningFeedbackChannel, { target: 'premise' })).toThrow()
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

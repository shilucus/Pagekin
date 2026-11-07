import { describe, expect, it } from 'vitest'
import { assertRuntimeFeedbackRequest, isRuntimeFeedbackChannel, RUNTIME_FEEDBACK_CHANNELS,
  MAX_RUNTIME_FEEDBACK_REVOCATIONS,
  type RuntimeFeedbackChannel, type RuntimeFeedbackChannels } from '../runtime-feedback-contract'

const operationId = '11111111-1111-4111-8111-111111111111'
const grantId = '22222222-2222-4222-8222-222222222222'
const reference = { projectId: 'project-A', grantId, revision: 1 }
const input = { baseId: 'base-A', feedback: 'Keep the author facts\r\n', constraints: ['Keep order', 'Keep these bytes\r\n'] }
const requests = {
  'runtime-feedback:v1:prepare': { operationId, input, modelId: 'fictional-model' },
  'runtime-feedback:v1:execute': reference,
  'runtime-feedback:v1:revoke': reference,
  'runtime-feedback:v1:revoke-many': { references: [reference] },
  'runtime-feedback:v1:read-receipt': { projectId: 'project-A', grantId },
  'runtime-feedback:v1:read-history': { grantId },
} satisfies { [C in RuntimeFeedbackChannel]: RuntimeFeedbackChannels[C]['args'][0] }

describe('closed runtime feedback v1 wire', () => {
  it('admits exactly six literal commands and no unknown version or generic operation', () => {
    expect(RUNTIME_FEEDBACK_CHANNELS).toEqual(Object.keys(requests))
    for (const channel of RUNTIME_FEEDBACK_CHANNELS) {
      expect(isRuntimeFeedbackChannel(channel)).toBe(true)
      expect(() => assertRuntimeFeedbackRequest(channel, requests[channel])).not.toThrow()
    }
    for (const channel of ['runtime-feedback:v2:prepare', 'runtime-feedback:v1:adopt', 'runtime-feedback:v1:dispatch', 'runtime-feedback:']) {
      expect(isRuntimeFeedbackChannel(channel)).toBe(false)
      expect(() => assertRuntimeFeedbackRequest(channel as RuntimeFeedbackChannel, {})).toThrow('RUNTIME_FEEDBACK_CHANNEL_NOT_ALLOWED')
    }
  })

  it('validates the complete bounded revocation scope before processing any reference', () => {
    const valid = { references: [reference, { ...reference, projectId: 'project-B' }] }
    const before = JSON.stringify(valid)
    expect(() => assertRuntimeFeedbackRequest('runtime-feedback:v1:revoke-many', valid)).not.toThrow()
    expect(JSON.stringify(valid)).toBe(before)
    for (const references of [[], new Array(1), [reference, undefined], [reference, { ...reference }],
      [{ ...reference, revision: 0 }], Array.from({ length: MAX_RUNTIME_FEEDBACK_REVOCATIONS + 1 }, (_, index) => ({ ...reference, projectId: `p-${index}` }))]) {
      expect(() => assertRuntimeFeedbackRequest('runtime-feedback:v1:revoke-many', { references })).toThrow()
    }
    expect(() => assertRuntimeFeedbackRequest('runtime-feedback:v1:revoke-many', {
      references: [{ ...reference, approved: true }],
    })).toThrow()
  })

  it.each(RUNTIME_FEEDBACK_CHANNELS)('rejects absent bodies and client-declared authority on %s', channel => {
    expect(() => assertRuntimeFeedbackRequest(channel, undefined)).toThrow()
    for (const key of ['epoch', 'session', 'task', 'source', 'capability', 'approved', 'decisionSource', 'adopt']) {
      expect(() => assertRuntimeFeedbackRequest(channel, { ...requests[channel], [key]: 'untrusted' })).toThrow()
    }
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])('rejects non-current revision shape %j', revision => {
    for (const channel of ['runtime-feedback:v1:execute', 'runtime-feedback:v1:revoke'] as const) {
      expect(() => assertRuntimeFeedbackRequest(channel, { ...reference, revision })).toThrow('RUNTIME_FEEDBACK_REVISION_INVALID')
    }
  })

  it.each(['', '../operation', '11111111-1111-1111-8111-111111111111', '11111111-1111-4111-1111-111111111111', operationId.toUpperCase().replace('1', 'A')])(
    'rejects noncanonical operation identifiers %j', value => {
      expect(() => assertRuntimeFeedbackRequest('runtime-feedback:v1:prepare', { ...requests['runtime-feedback:v1:prepare'], operationId: value })).toThrow()
      expect(() => assertRuntimeFeedbackRequest('runtime-feedback:v1:read-history', { grantId: value })).toThrow()
    })

  it('retains the exact dense instructions and only accepts main-derived targets', () => {
    const request = requests['runtime-feedback:v1:prepare']
    const before = JSON.stringify(request)
    assertRuntimeFeedbackRequest('runtime-feedback:v1:prepare', request)
    expect(JSON.stringify(request)).toBe(before)
    for (const extra of [{ target: 'premise' }, { range: { from: 1, to: 2 } }, { task: {} }, { modelId: 'other' }]) {
      expect(() => assertRuntimeFeedbackRequest('runtime-feedback:v1:prepare', { ...request, input: { ...input, ...extra } })).toThrow()
    }
    for (const constraints of [new Array(1), [null], ['valid', undefined]]) {
      expect(() => assertRuntimeFeedbackRequest('runtime-feedback:v1:prepare', { ...request, input: { ...input, constraints } })).toThrow()
    }
    for (const parentCandidateId of [null, undefined, 'candidate-A']) {
      expect(() => assertRuntimeFeedbackRequest('runtime-feedback:v1:prepare', { ...request, input: { ...input, parentCandidateId } })).not.toThrow()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { assertReferenceStyleRequest, assertReferenceStyleAckRequest, isReferenceStyleProgress } from '../reference-style-contract'

const execution = { owner: 'fictional-owner', epoch: 1 }
const request = { runId: 'fictional-import', execution, modelId: 'fictional-model' }
const identity = { projectId: 'fictional-project', leaseId: 'fictional-view', runId: request.runId, execution, sequence: 1 }
const handle = { projectId: identity.projectId, epoch: identity.leaseId, rootActionId: 'fictional-root', runId: 'fictional-generation' }
const ack = { runId: request.runId, execution, token: 'fictional-token', phase: 'opened', decision: 'accept' }
const budget = { totalUtf8Bytes: 7, limitUtf8Bytes: 10, reservedOutputTokens: 2,
  sections: [{ sectionName: 'source', utf8Bytes: 7 }], modelId: 'fictional-model', errorCode: 'OK' }

describe('closed foreground reference style contract', () => {
  it('keeps only the original run/execution/model selection, without changing inputs', () => {
    const frozen = structuredClone(request)
    assertReferenceStyleRequest(frozen)
    assertReferenceStyleRequest({ ...request, modelId: null })
    expect(frozen).toEqual(request)
  })
  it.each(['task', 'samples', 'rootActionId', 'generationRunHandle', 'uiActionNonce', 'background', 'grantId', 'apiKey'])('rejects caller authority/content field %s', key => {
    expect(() => assertReferenceStyleRequest({ ...request, [key]: 'not-authority' })).toThrow('GENERATION_IMPORT_TASK_INVALID')
  })
  it.each([null, [], {}, { ...request, runId: '' }, { ...request, modelId: '' },
    { ...request, execution: { ...execution, expiresAt: 999 } }, { ...request, execution: { ...execution, epoch: 0 } },
    { ...request, execution: { ...execution, epoch: 1.5 } }, { ...request, execution: { ...execution, owner: ' padded ' } }])('rejects malformed entry %#', value => {
    expect(() => assertReferenceStyleRequest(value)).toThrow('GENERATION_IMPORT_TASK_INVALID')
  })
  it('accepts only closed token decisions with no submitted effect body', () => {
    for (const phase of ['opened', 'commit']) for (const decision of ['accept', 'draft-changed', 'cancelled', 'projection-failed']) {
      assertReferenceStyleAckRequest({ ...ack, phase, decision })
    }
    for (const value of [{ ...ack, writingStyle: 'replacement' }, { ...ack, handle }, { ...ack, error: 'raw failure' },
      { ...ack, decision: 'approve' }, { ...ack, token: '' }, { ...ack, phase: 'finalize' }]) {
      expect(() => assertReferenceStyleAckRequest(value)).toThrow('GENERATION_IMPORT_TASK_INVALID')
    }
  })
  it('binds opened and commit projections to the exact project lease and closed shape', () => {
    expect(isReferenceStyleProgress({ ...identity, kind: 'opened', token: ack.token, handle, modelId: request.modelId })).toBe(true)
    expect(isReferenceStyleProgress({ ...identity, kind: 'commit-ready', token: ack.token, handle, writingStyle: 'fictional style' })).toBe(true)
    for (const value of [{ ...identity, kind: 'opened', token: ack.token, handle: { ...handle, epoch: 'other-view' }, modelId: request.modelId },
      { ...identity, kind: 'opened', token: ack.token, handle, modelId: request.modelId, task: {} },
      { ...identity, kind: 'commit-ready', token: ack.token, handle, writingStyle: ' ' },
      { ...identity, sequence: 0, kind: 'progress', progress: 10 }]) expect(isReferenceStyleProgress(value)).toBe(false)
  })
  it('requires actual counts only for counted logs and preserves the original progress values', () => {
    for (const log of ['imported-samples', 'sampled-finalized']) {
      expect(isReferenceStyleProgress({ ...identity, kind: 'log', log, count: 5 })).toBe(true)
      for (const count of [undefined, -1, 6, 1.1]) expect(isReferenceStyleProgress({ ...identity, kind: 'log', log, count })).toBe(false)
    }
    for (const log of ['sampling-finalized', 'no-finalized', 'read-finalized-failed', 'empty-samples', 'calling-ai', 'empty-result', 'saved']) {
      expect(isReferenceStyleProgress({ ...identity, kind: 'log', log })).toBe(true)
      expect(isReferenceStyleProgress({ ...identity, kind: 'log', log, count: 1 })).toBe(false)
    }
    for (const progress of [10, 90, 100]) expect(isReferenceStyleProgress({ ...identity, kind: 'progress', progress })).toBe(true)
    expect(isReferenceStyleProgress({ ...identity, kind: 'progress', progress: 50 })).toBe(false)
  })
  it('validates existing prompt reports including legacy optional fields before UI consumption', () => {
    const event = { ...identity, kind: 'prompt-budget', report: budget }
    expect(isReferenceStyleProgress(event)).toBe(true)
    expect(isReferenceStyleProgress({ ...event, report: { ...budget, contextWindowTokens: null, estimatedInputTokens: 3 } })).toBe(true)
    expect(isReferenceStyleProgress({ ...event, report: { ...budget, errorCode: 'PROMPT_BUDGET_EXHAUSTED' } })).toBe(true)
    for (const report of [{}, { ...budget, sections: null }, { ...budget, sections: [{}] },
      { ...budget, totalUtf8Bytes: -1 }, { ...budget, contextWindowTokens: 'unknown' }, { ...budget, estimatedInputTokens: 1.2 },
      { ...budget, errorCode: 'provider-error' }, { ...budget, sourceText: 'must not cross this diagnostic boundary' }]) {
      expect(isReferenceStyleProgress({ ...event, report })).toBe(false)
    }
  })
})

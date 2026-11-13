import { describe, expect, it } from 'vitest'
import { assertReferenceBlueprintRequest, assertReferenceBlueprintAckRequest, isReferenceBlueprintBatchId, isReferenceBlueprintProgress } from '../reference-blueprint-contract'

const execution = { owner: 'fictional-owner', epoch: 1 }
const request = { runId: 'fictional-import', execution, modelId: 'fictional-model' }
const identity = { projectId: 'fictional-project', leaseId: 'fictional-view', runId: request.runId, execution, sequence: 1 }
const batchId = '2-3-12345678.abcdef01'
const handle = { projectId: identity.projectId, epoch: identity.leaseId, rootActionId: 'fictional-root', runId: 'fictional-generation' }
const ack = { runId: request.runId, execution, batchId, token: 'fictional-token', decision: 'accept' }
const budget = { totalUtf8Bytes: 7, limitUtf8Bytes: 10, reservedOutputTokens: 2,
  sections: [{ sectionName: 'source', utf8Bytes: 7 }], modelId: 'fictional-model', errorCode: 'OK' }

describe('closed foreground reference blueprints contract', () => {
  it('retains only existing run/execution/model authority', () => {
    const frozen = structuredClone(request)
    assertReferenceBlueprintRequest(frozen)
    assertReferenceBlueprintRequest({ ...request, modelId: null })
    expect(frozen).toEqual(request)
  })
  it.each(['task', 'chapters', 'blueprints', 'skill', 'rootActionId', 'generationRunHandle', 'background', 'grantId', 'apiKey'])(
    'rejects caller content or extra authority: %s', key => {
      expect(() => assertReferenceBlueprintRequest({ ...request, [key]: 'not-authority' })).toThrow('GENERATION_IMPORT_TASK_INVALID')
    })
  it.each([null, [], {}, { ...request, runId: '' }, { ...request, modelId: '' },
    { ...request, execution: { ...execution, expiresAt: 999 } }, { ...request, execution: { ...execution, epoch: 0 } },
    { ...request, execution: { ...execution, epoch: 1.5 } }])('rejects malformed input %#', value => {
      expect(() => assertReferenceBlueprintRequest(value)).toThrow('GENERATION_IMPORT_TASK_INVALID')
    })
  it('binds readiness to a canonical chapter checkpoint and never an approval', () => {
    expect(isReferenceBlueprintBatchId(batchId)).toBe(true)
    for (const value of ['done', '2-3-12345678', '3-2-12345678', '2-3-12345678.ABCDEF01', ' '+batchId, '', null]) {
      expect(isReferenceBlueprintBatchId(value)).toBe(false)
    }
    for (const decision of ['accept', 'cancelled', 'projection-failed']) assertReferenceBlueprintAckRequest({ ...ack, decision })
    for (const value of [{ ...ack, phase: 'commit' }, { ...ack, decision: 'approve' }, { ...ack, batchId: 'done' },
      { ...ack, token: '' }, { ...ack, receipt: {} }, { ...ack, handle }, { ...ack, error: 'raw' }]) {
      expect(() => assertReferenceBlueprintAckRequest(value)).toThrow('GENERATION_IMPORT_TASK_INVALID')
    }
  })
  it('binds each opened event to its exact lease,handle and batch', () => {
    const event = { ...identity, kind: 'opened', batchId, token: ack.token, handle, modelId: request.modelId }
    expect(isReferenceBlueprintProgress(event)).toBe(true)
    for (const value of [{ ...event, handle: { ...handle, epoch: 'other-view' } }, { ...event, handle: { ...handle, extra: '' } },
      { ...event, batchId: 'done' }, { ...event, task: {} }, { ...event, modelId: null }, { ...event, sequence: 0 }]) {
      expect(isReferenceBlueprintProgress(value)).toBe(false)
    }
  })
  it('retains integer per-range and visited progress without effect payloads', () => {
    for (const progress of [0, 5, 21, 85, 99, 100]) expect(isReferenceBlueprintProgress({ ...identity, kind: 'progress', progress })).toBe(true)
    for (const progress of [-1, 1.5, 101, NaN]) expect(isReferenceBlueprintProgress({ ...identity, kind: 'progress', progress })).toBe(false)
    for (const kind of ['range-committed', 'range-synced']) {
      expect(isReferenceBlueprintProgress({ ...identity, kind, batchId })).toBe(true)
      expect(isReferenceBlueprintProgress({ ...identity, kind, batchId, blueprints: [] })).toBe(false)
    }
  })
  it('accepts only original bounded range logs,not new Skill or approval copy', () => {
    const event = (value: unknown) => ({ ...identity, kind: 'log', value })
    for (const value of [{ key: 'begin', count: 5, estimatedCalls: 1 }, { key: 'inferring', startChapter: 2, endChapter: 6 },
      { key: 'complete', count: 1 }, { key: 'stop-reason', code: 'ROOT_BUDGET_EXHAUSTED' }, { key: 'discard-failed', code: 'GENERATION_REQUEST_FAILED' }]) {
      expect(isReferenceBlueprintProgress(event(value))).toBe(true)
    }
    for (const value of [{ key: 'begin', count: 6, estimatedCalls: 2 }, { key: 'begin', count: 1, estimatedCalls: 2 },
      { key: 'inferring', startChapter: 2, endChapter: 7 }, { key: 'complete', count: 0 }, { key: 'skill', name: 'invented' },
      { key: 'stop-reason', code: 'raw provider text' }]) expect(isReferenceBlueprintProgress(event(value))).toBe(false)
  })
  it('retains complete prompt reports and optional legacy fields only', () => {
    const event = { ...identity, kind: 'prompt-budget', report: budget }
    expect(isReferenceBlueprintProgress(event)).toBe(true)
    expect(isReferenceBlueprintProgress({ ...event, report: { ...budget, contextWindowTokens: null, estimatedInputTokens: 4 } })).toBe(true)
    for (const report of [{ ...budget, sections: [{}] }, { ...budget, reservedOutputTokens: -1 }, { ...budget, secret: 'not-allowed' },
      { ...budget, errorCode: 'other' }, { ...budget, modelId: '' }]) expect(isReferenceBlueprintProgress({ ...event, report })).toBe(false)
  })
})

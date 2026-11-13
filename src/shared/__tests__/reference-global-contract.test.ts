import { describe, expect, it } from 'vitest'
import { assertReferenceGlobalRequest, assertReferenceGlobalAckRequest, isReferenceGlobalProgress, isReferenceGlobalCompletionFailureCode } from '../reference-global-contract'

const execution = { owner: 'fictional-owner', epoch: 1 }
const request = { runId: 'fictional-import', execution, modelId: 'fictional-model' }
const identity = { projectId: 'fictional-project', leaseId: 'fictional-view', runId: request.runId, execution, sequence: 1 }
const handle = { projectId: identity.projectId, epoch: identity.leaseId, rootActionId: 'fictional-root', runId: 'fictional-generation' }
const ack = { runId: request.runId, execution, token: 'fictional-token', decision: 'accept' }
const budget = { totalUtf8Bytes: 7, limitUtf8Bytes: 10, reservedOutputTokens: 2,
  sections: [{ sectionName: 'source', utf8Bytes: 7 }], modelId: 'fictional-model', errorCode: 'OK' }

describe('closed foreground reference global contract', () => {
  it('retains only established non-stop completion reasons', () => {
    for (const code of ['length', 'content_filter', 'cancelled', 'error', 'unknown']) expect(isReferenceGlobalCompletionFailureCode(code)).toBe(true)
    for (const value of ['stop', 'GENERATION_REQUEST_FAILED', 'arbitrary', '', null, undefined, {}, 1]) {
      expect(isReferenceGlobalCompletionFailureCode(value)).toBe(false)
    }
  })
  it('retains only run/execution/original model with no caller materials', () => {
    const frozen = structuredClone(request)
    assertReferenceGlobalRequest(frozen)
    assertReferenceGlobalRequest({ ...request, modelId: null })
    expect(frozen).toEqual(request)
  })
  it.each(['task', 'samples', 'roster', 'skill', 'rootActionId', 'generationRunHandle', 'uiActionNonce', 'background', 'grantId', 'apiKey'])(
    'rejects caller content or authority: %s', key => {
      expect(() => assertReferenceGlobalRequest({ ...request, [key]: 'not-authority' })).toThrow('GENERATION_IMPORT_TASK_INVALID')
    })
  it.each([null, [], {}, { ...request, runId: '' }, { ...request, modelId: '' },
    { ...request, execution: { ...execution, expiresAt: 999 } }, { ...request, execution: { ...execution, epoch: 0 } },
    { ...request, execution: { ...execution, epoch: 1.5 } }, { ...request, execution: { ...execution, owner: ' padded ' } }])(
    'rejects malformed input %#', value => expect(() => assertReferenceGlobalRequest(value)).toThrow('GENERATION_IMPORT_TASK_INVALID'))
  it('accepts only readiness decisions, never commit permission or a config CAS', () => {
    for (const decision of ['accept', 'cancelled', 'projection-failed']) assertReferenceGlobalAckRequest({ ...ack, decision })
    for (const value of [{ ...ack, phase: 'commit' }, { ...ack, phase: 'opened' }, { ...ack, decision: 'draft-changed' },
      { ...ack, decision: 'approve' }, { ...ack, token: '' }, { ...ack, core: {} }, { ...ack, handle }, { ...ack, error: 'raw' }]) {
      expect(() => assertReferenceGlobalAckRequest(value)).toThrow('GENERATION_IMPORT_TASK_INVALID')
    }
  })
  it('binds opened readiness to the exact lease and closed handle', () => {
    const event = { ...identity, kind: 'opened', token: ack.token, handle, modelId: request.modelId }
    expect(isReferenceGlobalProgress(event)).toBe(true)
    for (const value of [{ ...event, handle: { ...handle, epoch: 'other-view' } }, { ...event, handle: { ...handle, extra: '' } },
      { ...event, task: {} }, { ...event, modelId: null }, { ...event, sequence: 0 }, { ...event, kind: 'commit-ready' }]) {
      expect(isReferenceGlobalProgress(value)).toBe(false)
    }
  })
  it('retains original progress, raw candidate and committed signal without effect body', () => {
    for (const progress of [5, 10, 20, 25, 70, 90, 100]) expect(isReferenceGlobalProgress({ ...identity, kind: 'progress', progress })).toBe(true)
    expect(isReferenceGlobalProgress({ ...identity, kind: 'progress', progress: 50 })).toBe(false)
    expect(isReferenceGlobalProgress({ ...identity, kind: 'candidate', content: '{malformed' })).toBe(true)
    expect(isReferenceGlobalProgress({ ...identity, kind: 'committed' })).toBe(true)
    expect(isReferenceGlobalProgress({ ...identity, kind: 'committed', core: {} })).toBe(false)
  })
  it('validates topic counts, bounded card counts and exact original log variants', () => {
    const event = (value: unknown) => ({ ...identity, kind: 'log', value })
    for (const key of ['retrieving', 'calling-ai', 'syntax-repair', 'parsing']) {
      expect(isReferenceGlobalProgress(event({ key }))).toBe(true)
      expect(isReferenceGlobalProgress(event({ key, count: 1 }))).toBe(false)
    }
    for (const topic of ['worldview', 'protagonist', 'conflict', 'style']) {
      expect(isReferenceGlobalProgress(event({ key: 'retrieved', topic, count: 5 }))).toBe(true)
      expect(isReferenceGlobalProgress(event({ key: 'retrieval-fallback', topic }))).toBe(true)
    }
    for (const value of [{ key: 'retrieved', topic: 'worldview', count: 6 }, { key: 'retrieved', topic: 'other', count: 1 },
      { key: 'retrieved', topic: 'style', count: -1 }, { key: 'endpoint-recovery', count: 0 }, { key: 'saved-proposals', count: 9 }]) {
      expect(isReferenceGlobalProgress(event(value))).toBe(false)
    }
    for (const key of ['endpoint-recovery', 'saved-proposals', 'saved-roster']) expect(isReferenceGlobalProgress(event({ key, count: 8 }))).toBe(true)
    expect(isReferenceGlobalProgress(event({ key: 'saved-proposals', count: 0 }))).toBe(true)
    expect(isReferenceGlobalProgress(event({ key: 'skill', name: 'Fictional planning' }))).toBe(true)
    expect(isReferenceGlobalProgress(event({ key: 'discard-failed', code: 'GENERATION_REQUEST_FAILED' }))).toBe(true)
    expect(isReferenceGlobalProgress(event({ key: 'discard-failed', code: 'raw secret error' }))).toBe(false)
    expect(isReferenceGlobalProgress(event({ key: 'dropped-relationships', relationships: [{ source: 'A', target: 'B', relation: 'rival' }] }))).toBe(true)
    expect(isReferenceGlobalProgress(event({ key: 'dropped-relationships', relationships: [{ source: 'A', target: '', relation: 'rival' }] }))).toBe(false)
  })
  it('validates complete prompt-budget reports and optional legacy fields', () => {
    const event = { ...identity, kind: 'prompt-budget', report: budget }
    expect(isReferenceGlobalProgress(event)).toBe(true)
    expect(isReferenceGlobalProgress({ ...event, report: { ...budget, contextWindowTokens: null, estimatedInputTokens: 4 } })).toBe(true)
    for (const report of [{ ...budget, sections: [{}] }, { ...budget, reservedOutputTokens: -1 }, { ...budget, secret: 'not-allowed' },
      { ...budget, errorCode: 'other' }, { ...budget, modelId: '' }]) expect(isReferenceGlobalProgress({ ...event, report })).toBe(false)
  })
})

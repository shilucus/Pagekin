import { describe, expect, it } from 'vitest'
import { REFERENCE_RUN_CHANNELS, REFERENCE_RUN_STAGES, assertReferenceRunRequest,
  isReferenceRunChannel, isReferenceRunProgress } from '../reference-run-contract'

const reference = { projectId: 'fictional-project', runId: 'fictional-import',
  grantId: '11111111-1111-4111-8111-111111111111', revision: 1 }
const execution = { owner: '22222222-2222-4222-8222-222222222222', epoch: 1 }
const request = { reference, execution, modelId: 'fictional-planning' }
const token = '33333333-3333-4333-8333-333333333333'
const ack = { reference, execution, stage: 'global' as const, token, decision: 'settled' as const }
const run = { id: reference.runId, purpose: 'reference', rootRunId: reference.runId, stage: 'style', status: 'running' }
const event = { reference, execution, leaseId: 'fictional-view', sequence: 1,
  kind: 'stage-completed', token, completion: { stage: 'global', result: { run } } }

describe('foreground whole reference run closed contract', () => {
  it('exposes only one execute and a mechanical projection ACK', () => {
    expect(REFERENCE_RUN_CHANNELS).toEqual(['reference-run:v1:execute', 'reference-run:v1:projection-ack'])
    expect(REFERENCE_RUN_STAGES).toEqual(['knowledge', 'global', 'style', 'blueprints', 'refresh'])
    for (const channel of REFERENCE_RUN_CHANNELS) expect(isReferenceRunChannel(channel)).toBe(true)
    expect(isReferenceRunChannel('reference-run:v1:advance')).toBe(false)
    expect(isReferenceRunChannel('reference-run:v2:execute')).toBe(false)
    expect(() => assertReferenceRunRequest('reference-run:v2:execute' as never, request)).toThrow()
  })
  it.each(['fictional-planning', null])('accepts an explicit frozen model selection %s', modelId => {
    expect(() => assertReferenceRunRequest('reference-run:v1:execute', { ...request, modelId })).not.toThrow()
  })
  it.each([null, [], {}, { reference, execution }, { ...request, modelId: '' }, { ...request, modelId: ' ' },
    { ...request, modelId: 1 }, { ...request, defaultModel: true }, { ...request, projectPath: 'C:/unrelated' },
    { ...request, reference: { ...reference, revision: 0 } }, { ...request, reference: { ...reference, grantId: 'fabricated' } },
    { ...request, execution: { ...execution, epoch: 1.5 } }, { ...request, execution: { ...execution, skipGuard: true } },
  ])('rejects malformed or widened execute %#', value => {
    expect(() => assertReferenceRunRequest('reference-run:v1:execute', value)).toThrow('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID')
  })
  it.each(['settled', 'cancelled', 'projection-failed'] as const)('accepts only settled projection decision %s', decision => {
    expect(() => assertReferenceRunRequest('reference-run:v1:projection-ack', { ...ack, decision })).not.toThrow()
  })
  it.each([{ ...ack, decision: 'approve' }, { ...ack, nextStage: 'style' }, { ...ack, writingStyle: 'new fact' },
    { ...ack, stage: 'completed' }, { ...ack, token: 'fabricated' }, { ...ack, parentToken: {} },
  ])('rejects an ACK that claims authority or another stage %#', value => {
    expect(() => assertReferenceRunRequest('reference-run:v1:projection-ack', value)).toThrow()
  })
  it('accepts identity-bound completion and persisted stage skips', () => {
    expect(isReferenceRunProgress(event)).toBe(true)
    const identity = { reference, execution, leaseId: event.leaseId, sequence: event.sequence }
    expect(isReferenceRunProgress({ ...identity, kind: 'stage-started', stage: 'style', run })).toBe(true)
    expect(isReferenceRunProgress({ ...identity, kind: 'stage-skipped', stage: 'knowledge', run, token })).toBe(true)
    expect(isReferenceRunProgress({ ...identity, kind: 'stage-skipped', stage: 'knowledge', run })).toBe(false)
  })
  it.each([null, { ...event, sequence: 0 }, { ...event, sequence: 1.5 }, { ...event, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...event, leaseId: '' }, { ...event, token: 'fabricated' }, { ...event, nextStage: 'style' },
    { ...event, completion: { stage: 'completed', result: { run } } },
    { ...event, completion: { stage: 'global', result: null } },
    { ...event, completion: { stage: 'global', result: { run: { ...run, id: 'another-run' } } } },
    { ...event, completion: { stage: 'global', result: { run: { ...run, purpose: 'author-manuscript' } } } },
  ])('rejects malformed lifecycle envelopes %#', value => { expect(isReferenceRunProgress(value)).toBe(false) })
})

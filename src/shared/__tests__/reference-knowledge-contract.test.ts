import { describe, expect, it } from 'vitest'
import {
  REFERENCE_KNOWLEDGE_CHANNELS, assertReferenceKnowledgeRequest,
  isReferenceKnowledgeChannel, isReferenceKnowledgeProgress, referenceKnowledgeRequiresView,
} from '../reference-knowledge-contract'

const operationId = '11111111-1111-4111-8111-111111111111'
const owner = '22222222-2222-4222-8222-222222222222'
const reference = { projectId: 'fictional-A', runId: 'fictional-import', grantId: operationId, revision: 1 }
const prepare = { operationId, runId: reference.runId, executionOwner: owner }
const chapter = { reference, chapterNumber: 1, execution: { owner, epoch: 1 } }
const execution = { reference, execution: chapter.execution }

describe('foreground reference knowledge closed IPC contract', () => {
  it('accepts exactly the six versioned verbs without adding an automatic authorization route', () => {
    expect(REFERENCE_KNOWLEDGE_CHANNELS).toHaveLength(6)
    for (const channel of REFERENCE_KNOWLEDGE_CHANNELS) {
      expect(isReferenceKnowledgeChannel(channel)).toBe(true)
      expect(referenceKnowledgeRequiresView(channel)).toBe(channel !== 'reference-knowledge:v1:revoke')
      const request = channel === 'reference-knowledge:v1:prepare' ? prepare
        : channel === 'reference-knowledge:v1:import' ? chapter
          : channel === 'reference-knowledge:v1:execute' ? execution : reference
      expect(() => assertReferenceKnowledgeRequest(channel, request)).not.toThrow()
    }
    for (const channel of ['reference-knowledge:v2:prepare', 'reference-knowledge:v1:progress',
      'reference-knowledge:v1:reauthorize', 'reference-knowledge:v1:read-history']) {
      expect(isReferenceKnowledgeChannel(channel)).toBe(false)
      expect(() => assertReferenceKnowledgeRequest(channel as never, prepare)).toThrow('CHANNEL_NOT_ALLOWED')
    }
  })

  it.each(['authorAction', 'requestHash', 'manifestFingerprint', 'admission', 'model', 'apiKey', 'background'])(
    'rejects caller-supplied authority/input field %s', field => {
      expect(() => assertReferenceKnowledgeRequest('reference-knowledge:v1:prepare', { ...prepare, [field]: true }))
        .toThrow('PAYLOAD_INVALID')
    },
  )

  it.each([
    null, [], 'request', Object.create(prepare), { ...prepare, operationId: 'not-a-uuid' },
    { ...prepare, executionOwner: 'caller' }, { ...prepare, runId: '../other' },
    { operationId, runId: reference.runId }, { ...prepare, executionOwner: undefined },
  ])('rejects missing or malformed preparation %j', value => {
    expect(() => assertReferenceKnowledgeRequest('reference-knowledge:v1:prepare', value)).toThrow('PAYLOAD_INVALID')
  })

  it.each([
    { ...reference, revision: 0 }, { ...reference, revision: '1' }, { ...reference, revision: 1.1 },
    { ...reference, projectId: '' }, { ...reference, grantId: 'history:key' }, { ...reference, capsule: true },
  ])('rejects malformed or expanded references for every control verb %j', value => {
    for (const channel of ['reference-knowledge:v1:resume', 'reference-knowledge:v1:revoke', 'reference-knowledge:v1:complete'] as const) {
      expect(() => assertReferenceKnowledgeRequest(channel, value)).toThrow('PAYLOAD_INVALID')
    }
  })

  it.each([
    { ...chapter, chapterNumber: 0 }, { ...chapter, chapterNumber: '1' },
    { ...chapter, execution: { owner, epoch: 0 } }, { ...chapter, execution: { owner, epoch: NaN } },
    { ...chapter, execution: { owner, epoch: 1, expiresAt: 1 } },
    { ...chapter, execution: { owner: 'other', epoch: 1 } }, { ...chapter, admission: true },
    { ...chapter, reference: { ...reference, revision: Infinity } },
  ])('rejects malformed chapter authority without coercion %j', value => {
    expect(() => assertReferenceKnowledgeRequest('reference-knowledge:v1:import', value)).toThrow('PAYLOAD_INVALID')
  })

  it.each([
    { ...execution, chapterNumber: 1 }, { ...execution, chapters: [1] },
    { ...execution, model: {} }, { ...execution, background: true },
    { ...execution, execution: { ...chapter.execution, expiresAt: 1 } },
    { ...execution, execution: { owner, epoch: 0 } },
    { ...execution, reference: { ...reference, revision: 0 } },
    { reference }, null,
  ])('rejects expanded or malformed whole-stage execution %j', value => {
    expect(() => assertReferenceKnowledgeRequest('reference-knowledge:v1:execute', value)).toThrow('PAYLOAD_INVALID')
  })

  it('validates only exact chapter and batch projections, never an invoke authority', () => {
    const chapterProgress = { ...execution, kind: 'chapter', chapterNumber: 1, idempotent: false }
    const batchProgress = { ...execution, kind: 'batch', progress: 99 }
    expect(isReferenceKnowledgeProgress(chapterProgress)).toBe(true)
    expect(isReferenceKnowledgeProgress(batchProgress)).toBe(true)
    for (const value of [
      { ...chapterProgress, idempotent: 1 }, { ...chapterProgress, chapterNumber: 0 },
      { ...chapterProgress, reference: { ...reference, revision: 0 } },
      { ...chapterProgress, execution: { ...chapter.execution, expiresAt: 1 } },
      { ...batchProgress, progress: 100 }, { ...batchProgress, progress: -1 },
      { ...batchProgress, progress: 0.5 }, { ...batchProgress, error: 'extra' },
      { ...batchProgress, kind: 'complete' }, Object.create(chapterProgress), null,
    ]) expect(isReferenceKnowledgeProgress(value)).toBe(false)
    expect(isReferenceKnowledgeChannel('reference-knowledge:v1:progress')).toBe(false)
  })
})

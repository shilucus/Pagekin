import { describe, expect, it } from 'vitest'
import {
  REFERENCE_KNOWLEDGE_CHANNELS, assertReferenceKnowledgeRequest,
  isReferenceKnowledgeChannel, referenceKnowledgeRequiresView,
} from '../reference-knowledge-contract'

const operationId = '11111111-1111-4111-8111-111111111111'
const owner = '22222222-2222-4222-8222-222222222222'
const reference = { projectId: 'fictional-A', runId: 'fictional-import', grantId: operationId, revision: 1 }
const prepare = { operationId, runId: reference.runId, executionOwner: owner }
const chapter = { reference, chapterNumber: 1, execution: { owner, epoch: 1 } }

describe('foreground reference knowledge closed IPC contract', () => {
  it('accepts exactly the five versioned verbs without adding an automatic authorization route', () => {
    expect(REFERENCE_KNOWLEDGE_CHANNELS).toHaveLength(5)
    for (const channel of REFERENCE_KNOWLEDGE_CHANNELS) {
      expect(isReferenceKnowledgeChannel(channel)).toBe(true)
      expect(referenceKnowledgeRequiresView(channel)).toBe(channel !== 'reference-knowledge:v1:revoke')
      const request = channel === 'reference-knowledge:v1:prepare' ? prepare
        : channel === 'reference-knowledge:v1:import' ? chapter : reference
      expect(() => assertReferenceKnowledgeRequest(channel, request)).not.toThrow()
    }
    for (const channel of ['reference-knowledge:v2:prepare', 'reference-knowledge:v1:execute',
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
})

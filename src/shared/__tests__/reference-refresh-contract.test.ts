import { describe, expect, it } from 'vitest'
import { assertReferenceKnowledgeRequest, isReferenceKnowledgeChannel, referenceKnowledgeRequiresView } from '../reference-knowledge-contract'
import { REFERENCE_REFRESH_CHANNELS, assertReferenceRefreshRequest, isReferenceRefreshProgress } from '../reference-refresh-contract'

const reference = { projectId: 'fictional-project', runId: 'fictional-import', grantId: '11111111-1111-4111-8111-111111111111', revision: 1 }
const execution = { owner: '22222222-2222-4222-8222-222222222222', epoch: 1 }
const entry = { reference, execution }
const token = '33333333-3333-4333-8333-333333333333'
const ack = { ...entry, token, decision: 'completed' as const }
const event = { ...entry, leaseId: 'fictional-view', sequence: 1, kind: 'refresh' as const, token }

describe('closed foreground reference refresh contract', () => {
  it('registers only view-bound refresh and settled-projection ACK without granting a domain write', () => {
    expect(REFERENCE_REFRESH_CHANNELS).toEqual(['reference-knowledge:v1:refresh', 'reference-knowledge:v1:refresh-ack'])
    for (const channel of REFERENCE_REFRESH_CHANNELS) {
      expect(isReferenceKnowledgeChannel(channel)).toBe(true)
      expect(referenceKnowledgeRequiresView(channel)).toBe(true)
      const value = channel.endsWith('-ack') ? ack : entry
      expect(() => assertReferenceRefreshRequest(channel, value)).not.toThrow()
      expect(() => assertReferenceKnowledgeRequest(channel, value)).not.toThrow()
    }
    expect(isReferenceKnowledgeChannel('reference-knowledge:v1:refresh-any')).toBe(false)
    expect(() => assertReferenceRefreshRequest('reference-knowledge:v2:refresh' as never, entry)).toThrow('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID')
  })
  it.each([
    null, [], {}, { ...entry, override: true }, { ...entry, execution: null },
    { ...entry, reference: { ...reference, projectPath: 'C:/other' } },
    { ...entry, reference: { ...reference, grantId: 'not-an-issuance' } },
    { ...entry, reference: { ...reference, revision: 0 } },
    { ...entry, execution: { ...execution, epoch: 0 } },
    { ...entry, execution: { ...execution, allowance: 1 } },
  ])('rejects malformed refresh input %#', value => {
    expect(() => assertReferenceRefreshRequest('reference-knowledge:v1:refresh', value)).toThrow('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID')
  })
  it.each([
    { ...ack, token: '' }, { ...ack, decision: 'accept' }, { ...ack, decision: 'approve' },
    { ...ack, error: 'fictional-private-reason' }, { ...ack, execution: { ...execution, epoch: 1.5 } },
  ])('rejects a nonclosed ACK %#', value => {
    expect(() => assertReferenceRefreshRequest('reference-knowledge:v1:refresh-ack', value)).toThrow('KNOWLEDGE_BASE_REFERENCE_PAYLOAD_INVALID')
  })
  it.each(['completed', 'failed', 'cancelled'] as const)('accepts only the settled-projection decision %s', decision => {
    expect(() => assertReferenceRefreshRequest('reference-knowledge:v1:refresh-ack', { ...ack, decision })).not.toThrow()
  })
  it('accepts only original identity-bound projection or progress100 events', () => {
    expect(isReferenceRefreshProgress(event)).toBe(true)
    expect(isReferenceRefreshProgress({ ...entry, leaseId: event.leaseId, sequence: 2, kind: 'progress', progress: 100 })).toBe(true)
  })
  it.each([
    null, { ...event, leaseId: '' }, { ...event, sequence: 0 }, { ...event, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...event, token: 'unknown' }, { ...event, kind: 'approval' }, { ...event, receipt: {} },
    { ...entry, leaseId: event.leaseId, sequence: 2, kind: 'progress', progress: 99 },
  ])('rejects malformed progress %#', value => { expect(isReferenceRefreshProgress(value)).toBe(false) })
})

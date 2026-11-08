import { describe, expect, it } from 'vitest'
import { assertIssueReferenceImportGrant, assertReferenceImportGrantRef, REFERENCE_IMPORT_GRANT_ACTION } from '../reference-import-grant'

const grantId = '11111111-1111-4111-8111-111111111111'
const operationKey = '22222222-2222-4222-8222-222222222222'
const issue = { grantId, operationKey, runId: 'fictional-import-A', manifestFingerprint: 'a'.repeat(64), requestHash: 'b'.repeat(64) }
const ref = { grantId, revision: 1, runId: issue.runId }

describe('reference import grant closed contract', () => {
  it('accepts only explicit identifiers, fixed scope hashes and optional integer millisecond timestamps', () => {
    expect(REFERENCE_IMPORT_GRANT_ACTION).toBe('reference-import-v1')
    expect(() => assertIssueReferenceImportGrant(issue)).not.toThrow()
    expect(() => assertIssueReferenceImportGrant({ ...issue, createdAt: 0 })).not.toThrow()
    expect(() => assertIssueReferenceImportGrant({ ...issue, createdAt: Number.MAX_SAFE_INTEGER })).not.toThrow()
    expect(() => assertReferenceImportGrantRef(ref)).not.toThrow()
  })

  it.each(Object.keys(issue))('rejects a missing %s instead of inferring it', key => {
    const value: Record<string, unknown> = { ...issue }
    delete value[key]
    expect(() => assertIssueReferenceImportGrant(value)).toThrow('PAYLOAD_INVALID')
  })

  it.each(['action', 'projectId', 'decisionSource', 'purpose', 'capability', 'expiresAt', 'revision', 'policy'])('rejects unrecognized issue field %s', key => {
    expect(() => assertIssueReferenceImportGrant({ ...issue, [key]: 'untrusted' })).toThrow('PAYLOAD_INVALID')
  })

  it.each([
    { grantId: 'history:grant' }, { operationKey: 'history:key' }, { runId: '' }, { runId: '../other' },
    { manifestFingerprint: null }, { requestHash: null }, { requestHash: 'A'.repeat(64) },
    { manifestFingerprint: 'x'.repeat(64) }, { createdAt: -1 }, { createdAt: 1.5 }, { createdAt: '1000' },
    { createdAt: NaN }, { createdAt: Infinity }, { createdAt: Number.MAX_SAFE_INTEGER + 1 }, { createdAt: undefined },
  ])('rejects malformed input %j', change => {
    expect(() => assertIssueReferenceImportGrant({ ...issue, ...change })).toThrow('REFERENCE_IMPORT_GRANT_')
  })

  it.each([null, [], 'grant', Object.create(issue)])('rejects non-record or inherited request payload %j', value => {
    expect(() => assertIssueReferenceImportGrant(value)).toThrow('PAYLOAD_INVALID')
  })

  it.each([
    { ...ref, revision: 0 }, { ...ref, revision: 1.1 }, { ...ref, revision: '1' },
    { grantId, runId: ref.runId }, { ...ref, grantId: 'not-a-grant-id' }, { ...ref, runId: 'bad/path' },
    { ...ref, action: 'reference-import-v1' }, { ...ref, projectId: 'project-B' },
  ])('rejects nonexact references %j', value => {
    expect(() => assertReferenceImportGrantRef(value)).toThrow('REFERENCE_IMPORT_GRANT_')
  })
})

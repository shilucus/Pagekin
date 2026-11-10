import { describe, expect, it } from 'vitest'
import { GENERATION_DIAGNOSTIC_SOURCE_KINDS, type MaterialDecisionReceipt } from '../../../src/shared/generation-owner-contract'
import { projectGenerationSourceSelection } from '../generation-selection-diagnostics'

const contentHash = 'a'.repeat(64), secondHash = 'b'.repeat(64)
const privateValue = 'private-author-text-and-path'
function binding(sourceManifest: Record<string, unknown> = {}, sourceIds: string[] = []) {
  return { sourceManifest, sourceRefs: sourceIds.map(sourceId => ({ sourceId, projectId: 'project', epoch: 'epoch',
    revision: 1, contentHash, private: privateValue })) }
}
function decision(): MaterialDecisionReceipt {
  return { version: 1, verdict: 'admitted', promptHash: contentHash,
    capacity: { maxInputUnits: 1000, methodVersion: 'utf8-bytes-v1', admittedUnits: 30 },
    coverage: { required: 1, included: 1, complete: true },
    included: [{ sourceId: 'author:required', revision: 1, contentHash, category: 'author', required: true, units: 10 },
      { sourceId: 'finalized:2', revision: 2, contentHash: secondHash, category: 'finalized-history', required: false, units: 20 }],
    omitted: [{ sourceId: 'reference:0', revision: 1, contentHash: 'c'.repeat(64), category: 'reference', required: false, reason: 'budget' }] }
}
function importContext() {
  return { slot: { runId: 'frozen-import', stage: 'style', batchId: 'done' }, manifestFingerprint: contentHash,
    totalChapters: 100, totalWords: 5000, chapters: [2, 8, 90].map(number => ({ number, title: privateValue,
      content: privateValue, contentFingerprint: contentHash, wordCount: number })), core: { privateValue }, prompts: { privateValue } }
}

describe('frozen generation selection diagnostics', () => {
  it('counts only closed source namespaces and never returns their private labels or source references', () => {
    const sourceIds = ['project-core:main', 'author-action:private-author-text-and-path', 'planning-feedback:context',
      'legacy-roster-context', 'graph-generation-context', 'agent-blueprints:all', 'review-revision-context',
      'characters:all', 'character-relationships:all', 'narrative-thread-context:all', 'draft-target:3',
      'draft-continuity-catalog', 'continuity-locators', 'blueprint:3', 'finalized:3:private-author-text-and-path',
      'draft:3', 'project-guidance:private-author-text-and-path', 'knowledge-selection', 'kb:private-author-text-and-path',
      'plot-outline:origin', 'finalization-generation-context', 'editor-inline:author-draft',
      'import-manifest:private-author-text-and-path', 'agent-context', privateValue]
    const frozen = binding({}, sourceIds), before = JSON.stringify(frozen)
    const projected = projectGenerationSourceSelection(frozen)
    expect(projected.sourceRefs).toEqual({ coverage: 'recorded', counts: GENERATION_DIAGNOSTIC_SOURCE_KINDS.map(kind => ({ kind, count: 1 })) })
    expect(JSON.stringify(projected)).not.toContain(privateValue)
    expect(JSON.stringify(frozen)).toBe(before)
    expect(projectGenerationSourceSelection(binding({}, ['__proto__', 'constructor', 'blueprint:3', 'blueprint:4'])).sourceRefs.counts)
      .toEqual([{ kind: 'blueprint', count: 2 }, { kind: 'unknown', count: 2 }])
  })
  it('distinguishes an empty recorded source list from absent historical evidence', () => {
    expect(projectGenerationSourceSelection(binding())).toEqual({ sourceRefs: { coverage: 'recorded', counts: [] },
      materialDecision: { coverage: 'not_recorded', receipt: null }, import: { coverage: 'not_recorded', source: null } })
    const historical = { sourceManifest: {} } as unknown as Parameters<typeof projectGenerationSourceSelection>[0]
    expect(projectGenerationSourceSelection(historical).sourceRefs).toEqual({ coverage: 'not_recorded', counts: null })
  })
  it('copies material metadata field by field without retaining nested extras or mutable references', () => {
    const expected = decision(), source = { ...decision(), private: privateValue,
      capacity: { ...expected.capacity, private: privateValue }, coverage: { ...expected.coverage, private: privateValue },
      included: expected.included.map(item => ({ ...item, private: privateValue })),
      omitted: expected.omitted.map(item => ({ ...item, private: privateValue })) }
    const projected = projectGenerationSourceSelection(binding({ materialDecision: source }))
    expect(projected.materialDecision).toEqual({ coverage: 'recorded', receipt: expected })
    expect(JSON.stringify(projected)).not.toContain(privateValue)
    projected.materialDecision.receipt!.included[0]!.units = 999
    expect(source.included[0]!.units).toBe(10)
  })
  it.each([
    ['included label', (value: MaterialDecisionReceipt) => { value.included[0]!.sourceId = privateValue }],
    ['omitted label', (value: MaterialDecisionReceipt) => { value.omitted[0]!.sourceId = privateValue }],
    ['category', (value: MaterialDecisionReceipt) => { Object.assign(value.included[0]!, { category: privateValue }) }],
    ['reason', (value: MaterialDecisionReceipt) => { Object.assign(value.omitted[0]!, { reason: privateValue }) }],
    ['prompt hash', (value: MaterialDecisionReceipt) => { value.promptHash = privateValue }],
    ['units', (value: MaterialDecisionReceipt) => { Object.assign(value.included[0]!, { units: privateValue }) }],
    ['capacity', (value: MaterialDecisionReceipt) => { Object.assign(value.capacity, { methodVersion: privateValue }) }],
    ['coverage', (value: MaterialDecisionReceipt) => { Object.assign(value.coverage, { complete: privateValue }) }],
  ] as const)('rejects poisoned material %s with only a fixed error code', (_label, poison) => {
    const source = decision()
    poison(source)
    expect(() => projectGenerationSourceSelection(binding({ materialDecision: source }))).toThrow(/^GENERATION_DIAGNOSTICS_INVALID$/u)
  })
  it('preserves the actual ordered sparse import chapters rather than inventing a contiguous range', () => {
    const context = importContext(), before = JSON.stringify(context)
    const projected = projectGenerationSourceSelection(binding({ importContext: context }))
    expect(projected.import).toEqual({ coverage: 'recorded', source: { kind: 'import', manifestFingerprint: contentHash,
      totalChapters: 100, totalWords: 5000, selectedChapters: [2, 8, 90].map(number => ({ number, contentHash, wordCount: number })), checkpointRange: null } })
    expect(JSON.stringify(projected)).not.toContain(privateValue)
    expect(JSON.stringify(context)).toBe(before)
  })
  it('returns only the range parsed from the frozen blueprint checkpoint', () => {
    const context = { ...importContext(), slot: { runId: 'frozen-import', stage: 'blueprints', batchId: '11-12-aaaaaaaa.bbbbbbbb' },
      chapters: [{ number: 11, contentFingerprint: contentHash, wordCount: 50 }, { number: 12, contentFingerprint: secondHash, wordCount: 60 }] }
    expect(projectGenerationSourceSelection(binding({ importContext: context })).import.source).toEqual({ kind: 'import',
      manifestFingerprint: contentHash, totalChapters: 100, totalWords: 5000,
      selectedChapters: [{ number: 11, contentHash, wordCount: 50 }, { number: 12, contentHash: secondHash, wordCount: 60 }],
      checkpointRange: { startChapter: 11, endChapter: 12 } })
    context.slot.batchId = '11-12-private-author-text-and-path'
    expect(() => projectGenerationSourceSelection(binding({ importContext: context }))).toThrow(/^GENERATION_DIAGNOSTICS_INVALID$/u)
  })
  it.each(['number', 'contentFingerprint', 'wordCount'] as const)('rejects poisoned import chapter %s instead of exporting it', field => {
    const context = importContext()
    Object.assign(context.chapters[0]!, { [field]: privateValue })
    expect(() => projectGenerationSourceSelection(binding({ importContext: context }))).toThrow(/^GENERATION_DIAGNOSTICS_INVALID$/u)
  })
})

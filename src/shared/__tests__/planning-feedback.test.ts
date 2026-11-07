import { describe, expect, it } from 'vitest'
import {
  PLANNING_FEEDBACK_CORE_COLUMNS, PLANNING_FEEDBACK_TARGETS, assertPlanningFeedbackAdoption,
  assertPlanningFeedbackId, assertPlanningFeedbackInstructions, isPlanningFeedbackTarget,
  planningFeedbackAdoptionBinding, planningFeedbackCoreSnapshot, type PlanningFeedbackBase, type PlanningFeedbackCandidate,
} from '../planning-feedback'

describe('single-field planning feedback v1', () => {
  it('limits targets to the six current config fields and premise/worldbuilding', () => {
    expect(PLANNING_FEEDBACK_TARGETS).toEqual(['coreOutline', 'worldSetting', 'goldenFinger',
      'protagonistProfile', 'globalGuidance', 'writingStyle', 'premise', 'worldbuilding'])
    for (const value of ['synopsis', 'charactersArch', 'drafts', 'blueprint', {}, undefined]) {
      expect(isPlanningFeedbackTarget(value)).toBe(false)
    }
    expect(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS)).not.toContain('characterStates')
    expect(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS)).not.toContain('charactersArch')
    expect(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS)).not.toContain('synopsis')
  })

  it.each(['full', 'partial', 'edited'] as const)('accepts an exact %s decision without normalizing author bytes', decision => {
    const request = { candidateId: 'candidate-1', idempotencyKey: 'author-click', decision, text: ' e\u0301\r\n  ' }
    expect(() => assertPlanningFeedbackAdoption(request)).not.toThrow()
    expect(request.text).toBe(' e\u0301\r\n  ')
  })

  it.each([
    { candidateId: 'c', idempotencyKey: 'k', decision: 'all', text: 'x' },
    { candidateId: 'c', idempotencyKey: 'k', decision: { toString: (): string => 'full' }, text: 'x' },
    { candidateId: 'c', idempotencyKey: 'k', decision: 'full', text: 1 },
    { candidateId: 'c', idempotencyKey: 'k', decision: 'full', text: 'x', generated: true },
    { candidateId: 'c', idempotencyKey: 'k', decision: 'full', text: 'x', decisionSource: 'author-action' },
    { candidateId: 'c', idempotencyKey: 'k', decision: 'full', text: 'x', target: 'synopsis' },
    { candidateId: 'c', idempotencyKey: 'k', decision: 'full' },
  ])('rejects unknown fields or malformed final payloads', request => {
    expect(() => assertPlanningFeedbackAdoption(request)).toThrow('PLANNING_FEEDBACK_PAYLOAD_INVALID')
  })

  it('does not accept paths as business IDs or object-valued constraints', () => {
    expect(() => assertPlanningFeedbackId('C:\\private\\file')).toThrow('PLANNING_FEEDBACK_ID_INVALID')
    expect(() => assertPlanningFeedbackInstructions('feedback', [{ instruction: 'x' }])).toThrow()
    expect(() => assertPlanningFeedbackInstructions('feedback', ['keep the title'])).not.toThrow()
  })

  it('projects only the known author inputs in a stable order regardless of full-core derived data', () => {
    const core = Object.fromEntries(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS).reverse()
      .map(key => [key, key === 'totalChapters' || key === 'wordsPerChapter' ? 100 : 'author text']))
    const source = planningFeedbackCoreSnapshot({ ...core, characterStates: 'derived', charactersArch: 'projection', synopsis: 'other stage' })
    expect(Object.keys(source)).toEqual(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS))
    expect(JSON.stringify(source)).not.toContain('derived')
    expect(() => planningFeedbackCoreSnapshot({ ...core, totalChapters: '100' })).toThrow('PLANNING_FEEDBACK_INTEGRITY_FAILED')
  })

  it('binds payload, decision, target, F0 revision and the real generation parent separately', () => {
    const base = { schemaVersion: 1, baseId: 'f0', projectId: 'project', target: 'premise',
      sourceRevision: 5, sourceHash: 'source', valueHash: 'f0-hash' } as PlanningFeedbackBase
    const candidate = { schemaVersion: 1, candidateId: 'c2', baseId: 'f0',
      textHash: 'c2-hash', generationParentHash: 'c1-hash' } as PlanningFeedbackCandidate
    const request = { candidateId: 'c2', idempotencyKey: 'key', decision: 'edited' as const, text: 'final' }
    const original = planningFeedbackAdoptionBinding(request, candidate, base, 'payload')
    expect(original).toContain('c1-hash')
    expect(original).toContain('f0')
    expect(JSON.parse(original).slice(-3)).toEqual(['edited', 'author-action', 'payload'])
    const variants = [
      planningFeedbackAdoptionBinding({ ...request, decision: 'partial' }, candidate, base, 'payload'),
      planningFeedbackAdoptionBinding(request, candidate, { ...base, target: 'worldbuilding' }, 'payload'),
      planningFeedbackAdoptionBinding(request, candidate, { ...base, sourceRevision: 7 }, 'payload'),
      planningFeedbackAdoptionBinding(request, { ...candidate, generationParentHash: 'f0-hash' }, base, 'payload'),
      planningFeedbackAdoptionBinding(request, candidate, base, 'different-payload'),
    ]
    expect(variants.every(value => value !== original)).toBe(true)
  })
})

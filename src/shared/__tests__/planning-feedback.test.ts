import { describe, expect, it } from 'vitest'
import {
  PLANNING_FEEDBACK_CORE_COLUMNS, PLANNING_FEEDBACK_TARGETS, assertPlanningFeedbackAdoption,
  assertPlanningFeedbackId, assertPlanningFeedbackInstructions, isPlanningFeedbackTarget,
  planningFeedbackAdoptionBinding, planningFeedbackCoreSnapshot, parsePlanningFeedbackScope, parsePlanningFeedbackSource,
  planningFeedbackSourceCore, planningFeedbackAdoptedScope, type PlanningFeedbackBase, type PlanningFeedbackCandidate,
  BLUEPRINT_FEEDBACK_FIELDS, parsePlanningFeedbackBlueprintText, planningFeedbackBlueprintValue,
  type PlanningFeedbackBlueprintSource, type PlanningFeedbackBlueprintScope,
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
    const base = { schemaVersion: 1, baseId: 'f0', projectId: 'project', target: 'premise', scope: { kind: 'field', field: 'premise' },
      sourceRevision: 5, sourceHash: 'source', valueHash: 'f0-hash' } as Extract<PlanningFeedbackBase, { schemaVersion: 1 }>
    const candidate = { schemaVersion: 1, candidateId: 'c2', baseId: 'f0',
      textHash: 'c2-hash', generationParentHash: 'c1-hash' } as PlanningFeedbackCandidate
    const request = { candidateId: 'c2', idempotencyKey: 'key', decision: 'edited' as const, text: 'final' }
    const original = planningFeedbackAdoptionBinding(request, candidate, base, 'payload')
    expect(original).toContain('c1-hash')
    expect(original).toContain('f0')
    expect(JSON.parse(original).slice(-3)).toEqual(['edited', 'author-action', 'payload'])
    expect(original).toBe(JSON.stringify([1, 'c2', 1, 'f0', 'project', 'premise', 'field', 5, 'source', 'c2-hash', 'c1-hash', 'edited', 'author-action', 'payload']))
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

describe('closed blueprint field planning feedback schema3', () => {
  const scope: PlanningFeedbackBlueprintScope = { kind: 'blueprint-fields', chapterNumber: 3, fields: ['title', 'characters', 'notes'] }
  const core = planningFeedbackCoreSnapshot(Object.fromEntries(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS)
    .map(key => [key, key === 'totalChapters' || key === 'wordsPerChapter' ? 100 : 'Fictional author facts'])))
  const source: PlanningFeedbackBlueprintSource = { core, synopsis: 'Fictional formal outline', charactersArch: 'Fictional architecture',
    blueprint: { chapterNumber: 3, title: 'Original title', role: 'Turning point', purpose: 'Reach the harbor', keyEvents: 'Mira finds a letter',
      characters: ['Mira', 'Ren'], suspenseHook: 'The sender is missing', userGuidance: '', notes: 'Author note\r\n', notesUpdatedAt: '2026-11-10T00:00:00.000Z' } }

  it('uses the existing eight-field whitelist and canonicalizes a nonempty distinct selection', () => {
    expect(BLUEPRINT_FEEDBACK_FIELDS).toEqual(['title', 'role', 'purpose', 'keyEvents', 'characters', 'suspenseHook', 'userGuidance', 'notes'])
    expect(isPlanningFeedbackTarget('blueprintFields')).toBe(true)
    expect(PLANNING_FEEDBACK_TARGETS).toHaveLength(8)
    expect(parsePlanningFeedbackScope({ kind: 'blueprint-fields', chapterNumber: 3, fields: ['notes', 'title', 'characters'] })).toEqual(scope)
    expect(parsePlanningFeedbackScope({ kind: 'blueprint-fields', chapterNumber: 1, fields: ['notes'] }))
      .toEqual({ kind: 'blueprint-fields', chapterNumber: 1, fields: ['notes'] })
  })

  it('rejects empty, duplicate, sparse, auxiliary or malformed scope declarations', () => {
    for (const fields of [[], ['title', 'title'], new Array<string>(1), ['newCharacterCandidates'], ['relationshipHints'], ['chapterNumber'], ['notesUpdatedAt'], ['Title'], [null]]) {
      expect(() => parsePlanningFeedbackScope({ ...scope, fields })).toThrow()
    }
    for (const chapterNumber of [0, -1, 1.5, '3', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parsePlanningFeedbackScope({ ...scope, chapterNumber })).toThrow()
    }
    expect(() => parsePlanningFeedbackScope({ ...scope, source: 'renderer' })).toThrow()
  })

  it('freezes exactly the ten persisted blueprint fields without auxiliary evidence or mutations', () => {
    const parsed = parsePlanningFeedbackSource('blueprintFields', source) as PlanningFeedbackBlueprintSource
    expect(parsed).toEqual(source)
    expect(parsed).not.toBe(source)
    expect(parsed.blueprint.characters).not.toBe(source.blueprint.characters)
    expect(Object.keys(parsed.blueprint)).toEqual(['chapterNumber', ...BLUEPRINT_FEEDBACK_FIELDS, 'notesUpdatedAt'])
    expect(planningFeedbackSourceCore(parsed)).toEqual(core)
    for (const extra of [{ newCharacterCandidates: [] }, { relationshipHints: [] }, { createdAt: 'date' }, { source: 'claim' }]) {
      expect(() => parsePlanningFeedbackSource('blueprintFields', { ...source, blueprint: { ...source.blueprint, ...extra } })).toThrow()
    }
    expect(() => parsePlanningFeedbackSource('blueprintFields', { ...source, extra: 'not a source field' })).toThrow()
    expect(() => parsePlanningFeedbackSource('blueprintFields', { ...source, core: { ...core, characterStates: 'derived' } })).toThrow()
    expect(() => parsePlanningFeedbackSource('plotOutlineRange', source)).toThrow()
    for (const characters of [new Array<string>(1), ['Mira', ' Mira '], [''], ['Mira', null]]) {
      expect(() => parsePlanningFeedbackSource('blueprintFields', { ...source, blueprint: { ...source.blueprint, characters } })).toThrow()
    }
    expect(() => parsePlanningFeedbackSource('blueprintFields', { ...source, blueprint: { ...source.blueprint, notesUpdatedAt: null } })).toThrow()
    expect(() => parsePlanningFeedbackSource('blueprintFields', { ...source, blueprint: { ...source.blueprint, title: 3 } })).toThrow()
  })

  it('projects only selected F0 values in canonical order and binds them to the actual chapter', () => {
    expect(planningFeedbackBlueprintValue(source, scope)).toBe(JSON.stringify({ title: source.blueprint.title, characters: ['Mira', 'Ren'], notes: 'Author note\r\n' }))
    expect(planningFeedbackBlueprintValue(source, { ...scope, fields: ['notes', 'title'] })).toBe(JSON.stringify({ title: source.blueprint.title, notes: 'Author note\r\n' }))
    expect(() => planningFeedbackBlueprintValue(source, { ...scope, chapterNumber: 4 })).toThrow('PLANNING_FEEDBACK_SCOPE_INVALID')
  })

  it('requires all and only generated fields but allows a nonempty explicit adopted subset', () => {
    const text = JSON.stringify({ notes: '', characters: ['Mira'], title: ' Revised title\r\n' })
    expect(parsePlanningFeedbackBlueprintText(text, scope, true)).toEqual({ title: ' Revised title\r\n', characters: ['Mira'], notes: '' })
    expect(Object.keys(parsePlanningFeedbackBlueprintText(text, scope, true))).toEqual(scope.fields)
    expect(parsePlanningFeedbackBlueprintText('{"notes":""}', scope, false)).toEqual({ notes: '' })
    expect(parsePlanningFeedbackBlueprintText('{"userGuidance":"","notes":""}', { ...scope, fields: ['userGuidance', 'notes'] }, true))
      .toEqual({ userGuidance: '', notes: '' })
    for (const invalid of ['{}', '[]', 'null', 'not JSON', '```json\n{"title":"T"}\n```', '{"title":"T"}{"notes":"N"}',
      '{"title":"T","notes":"N","characters":[] ,"chapterNumber":3}', '{"title":"T","notes":"N","characters":[],"newCharacterCandidates":[]}',
      '{"title":"T","notes":"N","characters":[],"relationshipHints":[]}', '{"title":3}', '{"characters":["Mira"," Mira "]}', '{"characters":[null]}']) {
      expect(() => parsePlanningFeedbackBlueprintText(invalid, scope, false)).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    }
    expect(() => parsePlanningFeedbackBlueprintText('{"title":"Only one field"}', scope, true)).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
  })

  it('derives adopted scope from actual final JSON and binds full equality without new wire fields', () => {
    const base = { schemaVersion: 3, target: 'blueprintFields', scope, baseId: 'blueprint-f0', projectId: 'project', sourceRevision: 9,
      sourceHash: 'source', source, value: planningFeedbackBlueprintValue(source, scope), valueHash: 'f0-hash', createdAt: 1,
      closedAt: null, closedByAdoptionId: null } as const satisfies PlanningFeedbackBase
    const candidate = { schemaVersion: 3, candidateId: 'c2', text: '{"title":"T","characters":["Mira"],"notes":""}',
      textHash: 'candidate-hash', generationParentHash: 'c1-hash' } as PlanningFeedbackCandidate
    const request = { candidateId: 'c2', idempotencyKey: 'author-action', decision: 'partial' as const, text: '{"notes":""}' }
    expect(planningFeedbackAdoptedScope(base, undefined, request.text)).toEqual({ kind: 'blueprint-fields', chapterNumber: 3, fields: ['notes'] })
    expect(() => planningFeedbackAdoptedScope(base)).toThrow('PLANNING_FEEDBACK_SCOPE_INVALID')
    expect(() => planningFeedbackAdoptedScope(base, { from: 3, to: 3 }, request.text)).toThrow('PLANNING_FEEDBACK_SCOPE_INVALID')
    expect(() => assertPlanningFeedbackAdoption({ ...request, adoptedFields: ['notes'] })).toThrow()
    const binding = planningFeedbackAdoptionBinding(request, candidate, base, 'payload')
    expect(JSON.parse(binding)).toEqual([3, 'c2', 3, 'blueprint-f0', 'project', 'blueprintFields', scope,
      { kind: 'blueprint-fields', chapterNumber: 3, fields: ['notes'] }, 9, 'source', 'candidate-hash', 'c1-hash', 'partial', 'author-action', 'payload'])
    expect(() => planningFeedbackAdoptionBinding({ ...request, decision: 'full' }, candidate, base, 'payload')).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
    expect(() => planningFeedbackAdoptionBinding({ ...request, decision: 'full', text: candidate.text }, candidate, base, 'payload')).not.toThrow()
    expect(() => planningFeedbackAdoptionBinding({ ...request, text: '{"role":"not selected"}' }, candidate, base, 'payload')).toThrow('PLANNING_FEEDBACK_TEXT_INVALID')
  })
})

describe('closed planning feedback range protocol v2', () => {
  it('keeps the legacy eight-target constant stable while recognizing the dedicated range target', () => {
    expect(PLANNING_FEEDBACK_TARGETS).toHaveLength(8)
    expect(isPlanningFeedbackTarget('plotOutlineRange')).toBe(true)
    expect(parsePlanningFeedbackScope({ kind: 'field', field: 'premise' })).toEqual({ kind: 'field', field: 'premise' })
    expect(parsePlanningFeedbackScope({ to: 4, kind: 'plot-outline-range', from: 3 }))
      .toEqual({ kind: 'plot-outline-range', from: 3, to: 4 })
  })

  it.each([
    { kind: 'field', field: 'synopsis' }, { kind: 'blueprint-field', field: 'title', chapterNumber: 3 },
    { kind: 'plot-outline-range', from: 3, to: 4, writer: 'raw' }, { kind: 'plot-outline-range', from: '3', to: 4 },
    { kind: 'plot-outline-range', from: 0, to: 4 }, { kind: 'plot-outline-range', from: 4, to: 3 },
    { kind: 'plot-outline-range', from: 1, to: 11 },
  ])('rejects unknown or noncanonical scopes: %j', scope => {
    expect(() => parsePlanningFeedbackScope(scope)).toThrow()
  })

  it('parses only the known range source and exposes its core without flattening or losing outline facts', () => {
    const core = planningFeedbackCoreSnapshot(Object.fromEntries(Object.keys(PLANNING_FEEDBACK_CORE_COLUMNS)
      .map(key => [key, key === 'totalChapters' || key === 'wordsPerChapter' ? 100 : 'author text'])))
    const source = { core, synopsis: 'Formal outline', charactersArch: 'Author architecture' }
    expect(parsePlanningFeedbackSource('plotOutlineRange', source)).toEqual(source)
    expect(planningFeedbackSourceCore(source)).toEqual(core)
    expect(planningFeedbackSourceCore(core)).toEqual(core)
    expect(() => parsePlanningFeedbackSource('plotOutlineRange', { ...source, secret: 'not an allowed source' })).toThrow()
    expect(() => parsePlanningFeedbackSource('plotOutlineRange', { ...source, core: { ...core, characterStates: 'derived' } })).toThrow()
    expect(() => parsePlanningFeedbackSource('premise', source)).toThrow()
  })

  it('binds the original and adopted chapter scopes separately and rejects expansion or field/range mixing', () => {
    const base = { schemaVersion: 2, baseId: 'base-range', projectId: 'project', target: 'plotOutlineRange',
      scope: { kind: 'plot-outline-range', from: 3, to: 4 }, sourceRevision: 7, sourceHash: 'source' } as Extract<PlanningFeedbackBase, { schemaVersion: 2 }>
    const candidate = { schemaVersion: 2, candidateId: 'c2', textHash: 'candidate', generationParentHash: 'c1' } as PlanningFeedbackCandidate
    const request = { candidateId: 'c2', idempotencyKey: 'choose', decision: 'partial' as const, text: 'Chapter 3', adoptedRange: { from: 3, to: 3 } }
    expect(() => assertPlanningFeedbackAdoption(request)).not.toThrow()
    const binding = planningFeedbackAdoptionBinding(request, candidate, base, 'payload')
    expect(JSON.parse(binding).slice(5, 8)).toEqual(['plotOutlineRange', base.scope, { kind: 'plot-outline-range', from: 3, to: 3 }])
    expect(planningFeedbackAdoptionBinding({ ...request, adoptedRange: { from: 4, to: 4 } }, candidate, base, 'payload')).not.toBe(binding)
    expect(() => planningFeedbackAdoptedScope(base, { from: 2, to: 3 })).toThrow('PLANNING_FEEDBACK_SCOPE_INVALID')
    const field = { ...base, schemaVersion: 1, target: 'premise', scope: { kind: 'field', field: 'premise' } } as unknown as PlanningFeedbackBase
    expect(() => planningFeedbackAdoptedScope(field, request.adoptedRange)).toThrow('PLANNING_FEEDBACK_SCOPE_INVALID')
  })
})

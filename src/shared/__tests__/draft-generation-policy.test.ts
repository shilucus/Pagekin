import { describe, expect, it } from 'vitest'
import type { LLMFinishReason } from '../ipc-channels'
import {
  MAX_AUTO_CONTINUE_ROUNDS,
  acceptsCondensedDraft,
  draftContinuationBudget,
  hasSubstantialPreviousChapterReuse,
  isAcceptedDraftContinuation,
  isLowProgressDraftContinuation,
  shouldAutoContinueDraft,
  shouldCondenseDraft,
} from '../draft-generation-policy'

const prose = (units: number) => '\u7532'.repeat(units)

describe('draft continuation policy', () => {
  it('keeps the shared seven-round limit', () => {
    expect(MAX_AUTO_CONTINUE_ROUNDS).toBe(7)
  })

  it.each([
    { units: 699, rounds: 6, finish: 'stop', expected: true },
    { units: 700, rounds: 6, finish: 'stop', expected: false },
    { units: 700, rounds: 6, finish: 'length', expected: true },
    { units: 800, rounds: 6, finish: 'length', expected: true },
    { units: 1300, rounds: 6, finish: 'length', expected: true },
    { units: 1301, rounds: 6, finish: 'length', expected: false },
    { units: 699, rounds: 7, finish: 'stop', expected: false },
    { units: 699, rounds: 7, finish: 'length', expected: false },
    { units: 0, rounds: 0, finish: 'content_filter', expected: false },
    { units: 0, rounds: 0, finish: 'error', expected: false },
    { units: 0, rounds: 0, finish: 'unknown', expected: false },
    { units: 0, rounds: 0, finish: 'cancelled', expected: false },
  ] satisfies Array<{ units: number; rounds: number; finish: LLMFinishReason; expected: boolean }>)('continues $finish at $units units after $rounds rounds: $expected', ({ units, rounds, finish, expected }) => {
    expect(shouldAutoContinueDraft(prose(units), 1000, rounds, finish)).toBe(expected)
  })

  it('uses the shared Unicode prose-unit counter', () => {
    expect(shouldAutoContinueDraft('Caf\u00e9 '.repeat(700), 1000, 6, 'stop')).toBe(false)
    expect(shouldAutoContinueDraft('\u{20000}'.repeat(699), 1000, 6, 'stop')).toBe(true)
  })

  it.each([
    { units: 0, remaining: 1000, ceiling: 1300, allowance: 1000 },
    { units: 699, remaining: 301, ceiling: 601, allowance: 301 },
    { units: 999, remaining: 1, ceiling: 301, allowance: 1 },
    { units: 1000, remaining: 0, ceiling: 300, allowance: 150 },
    { units: 1200, remaining: 0, ceiling: 100, allowance: 100 },
    { units: 1300, remaining: 0, ceiling: 0, allowance: 0 },
    { units: 1301, remaining: 0, ceiling: 0, allowance: 0 },
  ])('keeps the continuation allowance at $units units', ({ units, remaining, ceiling, allowance }) => {
    expect(draftContinuationBudget(units, 1000)).toEqual({ remaining, ceiling, allowance })
  })

  it.each([
    { finish: 'length', added: 0, lowProgress: true, accepted: false },
    { finish: 'length', added: 299, lowProgress: true, accepted: false },
    { finish: 'length', added: 300, lowProgress: false, accepted: true },
    { finish: 'stop', added: 0, lowProgress: false, accepted: true },
    { finish: 'stop', added: 299, lowProgress: false, accepted: true },
    { finish: 'stop', added: 300, lowProgress: false, accepted: true },
  ] satisfies Array<{ finish: LLMFinishReason; added: number; lowProgress: boolean; accepted: boolean }>)('preserves $finish with $added added units', ({ finish, added, lowProgress, accepted }) => {
    expect(isLowProgressDraftContinuation(finish, added)).toBe(lowProgress)
    expect(isAcceptedDraftContinuation(finish, added)).toBe(accepted)
  })
})

describe('single condense policy', () => {
  it.each([
    { units: 700, attempted: false, expected: false },
    { units: 1300, attempted: false, expected: false },
    { units: 1301, attempted: false, expected: true },
    { units: 1301, attempted: true, expected: false },
  ])('condenses $units units with prior attempt $attempted: $expected', ({ units, attempted, expected }) => {
    expect(shouldCondenseDraft(units, 1000, attempted)).toBe(expected)
  })

  it('allows an over-limit LENGTH candidate to reach the existing condense stage', () => {
    expect(shouldAutoContinueDraft(prose(1301), 1000, 0, 'length')).toBe(false)
    expect(shouldCondenseDraft(1301, 1000, false)).toBe(true)
  })

  it.each([
    { finish: 'stop', units: 699, expected: false },
    { finish: 'stop', units: 700, expected: true },
    { finish: 'stop', units: 1300, expected: true },
    { finish: 'stop', units: 1450, expected: true },
    { finish: 'length', units: 700, expected: false },
    { finish: 'length', units: 1301, expected: false },
    { finish: 'cancelled', units: 1000, expected: false },
    { finish: 'unknown', units: 1000, expected: false },
  ] satisfies Array<{ finish: LLMFinishReason; units: number; expected: boolean }>)('accepts $finish condense output at $units units: $expected', ({ finish, units, expected }) => {
    expect(acceptsCondensedDraft(finish, units, 1000)).toBe(expected)
  })
})

describe('substantial previous-chapter reuse', () => {
  it.each(['zh-CN', 'en-US'] as const)('keeps the continuous 79/80-character boundary in %s', language => {
    expect(hasSubstantialPreviousChapterReuse('a'.repeat(100), 'a'.repeat(79), language)).toBe(false)
    expect(hasSubstantialPreviousChapterReuse('a'.repeat(100), 'a'.repeat(80), language)).toBe(true)
  })

  it('detects Chinese reuse after removing punctuation and whitespace', () => {
    expect(hasSubstantialPreviousChapterReuse(prose(100), '\u7532\uff0c '.repeat(80), 'zh-CN')).toBe(true)
  })

  it('keeps English case folding and compatibility normalization', () => {
    expect(hasSubstantialPreviousChapterReuse('\uff21'.repeat(100), 'a, '.repeat(80), 'en-US')).toBe(true)
  })

  it('keeps the distinct CJK and English n-gram lengths', () => {
    const shortSource = 'abcdefghijklmnopqrs'
    expect(hasSubstantialPreviousChapterReuse(shortSource, shortSource.repeat(6), 'en-US')).toBe(false)
    expect(hasSubstantialPreviousChapterReuse(shortSource, shortSource.repeat(6), 'zh-CN')).toBe(true)
  })

  it('does not join separated reused passages into one continuous run', () => {
    expect(hasSubstantialPreviousChapterReuse(prose(100), prose(50) + '\u4e59'.repeat(20) + prose(50), 'zh-CN')).toBe(false)
  })

  it('checks only the first 1200 raw characters of the next chapter', () => {
    expect(hasSubstantialPreviousChapterReuse(prose(100), '\u4e59'.repeat(1200) + prose(100), 'zh-CN')).toBe(false)
  })

  it.each(['zh-CN', 'en-US'] as const)('does not rewrite or reject an authored refrain without predecessor reuse in %s', language => {
    const refrain = 'The light returns when the night has ended. '.repeat(4)
    const draft = refrain + '\n\nA different scene.\n\n' + refrain
    const original = draft
    expect(hasSubstantialPreviousChapterReuse('A different predecessor with no matching passage.', draft, language)).toBe(false)
    expect(draft).toBe(original)
  })

  it.each(['zh-CN', 'en-US'] as const)('keeps empty and short source windows harmless in %s', language => {
    expect(hasSubstantialPreviousChapterReuse('', prose(100), language)).toBe(false)
    expect(hasSubstantialPreviousChapterReuse('brief', 'brief', language)).toBe(false)
    expect(hasSubstantialPreviousChapterReuse(prose(100), '', language)).toBe(false)
  })
})

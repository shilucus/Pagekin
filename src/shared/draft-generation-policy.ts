import type { LLMFinishReason } from './ipc-channels'
import { countDraftUnits, draftTargetUnitRange } from './draft-units'
import type { WritingLanguage } from './writing-language'

// Ordinary continuations and the single no-progress recovery share this limit.
export const MAX_AUTO_CONTINUE_ROUNDS = 7
const NEXT_CHAPTER_HEAD_MAX_CHARS = 1200
const CROSS_CHAPTER_REUSE_CJK_NGRAM_CHARS = 8
const CROSS_CHAPTER_REUSE_ENGLISH_NGRAM_CHARS = 20
const CROSS_CHAPTER_REUSE_LONG_RUN_CHARS = 80

export function hasSubstantialPreviousChapterReuse(
  previousEnding: string,
  draft: string,
  writingLanguage: WritingLanguage,
): boolean {
  const ngramCharacters = writingLanguage === 'en-US'
    ? CROSS_CHAPTER_REUSE_ENGLISH_NGRAM_CHARS
    : CROSS_CHAPTER_REUSE_CJK_NGRAM_CHARS
  const normalize = (text: string) => text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
  const previous = normalize(previousEnding)
  const nextHead = normalize(draft.slice(0, NEXT_CHAPTER_HEAD_MAX_CHARS))
  if (previous.length < ngramCharacters || nextHead.length < ngramCharacters) {
    return false
  }

  const previousNgrams = new Set<string>()
  for (let index = 0; index <= previous.length - ngramCharacters; index += 1) {
    previousNgrams.add(previous.slice(index, index + ngramCharacters))
  }

  const covered = new Uint8Array(nextHead.length)
  for (let index = 0; index <= nextHead.length - ngramCharacters; index += 1) {
    if (!previousNgrams.has(nextHead.slice(index, index + ngramCharacters))) continue
    for (let offset = index; offset < index + ngramCharacters; offset += 1) {
      covered[offset] = 1
    }
  }

  let runLength = 0
  for (let index = 0; index <= covered.length; index += 1) {
    if (covered[index]) {
      runLength += 1
      continue
    }
    if (runLength >= CROSS_CHAPTER_REUSE_LONG_RUN_CHARS) return true
    runLength = 0
  }
  return false
}

export function shouldAutoContinueDraft(
  currentText: string,
  targetUnits: number,
  rounds: number,
  finishReason: LLMFinishReason,
): boolean {
  if (rounds >= MAX_AUTO_CONTINUE_ROUNDS) return false
  const currentUnits = countDraftUnits(currentText)
  if (currentUnits > draftTargetUnitRange(targetUnits).maximum) return false
  if (finishReason === 'stop') {
    return currentUnits < draftTargetUnitRange(targetUnits).minimum
  }
  return finishReason === 'length'
}

export function draftContinuationBudget(currentUnits: number, targetUnits: number): {
  remaining: number
  ceiling: number
  allowance: number
} {
  const range = draftTargetUnitRange(targetUnits)
  const remaining = Math.max(0, targetUnits - currentUnits)
  const ceiling = Math.max(0, range.maximum - currentUnits)
  const allowance = remaining > 0 ? Math.min(remaining, ceiling) : Math.min(150, ceiling)
  return { remaining, ceiling, allowance }
}

// addedUnits is the net countDraftUnits increase of the merged candidate.
export function isLowProgressDraftContinuation(finishReason: LLMFinishReason, addedUnits: number): boolean {
  return finishReason === 'length' && addedUnits < 300
}

export function isAcceptedDraftContinuation(finishReason: LLMFinishReason, addedUnits: number): boolean {
  return finishReason === 'stop' || addedUnits >= 300
}

export function shouldCondenseDraft(currentUnits: number, targetUnits: number, alreadyAttempted: boolean): boolean {
  return currentUnits > draftTargetUnitRange(targetUnits).maximum && !alreadyAttempted
}

export function acceptsCondensedDraft(finishReason: LLMFinishReason, currentUnits: number, targetUnits: number): boolean {
  return finishReason === 'stop' && currentUnits >= draftTargetUnitRange(targetUnits).minimum
}

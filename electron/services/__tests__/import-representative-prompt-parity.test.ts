import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { closeProjectDatabase, getProjectDb } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { FinalizedDraftImportRepository } from '../../repositories/finalized-draft-import-repository'
import { getBuiltinPromptTemplate, type PromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { buildImportInferenceTask, formatImportInferenceSample } from '../../../src/shared/import-inference-materials'
import { buildImportStyleMaterial, collectImportStyleSamples } from '../../../src/shared/import-style-materials'
import { countDraftUnits } from '../../../src/shared/draft-units'
import type { ImportRunChapterInput, ImportRunChapterSnapshot, ImportRunSnapshot } from '../../../src/shared/import-run'
import type { WritingLanguage } from '../../../src/shared/writing-language'

const base = path.resolve('.runtime/.cache/novel-quality-modernization/representative-prompt-parity')
const pageSize = 100
const runId = 'fictional-representative-prompt-run'
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
let root = ''

beforeEach(() => {
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'fictional-'))
  openCanonicalProjectFixture(root)
  getProjectDb()!.prepare("INSERT INTO project_core(id,project_name) VALUES('main','Fictional parity project')").run()
}, 20_000)

afterEach(() => {
  closeProjectDatabase()
  if (!root) return
  const relative = path.relative(base, path.resolve(root))
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    || fs.lstatSync(root).isSymbolicLink()
    || fs.realpathSync.native(root) !== path.join(fs.realpathSync.native(base), relative)) {
    throw new Error('FICTIONAL_PARITY_CLEANUP_OUTSIDE_BASE')
  }
  fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

function chaptersFor(numbers: readonly number[], contentFor?: (number: number, index: number) => string): ImportRunChapterInput[] {
  return numbers.map((number, index) => {
    const content = contentFor?.(number, index)
      ?? ` \nFictional chapter ${number}, source position ${index}. ${'Bounded source material. '.repeat(140)}\n `
    return { number, title: `  Fictional chapter ${number}  `, content,
      contentFingerprint: hash(content), contentSize: Buffer.byteLength(content, 'utf8') }
  })
}

function prepare(chapters: ImportRunChapterInput[], purpose: 'reference' | 'author-manuscript', language: WritingLanguage): ImportRunSnapshot {
  const preview = purpose === 'author-manuscript' ? FinalizedDraftImportRepository.preview(chapters.map(chapter => ({
    chapterNumber: chapter.number, title: chapter.title.trim(), content: chapter.content, wordCount: countDraftUnits(chapter.content),
  }))) : undefined
  const prepared = ImportRunRepository.prepare({ runId, purpose, locale: language,
    sourceFingerprint: hash(`fictional-source:${purpose}:${language}`),
    sourceDisplay: [{ displayName: 'Fictional.txt', mediaType: 'text/plain', size: chapters.reduce((total, chapter) => total + chapter.contentSize, 0) }],
    chapters, ...(preview ? { authorityFingerprint: preview.authorityFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint, authorInference: true } : {}) })
  expect(prepared.classification).toBe('new')
  expect(prepared.run).toBeDefined()
  return prepared.run!
}

// Retain the former renderer pagination/selection formula independently of the new SQL selector.
function oldPagedRepresentativeChapters() {
  const first: ImportRunChapterSnapshot[] = [], last: ImportRunChapterSnapshot[] = [], all: ImportRunChapterSnapshot[] = []
  let after = 0, calls = 0
  for (;;) {
    const page = ImportRunRepository.listChapterBatch(runId, { afterChapterNumber: after, limit: pageSize })
    calls++
    if (!page.length) break
    all.push(...page)
    for (const chapter of page) {
      if (first.length < 3) first.push(chapter)
      last.push(chapter)
      if (last.length > 2) last.shift()
    }
    after = page.at(-1)!.number
  }
  const selected = new Map<number, ImportRunChapterSnapshot>()
  for (const chapter of [...first, ...last]) selected.set(chapter.number, chapter)
  return { selected: [...selected.values()].sort((left, right) => left.number - right.number), all, calls }
}

function template(key: string, language: WritingLanguage): PromptTemplate {
  const builtin = getBuiltinPromptTemplate(key, language)
  if (!builtin) throw new Error('FICTIONAL_PARITY_PROMPT_REQUIRED')
  return { ...builtin, systemRole: `  Frozen fictional ${key} role  `,
    taskGuidance: key === 'analyze_writing_style'
      ? 'Frozen guidance: {{sample_text}}'
      : 'Frozen guidance: {{total_chapters}}|{{first_chapter}}|{{latest_chapter}}' }
}

function materials(chapters: readonly ImportRunChapterSnapshot[], language: WritingLanguage, totalChapters: number) {
  const sampledContent = {
    worldview: formatImportInferenceSample([{ text: 'Fictional retrieved world\nline', score: 0.876, fileName: 'World.txt' }], language),
    protagonist: formatImportInferenceSample([], language),
    conflict: formatImportInferenceSample('unavailable', language),
    style: formatImportInferenceSample([{ text: 'Fictional retrieved style', score: 0.125, fileName: 'Style.txt' }], language),
  }
  const samples = collectImportStyleSamples({ chapters }, language)
  return {
    global: buildImportInferenceTask({ template: template('infer_novel_config_with_vectors', language), writingLanguage: language,
      chapters, totalChapters, sampledContent }),
    style: buildImportStyleMaterial(template('analyze_writing_style', language), samples, language).task,
    samples,
  }
}

const shapes = [
  ...[1, 2, 3, 4, 5, 6].map(count => ({ name: `${count}-chapter boundary`, numbers: Array.from({ length: count }, (_, index) => index + 1) })),
  { name: 'gapped source chapters renumbered by reference prepare', numbers: [2, 5, 8, 20, 99, 100] },
  { name: 'more than one page', numbers: Array.from({ length: 201 }, (_, index) => index * 3 + 2) },
]
const cases = (['zh-CN', 'en-US'] as const).flatMap(language =>
  (['reference', 'author-manuscript'] as const).flatMap(purpose => shapes
    .filter(shape => purpose === 'reference' || !shape.name.startsWith('gapped'))
    .map(shape => ({ language, purpose, ...shape,
      numbers: purpose === 'author-manuscript' ? shape.numbers.map((_, index) => index + 1) : shape.numbers }))))

describe('native import representative selection to complete prompt parity', () => {
  it.each(cases)('$language / $purpose / $name', ({ language, purpose, numbers }) => {
    const input = chaptersFor([...numbers].reverse())
    const run = prepare(input, purpose, language)
    const previous = oldPagedRepresentativeChapters()
    const selected = ImportRunRepository.listRepresentativeChapters(runId)
    expect(selected).toEqual(previous.selected)
    // Reference sources receive new stable global numbers; new author imports must be contiguous from one.
    const persistedNumbers = numbers.map((_, index) => index + 1)
    expect(previous.all.map(chapter => chapter.number)).toEqual(persistedNumbers)
    const expectedNumbers = [...new Set([...persistedNumbers.slice(0, 3), ...persistedNumbers.slice(-2)])].sort((left, right) => left - right)
    expect(selected.map(chapter => chapter.number)).toEqual(expectedNumbers)
    expect(previous.all).toHaveLength(input.length)
    expect(previous.calls).toBe(Math.ceil(input.length / pageSize) + 1)
    expect(run.purpose).toBe(purpose)
    expect(run.authorInference === true).toBe(purpose === 'author-manuscript')
    expect(run.manifestChapterCount).toBe(input.length)
    expect(run.manifestWordCount).toBe(input.reduce((total, chapter) => total + countDraftUnits(chapter.content), 0))
    expect(run.manifestContentSize).toBe(input.reduce((total, chapter) => total + chapter.contentSize, 0))
    for (const chapter of selected) {
      expect(chapter.contentFingerprint).toBe(hash(chapter.content))
      expect(chapter.contentSize).toBe(Buffer.byteLength(chapter.content, 'utf8'))
    }
    const actual = materials(selected, language, run.manifestChapterCount)
    const expected = materials(previous.selected, language, run.manifestChapterCount)
    expect(actual.global.messages).toEqual(expected.global.messages)
    expect(actual.style.messages).toEqual(expected.style.messages)
    expect(actual).toEqual(expected)
    // The global prompt uses only actual endpoints; style selects the same five from the full book.
    expect(actual).toEqual(materials(previous.all, language, run.manifestChapterCount))
    expect(actual.global).toMatchObject({ purpose: 'import-inference', output: 'structured-data', reasoningStage: 'planning' })
    expect(actual.style).toMatchObject({ purpose: 'analyze-writing-style', output: 'visible-text', reasoningStage: 'review' })
    expect(ImportRunRepository.get(runId)).toEqual(run)
  })

  it.each((['zh-CN', 'en-US'] as const).flatMap(language =>
    (['reference', 'author-manuscript'] as const).map(purpose => ({ language, purpose }))))(
    'preserves raw UTF-16 limits and trimming in complete $language / $purpose messages', ({ language, purpose }) => {
      const raw = ` ${'A'.repeat(1999)}\ud83d\ude42${'B'.repeat(997)}\ud83d\ude42OVERFLOW\n `
      const run = prepare(chaptersFor([1, 2, 3, 4, 5, 6], () => raw), purpose, language)
      const previous = oldPagedRepresentativeChapters()
      const selected = ImportRunRepository.listRepresentativeChapters(runId)
      const actual = materials(selected, language, run.manifestChapterCount)
      expect(actual).toEqual(materials(previous.selected, language, run.manifestChapterCount))
      const opening = raw.slice(0, 3000), styleText = raw.trim().slice(0, 2000)
      expect(opening.charCodeAt(opening.length - 1)).toBe(0xd83d)
      expect(styleText.charCodeAt(styleText.length - 1)).toBe(0xd83d)
      const endpointOnly = [{ ...selected[0]!, content: opening }, { ...selected.at(-1)!, content: opening }]
      expect(actual.global.messages).toEqual(materials(endpointOnly, language, run.manifestChapterCount).global.messages)
      expect(actual.samples).toEqual(selected.map(chapter => language === 'en-US'
        ? `Chapter ${chapter.number}: ${chapter.title}\n${styleText}`
        : `\u7b2c${chapter.number}\u7ae0 ${chapter.title}\n${styleText}`))
    },
  )

  it.each(['zh-CN', 'en-US'] as const)('refuses a gapped author fixture rather than fabricating an accepted import (%s)', language => {
    const chapters = chaptersFor([2, 5, 8, 20, 99, 100])
    const preview = FinalizedDraftImportRepository.preview(chapters.map(chapter => ({
      chapterNumber: chapter.number, title: chapter.title.trim(), content: chapter.content, wordCount: countDraftUnits(chapter.content),
    })))
    expect(preview).toMatchObject({ classification: 'conflict', firstGapChapterNumber: 1 })
    expect(() => prepare(chapters, 'author-manuscript', language)).toThrow()
    expect(ImportRunRepository.get(runId)).toBeNull()
  })

  it.each(['zh-CN', 'en-US'] as const)('retains whitespace-only reference samples without inventing finalized fallback (%s)', language => {
    const run = prepare(chaptersFor([1, 2, 3, 4, 5, 6], number => number === 4 ? 'Unselected fictional middle text' : ' \n\t '), 'reference', language)
    const previous = oldPagedRepresentativeChapters()
    const actual = materials(ImportRunRepository.listRepresentativeChapters(runId), language, run.manifestChapterCount)
    expect(actual).toEqual(materials(previous.selected, language, run.manifestChapterCount))
    expect(actual.samples).toEqual([])
    expect(actual.global.messages).toEqual(materials([{ ...previous.selected[0]!, content: ' \n\t ' }], language, 6).global.messages)
    expect(ImportRunRepository.get(runId)).toEqual(run)
  })

  it.each(['zh-CN', 'en-US'] as const)('preserves empty-result prompt fallbacks without fabricating an import run (%s)', language => {
    const previous = oldPagedRepresentativeChapters()
    expect(previous).toEqual({ selected: [], all: [], calls: 1 })
    const selected = ImportRunRepository.listRepresentativeChapters(runId)
    expect(selected).toEqual([])
    expect(materials(selected, language, 0)).toEqual(materials(previous.selected, language, 0))
    expect(ImportRunRepository.get(runId)).toBeNull()
  })
})

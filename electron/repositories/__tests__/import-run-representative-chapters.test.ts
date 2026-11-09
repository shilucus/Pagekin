import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { ImportRunRepository, type CapturedImportRunContext } from '../import-run-repository'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const runId = 'fictional-run'

function fixture(numbers: number[], marker = 'A', purpose = 'reference') {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE import_runs (id TEXT PRIMARY KEY, purpose TEXT NOT NULL);
    CREATE TABLE import_run_chapters (
      run_id TEXT NOT NULL, chapter_number INTEGER NOT NULL,
      source_id TEXT NOT NULL, source_chapter_number INTEGER NOT NULL,
      title TEXT NOT NULL, content_fingerprint TEXT NOT NULL,
      content_size INTEGER NOT NULL, content_snapshot TEXT NOT NULL,
      PRIMARY KEY (run_id, chapter_number)
    );
  `)
  database.prepare('INSERT INTO import_runs VALUES (?, ?)').run(runId, purpose)
  const content = marker.repeat(3072)
  const digest = createHash('sha256').update(content, 'utf8').digest('hex')
  const insert = database.prepare('INSERT INTO import_run_chapters VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  database.transaction(() => {
    for (const number of numbers) insert.run(runId, number, 'source', number, `Chapter ${number}`, digest, Buffer.byteLength(content), content)
  })()
  const context: CapturedImportRunContext = { database, canonicalRoot: '/fictional', projectId: 'fictional-project' }
  return { database, context, content }
}

function oldPagedSample(context: CapturedImportRunContext) {
  const chapters = []
  let afterChapterNumber = 0
  for (;;) {
    const page = ImportRunRepository.listChapterBatch(runId, { afterChapterNumber, limit: 100 }, context)
    if (!page.length) break
    chapters.push(...page)
    afterChapterNumber = page[page.length - 1]!.number
  }
  const selected = new Map([...chapters.slice(0, 3), ...chapters.slice(-2)].map(chapter => [chapter.number, chapter]))
  return { chapters, sample: [...selected.values()].sort((a, b) => a.number - b.number) }
}

describe('representative import chapter reads', () => {
  it.each([
    [[], []], [[1], [1]], [[1, 2], [1, 2]], [[1, 2, 3], [1, 2, 3]], [[1, 2, 3, 4], [1, 2, 3, 4]],
    [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5]], [[1, 2, 3, 4, 5, 6], [1, 2, 3, 5, 6]],
    [[2, 5, 8, 10, 11, 12, 50, 99, 100], [2, 5, 8, 99, 100]],
    [[-2, 0, 2, 5, 8, 10, 99, 100], [2, 5, 8, 99, 100]],
  ])('matches the old paged sample for %j', (numbers, expected) => {
    const { database, context } = fixture(numbers)
    try {
      const representative = ImportRunRepository.listRepresentativeChapters(runId, context)
      expect(representative.map(chapter => chapter.number)).toEqual(expected)
      expect(representative).toEqual(oldPagedSample(context).sample)
      expect(ImportRunRepository.listRepresentativeChapters('missing-run', context)).toEqual([])
    } finally { database.close() }
  })

  it.each([10, 100, 1000])('returns bounded content versus the old %i-chapter paged read', count => {
    const { database, context, content } = fixture(Array.from({ length: count }, (_, index) => index + 1))
    try {
      const before = oldPagedSample(context)
      const after = ImportRunRepository.listRepresentativeChapters(runId, context)
      const bytes = (chapters: typeof after) => chapters.reduce((total, chapter) => total + Buffer.byteLength(chapter.content, 'utf8'), 0)
      expect(after).toEqual(before.sample)
      expect(bytes(before.chapters)).toBe(count * Buffer.byteLength(content, 'utf8'))
      expect(bytes(after)).toBe(5 * Buffer.byteLength(content, 'utf8'))
    } finally { database.close() }
  })

  it('keeps the captured database and reference-only context boundary', () => {
    const a = fixture([1, 2, 3, 4, 5, 6], 'A')
    const b = fixture([1, 2, 3, 4, 5, 6], 'B')
    const author = fixture([1], 'C', 'author-manuscript')
    try {
      expect(ImportRunRepository.listRepresentativeChapters(runId, a.context)[0]!.content).toBe(a.content)
      expect(ImportRunRepository.listRepresentativeChapters(runId, b.context)[0]!.content).toBe(b.content)
      expect(() => ImportRunRepository.listRepresentativeChapters(runId, author.context)).toThrow('IMPORT_RUN_REFERENCE_UNBOUND')
    } finally { a.database.close(); b.database.close(); author.database.close() }
  })

  it.each([
    ['content hash', "content_snapshot = 'changed'"],
    ['byte size', 'content_size = content_size + 1'],
    ['size limit', 'content_size = 16777217'],
    ['fingerprint format', "content_fingerprint = 'invalid'"],
    ['fingerprint mismatch', `content_fingerprint = '${'b'.repeat(64)}'`],
  ])('rejects selected chapter corruption: %s', (_description, assignment) => {
    const { database, context } = fixture([1, 2, 3, 4, 5, 6])
    try {
      database.prepare(`UPDATE import_run_chapters SET ${assignment} WHERE run_id = ? AND chapter_number = 1`).run(runId)
      expect(() => ImportRunRepository.listRepresentativeChapters(runId, context)).toThrow('IMPORT_RUN_SNAPSHOT_CORRUPT')
    } finally { database.close() }
  })

  it('defers unselected chapter corruption until a paged read consumes it', () => {
    const { database, context } = fixture([1, 2, 3, 4, 5, 6])
    try {
      database.prepare("UPDATE import_run_chapters SET content_snapshot = 'changed' WHERE run_id = ? AND chapter_number = 4").run(runId)
      expect(ImportRunRepository.listRepresentativeChapters(runId, context).map(chapter => chapter.number)).toEqual([1, 2, 3, 5, 6])
      expect(() => ImportRunRepository.listChapterBatch(runId, { afterChapterNumber: 0, limit: 100 }, context))
        .toThrow('IMPORT_RUN_SNAPSHOT_CORRUPT')
    } finally { database.close() }
  })
})

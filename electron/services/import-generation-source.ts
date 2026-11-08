import type Database from 'better-sqlite3'
import { textHash } from '../repositories/generation-run-repository'
import { countDraftUnits } from '../../src/shared/draft-units'
import { createImportRunChapterBatchCheckpointId, parseImportRunChapterBatchCheckpointId } from '../../src/shared/import-run'
import type { ImportGenerationContext, ImportGenerationSlot } from '../../src/shared/import-generation'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { measurePerformanceOperation, performanceStarted, recordPerformanceComputedMetric, recordPerformanceCount, recordPerformanceDuration } from './performance-diagnostics'

export function validateImportGenerationSlot(slot: ImportGenerationSlot): void {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot) || Object.keys(slot).some(key => !['runId', 'stage', 'batchId'].includes(key))
    || typeof slot.runId !== 'string' || !slot.runId.trim() || slot.runId.length > 256
    || !['global', 'style', 'blueprints'].includes(slot.stage) || typeof slot.batchId !== 'string' || slot.batchId.length > 256
    || (slot.stage === 'blueprints' ? !parseImportRunChapterBatchCheckpointId(slot.batchId) : slot.batchId !== 'done'))
    throw new Error('GENERATION_IMPORT_SLOT_INVALID')
}
export function importGenerationSlotKey(slot: ImportGenerationSlot): string {
  validateImportGenerationSlot(slot)
  return textHash(JSON.stringify([slot.runId, slot.stage, slot.batchId]))
}

export interface TargetedImportChapterRow {
  chapter_number: number
  title: string
  content_snapshot: string
  content_fingerprint: string
}

/**
 * PERF-002: Query only the targeted chapters from SQLite, eliminating full-book scans.
 * Preserves exact chapter ordering, gaps, short books (<=5 chapters) and single-chapter boundaries.
 */
export function queryTargetedImportChapters(
  db: Database.Database,
  runId: string,
  slot: ImportGenerationSlot,
): TargetedImportChapterRow[] {
  if (slot.stage === 'blueprints') {
    const range = parseImportRunChapterBatchCheckpointId(slot.batchId)
    if (!range) throw new Error('GENERATION_IMPORT_SLOT_INVALID')
    return db.prepare(
      'SELECT chapter_number,title,content_snapshot,content_fingerprint FROM import_run_chapters WHERE run_id=? AND chapter_number>=? AND chapter_number<=? ORDER BY chapter_number ASC',
    ).all(runId, range.startChapter, range.endChapter) as TargetedImportChapterRow[]
  }

  const countRow = db.prepare('SELECT COUNT(*) as count FROM import_run_chapters WHERE run_id=?').get(runId) as { count: number } | undefined
  const totalCount = countRow?.count ?? 0
  if (totalCount === 0) return []

  if (slot.stage === 'global') {
    if (totalCount === 1) {
      return db.prepare(
        'SELECT chapter_number,title,content_snapshot,content_fingerprint FROM import_run_chapters WHERE run_id=? ORDER BY chapter_number ASC LIMIT 1',
      ).all(runId) as TargetedImportChapterRow[]
    }

    const first = db.prepare(
      'SELECT chapter_number,title,content_snapshot,content_fingerprint FROM import_run_chapters WHERE run_id=? ORDER BY chapter_number ASC LIMIT 1',
    ).get(runId) as TargetedImportChapterRow | undefined

    const last = db.prepare(
      'SELECT chapter_number,title,content_snapshot,content_fingerprint FROM import_run_chapters WHERE run_id=? ORDER BY chapter_number DESC LIMIT 1',
    ).get(runId) as TargetedImportChapterRow | undefined

    if (!first || !last) return []
    if (first.chapter_number === last.chapter_number) return [first]
    return [first, last]
  }

  if (slot.stage === 'style') {
    if (totalCount <= 5) {
      return db.prepare(
        'SELECT chapter_number,title,content_snapshot,content_fingerprint FROM import_run_chapters WHERE run_id=? ORDER BY chapter_number ASC',
      ).all(runId) as TargetedImportChapterRow[]
    }

    const firstThree = db.prepare(
      'SELECT chapter_number,title,content_snapshot,content_fingerprint FROM import_run_chapters WHERE run_id=? ORDER BY chapter_number ASC LIMIT 3',
    ).all(runId) as TargetedImportChapterRow[]

    const lastTwo = db.prepare(
      'SELECT chapter_number,title,content_snapshot,content_fingerprint FROM import_run_chapters WHERE run_id=? ORDER BY chapter_number DESC LIMIT 2',
    ).all(runId) as TargetedImportChapterRow[]

    lastTwo.reverse()
    const map = new Map<number, TargetedImportChapterRow>()
    for (const row of [...firstThree, ...lastTwo]) {
      map.set(row.chapter_number, row)
    }
    return [...map.values()].sort((a, b) => a.chapter_number - b.chapter_number)
  }

  return []
}

/** Read immutable import material from the captured database, not renderer samples. */
export function captureImportGenerationContext(db: Database.Database, slot: ImportGenerationSlot): ImportGenerationContext {
  recordPerformanceCount('source.capture.calls')
  const started = performanceStarted()
  try { return captureImportGenerationContextAuthority(db, slot) }
  catch (error) { recordPerformanceCount('source.capture.failed'); throw error }
  finally { recordPerformanceDuration('source.capture.ms', started) }
}

function captureImportGenerationContextAuthority(db: Database.Database, slot: ImportGenerationSlot): ImportGenerationContext {
  validateImportGenerationSlot(slot)
  const run = db.prepare('SELECT manifest_fingerprint,manifest_chapter_count,manifest_word_count FROM import_runs WHERE id=?').get(slot.runId) as {
    manifest_fingerprint: string; manifest_chapter_count: number; manifest_word_count: number
  } | undefined
  if (!run || !/^[a-f0-9]{64}$/.test(run.manifest_fingerprint)) throw new Error('GENERATION_IMPORT_MANIFEST_REQUIRED')
  const range = slot.stage === 'blueprints' ? parseImportRunChapterBatchCheckpointId(slot.batchId) : null
  const selected = measurePerformanceOperation('source.read.ms', () => queryTargetedImportChapters(db, slot.runId, slot))
  recordPerformanceCount('source.read.chapters', selected.length)
  recordPerformanceComputedMetric('source.read.utf8_bytes', () => selected.reduce((sum, row) => sum + Buffer.byteLength(row.content_snapshot, 'utf8'), 0))
  measurePerformanceOperation('source.select.ms', () => {
    recordPerformanceCount(`source.selected.${slot.stage}.chapters`, selected.length)
    recordPerformanceComputedMetric('source.selected.utf8_bytes', () => selected.reduce((sum, row) => sum + Buffer.byteLength(row.content_snapshot, 'utf8'), 0))
  })
  measurePerformanceOperation('source.validate.ms', () => {
    if (!selected.length || selected.some(row => textHash(row.content_snapshot) !== row.content_fingerprint)) throw new Error('GENERATION_IMPORT_CONTENT_CHANGED')
  })
  const chapters = selected.map(row => ({ number: row.chapter_number, title: row.title, content: row.content_snapshot,
    contentFingerprint: row.content_fingerprint, wordCount: countDraftUnits(row.content_snapshot) }))
  if (range && createImportRunChapterBatchCheckpointId(chapters) !== slot.batchId) throw new Error('GENERATION_IMPORT_CHECKPOINT_CHANGED')
  const core = ProjectCoreRepository.get(db)
  if (!core || Buffer.byteLength(JSON.stringify(chapters), 'utf8') > 8 * 1024 * 1024) throw new Error('GENERATION_IMPORT_CONTEXT_LIMIT')
  return { slot: { ...slot }, manifestFingerprint: run.manifest_fingerprint, totalChapters: run.manifest_chapter_count, totalWords: run.manifest_word_count, chapters, core, prompts: {} }
}

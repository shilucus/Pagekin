import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EMPTY_BOOK, inferenceReply, openAuthorImport, seedEmptyBook } from './import-infer-scenarios.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { performanceMetadata, readModelRequestSummary, startPerformanceBaseline, stopPerformanceBaseline } from './performance-baseline.mjs'

export function performanceCorpus(chapters) {
  if (![10, 100, 1000].includes(chapters)) throw new Error('PERFORMANCE_CHAPTER_COUNT_UNSUPPORTED')
  const line = '沈默在雨夜里翻看卷宗，逐一核对证人的口供。窗外的电车缓缓经过，桌上的灯光照着一封没有署名的信。'
  return Array.from({ length: chapters }, (_, index) => `第${index + 1}章 雨夜记录\n${line.repeat(20)}\n`).join('\n')
}

export function corpusSha256(corpus) { return createHash('sha256').update(corpus, 'utf8').digest('hex') }

function scenario(chapters) {
  return { performance: true, model: true, shell: 'stage', timeout: 600_000, setup: seedEmptyBook, run: async context => {
    const { app, page, roots, fake, invoke } = context
    const metadata = performanceMetadata(chapters)
    let corpusHash = null, measurements = null, requestSummary = null, started = false, importedChapters = 0, blueprintChapters = 0
    let failureStage = null, stage = 'fixture', stopFailures = 0
    const start = performance.now()
    try {
      const corpus = performanceCorpus(chapters)
      corpusHash = corpusSha256(corpus)
      const file = path.join(roots.temp, 'performance-manuscript.txt')
      fs.writeFileSync(file, corpus, 'utf8')
      fake.replyReview(inferenceReply)
      page.setDefaultTimeout(600_000)
      stage = 'runtime'
      metadata.appRuntime = await app.evaluate(() => ({ electron: process.versions.electron ?? null,
        node: process.versions.node ?? null, chrome: process.versions.chrome ?? null }))
      stage = 'probe_start'
      await startPerformanceBaseline(app, page); started = true
      stage = 'preview'
      const dialog = await openAuthorImport(app, page, EMPTY_BOOK, file)
      assert.equal(await dialog.getByRole('checkbox', { name: /同时反推设定、架构、角色和蓝图/u }).isChecked(), true)
      stage = 'import'
      await dialog.getByRole('button', { name: `确认导入（${chapters} 章）`, disabled: false }).click({ timeout: 600_000 })
      await dialog.waitFor({ state: 'hidden', timeout: 600_000 })
      stage = 'workflow'
      await runSheet.waitUntilOpen(page)
      await runSheet.waitForRunDone(page, 600_000)
      stage = 'verify'
      const session = await app.evaluate(() => globalThis.__driveOpened)
      assert.ok(session?.leaseId)
      const drafts = await invoke(page, 'db:draft-list-all', session.projectPath, session)
      const blueprints = await invoke(page, 'db:blueprint-get-all', session.projectPath, session)
      importedChapters = drafts.filter(draft => draft.status === 'finalized').length
      blueprintChapters = blueprints.length
      assert.equal(importedChapters, chapters); assert.equal(blueprintChapters, chapters)
    } catch {
      failureStage = stage
    } finally {
      try {
        if (started) {
          measurements = await stopPerformanceBaseline(app, page)
          stopFailures = measurements.stopFailures.main + measurements.stopFailures.renderer
          if (stopFailures && !failureStage) failureStage = 'probe_stop'
        }
      } catch {
        stopFailures++
        if (!failureStage) failureStage = 'probe_stop'
      } finally {
        page.setDefaultTimeout(20_000)
      }
      try { requestSummary = await readModelRequestSummary(app) } catch { requestSummary = { coverage: 'unavailable', byRoute: {} } }
      if (requestSummary?.coverage !== 'guarded_fetch_attempts' && !failureStage) failureStage = 'request_summary'
    }
    const report = { metadata, corpusSha256: corpusHash, importedChapters, blueprintChapters,
      elapsedMs: performance.now() - start, fixtureAcceptedRequests: fake.requests.length, requestSummary,
      requestEvidence: 'local_observation_not_proof_of_remote_execution',
      success: failureStage === null, attempted: 1, failed: failureStage === null ? 0 : 1, failureStage, stopFailures, measurements,
      concurrency: { 1: 'executed', 2: 'unsupported_not_executed', 4: 'unsupported_not_executed' },
      thresholds: { target100Ms: 'candidate_only', target500Ms: 'candidate_only' } }
    if (failureStage) {
      const error = new Error(`PERFORMANCE_SCENARIO_FAILED:${failureStage}`)
      error.performanceBaseline = report
      throw error
    }
    return report
  } }
}

export const PERFORMANCE_SCENARIOS = Object.fromEntries([10, 100, 1000].map(chapters => [`perf-import-${chapters}`, scenario(chapters)]))

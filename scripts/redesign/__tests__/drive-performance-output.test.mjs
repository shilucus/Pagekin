import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, it, vi } from 'vitest'
import { performanceArtifactPath, performanceError, projectPerformanceResult } from '../drive-performance-output.mjs'
import { MATERIAL_DECISION_OMISSION_REASONS } from '../../../src/shared/generation-owner-contract.ts'

vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { driveSessions, releaseSessionRoot } from '../drive.mjs'

const directories = []
function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-output-test-'))
  directories.push(directory)
  return directory
}
function frozenSelection() {
  const hash = 'a'.repeat(64)
  return {
    secret: 'draft',
    sourceRefs: { coverage: 'recorded', counts: [{ kind: 'import', count: 3, secretCount: 17 }] },
    materialDecision: { coverage: 'recorded', receipt: { version: 1, verdict: 'admitted', promptHash: hash,
      capacity: { maxInputUnits: 100, methodVersion: 'utf8-bytes-v1', admittedUnits: 20, secret: 'private-capacity' },
      coverage: { required: 1, included: 1, complete: true },
      included: [{ sourceId: 'finalized:2', revision: 3, contentHash: hash, category: 'finalized-history', required: true, units: 20,
        content: 'private-content' }],
      omitted: MATERIAL_DECISION_OMISSION_REASONS.map((reason, index) => ({ sourceId: `reference:${index}`, revision: 0,
        contentHash: hash, category: 'reference', required: false, reason, title: 'private-title' })),
      promptText: 'private-prompt' } },
    import: { coverage: 'recorded', source: { kind: 'import', manifestFingerprint: hash, totalChapters: 100, totalWords: 1000,
      selectedChapters: [1, 3, 99].map(number => ({ number, contentHash: hash, wordCount: number, title: 'private-title' })),
      checkpointRange: { startChapter: 1, endChapter: 100, secretCount: 7 }, path: 'private-path' } },
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

it('requires lexical and real containment for Windows, UNC and prefix traps', () => {
  const options = { pathApi: path.win32, contained: () => true }
  const out = 'C:\\Users\\alice\\out'
  assert.equal(performanceArtifactPath('C:\\Users\\alice\\out\\shot.png', out, options), 'shot.png')
  for (const value of ['C:\\Users\\alice\\outside\\shot.png', 'D:\\out\\shot.png',
    '\\\\server\\share\\shot.png', 'C:\\Users\\alice\\out\\..\\private.png']) {
    const projected = performanceArtifactPath(value, out, options)
    assert.match(projected, /^opaque:[a-f0-9]{64}$/)
    assert.equal(projected.includes('alice'), false)
  }
  assert.equal(performanceArtifactPath('\\\\server\\share\\out\\shot.png', '\\\\server\\share\\out', options), 'shot.png')
  assert.match(performanceArtifactPath('C:\\Users\\alice\\out\\linked.png', out,
    { ...options, contained: () => false }), /^opaque:/)
  assert.match(performanceArtifactPath('C:\\Users\\alice\\out\\linked.png', out,
    { ...options, contained: () => { throw new Error('private path') } }), /^opaque:/)
})

it('projects exception and external evidence without changing input or dropping denominators', () => {
  const raw = { scenario: 'perf-import-10', error: 'Error: C:\\Users\\alice\\secret',
    isolationRoot: 'C:\\Users\\alice\\scratch', externalWrites: ['D:\\Users\\alice\\a', 'D:\\Users\\alice\\b'],
    externalWritesIgnored: ['\\\\server\\share\\cache'], measured: { attempted: 2, failed: 1 }, residualProcesses: [] }
  const before = structuredClone(raw)
  const projected = projectPerformanceResult(raw, 'C:\\Users\\alice\\out', { pathApi: path.win32, contained: () => true })
  assert.deepEqual(raw, before)
  assert.equal(projected.error, 'PERFORMANCE_FAILURE:Error:UNCLASSIFIED_ERROR')
  assert.equal(projected.externalWrites.length, 2)
  assert.equal(projected.externalWritesIgnored.length, 1)
  assert.deepEqual(projected.measured, { attempted: 2, failed: 1 })
  assert.equal(JSON.stringify(projected).includes('alice'), false)
  assert.equal(performanceError(Object.assign(new Error('private'), { code: 'EACCES' })), 'PERFORMANCE_FAILURE:Error:EACCES')
})

it('preserves bounded receipt hashes, statuses, coverage and attempt totals', () => {
  const hash = 'a'.repeat(64)
  const result = projectPerformanceResult({ measured: { diagnostics: { generation: {
    coverage: 'partial', observed: 2, retained: 1, runs: [{ runId: 'private-run-id', status: 'failed',
      source: { modelIdHash: hash, fingerprint: { modelLeaseRevision: hash, dependencyHash: hash } },
      initialDraftTaskHash: hash, parametersCoverage: 'not_recorded',
      attempts: { observed: 3, retained: 1, items: [{ attemptId: 'private-attempt-id', status: 'settled',
        failureCode: 'GENERATION_PROVIDER_FAILED', transport: { phase: 'stream', errorCode: 'ETIMEDOUT' } }] } }],
  } } } }, '/out')
  const run = result.measured.diagnostics.generation.runs[0]
  assert.equal(result.measured.diagnostics.generation.coverage, 'partial')
  assert.equal(run.source.modelIdHash, hash)
  assert.equal(run.source.fingerprint.modelLeaseRevision, hash)
  assert.equal(run.initialDraftTaskHash, hash)
  assert.equal(run.parametersCoverage, 'not_recorded')
  assert.equal(run.status, 'failed')
  assert.equal(run.attempts.observed, 3)
  assert.equal(run.attempts.items[0].transport.phase, 'stream')
  assert.equal(run.attempts.items[0].failureCode, 'GENERATION_PROVIDER_FAILED')
  assert.match(run.runId, /^opaque:/)
  assert.match(run.attempts.items[0].attemptId, /^opaque:/)
})

it('projects only frozen selection fields at the final export boundary', () => {
  const raw = { measured: { attempted: 2, failed: 1, diagnostics: { generation: { runs: [{ selection: frozenSelection() }] } } } }
  const before = structuredClone(raw)
  const result = projectPerformanceResult(raw, '/out')
  const selection = result.measured.diagnostics.generation.runs[0].selection
  assert.deepEqual(raw, before)
  assert.deepEqual(selection.sourceRefs, { coverage: 'recorded', counts: [{ kind: 'import', count: 3 }] })
  assert.deepEqual(selection.materialDecision.receipt.included[0], { sourceId: 'finalized:2', revision: 3,
    contentHash: 'a'.repeat(64), category: 'finalized-history', required: true, units: 20 })
  assert.deepEqual(selection.materialDecision.receipt.omitted.map(item => item.reason), MATERIAL_DECISION_OMISSION_REASONS)
  assert.deepEqual(selection.materialDecision.receipt.omitted.map(item => item.sourceId),
    MATERIAL_DECISION_OMISSION_REASONS.map((_, index) => `reference:${index}`))
  assert.deepEqual(selection.import.source, { kind: 'import', manifestFingerprint: 'a'.repeat(64), totalChapters: 100, totalWords: 1000,
    selectedChapters: [1, 3, 99].map(number => ({ number, contentHash: 'a'.repeat(64), wordCount: number })),
    checkpointRange: { startChapter: 1, endChapter: 100 } })
  assert.deepEqual(Object.keys(selection), ['sourceRefs', 'materialDecision', 'import'])
  assert.equal(JSON.stringify(selection).includes('private-'), false)
  assert.equal(JSON.stringify(selection).includes('secret'), false)
  assert.equal(JSON.stringify(selection).includes('promptText'), false)
  assert.equal(result.measured.attempted, 2)
  assert.equal(result.measured.failed, 1)
})

it('contains unknown source IDs and reasons in the final export even without the consumer', () => {
  const selection = frozenSelection()
  Object.assign(selection.materialDecision.receipt.omitted[0], { sourceId: 'reference:private-source', reason: 'private-reason' })
  Object.assign(selection.sourceRefs.counts[0], { kind: 'private-kind' })
  const result = projectPerformanceResult({ selection }, '/out').selection
  const item = result.materialDecision.receipt.omitted[0]
  assert.match(item.sourceId, /^opaque:[a-f0-9]{64}$/)
  assert.equal(item.reason, null)
  assert.equal(result.sourceRefs.counts[0].kind, 'unknown')
  assert.equal(JSON.stringify(result).includes('private-'), false)
  assert.deepEqual(projectPerformanceResult({ selection: result }, '/out').selection, result)
})

it('writes the same projection to stdout and JSON while passing real paths to session cleanup', async () => {
  const out = temporaryDirectory(), root = path.join(out, 'isolated')
  fs.mkdirSync(root)
  const artifact = path.join(out, 'perf-import-10-light.png')
  const lines = []
  vi.spyOn(process.stdout, 'write').mockImplementation(value => { lines.push(String(value)); return true })
  const code = await driveSessions({ sessions: [['perf-import-10', ['perf-import-10']]],
    options: { out, scenario: 'perf-import-10', theme: 'light' }, realKey: null, makeRoots: () => ({ root }),
    run: async (_name, _names, _options, _key, roots) => {
      assert.equal(roots.root, root)
      fs.writeFileSync(artifact, 'image')
      const errors = []
      releaseSessionRoot(roots.root, true, errors)
      assert.deepEqual(errors, [])
      return [{ scenario: 'perf-import-10', isolationRoot: roots.root, screenshot: artifact,
        externalWrites: [], externalWritesIgnored: [], residualProcesses: [], measured: { diagnostics: { generation: {
          scope: 'isolated_project', coverage: 'partial', observed: 2, retained: 2, runs: [{ runId: 'linked-run', status: 'failed', operation: 'finalized-chapter-notes',
            selection: frozenSelection(),
            source: { fingerprint: { skillSnapshotHash: 'b'.repeat(64) } }, initialDraftTaskHash: 'c'.repeat(64),
            parametersCoverage: 'not_recorded', importSlot: { runId: 'linked-run', stage: 'global' },
            attempts: { observed: 5, retained: 5, items: ['HTTP_ERROR', 'RESPONSE_BODY_MISSING', 'PROVIDER_STREAM_ERROR', 'STREAM_INVALID', 'STREAM_INCOMPLETE']
              .map(errorCode => ({ status: 'settled', purpose: 'chapter-draft-short-outline', transport: { phase: 'stream', errorCode } })) } },
          { status: 'completed', operation: 'finalized-character-state', finalizationSlot: { stepKey: 'character_cards' } }],
        } } } }]
    },
  })
  const report = JSON.parse(fs.readFileSync(path.join(out, 'perf-import-10-light.json'), 'utf8'))
  assert.equal(code, 0)
  assert.equal(fs.existsSync(root), false)
  assert.deepEqual(JSON.parse(lines[0]), report[0])
  assert.equal(report[0].screenshot, 'perf-import-10-light.png')
  assert.match(report[0].isolationRoot, /^opaque:/)
  assert.equal(lines[0].includes(root), false)
  const generation = report[0].measured.diagnostics.generation
  const run = generation.runs[0]
  assert.equal(generation.scope, 'isolated_project')
  assert.equal(generation.coverage, 'partial')
  assert.equal(run.status, 'failed')
  assert.equal(run.operation, 'finalized-chapter-notes')
  assert.equal(generation.runs[1].operation, 'finalized-character-state')
  assert.equal(generation.runs[1].finalizationSlot.stepKey, 'character_cards')
  assert.equal(run.parametersCoverage, 'not_recorded')
  assert.deepEqual(run.selection.sourceRefs, { coverage: 'recorded', counts: [{ kind: 'import', count: 3 }] })
  assert.deepEqual(run.selection.import.source.selectedChapters.map(item => item.number), [1, 3, 99])
  assert.deepEqual(run.selection.materialDecision.receipt.omitted.map(item => item.reason), MATERIAL_DECISION_OMISSION_REASONS)
  assert.equal(JSON.stringify(run.selection).includes('private-'), false)
  assert.equal(JSON.stringify(run.selection).includes('secret'), false)
  assert.equal(run.importSlot.stage, 'global')
  assert.equal(run.attempts.items[0].purpose, 'chapter-draft-short-outline')
  assert.deepEqual(run.attempts.items.map(item => item.transport.errorCode),
    ['HTTP_ERROR', 'RESPONSE_BODY_MISSING', 'PROVIDER_STREAM_ERROR', 'STREAM_INVALID', 'STREAM_INCOMPLETE'])
  assert.equal(run.source.fingerprint.skillSnapshotHash, 'b'.repeat(64))
  assert.equal(run.initialDraftTaskHash, 'c'.repeat(64))
  assert.match(run.runId, /^opaque:/)
  assert.equal(run.runId, run.importSlot.runId)
})

it('keeps an outer session failure visible without exporting its message or path', async () => {
  const out = temporaryDirectory()
  const lines = []
  vi.spyOn(process.stdout, 'write').mockImplementation(value => { lines.push(String(value)); return true })
  const code = await driveSessions({ sessions: [['perf-import-10', ['perf-import-10']]],
    options: { out, scenario: 'perf-import-10', theme: 'light' }, realKey: null,
    makeRoots: () => { throw Object.assign(new Error('C:\\Users\\alice\\private'), { code: 'EACCES' }) },
  })
  const report = JSON.parse(fs.readFileSync(path.join(out, 'perf-import-10-light.json'), 'utf8'))
  assert.equal(code, 1)
  assert.equal(report[0].error, 'PERFORMANCE_FAILURE:Error:EACCES')
  assert.deepEqual(JSON.parse(lines[0]), report[0])
  assert.equal(lines[0].includes('alice'), false)
})

it('scans the actual retained isolation directory for secrets before projecting paths', async () => {
  const out = temporaryDirectory(), root = temporaryDirectory()
  const secretFile = path.join(root, 'sensitive.txt')
  const lines = []
  vi.spyOn(process.stdout, 'write').mockImplementation(value => { lines.push(String(value)); return true })
  const code = await driveSessions({ sessions: [['perf-import-10', ['perf-import-10']]],
    options: { out, scenario: 'perf-import-10', theme: 'light' }, realKey: 'fixture-secret', makeRoots: () => ({ root }),
    run: async () => {
      fs.writeFileSync(secretFile, 'fixture-secret')
      return [{ scenario: 'perf-import-10', isolationRoot: root, externalWrites: [], residualProcesses: [] }]
    },
  })
  const report = JSON.parse(fs.readFileSync(path.join(out, 'perf-import-10-light.json'), 'utf8'))
  assert.equal(code, 1)
  assert.equal(fs.existsSync(secretFile), false)
  assert.equal(report[0].keyScan.hits.length, 1)
  assert.match(report[0].keyScan.hits[0], /^opaque:/)
  assert.deepEqual(JSON.parse(lines[0]), report[0])
  assert.equal(lines[0].includes('fixture-secret'), false)
  assert.equal(lines[0].includes(root), false)
})

import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelPerformanceImport, corpusSha256, performanceCorpus, PERFORMANCE_SCENARIOS, runPerformanceImportScenario } from '../performance-scenarios.mjs'
import { appendPerformanceFailureDiagnostic, assertPerformanceProbeCoverage, performanceMetadata, readModelRequestSummary, readPerformanceRunDiagnostics, startPerformanceBaseline, stopPerformanceBaseline, summarizeFixtureChats } from '../performance-baseline.mjs'

const collectorKey = Symbol.for('pagekin.performance-baseline')
beforeEach(() => { globalThis[collectorKey] = () => ({ schemaVersion: 1, quantiles: 'fixed-histogram-upper-bounds', metrics: { 'source.capture.calls': { count: 1 } } }) })
afterEach(() => { delete globalThis[collectorKey]; vi.restoreAllMocks(); vi.useRealTimers() })

describe('performance baseline contract', () => {
  it('projects frozen selection fields without reconstructing chapters or retaining extra source data', async () => {
    const hash = 'a'.repeat(64), handle = { runId: 'g' }
    const selection = {
      sourceRefs: { coverage: 'recorded', counts: [{ kind: 'import', count: 5, secret: 'private-ref' }] },
      materialDecision: { coverage: 'recorded', receipt: { version: 1, verdict: 'admitted', promptHash: hash,
        capacity: { maxInputUnits: 100, methodVersion: 'utf8-bytes-v1', admittedUnits: 20, secret: 'private-capacity' },
        coverage: { required: 1, included: 1, complete: true },
        included: [{ sourceId: 'finalized:2', revision: 3, contentHash: hash, category: 'finalized-history', required: true, units: 20, text: 'private-text' }],
        omitted: [{ sourceId: 'private-id', revision: 0, contentHash: hash, category: 'reference', required: false, reason: 'budget', text: 'private-omission' }],
        private: 'private-receipt' } },
      import: { coverage: 'recorded', source: { kind: 'import', manifestFingerprint: hash, totalChapters: 100, totalWords: 1000,
        selectedChapters: [1, 3, 99].map(number => ({ number, contentHash: hash, wordCount: number, content: 'private-content' })),
        checkpointRange: { startChapter: 1, endChapter: 100, extra: 'private-range' }, path: 'private-path' } },
    }
    const invoke = vi.fn(async (_page, channel) => channel === 'generation:list' ? [{ handle }]
      : { schemaVersion: 1, handle, attempts: [], selection })
    const result = await readPerformanceRunDiagnostics({ page: {}, invoke }, { leaseId: 'lease' }, true)
    const projected = result.generation.runs[0].selection
    expect(projected.import.source.selectedChapters.map(chapter => chapter.number)).toEqual([1, 3, 99])
    expect(projected.import.source).toMatchObject({ totalChapters: 100, checkpointRange: { startChapter: 1, endChapter: 100 } })
    expect(projected.sourceRefs.counts).toEqual([{ kind: 'import', count: 5 }])
    expect(projected.materialDecision.receipt.included[0]).toEqual({ sourceId: 'finalized:2', revision: 3,
      contentHash: hash, category: 'finalized-history', required: true, units: 20 })
    expect(projected.materialDecision.receipt.omitted[0]).toMatchObject({ reason: 'budget', category: 'reference' })
    expect(projected.materialDecision.receipt.omitted[0].sourceId).toMatch(/^opaque:[a-f0-9]{64}$/u)
    expect(JSON.stringify(projected)).not.toContain('private-')
    expect(invoke.mock.calls.map(call => call[1])).toEqual(['generation:list', 'generation:read-diagnostics'])
  })

  it.each([
    { sourceRefs: { coverage: 'recorded', counts: null }, materialDecision: { coverage: 'recorded', receipt: null },
      import: { coverage: 'recorded', source: null } },
    { sourceRefs: { coverage: 'not_recorded', counts: [{ kind: 'import', count: 5 }] },
      materialDecision: { coverage: 'not_recorded', receipt: { version: 1 } },
      import: { coverage: 'not_recorded', source: { kind: 'import' } } },
  ])('does not turn absent or explicitly unrecorded payloads into selection evidence', async selection => {
    const handle = { runId: 'g' }
    const invoke = vi.fn(async (_page, channel) => channel === 'generation:list' ? [{ handle }]
      : { schemaVersion: 1, handle, attempts: [], selection })
    const result = await readPerformanceRunDiagnostics({ page: {}, invoke }, { leaseId: 'lease' }, true)
    expect(result.generation.runs[0].selection).toEqual({
      sourceRefs: { coverage: 'not_recorded', counts: null },
      materialDecision: { coverage: 'not_recorded', receipt: null },
      import: { coverage: 'not_recorded', source: null },
    })
    expect(result.generation).toMatchObject({ coverage: 'observed', observed: 1, retained: 1 })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('contains poisoned selection metadata at the diagnostic consumer without adding source reads', async () => {
    const handle = { runId: 'g' }
    const item = { sourceId: 'reference:private-id', revision: -1, contentHash: 'private-hash',
      category: 'private-category', required: 'private-required', units: Infinity, reason: 'private-reason', content: 'private-content' }
    const selection = {
      private: 'private-selection',
      sourceRefs: { coverage: 'recorded', counts: [{ kind: 'private-kind', count: 'private-count' }, null] },
      materialDecision: { coverage: 'recorded', receipt: { version: 2, verdict: 'private-verdict', promptHash: 'private-prompt',
        capacity: { maxInputUnits: -1, methodVersion: 'private-method', admittedUnits: Infinity },
        coverage: { required: -1, included: 'private-count', complete: 'private-boolean' }, included: [item], omitted: [item] } },
      import: { coverage: 'recorded', source: { kind: 'private-kind', manifestFingerprint: 'private-hash',
        totalChapters: Number.MAX_SAFE_INTEGER + 1, totalWords: -1, selectedChapters: [null,
          { number: 'private-number', contentHash: 'private-hash', wordCount: NaN, title: 'private-title' }],
        checkpointRange: 'private-range', path: 'private-path' } },
    }
    const invoke = vi.fn(async (_page, channel) => channel === 'generation:list' ? [{ handle }]
      : { schemaVersion: 1, handle, attempts: [], selection })
    const result = await readPerformanceRunDiagnostics({ page: {}, invoke }, { leaseId: 'lease' }, true)
    const projected = result.generation.runs[0].selection
    expect(projected.sourceRefs.counts).toEqual([{ kind: 'unknown', count: null }, { kind: 'unknown', count: null }])
    expect(projected.materialDecision.receipt).toMatchObject({ version: null, verdict: null, promptHash: null,
      capacity: { maxInputUnits: null, methodVersion: null, admittedUnits: null },
      coverage: { required: null, included: null, complete: null } })
    expect(projected.materialDecision.receipt.included[0]).toEqual({ sourceId: expect.stringMatching(/^opaque:[a-f0-9]{64}$/u),
      revision: null, contentHash: null, category: null, required: null, units: null })
    expect(projected.materialDecision.receipt.omitted[0].reason).toBeNull()
    expect(projected.import.source).toEqual({ kind: null, manifestFingerprint: null, totalChapters: null, totalWords: null,
      selectedChapters: [{ number: null, contentHash: null, wordCount: null }, { number: null, contentHash: null, wordCount: null }],
      checkpointRange: null })
    expect(JSON.stringify(projected)).not.toContain('private-')
    expect(invoke.mock.calls.map(call => call[1])).toEqual(['generation:list', 'generation:read-diagnostics'])
  })

  it('reads bounded safe receipts and actual import slots after the probe boundary', async () => {
    const session = { leaseId: 'private-lease', projectPath: 'private-path' }
    const handle = { runId: 'generation-1', rootActionId: 'root-1' }
    const diagnostic = { schemaVersion: 1, handle, operation: 'import', status: 'completed',
      source: { modelIdHash: 'model-hash', modelReceiptHash: 'receipt-hash', fingerprint: { skillSnapshotHash: 'skill-hash', private: 'private-fingerprint' } },
      importSlot: { runId: 'import-1', stage: 'blueprints', batchId: 'batch-1' }, finalizationSlot: null,
      parametersCoverage: 'not_recorded', initialDraftTaskHash: null,
      attempts: Array.from({ length: 33 }, (_, i) => ({ attemptId: `attempt-${i}`, status: 'settled', purpose: 'import',
        requestedOutputTokens: 20, actual: { total: 12, private: 'private-usage' }, transport: { visibleEvents: 1, private: 'private-transport' } })) }
    const invoke = vi.fn(async (_page, channel, argument) => {
      if (channel === 'generation:list') return Array.from({ length: 33 }, () => ({ handle }))
      if (channel === 'generation:read-diagnostics') return diagnostic
      if (channel === 'db:import-run-get') return { id: argument, rootRunId: 'root-1', stage: 'blueprints', status: 'running',
        completedBatches: { blueprints: ['private-checkpoint'] }, sourceDisplay: 'private-source', lastError: 'private-error' }
      throw new Error('unexpected')
    })
    const result = await readPerformanceRunDiagnostics({ page: {}, invoke }, session, true)
    expect(result).toMatchObject({ sampleBoundary: 'after_probe_stop_attempt',
      generation: { coverage: 'partial', observed: 33, retained: 32, cutoff: true },
      importRun: { coverage: 'partial', observed: 1, retained: 1, runs: [{ id: 'import-1', checkpointCounts: { blueprints: 1 } }] } })
    expect(result.generation.runs[0]).toMatchObject({ source: { fingerprint: { skillSnapshotHash: 'skill-hash' } }, attempts: { observed: 33, retained: 32 } })
    expect(invoke).toHaveBeenCalledWith(expect.anything(), 'db:import-run-get', 'import-1', 'private-path', session)
    expect(JSON.stringify(result)).not.toMatch(/private-/u)
    expect(result.sampleEndedAt).toBeGreaterThanOrEqual(result.sampleStartedAt)
    const parameters = summarizeFixtureChats(Array.from({ length: 33 }, () => ({ maxTokens: 42, temperature: 0, messages: 'private-prompt' })))
    expect(parameters).toMatchObject({ observed: 33, retained: 32 })
    expect(parameters.items[0]).toEqual({ model: null, maxTokens: 42, temperature: 0 })
    expect(JSON.stringify(parameters)).not.toContain('private-prompt')
  })

  it('distinguishes unentered, unreadable and missing checkpoint observations', async () => {
    const context = { page: {}, invoke: vi.fn() }
    expect((await readPerformanceRunDiagnostics(context, null, false)).generation.coverage).toBe('not_entered')
    expect((await readPerformanceRunDiagnostics(context, null, true)).generation.coverage).toBe('unavailable')
    context.invoke.mockImplementation(async (_page, channel) => {
      if (channel === 'generation:list') return [{ handle: { runId: 'g' } }]
      if (channel === 'generation:read-diagnostics') return { schemaVersion: 1, handle: { runId: 'g' },
        importSlot: { runId: 'i' }, attempts: [] }
      return { id: 'i' }
    })
    const result = await readPerformanceRunDiagnostics(context, { leaseId: 'l' }, true)
    expect(result.importRun.runs[0].checkpointCounts).toBeNull()
    expect(result.generation.runs[0].selection).toEqual({
      sourceRefs: { coverage: 'not_recorded', counts: null },
      materialDecision: { coverage: 'not_recorded', receipt: null },
      import: { coverage: 'not_recorded', source: null },
    })
    context.invoke.mockRejectedValue(new Error('private-error'))
    expect((await readPerformanceRunDiagnostics(context, { leaseId: 'l' }, true)).generation.coverage).toBe('unavailable')
  })

  it('retains the prepared import during author postprocessing even if generation listing fails', async () => {
    const invoke = vi.fn(async (_page, channel, id) => {
      if (channel === 'db:import-run-get') return { id, rootRunId: 'root-1', stage: 'author-postprocess', status: 'running',
        completedBatches: { 'author-postprocess': ['a', 'b'] }, sourceDisplay: 'private-source' }
      throw new Error('private-error')
    })
    const result = await readPerformanceRunDiagnostics({ page: {}, invoke }, { leaseId: 'lease', projectPath: 'path' }, true, 'prepared-id')
    expect(result.generation.coverage).toBe('unavailable')
    expect(result.importRun).toMatchObject({ coverage: 'observed', observed: 1, retained: 1,
      runs: [{ id: 'prepared-id', stage: 'author-postprocess', checkpointCounts: { 'author-postprocess': 2 } }] })
    expect(JSON.stringify(result)).not.toMatch(/private-|lease|path/u)
  })

  it('bounds the entire diagnostic read and reports the unretained denominator', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn(async (_page, channel) => channel === 'generation:list'
      ? Array.from({ length: 33 }, (_, i) => ({ handle: { runId: `run-${i}` } })) : new Promise(() => {}))
    const pending = readPerformanceRunDiagnostics({ page: {}, invoke }, { leaseId: 'lease' }, true)
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending
    expect(result.generation).toMatchObject({ observed: 33, retained: 2, cutoff: true, coverage: 'partial' })
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(result.generation.omitted).toBe(31)
  })

  it('samples actual operation heads, tails and failures without losing the lightweight denominator', async () => {
    const runs = Array.from({ length: 60 }, (_, index) => ({ handle: { runId: `g-${index}` },
      operation: index < 40 ? 'finalized-character-state' : index < 58 ? 'import-blueprints' : 'analyze-writing-style',
      status: index === 16 ? 'failed' : 'completed' }))
    runs.push({ handle: { runId: 'private-operation-run' }, operation: 'private-operation', status: 'completed' })
    const invoke = vi.fn(async (_page, channel, argument) => {
      if (channel === 'generation:list') return runs
      const run = runs.find(item => item.handle.runId === argument.handle.runId)
      return { schemaVersion: 1, handle: run.handle, operation: run.operation, status: run.status,
        parametersCoverage: 'not_recorded', attempts: Array.from({ length: 34 }, () => ({ status: 'unknown' })) }
    })
    const result = await readPerformanceRunDiagnostics({ page: {}, invoke }, { leaseId: 'lease' }, true)
    const sampled = invoke.mock.calls.filter(call => call[1] === 'generation:read-diagnostics')
      .map(call => call[2].handle.runId)
    expect(sampled).toHaveLength(32)
    expect(new Set(sampled).size).toBe(32)
    expect(sampled).toEqual(expect.arrayContaining(['g-0', 'g-39', 'g-16', 'g-40', 'g-57', 'g-58', 'g-59']))
    expect(result.generation).toMatchObject({ observed: 61, retained: 32, omitted: 29,
      samplingRule: 'operation-head-tail-failed-v1', cutoff: true, coverage: 'partial',
      operationCounts: [{ operation: 'import-blueprints', count: 18 }, { operation: 'analyze-writing-style', count: 2 },
        { operation: 'finalized-character-state', count: 40 }, { operation: 'unknown', count: 1 }] })
    expect(result.generation.runs.every(run => run.attempts.observed === 34
      && run.attempts.retained === 32 && run.attempts.omitted === 2)).toBe(true)
    expect(result.generation.runs.find(run => run.runId === 'private-operation-run').operation).toBe('unknown')
    expect(JSON.stringify(result.generation.operationCounts)).not.toContain('private-operation')
    expect(invoke.mock.calls.every(call => ['generation:list', 'generation:read-diagnostics'].includes(call[1]))).toBe(true)
  })

  it('keeps complete parameter group counts with bounded groups, representatives and explicit overflow', () => {
    const chats = Array.from({ length: 40 }, (_, maxTokens) => ({ model: 'gpt-4.1', maxTokens, temperature: 0,
      messages: 'private-prompt', apiKey: 'private-key' }))
    chats.push({ model: 'gpt-4.1', maxTokens: 0, temperature: 0 }, { model: 'gpt-4.1', maxTokens: 0, temperature: 0 })
    const result = summarizeFixtureChats(chats)
    expect(result).toMatchObject({ coverage: 'observed_http_requests', observed: 42, retained: 32, omitted: 10,
      groupLimit: 32, grouped: 34, overflow: 8 })
    expect(result.groups).toHaveLength(32)
    expect(result.groups[0]).toEqual({ model: 'gpt-4.1', maxTokens: 0, temperature: 0, count: 3 })
    expect(result.groups.reduce((sum, group) => sum + group.count, 0) + result.overflow).toBe(result.observed)
    expect(result.items.at(-1)).toEqual({ model: 'gpt-4.1', maxTokens: 0, temperature: 0 })
    expect(JSON.stringify(result)).not.toMatch(/private-|messages|apiKey/u)
  })

  it('distinguishes missing, empty, invalid and zero parameters without exposing private model names', () => {
    expect(summarizeFixtureChats(null)).toEqual({ coverage: 'unavailable', observed: null, retained: 0,
      omitted: null, groupLimit: 32, grouped: null, overflow: null, groups: [], items: [] })
    expect(summarizeFixtureChats([])).toMatchObject({ observed: 0, retained: 0, omitted: 0, grouped: 0, overflow: 0 })
    const result = summarizeFixtureChats([null, { model: 'private-model', maxTokens: -1, temperature: NaN },
      { model: 'opaque:' + 'a'.repeat(64), maxTokens: 0, temperature: 0 }, {}])
    expect(result.items[0]).toEqual({ model: null, maxTokens: null, temperature: null })
    expect(result.items[1]).toEqual({ model: expect.stringMatching(/^opaque:[a-f0-9]{64}$/u), maxTokens: null, temperature: null })
    expect(result.items[2]).toEqual({ model: 'opaque:' + 'a'.repeat(64), maxTokens: 0, temperature: 0 })
    expect(result.groups[0]).toEqual({ model: null, maxTokens: null, temperature: null, count: 2 })
    expect(result.grouped).toBe(4)
    expect(JSON.stringify(result)).not.toContain('private-model')
  })
  it('exposes three isolated single-book scenarios and deterministic synthetic corpora', () => {
    expect(Object.keys(PERFORMANCE_SCENARIOS)).toEqual(['perf-import-10', 'perf-import-100', 'perf-import-1000'])
    for (const count of [10, 100, 1000]) {
      const corpus = performanceCorpus(count)
      expect(corpus.match(/^第\d+章 /gm)).toHaveLength(count)
      expect(Buffer.byteLength(corpus, 'utf8') / count).toBeGreaterThan(2820)
      expect(Buffer.byteLength(corpus, 'utf8') / count).toBeLessThan(2900)
      expect(corpusSha256(corpus)).toEqual(corpusSha256(performanceCorpus(count)))
      expect(PERFORMANCE_SCENARIOS[`perf-import-${count}`]).toMatchObject({ performance: true, model: true, shell: 'stage', timeout: 600_000 })
    }
    expect(() => performanceCorpus(4)).toThrow('PERFORMANCE_CHAPTER_COUNT_UNSUPPORTED')
  })

  it('does not put arbitrary source identifiers into metadata', () => {
    expect(performanceMetadata(10, 'secret/path').sourceSha).toBeNull()
    expect(performanceMetadata(10, 'a'.repeat(40)).sourceSha).toBe('a'.repeat(40))
    expect(performanceMetadata(10, undefined)).not.toHaveProperty('path')
  })

  it('summarizes only allowed request routes without returning raw entries', async () => {
    const previous = globalThis.__driveModelRequests
    try {
      globalThis.__driveModelRequests = [
        { path: '/v1/messages', status: 429, ms: 14, secret: 'private content' },
        { path: '/v1/messages', status: 'error', ms: 5 },
        { path: '/secret/path', status: 500, ms: 6 },
      ]
      const result = await readModelRequestSummary({ evaluate: async callback => callback() })
      expect(result.coverage).toBe('guarded_fetch_attempts')
      expect(result.byRoute['/v1/messages']).toEqual({ count: 2, failed: 2, http429: 1, totalMs: 19, maxMs: 14 })
      expect(JSON.stringify(result)).not.toContain('private content')
      expect(JSON.stringify(result)).not.toContain('/secret/path')
    } finally {
      if (previous === undefined) delete globalThis.__driveModelRequests
      else globalThis.__driveModelRequests = previous
    }
  })

  it('marks a missing request log unavailable', async () => {
    const previous = globalThis.__driveModelRequests
    try {
      delete globalThis.__driveModelRequests
      const result = await readModelRequestSummary({ evaluate: async callback => callback() })
      expect(result.coverage).toBe('unavailable')
    } finally {
      if (previous !== undefined) globalThis.__driveModelRequests = previous
    }
  })

  it('cleans up an actual main probe when renderer startup fails', async () => {
    vi.useFakeTimers()
    const key = Symbol.for('pagekin.performance-baseline.probe')
    expect(globalThis[key]).toBeUndefined()
    let histogram
    const app = { evaluate: async callback => {
      const result = callback()
      if (globalThis[key]) histogram = globalThis[key].histogram
      return result
    } }
    const page = { evaluate: async () => { throw new Error('private content') } }
    await expect(startPerformanceBaseline(app, page)).rejects.toThrow('PERFORMANCE_RENDERER_PROBE_START_FAILED')
    expect(histogram).toBeDefined()
    expect(globalThis[key]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('limits renderer metrics and stops actual probes', async () => {
    vi.useFakeTimers()
    const mainKey = Symbol.for('pagekin.performance-baseline.probe')
    const rendererKey = Symbol.for('pagekin.performance-baseline.renderer')
    expect(globalThis[mainKey]).toBeUndefined()
    expect(globalThis[rendererKey]).toBeUndefined()
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    const disable = vi.spyOn(globalThis[mainKey].histogram, 'disable')
    const renderer = globalThis[rendererKey]
    renderer.record('renderer.snapshot.calls', 2)
    for (const value of [-1, NaN, Infinity, '1']) renderer.record('renderer.snapshot.calls', value)
    renderer.record('untrusted.prompt', 100)
    const result = await stopPerformanceBaseline(app, page)
    expect(result.renderer.metrics).toEqual({ 'renderer.snapshot.calls': {
      count: 1, sum: 2, min: 2, max: 2, p50UpperBound: 2, p95UpperBound: 2,
    } })
    expect(result.stopFailures).toEqual({ main: 0, renderer: 0 })
    expect(disable).toHaveBeenCalledOnce()
    expect(globalThis[mainKey]).toBeUndefined()
    expect(globalThis[rendererKey]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([{ user: 0, system: 0 }, { user: 37, system: 13 }])('records actual window CPU deltas including measured zero: %j', async delta => {
    vi.useFakeTimers()
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const start = { user: 100, system: 50 }
    const cpuUsage = vi.spyOn(process, 'cpuUsage').mockReturnValue(delta).mockReturnValueOnce(start)
    vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 200 }).mockReturnValueOnce({ rss: 100 }).mockReturnValueOnce({ rss: 300 })
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    now = 350
    await vi.advanceTimersByTimeAsync(250)
    const result = await stopPerformanceBaseline(app, page)
    expect(cpuUsage).toHaveBeenCalledTimes(2)
    expect(cpuUsage).toHaveBeenNthCalledWith(1)
    expect(cpuUsage).toHaveBeenNthCalledWith(2, start)
    expect(result.main.cpu).toEqual({ userUs: delta.user, systemUs: delta.system, windowMs: 250 })
    expect(result.coverage.cpu).toBe('observed')
    expect(result.main.memory).toEqual({ rssStart: 100, rssEnd: 200, rssIntervalMs: 250, rssMax: 300, rssSamples: 3 })
    expect(result.stopFailures).toEqual({ main: 0, renderer: 0 })
    expect(globalThis[Symbol.for('pagekin.performance-baseline.probe')]).toBeUndefined()
    expect(globalThis[Symbol.for('pagekin.performance-baseline.renderer')]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, -1, NaN, Infinity])('exports only a finite nonnegative CPU probe window: %s', async windowMs => {
    vi.useFakeTimers()
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(process, 'cpuUsage').mockReturnValue({ user: 0, system: 0 })
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    now += windowMs
    const result = await stopPerformanceBaseline(app, page)
    expect(result.main.cpu).toEqual(windowMs === 0 ? { userUs: 0, systemUs: 0, windowMs: 0 } : null)
    expect(result.coverage.cpu).toBe(windowMs === 0 ? 'observed' : 'unavailable')
    expect(result.stopFailures).toEqual({ main: 0, renderer: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { start: undefined, end: { user: 0, system: 0 } },
    { start: { user: 10, system: 20 }, end: undefined },
    { start: { user: 10, system: 20 }, end: { user: -1, system: 0 } },
  ])('keeps absent or invalid CPU unavailable rather than substituting zero: %j', async usage => {
    vi.useFakeTimers()
    vi.spyOn(process, 'cpuUsage').mockReturnValue(usage.end).mockReturnValueOnce(usage.start)
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    const result = await stopPerformanceBaseline(app, page)
    expect(result.main.cpu).toBeNull()
    expect(result.coverage.cpu).toBe('unavailable')
    expect(result.stopFailures).toEqual({ main: 0, renderer: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['start', 'stop'])('still stops both probes when CPU sampling throws at %s', async phase => {
    vi.useFakeTimers()
    const cpuUsage = vi.spyOn(process, 'cpuUsage').mockImplementation(() => { throw new Error('private CPU sampling error') })
    if (phase === 'stop') cpuUsage.mockReturnValueOnce({ user: 10, system: 20 })
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    const result = await stopPerformanceBaseline(app, page)
    expect(result.main.cpu).toBeNull()
    expect(result.coverage.cpu).toBe('unavailable')
    expect(result.stopFailures).toEqual({ main: 0, renderer: 0 })
    expect(JSON.stringify(result)).not.toContain('private CPU sampling error')
    expect(globalThis[Symbol.for('pagekin.performance-baseline.probe')]).toBeUndefined()
    expect(globalThis[Symbol.for('pagekin.performance-baseline.renderer')]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([undefined, 0])('does not invent missing RSS endpoints or qualify invalid RSS: %s', async rss => {
    vi.useFakeTimers()
    vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss })
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    const result = await stopPerformanceBaseline(app, page)
    expect(result.main.memory.rssStart).toBe(rss)
    expect(result.main.memory.rssEnd).toBe(rss)
    expect(result.main.memory.rssIntervalMs).toBe(250)
    expect(result.coverage.main).toBe('unavailable')
    expect(result.stopFailures).toEqual({ main: 1, renderer: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disables the histogram when main probe startup fails before its timer is registered', async () => {
    vi.useFakeTimers()
    const hooks = process.getBuiltinModule('node:perf_hooks'), monitor = hooks.monitorEventLoopDelay
    let disable
    vi.spyOn(hooks, 'monitorEventLoopDelay').mockImplementation(options => {
      const histogram = monitor(options)
      disable = vi.spyOn(histogram, 'disable')
      return histogram
    })
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => { throw new Error('RSS start failed') })
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: vi.fn() }
    await expect(startPerformanceBaseline(app, page)).rejects.toThrow('RSS start failed')
    expect(disable).toHaveBeenCalledOnce()
    expect(page.evaluate).not.toHaveBeenCalled()
    expect(globalThis[Symbol.for('pagekin.performance-baseline.probe')]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans the main probe even when its final read fails', async () => {
    vi.useFakeTimers()
    const key = Symbol.for('pagekin.performance-baseline.probe')
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    const disable = vi.spyOn(globalThis[key].histogram, 'disable')
    globalThis[key].read = () => { throw new Error('private final probe read') }
    const result = await stopPerformanceBaseline(app, page)
    expect(result.main).toBeNull()
    expect(result.coverage.cpu).toBe('unavailable')
    expect(result.stopFailures).toEqual({ main: 1, renderer: 0 })
    expect(disable).toHaveBeenCalledOnce()
    expect(globalThis[key]).toBeUndefined()
    expect(globalThis[Symbol.for('pagekin.performance-baseline.renderer')]).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('private final probe read')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('derives schema-2 nonexclusive costs from valid owner-side summaries without mutating raw measurements', async () => {
    const summary = sum => ({ count: 1, sum, min: sum, max: sum, p50UpperBound: sum, p95UpperBound: sum })
    const main = { metrics: { schemaVersion: 1, quantiles: 'fixed-histogram-upper-bounds', metrics: {
      'import.read.ms': summary(0), 'generation.provider.ms': summary(10), 'transport.requests': summary(2),
      'generation.dispatch.calls': summary(99), 'transport.visible.events': summary(3), 'generation.visible.events': summary(4),
      'renderer.snapshot.queue_ms': summary(999), 'source.capture.ms': { ...summary(1), sum: NaN },
      'scheduler.acquire.calls': summary(3), 'scheduler.acquire.admitted': summary(2), 'scheduler.acquire.rejected': summary(1),
      'scheduler.wait.admitted_ms': summary(0), 'scheduler.wait.rejected_ms': summary(4), 'scheduler.queue': summary(1),
    } }, memory: { rssSamples: 1, rssMax: 1024, rssStart: 1024, rssEnd: 1024, rssIntervalMs: 250 }, eventLoop: { count: 1 } }
    const renderer = { metrics: { 'renderer.snapshot.queue_ms': summary(0), 'renderer.snapshot.processing_ms': summary(5),
      'source.read.ms': summary(999), 'generation.provider.ms': summary(999), 'workflow.import.refresh.ms': summary(7) },
    heartbeat: { intervalMs: 100, count: 1, sumDelayMs: 0, maxDelayMs: 0 } }
    const before = structuredClone({ main, renderer })
    const result = await stopPerformanceBaseline({ evaluate: async () => main }, { evaluate: async () => renderer })
    expect(result.costAttribution).toMatchObject({ coverage: { main: 'observed_metrics', renderer: 'observed_metrics' },
      ownership: 'main-plus-renderer-owned-metrics', categories: { schemaVersion: 2,
        localPreparation: { importReadMs: 0, sourceReadMs: null, sourceCaptureMs: null },
        queueWait: { snapshotQueueMs: 0, schedulerAcquireCalls: 3, schedulerAdmitted: 2, schedulerRejected: 1,
          schedulerAdmittedWaitMs: 0, schedulerRejectedWaitMs: 4, schedulerQueueSamples: summary(1) },
        modelExecution: { providerMs: 10, physicalRequests: 2,
          transportVisibleEvents: 3, generationVisibleEvents: 4 },
        parsingComputation: { rendererSnapshotProcessingMs: 5 }, persistenceSave: { saveMs: null } } })
    expect(result.costAttribution.categories).not.toHaveProperty('totalMs')
    expect(result.costAttribution.categories).not.toHaveProperty('phaseWallTimes')
    expect(result.renderer.metrics['workflow.import.refresh.ms'].sum).toBe(7)
    expect({ main: result.main, renderer: result.renderer }).toEqual(before)
  })

  it.each(['main', 'renderer'])('keeps unavailable %s cost observations null rather than borrowing the other side', async missing => {
    const summary = { count: 1, sum: 0, min: 0, max: 0, p50UpperBound: 0, p95UpperBound: 0 }
    const main = { metrics: { schemaVersion: 1, quantiles: 'fixed-histogram-upper-bounds', metrics: {
      'import.read.ms': summary, 'renderer.snapshot.queue_ms': summary,
    } }, memory: { rssSamples: 1, rssMax: 1024, rssStart: 1024, rssEnd: 1024, rssIntervalMs: 250 }, eventLoop: { count: 1 } }
    const renderer = { metrics: { 'renderer.snapshot.queue_ms': summary, 'import.read.ms': summary },
      heartbeat: { intervalMs: 100, count: 1, sumDelayMs: 0, maxDelayMs: 0 } }
    const result = await stopPerformanceBaseline({ evaluate: async () => missing === 'main' ? null : main },
      { evaluate: async () => missing === 'renderer' ? null : renderer })
    expect(result.costAttribution.coverage[missing]).toBe('unavailable')
    expect(result.costAttribution.categories.localPreparation.importReadMs).toBe(missing === 'main' ? null : 0)
    expect(result.costAttribution.categories.queueWait.snapshotQueueMs).toBe(missing === 'renderer' ? null : 0)
    expect(result.stopFailures[missing]).toBe(1)
  })

  it('reports probe errors without derived zero costs or retained raw error data', async () => {
    const fail = async () => { throw new Error('private-probe-error') }
    const result = await stopPerformanceBaseline({ evaluate: fail }, { evaluate: fail })
    expect(result.costAttribution.coverage).toEqual({ main: 'unavailable', renderer: 'unavailable' })
    expect(result.costAttribution.categories.localPreparation.importReadMs).toBeNull()
    expect(result.costAttribution.categories.queueWait.snapshotQueueMs).toBeNull()
    expect(result.costAttribution.categories.modelExecution.physicalRequests).toBeNull()
    expect(JSON.stringify(result)).not.toContain('private-probe-error')
  })

  it('cleans the main probe and counts a renderer stop failure', async () => {
    vi.useFakeTimers()
    const key = Symbol.for('pagekin.performance-baseline.probe')
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    const disable = vi.spyOn(globalThis[key].histogram, 'disable')
    const result = await stopPerformanceBaseline(app, { evaluate: async () => { throw new Error('private content') } })
    expect(result.stopFailures).toEqual({ main: 0, renderer: 1 })
    expect(disable).toHaveBeenCalledOnce()
    expect(globalThis[key]).toBeUndefined()
    globalThis[Symbol.for('pagekin.performance-baseline.renderer')].stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('distinguishes live probes with zero events from a stop failure', async () => {
    vi.useFakeTimers()
    globalThis[collectorKey] = () => ({ schemaVersion: 1, quantiles: 'fixed-histogram-upper-bounds', metrics: {} })
    // Fake timers do not advance the native histogram; supply one explicit loop sample.
    const app = { evaluate: async callback => {
      const result = callback()
      return result?.eventLoop ? { ...result, eventLoop: { ...result.eventLoop, count: 1 } } : result
    } }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    await vi.advanceTimersByTimeAsync(300)
    const result = await stopPerformanceBaseline(app, page)
    expect(result.renderer.heartbeat.count).toBe(3)
    expect(result.renderer.metrics).toEqual({})
    expect(result.coverage).toEqual({ main: 'live_zero_events', renderer: 'live_zero_events', cpu: 'observed' })
    expect(result.stopFailures).toEqual({ main: 0, renderer: 0 })
    expect(() => assertPerformanceProbeCoverage(result)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([{ heartbeat: 0, loop: 1 }, { heartbeat: 1, loop: 0 }, { heartbeat: 0, loop: 0 }])(
    'retains zero-sampling raw evidence but rejects complete coverage: %j', async counts => {
      const main = { metrics: { schemaVersion: 1, quantiles: 'fixed-histogram-upper-bounds', metrics: {} },
        memory: { rssMax: 1024, rssSamples: 1, rssStart: 1024, rssEnd: 1024, rssIntervalMs: 250 }, eventLoop: { count: counts.loop } }
      const renderer = { metrics: {}, heartbeat: { intervalMs: 100, count: counts.heartbeat, sumDelayMs: 0, maxDelayMs: 0 } }
      const result = await stopPerformanceBaseline({ evaluate: async () => main }, { evaluate: async () => renderer })
      expect(result.main).toBe(main)
      expect(result.renderer).toBe(renderer)
      expect(result.main.eventLoop.count).toBe(counts.loop)
      expect(result.renderer.heartbeat.count).toBe(counts.heartbeat)
      expect(result.stopFailures).toEqual({ main: 0, renderer: 0 })
      expect(result.coverage).toEqual({ main: counts.loop ? 'live_zero_events' : 'insufficient_samples',
        renderer: counts.heartbeat ? 'live_zero_events' : 'insufficient_samples', cpu: 'unavailable' })
      expect(() => assertPerformanceProbeCoverage(result)).toThrow('PERFORMANCE_PROBE_COVERAGE_UNAVAILABLE')
      expect(() => assertPerformanceProbeCoverage({ ...result, coverage: { main: 'live_zero_events', renderer: 'live_zero_events' } }))
        .toThrow('PERFORMANCE_PROBE_COVERAGE_UNAVAILABLE')
    },
  )

  it('persists only bounded closed diagnostic categories and exact stable codes', () => {
    const entries = []
    appendPerformanceFailureDiagnostic(entries, Object.assign(new Error('private-body'), { name: 'private-class', code: 'PRIVATE_SECRET' }), 'private-source', 'private-stage')
    appendPerformanceFailureDiagnostic(entries, new Error('PERFORMANCE_IMPORT_DRAIN_TIMEOUT'), 'cleanup', 'drain')
    for (let index = 0; index < 30; index++) appendPerformanceFailureDiagnostic(entries, new Error('private-body'), 'cleanup', 'quit')
    const saved = JSON.parse(JSON.stringify(entries))
    expect(saved).toHaveLength(12)
    expect(saved[0]).toEqual({ source: 'unclassified', stage: 'unclassified', errorClass: 'Error', code: 'UNCLASSIFIED_ERROR' })
    expect(saved[1]).toEqual({ source: 'cleanup', stage: 'drain', errorClass: 'Error', code: 'PERFORMANCE_IMPORT_DRAIN_TIMEOUT' })
    expect(JSON.stringify(saved)).not.toMatch(/private-|PRIVATE_SECRET/u)
  })

  it('retains fixed comparison failure codes without copying arbitrary messages', () => {
    const codes = ['PERFORMANCE_COMPARISON_TIMEOUT', 'PERFORMANCE_COMPARISON_SETUP_FAILED', 'PERFORMANCE_COMPARISON_INPUT_MISMATCH',
      'PERFORMANCE_COMPARISON_RECEIPT_INVALID', 'PERFORMANCE_COMPARISON_REQUEST_MISMATCH',
      'PERFORMANCE_COMPARISON_CLEANUP_FAILED', 'PERFORMANCE_COMPARISON_FINAL_REQUEST_EVIDENCE_FAILED']
    const entries = []
    for (const code of codes) appendPerformanceFailureDiagnostic(entries, Object.assign(new Error('private-prompt'), { code }), 'scenario', 'verify')
    expect(entries.map(item => item.code)).toEqual(codes)
    expect(JSON.stringify(entries)).not.toContain('private-prompt')
  })

  it('rejects a malformed renderer heartbeat even when metrics exist', async () => {
    vi.useFakeTimers()
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    const probe = globalThis[Symbol.for('pagekin.performance-baseline.renderer')]
    const stop = probe.stop
    probe.stop = () => ({ ...stop(), heartbeat: { intervalMs: 100, count: -1, sumDelayMs: 0, maxDelayMs: 0 } })
    const result = await stopPerformanceBaseline(app, page)
    expect(result.coverage.renderer).toBe('unavailable')
    expect(result.stopFailures.renderer).toBe(1)
    expect(() => assertPerformanceProbeCoverage(result)).toThrow('PERFORMANCE_PROBE_COVERAGE_UNAVAILABLE')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a hung renderer stop and still cleans the main probe', async () => {
    vi.useFakeTimers()
    const app = { evaluate: async callback => callback() }
    await startPerformanceBaseline(app, { evaluate: async (callback, argument) => callback(argument) })
    const stopped = stopPerformanceBaseline(app, { evaluate: () => new Promise(() => {}) })
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await stopped
    expect(result.stopFailures).toEqual({ main: 0, renderer: 1 })
    expect(result.coverage.renderer).toBe('unavailable')
    globalThis[Symbol.for('pagekin.performance-baseline.renderer')].stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([undefined, { stopFailures: { main: 0, renderer: 0 } },
    { stopFailures: { main: 1, renderer: 0 }, coverage: { main: 'observed_metrics', renderer: 'live_zero_events' } },
    { stopFailures: { main: 0, renderer: 0 }, coverage: { main: 'observed_metrics', renderer: 'unavailable' } },
    { stopFailures: { main: 0, renderer: 0 }, coverage: { main: 'insufficient_samples', renderer: 'observed_metrics' } },
  ])('does not accept missing or failed probe coverage: %j', measurements => {
    expect(() => assertPerformanceProbeCoverage(measurements)).toThrow('PERFORMANCE_PROBE_COVERAGE_UNAVAILABLE')
  })

  it('reports absent probes without treating missing observations as success', async () => {
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async callback => callback() }
    const result = await stopPerformanceBaseline(app, page)
    expect(result.stopFailures).toEqual({ main: 1, renderer: 1 })
    expect(result.coverage).toEqual({ main: 'unavailable', renderer: 'unavailable', cpu: 'unavailable' })
  })

  it('reports a missing main collector while still stopping both probes', async () => {
    vi.useFakeTimers()
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    globalThis[Symbol.for('pagekin.performance-baseline.renderer')].record('renderer.snapshot.calls', 1)
    delete globalThis[collectorKey]
    const result = await stopPerformanceBaseline(app, page)
    expect(result.main.metrics).toBeNull()
    expect(result.stopFailures).toEqual({ main: 1, renderer: 0 })
    expect(result.coverage.main).toBe('unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports missing renderer metrics and cleans the main probe', async () => {
    vi.useFakeTimers()
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async (callback, argument) => callback(argument) }
    await startPerformanceBaseline(app, page)
    const originalStop = globalThis[Symbol.for('pagekin.performance-baseline.renderer')].stop
    globalThis[Symbol.for('pagekin.performance-baseline.renderer')].stop = () => { originalStop(); return { heartbeat: {} } }
    const result = await stopPerformanceBaseline(app, page)
    expect(result.stopFailures).toEqual({ main: 0, renderer: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('attaches a sanitized failure report with phase and denominator', async () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    const page = { setDefaultTimeout: vi.fn() }
    const context = { page, app: { evaluate: async () => { throw new Error('private content') } },
      roots: { temp: 'unused' }, fake: { requests: [], replyReview: () => {} } }
    let error
    try { await PERFORMANCE_SCENARIOS['perf-import-10'].run(context) } catch (caught) { error = caught }
    expect(error.message).toBe('PERFORMANCE_SCENARIO_FAILED:runtime')
    expect(error.performanceBaseline).toMatchObject({ success: false, failureStage: 'runtime', attempted: 1, failed: 1, stopFailures: 0 })
    expect(error.performanceBaseline.importedChapters).toBeNull()
    expect(error.performanceBaseline.blueprintChapters).toBeNull()
    expect(JSON.stringify(error.performanceBaseline)).not.toContain('private content')
    expect(page.setDefaultTimeout).toHaveBeenLastCalledWith(20_000)
  })
})

function importFixture() {
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
  const events = []
  const original = vi.fn(async () => ({ success: true, preparation: { run: { id: 'import-1' } } }))
  const handlers = new Map([['db:import-run-prepare-inspection', original]])
  const action = { isChecked: async () => true, click: async () => { await handlers.get('db:import-run-prepare-inspection')() } }
  const dialog = { getByRole: () => action, waitFor: async () => {} }
  const context = {
    page: { setDefaultTimeout: vi.fn() }, roots: { temp: 'unused' },
    fake: { requests: Array(32).fill(null), replyReview: () => {} },
    app: { evaluate: vi.fn(async callback => callback.toString().includes('ipcMain')
      ? callback({ ipcMain: { _invokeHandlers: handlers } }) : { leaseId: 'fictional-lease', projectPath: 'fictional-project' }) },
    invoke: vi.fn(async (_page, channel) => {
      if (channel === 'db:draft-list-all') return Array.from({ length: 10 }, () => ({ status: 'finalized' }))
      if (channel === 'generation:list') return [{ handle: { runId: 'generation-1' } }]
      if (channel === 'generation:read-diagnostics') return { schemaVersion: 1, handle: { runId: 'generation-1' },
        importSlot: { runId: 'import-1', stage: 'global', batchId: 'done' }, attempts: [], source: {} }
      if (channel === 'db:import-run-get') return { id: 'import-1', completedBatches: { global: ['done'] } }
      return Array(10).fill({})
    }),
  }
  const summary = count => ({ coverage: 'guarded_fetch_attempts', byRoute: { '/v1/chat/completions': { count } } })
  const dependencies = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => { events.push('stop'); return {
      stopFailures: { main: 0, renderer: 0 }, coverage: { main: 'observed_metrics', renderer: 'observed_metrics' },
      main: { metrics: { metrics: { 'import.inspect.calls': { count: 1 } } }, eventLoop: { count: 1 } },
      renderer: { metrics: { 'renderer.snapshot.accepted': { count: 1 } }, heartbeat: { count: 1 } },
    } }),
    openImport: vi.fn(async () => dialog),
    waitDone: vi.fn(async () => { events.push('workflow') }),
    cancelImport: vi.fn(async () => { events.push('cancel'); return { status: 'drained', cancellationRequested: true } }),
    readRequests: vi.fn(async () => { events.push('summary'); return summary(32) }),
  }
  return { context, dependencies, events, summary, handlers, original }
}

describe('performance import failure evidence', () => {
  it('cancels and drains a timed-out import before stopping probes or freezing requests', async () => {
    const f = importFixture(), original = new Error('private-workflow-timeout')
    f.dependencies.waitDone.mockRejectedValue(original)
    let caught
    try { await runPerformanceImportScenario(10, f.context, f.dependencies) } catch (error) { caught = error }
    expect(f.events).toEqual(['cancel', 'stop', 'summary'])
    expect(caught.cause).toBe(original)
    expect(caught.performanceBaseline).toMatchObject({ failureStage: 'workflow', failed: 1, success: false,
      importedChapters: null, blueprintChapters: null, cleanupFailures: 0, drain: { status: 'drained' },
      countCoverage: { importedChapters: 'unavailable', blueprintChapters: 'unavailable' } })
    expect(JSON.stringify(caught.performanceBaseline)).not.toContain('private-workflow-timeout')
    await f.context.finalizePerformanceEvidence()
    expect(caught.performanceBaseline).toMatchObject({ failureStage: 'workflow', success: false, requestsAfterMeasurement: 0,
      requestSummaryCutoff: 'before_quit' })
  })

  it('preserves original, drain and stop errors without replacing the failing stage', async () => {
    const f = importFixture(), original = Object.assign(new Error('private-original'), { code: 'ECONNRESET' })
    const drain = Object.assign(new Error('private-drain'), { name: 'TimeoutError' }), stop = new Error('private-stop')
    f.dependencies.waitDone.mockRejectedValue(original)
    f.dependencies.cancelImport.mockRejectedValue(drain)
    f.dependencies.stop.mockRejectedValue(stop)
    let caught
    try { await runPerformanceImportScenario(10, f.context, f.dependencies) } catch (error) { caught = error }
    expect(caught.cause.errors).toEqual([original, drain, stop])
    expect(caught.performanceBaseline).toMatchObject({ failureStage: 'workflow', cleanupFailures: 2, drain: { status: 'unavailable' } })
    expect(JSON.parse(JSON.stringify(caught.performanceBaseline)).failureDiagnostics).toEqual([
      { source: 'scenario', stage: 'workflow', errorClass: 'Error', code: 'ECONNRESET' },
      { source: 'cleanup', stage: 'drain', errorClass: 'TimeoutError', code: 'TIMEOUT' },
      { source: 'cleanup', stage: 'probe_stop', errorClass: 'Error', code: 'UNCLASSIFIED_ERROR' },
    ])
    expect(JSON.stringify(caught.performanceBaseline)).not.toMatch(/private-original|private-drain|private-stop/u)
  })

  it('keeps a completed count when the subsequent independent count cannot be read', async () => {
    const f = importFixture()
    f.context.invoke.mockImplementation(async (_page, channel) => {
      if (channel === 'db:blueprint-get-all') throw new Error('unavailable')
      return Array.from({ length: 10 }, () => ({ status: 'finalized' }))
    })
    await expect(runPerformanceImportScenario(10, f.context, f.dependencies)).rejects.toMatchObject({ performanceBaseline: {
      failureStage: 'verify', importedChapters: 10, blueprintChapters: null,
      countCoverage: { importedChapters: 'observed', blueprintChapters: 'unavailable' },
    } })
  })

  it('reports applicable missing events separately from valid zero-event probes', async () => {
    const f = importFixture()
    f.dependencies.stop.mockResolvedValue({ stopFailures: { main: 0, renderer: 0 },
      coverage: { main: 'live_zero_events', renderer: 'live_zero_events' }, main: { metrics: { metrics: {} }, eventLoop: { count: 1 } },
      renderer: { metrics: {}, heartbeat: { count: 1 } } })
    await expect(runPerformanceImportScenario(10, f.context, f.dependencies)).rejects.toMatchObject({ performanceBaseline: {
      failureStage: 'event_coverage', stopFailures: 0, cleanupFailures: 0,
      eventCoverage: { importInspection: 'not_observed', rendererSnapshots: 'not_observed' },
    } })
  })

  it('fails zero-sampling coverage without misreporting a successful stop as a stop failure', async () => {
    const f = importFixture()
    f.dependencies.stop.mockResolvedValue({ stopFailures: { main: 0, renderer: 0 },
      coverage: { main: 'insufficient_samples', renderer: 'live_zero_events' }, main: { eventLoop: { count: 0 } },
      renderer: { heartbeat: { count: 2 } } })
    await expect(runPerformanceImportScenario(10, f.context, f.dependencies)).rejects.toMatchObject({ performanceBaseline: {
      failureStage: 'probe_coverage', stopFailures: 0, cleanupFailures: 1,
      failureDiagnostics: [{ source: 'cleanup', stage: 'probe_coverage', code: 'PERFORMANCE_PROBE_COVERAGE_UNAVAILABLE' }],
      measurements: { main: { eventLoop: { count: 0 } } },
    } })
  })

  it('rejects requests arriving between probe stop and the driver final cutoff', async () => {
    const f = importFixture()
    f.context.fake.chats = [{ model: 'gpt-4.1', maxTokens: 0, temperature: 0, messages: 'private-prompt' }]
    const report = await runPerformanceImportScenario(10, f.context, f.dependencies)
    expect(report.success).toBe(true)
    expect(report.fixture).toEqual({ kind: 'local-openai-compatible-fiction', protocol: 'openai', model: 'gpt-4.1',
      temperature: 0.7, configuredMaxTokens: 4096, skill: 'isolated-fixture-default-no-custom-install' })
    expect(report.fixtureParameters).toMatchObject({ observed: 1, retained: 1, grouped: 1, overflow: 0,
      groups: [{ model: 'gpt-4.1', maxTokens: 0, temperature: 0, count: 1 }] })
    expect(JSON.stringify(report)).not.toContain('private-prompt')
    expect(report.diagnostics.importRun.runs[0]).toMatchObject({ id: 'import-1', checkpointCounts: { global: 1 } })
    expect(f.handlers.get('db:import-run-prepare-inspection')).toBe(f.original)
    expect(f.dependencies.cancelImport).not.toHaveBeenCalled()
    f.dependencies.readRequests.mockResolvedValueOnce(f.summary(33))
    await expect(f.context.finalizePerformanceEvidence()).rejects.toMatchObject({ performanceBaseline: report })
    expect(report).toMatchObject({ success: false, failed: 1, failureStage: 'final_request_summary',
      requestsAfterMeasurement: 1, cleanupFailures: 1, requestSummaryCutoff: 'before_quit' })
  })

  it('does not replace an unavailable final request observation with an empty success', async () => {
    const f = importFixture()
    const report = await runPerformanceImportScenario(10, f.context, f.dependencies)
    f.dependencies.readRequests.mockRejectedValueOnce(new Error('private-observation'))
    await expect(f.context.finalizePerformanceEvidence()).rejects.toMatchObject({ performanceBaseline: report })
    expect(report).toMatchObject({ success: false, finalRequestSummary: null, requestsAfterMeasurement: null })
    expect(JSON.stringify(report)).not.toContain('private-observation')
  })

  it('detects a newly accepted fixture request even before its guarded fetch settles', async () => {
    const f = importFixture()
    const report = await runPerformanceImportScenario(10, f.context, f.dependencies)
    f.context.fake.requests.push(null)
    await expect(f.context.finalizePerformanceEvidence()).rejects.toMatchObject({ performanceBaseline: report })
    expect(report).toMatchObject({ success: false, failed: 1, finalFixtureAcceptedRequests: 33, requestsAfterMeasurement: 0 })
  })

  it('retains the original workflow error and report when the later cutoff also fails', async () => {
    const f = importFixture(), original = new Error('private-original-workflow')
    f.dependencies.waitDone.mockRejectedValue(original)
    let caught
    try { await runPerformanceImportScenario(10, f.context, f.dependencies) } catch (error) { caught = error }
    const report = caught.performanceBaseline
    f.dependencies.readRequests.mockResolvedValueOnce(f.summary(34))
    await expect(f.context.finalizePerformanceEvidence()).rejects.toMatchObject({ performanceBaseline: report })
    expect(caught.cause).toBe(original)
    expect(caught.performanceBaseline).toBe(report)
    expect(report).toMatchObject({ failureStage: 'workflow', failed: 1, requestsAfterMeasurement: 2, cleanupFailures: 1 })
    expect(f.context.invoke.mock.calls.map(call => call[1])).toEqual(['db:import-run-get', 'generation:list', 'generation:read-diagnostics'])
    expect(f.dependencies.stop.mock.invocationCallOrder[0]).toBeLessThan(f.context.invoke.mock.invocationCallOrder[0])
  })

  it('uses the actual import cancel button and bounds a non-draining executor', async () => {
    vi.useFakeTimers()
    const click = vi.fn(async () => {}), hidden = vi.fn(() => new Promise(() => {}))
    const active = { count: async () => 1, getAttribute: async () => 'running', getByRole: () => ({ click }), waitFor: hidden }
    const card = { filter: () => card, waitFor: async () => {}, and: () => active }
    const sheet = { waitFor: async () => {}, getByRole: () => card }
    const page = { getByRole: () => sheet, locator: vi.fn(), waitForFunction: hidden }
    const cancelled = cancelPerformanceImport(page, 10)
    const rejected = expect(cancelled).rejects.toThrow('PERFORMANCE_IMPORT_DRAIN_TIMEOUT')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(click).toHaveBeenCalledOnce()
    expect(hidden).toHaveBeenCalledWith(expect.any(Function), '导入作者原稿（10 章）', { timeout: 25_000 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not equate a terminal card still in activeRuns with drained execution', async () => {
    const title = '导入作者原稿（10 章）'
    let movedToHistory = false
    const node = { querySelector: selector => selector === 'h3' ? { textContent: title } : movedToHistory ? {} : null }
    vi.stubGlobal('document', { querySelectorAll: () => [node] })
    try {
      const active = { count: async () => 0 }
      const card = { filter: () => card, waitFor: async () => {}, and: () => active }
      const sheet = { waitFor: async () => {}, getByRole: () => card }
      const page = { getByRole: () => sheet, locator: () => {}, waitForFunction: async (predicate, expectedTitle) => {
        expect(predicate(expectedTitle)).toBe(false)
        movedToHistory = true
        expect(predicate(expectedTitle)).toBe(true)
      } }
      await expect(cancelPerformanceImport(page, 10)).resolves.toEqual({ status: 'drained', cancellationRequested: false })
    } finally { vi.unstubAllGlobals() }
  })
})

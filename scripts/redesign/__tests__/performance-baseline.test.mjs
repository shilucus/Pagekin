import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { corpusSha256, performanceCorpus, PERFORMANCE_SCENARIOS } from '../performance-scenarios.mjs'
import { performanceMetadata, readModelRequestSummary, startPerformanceBaseline, stopPerformanceBaseline } from '../performance-baseline.mjs'

const collectorKey = Symbol.for('pagekin.performance-baseline')
beforeEach(() => { globalThis[collectorKey] = () => ({ schemaVersion: 1, quantiles: 'fixed-histogram-upper-bounds', metrics: { 'source.capture.calls': { count: 1 } } }) })
afterEach(() => { delete globalThis[collectorKey]; vi.restoreAllMocks(); vi.useRealTimers() })

describe('performance baseline contract', () => {
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

  it('reports absent probes without treating missing observations as success', async () => {
    const app = { evaluate: async callback => callback() }
    const page = { evaluate: async callback => callback() }
    const result = await stopPerformanceBaseline(app, page)
    expect(result.stopFailures).toEqual({ main: 1, renderer: 1 })
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
    expect(JSON.stringify(error.performanceBaseline)).not.toContain('private content')
    expect(page.setDefaultTimeout).toHaveBeenLastCalledWith(20_000)
  })
})

import os from 'node:os'
import { PERFORMANCE_METRICS } from '../../src/shared/performance-baseline.ts'

export function performanceMetadata(chapters, sourceSha = process.env.PAGEKIN_PERFORMANCE_SOURCE_SHA) {
  return { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown',
    ramBytes: os.totalmem(), driverNode: process.version, appRuntime: null,
    sourceSha: /^[a-f\d]{40,64}$/i.test(sourceSha ?? '') ? sourceSha : null,
    chapters, books: 1, cache: 'uncontrolled' }
}

export async function readModelRequestSummary(app) {
  return app.evaluate(() => {
    const routes = ['/v1/chat/completions', '/v1/embeddings', '/v1/messages']
    const rows = Object.fromEntries(routes.map(route => [route, { count: 0, failed: 0, http429: 0, totalMs: 0, maxMs: 0 }]))
    const log = globalThis.__driveModelRequests
    if (!Array.isArray(log)) return { coverage: 'unavailable', byRoute: rows }
    for (const entry of log) {
      if (!entry || !Object.hasOwn(rows, entry.path)) continue
      const row = rows[entry.path]
      row.count++
      if (typeof entry.status !== 'number' || entry.status < 200 || entry.status >= 300) row.failed++
      if (entry.status === 429) row.http429++
      if (typeof entry.ms === 'number' && Number.isFinite(entry.ms) && entry.ms >= 0) {
        row.totalMs += entry.ms
        row.maxMs = Math.max(row.maxMs, entry.ms)
      }
    }
    return { coverage: 'guarded_fetch_attempts', byRoute: rows }
  })
}

export async function startPerformanceBaseline(app, page) {
  await app.evaluate(() => {
    const key = Symbol.for('pagekin.performance-baseline.probe')
    if (globalThis[key]) throw new Error('PERFORMANCE_PROBE_ALREADY_RUNNING')
    const histogram = process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
    let rssMax = process.memoryUsage().rss, rssSamples = 1
    const timer = setInterval(() => { rssMax = Math.max(rssMax, process.memoryUsage().rss); rssSamples++ }, 250)
    globalThis[key] = { histogram, timer, read: () => ({ rssMax, rssSamples }) }
  })
  try {
    await page.evaluate(metrics => {
      const key = Symbol.for('pagekin.performance-baseline.renderer')
      if (globalThis[key]) throw new Error('PERFORMANCE_RENDERER_PROBE_ALREADY_RUNNING')
      const allowed = new Set(metrics), bounds = [0, ...Array.from({ length: 41 }, (_, i) => 2 ** i)]
      const summaries = new Map()
      const record = (name, value) => {
        if (!allowed.has(name) || !Number.isFinite(value) || value < 0) return
        const item = summaries.get(name) ?? { count: 0, sum: 0, min: value, max: value, buckets: Array(bounds.length + 1).fill(0) }
        if (!Number.isSafeInteger(item.count + 1) || !Number.isFinite(item.sum + value)) return
        item.count++; item.sum += value; item.min = Math.min(item.min, value); item.max = Math.max(item.max, value)
        const index = bounds.findIndex(bound => value <= bound)
        item.buckets[index < 0 ? bounds.length : index]++
        summaries.set(name, item)
      }
      const snapshot = () => Object.fromEntries([...summaries].map(([name, item]) => {
        const quantile = fraction => {
          let count = 0
          for (const [index, bucket] of item.buckets.entries()) {
            count += bucket
            if (count >= Math.ceil(item.count * fraction)) return Math.min(bounds[index] ?? item.max, item.max)
          }
          return item.max
        }
        return [name, { count: item.count, sum: item.sum, min: item.min, max: item.max,
          p50UpperBound: quantile(.5), p95UpperBound: quantile(.95) }]
      }))
      let previous = performance.now(), count = 0, maxDelayMs = 0, sumDelayMs = 0
      const timer = setInterval(() => {
        const now = performance.now(), delay = Math.max(0, now - previous - 100)
        previous = now; count++; sumDelayMs += delay; maxDelayMs = Math.max(maxDelayMs, delay)
      }, 100)
      globalThis[key] = { record, now: () => performance.now(), stop: () => {
        clearInterval(timer); delete globalThis[key]
        return { metrics: snapshot(), heartbeat: { intervalMs: 100, count, sumDelayMs, maxDelayMs } }
      } }
    }, PERFORMANCE_METRICS)
  } catch {
    await app.evaluate(() => {
      const key = Symbol.for('pagekin.performance-baseline.probe'), probe = globalThis[key]
      if (probe) { clearInterval(probe.timer); probe.histogram.disable(); delete globalThis[key] }
    })
    throw new Error('PERFORMANCE_RENDERER_PROBE_START_FAILED')
  }
}

export async function stopPerformanceBaseline(app, page) {
  let renderer = null, main = null, rendererStopFailures = 0, mainStopFailures = 0
  try {
    renderer = await page.evaluate(() => globalThis[Symbol.for('pagekin.performance-baseline.renderer')]?.stop() ?? null)
    if (!renderer?.metrics || typeof renderer.metrics !== 'object' || Array.isArray(renderer.metrics)
      || Object.keys(renderer.metrics).length === 0) rendererStopFailures++
  } catch { rendererStopFailures++ }
  try {
    main = await app.evaluate(() => {
      const key = Symbol.for('pagekin.performance-baseline.probe'), probe = globalThis[key]
      if (!probe) return null
      clearInterval(probe.timer); probe.histogram.disable()
      const h = probe.histogram, memory = probe.read()
      delete globalThis[key]
      const metrics = globalThis[Symbol.for('pagekin.performance-baseline')]?.() ?? null
      return { metrics, memory, eventLoop: { count: h.count, minMs: h.count ? h.min / 1e6 : null,
        maxMs: h.count ? h.max / 1e6 : null, meanMs: h.count ? h.mean / 1e6 : null,
        p50Ms: h.count ? h.percentile(50) / 1e6 : null, p95Ms: h.count ? h.percentile(95) / 1e6 : null } }
    })
    if (!main || main.metrics?.schemaVersion !== 1 || main.metrics?.quantiles !== 'fixed-histogram-upper-bounds'
      || !main.metrics?.metrics || typeof main.metrics.metrics !== 'object' || Array.isArray(main.metrics.metrics)
      || Object.keys(main.metrics.metrics).length === 0) mainStopFailures++
  } catch { mainStopFailures++ }
  return { main, renderer, stopFailures: { main: mainStopFailures, renderer: rendererStopFailures } }
}

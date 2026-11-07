import { expect, it } from 'vitest'
import { createPerformanceBaseline, PERFORMANCE_METRICS, type PerformanceMetric } from '../performance-baseline'

it('retains cancellation counts and compressed archive bytes as distinct import metrics', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('import.inspect.cancelled', 1)
  baseline.record('import.read.archive_bytes', 200)
  baseline.record('import.read.utf8_bytes', 800)
  expect(baseline.snapshot().metrics['import.inspect.cancelled']?.sum).toBe(1)
  expect(baseline.snapshot().metrics['import.read.archive_bytes']?.sum).toBe(200)
  expect(baseline.snapshot().metrics['import.read.utf8_bytes']?.sum).toBe(800)
})

it('distinguishes logical dispatch from transport requests and rejects the misleading old metric', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('generation.dispatch.calls', 1)
  baseline.record('transport.sessions', 2)
  baseline.record('transport.requests', 1)
  baseline.record('generation.physical_requests' as PerformanceMetric, 1)
  expect(Object.keys(baseline.snapshot().metrics)).toEqual(['generation.dispatch.calls', 'transport.sessions', 'transport.requests'])
})

it('summarizes the full denominator with explicitly bounded approximate quantiles', () => {
  const baseline = createPerformanceBaseline()
  for (let value = 1; value <= 1000; value++) baseline.record('source.read.ms', value)
  expect(baseline.snapshot().metrics['source.read.ms']).toEqual({ count: 1000, sum: 500500, min: 1, max: 1000, p50UpperBound: 512, p95UpperBound: 1000 })
})

it('retains only fixed names and numeric summaries, regardless of event volume', () => {
  const baseline = createPerformanceBaseline()
  for (let index = 0; index < 10000; index++) {
    baseline.record('transport.visible.events', 1)
    baseline.record(`private-path-and-key-${index}` as PerformanceMetric, 1)
  }
  for (const invalid of [NaN, Infinity, -Infinity, -1]) baseline.record('source.read.ms', invalid)
  expect(Object.keys(baseline.snapshot().metrics)).toEqual(['transport.visible.events'])
  expect(baseline.snapshot().metrics['transport.visible.events']?.count).toBe(10000)
  expect(JSON.stringify(baseline.snapshot())).not.toContain('private-path-and-key')
  expect(Object.keys(baseline.snapshot().metrics).length).toBeLessThanOrEqual(PERFORMANCE_METRICS.length)
})

it('returns detached immutable snapshots and preserves zero observations', () => {
  const baseline = createPerformanceBaseline()
  baseline.record('source.read.ms', 0)
  const first = baseline.snapshot()
  baseline.record('source.read.ms', 2)
  expect(first.metrics['source.read.ms']?.count).toBe(1)
  expect(Object.isFrozen(first.metrics['source.read.ms'])).toBe(true)
  expect(baseline.snapshot().metrics['source.read.ms']).toEqual({ count: 2, sum: 2, min: 0, max: 2, p50UpperBound: 0, p95UpperBound: 2 })
})

import { createPerformanceBaseline, type PerformanceMetric } from '../../src/shared/performance-baseline'

const baseline = createPerformanceBaseline()
const snapshotKey = Symbol.for('pagekin.performance-baseline')

export function performanceDiagnosticsEnabled(): boolean {
  try { return process.env.PAGEKIN_PERFORMANCE_BASELINE === '1' } catch { return false }
}

export function readPerformanceDiagnostics() {
  return baseline.snapshot()
}

function installSnapshot(): void {
  if (!Object.prototype.hasOwnProperty.call(globalThis, snapshotKey)) {
    Object.defineProperty(globalThis, snapshotKey, { value: readPerformanceDiagnostics, writable: false, configurable: false, enumerable: false })
  }
}

/** No caller strings or payloads enter the collector, including error messages. */
export function recordPerformanceMetric(name: PerformanceMetric, value: number): void {
  try {
    if (!performanceDiagnosticsEnabled()) return
    installSnapshot()
    baseline.record(name, value)
  } catch { /* Diagnostics cannot change business outcomes. */ }
}

export function recordPerformanceCount(name: PerformanceMetric, amount = 1): void {
  recordPerformanceMetric(name, amount)
}

export function performanceStarted(): number | null {
  try { return performanceDiagnosticsEnabled() ? performance.now() : null } catch { return null }
}

export function recordPerformanceDuration(name: PerformanceMetric, started: number | null): void {
  try { if (started !== null) recordPerformanceMetric(name, Math.max(0, performance.now() - started)) } catch { /* Diagnostic clock failure is nonfatal. */ }
}

export function recordPerformanceTextBytes(name: PerformanceMetric, text: string): void {
  try { if (performanceDiagnosticsEnabled()) recordPerformanceMetric(name, Buffer.byteLength(text, 'utf8')) } catch { /* Never retain the measured text. */ }
}

export function recordPerformanceComputedMetric(name: PerformanceMetric, sample: () => number): void {
  try { if (performanceDiagnosticsEnabled()) recordPerformanceMetric(name, sample()) } catch { /* Sampling cannot change the operation being measured. */ }
}

/** Synchronous work only; async boundaries use performanceStarted/recordPerformanceDuration. */
export function measurePerformanceOperation<T>(name: PerformanceMetric, operation: () => T): T {
  const started = performanceStarted()
  try { return operation() } finally { recordPerformanceDuration(name, started) }
}

try { if (performanceDiagnosticsEnabled()) installSnapshot() } catch { /* A pre-existing global does not affect generation. */ }

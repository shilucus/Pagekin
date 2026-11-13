import type { MainProcessSchedulerPermit } from './main-process-scheduler'

/** Logical completion starts a cleanup deadline; only physical settlement releases admission. */
export function createNetworkPermitLifetime(
  permit: MainProcessSchedulerPermit,
  signal?: AbortSignal,
  graceMs = 5_000,
): { logicalEnd(): void; finish(): void } {
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const logicalEnd = () => {
    if (finished || timer !== undefined) return
    timer = setTimeout(() => { if (!finished) permit.quarantine() }, graceMs)
    timer.unref?.()
  }
  signal?.addEventListener('abort', logicalEnd, { once: true })
  if (signal?.aborted) logicalEnd()
  return {
    logicalEnd,
    finish() {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', logicalEnd)
      permit.finish()
    },
  }
}

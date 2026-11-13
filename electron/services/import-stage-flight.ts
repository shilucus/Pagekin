const active = new WeakMap<object, Map<string, 'knowledge' | 'global' | 'style'>>()

/** Process-local writer ownership only; durable execution authority remains in the existing repositories. */
export function acquireImportStageFlight(database: object, runId: string, stage: 'knowledge' | 'global' | 'style'): () => void {
  assertImportStageUnmanagedMutationAllowed(database, runId)
  let runs = active.get(database)
  if (!runs) { runs = new Map(); active.set(database, runs) }
  runs.set(runId, stage)
  let released = false
  return () => {
    if (released) return
    released = true
    runs.delete(runId)
    if (!runs.size) active.delete(database)
  }
}

export function assertImportStageUnmanagedMutationAllowed(database: object, runId: unknown): void {
  if (typeof runId !== 'string') return
  const stage = active.get(database)?.get(runId)
  if (stage) throw new Error(stage === 'knowledge' ? 'KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE' : 'GENERATION_OWNER_BUSY')
}

export function hasImportStageFlight(database: object, runId: string): boolean {
  return active.get(database)?.has(runId) ?? false
}

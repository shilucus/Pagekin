import type Database from 'better-sqlite3'

const active = new WeakMap<object, Map<string, 'knowledge' | 'global' | 'style' | 'blueprints' | 'refresh'>>()

/** Process-local writer ownership only; durable execution authority remains in the existing repositories. */
export function acquireImportStageFlight(database: object, runId: string, stage: 'knowledge' | 'global' | 'style' | 'blueprints' | 'refresh'): () => void {
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

/** Resolve the saved operation as well as the established fresh-import naming contract. */
export function assertImportBlueprintOperationUnmanagedMutationAllowed(database: Database.Database, operationId: unknown): void {
  if (typeof operationId !== 'string') return
  const rows = database.prepare(`SELECT DISTINCT run_id FROM import_run_receipts
    WHERE stage='blueprints' AND json_extract(payload_json,'$.operationId')=?`).all(operationId) as { run_id: string }[]
  for (const row of rows) assertImportStageUnmanagedMutationAllowed(database, row.run_id)
  const match = /^import-blueprints-(.+)-[1-9]\d*-[1-9]\d*$/u.exec(operationId.trim())
  if (match) assertImportStageUnmanagedMutationAllowed(database, match[1])
}

export function assertImportBlueprintSyncUnmanagedMutationAllowed(database: Database.Database, operationId: unknown): void {
  if (typeof operationId !== 'string') return
  const row = database.prepare('SELECT blueprint_commit_operation_id FROM blueprint_character_sync_operations WHERE operation_id=?')
    .get(operationId) as { blueprint_commit_operation_id: string } | undefined
  if (row) assertImportBlueprintOperationUnmanagedMutationAllowed(database, row.blueprint_commit_operation_id)
}

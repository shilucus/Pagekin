import type { ReferenceRunStage } from '../../src/shared/reference-run-contract'
import { ImportRunRepository } from '../repositories/import-run-repository'
import { assertReferenceBlueprintSkippedHistory } from './reference-blueprint-driver'
import { assertReferenceGlobalSkippedHistory } from './reference-global-driver'
import { assertReferenceStyleSkippedHistory } from './reference-style-driver'
import type { ProjectRuntime } from './project-runtime'

/** Validate existing durable stage history without invoking a stage or changing its state. */
export function assertReferenceImportSkippedHistory(runtime: ProjectRuntime, runId: string, stage: ReferenceRunStage): void {
  switch (stage) {
    case 'knowledge':
      return
    case 'global': {
      const run = ImportRunRepository.get(runId, runtime)
      if (!run) throw new Error('IMPORT_RUN_NOT_FOUND')
      assertReferenceGlobalSkippedHistory(runtime, runId, run.status === 'completed' && run.stage === 'completed')
      return
    }
    case 'style':
      assertReferenceStyleSkippedHistory(runtime, runId)
      return
    case 'blueprints':
      assertReferenceBlueprintSkippedHistory(runtime, runId)
      return
    case 'refresh':
      throw new Error('REFERENCE_RUN_STAGE_MISMATCH')
  }
}

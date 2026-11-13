import { describe, expect, it, vi } from 'vitest'
import { knownAppErrorMessage } from '../../../src/i18n/app-errors'
import { translate } from '../../../src/i18n/core'

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' } }))
vi.mock('../../repositories/import-run-repository', () => ({
  ImportRunRepository: { get: vi.fn(() => { throw new Error('FICTIONAL_DATABASE_READ_FORBIDDEN') }) },
}))
import { explainImportRunFailure, persistedImportRunFailure } from '../import-run-failure'

const displayOnlyCodes = [
  'GENERATION_PROJECT_CLOSE_FAILED', 'RUNTIME_FEEDBACK_RESOURCES_CHANGED', 'GENERATION_OWNER_BUSY',
  'RUNTIME_FEEDBACK_HANDOFF_FAILED', 'RUNTIME_FEEDBACK_CAPABILITY_REQUIRED', 'MCP_TRANSPORT_CLOSED',
  'MCP_TOOL_FAILED', 'MCP_TRANSPORT_ERROR', 'MCP_TRANSPORT_UNAVAILABLE', 'MCP_REQUEST_REJECTED',
  'CHARACTER_ROSTER_SCHEMA_MISSING', 'GENERATION_AGENT_CLOSING', 'GENERATION_AGENT_GLOBAL_EXECUTION_STALE',
  'GENERATION_OWNER_CLOSING', 'RUNTIME_FEEDBACK_REVOKE_CLEANUP_FAILED', 'RUNTIME_FEEDBACK_PREPARE_ROLLBACK_FAILED',
  'RUNTIME_FEEDBACK_EXECUTION_CLEANUP_FAILED', 'RUNTIME_FEEDBACK_CLOSE_QUIESCE_FAILED',
  'GENERATION_BATCH_PROJECT_CORE_MISSING', 'GENERATION_BATCH_BLUEPRINT_MISSING',
  'GENERATION_DRAFT_REQUIRED_PREDECESSOR_MISSING', 'IMPORT_RUN_CANCEL_REQUEST_FAILED',
  'BLUEPRINT_CHANGES_EMPTY', 'BLUEPRINT_CHARACTERS_INVALID', 'MCP_DISCONNECT_FAILED',
] as const

describe('import diagnostic boundary remains independent of display-only codes', () => {
  it.each(['zh-CN', 'en-US'] as const)('retains the import template and diagnostic code in %s', locale => {
    for (const code of [...displayOnlyCodes, 'IMPORT_RUN_REFRESH_PROJECTION_FAILED']) {
      const message = translate(locale, 'error.importRunCheckFailed', { code })
      expect(knownAppErrorMessage(locale, code), code).toBeUndefined()
      expect(explainImportRunFailure(new Error(code), locale), code).toEqual({ error: message, errorCode: code })
      expect(persistedImportRunFailure(`Error invoking remote method 'fictional': Error: ${code}`, locale), code).toBe(message)
    }
  })
})

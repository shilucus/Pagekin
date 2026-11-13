import { describe, expect, it, vi } from 'vitest'
import { knownAppErrorMessage } from '../../../src/i18n/app-errors'
import { translate } from '../../../src/i18n/core'

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' } }))
vi.mock('../../repositories/import-run-repository', () => ({
  ImportRunRepository: { get: vi.fn(() => { throw new Error('FICTIONAL_DATABASE_READ_FORBIDDEN') }) },
}))
import { explainImportRunFailure, persistedImportRunFailure } from '../import-run-failure'

const code = 'IMPORT_RUN_REFRESH_PROJECTION_FAILED'

describe('finite reference refresh failure projection', () => {
  it.each(['zh-CN', 'en-US'] as const)('keeps the existing import-check template and diagnostic in %s', locale => {
    const message = translate(locale, 'error.importRunCheckFailed', { code })
    expect(knownAppErrorMessage(locale, code)).toBeUndefined()
    expect(explainImportRunFailure(new Error(code), locale)).toEqual({ error: message, errorCode: code })
    expect(persistedImportRunFailure(`Error invoking remote method 'reference-knowledge:v1:refresh': Error: ${code}`, locale)).toBe(message)
  })
})

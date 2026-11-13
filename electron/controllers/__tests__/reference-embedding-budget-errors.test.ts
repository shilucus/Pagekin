import { describe, expect, it, vi } from 'vitest'
import type { Locale } from '../../../src/i18n/types'
import type { ReferenceEmbeddingBudgetErrorCode } from '../../services/reference-embedding-budget-contract'

const mock = vi.hoisted(() => ({ locale: 'en-US' as 'zh-CN' | 'en-US' }))
vi.mock('electron', () => ({
  app: { getLocale: () => mock.locale, isPackaged: false },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('../../repositories/import-run-repository', () => ({
  ImportRunRepository: { get: () => ({ locale: mock.locale }) },
}))

import { knownAppErrorMessage, importGenerationStopMessage } from '../../../src/i18n/app-errors'
import { translate } from '../../../src/i18n/core'
import { EmbeddingDispatchBarrierError } from '../../services/reference-embedding-dispatch-contract'
import { referenceEmbeddingBudgetFailure } from '../../services/reference-embedding-budget-contract'
import { explainImportRunFailure } from '../import-run-failure'
import { explainReferenceImportFailure } from '../kb-controller'

const codes = [
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_REQUIRED',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_INVALID',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_EXHAUSTED',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_ACTIVE_TIME_EXHAUSTED',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_RECOVERY_UNKNOWN',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_HISTORY_UNBUDGETED',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_PLAN_CONFLICT',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_PERSISTENCE_FAILED',
  'KNOWLEDGE_BASE_REFERENCE_BUDGET_HISTORY_FROZEN',
] as const satisfies readonly ReferenceEmbeddingBudgetErrorCode[]

describe('reference embedding budget failure presentation', () => {
  it.each(['zh-CN', 'en-US'] as const)('keeps every budget barrier and exact diagnostic code in the existing %s check-failed paths', locale => {
    mock.locale = locale
    for (const code of codes) {
      let caught: unknown
      try { referenceEmbeddingBudgetFailure(code) } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(EmbeddingDispatchBarrierError)
      expect(caught).toMatchObject({ code, message: code })
      expect(knownAppErrorMessage(locale, code)).toBeUndefined()
      expect(importGenerationStopMessage(locale, code)).toBeUndefined()
      expect(explainImportRunFailure(caught, locale)).toEqual({
        errorCode: code, error: translate(locale, 'error.importRunCheckFailed', { code }),
      })
      const expected = referenceCheckText(locale, code)
      expect(explainReferenceImportFailure({ success: false, error: code }, 'fictional-run')).toEqual({
        success: false, errorCode: code, error: expected,
      })
      expect(expected).not.toBe(translate(locale, 'error.importBudgetReached'))
    }
  })
})

function referenceCheckText(locale: Locale, code: ReferenceEmbeddingBudgetErrorCode): string {
  return locale === 'zh-CN' ? `参照章节未能写入知识库（校验未通过：${code}）。`
    : `The reference chapter could not be written to the knowledge base (check failed: ${code}).`
}

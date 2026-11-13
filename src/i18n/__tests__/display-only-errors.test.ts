import { describe, expect, it } from 'vitest'
import { appErrorMessage, displayedErrorMessage, errorCodeOf, knownAppErrorMessage } from '../app-errors'
import { translate } from '../core'

const diagnostics = [
  'GENERATION_PROJECT_CLOSE_FAILED', 'RUNTIME_FEEDBACK_RESOURCES_CHANGED',
  'GENERATION_OWNER_BUSY', 'RUNTIME_FEEDBACK_HANDOFF_FAILED',
  'RUNTIME_FEEDBACK_CAPABILITY_REQUIRED', 'MCP_TRANSPORT_CLOSED',
  'MCP_TOOL_FAILED', 'MCP_TRANSPORT_ERROR', 'MCP_TRANSPORT_UNAVAILABLE',
  'MCP_REQUEST_REJECTED', 'CHARACTER_ROSTER_SCHEMA_MISSING',
  'GENERATION_AGENT_CLOSING', 'GENERATION_AGENT_GLOBAL_EXECUTION_STALE',
  'GENERATION_OWNER_CLOSING', 'RUNTIME_FEEDBACK_REVOKE_CLEANUP_FAILED',
  'RUNTIME_FEEDBACK_PREPARE_ROLLBACK_FAILED', 'RUNTIME_FEEDBACK_EXECUTION_CLEANUP_FAILED',
  'RUNTIME_FEEDBACK_CLOSE_QUIESCE_FAILED', 'GENERATION_BATCH_PROJECT_CORE_MISSING',
  'GENERATION_BATCH_BLUEPRINT_MISSING', 'GENERATION_DRAFT_REQUIRED_PREDECESSOR_MISSING',
  'IMPORT_RUN_CANCEL_REQUEST_FAILED', 'BLUEPRINT_CHANGES_EMPTY',
  'BLUEPRINT_CHARACTERS_INVALID', 'MCP_DISCONNECT_FAILED',
] as const

describe.each(['zh-CN', 'en-US'] as const)('display-only diagnostic boundary in %s', locale => {
  it.each(diagnostics)('explains %s without registering a safe failure code', code => {
    const expected = translate(locale, 'error.unknown', { message: code })
    const wrapped = `Error invoking remote method 'fictional:operation': DiagnosticError: ${code}`
    for (const error of [code, new Error(code), wrapped, new Error(wrapped), { code }, { errorCode: code }]) {
      expect(knownAppErrorMessage(locale, error)).toBeUndefined()
      expect(errorCodeOf(error)).toBe(code)
      expect(displayedErrorMessage(locale, error)).toBe(expected)
    }
    expect(appErrorMessage(locale, new Error(code))).toBe(expected)
    expect(expected).not.toContain('{message}')
    expect(expected).not.toMatch(/retry|try again|generate again|continue import/iu)
  })

  it('keeps an existing known candidate ahead of a display-only message', () => {
    const error = Object.assign(new Error('GENERATION_OWNER_BUSY'), { code: 'PROJECT_NOT_OPEN' })
    expect(displayedErrorMessage(locale, error)).toBe(knownAppErrorMessage(locale, 'PROJECT_NOT_OPEN'))
    expect(appErrorMessage(locale, error)).toBe(knownAppErrorMessage(locale, 'PROJECT_NOT_OPEN'))
    expect(errorCodeOf(error)).toBe('GENERATION_OWNER_BUSY')
  })

  it('retains the existing known message priority over another object code', () => {
    const error = Object.assign(new Error('PROJECT_NOT_OPEN'), { code: 'MCP_DISCONNECT_FAILED' })
    expect(displayedErrorMessage(locale, error)).toBe(knownAppErrorMessage(locale, 'PROJECT_NOT_OPEN'))
    expect(errorCodeOf(error)).toBe('PROJECT_NOT_OPEN')
  })

  it('does not reinterpret unknown codes,prose or embedded diagnostic text', () => {
    for (const message of ['GENERATION_SOMETHING_NEW', 'disk full', 'GENERATION_OWNER_BUSY: fictional diagnostic detail']) {
      expect(displayedErrorMessage(locale, new Error(message))).toBe(message)
      expect(knownAppErrorMessage(locale, message)).toBeUndefined()
    }
    expect(displayedErrorMessage(locale, { message: 'fictional detail' })).toBe('fictional detail')
    expect(displayedErrorMessage(locale, null, 'fictional fallback')).toBe('fictional fallback')
  })

  it('uses only a stable display code instead of an unrelated object message', () => {
    expect(displayedErrorMessage(locale, { code: 'GENERATION_OWNER_BUSY', message: 'fictional private detail' }))
      .toBe(translate(locale, 'error.unknown', { message: 'GENERATION_OWNER_BUSY' }))
  })
})

it('freezes the finite diagnostic inventory without aliases', () => {
  expect(diagnostics).toHaveLength(25)
  expect(new Set(diagnostics).size).toBe(25)
})

import { describe, expect, it } from 'vitest'
import {
  INBOUND_COMMANDS,
  INBOUND_ERROR_CODES,
  InboundDomainError,
  normalizePayload,
  validateHostHeader,
  validateInboundRequest,
  validateOriginHeader,
} from '../inbound-domain-contract'

describe('inbound-domain-contract', () => {
  describe('normalizePayload', () => {
    it('produces identical hash regardless of key order', () => {
      const obj1 = { b: 2, a: 1, c: { y: 'hello', x: 'world' } }
      const obj2 = { a: 1, c: { x: 'world', y: 'hello' }, b: 2 }

      const res1 = normalizePayload(obj1)
      const res2 = normalizePayload(obj2)

      expect(res1.hash).toBe(res2.hash)
      expect(res1.jsonString).toBe(res2.jsonString)
      expect(res1.jsonString).toBe('{"a":1,"b":2,"c":{"x":"world","y":"hello"}}')
    })

    it('handles arrays and primitives inside objects', () => {
      const payload = {
        items: [3, 2, 1],
        meta: { title: 'Chapter 1' },
      }
      const res = normalizePayload(payload)
      expect(res.jsonString).toBe('{"items":[3,2,1],"meta":{"title":"Chapter 1"}}')
      expect(res.hash).toHaveLength(64)
    })
  })

  describe('validateInboundRequest', () => {
    const validRequest = {
      callerId: 'cli-agent-1',
      token: 'test-valid-token-123',
      projectId: 'project-novel-1',
      grantId: 'grant-456',
      command: 'workflow:start' as const,
      idempotencyKey: 'idem-uuid-001',
      payload: { chapterId: 'ch-1' },
    }

    it('passes a fully valid request', () => {
      expect(() => validateInboundRequest(validRequest)).not.toThrow()
    })

    it('throws COMMAND_NOT_ALLOWED for forbidden commands', () => {
      const invalid = { ...validRequest, command: 'dangerous:drop_database' }
      expect(() => validateInboundRequest(invalid)).toThrowError(InboundDomainError)
      try {
        validateInboundRequest(invalid)
      } catch (err: unknown) {
        expect((err as InboundDomainError).code).toBe(INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED)
      }
    })

    it('throws UNAUTHORIZED_TOKEN when callerId or token is missing', () => {
      expect(() => validateInboundRequest({ ...validRequest, callerId: '' })).toThrowError(
        /Missing or invalid callerId/,
      )
      expect(() => validateInboundRequest({ ...validRequest, token: '' })).toThrowError(
        /Missing or invalid authentication token/,
      )
    })

    it('throws PROJECT_GRANT_INVALID when projectId or grantId is missing', () => {
      expect(() => validateInboundRequest({ ...validRequest, projectId: '' })).toThrowError(
        /Missing or invalid projectId/,
      )
      expect(() => validateInboundRequest({ ...validRequest, grantId: '' })).toThrowError(
        /Missing or invalid grantId/,
      )
    })

    it('throws PATH_TRAVERSAL_DETECTED when path traversal pattern exists in payload', () => {
      const traversalReq = {
        ...validRequest,
        payload: { targetFile: '../../../../etc/passwd' },
      }
      expect(() => validateInboundRequest(traversalReq)).toThrowError(InboundDomainError)
      try {
        validateInboundRequest(traversalReq)
      } catch (err: unknown) {
        expect((err as InboundDomainError).code).toBe(INBOUND_ERROR_CODES.PATH_TRAVERSAL_DETECTED)
      }
    })

    it('throws SQL_PROHIBITED when raw SQL statement is passed in payload', () => {
      const sqlReq = {
        ...validRequest,
        payload: { query: 'SELECT * FROM chapters WHERE 1=1' },
      }
      expect(() => validateInboundRequest(sqlReq)).toThrowError(InboundDomainError)
      try {
        validateInboundRequest(sqlReq)
      } catch (err: unknown) {
        expect((err as InboundDomainError).code).toBe(INBOUND_ERROR_CODES.SQL_PROHIBITED)
      }
    })

    it('throws PAYLOAD_SIZE_EXCEEDED when payload exceeds 512KB', () => {
      const hugeString = 'A'.repeat(600 * 1024)
      const hugeReq = {
        ...validRequest,
        payload: { bigData: hugeString },
      }
      expect(() => validateInboundRequest(hugeReq)).toThrowError(InboundDomainError)
      try {
        validateInboundRequest(hugeReq)
      } catch (err: unknown) {
        expect((err as InboundDomainError).code).toBe(INBOUND_ERROR_CODES.PAYLOAD_SIZE_EXCEEDED)
      }
    })
  })

  describe('validateHostHeader', () => {
    it('accepts loopback host names', () => {
      expect(() => validateHostHeader('127.0.0.1')).not.toThrow()
      expect(() => validateHostHeader('127.0.0.1:5180')).not.toThrow()
      expect(() => validateHostHeader('localhost:8080')).not.toThrow()
      expect(() => validateHostHeader('[::1]:9000')).not.toThrow()
    })

    it('rejects external or dangerous hosts', () => {
      expect(() => validateHostHeader('example.com')).toThrowError(InboundDomainError)
      expect(() => validateHostHeader('192.168.1.100:8080')).toThrowError(InboundDomainError)
      expect(() => validateHostHeader(null)).toThrowError(/Missing Host header/)
    })
  })

  describe('validateOriginHeader', () => {
    it('accepts undefined/null origin (CLI calls)', () => {
      expect(() => validateOriginHeader(undefined)).not.toThrow()
      expect(() => validateOriginHeader(null)).not.toThrow()
    })

    it('accepts local webview or local origins', () => {
      expect(() => validateOriginHeader('http://localhost:5180')).not.toThrow()
      expect(() => validateOriginHeader('http://127.0.0.1:3000')).not.toThrow()
      expect(() => validateOriginHeader('vscode-webview://my-extension')).not.toThrow()
      expect(() => validateOriginHeader('ai-novel://local')).not.toThrow()
    })

    it('rejects external website origins', () => {
      expect(() => validateOriginHeader('https://attacker-site.com')).toThrowError(InboundDomainError)
      expect(() => validateOriginHeader('http://malicious.cn:8080')).toThrowError(InboundDomainError)
    })
  })

  describe('command whitelist completeness', () => {
    it('contains all required API-001 commands', () => {
      expect(INBOUND_COMMANDS).toContain('project:get')
      expect(INBOUND_COMMANDS).toContain('project:list')
      expect(INBOUND_COMMANDS).toContain('workflow:start')
      expect(INBOUND_COMMANDS).toContain('workflow:resume')
      expect(INBOUND_COMMANDS).toContain('workflow:get')
      expect(INBOUND_COMMANDS).toContain('workflow:events')
      expect(INBOUND_COMMANDS).toContain('workflow:receipt')
      expect(INBOUND_COMMANDS).toContain('human-review:list')
      expect(INBOUND_COMMANDS).toContain('human-review:approve')
    })
  })
})

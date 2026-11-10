import { createHash } from 'node:crypto'

export const INBOUND_COMMANDS = [
  'project:get',
  'project:list',
  'workflow:start',
  'workflow:resume',
  'workflow:get',
  'workflow:events',
  'workflow:receipt',
  'human-review:list',
  'human-review:approve',
] as const

export type InboundCommand = (typeof INBOUND_COMMANDS)[number]

export const INBOUND_TOKEN_SCOPES = ['task', 'human_review', 'admin'] as const
export type InboundTokenScope = (typeof INBOUND_TOKEN_SCOPES)[number]

export const MAX_INBOUND_PAYLOAD_BYTES = 512 * 1024 // 512 KB

export const INBOUND_ERROR_CODES = {
  COMMAND_NOT_ALLOWED: 'COMMAND_NOT_ALLOWED',
  IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
  UNAUTHORIZED_TOKEN: 'UNAUTHORIZED_TOKEN',
  INSUFFICIENT_SCOPE: 'INSUFFICIENT_SCOPE',
  HUMAN_REVIEW_SCOPE_REQUIRED: 'HUMAN_REVIEW_SCOPE_REQUIRED',
  UNKNOWN_STATUS_NON_RETRYABLE: 'UNKNOWN_STATUS_NON_RETRYABLE',
  PAYLOAD_SIZE_EXCEEDED: 'PAYLOAD_SIZE_EXCEEDED',
  PATH_TRAVERSAL_DETECTED: 'PATH_TRAVERSAL_DETECTED',
  SQL_PROHIBITED: 'SQL_PROHIBITED',
  PROJECT_GRANT_INVALID: 'PROJECT_GRANT_INVALID',
  INVALID_HOST_HEADER: 'INVALID_HOST_HEADER',
  INVALID_ORIGIN_HEADER: 'INVALID_ORIGIN_HEADER',
} as const

export type InboundErrorCode = (typeof INBOUND_ERROR_CODES)[keyof typeof INBOUND_ERROR_CODES]

export class InboundDomainError extends Error {
  public readonly code: InboundErrorCode
  public readonly status: number

  constructor(code: InboundErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'InboundDomainError'
    this.code = code
    this.status = status
  }
}

export interface InboundAuthToken {
  token: string
  callerId: string
  scopes: InboundTokenScope[]
  allowedProjectIds: string[]
  expiresAt: number // timestamp ms
  revoked?: boolean
}

export interface InboundRequest<TPayload = Record<string, unknown>> {
  callerId: string
  token: string
  projectId: string
  grantId: string
  command: InboundCommand
  idempotencyKey: string
  payload: TPayload
  sequenceCursor?: number
}

export interface InboundEvent {
  sequenceNumber: number
  taskId: string
  projectId: string
  type: 'status_changed' | 'step_completed' | 'log' | 'review_required' | 'receipt_issued'
  timestamp: number
  data: Record<string, unknown>
}

export interface InboundReceipt {
  operationKey: string
  idempotencyKey: string
  projectId: string
  grantId: string
  command: InboundCommand
  payloadHash: string
  status: 'succeeded' | 'failed' | 'unknown' | 'pending_review'
  result?: Record<string, unknown>
  error?: {
    code: string
    message: string
  }
  createdAt: number
  completedAt?: number
}

/**
 * Deterministically normalizes any JSON-compatible object by sorting all object keys recursively.
 * Returns the normalized JSON string and its SHA-256 hex digest.
 */
export function normalizePayload(data: unknown): { jsonString: string; hash: string } {
  function sortKeys(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value
    }
    if (Array.isArray(value)) {
      return value.map(sortKeys)
    }
    const record = value as Record<string, unknown>
    const sortedKeys = Object.keys(record).sort()
    const result: Record<string, unknown> = {}
    for (const key of sortedKeys) {
      if (record[key] !== undefined) {
        result[key] = sortKeys(record[key])
      }
    }
    return result
  }

  const sorted = sortKeys(data)
  const jsonString = JSON.stringify(sorted)
  const hash = createHash('sha256').update(jsonString, 'utf-8').digest('hex')
  return { jsonString, hash }
}

/**
 * Validates the inbound request envelope, payload structure, size, command whitelist,
 * and security boundaries (path traversal, SQL patterns).
 */
export function validateInboundRequest(request: unknown): asserts request is InboundRequest {
  if (!request || typeof request !== 'object') {
    throw new InboundDomainError(INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED, 'Inbound request must be an object', 400)
  }

  const req = request as Partial<InboundRequest>

  if (!req.callerId || typeof req.callerId !== 'string') {
    throw new InboundDomainError(INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN, 'Missing or invalid callerId', 401)
  }
  if (!req.token || typeof req.token !== 'string') {
    throw new InboundDomainError(INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN, 'Missing or invalid authentication token', 401)
  }
  if (!req.projectId || typeof req.projectId !== 'string') {
    throw new InboundDomainError(INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID, 'Missing or invalid projectId', 400)
  }
  if (!req.grantId || typeof req.grantId !== 'string') {
    throw new InboundDomainError(INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID, 'Missing or invalid grantId', 400)
  }
  if (!req.command || typeof req.command !== 'string' || !INBOUND_COMMANDS.includes(req.command as InboundCommand)) {
    throw new InboundDomainError(INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED, `Command '${req.command}' is not in the whitelist`, 403)
  }
  if (!req.idempotencyKey || typeof req.idempotencyKey !== 'string') {
    throw new InboundDomainError(INBOUND_ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH, 'Missing or invalid idempotencyKey', 400)
  }

  // Validate payload size
  const payloadStr = JSON.stringify(req.payload ?? {})
  if (Buffer.byteLength(payloadStr, 'utf-8') > MAX_INBOUND_PAYLOAD_BYTES) {
    throw new InboundDomainError(INBOUND_ERROR_CODES.PAYLOAD_SIZE_EXCEEDED, `Payload size exceeds limit of ${MAX_INBOUND_PAYLOAD_BYTES} bytes`, 413)
  }

  // Deep inspection for forbidden patterns (Path Traversal, Raw SQL, Preload exposure)
  inspectForbiddenPayloadPatterns(req.payload)
}

function inspectForbiddenPayloadPatterns(payload: unknown, depth = 0): void {
  if (depth > 20 || !payload || typeof payload !== 'object') {
    if (typeof payload === 'string') {
      checkForbiddenString(payload)
    }
    return
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      inspectForbiddenPayloadPatterns(item, depth + 1)
    }
    return
  }

  for (const [key, val] of Object.entries(payload as Record<string, unknown>)) {
    checkForbiddenString(key)
    inspectForbiddenPayloadPatterns(val, depth + 1)
  }
}

function checkForbiddenString(str: string): void {
  // Path traversal check
  if (str.includes('../') || str.includes('..\\') || str === '..') {
    throw new InboundDomainError(INBOUND_ERROR_CODES.PATH_TRAVERSAL_DETECTED, 'Forbidden path traversal detected in payload', 400)
  }

  // Dangerous direct SQL keywords in commands
  const upper = str.toUpperCase().trim()
  if (
    upper.startsWith('SELECT ') ||
    upper.startsWith('INSERT INTO ') ||
    upper.startsWith('DROP TABLE ') ||
    upper.startsWith('DELETE FROM ') ||
    upper.startsWith('UPDATE ') ||
    upper.startsWith('UNION SELECT ')
  ) {
    throw new InboundDomainError(INBOUND_ERROR_CODES.SQL_PROHIBITED, 'Direct SQL statements are strictly prohibited', 400)
  }
}

function parseHeaderAuthority(protocol: string, authority: string): URL | null {
  // URL parsing can discard controls and reinterpret separators; reject them before parsing.
  if (
    !authority ||
    authority.endsWith(':') ||
    /[\\/?#@,\s]/.test(authority) ||
    Array.from(authority).some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    return null
  }

  try {
    const parsed = new URL(`${protocol}//${authority}`)
    return parsed.hostname && !parsed.username && !parsed.password ? parsed : null
  } catch {
    return null
  }
}

/**
 * Validates a single loopback Host authority without accepting URL-normalized aliases.
 */
export function validateHostHeader(host?: string | null): void {
  if (!host) {
    throw new InboundDomainError(INBOUND_ERROR_CODES.INVALID_HOST_HEADER, 'Missing Host header', 400)
  }
  const cleanHost = host.trim().toLowerCase()
  const isLoopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(cleanHost)

  if (!isLoopback || !parseHeaderAuthority('http:', cleanHost)) {
    throw new InboundDomainError(INBOUND_ERROR_CODES.INVALID_HOST_HEADER, 'Host header is not a permitted loopback authority', 403)
  }
}

/**
 * Validates a single origin using the existing loopback and custom-protocol policy.
 */
export function validateOriginHeader(origin?: string | null): void {
  if (!origin) {
    return // CLI/Curl usually don't set Origin, which is completely fine
  }
  const cleanOrigin = origin.trim().toLowerCase()
  const originParts = /^(http:|vscode-webview:|ai-novel:)\/\/(.+)$/.exec(cleanOrigin)
  const protocol = originParts?.[1]
  const authority = originParts?.[2]
  const parsed = protocol && authority ? parseHeaderAuthority(protocol, authority) : null
  const isAllowedOrigin = authority && parsed && (
    protocol !== 'http:' || /^(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/.test(authority)
  )

  if (!isAllowedOrigin) {
    throw new InboundDomainError(INBOUND_ERROR_CODES.INVALID_ORIGIN_HEADER, 'Origin header is not permitted to access local domain API', 403)
  }
}

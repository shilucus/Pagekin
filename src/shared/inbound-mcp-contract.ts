/**
 * Inbound Narrow-Domain MCP Adapter Contract (MCP-001)
 *
 * Exposes narrow domain tools over standard MCP JSON-RPC 2.0 protocol
 * delegating all actual operations to InboundApiService without creating
 * a secondary execution kernel.
 */

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

export interface McpJsonRpcRequest<TParams = Record<string, unknown>> {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: TParams
}

export interface McpJsonRpcResponse<TResult = unknown> {
  jsonrpc: '2.0'
  id: string | number | null
  result?: TResult
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface McpCallToolParams {
  name: string
  arguments: {
    token: string
    callerId?: string
    projectId?: string
    grantId?: string
    idempotencyKey?: string
    payload?: Record<string, unknown>
    [key: string]: unknown
  }
}

export interface McpCallToolResult {
  content: Array<{
    type: 'text'
    text: string
  }>
  isError?: boolean
}

/**
 * Narrow domain MCP tool whitelist.
 * Explicitly forbids SQL, arbitrary file access, full preload, or OS process execution.
 */
export const INBOUND_MCP_TOOL_NAMES = [
  'pagekin_get_project',
  'pagekin_list_projects',
  'pagekin_start_workflow',
  'pagekin_get_workflow',
  'pagekin_query_events',
  'pagekin_get_receipt',
  'pagekin_list_human_reviews',
  'pagekin_get_preliminary_report',
] as const

export type InboundMcpToolName = (typeof INBOUND_MCP_TOOL_NAMES)[number]

export const INBOUND_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'pagekin_get_project',
    description: 'Get project summary and configuration for a specified novel project',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Inbound authentication token' },
        callerId: { type: 'string', description: 'Optional caller identifier bound to token' },
        projectId: { type: 'string', description: 'Target project ID' },
      },
      required: ['token', 'projectId'],
    },
  },
  {
    name: 'pagekin_list_projects',
    description: 'List all novel projects authorized under caller token',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Inbound authentication token' },
        callerId: { type: 'string', description: 'Optional caller identifier bound to token' },
        projectId: { type: 'string', description: 'Optional project ID filter' },
      },
      required: ['token'],
    },
  },
  {
    name: 'pagekin_start_workflow',
    description: 'Start a bounded novel creation workflow task (outline, character, blueprint, draft)',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Inbound authentication token' },
        callerId: { type: 'string', description: 'Optional caller identifier bound to token' },
        projectId: { type: 'string', description: 'Target project ID' },
        grantId: { type: 'string', description: 'Task authorization grant ID' },
        idempotencyKey: { type: 'string', description: 'Unique idempotency key' },
        payload: {
          type: 'object',
          description: 'Creation task payload (e.g. stage, prompt, chapterRange)',
        },
      },
      required: ['token', 'projectId', 'grantId', 'idempotencyKey'],
    },
  },
  {
    name: 'pagekin_get_workflow',
    description: 'Query task status, step progress and error diagnosis',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Inbound authentication token' },
        callerId: { type: 'string', description: 'Optional caller identifier bound to token' },
        projectId: { type: 'string', description: 'Target project ID' },
        payload: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Target workflow task ID' },
          },
          required: ['taskId'],
        },
      },
      required: ['token', 'projectId'],
    },
  },
  {
    name: 'pagekin_query_events',
    description: 'Query streaming structure events and progress logs for a running task',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Inbound authentication token' },
        callerId: { type: 'string', description: 'Optional caller identifier bound to token' },
        projectId: { type: 'string', description: 'Target project ID' },
        payload: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Target workflow task ID' },
            afterSequence: { type: 'number', description: 'Cursor offset sequence' },
          },
          required: ['taskId'],
        },
      },
      required: ['token', 'projectId'],
    },
  },
  {
    name: 'pagekin_get_receipt',
    description: 'Retrieve immutable execution receipt upon workflow step completion',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Inbound authentication token' },
        callerId: { type: 'string', description: 'Optional caller identifier bound to token' },
        projectId: { type: 'string', description: 'Target project ID' },
        payload: {
          type: 'object',
          properties: {
            targetIdempotencyKey: { type: 'string', description: 'Target workflow idempotency key' },
            taskId: { type: 'string', description: 'Optional target workflow task ID' },
          },
        },
      },
      required: ['token', 'projectId'],
    },
  },
  {
    name: 'pagekin_list_human_reviews',
    description: 'List pending proposals requiring author human review (requires human_review/admin scope)',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Inbound authentication token' },
        callerId: { type: 'string', description: 'Optional caller identifier bound to token' },
        projectId: { type: 'string', description: 'Target project ID' },
      },
      required: ['token', 'projectId'],
    },
  },
  {
    name: 'pagekin_get_preliminary_report',
    description: 'Retrieve structured preliminary acceptance report (scope, continuity, quality)',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Inbound authentication token' },
        callerId: { type: 'string', description: 'Optional caller identifier bound to token' },
        projectId: { type: 'string', description: 'Target project ID' },
        payload: {
          type: 'object',
          properties: {
            reportId: { type: 'string', description: 'Preliminary report ID' },
          },
          required: ['reportId'],
        },
      },
      required: ['token', 'projectId'],
    },
  },
] as const

// Detect real malicious SQL injection attempts (e.g. statement chains with semicolon or union injection),
// without false-positive blocking of common English creative writing words (select, drop, alter, union).
const MALICIOUS_SQL_INJECTION = /(;\s*(DROP|ALTER|TRUNCATE|DELETE)\s+TABLE|\bUNION\s+SELECT\b|'\s*OR\s*'1'\s*=\s*'1)/i
const PATH_TRAVERSAL_PATTERN = /(\.\.[/\\]|[/\\]etc[/\\]|[/\\]system32[/\\])/i

export function validateMcpToolCall(params: McpCallToolParams): { valid: boolean; reason?: string } {
  if (!params || typeof params !== 'object') {
    return { valid: false, reason: 'Invalid tool call parameters' }
  }

  if (!INBOUND_MCP_TOOL_NAMES.includes(params.name as InboundMcpToolName)) {
    return {
      valid: false,
      reason: `Tool [${params.name}] is not permitted. Only narrow domain tools are whitelisted.`,
    }
  }

  const args = params.arguments
  if (!args || typeof args !== 'object') {
    return { valid: false, reason: 'Tool arguments must be an object' }
  }

  if (!args.token || typeof args.token !== 'string') {
    return { valid: false, reason: 'Missing or invalid authentication token' }
  }

  // Security check: Scan argument values for prohibited SQL injection or path traversal attempts
  const argsString = JSON.stringify(args)
  if (MALICIOUS_SQL_INJECTION.test(argsString)) {
    return { valid: false, reason: 'Malicious SQL injection attempt detected in MCP tool call' }
  }

  if (PATH_TRAVERSAL_PATTERN.test(argsString)) {
    return { valid: false, reason: 'Path traversal expressions are strictly prohibited' }
  }

  return { valid: true }
}

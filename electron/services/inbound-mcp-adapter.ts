import {
  type InboundCommand,
  InboundDomainError,
  type InboundReceipt,
  type InboundRequest,
} from '../../src/shared/inbound-domain-contract'
import {
  type InboundMcpToolName,
  INBOUND_MCP_TOOL_NAMES,
  INBOUND_MCP_TOOLS,
  type McpCallToolParams,
  type McpCallToolResult,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  validateMcpToolCall,
} from '../../src/shared/inbound-mcp-contract'
import type { InboundApiService } from './inbound-api-service'

const TOOL_COMMAND_MAPPING: Record<InboundMcpToolName, InboundCommand> = {
  pagekin_get_project: 'project:get',
  pagekin_list_projects: 'project:list',
  pagekin_start_workflow: 'workflow:start',
  pagekin_get_workflow: 'workflow:get',
  pagekin_query_events: 'workflow:events',
  pagekin_get_receipt: 'workflow:receipt',
  pagekin_list_human_reviews: 'human-review:list',
  pagekin_get_preliminary_report: 'workflow:get',
}

export class InboundMcpAdapter {
  constructor(private readonly apiService: InboundApiService) {}

  /**
   * Dispatches incoming JSON-RPC 2.0 messages from MCP client transports (stdio / SSE).
   */
  public async handleMessage(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    if (!request || request.jsonrpc !== '2.0' || !request.method) {
      return {
        jsonrpc: '2.0',
        id: request?.id ?? null,
        error: {
          code: -32600,
          message: 'Invalid Request: jsonrpc must be "2.0" and method must be defined',
        },
      }
    }

    try {
      if (request.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: {
            tools: [...INBOUND_MCP_TOOLS],
          },
        }
      }

      if (request.method === 'tools/call') {
        const params = request.params as unknown as McpCallToolParams
        const callResult = await this.handleToolCall(params)
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: callResult,
        }
      }

      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: -32601,
          message: `Method '${request.method}' not found. Only 'tools/list' and 'tools/call' are supported.`,
        },
      }
    } catch (err: unknown) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  /**
   * Executes a narrow domain tool by validating arguments and delegating to InboundApiService.
   */
  private async handleToolCall(params: McpCallToolParams): Promise<McpCallToolResult> {
    // 1. Validate tool name against whitelist and scan for prohibited inputs (malicious SQL injection, path traversal)
    const validation = validateMcpToolCall(params)
    if (!validation.valid) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'SECURITY_VALIDATION_FAILED',
              reason: validation.reason,
            }),
          },
        ],
        isError: true,
      }
    }

    const toolName = params.name as InboundMcpToolName
    const command = TOOL_COMMAND_MAPPING[toolName]
    const args = params.arguments

    // 2. Synthesize InboundRequest for domain API execution, auto-resolving token metadata
    const tokenRecord = this.apiService.getToken(args.token)
    const callerId = (args.callerId as string) || tokenRecord?.callerId || 'mcp-inbound-client'

    let projectId = (args.projectId as string) || ''
    if (toolName === 'pagekin_list_projects' && !projectId) {
      projectId = tokenRecord?.allowedProjectIds?.[0] || 'default'
    }

    const grantId = (args.grantId as string) || `mcp-grant-${toolName}`
    const idempotencyKey = (args.idempotencyKey as string) || `mcp-${toolName}-${Date.now()}`
    let payload = (args.payload as Record<string, unknown>) || {}

    // Align schema specific payloads for receipts and streaming events
    if (toolName === 'pagekin_get_receipt') {
      const targetKey = (payload.targetIdempotencyKey as string) || (payload.taskId as string) || ''
      payload = {
        ...payload,
        targetIdempotencyKey: targetKey,
        targetCommand: payload.targetCommand || 'workflow:start',
      }
    } else if (toolName === 'pagekin_query_events') {
      const afterSeq = payload.afterSequence ?? payload.fromSequence ?? 0
      payload = {
        ...payload,
        afterSequence: afterSeq,
      }
    }

    const domainReq: InboundRequest = {
      callerId,
      token: args.token,
      projectId,
      grantId,
      command,
      idempotencyKey,
      payload,
    }

    try {
      // 3. Delegate to shared InboundApiService kernel (sharing grants, scopes, idempotency & receipts)
      const receipt: InboundReceipt = await this.apiService.executeInboundRequest(domainReq)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(receipt, null, 2),
          },
        ],
        isError: receipt.status === 'failed' || receipt.status === 'unknown',
      }
    } catch (err: unknown) {
      if (err instanceof InboundDomainError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                errorCode: err.code,
                message: err.message,
                status: err.status,
              }),
            },
          ],
          isError: true,
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              errorCode: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      }
    }
  }

  /**
   * Utility to check whether a specific tool name is exposed by this inbound adapter.
   */
  public isToolSupported(toolName: string): boolean {
    return INBOUND_MCP_TOOL_NAMES.includes(toolName as InboundMcpToolName)
  }
}

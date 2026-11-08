import { describe, expect, it } from 'vitest'
import { InboundMcpAdapter } from '../inbound-mcp-adapter'
import { InboundApiService } from '../inbound-api-service'
import type { InboundReceipt } from '../../../src/shared/inbound-domain-contract'

describe('InboundMcpAdapter', () => {
  const createTestFixture = () => {
    const apiService = new InboundApiService()
    const adapter = new InboundMcpAdapter(apiService)

    // Issue a task-scoped token
    const taskToken = apiService.issueToken({
      callerId: 'test-mcp-client',
      scopes: ['task'],
      allowedProjectIds: ['proj-novel-1', 'proj-novel-2'],
    })

    // Issue a human_review-scoped token
    const reviewToken = apiService.issueToken({
      callerId: 'test-mcp-reviewer',
      scopes: ['human_review'],
      allowedProjectIds: ['proj-novel-1'],
    })

    return { apiService, adapter, taskToken, reviewToken }
  }

  it('handles tools/list returning exactly 8 whitelisted narrow domain tools', async () => {
    const { adapter } = createTestFixture()

    const response = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })

    expect(response.error).toBeUndefined()
    expect(response.result).toBeDefined()
    const result = response.result as { tools: Array<{ name: string }> }
    expect(result.tools.length).toBe(8)
    const toolNames = result.tools.map(t => t.name)
    expect(toolNames).toContain('pagekin_start_workflow')
    expect(toolNames).toContain('pagekin_get_workflow')
    expect(toolNames).toContain('pagekin_get_receipt')
    expect(toolNames).toContain('pagekin_list_projects')
    expect(toolNames).toContain('pagekin_query_events')
    expect(toolNames).toContain('pagekin_list_human_reviews')
    expect(toolNames).not.toContain('execute_command')
    expect(toolNames).not.toContain('sql_query')
  })

  it('executes allowed tool delegating to InboundApiService sharing token and idempotency', async () => {
    const { adapter, taskToken } = createTestFixture()

    const request = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'tools/call',
      params: {
        name: 'pagekin_start_workflow',
        arguments: {
          callerId: 'test-mcp-client',
          token: taskToken.token,
          projectId: 'proj-novel-1',
          grantId: 'grant-mcp-01',
          idempotencyKey: 'idem-mcp-task-01',
          payload: {
            workflowType: 'outline_generation',
            prompt: 'Please select three traits. A drop of dew. The union of clans.',
          },
        },
      },
    }

    const response = await adapter.handleMessage(request)
    expect(response.error).toBeUndefined()
    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBeFalsy()

    const receipt: InboundReceipt = JSON.parse(result.content[0].text)
    expect(receipt.operationKey).toBeDefined()
    expect(receipt.status).toBe('succeeded')
    expect(receipt.idempotencyKey).toBe('idem-mcp-task-01')

    // Replay with identical idempotencyKey -> returns same receipt without duplicate effect
    const replayResponse = await adapter.handleMessage(request)
    const replayResult = replayResponse.result as { content: Array<{ type: string; text: string }> }
    const replayReceipt: InboundReceipt = JSON.parse(replayResult.content[0].text)
    expect(replayReceipt.operationKey).toBe(receipt.operationKey)
  })

  it('handles pagekin_list_projects with only token and auto-resolves callerId and projects', async () => {
    const { adapter, taskToken } = createTestFixture()

    // Caller only passes token without callerId or projectId
    const response = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'pagekin_list_projects',
        arguments: {
          token: taskToken.token,
        },
      },
    })

    expect(response.error).toBeUndefined()
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBeFalsy()

    const receipt: InboundReceipt = JSON.parse(result.content[0].text)
    expect(receipt.status).toBe('succeeded')
    const projects = receipt.result?.projects as Array<{ projectId: string }>
    expect(projects.length).toBe(2)
    expect(projects.map(p => p.projectId)).toEqual(['proj-novel-1', 'proj-novel-2'])
  })

  it('queries events with cursor pagination and retrieves workflow receipt', async () => {
    const { adapter, taskToken } = createTestFixture()

    // 1. Start a workflow
    const startRes = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'pagekin_start_workflow',
        arguments: {
          token: taskToken.token,
          projectId: 'proj-novel-1',
          grantId: 'grant-mcp-events',
          idempotencyKey: 'idem-event-test',
          payload: {
            taskId: 'task-flow-101',
          },
        },
      },
    })
    expect(startRes.error).toBeUndefined()

    // 2. Query events with afterSequence cursor
    const eventsRes = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'pagekin_query_events',
        arguments: {
          token: taskToken.token,
          projectId: 'proj-novel-1',
          payload: {
            taskId: 'task-flow-101',
            afterSequence: 0,
          },
        },
      },
    })
    expect(eventsRes.error).toBeUndefined()
    const eventsResult = eventsRes.result as { content: Array<{ text: string }> }
    const eventReceipt: InboundReceipt = JSON.parse(eventsResult.content[0].text)
    expect(eventReceipt.status).toBe('succeeded')
    expect(Array.isArray(eventReceipt.result?.events)).toBe(true)

    // 3. Query receipt using targetIdempotencyKey
    const receiptRes = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'pagekin_get_receipt',
        arguments: {
          token: taskToken.token,
          projectId: 'proj-novel-1',
          grantId: 'grant-mcp-events',
          payload: {
            targetIdempotencyKey: 'idem-event-test',
          },
        },
      },
    })
    expect(receiptRes.error).toBeUndefined()
    const receiptResult = receiptRes.result as { content: Array<{ text: string }> }
    const receiptData: InboundReceipt = JSON.parse(receiptResult.content[0].text)
    expect(receiptData.status).toBe('succeeded')
    expect(receiptData.result?.receipt).toBeDefined()
  })

  it('rejects unauthorized tools outside the narrow whitelist', async () => {
    const { adapter, taskToken } = createTestFixture()

    const response = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'pagekin_execute_system_process' as unknown as string,
        arguments: {
          token: taskToken.token,
          projectId: 'proj-novel-1',
        },
      },
    })

    const result = response.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('SECURITY_VALIDATION_FAILED')
    expect(result.content[0].text).toContain('is not permitted')
  })

  it('rejects parameters containing real malicious SQL injection attempts', async () => {
    const { adapter, taskToken } = createTestFixture()

    const response = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'pagekin_get_project',
        arguments: {
          token: taskToken.token,
          projectId: "proj-novel-1'; DROP TABLE novels; --",
        },
      },
    })

    const result = response.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Malicious SQL injection attempt detected')
  })

  it('enforces human_review scope isolation preventing task credentials from self-approving', async () => {
    const { adapter, taskToken } = createTestFixture()

    // Task token tries to list human reviews (requires human_review scope)
    const response = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'pagekin_list_human_reviews',
        arguments: {
          token: taskToken.token,
          projectId: 'proj-novel-1',
        },
      },
    })

    const result = response.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('INSUFFICIENT_SCOPE')
  })

  it('rejects requests for ungranted projects', async () => {
    const { adapter, taskToken } = createTestFixture()

    const response = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'pagekin_get_project',
        arguments: {
          token: taskToken.token,
          projectId: 'proj-unauthorized-999',
        },
      },
    })

    const result = response.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('PROJECT_GRANT_INVALID')
  })

  it('returns standard JSON-RPC 2.0 error with id=null on unknown method or invalid format', async () => {
    const { adapter } = createTestFixture()

    const invalidRpc = await adapter.handleMessage({
      jsonrpc: '1.0' as unknown as '2.0',
      id: 11,
      method: 'tools/list',
    })
    expect(invalidRpc.error?.code).toBe(-32600)

    const unknownMethod = await adapter.handleMessage({
      jsonrpc: '2.0',
      id: 12,
      method: 'unknown/method',
    })
    expect(unknownMethod.error?.code).toBe(-32601)

    // Invalid format without id -> id is null
    const noIdRpc = await adapter.handleMessage({
      jsonrpc: '1.0' as unknown as '2.0',
      method: 'tools/list',
    })
    expect(noIdRpc.id).toBeNull()
    expect(noIdRpc.error?.code).toBe(-32600)
  })
})

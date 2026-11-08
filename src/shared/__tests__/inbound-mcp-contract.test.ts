import { describe, expect, it } from 'vitest'
import {
  INBOUND_MCP_TOOL_NAMES,
  INBOUND_MCP_TOOLS,
  validateMcpToolCall,
} from '../inbound-mcp-contract'

describe('InboundMcpContract', () => {
  it('defines exactly 8 whitelisted narrow domain tools without SQL or OS process capabilities', () => {
    expect(INBOUND_MCP_TOOL_NAMES.length).toBe(8)
    expect(INBOUND_MCP_TOOLS.length).toBe(8)

    const toolNames = INBOUND_MCP_TOOLS.map(t => t.name)
    expect(toolNames).toEqual(INBOUND_MCP_TOOL_NAMES)

    // Ensure none of the tools expose SQL, shell or arbitrary fs
    expect(toolNames.some(n => n.includes('sql') || n.includes('exec') || n.includes('file'))).toBe(false)
  })

  it('validates legitimate MCP tool parameters', () => {
    const validParams = {
      name: 'pagekin_start_workflow',
      arguments: {
        token: 'ink_inbound_valid_token_123',
        projectId: 'proj-001',
        grantId: 'grant-001',
        idempotencyKey: 'idem-001',
        payload: {
          stage: 'outline_generation',
          prompt: 'Generate an outline for a science fiction novel',
        },
      },
    }

    const check = validateMcpToolCall(validParams)
    expect(check.valid).toBe(true)
    expect(check.reason).toBeUndefined()
  })

  it('does NOT false-positive reject legitimate novel text containing common words (select, drop, alter, union)', () => {
    const novelCreativeParams = {
      name: 'pagekin_start_workflow',
      arguments: {
        token: 'ink_inbound_valid_token_123',
        projectId: 'proj-001',
        grantId: 'grant-001',
        idempotencyKey: 'idem-002',
        payload: {
          prompt: 'Please select three character traits. A drop of rain fell. He has an alter ego. The labor union held a strike.',
        },
      },
    }

    const check = validateMcpToolCall(novelCreativeParams)
    expect(check.valid).toBe(true)
    expect(check.reason).toBeUndefined()
  })

  it('rejects unauthorized or unknown tools', () => {
    const invalidTool = {
      name: 'execute_shell_command',
      arguments: {
        token: 'ink_inbound_valid_token_123',
      },
    }

    const check = validateMcpToolCall(invalidTool as unknown as Parameters<typeof validateMcpToolCall>[0])
    expect(check.valid).toBe(false)
    expect(check.reason).toContain('is not permitted')
  })

  it('rejects arguments containing real malicious SQL injection attempts', () => {
    const sqlParams = {
      name: 'pagekin_get_project',
      arguments: {
        token: 'ink_inbound_valid_token_123',
        projectId: 'proj-001; DROP TABLE chapters;',
      },
    }

    const check = validateMcpToolCall(sqlParams)
    expect(check.valid).toBe(false)
    expect(check.reason).toContain('Malicious SQL injection attempt detected')

    const unionParams = {
      name: 'pagekin_get_project',
      arguments: {
        token: 'ink_inbound_valid_token_123',
        projectId: 'proj-001 UNION SELECT * FROM users',
      },
    }

    const unionCheck = validateMcpToolCall(unionParams)
    expect(unionCheck.valid).toBe(false)
    expect(unionCheck.reason).toContain('Malicious SQL injection attempt detected')
  })

  it('rejects arguments containing path traversal attempts', () => {
    const pathTraversalParams = {
      name: 'pagekin_get_project',
      arguments: {
        token: 'ink_inbound_valid_token_123',
        projectId: '../../etc/passwd',
      },
    }

    const check = validateMcpToolCall(pathTraversalParams)
    expect(check.valid).toBe(false)
    expect(check.reason).toContain('Path traversal expressions are strictly prohibited')
  })
})

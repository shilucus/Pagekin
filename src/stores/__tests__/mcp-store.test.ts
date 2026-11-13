import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { MCPChannels, MCPToolCallResult } from '../../shared/ipc-channels'
import type { AgentGlobalToolExecution, AgentToolAction } from '../../shared/agent-generation'
import { runAgentLoop } from '../../services/agent/agent-engine'
import { AgentGenerationClient } from '../../services/agent/agent-generation-client'
import { toolRegistry, type AgentExecutionContext } from '../../services/agent/tool-registry'
import { translate } from '../../i18n/core'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  register: vi.fn(),
  unregisterBySource: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke: mocks.invoke },
}))

vi.mock('../../services/agent/tool-registry', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/agent/tool-registry')>()
  const register = actual.toolRegistry.register.bind(actual.toolRegistry)
  const unregisterBySource = actual.toolRegistry.unregisterBySource.bind(actual.toolRegistry)
  actual.toolRegistry.register = mocks.register.mockImplementation(register)
  actual.toolRegistry.unregisterBySource = mocks.unregisterBySource.mockImplementation(unregisterBySource)
  return actual
})

import { useLocaleStore } from '../locale-store'
import { useMCPStore } from '../mcp-store'

const originalLocale = useLocaleStore.getState().locale
const remoteToolName = 'mcp__safe-id__write_remote'
const execution: AgentGlobalToolExecution = { version: 1, token: 'fictional-main-issued-proof' }
const actionRef: AgentToolAction['ref'] = {
  handle: { projectId: 'fictional-project', epoch: 'fictional-epoch', rootActionId: 'fictional-root', runId: 'fictional-run' },
  attemptId: 'fictional-attempt', toolCallId: 'fictional-tool-call',
}

function registerRemoteTool() {
  useMCPStore.setState({ tools: [{ name: 'write_remote', description: 'Writes fictional remote state',
    inputSchema: { type: 'object' }, serverId: 'safe-id' }] })
  useMCPStore.getState().registerMCPToolsToRegistry()
  return toolRegistry.get(remoteToolName)!
}

function context(): AgentExecutionContext {
  return { projectSession: null, selectedModelId: 'fictional-model', uiLocale: 'en-US', writingLanguage: 'en-US' }
}

function callbacks() {
  return { onTextChunk: vi.fn(), onToolCallStart: vi.fn(), onToolCallComplete: vi.fn(),
    onToolCallConfirmRequired: vi.fn(async () => true), onDone: vi.fn(), onError: vi.fn() }
}

afterEach(() => {
  toolRegistry.unregisterBySource('mcp')
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
  useMCPStore.setState({
    servers: [],
    tools: [],
    resources: [],
    configPath: null,
    loading: false,
    error: null,
  })
})

describe('renderer MCP trust boundary', () => {
  it('initializes and connects using safe server ids only', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:get-config-path') return 'C:/isolated/.vela/mcp_config.json'
      if (channel === 'mcp:load-config') {
        return {
          success: true,
          status: 'loaded',
          servers: [{ id: 'safe-id', name: 'Safe server', transport: 'stdio' }],
        }
      }
      if (channel === 'mcp:connect') return { success: true }
      if (channel === 'mcp:get-servers-status') return []
      if (channel === 'mcp:list-tools' || channel === 'mcp:list-resources') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().init()

    expect(mocks.invoke).toHaveBeenCalledWith('mcp:connect', 'safe-id')
    expect(mocks.invoke.mock.calls.find(([channel]) => channel === 'mcp:connect')?.[1])
      .toBeTypeOf('string')
    expect(useMCPStore.getState()).toMatchObject({ loading: false, error: null })
  })

  it('shows corrupt configuration errors but treats missing configuration as empty', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:get-config-path') return 'C:/isolated/.vela/mcp_config.json'
      if (channel === 'mcp:load-config') {
        return { success: false, status: 'error', servers: [], error: 'MCP 配置损坏' }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().init()
    expect(useMCPStore.getState()).toMatchObject({ loading: false, error: 'MCP 配置损坏' })

    useMCPStore.setState({ error: null })
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:get-config-path') return 'C:/isolated/.vela/mcp_config.json'
      if (channel === 'mcp:load-config') {
        return { success: true, status: 'missing', servers: [] }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    await useMCPStore.getState().init()
    expect(useMCPStore.getState()).toMatchObject({ loading: false, error: null })
  })

  it('keeps the existing human-confirmation requirement for every registered MCP tool', () => {
    useMCPStore.setState({
      tools: [{
        name: 'write_remote',
        description: 'Writes remote state',
        inputSchema: { type: 'object' },
        serverId: 'safe-id',
      }],
    })

    useMCPStore.getState().registerMCPToolsToRegistry()

    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'mcp__safe-id__write_remote',
      requiresConfirmation: true,
      isReadOnly: false,
    }))
  })

  it('uses the versioned commit-state result and keeps the execution proof optional for direct callers', () => {
    expectTypeOf<MCPChannels['mcp:call-tool']['return']>().toEqualTypeOf<MCPToolCallResult>()
    expectTypeOf<MCPChannels['mcp:call-tool']['args']>()
      .toEqualTypeOf<[serverId: string, toolName: string, args: Record<string, unknown>, execution?: AgentGlobalToolExecution]>()
  })

  it('rejects a hosted call without main proof before marking or sending, ignoring a model-supplied proof', async () => {
    const tool = registerRemoteTool(), markSideEffectStarted = vi.fn()
    await expect(tool.execute({ globalToolExecution: execution }, { ...context(), agentToolAction: actionRef, markSideEffectStarted }))
      .rejects.toThrow('GENERATION_AGENT_GLOBAL_EXECUTION_REQUIRED')
    expect(markSideEffectStarted).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('passes hosted main proof separately from model arguments immediately after marking dispatch', async () => {
    const tool = registerRemoteTool(), markSideEffectStarted = vi.fn()
    const args = { globalToolExecution: { version: 1, token: 'fictional-model-forgery' } }
    mocks.invoke.mockResolvedValueOnce({ version: 1, success: true, content: '', commitState: 'committed' })
    await tool.execute(args, { ...context(), agentToolAction: actionRef, globalToolExecution: execution, markSideEffectStarted })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mcp:call-tool', 'safe-id', 'write_remote', args, execution)
    expect(markSideEffectStarted).toHaveBeenCalledOnce()
    expect(markSideEffectStarted.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[0]!)
  })

  it.each(['not_committed', 'committed', 'unknown'] as const)('marks dispatch and preserves the %s receipt unchanged', async commitState => {
    const tool = registerRemoteTool(), markSideEffectStarted = vi.fn()
    mocks.invoke.mockResolvedValueOnce({ version: 1, success: commitState === 'committed', content: 'Fictional response', commitState })
    await expect(tool.execute({ value: 'fictional' }, { ...context(), markSideEffectStarted }))
      .resolves.toMatchObject({ success: commitState === 'committed', content: 'Fictional response', commitState })
    expect(markSideEffectStarted).toHaveBeenCalledOnce()
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mcp:call-tool', 'safe-id', 'write_remote', { value: 'fictional' })
    expect(markSideEffectStarted.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[0]!)
  })

  it('rejects an already aborted call before marking or sending any remote side effect', async () => {
    const tool = registerRemoteTool(), controller = new AbortController(), markSideEffectStarted = vi.fn()
    controller.abort()
    await expect(tool.execute({}, { ...context(), agentToolAction: actionRef, abortSignal: controller.signal, markSideEffectStarted }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(markSideEffectStarted).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it.each(['unknown-receipt', 'rejected-receipt'] as const)('stops the Agent without resending an MCP %s', async mode => {
    registerRemoteTool()
    if (mode === 'unknown-receipt') mocks.invoke.mockResolvedValueOnce({ version: 1,
      success: false, content: '', commitState: 'unknown', error: 'fictional receipt unavailable' })
    else mocks.invoke.mockRejectedValueOnce(new Error('fictional IPC closed after dispatch'))
    const ui = callbacks(), generate = vi.fn()
      .mockResolvedValueOnce(`<tool_call>{"name":"${remoteToolName}","arguments":{}}</tool_call>`)
      .mockResolvedValueOnce(`<tool_call>{"name":"${remoteToolName}","arguments":{}}</tool_call>`)
    await runAgentLoop('system', [], 'fictional remote write', 'fictional-model', generate, ui, undefined, context())
    expect(ui.onToolCallConfirmRequired).toHaveBeenCalledOnce()
    expect(mocks.invoke).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledOnce()
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'result_unknown', commitState: 'unknown' }))
    expect(ui.onDone).toHaveBeenCalledWith(expect.stringContaining('stopped to avoid a duplicate write'), expect.anything(), expect.anything())
  })

  it('keeps a sent MCP timeout unknown and ignores its late receipt without another round', async () => {
    vi.useFakeTimers()
    registerRemoteTool()
    let finish!: (result: MCPToolCallResult) => void
    mocks.invoke.mockImplementationOnce(() => new Promise<MCPToolCallResult>(resolve => { finish = resolve }))
    const ui = callbacks(), generate = vi.fn()
      .mockResolvedValueOnce(`<tool_call>{"name":"${remoteToolName}","arguments":{}}</tool_call>`)
      .mockResolvedValueOnce('must not continue')
    const run = runAgentLoop('system', [], 'fictional remote write', 'fictional-model', generate, ui, undefined, context())
    try {
      await vi.advanceTimersByTimeAsync(30_000)
      await run
      expect(mocks.invoke).toHaveBeenCalledOnce()
      expect(generate).toHaveBeenCalledOnce()
      expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'result_unknown', commitState: 'unknown' }))
    } finally {
      finish({ version: 1, success: true, content: 'Fictional late receipt', commitState: 'committed' })
      await run
    }
    expect(ui.onToolCallComplete).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledOnce()
  })

  it.each(['unknown-receipt', 'rejected-receipt', 'missing-proof'] as const)('honors the hosted claim proof boundary for MCP %s', async mode => {
    const tool = registerRemoteTool()
    if (mode === 'unknown-receipt') mocks.invoke.mockResolvedValueOnce({ version: 1,
      success: false, content: '', commitState: 'unknown' })
    else if (mode === 'rejected-receipt') mocks.invoke.mockRejectedValueOnce(new Error('fictional IPC closed after dispatch'))
    const session = { projectId: 'fictional-project', leaseId: 'fictional-lease', projectPath: 'C:/synthetic/mcp-project' }
    const host = new AgentGenerationClient(session)
    const action: AgentToolAction = { name: remoteToolName, arguments: {}, status: 'pending', ref: {
      handle: { projectId: session.projectId, epoch: 'fictional-epoch', rootActionId: 'fictional-root', runId: 'fictional-run' },
      attemptId: 'fictional-attempt', toolCallId: 'fictional-tool-call' } }
    const assertTool = vi.spyOn(host, 'assertTool').mockImplementation(() => {})
    const claim = vi.spyOn(host, 'claimTool').mockResolvedValue({ action: { ...action, status: 'running' }, execute: true,
      globalExecution: mode === 'missing-proof' ? undefined : execution })
    const finish = vi.spyOn(host, 'finishTool').mockImplementation(async request => ({ ...action, status: request.status }))
    const ui = callbacks(), generate = vi.fn().mockResolvedValueOnce({ index: 0, handle: action.ref.handle,
      status: 'completed', visibleText: '', protocolText: '', actions: [action] })
      .mockResolvedValueOnce({ index: 1, handle: action.ref.handle, status: 'completed', visibleText: '', protocolText: '', actions: [] })
    try {
      await runAgentLoop('ignored', [], 'ignored', 'ignored', generate, ui, undefined,
        { ...context(), projectSession: session, agentGeneration: host, globalToolExecution: { version: 1, token: 'fictional-stale-context-proof' } })
      expect(assertTool).toHaveBeenCalledExactlyOnceWith(tool)
      expect(ui.onToolCallConfirmRequired).toHaveBeenCalledOnce()
      expect(claim).toHaveBeenCalledExactlyOnceWith(action.ref, true, undefined)
      if (mode === 'missing-proof') {
        expect(finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ref: action.ref, status: 'failed' }))
        expect(mocks.invoke).not.toHaveBeenCalled()
        expect(generate).toHaveBeenCalledTimes(2)
        expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', commitState: 'not_committed' }))
      } else {
        expect(finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ref: action.ref, status: 'unknown' }))
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mcp:call-tool', 'safe-id', 'write_remote', {}, execution)
        expect(generate).toHaveBeenCalledOnce()
        expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'result_unknown', commitState: 'unknown' }))
      }
    } finally {
      assertTool.mockRestore()
      claim.mockRestore()
      finish.mockRestore()
      host.close()
    }
  })

  it('reports cancellation during confirmation as not committed without sending the MCP request', async () => {
    registerRemoteTool()
    const controller = new AbortController(), ui = callbacks()
    ui.onToolCallConfirmRequired.mockImplementationOnce(async () => { controller.abort(); return true })
    const generate = vi.fn().mockResolvedValueOnce(`<tool_call>{"name":"${remoteToolName}","arguments":{}}</tool_call>`)
    await runAgentLoop('system', [], 'fictional remote write', 'fictional-model', generate, ui, controller.signal, context())
    expect(ui.onToolCallConfirmRequired).toHaveBeenCalledOnce()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(generate).toHaveBeenCalledOnce()
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', commitState: 'not_committed' }))
  })
})

describe('MCP 连接失败的说明', () => {
  afterEach(() => { useLocaleStore.setState({ locale: originalLocale }) })

  it.each([
    ['zh-CN', '项目已切换或重新打开', '连接失败'],
    ['en-US', 'The project was switched or reopened', 'Connection failed'],
  ] as const)('%s 界面：登记的码换成说明，未登记的原文保留，没有原因时用兜底', async (locale, stale, fallback) => {
    useLocaleStore.setState({ locale })
    for (const [error, shown] of [
      ["Error invoking remote method 'mcp:connect': Error: PROJECT_SESSION_STALE", expect.stringContaining(stale)],
      ['SOMETHING_NEW_FROM_MAIN', 'SOMETHING_NEW_FROM_MAIN'],
      [undefined, fallback],
    ] as const) {
      mocks.invoke.mockResolvedValue({ success: false, error })
      await useMCPStore.getState().connectServer('safe-id')
      expect(useMCPStore.getState().error).toEqual(shown)
    }
  })
})

describe('MCP disconnect receipts', () => {
  beforeEach(() => { useLocaleStore.setState({ locale: 'en-US' }) })
  afterEach(() => { useLocaleStore.setState({ locale: originalLocale }) })

  const previousTool = { name: 'old_tool', description: 'Old tool', inputSchema: { type: 'object' }, serverId: 'first' }
  const currentTool = { name: 'current_tool', description: 'Current tool', inputSchema: { type: 'object' }, serverId: 'remaining' }
  const oldResource = { uri: 'fictional://old', name: 'Old resource', serverId: 'first' }
  const currentResource = { uri: 'fictional://current', name: 'Current resource', serverId: 'remaining' }
  const firstServer = { id: 'first', name: 'First server', status: 'connected' as const, toolCount: 1 }
  const remainingServer = { id: 'remaining', name: 'Remaining server', status: 'connected' as const, toolCount: 1 }

  function seedAvailableState() {
    useMCPStore.setState({
      servers: [firstServer, remainingServer],
      tools: [previousTool],
      resources: [oldResource],
      error: null,
    })
    useMCPStore.getState().registerMCPToolsToRegistry()
  }

  it.each(['zh-CN', 'en-US'] as const)('keeps single-disconnect failure and refreshes actual state in %s', async locale => {
    useLocaleStore.setState({ locale })
    seedAvailableState()
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:disconnect') return { success: false, error: 'MCP_DISCONNECT_FAILED' }
      if (channel === 'mcp:get-servers-status') return [remainingServer]
      if (channel === 'mcp:list-tools') return [currentTool]
      if (channel === 'mcp:list-resources') return [currentResource]
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().disconnectServer('first')

    expect(useMCPStore.getState()).toMatchObject({
      servers: [remainingServer], tools: [currentTool], resources: [currentResource],
      error: translate(locale, 'error.unknown', { message: 'MCP_DISCONNECT_FAILED' }),
    })
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:disconnect', 'first')
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:get-servers-status')
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:list-tools')
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:list-resources')
    expect(toolRegistry.get('mcp__remaining__current_tool')).toBeDefined()
    expect(toolRegistry.get('mcp__first__old_tool')).toBeUndefined()
  })

  it('does not clear all-disconnect state when the main process reports remaining servers', async () => {
    seedAvailableState()
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:disconnect-all') return { success: false, error: 'MCP_DISCONNECT_FAILED' }
      if (channel === 'mcp:get-servers-status') return [remainingServer]
      if (channel === 'mcp:list-tools') return [currentTool]
      if (channel === 'mcp:list-resources') return [currentResource]
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().disconnectAll()

    expect(useMCPStore.getState()).toMatchObject({
      servers: [remainingServer], tools: [currentTool], resources: [currentResource],
      error: translate('en-US', 'error.unknown', { message: 'MCP_DISCONNECT_FAILED' }),
    })
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:get-servers-status')
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:list-tools')
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:list-resources')
    expect(toolRegistry.get('mcp__remaining__current_tool')).toBeDefined()
  })

  it('preserves prior available state if status and tool refreshes fail after disconnect failure', async () => {
    seedAvailableState()
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:disconnect') return { success: false, error: 'MCP_DISCONNECT_FAILED' }
      if (channel === 'mcp:get-servers-status') throw new Error('fictional status query failure')
      if (channel === 'mcp:list-tools') throw new Error('fictional tool query failure')
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().disconnectServer('first')

    expect(useMCPStore.getState()).toMatchObject({
      servers: [firstServer, remainingServer], tools: [previousTool], resources: [oldResource],
      error: translate('en-US', 'error.unknown', { message: 'MCP_DISCONNECT_FAILED' }),
    })
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:get-servers-status')
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:list-tools')
    expect(toolRegistry.get('mcp__first__old_tool')).toBeDefined()
  })

  it('propagates a rejected single-disconnect IPC error without changing available state', async () => {
    seedAvailableState()
    const ipcError = new Error('fictional disconnect IPC rejection')
    mocks.invoke.mockRejectedValue(ipcError)

    await expect(useMCPStore.getState().disconnectServer('first')).rejects.toBe(ipcError)

    expect(useMCPStore.getState()).toMatchObject({
      servers: [firstServer, remainingServer], tools: [previousTool], resources: [oldResource], error: null,
    })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mcp:disconnect', 'first')
    expect(toolRegistry.get('mcp__first__old_tool')).toBeDefined()
  })

  it('propagates a rejected disconnect-all IPC error without changing available state', async () => {
    seedAvailableState()
    const ipcError = new Error('fictional disconnect-all IPC rejection')
    mocks.invoke.mockRejectedValue(ipcError)

    await expect(useMCPStore.getState().disconnectAll()).rejects.toBe(ipcError)

    expect(useMCPStore.getState()).toMatchObject({
      servers: [firstServer, remainingServer], tools: [previousTool], resources: [oldResource], error: null,
    })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mcp:disconnect-all')
    expect(toolRegistry.get('mcp__first__old_tool')).toBeDefined()
  })

  it('keeps the existing successful single-disconnect refresh and registry behavior', async () => {
    seedAvailableState()
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:disconnect') return { success: true }
      if (channel === 'mcp:get-servers-status') return [remainingServer]
      if (channel === 'mcp:list-tools') return [currentTool]
      if (channel === 'mcp:list-resources') return [currentResource]
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await useMCPStore.getState().disconnectServer('first')

    expect(useMCPStore.getState()).toMatchObject({ servers: [remainingServer], tools: [currentTool], resources: [currentResource], error: null })
    expect(toolRegistry.get('mcp__remaining__current_tool')).toBeDefined()
    expect(toolRegistry.get('mcp__first__old_tool')).toBeUndefined()
  })

  it('keeps the existing successful disconnect-all clearing behavior', async () => {
    seedAvailableState()
    mocks.invoke.mockResolvedValue({ success: true })

    await useMCPStore.getState().disconnectAll()

    expect(useMCPStore.getState()).toMatchObject({ servers: [], tools: [], resources: [] })
    expect(toolRegistry.get('mcp__first__old_tool')).toBeUndefined()
  })
})

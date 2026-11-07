import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  loadConfig: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  disconnectAll: vi.fn(),
  getAllTools: vi.fn((): unknown[] => []),
  getAllResources: vi.fn((): unknown[] => []),
  callTool: vi.fn(),
  getServersStatus: vi.fn((): unknown[] => []),
  getDefaultConfigPath: vi.fn(() => 'C:/isolated/.vela/mcp_config.json'),
  closed: false,
  active: 0,
  acquire: vi.fn(),
  release: vi.fn(),
  acquireAgent: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../mcp-manager', () => ({ mcpManager: mocks }))
vi.mock('../../services/project-runtime', () => ({ projectRuntimeHost: { acquireApplicationOperation: mocks.acquire } }))
vi.mock('../../services/agent-global-tool-admission', () => ({ acquireAgentGlobalToolOperation: mocks.acquireAgent }))

import { registerMCPHandlers } from '../mcp-ipc-bridge'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

beforeAll(() => registerMCPHandlers())

beforeEach(() => {
  vi.clearAllMocks()
  mocks.closed = false
  mocks.active = 0
  mocks.acquire.mockImplementation(() => {
    if (mocks.closed) throw new Error('PROJECT_RUNTIME_HOST_CLOSING')
    mocks.active++
    let released = false
    return () => { if (!released) { released = true; mocks.active--; mocks.release() } }
  })
  mocks.acquireAgent.mockImplementation(() => mocks.acquire())
  mocks.loadConfig.mockResolvedValue({
    status: 'loaded',
    servers: [{ id: 'safe-id', name: 'Safe server', transport: 'stdio' }],
  })
})

describe('MCP IPC trust boundary', () => {
  it('does not accept an arbitrary config path or expose trusted launch configuration', async () => {
    const result = await handler('mcp:load-config')({}, 'C:/attacker/config.json')

    expect(mocks.loadConfig).toHaveBeenCalledWith()
    expect(result).toEqual({
      success: true,
      status: 'loaded',
      servers: [{ id: 'safe-id', name: 'Safe server', transport: 'stdio' }],
    })
    expect(JSON.stringify(result)).not.toMatch(/command|args|env|url|SECRET_(?:COMMAND|ARGUMENT|ENV|URL)_MARKER/iu)
  })

  it('connects by a previously loaded server id and reports initialization failure', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('SECRET_INITIALIZE_ERROR_MARKER'))

    const result = await handler('mcp:connect')({}, 'safe-id')
    expect(result).toEqual({
      success: false,
      error: 'MCP_CONNECT_FAILED',
    })
    expect(JSON.stringify(result)).not.toContain('SECRET_INITIALIZE_ERROR_MARKER')
    expect(mocks.connect).toHaveBeenCalledWith('safe-id')
  })

  it('makes malformed configuration visible while preserving missing as a distinct state', async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      status: 'error',
      servers: [],
      error: 'MCP_CONFIG_INVALID',
    })
    await expect(handler('mcp:load-config')({})).resolves.toEqual({
      success: false,
      status: 'error',
      servers: [],
      error: 'MCP_CONFIG_INVALID',
    })

    mocks.loadConfig.mockResolvedValueOnce({ status: 'missing', servers: [] })
    await expect(handler('mcp:load-config')({})).resolves.toEqual({
      success: true,
      status: 'missing',
      servers: [],
    })
  })
})

describe('MCP IPC application lifecycle', () => {
  it.each(['mcp:load-config', 'mcp:connect'])('keeps %s admitted until its main-process promise settles', async channel => {
    let complete!: (result: unknown) => void
    const pending = new Promise(resolve => { complete = resolve })
    const operation = channel === 'mcp:load-config' ? mocks.loadConfig : mocks.connect
    operation.mockReturnValueOnce(pending)
    const result = handler(channel)({}, 'safe-id')
    expect(mocks.active).toBe(1)
    mocks.closed = true
    await Promise.resolve()
    expect(mocks.active).toBe(1)
    complete(channel === 'mcp:load-config' ? { status: 'loaded', servers: [] } : undefined)
    await expect(result).resolves.toMatchObject({ success: true })
    expect(mocks.active).toBe(0)
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it.each(['mcp:load-config', 'mcp:connect'])('releases the %s operation only after a rejected main promise', async channel => {
    let fail!: (error: Error) => void
    const pending = new Promise((_resolve, reject) => { fail = reject })
    const operation = channel === 'mcp:load-config' ? mocks.loadConfig : mocks.connect
    operation.mockReturnValueOnce(pending)
    const result = handler(channel)({}, 'safe-id')
    expect(mocks.active).toBe(1)
    fail(new Error('SECRET_ASYNC_ERROR_MARKER'))
    const receipt = await result
    expect(receipt).toMatchObject({ success: false })
    expect(JSON.stringify(receipt)).not.toContain('SECRET_ASYNC_ERROR_MARKER')
    expect(mocks.active).toBe(0)
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('rejects new load and connect work while still permitting explicit disconnect cleanup', async () => {
    mocks.closed = true
    await expect(handler('mcp:load-config')({})).resolves.toMatchObject({ success: false, error: 'PROJECT_RUNTIME_HOST_CLOSING' })
    await expect(handler('mcp:connect')({}, 'safe-id')).resolves.toEqual({ success: false, error: 'PROJECT_RUNTIME_HOST_CLOSING' })
    expect(mocks.loadConfig).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.active).toBe(0)
    mocks.acquire.mockClear()
    await expect(handler('mcp:disconnect')({}, 'safe-id')).resolves.toEqual({ success: true })
    await expect(handler('mcp:disconnect-all')({})).resolves.toEqual({ success: true })
    expect(mocks.disconnect).toHaveBeenCalledWith('safe-id')
    expect(mocks.disconnectAll).toHaveBeenCalledOnce()
    expect(mocks.acquire).not.toHaveBeenCalled()
  })

  it('leaves tool effect ownership in the manager and preserves its versioned unknown receipt', async () => {
    const receipt = { version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_REQUEST_TIMEOUT' }
    mocks.callTool.mockResolvedValueOnce(receipt)
    await expect(handler('mcp:call-tool')({}, 'safe-id', 'fictional_write', { fixture: true })).resolves.toEqual(receipt)
    expect(mocks.callTool).toHaveBeenCalledWith('safe-id', 'fictional_write', { fixture: true }, expect.any(Function))
    expect(mocks.acquire).not.toHaveBeenCalled()
    expect(mocks.acquireAgent).not.toHaveBeenCalled()
  })

  it('defers exact sender and execution validation to the manager factory and never releases it on the foreground receipt', async () => {
    const sender = { id: 17 }, execution = { version: 1, token: 'fictional-token' }, args = { fixture: true }
    const receipt = { version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_REQUEST_TIMEOUT' }
    let send!: () => void, releaseEffect: (() => void) | undefined
    const pendingSend = new Promise<void>(resolve => { send = resolve })
    mocks.callTool.mockImplementationOnce(async (_serverId, _toolName, _args, acquireEffect: () => () => void) => {
      await pendingSend
      releaseEffect = acquireEffect()
      return receipt
    })
    const foreground = handler('mcp:call-tool')({ sender }, 'safe-id', 'fictional_write', args, execution)
    expect(mocks.acquireAgent).not.toHaveBeenCalled()
    expect(mocks.acquire).not.toHaveBeenCalled()
    send()
    await expect(foreground).resolves.toEqual(receipt)
    expect(mocks.acquireAgent).toHaveBeenCalledWith(sender, execution, { kind: 'mcp', serverId: 'safe-id', toolName: 'fictional_write', args })
    expect(mocks.active).toBe(1)
    expect(mocks.release).not.toHaveBeenCalled()
    expect(releaseEffect).toBe(mocks.acquireAgent.mock.results[0]!.value)
    if (!releaseEffect) throw new Error('Missing manager effect release')
    releaseEffect()
    expect(mocks.active).toBe(0)
  })

  it('does not lose the omitted execution envelope used by independent manual calls', async () => {
    const sender = { id: 18 }, args = { fixture: true }
    mocks.callTool.mockImplementationOnce(async (_serverId, _toolName, _args, acquireEffect: () => () => void) => {
      const release = acquireEffect()
      try { return { version: 1, success: true, content: '', commitState: 'committed' } }
      finally { release() }
    })
    await expect(handler('mcp:call-tool')({ sender }, 'safe-id', 'fictional_write', args)).resolves.toMatchObject({ success: true })
    expect(mocks.acquireAgent).toHaveBeenCalledWith(sender, undefined, { kind: 'mcp', serverId: 'safe-id', toolName: 'fictional_write', args })
    expect(mocks.active).toBe(0)
  })

  it('does not return raw disconnect errors from the cleanup path', async () => {
    mocks.disconnect.mockRejectedValueOnce(new Error('SECRET_DISCONNECT_MARKER'))
    mocks.disconnectAll.mockRejectedValueOnce(new Error('SECRET_DISCONNECT_ALL_MARKER'))
    await expect(handler('mcp:disconnect')({}, 'safe-id')).resolves.toEqual({ success: false, error: 'MCP_DISCONNECT_FAILED' })
    await expect(handler('mcp:disconnect-all')({})).resolves.toEqual({ success: false, error: 'MCP_DISCONNECT_FAILED' })
  })
})

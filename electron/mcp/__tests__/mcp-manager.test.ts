import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const lifecycle = vi.hoisted(() => ({ closed: false, active: 0, acquire: vi.fn(), release: vi.fn() }))

vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'C:/REAL-HOME-MUST-NOT-BE-READ') } }))
vi.mock('../../services/project-runtime', () => ({ projectRuntimeHost: { acquireApplicationOperation: lifecycle.acquire } }))

type Manager = typeof import('../mcp-manager')['mcpManager']

let fixtureRoot = ''
let velaHome = ''
let mcpManager: Manager
const children: EventEmitter[] = []

function createMcpProcess(options: { initializeError?: string; failToStart?: boolean; neverRespond?: boolean; deferTools?: boolean } = {}) {
  const processEmitter = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const requests: { id: number; method: string }[] = []
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((raw: string, _callback?: (error?: Error | null) => void) => {
      void _callback
      const request = JSON.parse(raw) as { id?: number; method: string }
      if (request.id === undefined) return true
      requests.push({ id: request.id, method: request.method })
      if (options.failToStart) {
        queueMicrotask(() => processEmitter.emit('error', new Error('SECRET_CHILD_ERROR_MARKER')))
        return true
      }
      if (options.neverRespond || options.deferTools && request.method === 'tools/call') return true

      const payload = request.method === 'initialize' && options.initializeError
        ? { error: { code: -32000, message: options.initializeError } }
        : {
            result: request.method === 'tools/list'
              ? { tools: [] }
              : request.method === 'resources/list'
                ? { resources: [] }
                : {},
          }
      queueMicrotask(() => {
        stdout.emit('data', Buffer.from(`${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          ...payload,
        })}\n`))
      })
      return true
    }),
  })

  children.push(processEmitter)
  return Object.assign(processEmitter, {
    stdout,
    stderr,
    stdin,
    requests,
    kill: vi.fn(),
  })
}

function writeConfig(value: unknown): void {
  fs.writeFileSync(
    path.join(velaHome, 'mcp_config.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  )
}

async function connectToolProcess() {
  writeConfig({ mcpServers: { fictional: { command: 'node' } } })
  const child = createMcpProcess({ deferTools: true })
  spawnMock.mockReturnValue(child)
  await mcpManager.loadConfig()
  await mcpManager.connect('fictional')
  return child
}

function respond(child: ReturnType<typeof createMcpProcess>, id: number, payload: { result?: unknown; error?: unknown }) {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`))
}

beforeEach(async () => {
  vi.resetModules()
  spawnMock.mockReset()
  lifecycle.closed = false
  lifecycle.active = 0
  lifecycle.acquire.mockReset().mockImplementation(() => {
    if (lifecycle.closed) throw new Error('PROJECT_RUNTIME_HOST_CLOSING')
    lifecycle.active++
    let released = false
    return () => { if (!released) { released = true; lifecycle.active--; lifecycle.release() } }
  })
  lifecycle.release.mockReset()
  velaHome = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ai-novel-mcp-'))
  fixtureRoot = velaHome
    velaHome = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
  mcpManager = (await import('../mcp-manager')).mcpManager
})

afterEach(async () => {
  vi.useRealTimers()
  await mcpManager.disconnectAll()
  for (const child of children.splice(0)) child.emit('exit', 0)
  expect(lifecycle.active).toBe(0)
  delete process.env.AI_NOVEL_VELA_HOME
    delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('MCP trusted configuration boundary', () => {
  it('uses the isolated VELA_HOME and distinguishes a missing config', async () => {
    expect(mcpManager.getDefaultConfigPath()).toBe(path.join(velaHome, 'mcp_config.json'))
    await expect(mcpManager.loadConfig()).resolves.toEqual({ status: 'missing', servers: [] })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('revokes previously trusted ids when a reload is missing or corrupt', async () => {
    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'loaded' })
    fs.unlinkSync(path.join(velaHome, 'mcp_config.json'))

    await expect(mcpManager.loadConfig()).resolves.toEqual({ status: 'missing', servers: [] })
    await expect(mcpManager.connect('old_server')).rejects.toThrow('MCP_SERVER_NOT_CONFIGURED')

    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'loaded' })
    writeConfig('{BROKEN_MCP_CONFIG')

    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'error', servers: [] })
    await expect(mcpManager.connect('old_server')).rejects.toThrow('MCP_SERVER_NOT_CONFIGURED')
  })

  it('disconnects an active server when its configuration becomes missing', async () => {
    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    const process = createMcpProcess()
    spawnMock.mockReturnValue(process)
    await mcpManager.loadConfig()
    await mcpManager.connect('old_server')
    fs.unlinkSync(path.join(velaHome, 'mcp_config.json'))

    await expect(mcpManager.loadConfig()).resolves.toEqual({ status: 'missing', servers: [] })

    expect(process.kill).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus()).toEqual([])
  })

  it('disconnects an active server when its configuration becomes corrupt', async () => {
    writeConfig({ mcpServers: { old_server: { command: 'node' } } })
    const process = createMcpProcess()
    spawnMock.mockReturnValue(process)
    await mcpManager.loadConfig()
    await mcpManager.connect('old_server')
    writeConfig('{BROKEN_MCP_CONFIG')

    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'error', servers: [] })

    expect(process.kill).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus()).toEqual([])
  })

  it('keeps unchanged connections and disconnects deleted or changed servers on reload', async () => {
    writeConfig({
      mcpServers: {
        unchanged: { command: 'node', args: ['same.js'] },
        changed: { command: 'node', args: ['old.js'] },
        deleted: { command: 'node', args: ['gone.js'] },
      },
    })
    const unchangedProcess = createMcpProcess()
    const changedProcess = createMcpProcess()
    const deletedProcess = createMcpProcess()
    spawnMock
      .mockReturnValueOnce(unchangedProcess)
      .mockReturnValueOnce(changedProcess)
      .mockReturnValueOnce(deletedProcess)
    await mcpManager.loadConfig()
    await mcpManager.connect('unchanged')
    await mcpManager.connect('changed')
    await mcpManager.connect('deleted')

    writeConfig({
      mcpServers: {
        unchanged: { command: 'node', args: ['same.js'] },
        changed: { command: 'node', args: ['new.js'] },
        added: { command: 'node', args: ['new-server.js'] },
      },
    })
    await mcpManager.loadConfig()

    expect(unchangedProcess.kill).not.toHaveBeenCalled()
    expect(changedProcess.kill).toHaveBeenCalledOnce()
    expect(deletedProcess.kill).toHaveBeenCalledOnce()
    expect(mcpManager.getServersStatus().map(server => server.id)).toEqual(['unchanged'])
  })

  it('reports a malformed config instead of treating it as missing', async () => {
    writeConfig({
      mcpServers: {
        appears_before_damage: { command: 'node' },
        damaged: { args: 'not-an-array' },
      },
    })
    await expect(mcpManager.loadConfig()).resolves.toEqual({
      status: 'error',
      servers: [],
      error: 'MCP_CONFIG_INVALID',
    })
    await expect(mcpManager.connect('appears_before_damage')).rejects.toThrow('MCP_SERVER_NOT_CONFIGURED')
  })

  it('reports invalid JSON as corrupt configuration', async () => {
    writeConfig('{BROKEN_MCP_CONFIG')
    await expect(mcpManager.loadConfig()).resolves.toEqual({
      status: 'error',
      servers: [],
      error: 'MCP_CONFIG_INVALID',
    })
  })

  it.each([
    { serverConfig: {}, caseName: 'neither transport' },
    { serverConfig: { command: 'node', url: 'https://example.invalid/sse' }, caseName: 'ambiguous transport' },
    { serverConfig: { command: '   ' }, caseName: 'blank command' },
    { serverConfig: { url: '   ' }, caseName: 'blank URL' },
  ])('rejects $caseName instead of loading an unusable server', async ({ serverConfig }) => {
    writeConfig({ mcpServers: { invalid: serverConfig } })
    await expect(mcpManager.loadConfig()).resolves.toMatchObject({ status: 'error', servers: [] })
    await expect(mcpManager.connect('invalid')).rejects.toThrow('MCP_SERVER_NOT_CONFIGURED')
  })

  it('keeps command arguments, environment, and credential URLs in the main process', async () => {
    writeConfig({
      mcpServers: {
        secret_stdio_server: {
          command: 'SECRET_COMMAND_MARKER',
          args: ['SECRET_ARGUMENT_MARKER'],
          env: { API_KEY: 'SECRET_ENV_MARKER' },
        },
        secret_sse_server: {
          url: 'https://user:SECRET_URL_MARKER@example.invalid/sse',
        },
      },
    })

    const result = await mcpManager.loadConfig()

    expect(result).toEqual({
      status: 'loaded',
      servers: [
        { id: 'secret_stdio_server', name: 'secret_stdio_server', transport: 'stdio' },
        { id: 'secret_sse_server', name: 'secret_sse_server', transport: 'sse' },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/SECRET_(?:COMMAND|ARGUMENT|ENV|URL)_MARKER/u)
  })

  it('rejects an id that was not loaded from the trusted config', async () => {
    await expect(mcpManager.connect('unconfigured')).rejects.toThrow('MCP_SERVER_NOT_CONFIGURED')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('hides the child window and connects only a loaded stdio server', async () => {
    writeConfig({
      mcpServers: {
        hidden_window_test: {
          command: 'node',
          args: ['server.js'],
          env: { MCP_TEST: '1' },
        },
      },
    })
    spawnMock.mockReturnValue(createMcpProcess())
    await mcpManager.loadConfig()

    await mcpManager.connect('hidden_window_test')

    expect(spawnMock).toHaveBeenCalledWith('node', ['server.js'], {
      env: expect.objectContaining({ MCP_TEST: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  })

  it('rejects when MCP session initialization fails and preserves an error status', async () => {
    writeConfig({ mcpServers: { broken: { command: 'node' } } })
    spawnMock.mockReturnValue(createMcpProcess({ initializeError: 'SECRET_INITIALIZE_ERROR_MARKER' }))
    await mcpManager.loadConfig()

    await expect(mcpManager.connect('broken')).rejects.toThrow('MCP_CONNECT_FAILED')
    expect(mcpManager.getServersStatus()).toEqual([
      expect.objectContaining({ id: 'broken', status: 'error', error: 'MCP_CONNECT_FAILED' }),
    ])
    expect(JSON.stringify(mcpManager.getServersStatus())).not.toContain('SECRET_INITIALIZE_ERROR_MARKER')
  })

  it('settles once with a safe error when the child process fails to start', async () => {
    writeConfig({ mcpServers: { broken: { command: 'node' } } })
    spawnMock.mockReturnValue(createMcpProcess({ failToStart: true }))
    await mcpManager.loadConfig()

    await expect(mcpManager.connect('broken')).rejects.toThrow('MCP_CONNECT_FAILED')
    expect(mcpManager.getServersStatus()).toEqual([
      expect.objectContaining({ id: 'broken', status: 'error', error: 'MCP_CONNECT_FAILED' }),
    ])
    expect(JSON.stringify(mcpManager.getServersStatus())).not.toContain('SECRET_CHILD_ERROR_MARKER')
  })

  it('reports a stable code when a tool is called on a server that is not connected', async () => {
    await expect(mcpManager.callTool('absent', 'search', {})).resolves.toEqual({
      version: 1,
      success: false,
      content: '',
      commitState: 'not_committed',
      error: 'MCP_SERVER_NOT_CONNECTED',
    })
  })

  it('times out initialization without leaving the connection pending', async () => {
    vi.useFakeTimers()
    writeConfig({ mcpServers: { silent: { command: 'node' } } })
    spawnMock.mockReturnValue(createMcpProcess({ neverRespond: true }))
    await mcpManager.loadConfig()

    const rejection = expect(mcpManager.connect('silent')).rejects.toThrow('MCP_CONNECT_FAILED')
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
    expect(mcpManager.getServersStatus()).toEqual([
      expect.objectContaining({ id: 'silent', status: 'error' }),
    ])
  })
})

describe('MCP actual effect lifecycle', () => {
  it.each(['bound-B', 'manual'] as const)('rejects an A-only closed factory before write while allowing %s work', async next => {
    const child = await connectToolProcess(), writes = child.stdin.write.mock.calls.length
    const acquireA = vi.fn(() => {
      expect(child.stdin.write).toHaveBeenCalledTimes(writes)
      throw new Error('PROJECT_RUNTIME_CLOSE_REQUESTED')
    })
    await expect(mcpManager.callTool('fictional', 'write_A', {}, acquireA)).resolves.toEqual({ version: 1, success: false, content: '', commitState: 'not_committed', error: 'PROJECT_RUNTIME_CLOSE_REQUESTED' })
    expect(acquireA).toHaveBeenCalledOnce()
    expect(child.stdin.write).toHaveBeenCalledTimes(writes)
    expect(lifecycle.acquire).not.toHaveBeenCalled()
    const releaseB = vi.fn(), acquireB = vi.fn(() => releaseB)
    const result = mcpManager.callTool('fictional', 'write_other', {}, next === 'bound-B' ? acquireB : undefined)
    expect(child.stdin.write).toHaveBeenCalledTimes(writes + 1)
    const id = child.requests.find(request => request.method === 'tools/call')!.id
    respond(child, id, { result: { content: [] } })
    await expect(result).resolves.toMatchObject({ success: true, commitState: 'committed' })
    if (next === 'bound-B') {
      expect(acquireB).toHaveBeenCalledOnce()
      expect(releaseB).toHaveBeenCalledOnce()
      expect(lifecycle.acquire).not.toHaveBeenCalled()
    } else expect(lifecycle.release).toHaveBeenCalledOnce()
  })

  it.each(['late-response', 'observed-exit'] as const)('keeps the exact factory effect through foreground timeout until %s proof', async proof => {
    vi.useFakeTimers()
    const child = await connectToolProcess(), release = vi.fn(), factory = vi.fn(() => release)
    const foreground = mcpManager.callTool('fictional', 'write_fixture', {}, factory)
    expect(factory).toHaveBeenCalledOnce()
    expect(lifecycle.acquire).not.toHaveBeenCalled()
    const id = child.requests.find(request => request.method === 'tools/call')!.id
    await vi.advanceTimersByTimeAsync(10_000)
    const receipt = await foreground
    expect(receipt).toMatchObject({ success: false, commitState: 'unknown', error: 'MCP_REQUEST_TIMEOUT' })
    expect(release).not.toHaveBeenCalled()
    if (proof === 'late-response') respond(child, id, { result: { content: [] } })
    else child.emit('exit', 0)
    expect(release).toHaveBeenCalledOnce()
    child.emit('exit', 0)
    expect(release).toHaveBeenCalledOnce()
    expect(receipt.commitState).toBe('unknown')
    expect(factory).toHaveBeenCalledOnce()
    expect(child.requests.filter(request => request.method === 'tools/call')).toHaveLength(1)
  })

  it('owns a lease until the corresponding protocol result, without treating backpressure as a rejected send', async () => {
    const child = await connectToolProcess()
    child.stdin.write.mockReturnValueOnce(false)
    const result = mcpManager.callTool('fictional', 'write_fixture', {})
    expect(lifecycle.active).toBe(1)
    const id = JSON.parse(child.stdin.write.mock.calls.at(-1)![0]).id as number
    respond(child, id + 100, { result: { content: [] } })
    expect(lifecycle.active).toBe(1)
    respond(child, id, { result: { content: [{ type: 'text', text: 'fictional completed result' }] } })
    await expect(result).resolves.toEqual({ version: 1, success: true, content: 'fictional completed result', commitState: 'committed' })
    expect(lifecycle.active).toBe(0)
    respond(child, id, { result: { content: [] } })
    expect(lifecycle.release).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('keeps independent effect tombstones after foreground timeout and only releases each matching late response', async () => {
    vi.useFakeTimers()
    const child = await connectToolProcess()
    const first = mcpManager.callTool('fictional', 'write_first', {})
    const second = mcpManager.callTool('fictional', 'write_second', {})
    const requests = child.requests.filter(request => request.method === 'tools/call')
    expect(requests).toHaveLength(2)
    expect(lifecycle.active).toBe(2)
    await vi.advanceTimersByTimeAsync(10_000)
    const receipt = await first
    expect(receipt).toEqual({ version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_REQUEST_TIMEOUT' })
    await expect(second).resolves.toEqual(receipt)
    expect(lifecycle.active).toBe(2)
    expect(child.kill).not.toHaveBeenCalled()
    respond(child, requests[0]!.id, { result: { content: [] } })
    expect(lifecycle.active).toBe(1)
    respond(child, requests[0]!.id, { result: { content: [] } })
    expect(lifecycle.active).toBe(1)
    respond(child, requests[1]!.id, { result: { content: [] } })
    expect(lifecycle.active).toBe(0)
    expect(receipt.commitState).toBe('unknown')
    expect(child.requests.filter(request => request.method === 'tools/call')).toHaveLength(2)
  })

  it.each(['process-error', 'stdin-error', 'stdout-end'] as const)('keeps a dispatched effect after %s until actual child exit', async source => {
    const child = await connectToolProcess()
    const result = mcpManager.callTool('fictional', 'write_fixture', {})
    if (source === 'process-error') child.emit('error', new Error('SECRET_TRANSPORT_MARKER'))
    else if (source === 'stdin-error') child.stdin.emit('error', new Error('SECRET_TRANSPORT_MARKER'))
    else child.stdout.emit('end')
    await expect(result).resolves.toEqual({ version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_TRANSPORT_ERROR' })
    expect(lifecycle.active).toBe(1)
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('exit', 1)
    expect(lifecycle.active).toBe(0)
    child.emit('exit', 1)
    expect(lifecycle.release).toHaveBeenCalledOnce()
    expect(JSON.stringify(mcpManager.getServersStatus())).not.toContain('SECRET_TRANSPORT_MARKER')
  })

  it('does not release an effect merely because explicit disconnect sent kill', async () => {
    const child = await connectToolProcess()
    const result = mcpManager.callTool('fictional', 'write_fixture', {})
    lifecycle.closed = true
    await mcpManager.disconnect('fictional')
    await expect(result).resolves.toEqual({ version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_SERVER_NOT_CONNECTED' })
    expect(child.kill).toHaveBeenCalledOnce()
    expect(lifecycle.active).toBe(1)
    expect(mcpManager.getServersStatus()).toEqual([])
    child.emit('exit', 0)
    expect(lifecycle.active).toBe(0)
  })

  it('keeps an old runtime effect separate when reconnect reuses server and request ids', async () => {
    const old = await connectToolProcess()
    const first = mcpManager.callTool('fictional', 'write_old', {})
    const replacement = createMcpProcess({ deferTools: true })
    spawnMock.mockReturnValueOnce(replacement)
    await mcpManager.connect('fictional')
    await expect(first).resolves.toMatchObject({ commitState: 'unknown' })
    const second = mcpManager.callTool('fictional', 'write_new', {})
    expect(lifecycle.active).toBe(2)
    old.emit('exit', 0)
    expect(lifecycle.active).toBe(1)
    expect(mcpManager.getServersStatus()).toEqual([expect.objectContaining({ id: 'fictional', status: 'connected' })])
    const id = replacement.requests.find(request => request.method === 'tools/call')!.id
    respond(replacement, id, { result: { content: [] } })
    await expect(second).resolves.toMatchObject({ success: true, commitState: 'committed' })
    expect(lifecycle.active).toBe(0)
  })

  it.each(['throw', 'callback'] as const)('treats a writer %s after dispatch as unknown and retains the effect', async mode => {
    const child = await connectToolProcess()
    child.stdin.write.mockImplementationOnce((_raw, callback) => {
      if (mode === 'throw') throw new Error('SECRET_WRITER_MARKER')
      callback?.(new Error('SECRET_WRITER_MARKER'))
      return false
    })
    await expect(mcpManager.callTool('fictional', 'write_fixture', {})).resolves.toEqual({ version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_TRANSPORT_ERROR' })
    expect(lifecycle.active).toBe(1)
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('exit', 1)
    expect(lifecycle.active).toBe(0)
  })

  it('rejects a sealed host before sending or acquiring an effect', async () => {
    const child = await connectToolProcess(), writes = child.stdin.write.mock.calls.length
    lifecycle.closed = true
    await expect(mcpManager.callTool('fictional', 'write_fixture', {})).resolves.toEqual({ version: 1, success: false, content: '', commitState: 'not_committed', error: 'PROJECT_RUNTIME_HOST_CLOSING' })
    expect(child.stdin.write).toHaveBeenCalledTimes(writes)
    expect(lifecycle.active).toBe(0)
    expect(lifecycle.release).not.toHaveBeenCalled()
  })

  it('rejects unserializable input before dispatch without leaking arguments', async () => {
    const child = await connectToolProcess(), writes = child.stdin.write.mock.calls.length
    const args: Record<string, unknown> = { private: 'SECRET_ARGUMENT_MARKER' }
    args.cycle = args
    await expect(mcpManager.callTool('fictional', 'write_fixture', args)).resolves.toEqual({ version: 1, success: false, content: '', commitState: 'not_committed', error: 'MCP_REQUEST_REJECTED' })
    expect(child.stdin.write).toHaveBeenCalledTimes(writes)
    expect(lifecycle.acquire).not.toHaveBeenCalled()
  })

  it('sanitizes protocol errors and stderr while releasing a terminal protocol response', async () => {
    const child = await connectToolProcess()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = mcpManager.callTool('fictional', 'write_fixture', {})
      const id = child.requests.find(request => request.method === 'tools/call')!.id
      child.stderr.emit('data', Buffer.from('SECRET_STDERR_MARKER'))
      respond(child, id, { error: { code: -32000, message: 'SECRET_TOOL_ERROR_MARKER' } })
      await expect(result).resolves.toEqual({ version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_TOOL_FAILED' })
      expect(lifecycle.active).toBe(0)
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_STDERR_MARKER')
    } finally { warn.mockRestore() }
  })

  it('does not interpret an application tool error as a known rollback', async () => {
    const child = await connectToolProcess()
    const result = mcpManager.callTool('fictional', 'write_fixture', {})
    const id = child.requests.find(request => request.method === 'tools/call')!.id
    respond(child, id, { result: { isError: true, content: [{ type: 'text', text: 'SECRET_TOOL_ERROR_MARKER' }] } })
    await expect(result).resolves.toEqual({ version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_TOOL_FAILED' })
    expect(lifecycle.active).toBe(0)
  })

  it.each([
    { name: 'null result', payload: { result: null } },
    { name: 'array result', payload: { result: [] } },
    { name: 'missing content', payload: { result: {} } },
    { name: 'non-array content', payload: { result: { content: {} } } },
    { name: 'non-boolean isError', payload: { result: { content: [], isError: 'SECRET_TOOL_MARKER' } } },
    { name: 'invalid text', payload: { result: { content: [{ type: 'text', text: 123 }] } } },
    { name: 'incomplete image', payload: { result: { content: [{ type: 'image', data: 'AA==' }] } } },
    { name: 'incomplete resource', payload: { result: { content: [{ type: 'resource', resource: { uri: 'fictional://resource' } }] } } },
    { name: 'string error', payload: { error: 'SECRET_TOOL_MARKER' } },
    { name: 'missing error message', payload: { error: { code: -32000 } } },
    { name: 'string error code', payload: { error: { code: '-32000', message: 'SECRET_TOOL_MARKER' } } },
    { name: 'fractional error code', payload: { error: { code: -32000.5, message: 'SECRET_TOOL_MARKER' } } },
    { name: 'both result and error', payload: { result: { content: [] }, error: { code: -32000, message: 'SECRET_TOOL_MARKER' } } },
  ])('keeps a malformed $name frame pending until a valid late terminal response', async ({ payload }) => {
    vi.useFakeTimers()
    const child = await connectToolProcess()
    const result = mcpManager.callTool('fictional', 'write_fixture', {})
    const id = child.requests.find(request => request.method === 'tools/call')!.id
    respond(child, id, payload)
    expect(lifecycle.active).toBe(1)
    expect(lifecycle.release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    const receipt = await result
    expect(receipt).toEqual({ version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_REQUEST_TIMEOUT' })
    expect(lifecycle.active).toBe(1)
    respond(child, id, { result: { content: [] } })
    expect(lifecycle.active).toBe(0)
    expect(lifecycle.release).toHaveBeenCalledOnce()
    expect(receipt.commitState).toBe('unknown')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('keeps a malformed response effect until observed exit, never until a kill request alone', async () => {
    const child = await connectToolProcess()
    const result = mcpManager.callTool('fictional', 'write_fixture', {})
    const id = child.requests.find(request => request.method === 'tools/call')!.id
    respond(child, id, { result: null })
    await mcpManager.disconnect('fictional')
    await expect(result).resolves.toMatchObject({ success: false, commitState: 'unknown' })
    expect(lifecycle.active).toBe(1)
    child.emit('exit', 0)
    expect(lifecycle.active).toBe(0)
  })

  it('accepts the pinned text, image and embedded resource shapes without rejecting extensions', async () => {
    const child = await connectToolProcess()
    const result = mcpManager.callTool('fictional', 'write_fixture', {})
    const id = child.requests.find(request => request.method === 'tools/call')!.id
    respond(child, id, { result: { _meta: { fictional: true }, content: [
      { type: 'image', data: 'AA==', mimeType: 'image/png', annotations: { priority: 0.5 } },
      { type: 'resource', resource: { uri: 'fictional://text', text: 'embedded text', mimeType: 'text/plain' } },
      { type: 'resource', resource: { uri: 'fictional://blob', blob: 'AA==' } },
      { type: 'text', text: 'fictional visible tool result', extra: 'accepted extension' },
    ], isError: false } })
    await expect(result).resolves.toEqual({ version: 1, success: true, content: 'fictional visible tool result', commitState: 'committed' })
    expect(lifecycle.active).toBe(0)
  })
})

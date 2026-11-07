/**
 * MCP（Model Context Protocol）连接管理器
 *
 * 运行在 Electron 主进程，通过 stdio/SSE 管理与外部 MCP Server 的连接。
 * 兼容 Claude Desktop 的配置格式 (claude_desktop_config.json)。
 *
 * 架构：
 * - 主进程负责 MCP 连接的生命周期（启动子进程 / 建立 SSE）
 * - 通过 IPC 将可用 Tool 列表暴露给渲染进程
 * - 渲染进程通过 IPC 调用 MCP Tool
 */

import { spawn, type ChildProcess } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { isDeepStrictEqual } from 'node:util'
import { VELA_HOME } from '../utils/config-utils'
import { assertGlobalDataReady } from '../services/app-data-locator'
import { projectRuntimeHost } from '../services/project-runtime'
import type {
  MCPConfigLoadResult,
  MCPConnectionStatus,
  MCPResourceDescription,
  MCPServerStatus,
  MCPServerSummary,
  MCPToolDescription,
  MCPToolCallResult,
} from '../../src/shared/ipc-channels'

// ===== 类型定义 =====

/** MCP 服务器配置（兼容 Claude Desktop 格式） */
export interface MCPServerConfig {
  /** 服务器唯一 ID */
  id: string
  /** 显示名称 */
  name: string
  /** 传输协议 */
  transport: 'stdio' | 'sse'
  /** stdio 模式：要执行的命令 */
  command?: string
  /** stdio 模式：命令参数 */
  args?: string[]
  /** stdio 模式：环境变量 */
  env?: Record<string, string>
  /** SSE 模式：服务器 URL */
  url?: string
}

/** MCP 配置文件格式（兼容 Claude Desktop） */
export interface MCPConfig {
  mcpServers: Record<string, {
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
  }>
}

/** MCP Tool 描述 */
export interface MCPToolDesc extends MCPToolDescription {
  /** 工具名（MCP 原始名称） */
  name: string
  /** 描述 */
  description: string
  /** 输入 JSON Schema */
  inputSchema: Record<string, unknown>
  /** 所属服务器 ID */
  serverId: string
}

/** MCP 资源描述 */
export interface MCPResourceDesc extends MCPResourceDescription {
  uri: string
  name: string
  description?: string
  mimeType?: string
  serverId: string
}

class MCPRequestError extends Error {
  constructor(code: string, readonly commitState: 'not_committed' | 'unknown') { super(code) }
}

interface MCPRequestPending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  releaseEffect?: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Required response shapes from the negotiated MCP 2024-11-05 schema; extensions remain allowed. */
function isToolResult(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.content) || value.isError !== undefined && typeof value.isError !== 'boolean') return false
  return value.content.every(item => {
    if (!isRecord(item)) return false
    if (item.type === 'text') return typeof item.text === 'string'
    if (item.type === 'image') return typeof item.data === 'string' && typeof item.mimeType === 'string'
    if (item.type !== 'resource' || !isRecord(item.resource)) return false
    const resource = item.resource
    return typeof resource.uri === 'string' && (resource.mimeType === undefined || typeof resource.mimeType === 'string')
      && (typeof resource.text === 'string' || typeof resource.blob === 'string')
  })
}

/** 服务器运行时状态 */
interface MCPServerRuntime {
  config: MCPServerConfig
  status: MCPConnectionStatus
  process?: ChildProcess
  tools: MCPToolDesc[]
  resources: MCPResourceDesc[]
  error?: string
  /** 消息缓冲区（用于解析 JSON-RPC） */
  buffer: string
  /** 请求 ID 计数器 */
  nextRequestId: number
  /** 待响应的请求回调 */
  pendingRequests: Map<number, MCPRequestPending>
}

// ===== MCP Manager 实现 =====

class MCPManagerImpl {
  private servers: Map<string, MCPServerRuntime> = new Map()
  private loadedConfigs: Map<string, MCPServerConfig> = new Map()

  /** 状态变更通知回调（通知渲染进程） */
  private onStatusChange?: (serverId: string, status: MCPConnectionStatus, error?: string) => void
  /** Tool 列表变更回调 */
  private onToolsChange?: (tools: MCPToolDesc[]) => void

  /** 设置状态变更回调 */
  setCallbacks(callbacks: {
    onStatusChange?: (serverId: string, status: MCPConnectionStatus, error?: string) => void
    onToolsChange?: (tools: MCPToolDesc[]) => void
  }) {
    this.onStatusChange = callbacks.onStatusChange
    this.onToolsChange = callbacks.onToolsChange
  }

  /** 获取 MCP 配置文件默认路径 */
  getDefaultConfigPath(): string {
    assertGlobalDataReady()
    return join(VELA_HOME, 'mcp_config.json')
  }

  /**
   * 加载 MCP 配置文件
   * 兼容 Claude Desktop 格式
   */
  async loadConfig(): Promise<MCPConfigLoadResult> {
    const path = this.getDefaultConfigPath()
    this.loadedConfigs.clear()
    const revoke = async (result: MCPConfigLoadResult): Promise<MCPConfigLoadResult> => {
      await this.disconnectAll()
      return result
    }
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed: unknown = JSON.parse(raw)

      if (
        !parsed
        || typeof parsed !== 'object'
        || !('mcpServers' in parsed)
        || !parsed.mcpServers
        || typeof parsed.mcpServers !== 'object'
        || Array.isArray(parsed.mcpServers)
      ) {
        return revoke({ status: 'error', servers: [], error: 'MCP_CONFIG_INVALID' })
      }

      const servers: MCPServerSummary[] = []
      const trustedConfigs = new Map<string, MCPServerConfig>()
      for (const [id, value] of Object.entries(parsed.mcpServers)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return revoke({ status: 'error', servers: [], error: 'MCP_CONFIG_INVALID' })
        }
        const cfg = value as MCPConfig['mcpServers'][string]
        if (
          (cfg.command !== undefined && typeof cfg.command !== 'string')
          || (cfg.args !== undefined && (!Array.isArray(cfg.args) || cfg.args.some(arg => typeof arg !== 'string')))
          || (cfg.env !== undefined && (
            !cfg.env
            || typeof cfg.env !== 'object'
            || Array.isArray(cfg.env)
            || Object.values(cfg.env).some(entry => typeof entry !== 'string')
          ))
          || (cfg.url !== undefined && typeof cfg.url !== 'string')
        ) {
          return revoke({ status: 'error', servers: [], error: 'MCP_CONFIG_INVALID' })
        }
        const hasCommand = typeof cfg.command === 'string' && cfg.command.trim().length > 0
        const hasUrl = typeof cfg.url === 'string' && cfg.url.trim().length > 0
        if (hasCommand === hasUrl) {
          return revoke({ status: 'error', servers: [], error: 'MCP_CONFIG_INVALID' })
        }
        const trustedConfig: MCPServerConfig = {
          id,
          name: id,
          transport: hasUrl ? 'sse' : 'stdio',
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          url: cfg.url,
        }
        trustedConfigs.set(id, trustedConfig)
        servers.push({ id, name: id, transport: trustedConfig.transport })
      }
      for (const [id, runtime] of this.servers) {
        const trustedConfig = trustedConfigs.get(id)
        if (!trustedConfig || !isDeepStrictEqual(runtime.config, trustedConfig)) {
          await this.disconnect(id)
        }
      }
      this.loadedConfigs = trustedConfigs
      return { status: 'loaded', servers }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return revoke({ status: 'missing', servers: [] })
      }
      return revoke({ status: 'error', servers: [], error: 'MCP_CONFIG_INVALID' })
    }
  }

  /**
   * 连接到 MCP 服务器
   */
  async connect(serverId: string): Promise<void> {
    const config = this.loadedConfigs.get(serverId)
    if (!config) throw new Error('MCP_SERVER_NOT_CONFIGURED')
    if (this.servers.has(config.id)) {
      await this.disconnect(config.id)
    }

    const runtime: MCPServerRuntime = {
      config,
      status: 'connecting',
      tools: [],
      resources: [],
      buffer: '',
      nextRequestId: 1,
      pendingRequests: new Map(),
    }
    this.servers.set(config.id, runtime)
    this.notifyStatusChange(config.id, 'connecting')

    try {
      if (config.transport === 'stdio') {
        await this.connectStdio(runtime)
      } else {
        throw new Error('MCP_SSE_UNSUPPORTED')
      }

      // 初始化 MCP 会话
      await this.initializeSession(runtime)

      // 发现工具
      await this.discoverTools(runtime)

      // 发现资源
      await this.discoverResources(runtime)

      runtime.status = 'connected'
      this.notifyStatusChange(config.id, 'connected')
      this.notifyToolsChange()
    } catch {
      runtime.process?.kill()
      this.rejectRequests(runtime, 'MCP_CONNECT_FAILED')
      runtime.status = 'error'
      runtime.error = 'MCP_CONNECT_FAILED'
      this.notifyStatusChange(config.id, 'error', runtime.error)
      throw new Error(runtime.error)
    }
  }

  /** stdio 模式连接 */
  private async connectStdio(runtime: MCPServerRuntime): Promise<void> {
    const { command, args = [], env } = runtime.config
    if (!command) {
      throw new Error('MCP_STDIO_COMMAND_REQUIRED')
    }

    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    runtime.process = proc

    // 监听 stdout（JSON-RPC 消息）
    proc.stdout?.on('data', (data: Buffer) => {
      runtime.buffer += data.toString()
      this.processBuffer(runtime)
    })

    // 监听 stderr（调试日志）
    proc.stderr?.on('data', () => {
      console.warn('[MCP] server stderr received')
    })

    // 监听进程退出
    proc.on('exit', (code) => {
      console.log(`[MCP:${runtime.config.id}] 进程退出，code=${code}`)
      this.rejectRequests(runtime, 'MCP_TRANSPORT_CLOSED', true)
      if (this.servers.get(runtime.config.id) !== runtime || runtime.status === 'error') return
      runtime.status = 'disconnected'
      this.notifyStatusChange(runtime.config.id, 'disconnected')
    })

    const transportFailed = () => this.failTransport(runtime)
    proc.on('error', transportFailed)
    proc.stdin?.on?.('error', transportFailed)
    proc.stdout?.on('end', transportFailed)
  }

  /** 处理 JSON-RPC 消息缓冲区 */
  private processBuffer(runtime: MCPServerRuntime): void {
    // MCP 使用 \n 分隔的 JSON-RPC 消息
    const lines = runtime.buffer.split('\n')
    runtime.buffer = lines.pop() ?? '' // 保留最后一行（可能不完整）

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const msg = JSON.parse(trimmed)
        this.handleMessage(runtime, msg)
      } catch {
        // 非 JSON 行，忽略
      }
    }
  }

  /** 处理收到的 JSON-RPC 消息 */
  private handleMessage(runtime: MCPServerRuntime, msg: Record<string, unknown>): void {
    // 响应消息（有 id）
    if (msg.jsonrpc === '2.0' && typeof msg.id === 'number' && Number.isSafeInteger(msg.id) && ('result' in msg) !== ('error' in msg)) {
      const pending = runtime.pendingRequests.get(msg.id as number)
      if (pending) {
        if ('error' in msg) {
          if (!isRecord(msg.error) || typeof msg.error.code !== 'number' || !Number.isInteger(msg.error.code)
            || typeof msg.error.message !== 'string') return
        } else if (!isRecord(msg.result) || pending.releaseEffect && !isToolResult(msg.result)) return
        runtime.pendingRequests.delete(msg.id as number)
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        pending.releaseEffect?.()
        if ('error' in msg) {
          pending.reject(new MCPRequestError('MCP_TOOL_FAILED', 'unknown'))
        } else {
          pending.resolve(msg.result)
        }
      }
    }
    // 通知消息（无 id）— 暂时只记录日志
  }

  private failTransport(runtime: MCPServerRuntime): void {
    this.rejectRequests(runtime, 'MCP_TRANSPORT_ERROR')
    if (runtime.status === 'connecting') return
    runtime.status = 'error'
    runtime.error = 'MCP_TRANSPORT_ERROR'
    if (this.servers.get(runtime.config.id) === runtime) this.notifyStatusChange(runtime.config.id, 'error', runtime.error)
  }

  /** A transport failure stops waiting, not the already dispatched local effect. */
  private rejectRequests(runtime: MCPServerRuntime, code: string, exited = false): void {
    for (const [id, pending] of runtime.pendingRequests) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.timer = undefined
      if (!pending.releaseEffect || exited) {
        runtime.pendingRequests.delete(id)
        pending.releaseEffect?.()
      }
      pending.reject(new MCPRequestError(code, 'unknown'))
    }
  }

  /** 发送 JSON-RPC 请求 */
  private sendRequest(runtime: MCPServerRuntime, method: string, params?: unknown, acquireEffect?: () => () => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = runtime.nextRequestId++
      let message: string, releaseEffect: (() => void) | undefined
      const stdin = runtime.process?.stdin
      if (!stdin) {
        reject(new MCPRequestError('MCP_TRANSPORT_UNAVAILABLE', 'not_committed'))
        return
      }
      try {
        message = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })
        if (method === 'tools/call') releaseEffect = acquireEffect ? acquireEffect() : projectRuntimeHost.acquireApplicationOperation()
      } catch (error) {
        const code = error instanceof Error && /^(?:PROJECT_RUNTIME_[A-Z_]+|MCP_TRANSPORT_UNAVAILABLE)$/.test(error.message)
          ? error.message : 'MCP_REQUEST_REJECTED'
        reject(new MCPRequestError(code, 'not_committed'))
        return
      }
      const pending: MCPRequestPending = { resolve, reject, releaseEffect }
      runtime.pendingRequests.set(id, pending)
      // A tools/call timeout retires only the foreground waiter, never the effect lease.
      pending.timer = setTimeout(() => {
        if (runtime.pendingRequests.get(id) === pending) {
          pending.timer = undefined
          if (!releaseEffect) runtime.pendingRequests.delete(id)
          reject(new MCPRequestError('MCP_REQUEST_TIMEOUT', 'unknown'))
        }
      }, 10000)
      try {
        stdin.write(message + '\n', error => {
          if (error) this.failTransport(runtime)
        })
      } catch {
        this.failTransport(runtime)
      }
    })
  }

  /** 初始化 MCP 会话 */
  private async initializeSession(runtime: MCPServerRuntime): Promise<void> {
    await this.sendRequest(runtime, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'vela',
        version: '1.0.0',
      },
    })

    // 发送 initialized 通知
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    runtime.process?.stdin?.write(msg + '\n')
  }

  /** 发现可用工具 */
  private async discoverTools(runtime: MCPServerRuntime): Promise<void> {
    try {
      const result = await this.sendRequest(runtime, 'tools/list') as { tools?: MCPToolDesc[] }
      runtime.tools = (result?.tools ?? []).map(t => ({
        ...t,
        serverId: runtime.config.id,
      }))
    } catch {
      runtime.tools = []
    }
  }

  /** 发现可用资源 */
  private async discoverResources(runtime: MCPServerRuntime): Promise<void> {
    try {
      const result = await this.sendRequest(runtime, 'resources/list') as { resources?: MCPResourceDesc[] }
      runtime.resources = (result?.resources ?? []).map(r => ({
        ...r,
        serverId: runtime.config.id,
      }))
    } catch {
      runtime.resources = []
    }
  }

  /**
   * 调用 MCP Tool；acquireEffect 只接受主进程工厂，在实际发送前验证并取得 effect lease。
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>, acquireEffect?: () => () => void): Promise<MCPToolCallResult> {
    const runtime = this.servers.get(serverId)
    if (!runtime || runtime.status !== 'connected') {
      return { version: 1, success: false, content: '', commitState: 'not_committed', error: 'MCP_SERVER_NOT_CONNECTED' }
    }

    try {
      const result = await this.sendRequest(runtime, 'tools/call', {
        name: toolName,
        arguments: args,
      }, acquireEffect) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }

      if (result?.isError) return { version: 1, success: false, content: '', commitState: 'unknown', error: 'MCP_TOOL_FAILED' }

      const textParts = (result?.content ?? [])
        .filter(c => c?.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
        .join('\n')

      return { version: 1, success: true, content: textParts, commitState: 'committed' }
    } catch (error) {
      return { version: 1, success: false, content: '', commitState: error instanceof MCPRequestError ? error.commitState : 'unknown',
        error: error instanceof MCPRequestError ? error.message : 'MCP_TOOL_FAILED' }
    }
  }

  /** 断开服务器连接 */
  async disconnect(serverId: string): Promise<void> {
    const runtime = this.servers.get(serverId)
    if (!runtime) return

    runtime.process?.kill()
    this.rejectRequests(runtime, 'MCP_SERVER_NOT_CONNECTED')
    this.servers.delete(serverId)
    this.notifyStatusChange(serverId, 'disconnected')
    this.notifyToolsChange()
  }

  /** 断开所有连接 */
  async disconnectAll(): Promise<void> {
    for (const id of this.servers.keys()) {
      await this.disconnect(id)
    }
  }

  /** 获取所有 MCP Tool */
  getAllTools(): MCPToolDesc[] {
    const tools: MCPToolDesc[] = []
    for (const runtime of this.servers.values()) {
      if (runtime.status === 'connected') {
        tools.push(...runtime.tools)
      }
    }
    return tools
  }

  /** 获取所有 MCP 资源 */
  getAllResources(): MCPResourceDesc[] {
    const resources: MCPResourceDesc[] = []
    for (const runtime of this.servers.values()) {
      if (runtime.status === 'connected') {
        resources.push(...runtime.resources)
      }
    }
    return resources
  }

  /** 获取所有服务器状态 */
  getServersStatus(): MCPServerStatus[] {
    return Array.from(this.servers.values()).map(r => ({
      id: r.config.id,
      name: r.config.name,
      status: r.status,
      toolCount: r.tools.length,
      error: r.error,
    }))
  }

  private notifyStatusChange(serverId: string, status: MCPConnectionStatus, error?: string) {
    this.onStatusChange?.(serverId, status, error)
  }

  private notifyToolsChange() {
    this.onToolsChange?.(this.getAllTools())
  }
}

/** 全局单例 MCP Manager */
export const mcpManager = new MCPManagerImpl()

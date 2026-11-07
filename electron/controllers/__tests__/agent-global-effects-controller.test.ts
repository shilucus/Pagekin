import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGenerationInput, AgentToolClaim } from '../../../src/shared/agent-generation'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { ProjectRuntime } from '../../services/project-runtime'
import { WINDOWS_RUNNER_IO_STALL_TIMEOUT_MS } from '../../../test/helpers/windows-runner-io-stall'

type Handler = (...args: unknown[]) => Promise<unknown>
type Effect = 'inspect' | 'install' | 'mcp'
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))

class Sender extends EventEmitter {
  id = 7
  gone = false
  send = vi.fn()
  isDestroyed() { return this.gone }
  destroy() { this.gone = true; this.emit('destroyed') }
}

const sourceUrl = 'https://github.com/acme/fictional-skill/blob/main/SKILL.md'
const skillText = '---\nname: fictional-prose\ndescription: Concrete prose.\nversion: 1.0.0\nlanguage: en-US\nstage: refinement\n---\nUse concrete action.'
const model: ModelProfile = { id: 'fictional-global-effect', name: 'Fictional model', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://fictional.invalid/v1', apiKey: 'synthetic-only', maxTokens: 2048, temperature: 0.7, purposes: ['generation'] }
const fixturePrefix = path.join(os.tmpdir(), 'pagekin-agent-global-effects-')
let root: string, dataRoot: string, sender: Sender, skillFetches: number, agentReply: string
let host: typeof import('../../services/project-runtime').projectRuntimeHost
let access: typeof import('../../services/project-access').projectAccess
let session: ProjectSessionContext
let child: ReturnType<typeof createChild>
let settleSkill: (() => void) | undefined
let holdSkill: boolean
const pending: Promise<unknown>[] = []

function invoke(channel: string, ...args: unknown[]) {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_FICTIONAL_HANDLER:${channel}`)
  return handler({ sender }, ...args)
}

function createChild() {
  const process = new EventEmitter(), stdout = new EventEmitter(), stderr = new EventEmitter()
  const toolWrites: number[] = [], outstanding: number[] = []
  const stdin = Object.assign(new EventEmitter(), { write: vi.fn((raw: string) => {
    const request = JSON.parse(raw) as { id?: number; method: string }
    if (request.id === undefined) return true
    if (request.method === 'tools/call') { toolWrites.push(request.id); outstanding.push(request.id); return true }
    const result = request.method === 'tools/list' ? { tools: [{ name: 'touch', description: 'Fictional effect', inputSchema: { type: 'object' } }] }
      : request.method === 'resources/list' ? { resources: [] } : {}
    queueMicrotask(() => stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')))
    return true
  }) })
  return Object.assign(process, { stdout, stderr, stdin, toolWrites, kill: vi.fn(), complete: () => {
    for (const id of outstanding.splice(0)) stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: 'Fictional tool finished.' }] } }) + '\n'))
  } })
}

async function openBook(name: string): Promise<ProjectRuntime> {
  const project = access.createProject(root, name)
  ;(await import('../../database')).createProjectDatabase(project.rootPath)
  const runtime = host.commitOpen(host.prepareRetainedOpen(project))
  runtime.database.exec("INSERT INTO project_core(id,project_name,genre,global_guidance) VALUES('main','Fictional project','Fantasy','Author guidance')")
  const lease = access.beginViewSession(runtime)
  session = { projectId: lease.projectId, projectPath: lease.rootPath, leaseId: lease.leaseId }
  return runtime
}

async function prepare(effect: Effect) {
  if (effect !== 'mcp') expect(await invoke('skills:inspect-github', sourceUrl)).toMatchObject({ success: true })
  else {
    fs.writeFileSync(path.join(dataRoot, 'mcp_config.json'), JSON.stringify({ mcpServers: { fictional: { command: 'fictional-not-executed' } } }))
    expect(await invoke('mcp:load-config')).toMatchObject({ success: true })
    expect(await invoke('mcp:connect', 'fictional')).toMatchObject({ success: true })
  }
}

async function claim(effect: Effect): Promise<AgentToolClaim> {
  const name = effect === 'inspect' ? 'inspect_writing_skill' : effect === 'install' ? 'install_writing_skill' : 'mcp__fictional__touch'
  const args = effect !== 'mcp' ? { source_url: sourceUrl } : { value: 'confirmed' }
  agentReply = `Visible fictional reply.<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`
  const input: AgentGenerationInput = { mode: 'planning', uiLocale: 'en-US', historyMessages: [], userMessage: 'Fictional confirmed task',
    tools: [{ name, description: 'Fictional tool', inputSchema: { type: 'object' }, requiresConfirmation: effect !== 'inspect',
      isReadOnly: effect === 'inspect', source: effect !== 'mcp' ? 'builtin' : 'mcp' }] }
  const started = await invoke('agent-generation:begin', { uiActionNonce: randomUUID(), modelId: model.id, input }, session) as import('../../../src/shared/agent-generation').AgentGenerationRecovery
  const round = await invoke('agent-generation:round', { handle: started.handle, index: 0 }, session) as typeof started
  const result = await invoke('agent-generation:claim-tool', { ref: round.rounds[0].actions[0].ref, confirmed: true }, session) as AgentToolClaim
  expect(result.execute).toBe(true)
  expect(result.globalExecution).toMatchObject({ version: 1, token: expect.any(String) })
  return result
}

function start(effect: Effect, execution: unknown, caller = sender, changed = false) {
  const handler = mocks.handlers.get(effect === 'inspect' ? 'skills:inspect-github' : effect === 'install' ? 'skills:install-github' : 'mcp:call-tool')!
  return effect !== 'mcp' ? handler({ sender: caller }, changed ? sourceUrl.replace('main', 'other') : sourceUrl, execution)
    : handler({ sender: caller }, 'fictional', 'touch', { value: changed ? 'replaced' : 'confirmed' }, execution)
}

function effects(effect: Effect) { return effect !== 'mcp' ? skillFetches : child.toolWrites.length }

beforeEach(async () => {
  vi.resetModules(); mocks.handlers.clear(); mocks.spawn.mockReset()
  root = fs.mkdtempSync(fixturePrefix)
  dataRoot = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(root)
  sender = new Sender(); skillFetches = 0; agentReply = ''; settleSkill = undefined; holdSkill = false
  child = createChild(); mocks.spawn.mockReturnValue(child)
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).startsWith('https://raw.githubusercontent.com/')) {
      skillFetches++
      if (holdSkill) await new Promise<void>(resolve => { settleSkill = resolve })
      return new Response(skillText, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: agentReply }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 })
  }))
  ;(await import('../app-data-controller')).registerAppDataController()
  const { ModelExecutionLeaseRegistry } = await import('../../services/model-execution-lease')
  ;(await import('../generation-controller')).registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
    loadModel: () => model, applyProxyConfig: () => {} })
  ;(await import('../db-controller')).registerDatabaseController()
  ;(await import('../../mcp/mcp-ipc-bridge')).registerMCPHandlers()
  host = (await import('../../services/project-runtime')).projectRuntimeHost
  access = (await import('../../services/project-access')).projectAccess
}, WINDOWS_RUNNER_IO_STALL_TIMEOUT_MS)

afterEach(async () => {
  settleSkill?.(); child.complete(); child.emit('exit', 0)
  await Promise.allSettled(pending.splice(0))
  await host.requestCloseAll({ timeoutMs: 0 })
  access.invalidateCurrentSession()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  delete process.env.AI_NOVEL_VELA_HOME; delete process.env.AI_NOVEL_APP_DATA_HOME
  if (!path.resolve(root).startsWith(path.resolve(fixturePrefix))) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_OWNED_ROOT')
  fs.rmSync(root, { recursive: true, force: true })
}, WINDOWS_RUNNER_IO_STALL_TIMEOUT_MS)

describe('registered Agent claim to actual global effect admission', { timeout: WINDOWS_RUNNER_IO_STALL_TIMEOUT_MS }, () => {
  it('keeps B same-URL inspection when a closed A sends its old inspect credential', async () => {
    const a = await openBook('Fiction A'), stale = await claim('inspect')
    expect(await invoke('db:close', session.projectPath, session)).toEqual({ success: true })
    expect(a.database.open).toBe(false)
    await openBook('Fiction B')
    expect(await invoke('skills:inspect-github', sourceUrl)).toMatchObject({ success: true })
    const before = skillFetches
    expect(await start('inspect', stale.globalExecution!)).toMatchObject({ success: false })
    expect(skillFetches).toBe(before)
    const owned = await claim('install')
    expect(await start('install', owned.globalExecution!)).toMatchObject({ success: true, skill: { name: 'fictional-prose' } })
    expect(skillFetches).toBe(before + 1)
  })

  it.each(['install', 'mcp'] as const)('refuses a late %s after true A close while B and explicit application actions remain available', async effect => {
    await prepare(effect)
    const a = await openBook('Fiction A'), aClaim = await claim(effect), before = effects(effect)
    expect(await invoke('db:close', session.projectPath, session)).toEqual({ success: true })
    expect(a.database.open).toBe(false)
    expect(await start(effect, aClaim.globalExecution!)).toMatchObject({ success: false })
    expect(effects(effect)).toBe(before)
    if (effect === 'install') expect(await invoke('skills:inspect-github', sourceUrl)).toMatchObject({ success: true })
    else {
      const direct = invoke('mcp:call-tool', 'fictional', 'touch', { value: 'explicit application action' })
      child.complete(); expect(await direct).toMatchObject({ success: true, commitState: 'committed' })
    }
    const b = await openBook('Fiction B'), bClaim = await claim(effect), operation = start(effect, bClaim.globalExecution!)
    child.complete(); expect(await operation).toMatchObject({ success: true })
    expect(b.database.open).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'skills', 'fictional-prose', 'SKILL.md'))).toBe(effect === 'install')
  })

  it.each(['install', 'mcp'] as const)('binds %s to its exact sender, arguments and single actual dispatch', async effect => {
    await prepare(effect); await openBook('Fiction A')
    const owned = await claim(effect), before = effects(effect)
    for (const invalid of [null, {}, { version: 1, token: 'missing' }, { ...owned.globalExecution!, version: 2 },
      { ...owned.globalExecution!, unexpected: true }]) {
      expect(await start(effect, invalid)).toMatchObject({ success: false })
    }
    expect(await start(effect, owned.globalExecution!, new Sender())).toMatchObject({ success: false })
    expect(await start(effect, owned.globalExecution!, sender, true)).toMatchObject({ success: false })
    expect(effects(effect)).toBe(before)
    const operation = start(effect, owned.globalExecution!)
    child.complete(); expect(await operation).toMatchObject({ success: true })
    expect(await start(effect, owned.globalExecution!)).toMatchObject({ success: false })
    expect(effects(effect)).toBe(before + 1)
  })

  it.each(['install', 'mcp'] as const)('revokes unstarted %s on a terminal finish without reconstructing it from history', async effect => {
    await prepare(effect); await openBook('Fiction A')
    const owned = await claim(effect), before = effects(effect)
    await invoke('agent-generation:finish-tool', { ref: owned.action.ref, status: 'unknown', observation: 'Fictional stopped waiter' }, session)
    expect(await start(effect, owned.globalExecution!)).toMatchObject({ success: false })
    expect(effects(effect)).toBe(before)
  })

  it.each(['install', 'mcp'] as const)('revokes an unstarted %s when its exact sender disappears', async effect => {
    await prepare(effect); await openBook('Fiction A')
    const owned = await claim(effect), before = effects(effect)
    sender.destroy()
    expect(await start(effect, owned.globalExecution!)).toMatchObject({ success: false })
    expect(effects(effect)).toBe(before)
  })

  it.each(['install', 'mcp'] as const)('keeps the actual admitted %s alive through sender loss and logical unknown until physical completion', async effect => {
    await prepare(effect)
    const a = await openBook('Fiction A'), owned = await claim(effect)
    if (effect === 'install') holdSkill = true
    const operation = start(effect, owned.globalExecution!); pending.push(operation)
    sender.destroy()
    await expect(host.requestClose(a, { timeoutMs: 0 })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
    expect(a.database.open).toBe(true)
    const usage = a.database.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(owned.action.ref.attemptId) as string
    expect(JSON.parse(usage).agentActions[owned.action.ref.toolCallId].status).toBe('unknown')
    if (effect === 'install') {
      expect(fs.existsSync(path.join(dataRoot, 'skills', 'fictional-prose', 'SKILL.md'))).toBe(false)
      settleSkill!()
    } else child.complete()
    expect(await operation).toMatchObject({ success: true })
    await host.requestClose(a, { timeoutMs: 0 })
    expect(a.database.open).toBe(false)
  })
})

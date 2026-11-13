import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => ({ modelId: 'fictional-embedding', protocol: 'openai',
  model: { provider: 'openai', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-only', modelName: 'fictional-embedding' } }) }))
import { registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { MainGenerationScheduler } from '../../services/generation-scheduler'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import { addChunks } from '../../vector-store'

const model: ModelProfile = { id: 'fictional-model', name: 'Fictional model', provider: 'openai', protocol: 'openai',
  modelName: 'fictional-model', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-only', temperature: 0.7,
  maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048,
    reasoning: false, structuredOutput: true, usage: true } }
const scheduler = new MainGenerationScheduler({ global: 2, provider: 2, credential: 2, model: 2, project: 1,
  maxQueued: 16, maxQuarantined: 2, interactiveBurst: 1 }, 60)
class Sender extends EventEmitter { send = vi.fn(); isDestroyed() { return false } }
const sender = new Sender()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const runId = 'fictional-reference-run'
const slot = { runId, stage: 'global' as const, batchId: 'done' }
let root: string, session: ProjectSessionContext
let project: ReturnType<typeof projectAccess.createProject>
beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
    loadModel: () => model, applyProxyConfig: () => {}, scheduler })
  registerDatabaseController()
})
beforeEach(() => {
  const base = path.resolve('.runtime/iq62')
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'f-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  expect(path.resolve(root, 'Fictional reference').length).toBeLessThanOrEqual(85)
  project = projectAccess.createProject(root, 'Fictional reference')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.prepare("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','Fictional reference',100)").run()
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
})
afterEach(async () => {
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) await projectRuntimeHost.requestClose(runtime)
  closeProjectDatabase(); projectAccess.invalidateCurrentSession(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  const base = path.resolve('.runtime/iq62'), absolute = path.resolve(root)
  const relative = path.relative(base, absolute)
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    || fs.lstatSync(absolute).isSymbolicLink() || normalize(fs.realpathSync.native(base)) !== normalize(base)
    || normalize(fs.realpathSync.native(absolute)) !== normalize(absolute)) throw new Error('FIXTURE_CLEANUP_UNSAFE')
  fs.rmSync(absolute, { recursive: true, force: true })
})
function invoke<T>(channel: string, payload: unknown, context = session): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender }, payload, { ...context }) as Promise<T>
}
async function begin() {
  const content = 'A fictional letter arrived at the harbor.'
  ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash('fictional-source'), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'Fictional chapter', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }] })
  const execution = ImportRunRepository.startOrResume(runId, 'fictional-owner', Date.now(), 60_000).execution
  // This fixture isolates global generation; it does not exercise knowledge-stage checkpoint admission.
  getProjectDb()!.prepare("UPDATE import_runs SET stage='global' WHERE id=?").run(runId)
  const request: BeginGenerationRequest = { operation: 'import-global-facts', uiActionNonce: 'fictional-global', modelId: model.id,
    promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'], skillStages: ['planning'], selectedDraftIds: [],
    selectedFinalizedDraftIds: [], output: 'structured-data', importSlot: slot, importExecution: execution }
  const view = await invoke<{ handle: MainGenerationRunHandle }>('generation:begin', request)
  return { request, execution, handle: view.handle }
}
function queryAuthority(execution: { owner: string; epoch: number }) {
  return { owner: execution.owner, epoch: execution.epoch }
}
function embeddingTransport() {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const task = { purpose: 'import-global-facts', output: 'structured-data',
  messages: [{ role: 'user', content: 'Summarize the fictional reference.' }] }
const modelResponse = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"fictional":true}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } })
async function changeKnowledge() {
  await addChunks(session.projectPath, 'fictional-document', 'fictional.txt', ['A fictional changed harbor.'], undefined, undefined,
    { corpusKind: 'project-knowledge' })
}
function dbCall<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender }, ...args, session.projectPath, { ...session }) as Promise<T>
}
function globalEffect(handle: MainGenerationRunHandle) {
  return { runId, stage: 'global', batchId: 'done', effectKey: 'global-facts', kind: 'project-global-facts', payload: {
    operationId: `novel-import-global-${runId}`, expectedRosterRevision: 0, generationRunHandle: handle,
    core: { genre: 'fiction', subGenre: 'adventure', targetAudience: 'general', totalChapters: 1, wordsPerChapter: 900,
      plotStructure: 'three_act', narrativePov: 'third_limited', goldenFinger: 'A fictional gift', globalGuidance: 'Follow the letter', premise: 'A letter',
      coreOutline: 'Find its sender', worldSetting: 'A harbor', protagonistProfile: 'A courier', worldbuilding: 'The harbor', synopsis: 'A letter' },
    characterEntries: [{ name: 'Courier', role: 'protagonist', gender: 'unknown', age: '18', appearance: 'plain',
      personality: 'careful', background: 'harbor resident', abilities: 'observation', motivation: 'find sender', relationships: [], arc: 'growth', notes: '' }],
  } }
}

describe('reference import query registered IPC', () => {
  it('requires a completed query plan before reference global LLM dispatch', async () => {
    const fetch = embeddingTransport(), { handle, execution } = await begin()
    await expect(invoke('import-generation:execute', { handle, execution, ordinal: 0, task }))
      .rejects.toThrow('GENERATION_IMPORT_QUERY_REQUIRED')
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM import_query_plans').pluck().get()).toBe(0)
  })
  it('holds the scheduler and physical clock after cancel until ignored-abort fetch drains', async () => {
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.fn(async () => {
      started(); await gate
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const { handle, execution } = await begin()
    const pending = invoke('import-generation:v1:query-materials', { handle, execution: queryAuthority(execution) })
      .then(() => 'unexpected-success', error => (error as Error).message)
    let outcome = ''
    try {
      const entry = await Promise.race([entered.then(() => 'entered'), pending.then(result => `before-fetch:${result}`)])
      expect(entry).toBe('entered')
      await invoke('generation:cancel', handle)
      expect(scheduler.getStats().occupied).toBe(1)
      expect(getProjectDb()!.prepare('SELECT active_since_ms FROM generation_roots WHERE root_action_id=?').pluck().get(handle.rootActionId)).not.toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { release(); outcome = await pending }
    expect(outcome).toBe('GENERATION_ACTION_CANCELLED')
    await vi.waitFor(() => expect(scheduler.getStats().occupied).toBe(0))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL').pluck().get()).toBe(1)
    expect(getProjectDb()!.prepare('SELECT active_since_ms FROM generation_roots WHERE root_action_id=?').pluck().get(handle.rootActionId)).toBeNull()
  })
  it('reopens a completed plan under a new lease without embedding again', async () => {
    const fetch = embeddingTransport(), { handle, execution } = await begin()
    const first = await invoke<{ topics: unknown[] }>('import-generation:v1:query-materials', { handle, execution: queryAuthority(execution) })
    expect(fetch).toHaveBeenCalledTimes(4)
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId)
    expect(runtime).toBeDefined()
    await projectRuntimeHost.requestClose(runtime!)
    closeProjectDatabase(); projectAccess.invalidateCurrentSession()
    initProjectDatabase(project.rootPath)
    session = { ...session, leaseId: projectAccess.beginSession(project).leaseId }
    const recovered = await invoke<{ view: { handle: MainGenerationRunHandle } }>('import-generation:read', { slot, runId: handle.runId })
    expect(session.leaseId).not.toBe(handle.epoch)
    expect(recovered.view.handle).toEqual(handle)
    expect(projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId)?.executionEpoch).not.toBe(runtime!.executionEpoch)
    await expect(invoke('import-generation:v1:query-materials', { handle: recovered.view.handle, execution: queryAuthority(execution) }))
      .rejects.toThrow('GENERATION_REQUEST_FAILED')
    const renewed = ImportRunRepository.startOrResume(runId, 'fictional-owner', Date.now(), 60_000).execution
    expect(renewed.epoch).toBeGreaterThan(execution.epoch)
    const replay = await invoke<{ topics: unknown[] }>('import-generation:v1:query-materials', { handle: recovered.view.handle, execution: queryAuthority(renewed) })
    expect(replay.topics).toEqual(first.topics)
    expect(fetch).toHaveBeenCalledTimes(4)
  })
  it('rejects LLM dispatch when query knowledge changes after capture', async () => {
    const fetch = embeddingTransport(), { handle, execution } = await begin()
    await invoke('import-generation:v1:query-materials', { handle, execution: queryAuthority(execution) })
    await changeKnowledge()
    await expect(invoke('import-generation:execute', { handle, execution, ordinal: 0, task }))
      .rejects.toThrow('GENERATION_REQUEST_FAILED')
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
  })
  it.each(['prepared', 'committed'] as const)('fences a %s global effect and preserves a committed ACK after knowledge changes', async state => {
    const fetch = embeddingTransport(), { handle, execution } = await begin()
    await invoke('import-generation:v1:query-materials', { handle, execution: queryAuthority(execution) })
    fetch.mockImplementation(async () => modelResponse())
    const generated = await invoke<{ outcome: { status: string } }>('import-generation:execute', { handle, execution, ordinal: 0, task })
    expect(generated.outcome.status).toBe('completed')
    const prepared = await dbCall<{ success: boolean; receipt: { state: string } }>('db:import-run-effect-receipt-prepare', globalEffect(handle), execution)
    expect(prepared).toMatchObject({ success: true, receipt: { state: 'prepared' } })
    if (state === 'committed') {
      const committed = await dbCall('db:import-run-effect-receipt-commit', runId, 'global', 'done', execution)
      expect(committed, JSON.stringify(committed)).toHaveProperty('success', true)
      expect(committed).toMatchObject({ success: true, result: { receipt: { state: 'committed' } } })
    }
    await changeKnowledge()
    const result = await dbCall('db:import-run-effect-receipt-commit', runId, 'global', 'done', execution)
    if (state === 'prepared') {
      expect(result).toMatchObject({ success: false, errorCode: 'REFERENCE_IMPORT_KNOWLEDGE_SOURCE_STALE' })
      expect(getProjectDb()!.prepare('SELECT count(*) FROM import_global_fact_operations').pluck().get()).toBe(0)
      expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')?.state).toBe('prepared')
    } else {
      expect(result).toMatchObject({ success: true, result: { receipt: { state: 'committed' } } })
      expect(getProjectDb()!.prepare('SELECT count(*) FROM import_global_fact_operations').pluck().get()).toBe(1)
    }
    expect(fetch).toHaveBeenCalledTimes(5)
  })
  it('rejects extra payload fields and stale execution before any physical request', async () => {
    const fetch = embeddingTransport(), { handle, execution } = await begin()
    await expect(invoke('import-generation:v1:query-materials', { handle, execution: queryAuthority(execution), modelId: 'forged' }))
      .rejects.toThrow('GENERATION_IMPORT_QUERY_INVALID')
    await expect(invoke('import-generation:v1:query-materials', { handle, execution }))
      .rejects.toThrow('GENERATION_IMPORT_QUERY_INVALID')
    await expect(invoke('import-generation:v1:query-materials', { handle, execution: { ...queryAuthority(execution), epoch: execution.epoch + 1 } }))
      .rejects.toThrow('GENERATION_REQUEST_FAILED')
    await expect(invoke('import-generation:v1:query-materials', { handle, execution: queryAuthority(execution) }, { ...session, leaseId: 'stale-fictional-lease' }))
      .rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT count(*) FROM import_query_plans').pluck().get()).toBe(0)
  })
  it('charges four fixed query requests to the generation root and replays without another fetch', async () => {
    const fetch = embeddingTransport(), { handle, execution } = await begin()
    const request = { handle, execution: queryAuthority(execution) }
    const first = await invoke<{ version: number; topics: { key: string }[] }>('import-generation:v1:query-materials', request)
    expect(first.version).toBe(1)
    expect(first.topics.map(topic => topic.key)).toEqual(['worldview', 'protagonist', 'conflict', 'style'])
    expect(fetch).toHaveBeenCalledTimes(4)
    const db = getProjectDb()!
    expect(db.prepare('SELECT root_action_id FROM import_query_plans').pluck().get()).toBe(handle.rootActionId)
    expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL AND physical_closed_at_ms IS NOT NULL').pluck().get()).toBe(4)
    expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
    const second = await invoke<typeof first>('import-generation:v1:query-materials', request)
    expect(second.topics).toEqual(first.topics)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(db.prepare('SELECT count(*) FROM import_query_topics').pluck().get()).toBe(4)
    fetch.mockImplementation(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"fictional":true}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const generated = await invoke<{ outcome: { status: string } }>('import-generation:execute', {
      handle, execution, ordinal: 0, task: { purpose: 'import-global-facts', output: 'structured-data',
        messages: [{ role: 'user', content: 'Summarize the fictional reference.' }] },
    })
    expect(generated.outcome.status).toBe('completed')
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(db.prepare('SELECT root_action_id FROM generation_attempts').pluck().get()).toBe(handle.rootActionId)
    expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(1)
  })
  it('does not resend a transport-unknown marked topic on the same handle or a fresh nonce', async () => {
    const fetch = vi.fn(async () => { throw new Error('fictional transport failure') })
    vi.stubGlobal('fetch', fetch)
    const { handle, execution, request } = await begin()
    await expect(invoke('import-generation:v1:query-materials', { handle, execution: queryAuthority(execution) })).rejects.toThrow('GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN')
    await expect(invoke('import-generation:v1:query-materials', { handle, execution: queryAuthority(execution) })).rejects.toThrow('GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN')
    await expect(invoke('generation:begin', { ...request, uiActionNonce: 'fictional-new-nonce' })).rejects.toThrow('GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL').pluck().get()).toBe(1)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
  })
})

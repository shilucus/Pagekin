import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'
import type { ImportQueryMaterialsResponse } from '../../../src/shared/import-generation'
import { getImportInferenceTopics } from '../../../src/shared/import-inference-materials'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '', concurrency: 1 }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => ({ modelId: 'fictional-embedding', protocol: 'openai',
  model: { provider: 'openai', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-only', modelName: 'fictional-embedding',
    embeddingOptions: { chunkSize: 500, chunkOverlap: 50, batchSize: 50, concurrencyLimit: mocks.concurrency } } }) }))
import { registerGenerationController } from '../generation-controller'
import { registerLLMController } from '../llm-controller'
import { registerDatabaseController } from '../db-controller'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { MainGenerationScheduler } from '../../services/generation-scheduler'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import { addChunks } from '../../vector-store'

const model: ModelProfile = { id: 'fictional-model', name: 'Fictional model', provider: 'openai', protocol: 'openai',
  modelName: 'fictional-model', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-only', temperature: 0.7,
  maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048,
    reasoning: false, structuredOutput: true, usage: true } }
class Sender extends EventEmitter { readonly id = 7102; send = vi.fn(); isDestroyed() { return false } }
const sender = new Sender()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const runId = 'fictional-reference-run'
const slot = { runId, stage: 'global' as const, batchId: 'done' }
let root = '', session: ProjectSessionContext

beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
    loadModel: () => model, applyProxyConfig: () => {} })
  registerDatabaseController()
})
async function cleanup() {
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) await projectRuntimeHost.requestClose(runtime)
  closeProjectDatabase(); projectAccess.invalidateCurrentSession(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  if (!root) return
  const base = path.resolve('.runtime/iq63'), absolute = path.resolve(root), relative = path.relative(base, absolute)
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    || fs.lstatSync(absolute).isSymbolicLink() || normalize(fs.realpathSync.native(base)) !== normalize(base)
    || normalize(fs.realpathSync.native(absolute)) !== normalize(absolute)) throw new Error('FIXTURE_CLEANUP_UNSAFE')
  fs.rmSync(absolute, { recursive: true, force: true }); root = ''
}
afterEach(cleanup)
function invoke<T>(channel: string, payload: unknown): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender }, payload, { ...session }) as Promise<T>
}
async function setup(concurrency: number) {
  mocks.concurrency = concurrency
  const base = path.resolve('.runtime/iq63')
  fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, 'f-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  expect(path.resolve(root, 'Fictional reference').length).toBeLessThanOrEqual(85)
  const project = projectAccess.createProject(root, 'Fictional reference')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.prepare("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','Fictional reference',100)").run()
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
  const identity = { modelFingerprint: 'openai|https://fictional.invalid/v1|fictional-embedding', distanceMetric: 'l2' as const }
  expect(await addChunks(project.rootPath, 'fictional-reference', 'reference.txt', ['A courier finds a letter at the harbor.'],
    [[1, 0]], undefined, { corpusKind: 'reference', replacementMode: 'stable-id' }, identity)).toMatchObject({ success: true })
  expect(await addChunks(project.rootPath, 'fictional-project', 'project.txt', ['A harbor mystery and a careful courier.'],
    [[0.8, 0.2]], undefined, { corpusKind: 'project-knowledge', replacementMode: 'stable-id' }, identity)).toMatchObject({ success: true })
  const content = 'A fictional letter arrived at the harbor.'
  ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash('fictional-source'), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'Fictional chapter', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }] })
  const execution = ImportRunRepository.startOrResume(runId, 'fictional-owner', Date.now(), 60_000).execution
  // Isolate global generation; knowledge-stage checkpoint admission is covered elsewhere.
  getProjectDb()!.prepare("UPDATE import_runs SET stage='global' WHERE id=?").run(runId)
  const request: BeginGenerationRequest = { operation: 'import-global-facts', uiActionNonce: 'fictional-global', modelId: model.id,
    promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'], skillStages: ['planning'], selectedDraftIds: [],
    selectedFinalizedDraftIds: [], output: 'structured-data', importSlot: slot, importExecution: execution }
  const view = await invoke<{ handle: MainGenerationRunHandle }>('generation:begin', request)
  return { handle: view.handle, execution: { owner: execution.owner, epoch: execution.epoch } }
}

async function measure(concurrency: number) {
  const request = await setup(concurrency)
  const releases: Array<() => void> = [], completion: number[] = []
  const issued: string[] = []
  let active = 0, peak = 0, draining = false
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { input: string[] }
    expect(payload.input).toHaveLength(1)
    const topic = [...getImportInferenceTopics('zh-CN'), ...getImportInferenceTopics('en-US')]
      .find(item => item.query === payload.input[0])
    expect(topic).toBeDefined()
    issued.push(topic!.key)
    const index = releases.length
    active++; peak = Math.max(peak, active)
    await new Promise<void>(resolve => { releases.push(resolve); if (draining) resolve() })
    active--; completion.push(index)
    const vector = topic!.key === 'worldview' || topic!.key === 'conflict' ? [1, 0] : [0, 1]
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  const started = Date.now()
  const pending = invoke<ImportQueryMaterialsResponse>('import-generation:v1:query-materials', request)
  void pending.catch(() => {})
  try {
    for (let i = 0; i < 4; i += concurrency) {
      const count = Math.min(4, i + concurrency)
      await vi.waitFor(() => expect(releases.length).toBeGreaterThanOrEqual(count), { timeout: 4000 })
      for (let j = count - 1; j >= i; j--) releases[j]()
    }
    const result = await pending
    const elapsedMs = Date.now() - started
    expect(result.topics.map(topic => topic.key)).toEqual(['worldview', 'protagonist', 'conflict', 'style'])
    for (const topic of result.topics) expect(topic.results?.length).toBeGreaterThan(0)
    expect([...issued].sort()).toEqual(['conflict', 'protagonist', 'style', 'worldview'])
    expect(result.topics[0].results?.[0].fileName).not.toBe(result.topics[1].results?.[0].fileName)
    expect(fetch).toHaveBeenCalledTimes(4)
    const db = getProjectDb()!
    expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL AND physical_closed_at_ms IS NOT NULL').pluck().get()).toBe(4)
    const receipts = db.prepare('SELECT query_id,receipt_fingerprint FROM import_query_topics ORDER BY query_id').all()
    expect(result.run.handle).toEqual(request.handle)
    const replay = await invoke<typeof result>('import-generation:v1:query-materials', request)
    expect(replay.run.handle).toEqual(request.handle)
    expect(replay.topics).toEqual(result.topics)
    expect(db.prepare('SELECT query_id,receipt_fingerprint FROM import_query_topics ORDER BY query_id').all()).toEqual(receipts)
    expect(fetch).toHaveBeenCalledTimes(4)
    return { topics: result.topics, peak, completion, elapsedMs }
  } finally {
    draining = true; releases.forEach(release => release())
    await pending.catch(() => {})
  }
}

describe('registered reference query overlap', () => {
  it.each(['unchanged', 'changed'] as const)('shares the slot with the actual owner and rechecks %s source', async source => {
    const scheduler = new MainGenerationScheduler({ global: 1, provider: 1, credential: 1, model: 1, project: 1,
      maxQueued: 8, maxQuarantined: 2, interactiveBurst: 1 }, 16)
    registerGenerationController({ scheduler, modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
      loadModel: () => model, applyProxyConfig: () => {} })
    ;(registerLLMController as unknown as (options: { scheduler: MainGenerationScheduler }) => unknown)({ scheduler })
    let releaseProbe!: () => void
    const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
    let queryPhase = true
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (queryPhase) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 })
      const body = JSON.parse(String(init?.body)) as { stream?: boolean }
      if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"fictional"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } })
      await probeGate
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    let probe: Promise<unknown> | undefined, generation: Promise<unknown> | undefined
    try {
      const request = await setup(2)
      await invoke('import-generation:v1:query-materials', request)
      expect(fetch).toHaveBeenCalledTimes(4)
      queryPhase = false
      const direct = mocks.handlers.get('llm:test-connection')!
      probe = direct({ sender }, model)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5), { timeout: 4000 })
      generation = invoke('import-generation:execute', { ...request, ordinal: 0,
        task: { purpose: 'import-global-facts', output: 'structured-data', messages: [{ role: 'user', content: 'Fictional facts.' }] } })
      void generation.catch(() => {})
      await vi.waitFor(() => expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 }), { timeout: 4000 })
      const db = getProjectDb()!
      expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
      if (source === 'changed') db.prepare("UPDATE project_core SET global_guidance='Changed fictional source' WHERE id='main'").run()
      releaseProbe()
      await expect(probe).resolves.toMatchObject({ success: true })
      if (source === 'changed') {
        await expect(generation).rejects.toThrow('GENERATION_SOURCE_CHANGED')
        expect(fetch).toHaveBeenCalledTimes(5)
        expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
      } else {
        await expect(generation).resolves.toMatchObject({ outcome: { status: 'completed' } })
        expect(fetch).toHaveBeenCalledTimes(6)
        expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(1)
      }
      expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
    } finally {
      releaseProbe(); scheduler.close()
      if (probe) await probe.catch(() => {})
      if (generation) await generation.catch(() => {})
      registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
        loadModel: () => model, applyProxyConfig: () => {} })
    }
  }, 30_000)

  it('uses one embedding admission per physical query with global capacity one', async () => {
    const scheduler = new MainGenerationScheduler({ global: 1, provider: 1, credential: 1, model: 1, project: 1,
      maxQueued: 8, maxQuarantined: 2, interactiveBurst: 1 }, 16)
    const admission = vi.spyOn(scheduler, 'acquireEmbedding')
    registerGenerationController({ scheduler, modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
      loadModel: () => model, applyProxyConfig: () => {} })
    const releases: Array<() => void> = []
    let draining = false
    const fetch = vi.fn(async () => {
      await new Promise<void>(resolve => { releases.push(resolve); if (draining) resolve() })
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    let pending: Promise<ImportQueryMaterialsResponse> | undefined
    try {
      const request = await setup(2)
      pending = invoke<ImportQueryMaterialsResponse>('import-generation:v1:query-materials', request)
      void pending.catch(() => {})
      for (let index = 0; index < 4; index++) {
        await vi.waitFor(() => expect(releases).toHaveLength(index + 1), { timeout: 4000 })
        expect(scheduler.getStats().occupied).toBe(1)
        expect(fetch).toHaveBeenCalledTimes(index + 1)
        releases[index]()
      }
      const result = await pending
      expect(result.topics.map(topic => topic.key)).toEqual(['worldview', 'protagonist', 'conflict', 'style'])
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(admission).toHaveBeenCalledTimes(4)
      expect(getProjectDb()!.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL AND physical_closed_at_ms IS NOT NULL').pluck().get()).toBe(4)
      expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
    } finally {
      draining = true; releases.forEach(release => release())
      scheduler.close()
      if (pending) await pending.catch(() => {})
      registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
        loadModel: () => model, applyProxyConfig: () => {} })
    }
  }, 30_000)

  it('preserves nonempty ordered materials and replay while bounded physical requests overlap', async () => {
    const samples: Array<{ serialMs: number; overlapMs: number; serialPeak: number; overlapPeak: number;
      serialCompletion: number[]; overlapCompletion: number[] }> = []
    for (let i = 0; i < 3; i++) {
      const serial = await measure(1)
      await cleanup()
      const overlap = await measure(2)
      expect(serial.peak).toBe(1); expect(serial.completion).toEqual([0, 1, 2, 3])
      expect(overlap.peak).toBe(2); expect(overlap.completion).toEqual([1, 0, 3, 2])
      expect(overlap.topics).toEqual(serial.topics)
      samples.push({ serialMs: serial.elapsedMs, overlapMs: overlap.elapsedMs, serialPeak: serial.peak,
        overlapPeak: overlap.peak, serialCompletion: serial.completion, overlapCompletion: overlap.completion })
      await cleanup()
    }
    const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
    const serial = samples.map(sample => sample.serialMs), overlap = samples.map(sample => sample.overlapMs)
    console.info('[stage63-controlled-overlap]', JSON.stringify({ samples: samples.length, requestsPerRun: 4,
      failures: 0, http429: 0, raw: samples, serial: { p50Ms: percentile(serial, 0.5), p95Ms: percentile(serial, 0.95) },
      overlap: { p50Ms: percentile(overlap, 0.5), p95Ms: percentile(overlap, 0.95) } }))
  }, 90_000)

  it('keeps both physical holds after cancellation and never starts another topic', async () => {
    const request = await setup(2)
    const releases: Array<() => void> = []
    let draining = false
    const fetch = vi.fn(async () => {
      await new Promise<void>(resolve => { releases.push(resolve); if (draining) resolve() })
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const pending = invoke('import-generation:v1:query-materials', request).then(() => 'unexpected-success', error => (error as Error).message)
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(2), { timeout: 4000 })
      await invoke('generation:cancel', request.handle)
      const db = getProjectDb()!
      expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL AND physical_closed_at_ms IS NULL').pluck().get()).toBe(2)
      expect(db.prepare('SELECT active_since_ms FROM generation_roots WHERE root_action_id=?').pluck().get(request.handle.rootActionId)).not.toBeNull()
      releases[0]()
      await vi.waitFor(() => expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL AND physical_closed_at_ms IS NULL').pluck().get()).toBe(1))
      expect(db.prepare('SELECT active_since_ms FROM generation_roots WHERE root_action_id=?').pluck().get(request.handle.rootActionId)).not.toBeNull()
      expect(fetch).toHaveBeenCalledTimes(2)
      releases[1]()
      expect(await pending).toBe('GENERATION_ACTION_CANCELLED')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL').pluck().get()).toBe(2)
      expect(db.prepare('SELECT active_since_ms FROM generation_roots WHERE root_action_id=?').pluck().get(request.handle.rootActionId)).toBeNull()
    } finally { draining = true; releases.forEach(release => release()); await pending }
  }, 20_000)

  it.each([0, 1])('drains the sibling after topic %i becomes transport unknown without refilling or resending', async failedIndex => {
    const request = await setup(2)
    const releases: Array<() => void> = []
    const signals: Array<AbortSignal | null | undefined> = []
    let draining = false
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const index = releases.length
      signals.push(init?.signal)
      await new Promise<void>(resolve => { releases.push(resolve); if (draining) resolve() })
      if (index === failedIndex) throw new Error('fictional transport failure')
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const pending = invoke('import-generation:v1:query-materials', request).then(() => 'unexpected-success', error => (error as Error).message)
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(2), { timeout: 4000 })
      releases[failedIndex]()
      const db = getProjectDb()!
      await vi.waitFor(() => expect(db.prepare("SELECT count(*) FROM import_query_topics WHERE state='unknown'").pluck().get()).toBe(1))
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL AND physical_closed_at_ms IS NULL').pluck().get()).toBe(1)
      expect(signals[1 - failedIndex]?.aborted).toBe(false)
      releases[1 - failedIndex]()
      expect(await pending).toBe('GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN')
      await expect(invoke('import-generation:v1:query-materials', request)).rejects.toThrow('GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL').pluck().get()).toBe(2)
      expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL AND physical_closed_at_ms IS NULL').pluck().get()).toBe(0)
    } finally { draining = true; releases.forEach(release => release()); await pending }
  }, 20_000)

  it('shares the original root with generation reservations created while a query is physically active', async () => {
    const request = await setup(2), db = getProjectDb()!
    const originalPolicy = db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(request.handle.rootActionId) as string
    const repository = new GenerationRunRepository(() => db)
    const budget = repository.budget(request.handle.rootActionId)
    expect(repository.get(request.handle.runId).status).toBe('running')
    const releases: Array<() => void> = []
    let draining = false, seeded = false
    const fetch = vi.fn(async () => {
      if (!seeded) {
        seeded = true
        expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL').pluck().get()).toBe(1)
        // Synthetic reservations occupy the ledger only; they are not provider calls.
        for (let i = 0; i < budget.policy.maxPhysicalRequests - 1; i++) {
          repository.reserve(request.handle.runId, `fixture-reservation-${i}`, hash(`fixture-request-${i}`), 1, 1)
        }
        expect(repository.budget(request.handle.rootActionId).attempts).toHaveLength(budget.policy.maxPhysicalRequests - 1)
        expect(repository.budget(request.handle.rootActionId).attempts.every(attempt => attempt.status === 'reserved')).toBe(true)
        expect(db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(request.handle.rootActionId)).toBe(originalPolicy)
      }
      await new Promise<void>(resolve => { releases.push(resolve); if (draining) resolve() })
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    let earlyResult: string | undefined
    const pending = invoke('import-generation:v1:query-materials', request)
      .then(() => 'unexpected-success', error => (error as Error).message)
      .then(result => { earlyResult = result; return result })
    try {
      await vi.waitFor(() => {
        if (earlyResult !== undefined) throw new Error(`QUERY_BEFORE_FETCH:${earlyResult}`)
        expect(releases).toHaveLength(1)
      }, { timeout: 4000 })
      expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL').pluck().get()).toBe(1)
      releases[0]()
      expect(await pending).toBe('ROOT_BUDGET_EXHAUSTED')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL').pluck().get()).toBe(1)
      expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL AND physical_closed_at_ms IS NULL').pluck().get()).toBe(0)
      expect(repository.budget(request.handle.rootActionId).attempts).toHaveLength(budget.policy.maxPhysicalRequests - 1)
      expect(db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(request.handle.rootActionId)).toBe(originalPolicy)
    } finally { draining = true; releases.forEach(release => release()); await pending }
  }, 20_000)
})

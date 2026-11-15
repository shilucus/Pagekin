import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { ImportRunExecutionAuthority, ImportRunExecutionLease, ImportRunSnapshot } from '../../../src/shared/import-run'
import { isReferenceGlobalProgress } from '../../../src/shared/reference-global-contract'
import { isReferenceKnowledgeProgress, type ReferenceKnowledgeReference } from '../../../src/shared/reference-knowledge-contract'
import { isReferenceRefreshProgress } from '../../../src/shared/reference-refresh-contract'
import { isReferenceRunProgress, type ReferenceRunProgress, type ReferenceRunRequest, type ReferenceRunStage } from '../../../src/shared/reference-run-contract'
import { isReferenceStyleProgress } from '../../../src/shared/reference-style-contract'
import { isReferenceBlueprintProgress } from '../../../src/shared/reference-blueprint-contract'
import { registerGenerationController } from '../generation-controller'
import { registerReferenceKnowledgeController } from '../reference-knowledge-controller'
import { registerKBController } from '../kb-controller'
import { registerDatabaseController } from '../db-controller'
import { closeProjectDatabase, getCurrentProjectPath, getProjectDb } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { MainGenerationScheduler } from '../../services/generation-scheduler'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import * as vectorStore from '../../vector-store'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
// @ts-expect-error Existing JavaScript cleanup helper has no declaration.
import { removeTemporaryTree } from '../../../test/helpers/remove-temporary-tree.mjs'

type Handler = (event: { sender: Sender }, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '', currentPlanningModelId: 'fictional-planning' }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', isPackaged: false }, dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../utils/config-utils', () => ({ GLOBAL_CONFIG_PATH: 'fictional-global.json', MODELS_CONFIG_PATH: 'fictional-models.json',
  DEFAULT_GLOBAL_CONFIG: { defaultModelId: null, defaultEmbeddingModelId: null },
  readJsonFile: (file: string) => file === 'fictional-global.json'
    ? { defaultModelId: mocks.currentPlanningModelId, defaultEmbeddingModelId: 'fictional-embedding' }
    : [
      { id: 'fictional-planning', name: 'Fictional planning', provider: 'openai', protocol: 'openai',
        modelName: 'fictional-planning', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fixture-only', temperature: 0.2,
        maxTokens: 8192, purposes: ['generation'], capabilities: { contextWindowTokens: 32768,
          maxOutputTokens: 8192, reasoning: false, structuredOutput: true, usage: true } },
      { id: 'fictional-planning-b', name: 'Fictional planning B', provider: 'openai', protocol: 'openai',
        modelName: 'fictional-planning-b', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fixture-only', temperature: 0.2,
        maxTokens: 8192, purposes: ['generation'], capabilities: { contextWindowTokens: 32768,
          maxOutputTokens: 8192, reasoning: false, structuredOutput: true, usage: true } },
      { id: 'fictional-embedding', provider: 'openai', protocol: 'openai',
        modelName: 'fictional-embedding', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fixture-only',
        purposes: ['embedding'], embeddingOptions: { chunkSize: 500, chunkOverlap: 0, batchSize: 8 } },
    ] }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))

const RUN = 'fictional-reference-whole-run'
const MODEL_ID = 'fictional-planning'
const MODEL_B_ID = 'fictional-planning-b'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const normal = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const planningModel: ModelProfile = { id: MODEL_ID, name: 'Fictional planning', provider: 'openai', protocol: 'openai',
  modelName: MODEL_ID, baseUrl: 'https://fictional.invalid/v1', apiKey: 'fixture-only', temperature: 0.2,
  maxTokens: 8192, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 8192,
    reasoning: false, structuredOutput: true, usage: true } }
const scheduler = new MainGenerationScheduler({ global: 2, provider: 2, credential: 2, model: 2, project: 2,
  maxQueued: 16, maxQuarantined: 2, interactiveBurst: 1 }, 60)

class Sender extends EventEmitter {
  readonly id = 88
  destroyed = false
  events: Array<{ channel: string; payload: unknown }> = []
  acknowledgements: Promise<void>[] = []
  ackErrors: unknown[] = []
  holdMainStage: ReferenceRunStage | null = null
  heldMainStage: ReferenceRunProgress | null = null
  isDestroyed() { return this.destroyed }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed') } }
  send(channel: string, payload: unknown) {
    this.events.push({ channel, payload })
    if (channel === 'reference-run:v1:progress') {
      if (!isReferenceRunProgress(payload)) throw new Error('INVALID_REFERENCE_RUN_PROGRESS')
      const projectedStage = payload.kind === 'stage-completed' ? payload.completion.stage : payload.stage
      if ((payload.kind === 'stage-completed' || payload.kind === 'stage-skipped') && projectedStage === this.holdMainStage) {
        this.heldMainStage = payload
        return
      }
      if (payload.kind === 'stage-skipped') {
        this.scheduleAck('reference-run:v1:projection-ack', { reference: payload.reference,
          execution: payload.execution, stage: payload.stage, token: payload.token, decision: 'settled' }, { ...session })
        return
      }
      if (payload.kind === 'stage-completed') {
        this.scheduleAck('reference-run:v1:projection-ack', { reference: payload.reference,
          execution: payload.execution, stage: payload.completion.stage, token: payload.token, decision: 'settled' }, { ...session })
      }
      return
    }
    if (channel === 'import-generation:v1:global-progress') {
      if (!isReferenceGlobalProgress(payload)) throw new Error('INVALID_REFERENCE_GLOBAL_PROGRESS')
      if (payload.kind === 'opened') this.scheduleAck('import-generation:v1:global-ack', {
        runId: payload.runId, execution: payload.execution, token: payload.token, decision: 'accept' }, { ...session })
      return
    }
    if (channel === 'import-generation:v1:style-progress') {
      if (!isReferenceStyleProgress(payload)) throw new Error('INVALID_REFERENCE_STYLE_PROGRESS')
      if (payload.kind === 'opened' || payload.kind === 'commit-ready') this.scheduleAck('import-generation:v1:style-ack', {
        runId: payload.runId, execution: payload.execution, token: payload.token,
        phase: payload.kind === 'opened' ? 'opened' : 'commit', decision: 'accept' }, { ...session })
      return
    }
    if (channel === 'import-generation:v1:blueprints-progress') {
      if (!isReferenceBlueprintProgress(payload)) throw new Error('INVALID_REFERENCE_BLUEPRINT_PROGRESS')
      if (payload.kind === 'opened') this.scheduleAck('import-generation:v1:blueprints-ack', {
        runId: payload.runId, execution: payload.execution, batchId: payload.batchId, token: payload.token, decision: 'accept' }, { ...session })
      return
    }
    if (channel === 'reference-knowledge:v1:progress' && !isReferenceKnowledgeProgress(payload)) {
      throw new Error('INVALID_REFERENCE_KNOWLEDGE_PROGRESS')
    }
    if (channel === 'reference-knowledge:v1:refresh-progress') {
      if (!isReferenceRefreshProgress(payload)) throw new Error('INVALID_REFERENCE_REFRESH_PROGRESS')
      if (payload.kind === 'refresh') this.scheduleAck('reference-knowledge:v1:refresh-ack', {
        reference: payload.reference, execution: payload.execution, token: payload.token, decision: 'completed' }, { ...session })
    }
  }
  private scheduleAck(channel: string, payload: unknown, context: ProjectSessionContext) {
    const task = Promise.resolve().then(() => dispatch(channel, payload, context)).then(result => {
      if (result && typeof result === 'object' && 'success' in result && result.success === false) this.ackErrors.push(result)
    }, error => { this.ackErrors.push(error) })
    this.acknowledgements.push(task)
  }
}

let base = '', parent = '', root = '', session: ProjectSessionContext, sender: Sender
let database: NonNullable<ReturnType<typeof getProjectDb>>
let generation: ReturnType<typeof registerGenerationController>
let pending: Promise<unknown> | undefined
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>> | undefined

function verifiedCleanupRoot(): string {
  const target = path.resolve(parent)
  if (normal(path.dirname(target)) !== normal(base) || !path.basename(target).startsWith('pk-ref-whole-run-')) {
    throw new Error('FIXTURE_CLEANUP_OUTSIDE_BASE')
  }
  for (const directory of [base, target]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normal(fs.realpathSync.native(directory)) !== normal(directory)) {
      throw new Error('FIXTURE_CLEANUP_LINK')
    }
  }
  const pendingDirectories = [target]
  while (pendingDirectories.length) {
    const directory = pendingDirectories.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      const stat = fs.lstatSync(child)
      if (stat.isSymbolicLink() || normal(fs.realpathSync.native(child)) !== normal(child)) throw new Error('FIXTURE_CLEANUP_LINK')
      if (entry.isDirectory()) pendingDirectories.push(child)
    }
  }
  return target
}

beforeAll(() => {
  const otherPlanningModel: ModelProfile = { ...planningModel, id: MODEL_B_ID, name: 'Fictional planning B', modelName: MODEL_B_ID }
  const loadModel = (id: string) => id === planningModel.id ? planningModel : id === otherPlanningModel.id ? otherPlanningModel : null
  generation = registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel }),
    loadModel, applyProxyConfig: () => {}, scheduler })
  registerReferenceKnowledgeController(scheduler, generation)
  registerKBController()
  registerDatabaseController()
})

beforeEach(async () => {
  sender = new Sender()
  pending = undefined
  fetchMock = undefined
  mocks.currentPlanningModelId = MODEL_ID
  base = fs.realpathSync.native(os.tmpdir())
  parent = fs.mkdtempSync(path.join(base, 'pk-ref-whole-run-'))
  mocks.globalRoot = path.join(parent, 'global')
  fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(parent, 'Fictional reference run')
  const lease = projectAccess.beginSession(project)
  root = lease.rootPath
  session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: root }
  openCanonicalProjectFixture(root, Buffer.alloc(32, 47))
  database = getProjectDb()!
  database.prepare("INSERT OR IGNORE INTO project_core(id,project_name,words_per_chapter) VALUES('main','Fictional reference run',100)").run()
  database.prepare("UPDATE project_core SET project_name='Fictional reference run',words_per_chapter=100 WHERE id='main'").run()
})

afterEach(async () => {
  try {
    sender?.destroy()
    if (pending) await pending.catch(() => undefined)
    if (sender) await Promise.all(sender.acknowledgements)
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session?.projectId
      && normal(item.canonicalRoot) === normal(root))
    if (runtime) await projectRuntimeHost.requestClose(runtime)
    if (root) vectorStore.closeConnection(root)
    if (getCurrentProjectPath() && normal(getCurrentProjectPath()!) === normal(root)) closeProjectDatabase()
    if (database?.open) throw new Error('FIXTURE_DATABASE_STILL_OPEN')
    const current = projectAccess.captureCurrentSession()
    if (current?.projectId === session?.projectId && current.leaseId === session.leaseId) projectAccess.invalidateCurrentSession()
  } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (parent && !database?.open) removeTemporaryTree(verifiedCleanupRoot(), base)
    parent = ''; root = ''; mocks.globalRoot = ''
    mocks.currentPlanningModelId = MODEL_ID
  }
})

function dispatch<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender }, ...args) as Promise<T>
}

function makeInference() {
  const card = (name: string, role: 'protagonist' | 'supporting' | 'antagonist') => ({ name, role, gender: 'unknown', age: '18',
    appearance: 'plain', personality: 'careful', background: 'a harbor resident', abilities: 'observation',
    motivation: 'find the sender', relationships: [], arc: 'growth', notes: 'fictional',
    currentState: { location: 'harbor', powerLevel: 'ordinary', physicalState: 'healthy', mentalState: 'alert',
      keyItems: 'sealed letter', recentEvents: 'arrival', updatedAtChapter: 1 } })
  return { novelConfig: { genre: 'fiction', subGenre: 'adventure', targetAudience: 'general', plotStructure: 'three_act',
    narrativePOV: 'third_limited', coreOutline: 'Find the sender', worldSetting: 'A harbor', goldenFinger: 'A letter',
    protagonistProfile: 'A courier', globalGuidance: 'Follow the letter' },
    architectureFiles: { premise: 'A letter arrives', worldbuilding: 'A harbor', synopsis: 'Find the sender' },
    characterCards: [card('Courier', 'protagonist'), card('Sailor', 'supporting'), card('Keeper', 'antagonist')] }
}

function modelOutputs() {
  return [JSON.stringify(makeInference()), 'Fictional voice: concise sentences and restrained dialogue.',
    JSON.stringify({ blueprints: [{ chapterNumber: 1, title: 'The sealed letter', role: 'setup', purpose: 'Find its sender',
      keyEvents: 'The courier receives a sealed letter.', characters: ['Courier'],
      newCharacterCandidates: [{ name: 'Courier', role: 'protagonist' }], relationships: [], suspenseHook: 'Who sent it?' }] })]
}

function completion(text: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function installProvider(outputs = modelOutputs()) {
  let index = 0
  fetchMock = vi.fn<typeof globalThis.fetch>(async input => {
    if (String(input).includes('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })
    const output = outputs[index++]
    if (output === undefined) throw new Error('FICTIONAL_UNEXPECTED_MODEL_REQUEST')
    return completion(output)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function prepare(runId = RUN): Promise<{ reference: ReferenceKnowledgeReference; execution: ImportRunExecutionLease }> {
  const content = 'A fictional courier receives a sealed letter at the harbor and decides to find its sender.'
  ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash(`source:${runId}`), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional-reference.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'The sealed letter', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }] })
  return dispatch('reference-knowledge:v1:prepare', { operationId: randomUUID(), runId, executionOwner: randomUUID() }, { ...session })
}

function executionOf(issued: { execution: ImportRunExecutionLease }): ImportRunExecutionAuthority {
  return { owner: issued.execution.owner, epoch: issued.execution.epoch }
}

function runRequest(issued: { reference: ReferenceKnowledgeReference; execution: ImportRunExecutionLease }, modelId: string | null = MODEL_ID): ReferenceRunRequest {
  return { reference: issued.reference, execution: executionOf(issued), modelId }
}

function execute(request: ReferenceRunRequest): Promise<{
  success: boolean; run?: ImportRunSnapshot; execution?: null; replayed?: boolean; errorCode?: string
}> {
  const operation = dispatch<{
    success: boolean; run?: ImportRunSnapshot; execution?: null; replayed?: boolean; errorCode?: string
  }>('reference-run:v1:execute', request, { ...session })
  pending = operation
  void operation.catch(() => undefined)
  return operation
}

function wholeProgress() {
  return sender.events.flatMap(event => event.channel === 'reference-run:v1:progress'
    ? [event.payload as ReferenceRunProgress] : [])
}

async function waitForStageCompleted(stage: ReferenceRunStage): Promise<Extract<ReferenceRunProgress, { kind: 'stage-completed' }>> {
  await vi.waitFor(() => expect(sender.heldMainStage?.kind === 'stage-completed'
    ? sender.heldMainStage.completion.stage === stage : wholeProgress().some(item => item.kind === 'stage-completed'
      && item.completion.stage === stage)).toBe(true), { timeout: 30_000 })
  const held = sender.heldMainStage
  if (held?.kind === 'stage-completed' && held.completion.stage === stage) return held
  return wholeProgress().find((item): item is Extract<ReferenceRunProgress, { kind: 'stage-completed' }> =>
    item.kind === 'stage-completed' && item.completion.stage === stage)!
}

async function waitForStageSkipped(stage: ReferenceRunStage): Promise<Extract<ReferenceRunProgress, { kind: 'stage-skipped' }>> {
  await vi.waitFor(() => expect(sender.heldMainStage?.kind === 'stage-skipped'
    ? sender.heldMainStage.stage === stage : wholeProgress().some(item => item.kind === 'stage-skipped' && item.stage === stage)).toBe(true),
  { timeout: 30_000 })
  const held = sender.heldMainStage
  if (held?.kind === 'stage-skipped' && held.stage === stage) return held
  return wholeProgress().find((item): item is Extract<ReferenceRunProgress, { kind: 'stage-skipped' }> =>
    item.kind === 'stage-skipped' && item.stage === stage)!
}

function acknowledgeMain(event: Extract<ReferenceRunProgress, { kind: 'stage-completed' | 'stage-skipped' }>,
  decision: 'settled' | 'cancelled' | 'projection-failed' = 'settled') {
  return dispatch('reference-run:v1:projection-ack', { reference: event.reference, execution: event.execution,
    stage: event.kind === 'stage-completed' ? event.completion.stage : event.stage, token: event.token, decision }, { ...session })
}

async function settleAcks() { await Promise.all(sender.acknowledgements) }

describe('registered whole reference-run foreground on isolated native storage', () => {
  it.each(['grant', 'revision', 'owner', 'epoch', 'sender', 'expired-lease'] as const)(
    'rejects an invalid %s before admitting or recovering a generation owner', async invalid => {
      const issued = await prepare()
      const request: ReferenceRunRequest = { ...runRequest(issued), reference: { ...issued.reference }, execution: executionOf(issued) }
      if (invalid === 'grant') request.reference.grantId = randomUUID()
      if (invalid === 'revision') request.reference.revision++
      if (invalid === 'owner') request.execution.owner = randomUUID()
      if (invalid === 'epoch') request.execution.epoch++
      if (invalid === 'expired-lease') database.prepare('UPDATE import_runs SET lease_expires_at=0 WHERE id=?').run(RUN)
      const caller = invalid === 'sender' ? new Sender() : sender
      const admit = vi.spyOn(generation, 'prepareReferenceRun')
      const before = database.prepare('SELECT * FROM generation_runs ORDER BY run_id').all()
      try {
        const result = await mocks.handlers.get('reference-run:v1:execute')!({ sender: caller }, request, { ...session })
        expect(result).toMatchObject({ success: false })
        expect(admit).not.toHaveBeenCalled()
        expect(database.prepare('SELECT * FROM generation_runs ORDER BY run_id').all()).toEqual(before)
      } finally {
        if (invalid === 'expired-lease') {
          database.prepare('UPDATE import_runs SET lease_expires_at=? WHERE id=?').run(issued.execution.expiresAt, RUN)
        }
        if (caller !== sender) caller.destroy()
      }
    }, 30_000)

  it('executes and acknowledges all five existing stage owners with committed receipts', async () => {
    const fetch = installProvider()
    const issued = await prepare()

    const result = await execute(runRequest(issued))
    await settleAcks()

    expect(result.success, `reference-run errorCode: ${result.errorCode ?? 'none'}`).toBe(true)
    expect(result).toMatchObject({ success: true, run: { id: RUN, purpose: 'reference', status: 'completed', stage: 'completed' }, execution: null })
    expect(wholeProgress().filter(item => item.kind === 'stage-completed').map(item => item.kind === 'stage-completed' && item.completion.stage))
      .toEqual(['knowledge', 'global', 'style', 'blueprints', 'refresh'])
    expect(ImportRunRepository.get(RUN)?.completedBatches.refresh).toContain('done')
    expect(database.prepare('SELECT chapter_number,state FROM import_run_knowledge_receipts WHERE run_id=?').all(RUN))
      .toEqual([{ chapter_number: 1, state: 'committed' }])
    expect(ImportRunRepository.getEffectReceipt(RUN, 'global', 'done')?.state).toBe('committed')
    expect(ImportRunRepository.getEffectReceipt(RUN, 'style', 'done')?.state).toBe('committed')
    expect(database.prepare("SELECT state FROM import_effect_ledger WHERE run_id=? AND stage='blueprints'").all(RUN))
      .toEqual([{ state: 'complete' }])
    expect(database.prepare('SELECT state FROM reference_import_grants WHERE grant_id=?').pluck().get(issued.reference.grantId)).toBe('completed')
    const opened = sender.events.flatMap(event => event.channel === 'import-generation:v1:global-progress'
      || event.channel === 'import-generation:v1:style-progress' || event.channel === 'import-generation:v1:blueprints-progress'
      ? [event.payload as { kind?: string; modelId?: string }] : []).filter(event => event.kind === 'opened')
    expect(opened.map(event => event.modelId)).toEqual([MODEL_ID, MODEL_ID, MODEL_ID])
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(3)
    expect(sender.ackErrors).toEqual([])
  }, 120_000)

  it('joins the same run while a stage projection is pending and fences sibling writers', async () => {
    const fetch = installProvider()
    const issued = await prepare()
    const request = runRequest(issued)
    sender.holdMainStage = 'knowledge'
    const first = execute(request)
    const gate = await waitForStageCompleted('knowledge')
    expect(gate.completion.result.run).toMatchObject({ stage: 'global', status: 'running' })
    mocks.currentPlanningModelId = MODEL_B_ID

    const joined = execute(request)
    await expect(dispatch('reference-knowledge:v1:prepare',
      { operationId: randomUUID(), runId: RUN, executionOwner: randomUUID() }, { ...session }))
      .rejects.toThrow()
    await expect(dispatch('reference-knowledge:v1:resume', issued.reference, { ...session }))
      .rejects.toThrow()
    expect(await dispatch<{ success: boolean; errorCode?: string }>('db:import-run-advance-stage', RUN,
      'knowledge', 'global', issued.execution, root, { ...session }))
      .toMatchObject({ success: false, errorCode: 'GENERATION_OWNER_BUSY' })
    expect(await execute({ ...request, modelId: 'different-fixture-model' }))
      .toMatchObject({ success: false, errorCode: 'GENERATION_OWNER_BUSY' })

    sender.holdMainStage = null
    await acknowledgeMain(gate)
    expect(await first).toMatchObject({ success: true, run: { stage: 'completed' } })
    expect(await joined).toMatchObject({ success: true, run: { stage: 'completed' } })
    await settleAcks()
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(3)
    const opened = sender.events.flatMap(event => event.channel === 'import-generation:v1:global-progress'
      || event.channel === 'import-generation:v1:style-progress' || event.channel === 'import-generation:v1:blueprints-progress'
      ? [event.payload as { kind?: string; modelId?: string }] : []).filter(event => event.kind === 'opened')
    expect(opened.map(event => event.modelId)).toEqual([MODEL_ID, MODEL_ID, MODEL_ID])
    expect(sender.ackErrors).toEqual([])
  }, 120_000)

  it('waits for completed-history skipped-stage ACKs before replaying refresh', async () => {
    const fetch = installProvider()
    const issued = await prepare()
    expect(await execute(runRequest(issued))).toMatchObject({ success: true, run: { status: 'completed' } })
    await settleAcks()
    const completedRun = ImportRunRepository.get(RUN)
    const effectsBeforeReplay = database.prepare('SELECT stage,batch_id,state,evidence_kind,diagnostic_code FROM import_effect_ledger WHERE run_id=? ORDER BY stage,batch_id').all(RUN)
    const grantBeforeReplay = database.prepare('SELECT state FROM reference_import_grants WHERE grant_id=?').pluck().get(issued.reference.grantId)

    const replayEventOffset = sender.events.length
    const replayProgressOffset = wholeProgress().length
    sender.holdMainStage = 'knowledge'
    const replay = execute(runRequest(issued))
    const skipped = await waitForStageSkipped('knowledge')
    const joined = execute(runRequest(issued))
    expect(wholeProgress().slice(replayProgressOffset).some(item => item.kind === 'stage-started' && item.stage === 'refresh')).toBe(false)
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(3)

    sender.holdMainStage = null
    await acknowledgeMain(skipped)
    expect(await replay).toMatchObject({ success: true, run: { status: 'completed' } })
    expect(await joined).toMatchObject({ success: true, run: { status: 'completed' } })
    await settleAcks()
    expect(wholeProgress().slice(replayProgressOffset).some(item => item.kind === 'stage-started' && item.stage === 'refresh')).toBe(true)
    expect(wholeProgress().slice(replayProgressOffset).some(item => item.kind === 'stage-completed' && item.completion.stage === 'refresh')).toBe(true)
    expect(sender.events.slice(replayEventOffset).some(event => event.channel === 'reference-knowledge:v1:refresh-progress')).toBe(false)
    expect(ImportRunRepository.get(RUN)).toEqual(completedRun)
    expect(database.prepare('SELECT stage,batch_id,state,evidence_kind,diagnostic_code FROM import_effect_ledger WHERE run_id=? ORDER BY stage,batch_id').all(RUN))
      .toEqual(effectsBeforeReplay)
    expect(database.prepare('SELECT state FROM reference_import_grants WHERE grant_id=?').pluck().get(issued.reference.grantId))
      .toBe(grantBeforeReplay)
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(3)
    expect(sender.ackErrors).toEqual([])
  }, 120_000)

  it('does not guess a planning default for a fresh null-model request', async () => {
    const fetch = installProvider()
    const issued = await prepare()

    expect(await execute(runRequest(issued, null))).toMatchObject({ success: false, errorCode: 'GENERATION_MODEL_REQUIRED' })
    await settleAcks()
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(0)
    expect(sender.events.flatMap(event => event.channel === 'import-generation:v1:global-progress'
      || event.channel === 'import-generation:v1:style-progress' || event.channel === 'import-generation:v1:blueprints-progress'
      ? [event.payload as { kind?: string }] : []).filter(event => event.kind === 'opened')).toHaveLength(0)
  }, 60_000)

  it('recovers a historical global model when the next whole-run request is null', async () => {
    const fetch = installProvider()
    const issued = await prepare()
    sender.holdMainStage = 'global'
    const first = execute(runRequest(issued))
    const globalGate = await waitForStageCompleted('global')
    expect(ImportRunRepository.get(RUN)).toMatchObject({ status: 'running', stage: 'style' })

    await acknowledgeMain(globalGate, 'projection-failed')
    expect((await first).success).toBe(false)
    expect(ImportRunRepository.get(RUN)).toMatchObject({ status: 'running', stage: 'style' })
    sender.holdMainStage = null
    mocks.currentPlanningModelId = MODEL_B_ID

    const recovered = await execute(runRequest(issued, null))
    await settleAcks()
    expect(recovered).toMatchObject({ success: true, run: { status: 'completed', stage: 'completed' } })
    const opened = sender.events.flatMap(event => event.channel === 'import-generation:v1:global-progress'
      || event.channel === 'import-generation:v1:style-progress' || event.channel === 'import-generation:v1:blueprints-progress'
      ? [event.payload as { kind?: string; modelId?: string }] : []).filter(event => event.kind === 'opened')
    expect(opened.map(event => event.modelId)).toEqual([MODEL_ID, MODEL_ID, MODEL_ID])
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(3)
    expect(sender.ackErrors).toEqual([])
  }, 120_000)

  it('rejects legacy unknown global history before projecting the skipped stage', async () => {
    const fetch = installProvider()
    const issued = await prepare()
    database.prepare("UPDATE import_runs SET stage='style' WHERE id=?").run(RUN)
    const effectNamespace = ImportRunRepository.get(RUN)!.effectNamespace
    database.prepare(`INSERT INTO import_effect_ledger(run_id,stage,batch_id,effect_namespace,effect_key,state,evidence_kind,diagnostic_code)
      VALUES(?,'global','__legacy_fictional',?,'fictional-legacy-global-unknown','unknown','terminal','FICTIONAL_UNKNOWN')`)
      .run(RUN, effectNamespace)

    const response = await execute(runRequest(issued))
    await settleAcks()

    expect(response).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_EFFECT_HISTORY_UNKNOWN' })
    expect(wholeProgress().filter(item => item.kind === 'stage-skipped').map(item => item.kind === 'stage-skipped' && item.stage))
      .toEqual(['knowledge'])
    expect(wholeProgress().some(item => item.kind === 'stage-started' && item.stage === 'global')).toBe(false)
    expect(ImportRunRepository.get(RUN)).toMatchObject({ status: 'running', stage: 'style' })
    expect(fetch).not.toHaveBeenCalled()
  }, 60_000)

  it('rejects corrupt style and unknown blueprint history without replaying refresh or changing completion', async () => {
    const fetch = installProvider()
    const issued = await prepare()
    expect(await execute(runRequest(issued))).toMatchObject({ success: true, run: { status: 'completed', stage: 'completed' } })
    await settleAcks()
    const completedRun = ImportRunRepository.get(RUN)
    const styleReceipt = database.prepare(`SELECT payload_json,payload_hash FROM import_run_receipts
      WHERE run_id=? AND stage='style' AND batch_id='done'`).get(RUN) as { payload_json: string; payload_hash: string }

    database.prepare(`UPDATE import_run_receipts SET payload_json='{}' WHERE run_id=? AND stage='style' AND batch_id='done'`).run(RUN)
    const styleReplayOffset = sender.events.length
    const badStyle = await execute(runRequest(issued))
    await settleAcks()
    expect(badStyle).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_RECEIPT_CORRUPT' })
    expect(wholeProgress().slice(0).some(item => item.kind === 'stage-skipped' && item.stage === 'style')).toBe(false)
    expect(sender.events.slice(styleReplayOffset).some(event => event.channel === 'reference-knowledge:v1:refresh-progress')).toBe(false)
    expect(ImportRunRepository.get(RUN)).toEqual(completedRun)

    database.prepare(`UPDATE import_run_receipts SET payload_json=?,payload_hash=? WHERE run_id=? AND stage='style' AND batch_id='done'`)
      .run(styleReceipt.payload_json, styleReceipt.payload_hash, RUN)
    database.prepare(`INSERT INTO import_effect_ledger(run_id,stage,batch_id,effect_namespace,effect_key,state,evidence_kind,diagnostic_code)
      VALUES(?,'blueprints','fictional-unknown-blueprint',?,'fictional-unknown-blueprint-effect','unknown','terminal','FICTIONAL_UNKNOWN')`)
      .run(RUN, completedRun!.effectNamespace)

    const blueprintReplayOffset = sender.events.length
    const badBlueprints = await execute(runRequest(issued))
    await settleAcks()
    expect(badBlueprints).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_EFFECT_HISTORY_UNKNOWN' })
    expect(wholeProgress().some(item => item.kind === 'stage-skipped' && item.stage === 'blueprints')).toBe(false)
    expect(sender.events.slice(blueprintReplayOffset).some(event => event.channel === 'reference-knowledge:v1:refresh-progress')).toBe(false)
    expect(ImportRunRepository.get(RUN)).toEqual(completedRun)
    expect(database.prepare('SELECT state FROM reference_import_grants WHERE grant_id=?').pluck().get(issued.reference.grantId))
      .toBe('completed')
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(3)
  }, 120_000)

  it('retains a completed run after grant failure and retries only the original issuance grant', async () => {
    const fetch = installProvider()
    const issued = await prepare()
    database.exec(`CREATE TRIGGER fictional_whole_run_grant_failure BEFORE UPDATE OF state ON reference_import_grants
      WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fictional grant failure'); END`)

    const first = await execute(runRequest(issued))
    await settleAcks()
    const completedRun = database.prepare('SELECT status,stage,execution_owner,execution_epoch,lease_expires_at FROM import_runs WHERE id=?').get(RUN)
    expect(first.success).toBe(false)
    expect(completedRun).toMatchObject({ status: 'completed', stage: 'completed', execution_owner: '', lease_expires_at: 0 })
    expect(database.prepare('SELECT state FROM reference_import_grants WHERE grant_id=?').pluck().get(issued.reference.grantId)).toBe('active')

    database.exec('DROP TRIGGER fictional_whole_run_grant_failure')
    const modelRequestsBeforeRetry = fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings')).length
    const retry = await execute(runRequest(issued))
    await settleAcks()

    expect(retry).toMatchObject({ success: true, run: { status: 'completed', stage: 'completed' } })
    expect(database.prepare('SELECT status,stage,execution_owner,execution_epoch,lease_expires_at FROM import_runs WHERE id=?').get(RUN))
      .toEqual(completedRun)
    expect(database.prepare('SELECT state FROM reference_import_grants WHERE grant_id=?').pluck().get(issued.reference.grantId)).toBe('completed')
    expect(wholeProgress().filter(item => item.kind === 'stage-skipped').map(item => item.kind === 'stage-skipped' && item.stage))
      .toEqual(['knowledge', 'global', 'style', 'blueprints'])
    expect(wholeProgress().filter(item => item.kind === 'stage-started').map(item => item.kind === 'stage-started' && item.stage))
      .toEqual(['knowledge', 'global', 'style', 'blueprints', 'refresh', 'refresh'])
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(modelRequestsBeforeRetry)
    expect(sender.ackErrors).toEqual([])
  }, 120_000)

  it.each(['cancelled-ack', 'destroyed-sender'] as const)('stops at the knowledge projection boundary on %s', async outcome => {
    const fetch = installProvider()
    const issued = await prepare()
    sender.holdMainStage = 'knowledge'
    const flight = execute(runRequest(issued))
    const gate = await waitForStageCompleted('knowledge')

    if (outcome === 'cancelled-ack') await acknowledgeMain(gate, 'cancelled')
    else sender.destroy()

    expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_CANCELLED' })
    expect(ImportRunRepository.get(RUN)).toMatchObject({ status: 'cancelled', stage: 'global' })
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(0)
  }, 60_000)

  it('retains the run until a failed cancellation write is retried during close', async () => {
    installProvider()
    const issued = await prepare()
    sender.holdMainStage = 'knowledge'
    const flight = execute(runRequest(issued))
    const gate = await waitForStageCompleted('knowledge')
    let retriedStatus: string | undefined
    const cancel = vi.spyOn(ImportRunRepository, 'cancelAtBoundary')
      .mockImplementationOnce(() => { throw new Error('FICTIONAL_CANCEL_WRITE_FAILED') })

    await acknowledgeMain(gate, 'cancelled')
    expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_CANCELLED' })
    expect(ImportRunRepository.get(RUN)).toMatchObject({ status: 'running', stage: 'global' })
    database.prepare('UPDATE import_runs SET lease_expires_at=0 WHERE id=?').run(RUN)
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId)!
    expect(() => projectRuntimeHost.assertTaskAvailable(runtime)).toThrow('PROJECT_RUNTIME_BUSY')
    const originalExpiredCancel = ImportRunRepository.cancelExpiredReferenceAtBoundary.bind(ImportRunRepository)
    const expiredCancel = vi.spyOn(ImportRunRepository, 'cancelExpiredReferenceAtBoundary').mockImplementation((...args) => {
      originalExpiredCancel(...args)
      retriedStatus = ImportRunRepository.get(RUN)?.status
    })
    await projectRuntimeHost.requestClose(runtime)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(expiredCancel).toHaveBeenCalledTimes(1)
    expect(retriedStatus).toBe('cancelled')
  }, 60_000)

  it('stops at a revoked issuance during the whole-run projection wait', async () => {
    const fetch = installProvider()
    const issued = await prepare()
    sender.holdMainStage = 'knowledge'
    const flight = execute(runRequest(issued))
    await waitForStageCompleted('knowledge')

    await expect(dispatch('reference-knowledge:v1:revoke', issued.reference)).resolves.toMatchObject({ state: 'revoked' })
    expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_CANCELLED' })
    expect(ImportRunRepository.get(RUN)).toMatchObject({ status: 'cancelled', stage: 'global' })
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/embeddings'))).toHaveLength(0)
    expect(sender.ackErrors).toEqual([])
  }, 60_000)
})

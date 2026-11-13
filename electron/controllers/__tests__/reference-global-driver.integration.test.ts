import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import { createImportRunChapterBatchCheckpointId, type ImportRunExecutionAuthority, type ImportRunExecutionLease } from '../../../src/shared/import-run'
import { isReferenceGlobalProgress, type ReferenceGlobalProgress, type ReferenceGlobalResponse } from '../../../src/shared/reference-global-contract'
import { buildImportEndpointCardTask, buildImportInferenceTask, formatImportInferenceSample, getImportInferenceTopics,
  type ImportInferenceTopicKey } from '../../../src/shared/import-inference-materials'
import type { ImportGenerationRecovery } from '../../../src/shared/import-generation'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { injectWritingSkillPrompt } from '../../../src/shared/writing-skill-task'
import { importInferenceJsonContract } from '../../../src/services/workflows/commands/import-inference-contract'
import { buildStructuredSyntaxRepairTask } from '../../../src/services/workflows/structured-syntax-repair'
import { createBoundedCompletionError } from '../../../src/services/workflows/bounded-completion'
import { StructuredContractDiagnostic } from '../../../src/shared/structured-contract-diagnostic'
import { registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { closeProjectDatabase, createProjectDatabase, getCurrentProjectPath, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { MainGenerationScheduler } from '../../services/generation-scheduler'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import { getProjectDataRoot } from '../../services/project-data-locator'
import { addChunks } from '../../vector-store'
import { ImportQueryMaterialsService } from '../../services/import-query-materials'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '', concurrency: 1 }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => ({ modelId: 'fictional-embedding', protocol: 'openai',
  model: { provider: 'openai', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-only', modelName: 'fictional-embedding',
    embeddingOptions: { chunkSize: 500, chunkOverlap: 50, batchSize: 50, concurrencyLimit: mocks.concurrency } } }) }))

const runId = 'fictional-reference-global'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const model: ModelProfile = { id: 'fictional-model', name: 'Fictional', provider: 'openai', protocol: 'openai',
  modelName: 'fictional-model', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-only', temperature: 0.7,
  maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048,
    reasoning: false, structuredOutput: true, usage: true } }
const otherModel: ModelProfile = { ...model, id: 'fictional-other', modelName: 'fictional-other' }
const scheduler = new MainGenerationScheduler({ global: 2, provider: 2, credential: 2, model: 2, project: 2,
  maxQueued: 16, maxQuarantined: 2, interactiveBurst: 1 }, 60)
class Sender extends EventEmitter {
  readonly id = 71
  destroyed = false
  events: ReferenceGlobalProgress[] = []
  isDestroyed() { return this.destroyed }
  send(channel: string, payload: unknown) {
    if (channel === 'import-generation:v1:global-progress') {
      if (!isReferenceGlobalProgress(payload)) throw new Error('INVALID_GLOBAL_PROGRESS')
      this.events.push(payload)
    }
  }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}
let sender: Sender, root: string, session: ProjectSessionContext, execution: ImportRunExecutionAuthority
let executionLease: ImportRunExecutionLease
let pending: Promise<unknown> | undefined, releaseFetch: (() => void) | undefined

beforeAll(() => {
  const loadModel = (id: string) => id === model.id ? model : id === otherModel.id ? otherModel : null
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel }), loadModel,
    applyProxyConfig: () => {}, scheduler })
  registerDatabaseController()
})
beforeEach(() => {
  sender = new Sender(); pending = undefined; releaseFetch = undefined; mocks.concurrency = 1
  const base = path.resolve('.runtime/rg66')
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'f-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, 'Fictional reference')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.prepare("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','Fictional reference',100)").run()
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: projectAccess.beginSession(project).leaseId }
  const chapters = Array.from({ length: 7 }, (_, index) => {
    const number = index + 1, content = `sample-${number}-` + String(number).repeat(3100) + `-end-${number}`
    return { number, title: `Fictional ${number}`, content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }
  })
  ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash('fictional-source'), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: 1 }], chapters })
  executionLease = ImportRunRepository.startOrResume(runId, 'fictional-owner', Date.now(), 60_000).execution
  execution = { owner: executionLease.owner, epoch: executionLease.epoch }
  getProjectDb()!.prepare("UPDATE import_runs SET stage='global' WHERE id=?").run(runId)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('UNEXPECTED_NETWORK') }))
})
function removeFixture() {
  const base = path.resolve('.runtime/rg66'), target = path.resolve(root), relative = path.relative(base, target)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    || normalize(fs.realpathSync.native(base)) !== normalize(base)) throw new Error('FIXTURE_CLEANUP_UNSAFE')
  const directories = [target], files: string[] = []
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!, stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(fs.realpathSync.native(directory)) !== normalize(directory)) throw new Error('FIXTURE_CLEANUP_UNSAFE')
    for (const entry of fs.readdirSync(directory)) {
      const child = path.join(directory, entry), childRelative = path.relative(target, child), childStat = fs.lstatSync(child)
      if (!childRelative || path.isAbsolute(childRelative) || childRelative === '..' || childRelative.startsWith(`..${path.sep}`)
        || childStat.isSymbolicLink() || normalize(fs.realpathSync.native(child)) !== normalize(child)) throw new Error('FIXTURE_CLEANUP_UNSAFE')
      if (childStat.isDirectory()) directories.push(child)
      else if (childStat.isFile()) files.push(child)
      else throw new Error('FIXTURE_CLEANUP_UNSAFE')
    }
  }
  for (const file of files) fs.unlinkSync(file)
  for (const directory of directories.reverse()) fs.rmdirSync(directory)
}
afterEach(async () => {
  sender.destroy(); releaseFetch?.()
  if (pending) await pending.catch(() => undefined)
  const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId
    && normalize(item.canonicalRoot) === normalize(session.projectPath))
  if (runtime) await projectRuntimeHost.requestClose(runtime)
  const currentPath = getCurrentProjectPath()
  if (currentPath && normalize(currentPath) === normalize(session.projectPath)) closeProjectDatabase()
  const currentSession = projectAccess.captureCurrentSession()
  if (currentSession?.projectId === session.projectId && currentSession.leaseId === session.leaseId) projectAccess.invalidateCurrentSession()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  removeFixture()
})
function invoke<T>(channel: string, payload: unknown, context = session, eventSender = sender): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender: eventSender }, payload, { ...context }) as Promise<T>
}
function dbCall<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`MISSING_HANDLER:${channel}`)
  return handler({ sender }, ...args, session.projectPath, { ...session }) as Promise<T>
}
function start(modelId: string | null = model.id) {
  const flight = invoke<ReferenceGlobalResponse>('import-generation:v1:global', { runId, execution, modelId })
  pending = flight; void flight.catch(() => undefined)
  return flight
}
async function opened() {
  const waiting = vi.waitFor(() => expect(sender.events.some(item => item.kind === 'opened')).toBe(true), { timeout: 10_000 })
    .then(() => sender.events.find(item => item.kind === 'opened')! as Extract<ReferenceGlobalProgress, { kind: 'opened' }>)
  if (!pending) throw new Error('GLOBAL_FLIGHT_MISSING')
  const finished = pending.then(result => {
    const code = result && typeof result === 'object' && 'errorCode' in result && typeof result.errorCode === 'string'
      && /^[A-Z][A-Z0-9_]{0,99}$/.test(result.errorCode) ? result.errorCode : 'UNEXPECTED_FINISH'
    throw new Error(`GLOBAL_BEFORE_OPENED:${code}`)
  }, () => { throw new Error('GLOBAL_BEFORE_OPENED:IPC_REJECTED') })
  return Promise.race([waiting, finished])
}
function ack(item: Extract<ReferenceGlobalProgress, { kind: 'opened' }>, decision: 'accept' | 'cancelled' | 'projection-failed' = 'accept', eventSender = sender) {
  return invoke<{ version: 1 }>('import-generation:v1:global-ack', { runId, execution, token: item.token, decision }, session, eventSender)
}
function card(name: string, role: 'protagonist' | 'supporting' = 'supporting') {
  return { name, role, gender: 'unknown', age: '18', appearance: 'plain', personality: 'careful', background: 'harbor',
    abilities: 'observation', motivation: 'find sender', relationships: [] as { target: string; relation: string }[], arc: 'growth', notes: 'fictional',
    currentState: { location: 'harbor', powerLevel: 'ordinary', physicalState: 'healthy', mentalState: 'alert', keyItems: 'letter', recentEvents: 'arrival', updatedAtChapter: 1 } }
}
function inference() {
  return { novelConfig: { genre: 'fiction', subGenre: 'adventure', targetAudience: 'general', plotStructure: 'three_act',
    narrativePOV: 'third_limited', coreOutline: 'Find the sender', worldSetting: 'A harbor', goldenFinger: 'A gift',
    protagonistProfile: 'A courier', globalGuidance: 'Follow the letter' }, architectureFiles: { premise: 'A letter arrives',
    worldbuilding: 'A harbor', synopsis: 'Find the sender' }, characterCards: [card('Courier', 'protagonist'), card('Sailor'), card('Keeper')] }
}
function completion(text: string, finishReason: 'stop' | 'length' = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
function provider(outputs: string[]) {
  let index = 0
  const fetch = vi.fn<typeof globalThis.fetch>(async input => {
    if (String(input).includes('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })
    const text = outputs[index++]
    if (text === undefined) throw new Error('UNEXPECTED_INFERENCE')
    return completion(text)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('registered foreground reference global', () => {
  it.each(['initial', 'syntax-and-endpoint'] as const)('commits only a proposal with original query and attempt provenance: %s', async mode => {
    const initial = inference()
    if (mode === 'syntax-and-endpoint') initial.characterCards[0]!.relationships.push({ target: 'Sender', relation: 'correspondent' })
    const full = JSON.stringify(initial)
    const outputs = mode === 'initial' ? [full] : [full.slice(0, -1), full, JSON.stringify({ characterCards: [card('Sender')] })]
    const skillRoot = getProjectDataRoot(session.projectPath)
    fs.mkdirSync(path.join(skillRoot, 'skills', 'fictional-planning'), { recursive: true })
    fs.writeFileSync(path.join(skillRoot, 'skills', 'fictional-planning', 'SKILL.md'),
      '---\nname: fictional-planning\nlanguage: bilingual\nstage: planning\n---\nRespect the fictional letter.\n')
    fs.writeFileSync(path.join(skillRoot, 'writing-skills.json'), JSON.stringify({ version: 1, bindings: { planning: 'project:fictional-planning' } }))
    const fetch = provider(outputs), db = getProjectDb()!
    const flight = start(), event = await opened()
    expect(event).toMatchObject({ projectId: session.projectId, leaseId: session.leaseId, runId, execution, modelId: model.id })
    expect(fetch).not.toHaveBeenCalled()
    const recovery = await invoke<ImportGenerationRecovery | null>('import-generation:read', {
      slot: { runId, stage: 'global', batchId: 'done' }, runId: event.handle.runId,
    })
    expect(recovery?.view.handle).toEqual(event.handle)
    if (!recovery) throw new Error('FIXTURE_RECOVERY_MISSING')
    expect(await ack(event)).toEqual({ version: 1 })
    const result = await flight
    expect(result).toMatchObject({ success: true, replayed: false, handle: event.handle, run: { stage: 'style', status: 'running' }, receipt: { state: 'committed' } })
    expect(fetch).toHaveBeenCalledTimes(4 + outputs.length)
    expect(sender.events.map(value => value.sequence)).toEqual(sender.events.map((_, index) => index + 1))
    expect(sender.events).toContainEqual(expect.objectContaining({ kind: 'log', value: { key: 'skill', name: 'fictional-planning' } }))
    const plan = db.prepare('SELECT * FROM import_query_plans WHERE import_root_run_id=?').get(runId) as { root_action_id: string; binding_json: string }
    expect(plan.root_action_id).toBe(event.handle.rootActionId)
    const queryBinding = JSON.parse(plan.binding_json) as { slot: { writingLanguage: 'en-US' | 'zh-CN' }; topics: unknown[] }
    expect(queryBinding.topics).toEqual(getImportInferenceTopics(queryBinding.slot.writingLanguage).map(({ key, query, topK }) => ({ key, query, topK })))
    expect(db.prepare('SELECT topic_key,state FROM import_query_topics WHERE import_root_run_id=? ORDER BY rowid').all(runId))
      .toEqual(['worldview', 'protagonist', 'conflict', 'style'].map(topic_key => ({ topic_key, state: 'completed' })))
    const attempts = db.prepare('SELECT invocation_nonce,root_action_id,usage_receipt_json FROM generation_attempts ORDER BY rowid').all() as {
      invocation_nonce: string; root_action_id: string; usage_receipt_json: string
    }[]
    expect(attempts.map(item => item.invocation_nonce)).toEqual(outputs.map((_, index) => `import:${index}`))
    expect(attempts.every(item => item.root_action_id === event.handle.rootActionId)).toBe(true)
    const binding = JSON.parse(db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(event.handle.runId) as string) as {
      fingerprint: { modelLeaseRevision: string; policyHash: string }
    }
    const stored = attempts.map(item => JSON.parse(item.usage_receipt_json) as { replayTask: GenerationTask; requestHash: string })
    expect(stored.map(item => item.replayTask.purpose)).toEqual(mode === 'initial' ? ['import-inference']
      : ['import-inference', 'import-inference:structured-syntax-repair', 'import-inference:endpoint-card-recovery'])
    for (const item of stored) expect(item.requestHash).toBe(hash(JSON.stringify([item.replayTask, binding.fingerprint.modelLeaseRevision, binding.fingerprint.policyHash])))
    const rows = db.prepare('SELECT topic_key,receipt_json FROM import_query_topics WHERE import_root_run_id=? ORDER BY rowid').all(runId) as {
      topic_key: ImportInferenceTopicKey; receipt_json: string
    }[]
    const sampledContent = Object.fromEntries(rows.map(row => {
      const receipt = JSON.parse(row.receipt_json) as { state: 'available'; snapshot: { results: { text: string; score: number; fileName: string }[] } } | { state: 'unavailable' }
      return [row.topic_key, formatImportInferenceSample(receipt.state === 'available' ? receipt.snapshot.results : 'unavailable', queryBinding.slot.writingLanguage)]
    })) as Partial<Record<ImportInferenceTopicKey, string>>
    const frozen = recovery.frozenContext
    const template = frozen.prompts.infer_novel_config_with_vectors || frozen.prompts.infer_novel_config
    expect(template).toBeDefined()
    const initialTask = buildImportInferenceTask({ template: template!, writingLanguage: frozen.core.writingLanguage,
      chapters: frozen.chapters, totalChapters: frozen.totalChapters, sampledContent })
    const initialWithSkill = injectWritingSkillPrompt(initialTask, frozen.core.writingLanguage,
      { name: 'fictional-planning', content: 'Respect the fictional letter.' }).task
    expect(stored[0]!.replayTask).toEqual(initialWithSkill)
    if (mode === 'syntax-and-endpoint') {
      const language = queryBinding.slot.writingLanguage, skill = { name: 'fictional-planning', content: 'Respect the fictional letter.' }
      const repair = buildStructuredSyntaxRepairTask({ purpose: 'import-inference', output: 'structured-data', messages: [] },
        importInferenceJsonContract(language), full.slice(0, -1), language)
      const correction = buildImportEndpointCardTask({ writingLanguage: language, originalRoot: initial, unresolvedTargets: ['Sender'] })
      expect(stored[1]!.replayTask.messages).toEqual(injectWritingSkillPrompt(repair, language, skill).task.messages)
      expect(stored[2]!.replayTask.messages).toEqual(injectWritingSkillPrompt(correction, language, skill).task.messages)
    }
    expect(JSON.stringify(stored[0]!.replayTask)).toContain('Respect the fictional letter.')
    expect(JSON.stringify(stored[0]!.replayTask)).toContain('sample-1-')
    expect(JSON.stringify(stored[0]!.replayTask)).toContain('sample-7-')
    expect(JSON.stringify(stored[0]!.replayTask)).not.toContain('-end-1')
    expect(JSON.stringify(stored[0]!.replayTask)).not.toContain('-end-7')
    expect(db.prepare('SELECT count(*) FROM characters').pluck().get()).toBe(0)
    const receipt = JSON.parse(db.prepare('SELECT receipt_json FROM import_global_fact_operations WHERE operation_id=?').pluck().get(`novel-import-global-${runId}`) as string)
    expect(receipt).toMatchObject({ characterProposal: { proposalBatchId: expect.any(String), sourceHash: expect.any(String) } })
    expect(receipt.proposalSource.characterEntries.map((entry: { name: string }) => entry.name))
      .toEqual(mode === 'initial' ? ['Courier', 'Sailor', 'Keeper'] : ['Courier', 'Sailor', 'Keeper', 'Sender'])
    const proposal = JSON.parse(db.prepare('SELECT raw_value FROM character_identity_proposals WHERE proposal_id=?')
      .pluck().get(receipt.characterProposal.proposalBatchId) as string)
    expect(proposal.proof.provenance).toMatchObject({ kind: 'generated', source: { projectId: session.projectId,
      epoch: event.handle.epoch, sourceId: `novel-import-global-${runId}` } })
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    const replay = await start()
    expect(replay).toMatchObject({ success: true, replayed: true, handle: event.handle, run: { stage: 'style' } })
    expect(fetch).toHaveBeenCalledTimes(4 + outputs.length)
  }, 60_000)

  it('drops dangling relationships at the eight-card limit without endpoint dispatch', async () => {
    const initial = inference()
    initial.characterCards[0]!.relationships.push({ target: 'Missing', relation: 'correspondent' })
    for (let index = 3; index < 8; index++) initial.characterCards.push(card(`Person ${index}`))
    const fetch = provider([JSON.stringify(initial)])
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'style' } })
    expect(fetch).toHaveBeenCalledTimes(5)
    const receipt = JSON.parse(getProjectDb()!.prepare('SELECT receipt_json FROM import_global_fact_operations WHERE operation_id=?')
      .pluck().get(`novel-import-global-${runId}`) as string)
    expect(receipt.proposalSource.characterEntries).toHaveLength(8)
    expect(receipt.proposalSource.characterEntries[0].relationships).toEqual([])
    expect(sender.events).toContainEqual(expect.objectContaining({ kind: 'log', value: expect.objectContaining({ key: 'dropped-relationships' }) }))
  }, 60_000)

  it.each(['semantic', 'changed-syntax'] as const)('rejects %s without a global fact or proposal write', async mode => {
    const candidate = inference(), valid = JSON.stringify(candidate)
    const outputs = mode === 'semantic' ? [JSON.stringify({ ...candidate, novelConfig: { ...candidate.novelConfig, plotStructure: 'invalid' } })]
      : [valid.slice(0, -1), valid.replace('Find the sender', 'Change the sender')]
    const fetch = provider(outputs), db = getProjectDb()!
    const before = db.prepare('SELECT * FROM project_core WHERE id=?').get('main')
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: false })
    expect(fetch).toHaveBeenCalledTimes(4 + outputs.length)
    expect(db.prepare('SELECT * FROM project_core WHERE id=?').get('main')).toEqual(before)
    expect(db.prepare('SELECT count(*) FROM import_global_fact_operations').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM characters').pluck().get()).toBe(0)
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)

  it.each([
    ['length', 'zh-CN'], ['length', 'en-US'],
    ['changed-syntax', 'zh-CN'], ['changed-syntax', 'en-US'],
    ['missing-field', 'zh-CN'], ['missing-field', 'en-US'],
  ] as const)('returns the trusted %s error in %s without writing inferred facts', async (kind, locale) => {
    const db = getProjectDb()!
    db.prepare('UPDATE import_runs SET locale=? WHERE id=?').run(locale, runId)
    db.prepare('UPDATE project_core SET writing_language=? WHERE id=?').run(locale === 'zh-CN' ? 'en-US' : 'zh-CN', 'main')
    const before = db.prepare('SELECT * FROM project_core WHERE id=?').get('main')
    const candidate = inference(), full = JSON.stringify(candidate), secret = 'fictional-private-candidate-value'
    let index = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).includes('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
      if (kind === 'length') return completion(secret, 'length')
      if (kind === 'changed-syntax') return completion(index++ === 0 ? full.slice(0, -1) : full.replace('Find the sender', 'Change the sender'))
      const { genre: _genre, ...withoutGenre } = candidate.novelConfig
      void _genre
      return completion(JSON.stringify({ ...candidate, novelConfig: { ...withoutGenre, coreOutline: secret } }))
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), event = await opened(); await ack(event)
    const result = await flight
    const expected = kind === 'length' ? createBoundedCompletionError('length', locale).message
      : kind === 'changed-syntax' ? locale === 'zh-CN' ? '导入推演 JSON 语法修复改变了候选事实，已拒绝写入'
        : 'The import-inference JSON syntax repair changed candidate facts, so the write was rejected.'
        : new StructuredContractDiagnostic('missing_field', 'novelConfig.genre').message
    expect(result).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED', error: expected })
    if (kind === 'length') expect(result).toMatchObject({ completionFailureCode: 'length' })
    else expect(result).not.toHaveProperty('completionFailureCode')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(fetch).toHaveBeenCalledTimes(kind === 'changed-syntax' ? 6 : 5)
    expect(db.prepare('SELECT * FROM project_core WHERE id=?').get('main')).toEqual(before)
    expect(db.prepare('SELECT count(*) FROM import_global_fact_operations').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM characters').pluck().get()).toBe(0)
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)

  it.each(['same-view', 'new-view'] as const)('recovers the original prepared payload without another query or model call: %s', async view => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    const originalCommit = ImportRunRepository.commitEffectReceipt.bind(ImportRunRepository)
    const injection = vi.spyOn(ImportRunRepository, 'commitEffectReceipt').mockImplementationOnce(() => { throw new Error('FICTIONAL_COMMIT_INTERRUPT') })
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: false })
    expect(injection).toHaveBeenCalledTimes(1); injection.mockRestore()
    const prepared = ImportRunRepository.getEffectReceipt(runId, 'global', 'done')
    expect(prepared).toMatchObject({ state: 'prepared' })
    const generation = db.prepare('SELECT root_action_id,binding_json FROM generation_runs WHERE run_id=?').get(event.handle.runId)
    expect(generation).toBeDefined()
    const binding = generation as { root_action_id: string; binding_json: string }
    expect(JSON.parse(binding.binding_json).sourceManifest.modelReceipt.modelId).toBe(model.id)
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(db.prepare('SELECT count(*) FROM import_global_fact_operations').pluck().get()).toBe(0)
    if (view === 'new-view') {
      const oldSession = session
      const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId
        && normalize(item.canonicalRoot) === normalize(session.projectPath))
      expect(runtime).toBeDefined()
      session = { ...session, leaseId: projectAccess.beginViewSession(runtime!).leaseId }
      expect(session.leaseId).not.toBe(oldSession.leaseId)
      expect(projectRuntimeHost.getActiveView()).toBe(runtime)
      await expect(invoke('import-generation:v1:global', { runId, execution, modelId: model.id }, oldSession)).rejects.toThrow()
      expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toEqual(prepared)
      expect(fetch).toHaveBeenCalledTimes(5)
    }
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    const commit = vi.spyOn(ImportRunRepository, 'commitEffectReceipt').mockImplementation(originalCommit)
    const recovered = await start()
    expect(recovered).toMatchObject({ success: true, replayed: true, handle: event.handle, modelId: model.id,
      run: { stage: 'style' }, receipt: { state: 'committed', payload: prepared!.payload, payloadHash: prepared!.payloadHash } })
    expect(db.prepare('SELECT root_action_id,binding_json FROM generation_runs WHERE run_id=?').get(event.handle.runId)).toEqual(generation)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(1)
  }, 60_000)

  it.each(['fresh', 'prepared'] as const)('rejects %s global commit when the captured query knowledge changes', async mode => {
    const db = getProjectDb()!, before = db.prepare('SELECT * FROM project_core WHERE id=?').get('main')
    const guard = vi.spyOn(ImportQueryMaterialsService.prototype, 'withSources')
    const changeKnowledge = async () => {
      const changed = await addChunks(session.projectPath, 'fictional-document', 'fictional.txt', ['A fictional changed harbor.'],
        undefined, undefined, { corpusKind: 'project-knowledge' })
      expect(changed).toMatchObject({ success: true, chunkCount: 1 })
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).includes('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
      if (mode === 'fresh') await changeKnowledge()
      return completion(JSON.stringify(inference()))
    })
    vi.stubGlobal('fetch', fetch)
    const injection = mode === 'prepared'
      ? vi.spyOn(ImportRunRepository, 'commitEffectReceipt').mockImplementationOnce(() => { throw new Error('FICTIONAL_COMMIT_INTERRUPT') })
      : undefined
    const flight = start(), event = await opened(); await ack(event)
    const first = await flight
    if (mode === 'prepared') {
      expect(first).toMatchObject({ success: false })
      expect(injection).toHaveBeenCalledTimes(1); injection!.mockRestore()
      expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toMatchObject({ state: 'prepared' })
      await changeKnowledge()
      executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery', Date.now(), 60_000).execution
      execution = { owner: executionLease.owner, epoch: executionLease.epoch }
      expect(await start()).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED' })
      expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toMatchObject({ state: 'prepared' })
    } else {
      expect(first).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED' })
      expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
    }
    const checks = await Promise.allSettled(guard.mock.results.map(result => result.value))
    expect(checks).toContainEqual(expect.objectContaining({ status: 'rejected',
      reason: expect.objectContaining({ message: 'REFERENCE_IMPORT_KNOWLEDGE_SOURCE_STALE' }) }))
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(db.prepare('SELECT * FROM project_core WHERE id=?').get('main')).toEqual(before)
    expect(db.prepare('SELECT count(*) FROM import_global_fact_operations').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM characters').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(1)
  }, 60_000)

  it('requires a selected model for a new run instead of inventing a default', async () => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    expect(await start(null)).toMatchObject({ success: false, errorCode: 'GENERATION_MODEL_REQUIRED' })
    expect(fetch).not.toHaveBeenCalled()
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM generation_runs').pluck().get()).toBe(0)
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)

  it.each([null, otherModel.id])('preserves the original model and root on prepared recovery with caller selection %s', async callerModel => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    const injection = vi.spyOn(ImportRunRepository, 'commitEffectReceipt').mockImplementationOnce(() => { throw new Error('FICTIONAL_COMMIT_INTERRUPT') })
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: false })
    injection.mockRestore()
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toMatchObject({ state: 'prepared' })
    const binding = db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(event.handle.runId) as string
    expect(JSON.parse(binding).sourceManifest.modelReceipt.modelId).toBe(model.id)
    const attempts = db.prepare('SELECT * FROM generation_attempts').all()
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    expect(await start(callerModel)).toMatchObject({ success: true, replayed: true, handle: event.handle, run: { stage: 'style' } })
    expect(db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(event.handle.runId)).toBe(binding)
    expect(db.prepare('SELECT * FROM generation_attempts').all()).toEqual(attempts)
    expect(db.prepare('SELECT root_action_id FROM generation_roots').pluck().get()).toBe(event.handle.rootActionId)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(5)
  }, 60_000)

  it('advances a committed effect after the transition fails without rewriting the receipt', async () => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    const advance = vi.spyOn(ImportRunRepository, 'advanceStage').mockImplementationOnce(() => { throw new Error('FICTIONAL_ADVANCE_INTERRUPT') })
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: false })
    expect(advance).toHaveBeenCalledTimes(1); advance.mockRestore()
    expect(ImportRunRepository.get(runId)).toMatchObject({ status: 'running', stage: 'global' })
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toMatchObject({ state: 'committed' })
    const receipts = db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()
    const effects = db.prepare('SELECT * FROM import_effect_ledger ORDER BY rowid').all()
    const operations = db.prepare('SELECT * FROM import_global_fact_operations').all()
    const attempts = db.prepare('SELECT * FROM generation_attempts').all()
    expect(await start()).toMatchObject({ success: true, replayed: true, handle: event.handle, run: { stage: 'style' } })
    expect(db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()).toEqual(receipts)
    expect(db.prepare('SELECT * FROM import_effect_ledger ORDER BY rowid').all()).toEqual(effects)
    expect(db.prepare('SELECT * FROM import_global_fact_operations').all()).toEqual(operations)
    expect(db.prepare('SELECT * FROM generation_attempts').all()).toEqual(attempts)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(5)
  }, 60_000)

  it('reads the historical committed receipt after real completion without granting execution', async () => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'style' } })
    // Synthetic later-stage effects supply only already-defined checkpoints; they do not test those drivers.
    ImportRunRepository.prepareEffectReceipt({ runId, stage: 'style', batchId: 'done', effectKey: 'writing-style',
      kind: 'project-writing-style', payload: { writingStyle: 'Fictional style' } }, executionLease)
    ImportRunRepository.commitEffectReceipt(runId, 'style', 'done', executionLease)
    ImportRunRepository.advanceStage(runId, 'style', 'blueprints', executionLease)
    const chapters = ImportRunRepository.listChapterBatch(runId, { afterChapterNumber: 0, limit: 100 })
    for (let offset = 0; offset < chapters.length; offset += 5) {
      const batch = chapters.slice(offset, offset + 5), startChapter = batch[0]!.number, endChapter = batch.at(-1)!.number
      const batchId = createImportRunChapterBatchCheckpointId(batch)
      ImportRunRepository.prepareEffectReceipt({ runId, stage: 'blueprints', batchId, effectKey: `blueprints:${batchId}`,
        kind: 'chapter-blueprint-range', payload: { mode: 'replace-range', operationId: `import-blueprints-${runId}-${startChapter}-${endChapter}`,
          startChapter, endChapter, blueprints: batch.map(chapter => ({ chapterNumber: chapter.number, title: `Fictional ${chapter.number}`,
            role: 'setup', purpose: `Advance ${chapter.number}`, keyEvents: `Event ${chapter.number}`, characters: [], suspenseHook: 'Hook', userGuidance: '', notes: '', notesUpdatedAt: '' })) } }, executionLease)
      ImportRunRepository.commitEffectReceipt(runId, 'blueprints', batchId, executionLease)
    }
    ImportRunRepository.advanceStage(runId, 'blueprints', 'refresh', executionLease)
    ImportRunRepository.completeBatch(runId, 'refresh', 'done', executionLease)
    expect(ImportRunRepository.complete(runId, executionLease)).toMatchObject({ stage: 'completed', status: 'completed' })
    const before = db.prepare('SELECT * FROM import_runs WHERE id=?').get(runId)
    const receipts = db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()
    const attempts = db.prepare('SELECT * FROM generation_attempts').all()
    const renew = vi.spyOn(ImportRunRepository, 'renewExecution')
    expect(await start()).toMatchObject({ success: true, replayed: true, execution: null, handle: event.handle, run: { stage: 'completed' } })
    expect(renew).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM import_runs WHERE id=?').get(runId)).toEqual(before)
    expect(db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()).toEqual(receipts)
    expect(db.prepare('SELECT * FROM generation_attempts').all()).toEqual(attempts)
    expect(fetch).toHaveBeenCalledTimes(5)
  }, 60_000)

  it('rolls back the global effect when the roster revision changes after decoding', async () => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    const before = db.prepare('SELECT * FROM project_core WHERE id=?').get('main')
    const original = ImportRunRepository.commitEffectReceipt.bind(ImportRunRepository)
    const commit = vi.spyOn(ImportRunRepository, 'commitEffectReceipt').mockImplementationOnce((...args) => {
      // Fault injection at the real post-decode/precommit boundary simulates a concurrent roster revision.
      db.prepare("UPDATE character_roster_meta SET revision=revision+1 WHERE id='main'").run()
      return original(...args)
    })
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: false, errorCode: 'CHARACTER_ROSTER_REVISION_STALE' })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT * FROM project_core WHERE id=?').get('main')).toEqual(before)
    expect(db.prepare('SELECT count(*) FROM import_global_fact_operations').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM characters').pluck().get()).toBe(0)
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toMatchObject({ state: 'prepared' })
    expect(fetch).toHaveBeenCalledTimes(5)
  }, 60_000)

  it('does not resend a transport-unknown query under a new execution owner', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('fictional reset'), { code: 'ECONNRESET' }) }) })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN' })
    const db = getProjectDb()!, topics = db.prepare('SELECT * FROM import_query_topics ORDER BY rowid').all()
    expect(topics).toContainEqual(expect.objectContaining({ topic_key: 'worldview', state: 'unknown' }))
    const prior = execution
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    expect(execution.owner).not.toBe(prior.owner); expect(execution.epoch).toBeGreaterThan(prior.epoch)
    sender.events = []
    let settled = false
    const retry = start().finally(() => { settled = true })
    await vi.waitFor(() => expect(settled || sender.events.some(item => item.kind === 'opened')).toBe(true), { timeout: 10_000 })
    const reopened = sender.events.find(item => item.kind === 'opened')
    if (reopened?.kind === 'opened') { expect(reopened.handle).toEqual(event.handle); await ack(reopened) }
    expect(await retry).toMatchObject({ success: false, errorCode: 'GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT * FROM import_query_topics ORDER BY rowid').all()).toEqual(topics)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
  }, 60_000)

  it.each(['unknown', 'persistence'] as const)('keeps a durable %s query failure ahead of a later sender stop while its sibling physically drains', async kind => {
    mocks.concurrency = 2
    const releases: Array<() => void> = []
    let draining = false
    const fetch = vi.fn(async () => {
      const index = releases.length
      await new Promise<void>(resolve => { releases.push(resolve); if (draining) resolve() })
      if (index === 0) throw new TypeError('fetch failed', { cause: Object.assign(new Error('fictional reset'), { code: 'ECONNRESET' }) })
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    let settled = false
    const flight = start().finally(() => { settled = true }), event = await opened(), db = getProjectDb()!
    try {
      await ack(event)
      await vi.waitFor(() => expect(releases).toHaveLength(2), { timeout: 10_000 })
      if (kind === 'persistence') db.exec("CREATE TEMP TRIGGER fictional_query_settle_failure BEFORE UPDATE OF outcome_json ON import_query_topics BEGIN SELECT RAISE(ABORT,'fictional persistence failure'); END")
      releases[0]!()
      await vi.waitFor(() => {
        if (kind === 'unknown') expect(db.prepare("SELECT count(*) FROM import_query_topics WHERE state='unknown'").pluck().get()).toBe(1)
        else expect(db.prepare('SELECT blocked_code FROM generation_roots').pluck().get()).toBe('GENERATION_IMPORT_QUERY_PERSISTENCE_FAILED')
        expect(db.prepare('SELECT count(*) FROM import_query_topics WHERE marked_at_ms IS NOT NULL AND physical_closed_at_ms IS NULL').pluck().get()).toBe(1)
      }, { timeout: 10_000 })
      sender.destroy()
      await new Promise(resolve => setTimeout(resolve, 75))
      expect(settled).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
      if (kind === 'persistence') db.exec('DROP TRIGGER fictional_query_settle_failure')
      releases[1]!()
      expect(await flight).toMatchObject({ success: false, errorCode: kind === 'unknown'
        ? 'GENERATION_IMPORT_QUERY_RECOVERY_UNKNOWN' : 'GENERATION_IMPORT_QUERY_PERSISTENCE_FAILED' })
      expect(db.prepare('SELECT status,stage,execution_owner,lease_expires_at FROM import_runs WHERE id=?').get(runId))
        .toMatchObject({ status: 'failed', stage: 'global', execution_owner: '', lease_expires_at: 0 })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fictional_query_settle_failure')
      draining = true; releases.forEach(release => release())
      await Promise.allSettled([flight])
    }
  }, 60_000)

  it.each([0, 1, 2])('does not resend an unknown LLM ordinal %i after takeover', async ordinal => {
    const original = inference(); original.characterCards[0]!.relationships.push({ target: 'Sender', relation: 'correspondent' })
    const complete = JSON.stringify(original), outputs = [complete.slice(0, -1), complete]
    let llmCalls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).includes('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
      if (llmCalls++ === ordinal) throw new TypeError('fetch failed', { cause: Object.assign(new Error('fictional reset'), { code: 'ECONNRESET' }) })
      return completion(outputs[llmCalls - 1]!)
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
    const db = getProjectDb()!, attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all() as {
      invocation_nonce: string; attempt_json: string; root_action_id: string
    }[]
    expect(attempts).toHaveLength(ordinal + 1)
    expect(attempts.at(-1)).toMatchObject({ invocation_nonce: `import:${ordinal}`, root_action_id: event.handle.rootActionId })
    expect(JSON.parse(attempts.at(-1)!.attempt_json)).toMatchObject({ status: 'unknown' })
    const calls = fetch.mock.calls.length, old = execution
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    expect(execution.owner).not.toBe(old.owner); expect(execution.epoch).toBeGreaterThan(old.epoch)
    sender.events = []
    let settled = false
    const retry = start().finally(() => { settled = true })
    await vi.waitFor(() => expect(settled || sender.events.some(item => item.kind === 'opened')).toBe(true), { timeout: 10_000 })
    const reopened = sender.events.find(item => item.kind === 'opened')
    if (reopened?.kind === 'opened') { expect(reopened.handle).toEqual(event.handle); await ack(reopened) }
    expect(await retry).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
    expect(fetch).toHaveBeenCalledTimes(calls)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)

  it('validates the closed request and sender-bound ACK before any query', async () => {
    const fetch = provider([JSON.stringify(inference())])
    await expect(invoke('import-generation:v1:global', { runId, execution, modelId: model.id, task: {} })).rejects.toThrow()
    await expect(invoke('import-generation:v1:global', { runId, execution, modelId: model.id }, { ...session, leaseId: 'fictional-stale' })).rejects.toThrow()
    const flight = start(), event = await opened()
    await expect(invoke('import-generation:v1:global-ack', { runId, execution, token: 'unknown-token', decision: 'accept' })).rejects.toThrow()
    await expect(ack(event, 'accept', new Sender())).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    await expect(ack(event, 'cancelled')).rejects.toThrow('GENERATION_ACTION_CANCELLED')
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_ACTION_CANCELLED' })
    expect(fetch).not.toHaveBeenCalled()
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)

  it('renews the same execution while opened waits and does not dispatch before ACK', async () => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    const original = ImportRunRepository.renewExecution, renewals: ImportRunExecutionLease[] = []
    const renew = vi.spyOn(ImportRunRepository, 'renewExecution').mockImplementation((id, lease, now, _leaseMs, context) => {
      const actual = original.call(ImportRunRepository, id, lease, now, 200, context)
      renewals.push(actual)
      return actual
    })
    const flight = start(), event = await opened()
    expect(renewals.length).toBeGreaterThan(0)
    const firstExpiry = renewals[0]!.expiresAt
    await vi.waitFor(() => { expect(Date.now()).toBeGreaterThan(firstExpiry); expect(renewals.length).toBeGreaterThanOrEqual(3) }, { timeout: 4_000, interval: 20 })
    expect(renewals.every(lease => lease.owner === execution.owner && lease.epoch === execution.epoch)).toBe(true)
    expect(db.prepare('SELECT execution_owner,execution_epoch FROM import_runs WHERE id=?').get(runId))
      .toMatchObject({ execution_owner: execution.owner, execution_epoch: execution.epoch })
    expect(fetch).not.toHaveBeenCalled()
    original.call(ImportRunRepository, runId, renewals[renewals.length - 1]!, Date.now())
    renew.mockRestore()
    await ack(event)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'style' } })
    expect(fetch).toHaveBeenCalledTimes(5)
  }, 60_000)

  it('rejects a changed frozen source after opened without querying or committing', async () => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    const flight = start(), event = await opened()
    db.prepare("UPDATE project_core SET world_setting='Changed fictional source' WHERE id='main'").run()
    await ack(event)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_IMPORT_CONTEXT_CHANGED' })
    expect(fetch).not.toHaveBeenCalled()
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
    expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
  }, 60_000)

  it('fences old same-run query and database writers while preserving cancellation', async () => {
    const fetch = provider([JSON.stringify(inference())])
    const flight = start(), event = await opened()
    await expect(invoke('import-generation:v1:query-materials', { handle: event.handle, execution })).rejects.toThrow()
    expect(await dbCall('db:import-run-advance-stage', runId, 'global', 'style', execution)).toMatchObject({ success: false })
    await expect(invoke('import-generation:execute', { handle: event.handle, execution, ordinal: 0,
      task: { purpose: 'import-inference', output: 'structured-data', messages: [{ role: 'user', content: 'forged' }] } })).rejects.toThrow()
    const candidate = inference()
    const globalRequest = { operationId: `novel-import-global-${runId}`, expectedRosterRevision: 0,
      core: { ...candidate.novelConfig, narrativePov: candidate.novelConfig.narrativePOV, totalChapters: 7, wordsPerChapter: 100,
        ...candidate.architectureFiles }, characterEntries: candidate.characterCards }
    expect(await dbCall('db:import-global-facts-commit', { ...globalRequest, operationId: 'fictional-other-operation', generationRunHandle: event.handle }))
      .toMatchObject({ success: false, errorCode: 'GENERATION_OWNER_BUSY' })
    expect(await dbCall('db:import-global-facts-commit', globalRequest)).toMatchObject({ success: false, errorCode: 'GENERATION_OWNER_BUSY' })
    expect(await dbCall('db:import-global-facts-commit', { ...globalRequest, operationId: `  ${globalRequest.operationId}  ` }))
      .toMatchObject({ success: false, errorCode: 'GENERATION_OWNER_BUSY' })
    expect(await dbCall('db:import-run-request-cancel', runId, execution)).toMatchObject({ success: true })
    await ack(event)
    expect(await flight).toMatchObject({ success: false })
    expect(fetch).not.toHaveBeenCalled()
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)

  it('cannot mutate the successor after actual lease expiry and takeover while opened waits', async () => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    const flight = start(), event = await opened()
    expect(event.execution).toEqual(execution)
    // Only expiry is injected; startOrResume creates the actual successor authority.
    db.prepare('UPDATE import_runs SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, runId)
    const successor = ImportRunRepository.startOrResume(runId, 'fictional-successor', Date.now(), 60_000).execution
    const row = db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at,status,stage,cancel_requested,last_error FROM import_runs WHERE id=?').get(runId)
    expect(row).toMatchObject({ execution_owner: successor.owner, execution_epoch: successor.epoch, lease_expires_at: successor.expiresAt,
      status: 'running', stage: 'global', cancel_requested: 0 })
    expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_EXECUTION_STALE' })
    expect(db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at,status,stage,cancel_requested,last_error FROM import_runs WHERE id=?').get(runId)).toEqual(row)
    expect(fetch).not.toHaveBeenCalled()
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)

  it.each(['elapsed', 'physical'] as const)('does not dispatch when the captured root %s budget has been exhausted', async kind => {
    const fetch = provider([JSON.stringify(inference())]), db = getProjectDb()!
    const flight = start(), event = await opened()
    const repository = new GenerationRunRepository(() => db), rootId = event.handle.rootActionId
    let budget = repository.budget(rootId)
    if (kind === 'elapsed') db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(budget.policy.maxActiveElapsedMs, rootId)
    else {
      // Terminal synthetic ledger entries model prior consumption without any real provider requests.
      let index = 0
      while (budget.attempts.length + (budget.auxiliaryRequestCount ?? 0) < budget.policy.maxPhysicalRequests) {
        const receipt = repository.reserve(event.handle.runId, `fictional-exhaustion-${index}`, hash(`fictional-exhaustion-${index}`), 1, 1)
        repository.markDispatched(receipt.attempt.attemptId)
        repository.settle(receipt.attempt.attemptId, null, 'stop')
        index++; budget = repository.budget(rootId)
      }
    }
    const attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const policy = db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(rootId)
    await ack(event)
    expect(await flight).toMatchObject({ success: false, errorCode: 'ROOT_BUDGET_EXHAUSTED' })
    expect(fetch).not.toHaveBeenCalled()
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(rootId)).toBe(policy)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)

  it.each(['sender', 'close', 'cancel'] as const)('waits for physical query drain on %s even when provider ignores abort', async stop => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetch = vi.fn(async () => {
      entered(); await gate
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), event = await opened(); await ack(event); await started
    let closed = false
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId)!
    expect(runtime).toBeDefined()
    const closing = stop === 'close' ? projectRuntimeHost.requestClose(runtime).then(() => { closed = true }) : undefined
    if (stop === 'sender') sender.destroy()
    if (stop === 'cancel') expect(await dbCall('db:import-run-request-cancel', runId, execution)).toMatchObject({ success: true })
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      if (closing) expect(closed).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      releaseFetch!()
      await Promise.allSettled([flight, ...(closing ? [closing] : [])])
    }
    if (closing) expect(closed).toBe(true)
    expect(await flight).toMatchObject({ success: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  }, 60_000)

  it('preserves a hard network failure when sender destruction follows its durable settlement', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).includes('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('fictional reset'), { code: 'ECONNRESET' }) })
    })
    vi.stubGlobal('fetch', fetch)
    const original = GenerationRunRepository.prototype.settle
    const settle = vi.spyOn(GenerationRunRepository.prototype, 'settle').mockImplementation(function (this: GenerationRunRepository, ...args) {
      const receipt = original.apply(this, args)
      if (receipt.attempt.status === 'unknown') {
        expect(receipt.failureCode).toBe('NETWORK_ERROR')
        sender.destroy()
      }
      return receipt
    })
    const flight = start(), event = await opened(); await ack(event)
    expect(await flight).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
    expect(settle).toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)

  it('drains an in-flight LLM after sender destruction without committing', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).includes('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
      entered(); await gate; return completion(JSON.stringify(inference()))
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), event = await opened(); await ack(event); await started
    sender.destroy()
    try {
      expect(scheduler.getStats().occupied).toBe(1)
      expect(fetch).toHaveBeenCalledTimes(5)
    } finally {
      releaseFetch!()
      await Promise.allSettled([flight])
    }
    expect(await flight).toMatchObject({ success: false })
    await vi.waitFor(() => expect(scheduler.getStats().occupied).toBe(0), { timeout: 10_000 })
    expect(ImportRunRepository.getEffectReceipt(runId, 'global', 'done')).toBeNull()
  }, 60_000)
})

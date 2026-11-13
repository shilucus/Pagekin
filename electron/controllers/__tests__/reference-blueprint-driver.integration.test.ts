import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import { createImportRunChapterBatchCheckpointId, type ImportRunExecutionAuthority, type ImportRunExecutionLease } from '../../../src/shared/import-run'
import { parseBlueprintSemanticResponseText } from '../../../src/shared/blueprint-semantic-contract'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'
import { isReferenceBlueprintProgress, type ReferenceBlueprintProgress, type ReferenceBlueprintResponse } from '../../../src/shared/reference-blueprint-contract'
import { isReferenceStyleProgress, type ReferenceStyleProgress, type ReferenceStyleResponse } from '../../../src/shared/reference-style-contract'
import type { ImportGenerationRecovery } from '../../../src/shared/import-generation'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { buildImportBlueprintTask } from '../../../src/shared/import-blueprint-materials'
import { injectWritingSkillPrompt } from '../../../src/shared/writing-skill-task'
import { knownAppErrorMessage } from '../../../src/i18n/app-errors'
import { registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { closeProjectDatabase, createProjectDatabase, getCurrentProjectPath, getProjectDb, initProjectDatabase } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { CharacterProposalService } from '../../services/character-proposal-service'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { MainGenerationScheduler } from '../../services/generation-scheduler'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost } from '../../services/project-runtime'
import { getProjectDataRoot, getProjectDatabasePath } from '../../services/project-data-locator'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
type Progress = Extract<ReferenceBlueprintProgress, { kind: 'opened' }>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))

let runId = 'fictional-reference-blueprints'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const model: ModelProfile = { id: 'fictional-model', name: 'Fictional', provider: 'openai', protocol: 'openai',
  modelName: 'fictional-model', baseUrl: 'https://fictional.invalid/v1', apiKey: 'fictional-only', temperature: 0.7,
  maxTokens: 16384, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 16384,
    reasoning: false, structuredOutput: true, usage: true } }
const splitModel: ModelProfile = { ...model, id: 'fictional-split-model', modelName: 'fictional-split-model', maxTokens: 4608,
  capabilities: { contextWindowTokens: 32768, maxOutputTokens: 4608, reasoning: false, structuredOutput: true, usage: true } }
const scheduler = new MainGenerationScheduler({ global: 2, provider: 2, credential: 2, model: 2, project: 1,
  maxQueued: 16, maxQuarantined: 2, interactiveBurst: 1 }, 60)
class Sender extends EventEmitter {
  readonly id = 71
  destroyed = false
  events: ReferenceBlueprintProgress[] = []
  styleEvents: ReferenceStyleProgress[] = []
  isDestroyed() { return this.destroyed }
  send(channel: string, payload: unknown) {
    if (channel === 'import-generation:v1:blueprints-progress') {
      if (!isReferenceBlueprintProgress(payload)) throw new Error('INVALID_BLUEPRINT_PROGRESS')
      this.events.push(payload)
    }
    if (channel === 'import-generation:v1:style-progress') {
      if (!isReferenceStyleProgress(payload)) throw new Error('INVALID_STYLE_PROGRESS')
      this.styleEvents.push(payload)
    }
  }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}
let sender: Sender, root: string, session: ProjectSessionContext, execution: ImportRunExecutionAuthority
let executionLease: ImportRunExecutionLease
let pending: Promise<ReferenceBlueprintResponse> | undefined, releaseFetch: (() => void) | undefined
let stylePending: Promise<ReferenceStyleResponse> | undefined

beforeAll(() => {
  const loadModel = (id: string) => id === model.id ? model : id === splitModel.id ? splitModel : null
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel }), loadModel,
    applyProxyConfig: () => {}, scheduler })
  registerDatabaseController()
})
beforeEach(() => {
  runId = 'fictional-reference-blueprints'
  sender = new Sender(); pending = undefined; stylePending = undefined; releaseFetch = undefined
  const base = path.resolve('.runtime/rb67')
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'f-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, 'Fictional reference')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.prepare("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','Fictional reference',100)").run()
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: projectAccess.beginSession(project).leaseId }
  const testName = expect.getState().currentTestName ?? ''
  const chapterCount = testName.includes('original page-100 boundary') ? 101
    : testName.includes('only prepared range in a new view') ? 2 : 7
  const chapters = Array.from({ length: chapterCount }, (_, index) => {
    const number = index + 1, content = `Fictional chapter ${number}: the courier finds a letter.`
    return { number, title: `Fictional ${number}`, content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }
  })
  ImportRunRepository.prepare({ runId, purpose: 'reference', sourceFingerprint: hash('fictional-source'), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: 1 }], chapters })
  executionLease = ImportRunRepository.startOrResume(runId, 'fictional-owner', Date.now(), 60_000).execution
  execution = { owner: executionLease.owner, epoch: executionLease.epoch }
  // This isolates the stage under test; earlier stages are not claimed as executed.
  getProjectDb()!.prepare("UPDATE import_runs SET stage='blueprints' WHERE id=?").run(runId)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('UNEXPECTED_NETWORK') }))
})
function removeFixture() {
  const base = path.resolve('.runtime/rb67'), target = path.resolve(root), relative = path.relative(base, target)
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
  if (stylePending) await stylePending.catch(() => undefined)
  const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId
    && normalize(item.canonicalRoot) === normalize(session.projectPath))
  if (runtime) await projectRuntimeHost.requestClose(runtime)
  const currentPath = getCurrentProjectPath()
  if (currentPath && normalize(currentPath) === normalize(session.projectPath)) closeProjectDatabase()
  const currentSession = projectAccess.captureCurrentSession()
  if (currentSession?.projectId === session.projectId && currentSession.leaseId === session.leaseId) projectAccess.invalidateCurrentSession()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); removeFixture()
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
  const flight = invoke<ReferenceBlueprintResponse>('import-generation:v1:blueprints', { runId, execution, modelId })
  pending = flight; void flight.catch(() => undefined)
  return flight
}
async function opened(index = 0) {
  const waiting = vi.waitFor(() => expect(sender.events.filter(item => item.kind === 'opened').length).toBeGreaterThan(index), { timeout: 10_000 })
    .then(() => sender.events.filter((item): item is Progress => item.kind === 'opened')[index]!)
  if (!pending) throw new Error('BLUEPRINT_FLIGHT_MISSING')
  return Promise.race([waiting, pending.then(result => { throw new Error(`BLUEPRINT_BEFORE_OPENED:${result.success ? 'UNEXPECTED_FINISH' : result.errorCode}`) })])
}
function ack(event: Progress, eventSender = sender) {
  return invoke('import-generation:v1:blueprints-ack', { runId, execution, batchId: event.batchId, token: event.token, decision: 'accept' }, session, eventSender)
}
function blueprint(number: number) {
  return { chapterNumber: number, title: `Chapter ${number}`, role: 'setup', purpose: 'Find the sender', keyEvents: `Letter ${number}`,
    characters: ['Courier'], newCharacterCandidates: [{ name: 'Courier', role: 'protagonist' }], relationships: [], suspenseHook: 'Who wrote the letter?' }
}
function response(numbers: number[], finishReason: 'stop' | 'length' = 'stop') {
  return stream(JSON.stringify({ blueprints: numbers.map(blueprint) }), finishReason)
}
function stream(text: string, finishReason: string = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
async function seedActualStyle() {
  getProjectDb()!.prepare("UPDATE import_runs SET stage='style' WHERE id=?").run(runId)
  const fetch = vi.fn<typeof globalThis.fetch>(async () => stream('Fictional concise writing style.'))
  vi.stubGlobal('fetch', fetch)
  const flight = invoke<ReferenceStyleResponse>('import-generation:v1:style', { runId, execution, modelId: model.id })
  stylePending = flight; void flight.catch(() => undefined)
  const wait = async (kind: 'opened' | 'commit-ready') => {
    await vi.waitFor(() => expect(sender.styleEvents.some(item => item.kind === kind)).toBe(true), { timeout: 10_000 })
    return sender.styleEvents.find((item): item is Extract<ReferenceStyleProgress, { kind: 'opened' | 'commit-ready' }> => item.kind === kind)!
  }
  const first = await wait('opened')
  await invoke('import-generation:v1:style-ack', { runId, execution, token: first.token, phase: 'opened', decision: 'accept' })
  const ready = await wait('commit-ready')
  await invoke('import-generation:v1:style-ack', { runId, execution, token: ready.token, phase: 'commit', decision: 'accept' })
  expect(await flight).toMatchObject({ success: true, run: { stage: 'blueprints' }, modelId: model.id })
  expect(fetch).toHaveBeenCalledTimes(1)
  return first.handle
}
async function seedShortPrior() {
  const chapters = ImportRunRepository.listChapterBatch(runId, { afterChapterNumber: 0, limit: 100 })
  const batchId = createImportRunChapterBatchCheckpointId(chapters.slice(0, 2))
  const slot = { runId, stage: 'blueprints', batchId }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response([1, 2]))
  vi.stubGlobal('fetch', fetch)
  const begun = await invoke<{ handle: MainGenerationRunHandle }>('generation:begin', {
    operation: 'import-blueprints', uiActionNonce: 'fictional-short-prior', modelId: model.id,
    promptKeys: ['infer_single_chapter_blueprint'], skillStages: ['planning'], selectedDraftIds: [], selectedFinalizedDraftIds: [],
    output: 'structured-data', importSlot: slot, importExecution: execution,
  })
  const raw = JSON.stringify({ blueprints: [1, 2].map(blueprint) })
  expect(await invoke('import-generation:execute', { handle: begun.handle, execution, ordinal: 0,
    task: { purpose: 'import-chapter-blueprints', output: 'structured-data', messages: [{ role: 'user', content: 'Fictional range.' }] } }))
    .toMatchObject({ outcome: { status: 'completed' } })
  const effect = { ...slot, effectKey: `blueprints:${batchId}`, kind: 'chapter-blueprint-range', payload: {
    mode: 'replace-range', operationId: `import-blueprints-${runId}-1-2`, startChapter: 1, endChapter: 2,
    generationRunHandle: begun.handle, blueprints: parseBlueprintSemanticResponseText(raw, [1, 2])
      .map(item => ({ ...item, userGuidance: '', notes: '', notesUpdatedAt: '' })),
  } }
  const prepared = await dbCall<{ success: boolean; errorCode?: string; error?: string }>('db:import-run-effect-receipt-prepare', effect, executionLease)
  if (!prepared.success) throw new Error(`FICTIONAL_SHORT_PRIOR_PREPARE:${prepared.errorCode ?? prepared.error ?? 'UNKNOWN'}`)
  expect(prepared).toMatchObject({ success: true, receipt: { state: 'prepared' } })
  expect(await dbCall('db:import-run-effect-receipt-commit', runId, 'blueprints', batchId, executionLease))
    .toMatchObject({ success: true, result: { receipt: { state: 'committed' } } })
  return { batchId, fetch, begun }
}

describe('registered foreground reference blueprints', () => {
  it('inherits the original style root and model despite another caller model', async () => {
    const style = await seedActualStyle()
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(calls++ === 0 ? [1, 2, 3, 4, 5] : [6, 7]))
    vi.stubGlobal('fetch', fetch)
    const flight = start('fictional-other-model'), first = await opened(); await ack(first)
    const second = await opened(1); await ack(second)
    expect(await flight).toMatchObject({ success: true, modelId: model.id, run: { stage: 'refresh' } })
    expect(first.handle.rootActionId).toBe(style.rootActionId)
    expect(second.handle.rootActionId).toBe(style.rootActionId)
    expect(first.modelId).toBe(model.id); expect(second.modelId).toBe(model.id)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
  }, 90_000)

  it.each(['elapsed', 'physical'] as const)('does not create another root after original %s budget is exhausted', async kind => {
    const style = await seedActualStyle(), db = getProjectDb()!
    const repository = new GenerationRunRepository(() => db)
    let budget = repository.budget(style.rootActionId)
    if (kind === 'elapsed') db.prepare('UPDATE generation_roots SET active_elapsed_ms=?,active_since_ms=NULL WHERE root_action_id=?')
      .run(budget.policy.maxActiveElapsedMs, style.rootActionId)
    else {
      let index = 0
      while (budget.attempts.length + (budget.auxiliaryRequestCount ?? 0) < budget.policy.maxPhysicalRequests) {
        const receipt = repository.reserve(style.runId, `fictional-exhaustion-${index}`, hash(`fictional-exhaustion-${index}`), 1, 1)
        repository.markDispatched(receipt.attempt.attemptId); repository.settle(receipt.attempt.attemptId, null, 'stop')
        index++; budget = repository.budget(style.rootActionId)
      }
    }
    const attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response([1, 2, 3, 4, 5]))
    vi.stubGlobal('fetch', fetch)
    const flight = start()
    let settled = false
    void flight.then(() => { settled = true }, () => { settled = true })
    await vi.waitFor(() => expect(settled || sender.events.some(item => item.kind === 'opened')).toBe(true), { timeout: 10_000 })
    const event = sender.events.find((item): item is Progress => item.kind === 'opened')
    if (event) await ack(event)
    expect(await flight).toMatchObject({ success: false, errorCode: 'ROOT_BUDGET_EXHAUSTED' })
    expect(fetch).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
  }, 90_000)

  it('preserves the original page-100 boundary for a 101 chapter run', async () => {
    const chapters = Array.from({ length: 101 }, (_, index) => ({ number: index + 1 }))
    const prior = await seedShortPrior()
    const oldReceipt = ImportRunRepository.getEffectReceipt(runId, 'blueprints', prior.batchId)
    let offset = 2
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const numbers = chapters.slice(offset, Math.min(offset + 5, offset < 100 ? 100 : chapters.length)).map(chapter => chapter.number)
      offset += numbers.length
      return response(numbers)
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start()
    for (let index = 0; index < 21; index++) {
      const event = await opened(index)
      const startChapter = index === 20 ? 101 : 3 + index * 5
      const endChapter = index === 20 ? 101 : Math.min(startChapter + 4, 100)
      expect(event.batchId.startsWith(`${startChapter}-${endChapter}-`)).toBe(true)
      await ack(event)
    }
    expect(await flight).toMatchObject({ success: true, run: { stage: 'refresh' } })
    expect(fetch).toHaveBeenCalledTimes(21)
    const committed = sender.events.flatMap(item => item.kind === 'range-committed' ? [item.batchId] : [])
    expect(committed).toHaveLength(21)
    expect(committed.at(-2)).toMatch(/^98-100-/)
    expect(committed.at(-1)).toMatch(/^101-101-/)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', prior.batchId)).toEqual(oldReceipt)
    expect(committed.includes(prior.batchId)).toBe(false)
    expect(sender.events.some(item => item.kind === 'range-synced' && item.batchId === prior.batchId)).toBe(false)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
  }, 240_000)

  it('replays an existing shorter real checkpoint before partitioning the uncovered chapters', async () => {
    const db = getProjectDb()!
    const { batchId, fetch } = await seedShortPrior()
    const old = ImportRunRepository.getEffectReceipt(runId, 'blueprints', batchId)
    fetch.mockImplementation(async () => response([3, 4, 5, 6, 7]))
    const flight = start(), next = await opened()
    expect(next.batchId).toMatch(/^3-7-/)
    await ack(next)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'refresh' } })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', batchId)).toEqual(old)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(sender.events.flatMap(item => item.kind === 'range-committed' ? [item.batchId] : [])).toEqual([next.batchId])
    expect(sender.events.flatMap(item => item.kind === 'range-synced' ? [item.batchId] : [])).toEqual([next.batchId])
  }, 90_000)

  it('commits two contiguous ranges as proposals and advances only after both sync', async () => {
    const skillRoot = getProjectDataRoot(session.projectPath)
    fs.mkdirSync(path.join(skillRoot, 'skills', 'fictional-planning'), { recursive: true })
    fs.writeFileSync(path.join(skillRoot, 'skills', 'fictional-planning', 'SKILL.md'),
      '---\nname: fictional-planning\nlanguage: bilingual\nstage: planning\n---\nRespect the fictional letter.\n')
    fs.writeFileSync(path.join(skillRoot, 'writing-skills.json'), JSON.stringify({ version: 1, bindings: { planning: 'project:fictional-planning' } }))
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(calls++ === 0 ? [1, 2, 3, 4, 5] : [6, 7]))
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened()
    expect(fetch).not.toHaveBeenCalled()
    const firstRecovery = await invoke<ImportGenerationRecovery | null>('import-generation:read', {
      slot: { runId, stage: 'blueprints', batchId: first.batchId }, runId: first.handle.runId,
    })
    expect(firstRecovery?.view.handle).toEqual(first.handle)
    await ack(first)
    const second = await opened(1)
    expect(second.batchId).not.toBe(first.batchId)
    const secondRecovery = await invoke<ImportGenerationRecovery | null>('import-generation:read', {
      slot: { runId, stage: 'blueprints', batchId: second.batchId }, runId: second.handle.runId,
    })
    expect(secondRecovery?.view.handle).toEqual(second.handle)
    await ack(second)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'refresh' }, modelId: model.id })
    expect(fetch).toHaveBeenCalledTimes(2)
    const db = getProjectDb()!
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(2)
    expect(db.prepare('SELECT count(*) FROM characters').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM character_identity_approvals').pluck().get()).toBe(0)
    const proposals = db.prepare("SELECT raw_value FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'").all() as Array<{ raw_value: string }>
    expect(proposals.length).toBeGreaterThan(0)
    expect(proposals.every(row => JSON.parse(row.raw_value).batch.status === 'pending-approval')).toBe(true)
    const attempts = db.prepare('SELECT run_id,root_action_id,invocation_nonce,usage_receipt_json FROM generation_attempts ORDER BY rowid').all() as Array<{
      run_id: string; root_action_id: string; invocation_nonce: string; usage_receipt_json: string
    }>
    expect(attempts.map(item => item.invocation_nonce)).toEqual(['import:0', 'import:0'])
    expect(attempts.map(item => item.run_id)).toEqual([first.handle.runId, second.handle.runId])
    expect(attempts.every(item => item.root_action_id === first.handle.rootActionId)).toBe(true)
    for (const [index, recovery] of [firstRecovery, secondRecovery].entries()) {
      if (!recovery) throw new Error('FIXTURE_RECOVERY_MISSING')
      const frozen = recovery.frozenContext, language = frozen.core.writingLanguage
      const task = buildImportBlueprintTask({ template: frozen.prompts.infer_single_chapter_blueprint!, writingLanguage: language,
        items: frozen.chapters, validatedPrefix: [], configSummary: JSON.stringify(frozen.core) })
      const expected = injectWritingSkillPrompt({ ...task, reasoningStage: 'planning',
        budgetDemand: { kind: 'structured-items', writingLanguage: language, requestedItems: frozen.chapters.length } }, language,
      { name: 'fictional-planning', content: 'Respect the fictional letter.' }).task
      const stored = JSON.parse(attempts[index]!.usage_receipt_json) as { replayTask: GenerationTask }
      expect(stored.replayTask).toEqual(expected)
    }
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)).toMatchObject({ state: 'committed' })
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', second.batchId!)).toMatchObject({ state: 'committed' })
    expect(sender.events.filter(item => item.kind === 'range-committed')).toHaveLength(2)
    expect(sender.events.filter(item => item.kind === 'range-synced')).toHaveLength(2)
  }, 90_000)

  it('retains per-range ordinals through length split and one syntax repair', async () => {
    const repaired = JSON.stringify({ blueprints: [1, 2].map(blueprint) })
    const outputs = [response([1, 2, 3, 4, 5], 'length'), stream(repaired.slice(0, -1)), stream(repaired),
      response([3, 4, 5]), response([6, 7])]
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const next = outputs.shift()
      if (!next) throw new Error('UNEXPECTED_INFERENCE')
      return next
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(); await ack(first)
    const second = await opened(1); await ack(second)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'refresh' } })
    expect(fetch).toHaveBeenCalledTimes(5)
    const rows = getProjectDb()!.prepare('SELECT run_id,invocation_nonce,usage_receipt_json FROM generation_attempts ORDER BY rowid').all() as Array<{
      run_id: string; invocation_nonce: string; usage_receipt_json: string
    }>
    expect(rows.slice(0, 4).map(row => row.invocation_nonce)).toEqual(['import:0', 'import:1', 'import:2', 'import:3'])
    expect(new Set(rows.slice(0, 4).map(row => row.run_id)).size).toBe(1)
    expect(rows[4]!.invocation_nonce).toBe('import:0')
    expect(rows[4]!.run_id).not.toBe(rows[0]!.run_id)
    const tasks = rows.map(row => (JSON.parse(row.usage_receipt_json) as { replayTask: GenerationTask }).replayTask)
    expect(tasks.map(task => task.purpose)).toEqual(['import-chapter-blueprints', 'import-chapter-blueprints',
      'import-chapter-blueprints:structured-syntax-repair', 'import-chapter-blueprints', 'import-chapter-blueprints'])
    const rightPrompt = tasks[3]!.messages.find(message => message.role === 'user')!.content
    const nextRangePrompt = tasks[4]!.messages.find(message => message.role === 'user')!.content
    expect(rightPrompt).toContain('Letter 1'); expect(rightPrompt).toContain('Letter 2')
    expect(nextRangePrompt).not.toContain('Letter 1'); expect(nextRangePrompt).not.toContain('Letter 2')
    expect(getProjectDb()!.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    const db = getProjectDb()!
    for (const event of [first, second]) {
      const receipt = ImportRunRepository.getEffectReceipt(runId, 'blueprints', event.batchId)
      expect(receipt).toMatchObject({ state: 'committed', kind: 'chapter-blueprint-range' })
      const effect = receipt!.effectReceipt as { characterSyncOperation: { operationId: string } }
      expect(BlueprintRepository.getCharacterSyncOperation(effect.characterSyncOperation.operationId, db))
        .toMatchObject({ status: 'completed', completionReceipt: expect.anything() })
    }
    expect(db.prepare('SELECT chapter_number,title FROM blueprints ORDER BY chapter_number').all())
      .toEqual(Array.from({ length: 7 }, (_, index) => ({ chapter_number: index + 1, title: `Chapter ${index + 1}` })))
  }, 90_000)

  it('keeps ordinal zero when the real planner splits before the first dispatch', async () => {
    const db = getProjectDb()!
    let initialLogs: Array<{ startChapter: number; endChapter: number }> = []
    let initialAttempts = -1
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const logs = sender.events.flatMap(item => item.kind === 'log' && item.value.key === 'inferring' ? [item.value] : [])
      if (initialAttempts === -1) {
        initialLogs = logs.map(({ startChapter, endChapter }) => ({ startChapter, endChapter }))
        initialAttempts = Number(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get())
      }
      const current = logs.at(-1)
      if (!current) throw new Error('FICTIONAL_INFERENCE_LOG_MISSING')
      return response(Array.from({ length: current.endChapter - current.startChapter + 1 }, (_, index) => current.startChapter + index))
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(splitModel.id), first = await opened(); await ack(first)
    const second = await opened(1); await ack(second)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'refresh' }, modelId: splitModel.id })
    expect(initialLogs[0]).toEqual({ startChapter: 1, endChapter: 5 })
    expect(initialLogs.length).toBeGreaterThan(1)
    expect(initialLogs.at(-1)!.endChapter).toBeLessThan(5)
    // Dispatch reserves its ledger row immediately before fetch; no rejected preflight was reserved.
    expect(initialAttempts).toBe(1)
    const attempts = db.prepare('SELECT run_id,invocation_nonce FROM generation_attempts ORDER BY rowid').all() as Array<{
      run_id: string; invocation_nonce: string
    }>
    expect(attempts[0]).toEqual({ run_id: first.handle.runId, invocation_nonce: 'import:0' })
    expect(attempts.find(item => item.run_id === second.handle.runId)?.invocation_nonce).toBe('import:0')
    expect(fetch).toHaveBeenCalledTimes(attempts.length)
  }, 90_000)

  it.each([
    ['initial', 'content_filter', 'content_filter', 'safety'],
    ['initial', 'fictional_finish', 'unknown', 'unknown'],
    ['repair', 'content_filter', 'content_filter', 'safety'],
    ['repair', 'fictional_finish', 'unknown', 'unknown'],
  ] as const)('preserves %s adapter finish %s without committing', async (phase, providerFinish, normalizedFinish, reason) => {
    const candidate = JSON.stringify({ blueprints: [1, 2, 3, 4, 5].map(blueprint) })
    const outputs = phase === 'repair'
      ? [stream(candidate.slice(0, -1)), stream(candidate, providerFinish)]
      : [stream(candidate, providerFinish)]
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const next = outputs.shift()
      if (!next) throw new Error('UNEXPECTED_INFERENCE')
      return next
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(); await ack(first)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED',
      error: `Blueprint inference failed (${reason}).` })
    const expectedCalls = phase === 'repair' ? 2 : 1
    expect(fetch).toHaveBeenCalledTimes(expectedCalls)
    const db = getProjectDb()!
    const rows = db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all() as Array<{
      attempt_json: string; usage_receipt_json: string
    }>
    expect(rows).toHaveLength(expectedCalls)
    const last = rows.at(-1)!
    expect(JSON.parse(last.attempt_json)).toMatchObject({ status: 'unknown' })
    const receipt = JSON.parse(last.usage_receipt_json) as { result: { finishReason: string; failureCode?: string } }
    expect(receipt.result).toMatchObject({ finishReason: normalizedFinish })
    expect(receipt.result.failureCode).toBeUndefined()
    if (phase === 'repair') expect(JSON.parse(rows[0]!.usage_receipt_json).result.finishReason).toBe('stop')
    // Main receipts currently have no promptBudget; the driver must not invent or duplicate reports.
    expect(sender.events.filter(item => item.kind === 'prompt-budget')).toHaveLength(0)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)).toBeNull()
    expect(db.prepare('SELECT count(*) FROM blueprints').pluck().get()).toBe(0)
  }, 90_000)

  it('replays an unknown adapter finish after a new owner without another request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => stream('Fictional incomplete output', 'fictional_finish'))
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(); await ack(first)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED',
      error: 'Blueprint inference failed (unknown).' })
    const db = getProjectDb()!, attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    expect(attempts).toHaveLength(1)
    const stored = attempts[0] as { attempt_json: string; usage_receipt_json: string }
    expect(JSON.parse(stored.attempt_json)).toMatchObject({ status: 'unknown' })
    expect(JSON.parse(stored.usage_receipt_json).result).toMatchObject({ finishReason: 'unknown' })
    const previous = execution
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-unknown-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    expect(execution.epoch).toBeGreaterThan(previous.epoch)
    sender.events = []
    let settled = false
    const retry = start().finally(() => { settled = true })
    await vi.waitFor(() => expect(settled || sender.events.some(item => item.kind === 'opened')).toBe(true), { timeout: 10_000 })
    const event = sender.events.find((item): item is Progress => item.kind === 'opened')
    if (event) { expect(event.handle).toEqual(first.handle); await ack(event) }
    expect(await retry).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED',
      error: 'Blueprint inference failed (unknown).' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)).toBeNull()
    expect(db.prepare('SELECT count(*) FROM blueprints').pluck().get()).toBe(0)
  }, 90_000)

  it('rejects a missing semantic field at the single-chapter boundary without an unbounded retry', async () => {
    const batches = [[1, 2, 3, 4, 5], [1, 2], [1]]
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const numbers = batches.shift()
      if (!numbers) throw new Error('UNEXPECTED_INFERENCE')
      return stream(JSON.stringify({ blueprints: numbers.map(number => {
        const incomplete: Partial<ReturnType<typeof blueprint>> = blueprint(number)
        delete incomplete.suspenseHook
        return incomplete
      }) }))
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(); await ack(first)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED',
      error: 'Blueprint inference failed (invalid_item).' })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)).toBeNull()
    expect(getProjectDb()!.prepare('SELECT count(*) FROM blueprints').pluck().get()).toBe(0)
  }, 90_000)

  it('rolls back the entire range and checkpoint when the actual blueprint write fails', async () => {
    const db = getProjectDb()!
    db.exec("CREATE TEMP TRIGGER fictional_blueprint_failure BEFORE INSERT ON blueprints WHEN NEW.chapter_number=3 BEGIN SELECT RAISE(ABORT,'fictional storage failure'); END")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response([1, 2, 3, 4, 5]))
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(); await ack(first)
    expect(await flight).toMatchObject({ success: false })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT count(*) FROM blueprints').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM blueprint_character_sync_operations').pluck().get()).toBe(0)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)).toMatchObject({ state: 'prepared' })
    expect(ImportRunRepository.get(runId)?.completedBatches.blueprints ?? []).not.toContain(first.batchId)
  }, 90_000)

  it.each([0, 1])('does not resend an unknown range ordinal %i after takeover', async ordinal => {
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (calls++ === ordinal) throw new TypeError('fetch failed', { cause: Object.assign(new Error('fictional reset'), { code: 'ECONNRESET' }) })
      return response([1, 2, 3, 4, 5], 'length')
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(); await ack(first)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED', error: 'Blueprint inference failed (server_error).' })
    const db = getProjectDb()!, attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    expect(attempts).toHaveLength(ordinal + 1)
    expect(JSON.parse((attempts.at(-1) as { usage_receipt_json: string }).usage_receipt_json).result.failureCode).toBe('NETWORK_ERROR')
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    sender.events = []
    let settled = false
    const retry = start().finally(() => { settled = true })
    await vi.waitFor(() => expect(settled || sender.events.some(item => item.kind === 'opened')).toBe(true), { timeout: 10_000 })
    const event = sender.events.find((item): item is Progress => item.kind === 'opened')
    if (event) { expect(event.handle).toEqual(first.handle); await ack(event) }
    expect(await retry).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED', error: 'Blueprint inference failed (server_error).' })
    expect(fetch).toHaveBeenCalledTimes(ordinal + 1)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)).toBeNull()
  }, 90_000)

  it('does not resend an unknown ordinal after a syntax repair and semantic split', async () => {
    const items = [1, 2, 3, 4, 5].map(number => {
      const item: Partial<ReturnType<typeof blueprint>> = blueprint(number)
      if (number === 1) delete item.suspenseHook
      return item
    })
    const repaired = JSON.stringify({ blueprints: items })
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const ordinal = calls++
      if (ordinal === 0) return stream(repaired.slice(0, -1))
      if (ordinal === 1) return stream(repaired)
      if (ordinal === 2) throw new TypeError('fetch failed', { cause: Object.assign(new Error('fictional reset'), { code: 'ECONNRESET' }) })
      throw new Error('UNEXPECTED_INFERENCE')
    })
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(); await ack(first)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED', error: 'Blueprint inference failed (server_error).' })
    const db = getProjectDb()!, attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    expect(attempts).toHaveLength(3)
    expect(JSON.parse((attempts.at(-1) as { usage_receipt_json: string }).usage_receipt_json).result.failureCode).toBe('NETWORK_ERROR')
    expect(db.prepare('SELECT invocation_nonce FROM generation_attempts ORDER BY rowid').pluck().all()).toEqual(['import:0', 'import:1', 'import:2'])
    expect(fetch).toHaveBeenCalledTimes(3)
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    sender.events = []
    let settled = false
    const retry = start().finally(() => { settled = true })
    await vi.waitFor(() => expect(settled || sender.events.some(item => item.kind === 'opened')).toBe(true), { timeout: 10_000 })
    const event = sender.events.find((item): item is Progress => item.kind === 'opened')
    if (event) { expect(event.handle).toEqual(first.handle); await ack(event) }
    expect(await retry).toMatchObject({ success: false, errorCode: 'GENERATION_REQUEST_FAILED', error: 'Blueprint inference failed (server_error).' })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT count(*) FROM generation_roots').pluck().get()).toBe(1)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)).toBeNull()
  }, 90_000)

  it('fences legacy same-run effect and blueprint writes while opened waits but permits cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response([1, 2, 3, 4, 5]))
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened()
    await expect(invoke('import-generation:execute', { handle: first.handle, execution, ordinal: 0,
      task: { purpose: 'import-chapter-blueprints', output: 'structured-data', messages: [{ role: 'user', content: 'forged' }] } })).rejects.toThrow()
    expect(await dbCall('db:import-run-advance-stage', runId, 'blueprints', 'refresh', execution)).toMatchObject({ success: false })
    expect(await dbCall('db:blueprint-commit-range', { mode: 'replace-range', operationId: `import-blueprints-${runId}-1-5`,
      startChapter: 1, endChapter: 5, blueprints: [1, 2, 3, 4, 5].map(blueprint), generationRunHandle: first.handle }))
      .toMatchObject({ success: false, error: 'Error: GENERATION_OWNER_BUSY' })
    expect(await dbCall('db:blueprint-commit-range', { mode: 'replace-range', operationId: 'fictional-other-operation',
      startChapter: 1, endChapter: 5, blueprints: [1, 2, 3, 4, 5].map(blueprint), generationRunHandle: first.handle }))
      .toMatchObject({ success: false, error: 'Error: GENERATION_OWNER_BUSY' })
    expect(await dbCall('db:blueprint-commit-range', { mode: 'replace-range', operationId: `  import-blueprints-${runId}-1-5  `,
      startChapter: 1, endChapter: 5, blueprints: [1, 2, 3, 4, 5].map(blueprint) }))
      .toMatchObject({ success: false, error: 'Error: GENERATION_OWNER_BUSY' })
    expect(getProjectDb()!.prepare('SELECT count(*) FROM blueprints').pluck().get()).toBe(0)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM blueprint_commit_operations').pluck().get()).toBe(0)
    expect(await dbCall('db:import-run-request-cancel', runId, execution)).toMatchObject({ success: true })
    await ack(first)
    expect(await flight).toMatchObject({ success: false })
    expect(fetch).not.toHaveBeenCalled()
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)).toBeNull()
  }, 90_000)

  it('fences direct sync writes for a committed range while the next range is open', async () => {
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(calls++ === 0 ? [1, 2, 3, 4, 5] : [6, 7]))
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(); await ack(first)
    const second = await opened(1)
    const receipt = ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)
    const effect = receipt?.effectReceipt as { characterSyncOperation?: { operationId?: string } } | undefined
    const operationId = effect?.characterSyncOperation?.operationId
    expect(operationId).toBeTruthy()
    expect(await dbCall('db:blueprint-character-sync-get', operationId)).toMatchObject({ operationId, status: 'completed' })
    const syncBefore = getProjectDb()!.prepare('SELECT * FROM blueprint_character_sync_operations ORDER BY rowid').all()
    expect(await dbCall('db:blueprint-character-sync-complete', operationId)).toMatchObject({ success: false, error: 'Error: GENERATION_OWNER_BUSY' })
    expect(getProjectDb()!.prepare('SELECT * FROM blueprint_character_sync_operations ORDER BY rowid').all()).toEqual(syncBefore)
    await expect(invoke('character-proposal:stage', { source: { kind: 'directory', operationId } })).rejects.toThrow('GENERATION_OWNER_BUSY')
    await ack(second)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'refresh' } })
    expect(fetch).toHaveBeenCalledTimes(2)
  }, 90_000)

  it.each(['prepared', 'sync-stage', 'sync-complete'] as const)('recovers %s range without repeating its model call', async boundary => {
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(calls++ === 0 ? [1, 2, 3, 4, 5] : [6, 7]))
    vi.stubGlobal('fetch', fetch)
    const fault = boundary === 'prepared'
      ? vi.spyOn(ImportRunRepository, 'commitEffectReceipt').mockImplementationOnce(() => { throw new Error('FICTIONAL_COMMIT_INTERRUPT') })
      : boundary === 'sync-stage'
        ? vi.spyOn(CharacterProposalService.prototype, 'stage').mockImplementationOnce(() => { throw new Error('FICTIONAL_SYNC_INTERRUPT') })
        : vi.spyOn(BlueprintRepository, 'completeCharacterSyncOperation').mockImplementationOnce(() => { throw new Error('FICTIONAL_SYNC_INTERRUPT') })
    const flight = start(), first = await opened(); await ack(first)
    const failed = await flight
    expect(failed).toMatchObject(boundary === 'prepared' ? { success: false }
      : { success: false, errorCode: 'GENERATION_REQUEST_FAILED', postCommitSyncBatchId: first.batchId })
    expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore()
    const receipt = ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)
    expect(receipt).toMatchObject({ state: boundary === 'prepared' ? 'prepared' : 'committed' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const rootRows = getProjectDb()!.prepare('SELECT root_action_id FROM generation_roots').all()
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    sender.events = []
    const recovery = start(), next = await opened(); expect(next.batchId).not.toBe(first.batchId); await ack(next)
    expect(await recovery).toMatchObject({ success: true, run: { stage: 'refresh' } })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(getProjectDb()!.prepare('SELECT root_action_id FROM generation_roots').all()).toEqual(rootRows)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)).toMatchObject({ state: 'committed', payload: receipt!.payload, payloadHash: receipt!.payloadHash })
  }, 90_000)

  it.each([null, splitModel.id])('recovers a prepared range in a new view without selecting caller model %s', async callerModel => {
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(calls++ === 0 ? [1, 2, 3, 4, 5] : [6, 7]))
    vi.stubGlobal('fetch', fetch)
    const fault = vi.spyOn(ImportRunRepository, 'commitEffectReceipt').mockImplementationOnce(() => { throw new Error('FICTIONAL_COMMIT_INTERRUPT') })
    const flight = start(), first = await opened(); await ack(first)
    expect(await flight).toMatchObject({ success: false })
    expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore()
    const db = getProjectDb()!, prepared = ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)
    expect(prepared).toMatchObject({ state: 'prepared' })
    const roots = db.prepare('SELECT root_action_id FROM generation_roots').all()
    const attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const oldSession = session
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId
      && normalize(item.canonicalRoot) === normalize(session.projectPath))
    expect(runtime).toBeDefined()
    session = { ...session, leaseId: projectAccess.beginViewSession(runtime!).leaseId }
    expect(session.leaseId).not.toBe(oldSession.leaseId)
    await expect(invoke('import-generation:v1:blueprints', { runId, execution, modelId: callerModel }, oldSession)).rejects.toThrow()
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-view-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    sender.events = []
    const recovery = start(callerModel), next = await opened()
    expect(next.batchId).not.toBe(first.batchId)
    expect(next.handle.rootActionId).toBe(first.handle.rootActionId)
    expect(next.modelId).toBe(model.id)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT root_action_id FROM generation_roots').all()).toEqual(roots)
    const committed = ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)
    expect(committed).toMatchObject({ state: 'committed', payload: prepared!.payload, payloadHash: prepared!.payloadHash })
    await ack(next)
    expect(await recovery).toMatchObject({ success: true, modelId: model.id, run: { stage: 'refresh' } })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(db.prepare('SELECT root_action_id FROM generation_roots').all()).toEqual(roots)
  }, 90_000)

  it('recovers the only prepared range in a new view with a null caller model and no new request', async () => {
    const db = getProjectDb()!
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response([1, 2])); vi.stubGlobal('fetch', fetch)
    const fault = vi.spyOn(ImportRunRepository, 'commitEffectReceipt').mockImplementationOnce(() => { throw new Error('FICTIONAL_COMMIT_INTERRUPT') })
    const flight = start(), first = await opened(); await ack(first)
    const failed = await flight
    expect(failed).toMatchObject({ success: false })
    if (!fault.mock.calls.length) throw new Error(`FICTIONAL_SINGLE_PREPARE:${failed.success ? 'UNEXPECTED_SUCCESS' : failed.errorCode}`)
    expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore()
    const prepared = ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)
    expect(prepared).toMatchObject({ state: 'prepared' })
    const attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const roots = db.prepare('SELECT root_action_id FROM generation_roots').all()
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId
      && normalize(item.canonicalRoot) === normalize(session.projectPath))
    expect(runtime).toBeDefined()
    const oldSession = session
    session = { ...session, leaseId: projectAccess.beginViewSession(runtime!).leaseId }
    expect(session.leaseId).not.toBe(oldSession.leaseId)
    await expect(invoke('import-generation:v1:blueprints', { runId, execution, modelId: null }, oldSession)).rejects.toThrow()
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-view-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    sender.events = []
    const result = await start(null)
    expect(result).toMatchObject({ success: true, replayed: true, modelId: model.id, run: { stage: 'refresh' },
      handle: { runId: first.handle.runId, rootActionId: first.handle.rootActionId } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT root_action_id FROM generation_roots').all()).toEqual(roots)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId))
      .toMatchObject({ state: 'committed', payload: prepared!.payload, payloadHash: prepared!.payloadHash })
    expect(sender.events.some(item => ['opened', 'range-committed', 'range-synced'].includes(item.kind))).toBe(false)
  }, 90_000)

  it('repairs a missing advance after both committed ranges without regenerating or projecting them again', async () => {
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(calls++ === 0 ? [1, 2, 3, 4, 5] : [6, 7]))
    vi.stubGlobal('fetch', fetch)
    const advance = vi.spyOn(ImportRunRepository, 'advanceStage').mockImplementationOnce(() => { throw new Error('FICTIONAL_ADVANCE_INTERRUPT') })
    const flight = start(), first = await opened(); await ack(first)
    const second = await opened(1); await ack(second)
    expect(await flight).toMatchObject({ success: false })
    expect(advance).toHaveBeenCalledTimes(1); advance.mockRestore()
    expect(ImportRunRepository.get(runId)).toMatchObject({ status: 'failed', stage: 'blueprints' })
    const firstReceipt = ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)
    const secondReceipt = ImportRunRepository.getEffectReceipt(runId, 'blueprints', second.batchId)
    expect(firstReceipt).toMatchObject({ state: 'committed' }); expect(secondReceipt).toMatchObject({ state: 'committed' })
    const previousExecution = execution
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-advance-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    expect(execution.owner).toBe('fictional-advance-recovery'); expect(execution.epoch).toBeGreaterThan(previousExecution.epoch)
    sender.events = []
    expect(await start()).toMatchObject({ success: true, run: { stage: 'refresh' }, replayed: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)).toEqual(firstReceipt)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', second.batchId)).toEqual(secondReceipt)
    expect(sender.events.some(item => ['opened', 'range-committed', 'range-synced'].includes(item.kind))).toBe(false)
    expect(sender.events.some(item => item.kind === 'log' || item.kind === 'prompt-budget')).toBe(false)
    expect(sender.events.flatMap(item => item.kind === 'progress' ? [item.progress] : [])).toEqual([71, 99, 100])
  }, 90_000)

  it('reads completed history without reconstructing execution or writing sync receipts', async () => {
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(calls++ === 0 ? [1, 2, 3, 4, 5] : [6, 7]))
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(); await ack(first)
    const second = await opened(1); await ack(second)
    expect(await flight).toMatchObject({ success: true, run: { stage: 'refresh' } })
    // Earlier stages were deliberately bypassed by this fixture; completion itself is real.
    ImportRunRepository.completeBatch(runId, 'refresh', 'done', executionLease)
    expect(ImportRunRepository.complete(runId, executionLease)).toMatchObject({ status: 'completed', stage: 'completed' })
    const db = getProjectDb()!
    const run = db.prepare('SELECT * FROM import_runs WHERE id=?').get(runId)
    const receipts = db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()
    const attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const sync = db.prepare('SELECT * FROM blueprint_character_sync_operations ORDER BY rowid').all()
    const renew = vi.spyOn(ImportRunRepository, 'renewExecution')
    const completeSync = vi.spyOn(BlueprintRepository, 'completeCharacterSyncOperation')
    sender.events = []
    expect(await start()).toMatchObject({ success: true, replayed: true, execution: null, run: { status: 'completed', stage: 'completed' } })
    expect(renew).not.toHaveBeenCalled(); expect(completeSync).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM import_runs WHERE id=?').get(runId)).toEqual(run)
    expect(db.prepare('SELECT * FROM import_run_receipts ORDER BY rowid').all()).toEqual(receipts)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT * FROM blueprint_character_sync_operations ORDER BY rowid').all()).toEqual(sync)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sender.events.some(item => ['opened', 'range-committed', 'range-synced'].includes(item.kind))).toBe(false)
  }, 90_000)

  it('rejects a changed source after opened without any model request or receipt', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response([1, 2, 3, 4, 5]))
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(), db = getProjectDb()!
    db.prepare("UPDATE project_core SET world_setting='Changed fictional source' WHERE id='main'").run()
    await ack(first)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_SOURCE_CHANGED' })
    expect(fetch).not.toHaveBeenCalled()
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)).toBeNull()
    expect(db.prepare('SELECT count(*) FROM generation_attempts').pluck().get()).toBe(0)
  }, 90_000)

  it('rechecks the original source guard before committing a prepared range', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response([1, 2, 3, 4, 5]))
    vi.stubGlobal('fetch', fetch)
    const fault = vi.spyOn(ImportRunRepository, 'commitEffectReceipt').mockImplementationOnce(() => { throw new Error('FICTIONAL_COMMIT_INTERRUPT') })
    const flight = start(), first = await opened(); await ack(first)
    expect(await flight).toMatchObject({ success: false })
    expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore()
    const db = getProjectDb()!, receipt = ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)
    expect(receipt).toMatchObject({ state: 'prepared' })
    db.prepare("UPDATE project_core SET world_setting='Changed fictional source' WHERE id='main'").run()
    executionLease = ImportRunRepository.startOrResume(runId, 'fictional-recovery', Date.now(), 60_000).execution
    execution = { owner: executionLease.owner, epoch: executionLease.epoch }
    expect(await start()).toMatchObject({ success: false, errorCode: 'GENERATION_IMPORT_EFFECT_SOURCE_CHANGED' })
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)).toEqual(receipt)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT count(*) FROM blueprints').pluck().get()).toBe(0)
  }, 90_000)

  it('rejects extra request fields and a different sender without dispatch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response([1, 2, 3, 4, 5]))
    vi.stubGlobal('fetch', fetch)
    await expect(invoke('import-generation:v1:blueprints', { runId, execution, modelId: model.id, task: {} })).rejects.toThrow()
    await expect(invoke('import-generation:v1:blueprints', { runId, execution, modelId: model.id }, { ...session, leaseId: 'fictional-stale' })).rejects.toThrow()
    const flight = start(), first = await opened()
    await expect(ack(first, new Sender())).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    sender.destroy()
    expect(await flight).toMatchObject({ success: false })
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)).toBeNull()
  }, 90_000)

  it('does not let the expired owner mutate its real successor while opened waits', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response([1, 2, 3, 4, 5]))
    vi.stubGlobal('fetch', fetch)
    const flight = start(), first = await opened(), db = getProjectDb()!
    // Only expiry is injected; startOrResume establishes the successor authority.
    db.prepare('UPDATE import_runs SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, runId)
    const successor = ImportRunRepository.startOrResume(runId, 'fictional-successor', Date.now(), 60_000).execution
    const before = db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at,status,stage,cancel_requested,last_error FROM import_runs WHERE id=?').get(runId)
    expect(before).toMatchObject({ execution_owner: successor.owner, execution_epoch: successor.epoch, status: 'running', stage: 'blueprints' })
    await expect(ack(first)).resolves.toEqual({ version: 1 })
    expect(await flight).toMatchObject({ success: false, errorCode: 'IMPORT_RUN_EXECUTION_STALE' })
    expect(db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at,status,stage,cancel_requested,last_error FROM import_runs WHERE id=?').get(runId)).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)).toBeNull()
  }, 90_000)

  it.each(['sender', 'close', 'cancel'] as const)('waits for a physically in-flight model request after %s', async stop => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { entered(); await gate; return response([1, 2, 3, 4, 5]) })
    vi.stubGlobal('fetch', fetch)
    let settled = false
    const flight = start().finally(() => { settled = true }), first = await opened(); await ack(first); await started
    let closed = false
    const runtime = projectRuntimeHost.getOpenRuntimes().find(item => item.projectId === session.projectId)!
    expect(runtime).toBeDefined()
    const databasePath = path.resolve(getProjectDatabasePath(session.projectPath))
    const relative = path.relative(path.resolve(root), databasePath)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || fs.lstatSync(databasePath).isSymbolicLink() || normalize(fs.realpathSync.native(databasePath)) !== normalize(databasePath)) {
      throw new Error('FIXTURE_DATABASE_PATH_UNSAFE')
    }
    const closing = stop === 'close' ? projectRuntimeHost.requestClose(runtime).then(() => { closed = true }) : undefined
    try {
      if (stop === 'sender') sender.destroy()
      if (stop === 'cancel') expect(await dbCall('db:import-run-request-cancel', runId, execution)).toMatchObject({ success: true })
      await new Promise(resolve => setTimeout(resolve, 75))
      expect(settled).toBe(false)
      if (closing) expect(closed).toBe(false)
      expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)).toBeNull()
    } finally { releaseFetch!(); await Promise.allSettled([flight, ...(closing ? [closing] : [])]) }
    if (closing) expect(closed).toBe(true)
    expect(await flight).toMatchObject({ success: false, errorCode: 'GENERATION_ACTION_CANCELLED' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const reopened = stop === 'close' ? new Database(databasePath, { readonly: true, fileMustExist: true }) : null
    try {
      const database = reopened ?? getProjectDb()!
      expect(database.prepare('SELECT status,execution_owner,lease_expires_at,cancel_requested FROM import_runs WHERE id=?').get(runId))
        .toMatchObject({ status: 'cancelled', execution_owner: '', lease_expires_at: 0, cancel_requested: 1 })
    } finally { reopened?.close() }
  }, 90_000)

  it('preserves a settled hard network error after sender destruction', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('fictional reset'), { code: 'ECONNRESET' }) }) })
    vi.stubGlobal('fetch', fetch)
    const original = GenerationRunRepository.prototype.settle
    const settle = vi.spyOn(GenerationRunRepository.prototype, 'settle').mockImplementation(function (this: GenerationRunRepository, ...args) {
      const receipt = original.apply(this, args)
      if (receipt.attempt.status === 'unknown') { expect(receipt.failureCode).toBe('NETWORK_ERROR'); sender.destroy() }
      return receipt
    })
    const flight = start(), first = await opened(); await ack(first)
    expect(await flight).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
    expect(settle).toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId!)).toBeNull()
    expect(getProjectDb()!.prepare('SELECT status,execution_owner,lease_expires_at FROM import_runs WHERE id=?').get(runId))
      .toMatchObject({ status: 'failed', execution_owner: '', lease_expires_at: 0 })
  }, 90_000)

  it('drains an ignored-abort provider after the real active deadline and preserves its hard failure', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { entered(); await gate; return response([1, 2, 3, 4, 5]) })
    vi.stubGlobal('fetch', fetch)
    let settled = false
    const flight = start().finally(() => { settled = true }), first = await opened(), db = getProjectDb()!
    const repository = new GenerationRunRepository(() => db), budget = repository.budget(first.handle.rootActionId)
    // Keep the real timer and policy; only consume fictional active time before dispatch.
    db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?')
      .run(budget.policy.maxActiveElapsedMs - 1500, first.handle.rootActionId)
    await ack(first); await started
    try {
      await vi.waitFor(() => {
        const row = db.prepare('SELECT usage_receipt_json FROM generation_attempts ORDER BY rowid DESC LIMIT 1').get() as { usage_receipt_json: string } | undefined
        expect(row && JSON.parse(row.usage_receipt_json).result?.failureCode).toBe('ROOT_BUDGET_EXHAUSTED')
      }, { timeout: 10_000 })
      sender.destroy()
      await new Promise(resolve => setTimeout(resolve, 75))
      expect(settled).toBe(false)
      expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)).toBeNull()
    } finally { releaseFetch!(); await Promise.allSettled([flight]) }
    expect(await flight).toMatchObject({ success: false, errorCode: 'ROOT_BUDGET_EXHAUSTED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(db.prepare('SELECT status,execution_owner,lease_expires_at FROM import_runs WHERE id=?').get(runId))
      .toMatchObject({ status: 'failed', execution_owner: '', lease_expires_at: 0 })
  }, 90_000)

  it.each([false, true])('preserves a provider context-length error after settle; sender destroyed=%s', async destroySender => {
    const body = JSON.stringify({ error: { message: 'maximum context length is 32768 tokens; fictional-private-body' } })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    const original = GenerationRunRepository.prototype.settle
    const settle = vi.spyOn(GenerationRunRepository.prototype, 'settle').mockImplementation(function (this: GenerationRunRepository, ...args) {
      const receipt = original.apply(this, args)
      expect(receipt.failureCode).toBe('GENERATION_CONTEXT_LENGTH_EXCEEDED')
      if (destroySender) sender.destroy()
      return receipt
    })
    const flight = start(), first = await opened(); await ack(first)
    const result = await flight
    expect(result).toMatchObject({ success: false, errorCode: 'GENERATION_CONTEXT_LENGTH_EXCEEDED',
      error: knownAppErrorMessage('en-US', 'GENERATION_CONTEXT_LENGTH_EXCEEDED') })
    expect(JSON.stringify(result)).not.toContain('fictional-private-body')
    expect(settle).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce()
    const db = getProjectDb()!
    const rows = db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all() as Array<{
      attempt_json: string; usage_receipt_json: string
    }>
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.attempt_json)).toMatchObject({ status: 'unknown' })
    expect(JSON.parse(rows[0]!.usage_receipt_json).result).toMatchObject({ finishReason: null, failureCode: 'GENERATION_CONTEXT_LENGTH_EXCEEDED' })
    expect(ImportRunRepository.getEffectReceipt(runId, 'blueprints', first.batchId)).toBeNull()
    expect(db.prepare('SELECT count(*) FROM blueprints').pluck().get()).toBe(0)
    expect(sender.events.some(item => item.kind === 'range-committed' || item.kind === 'range-synced')).toBe(false)
    expect(db.prepare('SELECT status,execution_owner,lease_expires_at FROM import_runs WHERE id=?').get(runId))
      .toMatchObject({ status: 'failed', execution_owner: '', lease_expires_at: 0 })
  }, 90_000)
})

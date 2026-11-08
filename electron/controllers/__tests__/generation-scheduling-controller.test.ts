import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { WorkflowBatchChannels, WorkflowBatchReference, WorkflowBatchReceipt } from '../../../src/shared/workflow-batch-contract'
import type { GenerationOwnerChannels } from '../../../src/shared/generation-owner-contract'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))

import { registerGenerationController } from '../generation-controller'
import { createProjectDatabase, closeProjectDatabase } from '../../database'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { MainGenerationScheduler } from '../../services/generation-scheduler'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'
import { textHash } from '../../repositories/generation-run-repository'
import { openLanceDatabase } from '../../lance-database'
import { withKnowledgeSourceGate } from '../../services/knowledge-source-gate'

const model: ModelProfile = { id: 'fictional-scheduled', name: 'Fictional scheduled model', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'fictional-only', maxTokens: 2048,
  temperature: 0.7, purposes: ['generation'] }
const scheduler = new MainGenerationScheduler({ global: 2, provider: 2, credential: 2, model: 2, project: 1,
  maxQueued: 32, maxQuarantined: 2, interactiveBurst: 1 }, 108)
const prose = (marker: string) => `${marker} reached the harbor before dawn. A courier stood beside the iron gate, holding a sealed letter. She checked his badge against the number in her notebook and asked him to wait. The tide had carried a broken crate onto the landing. Inside it lay a brass key wrapped in blue cloth. She recorded the discovery without opening the letter. Across the channel, a small ferry sounded its bell. She secured the gate, placed the key in her satchel, and followed the courier toward the customs house.`
const review = JSON.stringify({ summary: 'Fictional review', items: [{ category: 'continuity', severity: 'pass',
  description: 'Compared the supplied fictional draft and plan.' }], goalReviews: [] })
class Sender extends EventEmitter {
  send = vi.fn()
  private destroyed = false
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}
interface Book { project: ReturnType<typeof projectAccess.createProject>; runtime: ProjectRuntime; session: ProjectSessionContext; marker: string }
let root: string, sender: Sender
let release: (() => void) | undefined

beforeAll(() => registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
  loadModel: () => model, applyProxyConfig: () => {}, scheduler }))
beforeEach(() => {
  const base = path.resolve('.runtime/.cache/gsc')
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'f-'))
  mocks.globalRoot = path.join(root, 'global')
  fs.mkdirSync(mocks.globalRoot)
  sender = new Sender()
  expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0, subjects: 0 })
})
afterEach(async () => {
  release?.()
  release = undefined
  sender?.destroy()
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) await projectRuntimeHost.requestClose(runtime)
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  const base = path.resolve('.runtime/.cache/gsc'), absolute = path.resolve(root)
  const relative = path.relative(base, absolute)
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    || fs.lstatSync(absolute).isSymbolicLink() || normalize(fs.realpathSync.native(base)) !== normalize(base)
    || normalize(fs.realpathSync.native(absolute)) !== normalize(absolute)) throw new Error('FIXTURE_CLEANUP_UNSAFE')
  fs.rmSync(absolute, { recursive: true, force: true })
})
function book(name: string, marker: string): Book {
  const project = projectAccess.createProject(root, name)
  createProjectDatabase(project.rootPath)
  const runtime = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareRetainedOpen(project))
  const lease = projectAccess.beginViewSession(runtime)
  runtime.database.prepare(`INSERT INTO project_core(id,project_name,core_outline,global_guidance,writing_language,words_per_chapter,total_chapters)
    VALUES('main',?,?,?,'en-US',100,1)`).run(marker, marker, `Preserve ${marker} fictional author facts.`)
  runtime.database.prepare('INSERT INTO blueprints(chapter_number,title) VALUES(1,?)').run(`${marker} letter`)
  return { project, runtime, marker, session: { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId } }
}
type TestedChannels = WorkflowBatchChannels & GenerationOwnerChannels
function call<C extends keyof TestedChannels>(channel: C, arg: TestedChannels[C]['args'][0], session?: ProjectSessionContext) {
  return mocks.handlers.get(channel)!({ sender }, arg, ...(session ? [{ ...session }] : [])) as Promise<TestedChannels[C]['return']>
}
function start(value: Book) {
  return call('workflow-batch:v2:start', { operationKey: randomUUID(), modelId: model.id, reviewModelId: model.id, uiLocale: 'en-US',
    intent: { mode: 'draft_review', range: { startChapter: 1, endChapter: 1 }, targetUnits: 100 }, authorInputs: [] }, value.session)
}
async function finished(reference: WorkflowBatchReference, state: string): Promise<WorkflowBatchReceipt> {
  let receipt!: WorkflowBatchReceipt
  await vi.waitFor(async () => {
    receipt = await call('workflow-batch:v2:read-receipt', { reference })
    expect(receipt.task.state).toBe(state)
  }, { timeout: 20_000 })
  return receipt
}
function transport() {
  let resolve!: () => void
  const gate = new Promise<void>(yes => { resolve = yes })
  release = () => { resolve() }
  const arrivals: string[] = []
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const prompt = String(init?.body ?? '')
    const marker = ['BOOK_ALPHA', 'BOOK_BETA', 'BOOK_GAMMA'].find(value => prompt.includes(value))
    if (!marker) throw new Error('FICTIONAL_BOOK_SOURCE_MISSING')
    arrivals.push(marker)
    await gate
    const content = prompt.includes('Prepare a short chapter execution outline, not prose.')
      ? `Deliver the ${marker} letter.` : prompt.includes('[Strict evidence-anchor constraint]') ? review : prose(marker)
    return { ok: true, body: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`
        + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n'
        + 'data: [DONE]\n\n'))
      controller.close()
    } }) }
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, arrivals, release: () => resolve() }
}
async function seedKnowledge(value: Book) {
  const connection = await openLanceDatabase(path.join(value.runtime.projectStorageRoot, 'lancedb'))
  try {
    const chunks = await connection.createTable('chunks', [{ id: 'fictional-chunk', docId: 'fictional-document',
      text: `${value.marker} fictional harbor knowledge.`, fileName: 'fictional-notes.md', chunkIndex: 0,
      totalChunks: 1, corpusKind: 'project-knowledge' }])
    chunks.close()
    const documents = await connection.createTable('documents', [{ id: 'fictional-document', fileName: 'fictional-notes.md',
      chunkCount: 1, corpusKind: 'project-knowledge' }])
    documents.close()
  } finally { connection.close() }
}
async function changeKnowledge(value: Book) {
  await withKnowledgeSourceGate(value.runtime.projectStorageRoot, async () => {
    const connection = await openLanceDatabase(path.join(value.runtime.projectStorageRoot, 'lancedb'))
    try {
      const chunks = await connection.openTable('chunks')
      try { await chunks.update({ where: "id = 'fictional-chunk'", values: { text: 'Changed fictional passage while queued.' } }) }
      finally { chunks.close() }
    } finally { connection.close() }
  })
}

describe('registered generation scheduling across captured runtimes', () => {
  it('preserves the public root-cancellation code while an ordinary execution is queued', async () => {
    const wire = transport()
    const a = book('A', 'BOOK_ALPHA'), startedA = await start(a)
    await vi.waitFor(() => expect(wire.arrivals).toEqual(['BOOK_ALPHA']))
    const b = book('B', 'BOOK_BETA'), startedB = await start(b)
    await vi.waitFor(() => expect(wire.arrivals).toEqual(['BOOK_ALPHA', 'BOOK_BETA']))
    const c = book('C', 'BOOK_GAMMA')
    const prompt = 'BOOK_GAMMA fictional prompt.'
    const authorInputs = [{ id: 'draft:target-units', text: '100' }]
    const preparation = await call('generation:prepare-draft-context', { chapterNumber: 1, modelId: model.id,
      promptKeys: ['first_chapter_draft'], skillStages: [], authorInputs, query: c.marker, selectedDraftIds: [] }, c.session)
    const view = await call('generation:begin', { operation: 'chapter-draft', uiActionNonce: randomUUID(), modelId: model.id,
      chapterNumber: 1, selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'],
      skillStages: [], output: 'visible-text', authorInputs, selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6],
      preparationId: preparation.preparationId, materialDecision: {
        version: 1, verdict: 'admitted', promptHash: textHash(prompt),
        capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 },
        coverage: { required: 1, included: 1, complete: true },
        included: [{ sourceId: 'author:required', revision: 1, contentHash: 'a'.repeat(64), category: 'author', required: true, units: 12 }],
        omitted: [],
      } }, c.session)
    const executing = call('generation:execute', { handle: view.handle, invocationNonce: 'fictional-queued-call',
      task: { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: prompt }] } }, c.session)
    const rejected = expect(executing).rejects.toThrow('GENERATION_ACTION_CANCELLED')
    await vi.waitFor(() => expect(scheduler.getStats()).toMatchObject({ occupied: 2, queued: 1 }))
    expect(c.runtime.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
    expect((await call('generation:cancel', view.handle, c.session)).status).toBe('cancelled')
    await rejected
    expect(await call('generation:read', view.handle, c.session))
      .toMatchObject({ status: 'cancelled', ledger: { physicalRequests: 0, blockedCode: null } })
    expect(scheduler.getStats()).toMatchObject({ occupied: 2, queued: 0 })
    wire.release()
    await Promise.all([finished(startedA.reference!, 'waiting_review'), finished(startedB.reference!, 'waiting_review')])
    expect(wire.fetch).toHaveBeenCalledTimes(6)
    expect(wire.arrivals).not.toContain('BOOK_GAMMA')
    await vi.waitFor(() => expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0, subjects: 0 }))
  })

  it.each(['cancel', 'source-change', 'knowledge-change'] as const)('shares two permits and refuses queued third-book %s without an attempt', async action => {
    const wire = transport()
    const a = book('A', 'BOOK_ALPHA'), startedA = await start(a)
    await vi.waitFor(() => expect(wire.arrivals).toEqual(['BOOK_ALPHA']))
    const b = book('B', 'BOOK_BETA'), startedB = await start(b)
    await vi.waitFor(() => expect(wire.arrivals).toEqual(['BOOK_ALPHA', 'BOOK_BETA']))
    expect(scheduler.getStats()).toMatchObject({ occupied: 2, queued: 0 })
    const c = book('C', 'BOOK_GAMMA')
    if (action === 'knowledge-change') await seedKnowledge(c)
    const startedC = await start(c)
    await vi.waitFor(() => expect(scheduler.getStats()).toMatchObject({ occupied: 2, queued: 1 }))
    const attempts = (value: Book) => value.runtime.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()
    expect(attempts(a)).toBe(1)
    expect(attempts(b)).toBe(1)
    expect(attempts(c)).toBe(0)
    expect(wire.fetch).toHaveBeenCalledTimes(2)
    if (action === 'cancel') {
      const cancelled = await call('workflow-batch:v2:cancel', { reference: startedC.reference! })
      expect(cancelled.receipt.task.state).toBe('cancelled')
      await vi.waitFor(() => expect(scheduler.getStats().queued).toBe(0))
    } else if (action === 'source-change') {
      c.runtime.database.prepare("UPDATE project_core SET core_outline='Changed queued fictional source' WHERE id='main'").run()
    } else {
      const snapshots = c.runtime.database.prepare("SELECT json_extract(binding_json,'$.sourceManifest.knowledgeSnapshot') FROM generation_runs WHERE json_type(binding_json,'$.sourceManifest.knowledgeSnapshot')='object'").pluck().all() as string[]
      expect(snapshots).toHaveLength(1)
      expect(JSON.parse(snapshots[0]!)).toMatchObject({ storageState: 'present', state: 'stored',
        items: [{ chunkId: 'fictional-chunk', text: 'BOOK_GAMMA fictional harbor knowledge.' }] })
      await changeKnowledge(c)
    }
    wire.release()
    const [receiptA, receiptB] = await Promise.all([
      finished(startedA.reference!, 'waiting_review'), finished(startedB.reference!, 'waiting_review'),
    ])
    if (action !== 'cancel') {
      const rejected = await finished(startedC.reference!, 'blocked')
      expect(rejected.task.blockedCode).toMatch(action === 'knowledge-change' ? /KNOWLEDGE_SOURCE_STALE/u : /SOURCE_CHANGED/u)
      expect(rejected.steps.every(step => step.effect === null)).toBe(true)
      expect(c.runtime.database.prepare('SELECT blocked_code FROM generation_roots').pluck().all())
        .not.toContain('GENERATION_STORAGE_FAILED')
    }
    for (const [value, receipt] of [[a, receiptA], [b, receiptB]] as const) {
      expect(receipt.task.projectId).toBe(value.project.projectId)
      expect(receipt.steps).toHaveLength(6)
      expect(receipt.steps.every(step => step.effect !== null)).toBe(true)
      expect(receipt.attempts).toHaveLength(3)
      expect(receipt.attempts.map(attempt => attempt.status)).toEqual(['settled', 'settled', 'settled'])
      const chapter = receipt.chapters[0]!
      expect(chapter.draftSave).toMatchObject({ kind: 'current', receipt: { content: prose(value.marker), contentHash: textHash(prose(value.marker)) } })
      expect(chapter.review).toMatchObject({ success: true, kind: 'review', source: { content: prose(value.marker), chapterNumber: 1 } })
      expect(value.runtime.database.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
      expect(value.runtime.database.prepare('SELECT COUNT(*) FROM reviews').pluck().get()).toBe(1)
    }
    expect(attempts(c)).toBe(0)
    expect(c.runtime.database.prepare('SELECT COUNT(*) FROM workflow_batch_effects').pluck().get()).toBe(0)
    expect(wire.arrivals.filter(marker => marker === 'BOOK_ALPHA')).toHaveLength(3)
    expect(wire.arrivals.filter(marker => marker === 'BOOK_BETA')).toHaveLength(3)
    expect(wire.arrivals).not.toContain('BOOK_GAMMA')
    expect(wire.fetch).toHaveBeenCalledTimes(6)
    await vi.waitFor(() => expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0, subjects: 0 }))
  })
})

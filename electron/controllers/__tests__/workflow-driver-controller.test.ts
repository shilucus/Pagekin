import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { BeginGenerationRequest, GenerationOwnerChannels } from '../../../src/shared/generation-owner-contract'
import type { StartWorkflowDriverRequest, WorkflowDriverChannels, WorkflowDriverReference, WorkflowDriverReceipt } from '../../../src/shared/workflow-driver-contract'
import { draftShortOutlineTask } from '../../../src/shared/draft-short-outline'
import { textHash } from '../../repositories/generation-run-repository'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))

import { registerGenerationController } from '../generation-controller'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'
import { exportPortableProject } from '../../services/project-archive-service'
import { restorePortableProject } from '../../services/project-restore-service'

type Channels = WorkflowDriverChannels & GenerationOwnerChannels
const model: ModelProfile = { id: 'fictional-driver', name: 'Synthetic driver model', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 1024,
  temperature: 0.7, purposes: ['generation'] }
class Sender extends EventEmitter {
  send = vi.fn()
  private destroyed = false
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}
let root: string, session: ProjectSessionContext, sender: Sender, runtime: ProjectRuntime
let project: ReturnType<typeof projectAccess.createProject>
const prose = 'Fictional prose: she put the letter on the desk and walked to the harbor.'
let retirementGuard: (runtime: ProjectRuntime) => boolean

beforeAll(() => {
  const register = vi.spyOn(projectRuntimeHost, 'registerRetirementGuard')
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
    loadModel: () => model, applyProxyConfig: () => {} })
  retirementGuard = register.mock.calls[0]![0]
  register.mockRestore()
})
beforeEach(() => {
  const base = path.resolve('.runtime/.cache/wdi')
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'f-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  project = projectAccess.createProject(root, 'A')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  runtime = projectRuntimeHost.getActiveView()!
  getProjectDb()!.exec("INSERT INTO project_core(id,project_name,global_guidance,writing_language) VALUES('main','Fictional driver A','Preserve fictional author facts','en-US'); INSERT INTO blueprints(chapter_number,title) VALUES(1,'Fictional letter')")
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: projectAccess.beginSession(project).leaseId }
  sender = new Sender()
})
afterEach(async () => {
  sender?.destroy()
  for (const opened of projectRuntimeHost.getOpenRuntimes()) await projectRuntimeHost.requestClose(opened)
  closeProjectDatabase(); projectAccess.invalidateCurrentSession()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  const base = path.resolve('.runtime/.cache/wdi'), absolute = path.resolve(root)
  if (path.relative(base, absolute).startsWith('..') || fs.lstatSync(absolute).isSymbolicLink()) throw new Error('FIXTURE_CLEANUP_UNSAFE')
  fs.rmSync(absolute, { recursive: true, force: true })
})
function call<C extends keyof Channels>(channel: C, arg: Channels[C]['args'][0], caller = sender, view?: ProjectSessionContext) {
  return mocks.handlers.get(channel)!({ sender: caller }, arg, ...(view ? [{ ...view }] : [])) as Promise<Channels[C]['return']>
}
async function prepared(): Promise<StartWorkflowDriverRequest> {
  const authorInputs = [{ id: 'draft:target-units', text: '10' }]
  const context = await call('workflow-driver:v1:prepare-context', { request: {
    chapterNumber: 1, modelId: model.id, promptKeys: ['first_chapter_draft'], skillStages: [], authorInputs,
    query: 'Fictional letter', selectedDraftIds: [],
  } }, sender, session)
  const outlineTask = draftShortOutlineTask('en-US', 'Arrange the supplied fictional first-chapter material.')
  const baseDraftTask = { purpose: 'chapter-draft', output: 'visible-text' as const,
    budgetDemand: { kind: 'draft-units' as const, writingLanguage: 'en-US' as const, requestedUnits: 10, segmentable: true },
    messages: [{ role: 'user' as const, content: 'Write the fictional first chapter from the supplied material.' }] }
  const selection: BeginGenerationRequest = { operation: 'chapter-draft', chapterNumber: 1, uiActionNonce: randomUUID(),
    modelId: model.id, promptKeys: ['first_chapter_draft'], skillStages: [], authorInputs,
    selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6],
    output: 'visible-text', preparationId: context.preparationId, materialDecision: {
      version: 1, verdict: 'admitted', promptHash: textHash(baseDraftTask.messages[0]!.content),
      shortOutlinePromptHash: textHash(outlineTask.messages[0]!.content),
      capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 },
      coverage: { required: 1, included: 1, complete: true },
      included: [{ sourceId: 'author:required', revision: 1, contentHash: 'a'.repeat(64), category: 'author', required: true, units: 12 }], omitted: [],
    } }
  return { operationKey: randomUUID(), selection, recipe: { schemaVersion: 1, writingLanguage: 'en-US', outlineTask, baseDraftTask } }
}
function stream(options: { hold?: boolean; finishReason?: 'stop' | 'unknown'; includeUsage?: boolean } = {}) {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let requests = 0
  const fetch = vi.fn(async () => {
    const ordinal = requests++
    if (ordinal === 0) { entered(); if (options.hold) await gate }
    const content = ordinal === 0 ? 'Fictional outline: deliver the letter.' : prose
    return { ok: true, body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: options.finishReason ?? 'stop' }] })}\n\n`
        + (options.includeUsage ? 'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":12,"total_tokens":62}}\n\n' : '')
        + 'data: [DONE]\n\n'))
      controller.close()
    } }) }
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, started, release }
}
async function terminal(reference: WorkflowDriverReference): Promise<WorkflowDriverReceipt> {
  let result: WorkflowDriverReceipt | undefined
  await vi.waitFor(async () => {
    result = await call('workflow-driver:v1:read-receipt', { reference })
    expect(result.task.state).not.toBe('ready')
  }, { timeout: 15_000 })
  return result!
}

describe('workflow driver registered main IPC and actual native effects', () => {
  it('keeps a live driver without writing and allows its completed receipt after legacy handoff', async () => {
    const transport = stream({ hold: true, includeUsage: true })
    try {
      const issued = await call('workflow-driver:v1:start', await prepared(), sender, session)
      await transport.started
      const before = runtime.database.prepare('SELECT total_changes()').pluck().get()
      expect(retirementGuard(runtime)).toBe(false)
      expect(runtime.database.prepare('SELECT total_changes()').pluck().get()).toBe(before)
      transport.release()
      expect((await terminal(issued.reference!)).task.state).toBe('waiting_review')
      expect(runtime.database.prepare("SELECT json_extract(attempt_json,'$.status') FROM generation_attempts").pluck().all()).toEqual(['settled', 'settled'])
      await vi.waitFor(() => expect(retirementGuard(runtime)).toBe(true))
      const list = mocks.handlers.get('generation:list')!
      await list({ sender }, { ...session })
      expect(retirementGuard(runtime)).toBe(true)
      expect((await call('workflow-driver:v1:read-receipt', { reference: issued.reference! })).task.state).toBe('waiting_review')
    } finally { transport.release() }
  })
  it.each(['paused', 'blocked', 'waiting_review'] as const)('reads restored %s history without issuing a copied execution capability', async state => {
    const request = await prepared(), transport = stream({ hold: state === 'paused', finishReason: state === 'blocked' ? 'unknown' : 'stop' })
    const issued = await call('workflow-driver:v1:start', request, sender, session)
    try {
      if (state === 'paused') {
        await transport.started
        await call('workflow-driver:v1:pause', { reference: issued.reference! })
        transport.release()
      } else await terminal(issued.reference!)
      await projectRuntimeHost.requestClose(runtime)
      const archivePath = path.join(root, 'h.ainovel'), restoredRoot = path.join(root, 'C')
      await exportPortableProject({ sourceProjectRoot: project.rootPath, projectSession: session,
        targetArchivePath: archivePath, attemptParentPath: root,
        assertCurrentContext: context => { expect(context).toEqual(session); expect(runtime.database.open).toBe(false) },
        assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) } })
      await restorePortableProject({ archivePath, targetProjectRoot: restoredRoot })
      const copied = projectAccess.probeExistingProject(restoredRoot)
      if (copied.kind !== 'manifest' || copied.storageFormat !== 'canonical') throw new Error('FICTIONAL_RESTORE_NOT_CANONICAL')
      initProjectDatabase(copied.rootPath)
      runtime = projectRuntimeHost.getActiveView()!
      session = { projectId: copied.projectId, projectPath: copied.rootPath, leaseId: projectAccess.beginSession(copied).leaseId }
      const counts = () => ({ attempts: runtime.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get(),
        effects: runtime.database.prepare('SELECT COUNT(*) FROM workflow_effects').pluck().get(),
        changes: runtime.database.prepare('SELECT total_changes()').pluck().get() })
      const before = counts(), requests = transport.fetch.mock.calls.length
      const history = await call('workflow-driver:v1:read-history', { taskId: issued.receipt.task.taskId }, sender, session)
      expect(history.task.state).toBe(state)
      expect(history.task.projectId).toBe(issued.receipt.task.projectId)
      expect(history.task.projectId).not.toBe(copied.projectId)
      if (state === 'waiting_review') {
        expect(await call('workflow-driver:v1:reauthorize', { taskId: history.task.taskId }, sender, session))
          .toEqual({ reference: null, receipt: history })
        expect(history.composition?.text).toBe(prose)
        expect(history.draftSaveProof).toBe('unavailable')
      } else {
        await expect(call('workflow-driver:v1:reauthorize', { taskId: history.task.taskId }, sender, session))
          .rejects.toThrow('WORKFLOW_DRIVER_HISTORY_FROZEN')
      }
      for (const channel of ['workflow-driver:v1:resume', 'workflow-driver:v1:pause', 'workflow-driver:v1:cancel'] as const) {
        await expect(call(channel, { reference: issued.reference! })).rejects.toThrow('WORKFLOW_DRIVER_CAPABILITY_REQUIRED')
        await expect(call(channel, { reference: { projectId: copied.projectId, taskId: history.task.taskId, revision: history.task.revision } }))
          .rejects.toThrow('WORKFLOW_DRIVER_CAPABILITY_REQUIRED')
      }
      expect(counts()).toEqual(before)
      expect(transport.fetch).toHaveBeenCalledTimes(requests)
    } finally { transport.release() }
  })

  it('continues actual steps in A while viewing B and replays a lost start reply without new effects', async () => {
    const request = await prepared(), transport = stream({ hold: true })
    const issued = await call('workflow-driver:v1:start', request, sender, session)
    const reference = issued.reference!
    expect(reference).not.toBeNull()
    await transport.started
    expect((await call('workflow-driver:v1:start', request, sender, session)).reference).toEqual(reference)
    const b = projectAccess.createProject(root, 'B')
    createProjectDatabase(b.rootPath)
    const ticket = projectRuntimeHost.prepareRetainedOpen(b), runtimeB = projectRuntimeHost.commitOpen(ticket)
    projectRuntimeHost.activateView(runtimeB)
    projectAccess.beginSession(b)
    try {
      await expect(call('workflow-driver:v1:start', request, sender, session)).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
      await expect(call('workflow-driver:v1:read-receipt', { reference }, new Sender())).rejects.toThrow('WORKFLOW_DRIVER_CAPABILITY_REQUIRED')
      await expect(call('workflow-driver:v1:cancel', { reference: { ...reference, projectId: b.projectId } })).rejects.toThrow('WORKFLOW_DRIVER_CAPABILITY_REQUIRED')
      transport.release()
      const receipt = await terminal(reference)
      expect(receipt.task.state).toBe('waiting_review')
      expect(receipt.steps.map(step => step.effect?.receiptKind)).toEqual(['model', 'model', 'composition', 'draft_commit'])
      expect(receipt.draftSave).toMatchObject({ kind: 'current', receipt: { content: prose } })
      expect(transport.fetch).toHaveBeenCalledTimes(2)
      expect(runtime.database.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(1)
      expect(runtimeB.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
      const nonces = runtime.database.prepare('SELECT invocation_nonce,command_id FROM workflow_steps WHERE ordinal<2 ORDER BY ordinal').all() as { invocation_nonce: string; command_id: string }[]
      expect(new Set(nonces.flatMap(row => [row.invocation_nonce, row.command_id])).size).toBe(4)
      projectRuntimeHost.activateView(runtime)
      session = { ...session, leaseId: projectAccess.beginSession(project).leaseId }
      const history = await call('workflow-driver:v1:read-history', { taskId: reference.taskId }, sender, session)
      expect(history.draftSave).toEqual(receipt.draftSave)
      expect(transport.fetch).toHaveBeenCalledTimes(2)
    } finally { transport.release() }
  })

  it('rolls back task/run preparation on a native write failure and publishes no capability', async () => {
    const request = await prepared(), transport = stream()
    runtime.database.exec("CREATE TRIGGER reject_driver_issue BEFORE INSERT ON workflow_tasks BEGIN SELECT RAISE(ABORT,'fictional-private-write-failure'); END")
    await expect(call('workflow-driver:v1:start', request, sender, session)).rejects.toThrow('GENERATION_REQUEST_FAILED')
    expect(runtime.database.prepare('SELECT COUNT(*) FROM workflow_tasks').pluck().get()).toBe(0)
    expect(runtime.database.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(0)
    expect(runtime.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
    expect(transport.fetch).not.toHaveBeenCalled()
    runtime.database.exec('DROP TRIGGER reject_driver_issue')
    const retry = await call('workflow-driver:v1:start', await prepared(), sender, session)
    expect((await terminal(retry.reference!)).task.state).toBe('waiting_review')
  })

  it('does not dispatch a second step after source facts change during the first request', async () => {
    const request = await prepared(), transport = stream({ hold: true })
    const issued = await call('workflow-driver:v1:start', request, sender, session)
    try {
      await transport.started
      runtime.database.prepare("UPDATE project_core SET global_guidance=? WHERE id='main'").run('Changed fictional author source')
      transport.release()
      const receipt = await terminal(issued.reference!)
      expect(receipt.task.state).toBe('blocked')
      expect(receipt.draftSave.kind).toBe('absent')
      expect(transport.fetch).toHaveBeenCalledTimes(1)
      expect(runtime.database.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
    } finally { transport.release() }
  })

  it('retains work through pause and true close until an abort-ignoring transport physically returns', async () => {
    const request = await prepared(), transport = stream({ hold: true })
    const issued = await call('workflow-driver:v1:start', request, sender, session)
    try {
      await transport.started
      const paused = await call('workflow-driver:v1:pause', { reference: issued.reference! })
      expect(paused.receipt.task.state).toBe('paused')
      await expect(projectRuntimeHost.requestClose(runtime, { timeoutMs: 0 })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
      expect(runtime.database.open).toBe(true)
      expect(transport.fetch).toHaveBeenCalledTimes(1)
      transport.release()
      await projectRuntimeHost.requestClose(runtime)
      expect(runtime.database.open).toBe(false)
      expect(transport.fetch).toHaveBeenCalledTimes(1)
    } finally { transport.release() }
  })

  it('does not mint another invocation or resend after unknown delivery', async () => {
    const request = await prepared(), transport = stream({ finishReason: 'unknown' })
    const issued = await call('workflow-driver:v1:start', request, sender, session)
    expect((await terminal(issued.reference!)).task.state).toBe('blocked')
    const before = runtime.database.prepare('SELECT * FROM generation_attempts').all()
    const refreshed = await call('workflow-driver:v1:start', request, sender, session)
    await call('workflow-driver:v1:resume', { reference: refreshed.reference! }).catch(() => undefined)
    const again = await terminal(refreshed.reference!)
    expect(again.task.state).toBe('blocked')
    expect(transport.fetch).toHaveBeenCalledTimes(1)
    expect(runtime.database.prepare('SELECT * FROM generation_attempts').all()).toEqual(before)
    expect(runtime.database.prepare('SELECT COUNT(*) FROM drafts').pluck().get()).toBe(0)
  })
})

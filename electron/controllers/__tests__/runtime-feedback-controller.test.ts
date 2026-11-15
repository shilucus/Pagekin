import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { PlanningFeedbackChannels } from '../../../src/shared/planning-feedback-ipc'
import type { RuntimeFeedbackChannels, RuntimeFeedbackReference } from '../../../src/shared/runtime-feedback-contract'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))

import { registerGenerationController } from '../generation-controller'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { RuntimeFeedbackAuthority } from '../../services/runtime-feedback-authority'
import * as mainOwner from '../../services/main-generation-owner'
import { projectAccess } from '../../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'

const model: ModelProfile = { id: 'fixture', name: 'Synthetic model', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 1024, temperature: 0.7, purposes: ['generation'] }

class Sender extends EventEmitter {
  send = vi.fn()
  private destroyed = false
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}

type Channels = RuntimeFeedbackChannels & PlanningFeedbackChannels
let root: string, session: ProjectSessionContext, sender: Sender
let project: ReturnType<typeof projectAccess.createProject>
let otherRuntime: ProjectRuntime | null
let references: RuntimeFeedbackReference[]
let retirementGuard: (runtime: ProjectRuntime) => boolean

beforeAll(() => {
  const register = vi.spyOn(projectRuntimeHost, 'registerRetirementGuard')
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }),
    loadModel: () => model, applyProxyConfig: () => {} })
  retirementGuard = register.mock.calls[0]![0]
  register.mockRestore()
})

beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/rfg')
  fs.mkdirSync(cache, { recursive: true })
  root = fs.mkdtempSync(path.join(cache, 'ipc-'))
  mocks.globalRoot = path.join(root, 'global')
  fs.mkdirSync(mocks.globalRoot)
  project = projectAccess.createProject(root, 'Fiction A')
  createProjectDatabase(project.rootPath)
  initProjectDatabase(project.rootPath)
  getProjectDb()!.exec("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fiction A','A original')")
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: projectAccess.beginSession(project).leaseId }
  sender = new Sender()
  references = []
  otherRuntime = null
})

afterEach(async () => {
  for (const reference of references) {
    try { await call('runtime-feedback:v1:revoke', reference) } catch { /* Completed or already revoked. */ }
  }
  sender.destroy()
  if (otherRuntime && otherRuntime.phase === 'open' && otherRuntime !== projectRuntimeHost.getActiveView()) projectRuntimeHost.releaseIdle(otherRuntime)
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function call<C extends keyof Channels>(channel: C, arg: Channels[C]['args'][0], caller = sender, view?: ProjectSessionContext) {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`IPC_HANDLER_MISSING:${channel}`)
  return handler({ sender: caller }, arg, ...(view ? [{ ...view }] : [])) as Promise<Channels[C]['return']>
}

async function prepare(operationId = randomUUID()) {
  const base = await call('planning-feedback:v1:capture', { target: 'coreOutline' }, sender, session)
  const request = { operationId, input: { baseId: base.baseId, feedback: 'Preserve the facts', constraints: [] }, modelId: model.id }
  const result = await call('runtime-feedback:v1:prepare', request, sender, session)
  if (!result.reference) throw new Error('RUNTIME_FEEDBACK_REFERENCE_MISSING')
  references.push(result.reference)
  return { ...result, reference: result.reference, request }
}

function stream(content = 'Fictional candidate', includeUsage = false) {
  const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`
      + (includeUsage ? 'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":12,"total_tokens":62}}\n\n' : '')
      + 'data: [DONE]\n\n'))
    controller.close()
  } }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('runtime feedback registered IPC', () => {
  it('keeps an unstarted grant and propagates unexpected guard failures without changing storage', async () => {
    const runtime = projectRuntimeHost.getActiveView()!
    const prepared = await prepare()
    const before = runtime.database.prepare('SELECT * FROM runtime_feedback_grants').all()
    expect(retirementGuard(runtime)).toBe(false)
    expect(runtime.database.prepare('SELECT * FROM runtime_feedback_grants').all()).toEqual(before)
    expect(runtime.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
    expect((await call('runtime-feedback:v1:revoke', prepared.reference)).grant.state).toBe('revoked')
    const failure = vi.spyOn(runtime.database, 'prepare').mockImplementation(() => { throw new Error('FICTIONAL_GUARD_FAILURE') })
    expect(() => retirementGuard(runtime)).toThrow('FICTIONAL_GUARD_FAILURE')
    failure.mockRestore()
  })
  it('allows a completed receipt but retains a durable unknown attempt', async () => {
    stream(undefined, true)
    const runtime = projectRuntimeHost.getActiveView()!, prepared = await prepare()
    const receipt = await call('runtime-feedback:v1:execute', prepared.reference)
    expect(receipt.grant.state).toBe('completed')
    expect(runtime.database.prepare("SELECT json_extract(attempt_json,'$.status') FROM generation_attempts").pluck().all()).toEqual(['settled'])
    expect(retirementGuard(runtime)).toBe(true)
    const before = runtime.database.prepare('SELECT attempt_id,attempt_json FROM generation_attempts').get() as { attempt_id: string; attempt_json: string }
    runtime.database.prepare("UPDATE generation_attempts SET attempt_json=json_set(attempt_json,'$.status','unknown') WHERE attempt_id=?").run(before.attempt_id)
    const unknown = runtime.database.prepare('SELECT attempt_json FROM generation_attempts WHERE attempt_id=?').get(before.attempt_id)
    expect(retirementGuard(runtime)).toBe(false)
    expect(runtime.database.prepare('SELECT attempt_json FROM generation_attempts WHERE attempt_id=?').get(before.attempt_id)).toEqual(unknown)
    runtime.database.prepare('UPDATE generation_attempts SET attempt_json=? WHERE attempt_id=?').run(before.attempt_json, before.attempt_id)
  })
  it('retains an actual completed receipt with unknown usage after the owner becomes idle', async () => {
    stream()
    const runtime = projectRuntimeHost.getActiveView()!, prepared = await prepare()
    expect((await call('runtime-feedback:v1:execute', prepared.reference)).grant.state).toBe('completed')
    expect(runtime.database.prepare("SELECT json_extract(attempt_json,'$.status') FROM generation_attempts").pluck().all()).toEqual(['unknown'])
    const ownerCheck = vi.spyOn(RuntimeFeedbackAuthority.prototype, 'assertRetirable')
    expect(retirementGuard(runtime)).toBe(false)
    expect(ownerCheck).toHaveReturned()
  })
  it('rejects empty, sparse, oversized and duplicate batches before fencing any grant', async () => {
    const prepared = await prepare()
    const handler = mocks.handlers.get('runtime-feedback:v1:revoke-many')!
    const invalid = [[], Array(1), Array.from({ length: 129 }, () => ({ ...prepared.reference, grantId: randomUUID() })),
      [prepared.reference, { ...prepared.reference }]]
    for (const batch of invalid) await expect(handler({ sender }, { references: batch })).rejects.toThrow()
    expect(getProjectDb()!.prepare('SELECT state FROM runtime_feedback_grants').pluck().get()).toBe('active')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
  })

  it.each(['success', 'storage-failure', 'unauthorized', 'terminal'] as const)(
    'fences each requested project independently for %s', async scenario => {
      const fetch = stream(), preparedA = await prepare(), runtimeA = projectRuntimeHost.getActiveView()!, oldSession = { ...session }
      const projectB = projectAccess.createProject(root, 'Fiction B')
      createProjectDatabase(projectB.rootPath)
      const ticket = projectRuntimeHost.prepareRetainedOpen(projectB)
      otherRuntime = projectRuntimeHost.commitOpen(ticket)
      projectRuntimeHost.activateView(otherRuntime)
      otherRuntime.database.exec("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fiction B','B original')")
      session = { projectId: projectB.projectId, projectPath: projectB.rootPath, leaseId: projectAccess.beginSession(projectB).leaseId }
      try {
        const preparedB = await prepare()
        const completed = scenario === 'terminal' ? await call('runtime-feedback:v1:execute', preparedB.reference) : null
        if (scenario === 'storage-failure') runtimeA.database.exec(`CREATE TRIGGER reject_batch_revoke BEFORE UPDATE OF state ON runtime_feedback_grants
          WHEN OLD.grant_id='${preparedA.reference.grantId}' BEGIN SELECT RAISE(ABORT,'fictional-private-storage-detail'); END`)
        const request = { references: [preparedA.reference, preparedB.reference] }
        const response = await call('runtime-feedback:v1:revoke-many', request, scenario === 'unauthorized' ? new Sender() : sender)
        expect(response.projects).toHaveLength(2)
        const a = response.projects.find(item => item.projectId === preparedA.reference.projectId)!
        const b = response.projects.find(item => item.projectId === preparedB.reference.projectId)!
        expect(a.grants).toHaveLength(1)
        expect(b.grants).toHaveLength(1)
        expect(a.grants[0]).toMatchObject({ grantId: preparedA.reference.grantId, requestedRevision: preparedA.reference.revision })
        expect(b.grants[0]).toMatchObject({ grantId: preparedB.reference.grantId, requestedRevision: preparedB.reference.revision })
        if (scenario === 'unauthorized') {
          expect(response.completeForRequestedScope).toBe(false)
          for (const group of response.projects) {
            expect(group.completeForRequestedScope).toBe(false)
            expect(group.grants[0]).toMatchObject({ fenced: false, receipt: null, errorCode: expect.any(String) })
          }
          expect(JSON.stringify(response)).not.toContain('A original')
          expect(JSON.stringify(response)).not.toContain('B original')
          expect(runtimeA.database.prepare('SELECT state FROM runtime_feedback_grants').pluck().get()).toBe('active')
          expect(otherRuntime.database.prepare('SELECT state FROM runtime_feedback_grants').pluck().get()).toBe('active')
        } else {
          expect(response.completeForRequestedScope).toBe(scenario !== 'storage-failure')
          expect(a.completeForRequestedScope).toBe(scenario !== 'storage-failure')
          expect(b.completeForRequestedScope).toBe(true)
          expect(b.grants[0]).toMatchObject({ fenced: true, errorCode: null })
          expect(b.grants[0]!.receipt?.grant.state).toBe(scenario === 'terminal' ? 'completed' : 'revoked')
          if (scenario === 'storage-failure') {
            expect(a.grants[0]).toMatchObject({ fenced: false, receipt: null, errorCode: expect.any(String) })
            expect(JSON.stringify(response)).not.toContain('fictional-private-storage-detail')
            expect(runtimeA.database.prepare('SELECT state FROM runtime_feedback_grants').pluck().get()).toBe('active')
          } else {
            expect(a.grants[0]).toMatchObject({ fenced: true, errorCode: null })
            expect(a.grants[0]!.receipt?.grant.state).toBe('revoked')
          }
          if (completed) {
            expect(b.grants[0]!.receipt?.candidate).toEqual(completed.candidate)
            const replay = await call('runtime-feedback:v1:revoke-many', request)
            expect(replay).toEqual(response)
          }
        }
        expect(fetch).toHaveBeenCalledTimes(scenario === 'terminal' ? 1 : 0)
        expect(runtimeA.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
        expect(otherRuntime.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(scenario === 'terminal' ? 1 : 0)
      } finally {
        runtimeA.database.exec('DROP TRIGGER IF EXISTS reject_batch_revoke')
        projectRuntimeHost.activateView(runtimeA)
        session = { ...oldSession, leaseId: projectAccess.beginSession(project).leaseId }
      }
    })

  it.each([
    ['legacy', 'construct'], ['legacy', 'retire'], ['runtime', 'construct'], ['runtime', 'retire'],
  ] as const)('preserves the %s owner when handoff %s fails', async (initialMode, failure) => {
    const create = mainOwner.createMainGenerationOwner
    const created: ReturnType<typeof create>[] = []
    const factory = vi.spyOn(mainOwner, 'createMainGenerationOwner').mockImplementation(dependencies => {
      const owner = create(dependencies)
      created.push(owner)
      return owner
    })
    const base = await call('planning-feedback:v1:capture', { target: 'coreOutline' }, sender, session)
    const request = { operationId: randomUUID(), input: { baseId: base.baseId, feedback: 'Preserve the facts', constraints: [] }, modelId: model.id }
    if (initialMode === 'runtime') {
      const prepared = await call('runtime-feedback:v1:prepare', request, sender, session)
      if (!prepared.reference) throw new Error('RUNTIME_FEEDBACK_REFERENCE_MISSING')
      references.push(prepared.reference)
      await call('runtime-feedback:v1:revoke', prepared.reference)
    }
    const oldOwner = created[created.length - 1]!
    const db = getProjectDb()!
    const snapshot = () => ['generation_roots', 'generation_runs', 'generation_attempts', 'generation_artifacts']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = snapshot()
    const oldCount = created.length
    if (failure === 'construct') {
      factory.mockImplementationOnce(() => { throw new Error('FICTIONAL_CONSTRUCTION_FAILURE') })
    } else {
      vi.spyOn(oldOwner, 'retireIdle').mockImplementationOnce(() => { throw new Error('FICTIONAL_RETIRE_FAILURE') })
    }
    const handoff = () => initialMode === 'legacy'
      ? call('runtime-feedback:v1:prepare', request, sender, session)
      : call('planning-feedback:v1:capture', { target: 'coreOutline' }, sender, session)
    await expect(handoff()).rejects.toThrow()
    expect(snapshot()).toEqual(before)
    expect(factory.mock.calls.at(-1)?.[0].recoverInterrupted).toBe(false)
    if (failure === 'retire') {
      expect(created).toHaveLength(oldCount + 1)
      expect(() => created[oldCount]!.assertRetirable()).toThrow('GENERATION_OWNER_CLOSED')
    } else expect(created).toHaveLength(oldCount)
    const callsAfterFailure = factory.mock.calls.length
    if (initialMode === 'legacy') {
      await expect(call('planning-feedback:v1:capture', { target: 'coreOutline' }, sender, session)).resolves.toBeDefined()
    } else {
      const retained = await call('runtime-feedback:v1:prepare', { ...request, operationId: randomUUID() }, sender, session)
      expect(retained.reference).not.toBeNull()
      if (retained.reference) references.push(retained.reference)
    }
    expect(factory).toHaveBeenCalledTimes(callsAfterFailure)
  })

  it('keeps a terminal receipt readable to its sender after a legacy owner handoff without new effects', async () => {
    const fetch = stream(undefined, true), prepared = await prepare()
    const completed = await call('runtime-feedback:v1:execute', prepared.reference)
    expect(completed.grant.state).toBe('completed')
    expect(completed.candidate?.text).toBe('Fictional candidate')
    const db = getProjectDb()!
    const attempts = db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()
    const candidates = db.prepare('SELECT * FROM planning_feedback_candidates ORDER BY rowid').all()
    const handler = mocks.handlers.get('generation:list')
    if (!handler) throw new Error('IPC_HANDLER_MISSING:generation:list')
    const legacy = await handler({ sender }, { ...session }) as { handle: { runId: string } }[]
    expect(legacy.some(item => item.handle.runId === completed.grant.runId)).toBe(false)
    expect(retirementGuard(projectRuntimeHost.getActiveView()!)).toBe(true)
    const id = { projectId: prepared.reference.projectId, grantId: prepared.reference.grantId }
    expect(await call('runtime-feedback:v1:read-receipt', id)).toEqual(completed)
    expect(await call('runtime-feedback:v1:execute', prepared.reference)).toEqual(completed)
    expect(await call('runtime-feedback:v1:revoke', prepared.reference)).toEqual(completed)
    await expect(call('runtime-feedback:v1:read-receipt', id, new Sender())).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT * FROM generation_attempts ORDER BY rowid').all()).toEqual(attempts)
    expect(db.prepare('SELECT * FROM planning_feedback_candidates ORDER BY rowid').all()).toEqual(candidates)
  })

  it('executes retained A after switching to B without modifying B', async () => {
    const prepared = await prepare(), runtimeA = projectRuntimeHost.getActiveView()!, oldSession = { ...session }
    const beforeA = runtimeA.database.prepare('SELECT * FROM project_core').all()
    const fetch = stream()
    const projectB = projectAccess.createProject(root, 'Fiction B')
    createProjectDatabase(projectB.rootPath)
    const ticket = projectRuntimeHost.prepareRetainedOpen(projectB)
    otherRuntime = projectRuntimeHost.commitOpen(ticket)
    projectRuntimeHost.activateView(otherRuntime)
    otherRuntime.database.exec("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fiction B','B original')")
    session = { projectId: projectB.projectId, projectPath: projectB.rootPath, leaseId: projectAccess.beginSession(projectB).leaseId }
    const beforeB = otherRuntime.database.prepare('SELECT * FROM project_core').all()
    try {
      await expect(call('runtime-feedback:v1:prepare', { ...prepared.request, operationId: randomUUID() }, sender, oldSession)).rejects.toThrow()
      await expect(call('runtime-feedback:v1:execute', prepared.reference, new Sender())).rejects.toThrow()
      const receipt = await call('runtime-feedback:v1:execute', prepared.reference)
      expect(receipt.grant.state).toBe('completed')
      expect(receipt.candidate?.text).toBe('Fictional candidate')
      expect(runtimeA.database.prepare('SELECT * FROM project_core').all()).toEqual(beforeA)
      expect(otherRuntime.database.prepare('SELECT * FROM project_core').all()).toEqual(beforeB)
      expect(otherRuntime.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(await call('runtime-feedback:v1:execute', prepared.reference)).toEqual(receipt)
      expect((await call('runtime-feedback:v1:revoke', prepared.reference)).candidate).toEqual(receipt.candidate)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      projectRuntimeHost.activateView(runtimeA)
      session = { ...oldSession, leaseId: projectAccess.beginSession(project).leaseId }
    }
  })

  it('revokes before dispatch without creating an attempt or candidate', async () => {
    const fetch = stream(), prepared = await prepare()
    const receipt = await call('runtime-feedback:v1:revoke', prepared.reference)
    expect(receipt.grant.state).toBe('revoked')
    expect(receipt.candidate).toBeNull()
    expect((await call('runtime-feedback:v1:execute', prepared.reference)).grant.state).toBe('revoked')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM planning_feedback_candidates').pluck().get()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['legacy', 'restore'] as const)('denies dispatch under the %s maintenance lock', async kind => {
    const fetch = stream(), prepared = await prepare()
    const release = kind === 'legacy' ? projectRuntimeHost.acquireLegacyOperation('fixture') : projectRuntimeHost.acquireRestoreOperation()
    try {
      await expect(call('runtime-feedback:v1:execute', prepared.reference)).rejects.toThrow()
      expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally { release() }
    await call('runtime-feedback:v1:revoke', prepared.reference)
    const fresh = await prepare()
    expect((await call('runtime-feedback:v1:execute', fresh.reference)).grant.state).toBe('completed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('settles an in-flight request but refuses staging while maintenance is locked', async () => {
    const prepared = await prepare()
    let start!: () => void, releaseFetch!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const gate = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetch = vi.fn(async () => {
      start(); await gate
      return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Fictional candidate' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
        controller.close()
      } }) }
    })
    vi.stubGlobal('fetch', fetch)
    const execution = call('runtime-feedback:v1:execute', prepared.reference)
    let releaseLock: (() => void) | undefined
    try {
      await started
      releaseLock = projectRuntimeHost.acquireLegacyOperation('fixture')
      releaseFetch()
      await expect(execution).rejects.toThrow()
      const db = getProjectDb()!
      expect(db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(1)
      expect(db.prepare('SELECT COUNT(*) FROM generation_artifacts').pluck().get()).toBeGreaterThan(0)
      expect(db.prepare('SELECT COUNT(*) FROM planning_feedback_candidates').pluck().get()).toBe(0)
      expect(db.prepare('SELECT blocked_code FROM generation_roots').pluck().get()).toBeNull()
      const id = { projectId: prepared.reference.projectId, grantId: prepared.reference.grantId }
      const receipt = await call('runtime-feedback:v1:read-receipt', id)
      expect(receipt.candidate).toBeNull()
      expect((await call('runtime-feedback:v1:revoke', prepared.reference)).candidate).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      releaseFetch(); releaseLock?.()
      await execution.catch(() => undefined)
    }
  })

  it('does not reconstruct a capability from history after close and reopen', async () => {
    const fetch = stream(), prepared = await prepare()
    closeProjectDatabase()
    projectAccess.invalidateCurrentSession()
    initProjectDatabase(project.rootPath)
    session = { ...session, leaseId: projectAccess.beginSession(project).leaseId }
    const receipt = await call('runtime-feedback:v1:read-history', { grantId: prepared.reference.grantId }, sender, session)
    expect(receipt.grant.state).toBe('revoked')
    expect(receipt.nonReplayable).toBe(true)
    await expect(call('runtime-feedback:v1:execute', prepared.reference)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects changed source and conflicting reuse without dispatch', async () => {
    const fetch = stream(), prepared = await prepare()
    const repeated = await call('runtime-feedback:v1:prepare', prepared.request, sender, session)
    expect(repeated.reference).toEqual(prepared.reference)
    const other = await call('runtime-feedback:v1:prepare', prepared.request, new Sender(), session)
    expect(other.reference).toBeNull()
    await expect(call('runtime-feedback:v1:prepare', { ...prepared.request,
      input: { ...prepared.request.input, feedback: 'different instruction' } }, sender, session)).rejects.toThrow()
    await expect(call('runtime-feedback:v1:prepare', { ...prepared.request, modelId: 'different-model' }, sender, session)).rejects.toThrow()
    getProjectDb()!.exec("UPDATE project_core SET core_outline='Changed by author' WHERE id='main'")
    await expect(call('runtime-feedback:v1:execute', prepared.reference)).rejects.toThrow()
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a legacy handoff while a grant claim is live and releases it on revoke', async () => {
    const prepared = await prepare()
    await expect(call('planning-feedback:v1:capture', { target: 'coreOutline' }, sender, session)).rejects.toThrow()
    expect(getProjectDb()!.prepare('SELECT state FROM runtime_feedback_grants WHERE grant_id=?').pluck().get(prepared.reference.grantId)).toBe('active')
    await call('runtime-feedback:v1:revoke', prepared.reference)
    await expect(call('planning-feedback:v1:capture', { target: 'coreOutline' }, sender, session)).resolves.toBeDefined()
    const runtime = projectRuntimeHost.getActiveView()!
    const rootActionId = runtime.database.prepare('SELECT root_action_id FROM generation_runs WHERE run_id=?').pluck().get(prepared.receipt.grant.runId) as string
    await expect(call('planning-feedback:v1:read-run', { handle: { projectId: session.projectId, epoch: runtime.executionEpoch,
      rootActionId, runId: prepared.receipt.grant.runId } }, sender, session)).rejects.toThrow()
  })

  it('settles a revoked dispatch without a candidate and waits for physical fetch before handoff', async () => {
    const prepared = await prepare(), runtime = projectRuntimeHost.getActiveView()!
    let start!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.fn(async () => {
      start()
      await gate
      return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Late candidate' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
        controller.close()
      } }) }
    })
    vi.stubGlobal('fetch', fetch)
    const execution = call('runtime-feedback:v1:execute', prepared.reference)
    try {
      await started
      const revoked = await call('runtime-feedback:v1:revoke', prepared.reference)
      expect(revoked.grant.state).toBe('revoked')
      const result = await execution
      expect(result.candidate).toBeNull()
      expect(result.attempts).toHaveLength(1)
      expect(result.attempts[0].status).toBe('unknown')
      const again = await call('runtime-feedback:v1:execute', prepared.reference)
      expect(again).toEqual(result)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(() => projectRuntimeHost.releaseIdle(runtime)).toThrow('PROJECT_RUNTIME_BUSY')
      await expect(call('planning-feedback:v1:capture', { target: 'coreOutline' }, sender, session)).rejects.toThrow()
      expect(runtime.database.prepare('SELECT COUNT(*) FROM planning_feedback_candidates').pluck().get()).toBe(0)
      release()
      await vi.waitFor(async () => {
        await expect(call('planning-feedback:v1:capture', { target: 'coreOutline' }, sender, session)).resolves.toBeDefined()
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(runtime.database.prepare('SELECT COUNT(*) FROM planning_feedback_candidates').pluck().get()).toBe(0)
    } finally {
      release()
      await execution.catch(() => undefined)
    }
  })

  it('revokes a live grant when its exact sender is destroyed', async () => {
    const fetch = stream(), prepared = await prepare()
    sender.destroy()
    const receipt = await call('runtime-feedback:v1:read-history', { grantId: prepared.reference.grantId }, new Sender(), session)
    expect(receipt.grant.state).toBe('revoked')
    expect(receipt.candidate).toBeNull()
    await expect(call('runtime-feedback:v1:execute', prepared.reference)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
  })

  it('seals true close, preserves cleanup receipts and B admission, and releases A only after physical settlement', async () => {
    const prepared = await prepare(), runtimeA = projectRuntimeHost.getActiveView()!
    const projectB = projectAccess.createProject(root, 'Fiction B')
    createProjectDatabase(projectB.rootPath)
    otherRuntime = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareRetainedOpen(projectB))
    otherRuntime.database.exec("INSERT INTO project_core(id,project_name,core_outline) VALUES('main','Fiction B','B original')")
    let start!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.fn(async () => {
      start(); await gate
      return { ok: true, body: new ReadableStream({ start(controller) { controller.close() } }) }
    })
    vi.stubGlobal('fetch', fetch)
    const execution = call('runtime-feedback:v1:execute', prepared.reference)
    try {
      await started
      await expect(projectRuntimeHost.requestClose(runtimeA, { timeoutMs: 0 })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
      expect(runtimeA.database.open).toBe(true)
      expect(() => projectRuntimeHost.acquireWork(runtimeA)).toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')
      const receipt = await execution
      expect(receipt.grant.state).toBe('revoked')
      expect(receipt.attempts).toHaveLength(1)
      expect(receipt.attempts[0].status).toBe('unknown')
      expect(receipt.candidate).toBeNull()
      expect(await call('runtime-feedback:v1:read-receipt', {
        projectId: prepared.reference.projectId, grantId: prepared.reference.grantId,
      })).toEqual(receipt)
      expect(await call('runtime-feedback:v1:execute', prepared.reference)).toEqual(receipt)
      const leaseB = projectAccess.beginViewSession(otherRuntime)
      session = { projectId: leaseB.projectId, projectPath: leaseB.rootPath, leaseId: leaseB.leaseId }
      const preparedB = await prepare()
      expect(preparedB.reference.projectId).toBe(projectB.projectId)
      expect(fetch).toHaveBeenCalledOnce()
      release()
      await projectRuntimeHost.requestClose(runtimeA)
      expect(runtimeA.database.open).toBe(false)
      expect(projectRuntimeHost.getActiveView()).toBe(otherRuntime)
      expect(projectAccess.assertViewContext(session)).toBe(otherRuntime)
      const reopened = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareRetainedOpen(project))
      const leaseA = projectAccess.beginViewSession(reopened)
      session = { projectId: leaseA.projectId, projectPath: leaseA.rootPath, leaseId: leaseA.leaseId }
      const history = await call('runtime-feedback:v1:read-history', { grantId: prepared.reference.grantId }, sender, session)
      expect(history.attempts[0].status).toBe('unknown')
      expect((await call('runtime-feedback:v1:prepare', prepared.request, sender, session)).reference).toBeNull()
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      release()
      await execution.catch(() => undefined)
      if (runtimeA.database.open) await projectRuntimeHost.requestClose(runtimeA)
    }
  })
})

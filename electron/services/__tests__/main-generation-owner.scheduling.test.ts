import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { LLMHistoryRepository } from '../../repositories/llm-repository'
import { createMainGenerationOwner, type MainGenerationOwnerDependencies } from '../main-generation-owner'
import { MainGenerationScheduler } from '../generation-scheduler'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../../src/shared/builtin-writing-skills'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { TERMINAL_PROVIDER_FAILURE_CODES } from '../../../src/shared/generation-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import { captureGenerationKnowledge, verifyGenerationKnowledge, type GenerationKnowledgeSnapshot } from '../generation-knowledge-source'
import { withKnowledgeSourceGate, isKnowledgeSourceBusy } from '../knowledge-source-gate'
import { openLanceDatabase } from '../../lance-database'
import { LLMFactory } from '../../llm/llm-factory'
import type { ILLMProvider } from '../../llm/provider.interface'
import { getProjectDb } from '../../database'

vi.mock('../../database', () => ({ getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn(() => null) }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanups: (() => void | Promise<void>)[] = []
const suspendOwners: (() => void)[] = []
const finishProviders: (() => void)[] = []
afterEach(async () => {
  try {
    for (const suspend of suspendOwners.splice(0).reverse()) suspend()
    for (const finish of finishProviders.splice(0)) finish()
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})
const task: GenerationTask = { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: 'Write fictional prose from the frozen facts.' }] }

function verifiedCleanupRoot(base: string, root: string) {
  const assertChild = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
    }
  }
  const absoluteBase = path.resolve(base), absoluteRoot = path.resolve(root)
  const workspace = path.resolve('.')
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  assertChild(workspace, absoluteBase)
  assertChild(absoluteBase, absoluteRoot)
  for (let directory = absoluteRoot; ; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
      throw new Error('FICTIONAL_CLEANUP_LINK')
    }
    if (normalized(directory) === normalized(workspace)) break
  }
  const realBase = fs.realpathSync.native(absoluteBase), realRoot = fs.realpathSync.native(absoluteRoot)
  assertChild(fs.realpathSync.native(path.resolve('.')), realBase)
  assertChild(realBase, realRoot)
  const pending = [absoluteRoot]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('FICTIONAL_CLEANUP_LINK')
      assertChild(realRoot, fs.realpathSync.native(target))
      if (entry.isDirectory()) pending.push(target)
    }
  }
  return absoluteRoot
}

function scheduling(global = 1) {
  const scheduler = new MainGenerationScheduler({
    global, provider: global, credential: global, model: global, project: 1,
    maxQueued: 8, maxQuarantined: 2, interactiveBurst: 1,
  }, 64)
  cleanups.push(() => { scheduler.close() })
  return scheduler
}

function heldProvider() {
  let complete: (() => void) | undefined
  let markStarted!: () => void
  let signal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const dispatch = vi.fn<GenerationRunServiceDependencies['dispatch']>(async (_request, options) => {
    signal = options.signal
    markStarted()
    return new Promise(resolve => { complete = () => resolve({ usage: null, finishReason: 'stop' }) })
  })
  finishProviders.push(() => { complete?.() })
  return { dispatch, started, finish: () => { complete?.() }, get signal() { return signal } }
}

function fixture(label: string, scheduler: MainGenerationScheduler, dispatch: GenerationRunServiceDependencies['dispatch'] | undefined, options: {
  knowledgeSnapshot?: () => GenerationKnowledgeSnapshot | undefined
  withDispatchKnowledge?: MainGenerationOwnerDependencies['withDispatchKnowledge']
  protocol?: ModelProfile['protocol']
} = {}) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/scheduling-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  const projectStorageRoot = path.join(root, 'project'), globalDataRoot = path.join(root, 'global')
  fs.mkdirSync(projectStorageRoot)
  fs.mkdirSync(globalDataRoot)
  const db = new Database(path.join(root, 'project.db'))
  vi.mocked(getProjectDb).mockImplementation(() => db)
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','Fictional book','Frozen facts'); INSERT INTO blueprints(chapter_number,title) VALUES(1,'Fictional chapter')")
  const model: ModelProfile = { id: 'fictional-model', name: 'Fictional model', provider: 'openai', protocol: options.protocol ?? 'openai',
    modelName: 'gpt-4.1', apiKey: 'fictional-key', baseUrl: 'https://fictional.invalid/v1', temperature: 0.7, maxTokens: 2048,
    purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: false, usage: true } }
  let current = true, revoked = false, leaseNow = 0
  let beforeDispatch: (() => void) | undefined
  const leases = new ModelExecutionLeaseRegistry({ loadModel: () => model, now: () => leaseNow, ttlMs: 10 })
  const sourceDeps = { db, projectStorageRoot, globalDataRoot,
    readBuiltinPrompt: (key: string, language: 'zh-CN' | 'en-US') => JSON.stringify(getBuiltinPromptTemplate(key, language)), readBuiltinSkill: readBuiltinWritingSkill }
  const projectId = `fictional-${label}`, epoch = `epoch-${label}`
  const owner = createMainGenerationOwner({ database: db, projectPath: root, projectId, epoch, leases, loadModel: () => model, dispatch,
    scheduling: { admission: scheduler, projectKey: `runtime-${label}`, quarantineAfterMs: 50 },
    withDispatchKnowledge: options.withDispatchKnowledge ?? (async (snapshot, operation) => {
      if (!snapshot) return operation()
      return withKnowledgeSourceGate(projectStorageRoot, async () => {
        await verifyGenerationKnowledge({ projectStorageRoot, snapshot })
        return operation()
      })
    }),
    assertCurrent: () => { if (!current) throw new Error('GENERATION_EPOCH_STALE') },
    assertAdmission: () => { if (revoked) throw new Error('FICTIONAL_GRANT_REVOKED') }, beforeDispatch: () => beforeDispatch?.(),
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(sourceDeps, { ...selection,
      ...(options.knowledgeSnapshot ? { knowledgeSnapshot: options.knowledgeSnapshot() } : {}), projectId, epoch,
      modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDeps, previous, epoch, modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding,
  })
  const begin: BeginGenerationRequest = { operation: 'chapter-draft', uiActionNonce: `click-${label}`, modelId: model.id, chapterNumber: 1,
    selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'], skillStages: [], output: 'visible-text' }
  const view = owner.begin(begin)
  const request = { handle: view.handle, invocationNonce: 'fictional-call', task }
  const repository = new GenerationRunRepository(() => db)
  suspendOwners.push(() => { owner.suspendForProjectClose() })
  cleanups.push(async () => {
    await owner.whenPhysicalIdle()
    if (db.open) db.close()
    fs.rmSync(verifiedCleanupRoot(base, root), { recursive: true, force: true })
  })
  return { db, owner, view, request, model, repository, begin, projectStorageRoot,
    revoke: () => { revoked = true }, invalidate: () => { current = false }, expireLease: () => { leaseNow = 10 },
    beforeDispatch: (callback: () => void) => { beforeDispatch = callback },
    attempts: () => repository.budget(view.handle.rootActionId).attempts,
  }
}

function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))
}

function deferredCleanup() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  finishProviders.push(() => { resolve() })
  return { promise, resolve, reject }
}

const realProtocols = [
  { protocol: 'openai' as const,
    content: 'data: {"choices":[{"delta":{"content":"visible"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
    end: 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' },
  { protocol: 'anthropic' as const,
    content: 'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n'
      + 'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n'
      + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"visible"}}\n\n',
    end: 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n'
      + 'data: {"type":"message_stop"}\n\n' },
  { protocol: 'gemini' as const,
    content: 'data: {"candidates":[{"content":{"parts":[{"text":"visible"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}\n',
    end: 'data: {"candidates":[{"finishReason":"STOP"}]}\n' },
]

describe('scheduled main generation owners', () => {
  it('verifies the original real KB snapshot after queueing and rejects a passage changed under the short gate', async () => {
    const scheduler = scheduling(), pa = heldProvider(), pb = heldProvider()
    let snapshot: GenerationKnowledgeSnapshot | undefined = undefined
    const a = fixture('a', scheduler, pa.dispatch)
    const b = fixture('b', scheduler, pb.dispatch, { knowledgeSnapshot: () => snapshot })
    const knowledge = await openLanceDatabase(path.join(b.projectStorageRoot, 'lancedb'))
    try {
      const chunks = await knowledge.createTable('chunks', [{ id: 'fictional-chunk', docId: 'fictional-document',
        fileName: 'fictional.md', text: 'Original fictional passage', chunkIndex: 0, totalChunks: 1, corpusKind: 'project-knowledge' }])
      chunks.close()
      const documents = await knowledge.createTable('documents', [{ id: 'fictional-document', fileName: 'fictional.md',
        chunkCount: 1, corpusKind: 'project-knowledge', filePath: 'fictional-unmanaged-path' }])
      documents.close()
    } finally { knowledge.close() }
    snapshot = await captureGenerationKnowledge({ projectStorageRoot: b.projectStorageRoot, query: 'fictional', topK: 1 })
    expect(snapshot.state).toBe('stored')
    const view = b.owner.begin({ ...b.begin, uiActionNonce: 'captured-knowledge' })
    const binding = structuredClone(b.repository.get(view.handle.runId).binding)
    const first = a.owner.execute(a.request)
    await pa.started
    const second = outcome(b.owner.execute({ ...b.request, handle: view.handle }))
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
    expect(isKnowledgeSourceBusy(b.projectStorageRoot)).toBe(false)
    await withKnowledgeSourceGate(b.projectStorageRoot, async () => {
      const connection = await openLanceDatabase(path.join(b.projectStorageRoot, 'lancedb'))
      try {
        const chunks = await connection.openTable('chunks')
        try { await chunks.update({ where: "id = 'fictional-chunk'", values: { text: 'Changed fictional passage' } }) }
        finally { chunks.close() }
      } finally { connection.close() }
    })
    pa.finish()
    await first
    expect((await second).error).toMatchObject({ message: 'GENERATION_KNOWLEDGE_SOURCE_STALE' })
    expect(b.repository.budget(view.handle.rootActionId)).toMatchObject({ attempts: [], blockedCode: null })
    expect(b.repository.get(view.handle.runId).binding).toEqual(binding)
    expect(pb.dispatch).not.toHaveBeenCalled()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
  })

  it('rechecks cancellation after an injected asynchronous knowledge verification boundary without reserving', async () => {
    const scheduler = scheduling(), pa = heldProvider(), pb = heldProvider()
    let entered!: () => void, release!: () => void
    const verifying = new Promise<void>(resolve => { entered = resolve })
    const verified = new Promise<void>(resolve => { release = resolve })
    const a = fixture('a', scheduler, pa.dispatch)
    const b = fixture('b', scheduler, pb.dispatch, { withDispatchKnowledge: async (_snapshot, operation) => {
      entered()
      await verified
      return operation()
    } })
    const first = a.owner.execute(a.request)
    await pa.started
    const second = outcome(b.owner.execute(b.request))
    expect(scheduler.getStats().queued).toBe(1)
    pa.finish()
    await first
    await verifying
    b.owner.cancel(b.view.handle)
    release()
    expect((await second).error).toMatchObject({ message: 'GENERATION_ACTION_CANCELLED' })
    expect(b.repository.budget(b.view.handle.rootActionId)).toMatchObject({ attempts: [], blockedCode: null })
    expect(pb.dispatch).not.toHaveBeenCalled()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
  })

  it('shares one physical slot across captured books, deduplicates nonce, and queues without an attempt or transaction', async () => {
    const scheduler = scheduling(), acquire = vi.spyOn(scheduler, 'acquire')
    const pa = heldProvider(), pb = heldProvider()
    const a = fixture('a', scheduler, pa.dispatch), b = fixture('b', scheduler, pb.dispatch)
    const first = a.owner.execute(a.request)
    await pa.started
    const second = b.owner.execute(b.request), duplicate = b.owner.execute(b.request)
    expect(b.attempts()).toHaveLength(0)
    expect(b.db.inTransaction).toBe(false)
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(acquire.mock.calls.map(([request]) => request.projectKey)).toEqual(['runtime-a', 'runtime-b'])
    expect(acquire.mock.calls.map(([request]) => request.lane)).toEqual(['interactive', 'interactive'])
    pa.finish()
    await first
    await pb.started
    expect(a.attempts()).toHaveLength(1)
    expect(b.attempts()).toHaveLength(1)
    pb.finish()
    const [result, repeated] = await Promise.all([second, duplicate])
    expect(repeated).toEqual(result)
    expect(pb.dispatch).toHaveBeenCalledTimes(1)
    expect(scheduler.getStats().occupied).toBe(0)
    const durable = b.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get() as string
    expect(durable).not.toMatch(/scheduling|permit|dispatchAdmission/u)
    expect(JSON.stringify(result)).not.toMatch(/scheduling|permit|dispatchAdmission/u)
  })

  it.each([
    ['source', 'GENERATION_SOURCE_CHANGED'],
    ['model', 'GENERATION_SOURCE_CHANGED_MODEL'],
    ['lease', 'MODEL_EXECUTION_LEASE_EXPIRED'],
    ['epoch', 'GENERATION_EPOCH_STALE'],
    ['grant', 'FICTIONAL_GRANT_REVOKED'],
    ['budget', 'GENERATION_DISPATCH_BLOCKED'],
  ] as const)('rejects a queued %s change without reserving or refreezing', async (change, code) => {
    const scheduler = scheduling(), pa = heldProvider(), pb = heldProvider()
    const a = fixture('a', scheduler, pa.dispatch), b = fixture('b', scheduler, pb.dispatch)
    const first = a.owner.execute(a.request)
    await pa.started
    const second = outcome(b.owner.execute(b.request))
    expect(b.attempts()).toHaveLength(0)
    if (change === 'source') b.db.prepare("UPDATE project_core SET global_guidance='Changed fictional facts'").run()
    else if (change === 'model') b.model.temperature = 0.3
    else if (change === 'lease') b.expireLease()
    else if (change === 'epoch') b.invalidate()
    else if (change === 'grant') b.revoke()
    else b.repository.block(b.view.handle.rootActionId, 'ROOT_BUDGET_EXHAUSTED')
    pa.finish()
    await first
    const rejected = await second
    expect(rejected.error).toMatchObject({ message: code })
    expect(b.attempts()).toHaveLength(0)
    expect(pb.dispatch).not.toHaveBeenCalled()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
  })

  it('rechecks source changes between grant and the final native reservation without a storage-failure fence', async () => {
    const scheduler = scheduling(), provider = heldProvider()
    const a = fixture('a', scheduler, provider.dispatch)
    a.beforeDispatch(() => { a.db.prepare("UPDATE project_core SET global_guidance='Changed just before reserve'").run() })
    await expect(a.owner.execute(a.request)).rejects.toThrow('GENERATION_SOURCE_CHANGED')
    expect(a.attempts()).toHaveLength(0)
    expect(a.repository.budget(a.view.handle.rootActionId).blockedCode).toBeNull()
    expect(provider.dispatch).not.toHaveBeenCalled()
    expect(scheduler.getStats().occupied).toBe(0)
  })

  it.each([['source', 'GENERATION_SOURCE_CHANGED'], ['grant', 'FICTIONAL_GRANT_REVOKED']] as const)(
    'does not mask a real %s rejection when the queued root is also cancelled', async (change, code) => {
      const scheduler = scheduling(), pa = heldProvider(), pb = heldProvider()
      const a = fixture('a', scheduler, pa.dispatch), b = fixture('b', scheduler, pb.dispatch)
      const first = a.owner.execute(a.request)
      await pa.started
      const second = outcome(b.owner.execute(b.request))
      if (change === 'source') b.db.prepare("UPDATE project_core SET global_guidance='Changed before explicit cancel' WHERE id='main'").run()
      else b.revoke()
      b.owner.cancel(b.view.handle)
      expect((await second).error).toMatchObject({ message: code })
      expect(b.repository.budget(b.view.handle.rootActionId)).toMatchObject({ attempts: [], blockedCode: null })
      expect(pb.dispatch).not.toHaveBeenCalled()
      expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 0 })
      pa.finish()
      await first
    })

  it.each([
    ['pause', 'GENERATION_DISPATCH_BLOCKED'], ['cancel', 'GENERATION_ACTION_CANCELLED'],
    ['restart', 'GENERATION_ACTION_CANCELLED'], ['close', 'GENERATION_OWNER_CLOSING'], ['suspend', 'GENERATION_OWNER_CLOSED'],
  ] as const)('removes only this owner queued root on %s without dispatching or closing the other database', async (action, code) => {
    const scheduler = scheduling(), pa = heldProvider(), pb = heldProvider()
    const a = fixture('a', scheduler, pa.dispatch), b = fixture('b', scheduler, pb.dispatch)
    const first = a.owner.execute(a.request)
    await pa.started
    const second = outcome(b.owner.execute(b.request))
    if (action === 'pause') b.owner.pause(b.view.handle)
    else if (action === 'cancel') b.owner.cancel(b.view.handle)
    else if (action === 'restart') b.owner.restart(b.view.handle, { ...b.begin, uiActionNonce: 'replacement-click' })
    else if (action === 'close') b.owner.requestProjectClose()
    else { b.owner.suspendForProjectClose(); b.db.close() }
    const closedPrepare = action === 'suspend' ? vi.spyOn(b.db, 'prepare') : undefined
    const rejected = await second
    expect(rejected.error).toMatchObject({ message: code })
    if (closedPrepare) expect(closedPrepare).not.toHaveBeenCalled()
    else expect(b.attempts()).toHaveLength(0)
    expect(pb.dispatch).not.toHaveBeenCalled()
    expect(pa.signal?.aborted).toBe(false)
    expect(a.db.open).toBe(true)
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 0 })
    pa.finish()
    await first
    expect(a.attempts()).toHaveLength(1)
    expect(a.db.open).toBe(true)
  })

  it('allows two books under a two-slot policy and cancellation never ends the other physical request', async () => {
    const scheduler = scheduling(2), pa = heldProvider(), pb = heldProvider()
    const a = fixture('a', scheduler, pa.dispatch), b = fixture('b', scheduler, pb.dispatch)
    const first = a.owner.execute(a.request), second = b.owner.execute(b.request)
    await Promise.all([pa.started, pb.started])
    expect(scheduler.getStats().occupied).toBe(2)
    a.owner.cancel(a.view.handle)
    await first
    expect(pa.signal?.aborted).toBe(true)
    expect(pb.signal?.aborted).toBe(false)
    expect(scheduler.getStats().occupied).toBe(2)
    pa.finish()
    await a.owner.whenPhysicalIdle()
    expect(scheduler.getStats().occupied).toBe(1)
    pb.finish()
    await second
    expect(scheduler.getStats().occupied).toBe(0)
  })

  it('cancels an exact queued root without removing another queued root of the same captured owner', async () => {
    const scheduler = scheduling(), pa = heldProvider(), pb = heldProvider()
    const a = fixture('a', scheduler, pa.dispatch), b = fixture('b', scheduler, pb.dispatch)
    const first = a.owner.execute(a.request)
    await pa.started
    const cancelled = outcome(b.owner.execute(b.request))
    const next = b.owner.begin({ ...b.begin, uiActionNonce: 'another-root-click' })
    const retained = b.owner.execute({ ...b.request, handle: next.handle })
    b.owner.cancel(b.view.handle)
    expect((await cancelled).error).toMatchObject({ message: 'GENERATION_ACTION_CANCELLED' })
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
    pa.finish()
    await first
    await pb.started
    expect(b.attempts()).toHaveLength(0)
    expect(b.repository.budget(next.handle.rootActionId).attempts).toHaveLength(1)
    pb.finish()
    await retained
  })

  it('holds a cooperative abort through cleanup grace without permanently stopping the credential', async () => {
    vi.useFakeTimers()
    const scheduler = scheduling(), pa = heldProvider(), pb = heldProvider()
    const a = fixture('a', scheduler, pa.dispatch), b = fixture('b', scheduler, pb.dispatch)
    const first = a.owner.execute(a.request)
    await pa.started
    const second = b.owner.execute(b.request)
    a.owner.pause(a.view.handle)
    await first
    let idle = false
    const physicalIdle = a.owner.whenPhysicalIdle().then(() => { idle = true })
    await vi.advanceTimersByTimeAsync(49)
    expect(idle).toBe(false)
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, quarantined: 0, blockedCredentials: 0, queued: 1 })
    pa.finish()
    await physicalIdle
    await pb.started
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, quarantined: 0, blockedCredentials: 0 })
    pb.finish()
    await second
    await vi.advanceTimersByTimeAsync(100)
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 0 })
  })

  it('parks ignored abort only after grace, keeps unknown nonce non-replayable, and requires explicit reset after late finish', async () => {
    vi.useFakeTimers()
    const scheduler = scheduling(), acquire = vi.spyOn(scheduler, 'acquire'), pa = heldProvider(), pb = heldProvider()
    const a = fixture('a', scheduler, pa.dispatch), b = fixture('b', scheduler, pb.dispatch)
    const first = a.owner.execute(a.request)
    await pa.started
    const second = b.owner.execute(b.request)
    a.owner.cancel(a.view.handle)
    await first
    await a.owner.execute(a.request)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(pa.dispatch).toHaveBeenCalledTimes(1)
    expect(a.attempts()[0]!.status).toBe('unknown')
    await vi.advanceTimersByTimeAsync(50)
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, active: 0, quarantined: 1, blockedCredentials: 1, queued: 1 })
    expect(pb.dispatch).not.toHaveBeenCalled()
    expect(() => scheduler.resetCredential(a.model)).toThrow('SCHEDULER_CREDENTIAL_BUSY')
    pa.finish()
    pa.finish()
    await a.owner.whenPhysicalIdle()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 1, queued: 1 })
    expect(pb.dispatch).not.toHaveBeenCalled()
    scheduler.resetCredential(a.model)
    await pb.started
    pb.finish()
    await second
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 0 })
  })
})

describe.each(realProtocols)('$protocol default owner logical and physical completion', ({ protocol, content, end }) => {
  it.each([
    ['http-error', 'resolve'], ['http-error', 'reject'], ['done', 'resolve'], ['done', 'reject'],
  ] as const)('settles %s before cleanup and preserves its receipt after late cleanup %s', async (terminal, cleanup) => {
    vi.useFakeTimers()
    const close = deferredCleanup(), cancel = vi.fn(() => close.promise), releaseLock = vi.fn()
    const chunks = [content, end]
    const reader = { read: vi.fn(async () => chunks.length
      ? { done: false, value: new TextEncoder().encode(chunks.shift()!) }
      : { done: true, value: undefined }), cancel, releaseLock }
    const fetch = vi.fn().mockResolvedValue(terminal === 'http-error'
      ? { ok: false, status: 503, body: { cancel }, text: vi.fn() }
      : { ok: true, status: 200, body: { getReader: () => reader } })
    vi.stubGlobal('fetch', fetch)
    const scheduler = scheduling(), acquire = vi.spyOn(scheduler, 'acquire'), pb = heldProvider()
    const a = fixture('a', scheduler, undefined, { protocol }), b = fixture('b', scheduler, pb.dispatch, { protocol })
    const first = await a.owner.execute(a.request)
    const attemptId = a.attempts()[0]!.attemptId
    const receipt = a.repository.receipt(attemptId)
    if (terminal === 'http-error') {
      expect(first.outcome).toMatchObject({ status: 'incomplete', receipt: { failureCode: 'GENERATION_PROVIDER_FAILED' } })
      expect(receipt.failureCode).toBe('GENERATION_PROVIDER_FAILED')
    } else {
      expect(first.outcome).toMatchObject({ status: 'completed', content: 'visible', finishReason: 'stop' })
      expect(receipt.result).toMatchObject({ finishReason: 'stop', usage: { trusted: true, inputTokens: 2, completionTokens: 3, actualTokens: 5 } })
      expect(receipt.artifact?.text).toBe('visible')
    }
    expect(receipt.budget.blockedCode).toBeNull()
    const durable = a.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts').all()
    expect(cancel).toHaveBeenCalledOnce()
    expect(releaseLock).not.toHaveBeenCalled()
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, active: 1, quarantined: 0 })
    let physicallyIdle = false
    const idle = a.owner.whenPhysicalIdle().then(() => { physicallyIdle = true })
    await Promise.resolve()
    expect(physicallyIdle).toBe(false)
    const second = b.owner.execute(b.request)
    expect(scheduler.getStats().queued).toBe(1)
    await a.owner.execute(a.request)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(49)
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, active: 1, quarantined: 0 })
    expect(pb.dispatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, active: 0, quarantined: 1, blockedCredentials: 1, queued: 1 })
    expect(physicallyIdle).toBe(false)
    expect(() => scheduler.resetCredential(a.model)).toThrow('SCHEDULER_CREDENTIAL_BUSY')
    if (cleanup === 'resolve') close.resolve()
    else close.reject(new Error('fictional cleanup rejection'))
    await idle
    expect(cancel).toHaveBeenCalledOnce()
    expect(releaseLock).toHaveBeenCalledTimes(terminal === 'done' ? 1 : 0)
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 1, queued: 1 })
    expect(pb.dispatch).not.toHaveBeenCalled()
    expect(a.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts').all()).toEqual(durable)
    expect(a.repository.budget(a.view.handle.rootActionId).blockedCode).toBeNull()
    await a.owner.execute(a.request)
    expect(fetch).toHaveBeenCalledOnce()
    expect(acquire).toHaveBeenCalledTimes(2)
    scheduler.resetCredential(a.model)
    await pb.started
    pb.finish()
    await second
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 0 })
  })
})

describe('default owner adapter callback fallback', () => {
  it.each([
    ['done', 'closing'], ['done', 'revoked'], ['error', 'closing'], ['error', 'revoked'],
  ] as const)('fences isolated old DB resources after %s and %s while physical cleanup remains pending', async (terminal, lifecycle) => {
    vi.useFakeTimers()
    const close = deferredCleanup()
    const generateStream = vi.fn<ILLMProvider['generateStream']>((_model, _messages, options) => {
      if (terminal === 'done') options.onDone('visible', undefined, 'stop')
      else options.onError('LLM_REQUEST_FAILED')
      return close.promise.then(() => {
        options.onChunk('late text')
        options.onDone('late replacement', undefined, 'length')
        options.onError('LLM_CONTEXT_LENGTH_EXCEEDED')
        throw new Error('NETWORK_ERROR')
      })
    })
    vi.spyOn(LLMFactory, 'getProvider').mockReturnValue({ generateStream } as unknown as ILLMProvider)
    const scheduler = scheduling(), a = fixture('a', scheduler, undefined)
    const first = await a.owner.execute(a.request), original = structuredClone(first)
    expect(first.outcome.status).toBe(terminal === 'done' ? 'completed' : 'incomplete')
    if (lifecycle === 'closing') a.owner.requestProjectClose()
    else a.revoke()
    expect(a.owner.hasPhysicalInFlight()).toBe(true)
    await expect(a.owner.execute({ ...a.request, invocationNonce: 'new-after-lifecycle' })).rejects.toThrow(
      lifecycle === 'closing' ? 'GENERATION_OWNER_CLOSING' : 'FICTIONAL_GRANT_REVOKED')
    await vi.advanceTimersByTimeAsync(50)
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, quarantined: 1, blockedCredentials: 1 })
    // Production close waits for physical idle. Explicit suspend/close here exercises only fenced old resources.
    a.owner.suspendForProjectClose()
    a.db.close()
    const databaseFile = path.join(path.dirname(a.projectStorageRoot), 'project.db')
    const bytes = fs.readFileSync(databaseFile)
    const prepare = vi.spyOn(a.db, 'prepare'), exec = vi.spyOn(a.db, 'exec'), log = vi.spyOn(LLMHistoryRepository, 'logCall')
    let physicallyIdle = false
    const idle = a.owner.whenPhysicalIdle().then(() => { physicallyIdle = true })
    await Promise.resolve()
    expect(physicallyIdle).toBe(false)
    close.resolve()
    await idle
    expect(a.owner.hasPhysicalInFlight()).toBe(false)
    await expect(a.owner.execute(a.request)).rejects.toThrow(lifecycle === 'closing' ? 'GENERATION_OWNER_CLOSING' : 'GENERATION_OWNER_CLOSED')
    expect(prepare).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(fs.readFileSync(databaseFile)).toEqual(bytes)
    expect(first).toEqual(original)
    expect(generateStream).toHaveBeenCalledOnce()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 1 })
  })

  it.each(['done', 'error'] as const)('keeps the first %s callback when late callbacks and physical rejection follow', async terminal => {
    vi.useFakeTimers()
    const close = deferredCleanup()
    const generateStream: ILLMProvider['generateStream'] = (_model, _messages, options) => {
      options.onUsageEvidence?.({ protocol: 'openai', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        reasoningTokens: 0, accounting: 'included-in-completion', totalIncludesReasoning: true })
      if (terminal === 'done') options.onDone('visible', undefined, 'stop')
      else options.onError('LLM_REQUEST_FAILED')
      return close.promise.then(() => {
        options.onChunk('late text')
        options.onDone('replacement text', undefined, 'length')
        options.onError('LLM_CONTEXT_LENGTH_EXCEEDED')
        throw new Error('fictional late physical rejection')
      })
    }
    vi.spyOn(LLMFactory, 'getProvider').mockReturnValue({ generateStream } as ILLMProvider)
    const scheduler = scheduling(), a = fixture('a', scheduler, undefined)
    const first = await a.owner.execute(a.request)
    expect(first.outcome.status).toBe(terminal === 'done' ? 'completed' : 'incomplete')
    const durable = a.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts').all()
    expect(scheduler.getStats().occupied).toBe(1)
    close.resolve()
    await a.owner.whenPhysicalIdle()
    expect(a.db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts').all()).toEqual(durable)
    expect(a.repository.receipt(a.attempts()[0]!.attemptId).artifact?.text ?? '').toBe(terminal === 'done' ? 'visible' : '')
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 0 })
  })

  it.each(['complete', 'reject', 'throw'] as const)('keeps no-callback %s as the existing provider-failure category', async terminal => {
    const provider = { generateStream: vi.fn(() => {
      if (terminal === 'throw') throw new Error('fictional synchronous failure')
      return terminal === 'reject' ? Promise.reject(new Error('fictional adapter failure')) : Promise.resolve()
    }) } as unknown as ILLMProvider
    vi.spyOn(LLMFactory, 'getProvider').mockReturnValue(provider)
    const scheduler = scheduling(), a = fixture('a', scheduler, undefined)
    const first = await a.owner.execute(a.request)
    expect(first.outcome).toMatchObject({ status: 'incomplete', receipt: { failureCode: 'GENERATION_PROVIDER_FAILED' } })
    await a.owner.whenPhysicalIdle()
    expect(a.repository.budget(a.view.handle.rootActionId).blockedCode).toBeNull()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 0 })
    await a.owner.execute(a.request)
    expect(provider.generateStream).toHaveBeenCalledOnce()
  })

  describe.each(['reject', 'throw'] as const)('no-callback %s preserves the original rejection', terminal => {
    it.each([
      ...['NETWORK_ERROR', 'ECONNRESET', 'ETIMEDOUT', 'FETCH_FAILED'].map(code => ({ name: `Error ${code}`, error: new Error(code), failureCode: 'NETWORK_ERROR' })),
      ...TERMINAL_PROVIDER_FAILURE_CODES.map(code => ({ name: `Error ${code}`, error: new Error(code), failureCode: code })),
      { name: 'bare network string', error: 'NETWORK_ERROR', failureCode: 'GENERATION_PROVIDER_FAILED' },
      { name: 'bare context string', error: 'GENERATION_CONTEXT_LENGTH_EXCEEDED', failureCode: 'GENERATION_PROVIDER_FAILED' },
      { name: 'unmapped adapter context Error', error: new Error('LLM_CONTEXT_LENGTH_EXCEEDED'), failureCode: 'GENERATION_PROVIDER_FAILED' },
    ])('$name retains the existing service classification', async ({ error, failureCode }) => {
      const generateStream = vi.fn<ILLMProvider['generateStream']>(() => {
        if (terminal === 'throw') throw error
        return Promise.reject(error)
      })
      vi.spyOn(LLMFactory, 'getProvider').mockReturnValue({ generateStream } as unknown as ILLMProvider)
      const scheduler = scheduling(), a = fixture('a', scheduler, undefined)
      const first = await a.owner.execute(a.request)
      expect(first.outcome).toMatchObject({ status: 'incomplete', receipt: { failureCode } })
      await a.owner.whenPhysicalIdle()
      expect(a.repository.budget(a.view.handle.rootActionId).blockedCode).toBeNull()
      expect(scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 0 })
      await a.owner.execute(a.request)
      expect(generateStream).toHaveBeenCalledOnce()
    })
  })
})

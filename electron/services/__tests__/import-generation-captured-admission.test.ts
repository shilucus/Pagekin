import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { getCurrentProjectPath, getProjectDb } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { projectAccess } from '../project-access'
import { createMainGenerationOwner, type MainGenerationOwnerDependencies } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { MainGenerationScheduler } from '../generation-scheduler'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ImportRunExecutionAuthority } from '../../../src/shared/import-run'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(),
  getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const base = path.resolve('.runtime/creation-runtime-modernization/stage-6b-import-generation-tests')
const owners: ReturnType<typeof createMainGenerationOwner>[] = []
const databases: BetterSqlite3.Database[] = []
const roots: string[] = []
const releases: (() => void)[] = []
const schedulers: MainGenerationScheduler[] = []
const RUN_ID = 'fictional-shared-reference-run'
const slot = { runId: RUN_ID, stage: 'global' as const, batchId: 'done' }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const model: ModelProfile = { id: 'fictional-model', name: 'Fictional model', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', apiKey: 'fictional-not-a-credential', baseUrl: 'https://fictional.invalid/v1',
  temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
  capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
const task: GenerationTask = { purpose: 'import-global-facts', output: 'structured-data',
  messages: [{ role: 'user', content: 'Summarize the frozen fictional reference.' }] }
const stop: GenerationRunServiceDependencies['dispatch'] = async (_request, options) => {
  options.onVisible({ kind: 'delta', text: '{"fictional":"saved output"}' })
  return { finishReason: 'stop', usage: null }
}

function verifiedCleanupRoot(root: string): string {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const child = (parent: string, target: string) => {
    const relative = path.relative(parent, target)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
  }
  const workspace = path.resolve('.'), absolute = path.resolve(root)
  child(workspace, base)
  child(base, absolute)
  for (let directory = absolute; ; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(fs.realpathSync.native(directory)) !== normalize(directory)) throw new Error('FICTIONAL_CLEANUP_LINK')
    if (normalize(directory) === normalize(workspace)) break
  }
  const real = fs.realpathSync.native(absolute)
  child(fs.realpathSync.native(base), real)
  const pending = [absolute]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name), actual = fs.realpathSync.native(target)
      if (fs.lstatSync(target).isSymbolicLink() || normalize(actual) !== normalize(target)) throw new Error('FICTIONAL_CLEANUP_LINK')
      child(real, actual)
      if (entry.isDirectory()) pending.push(target)
    }
  }
  return absolute
}

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const owner of owners.splice(0)) {
    owner.suspendForProjectClose()
    await owner.whenPhysicalIdle()
  }
  for (const scheduler of schedulers.splice(0)) scheduler.close()
  for (const database of databases.splice(0)) database.close()
  for (const root of roots.splice(0)) fs.rmSync(verifiedCleanupRoot(root), { recursive: true, force: true })
  vi.restoreAllMocks()
})

function book(label: string) {
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'book-'))
  roots.push(root)
  prepareCanonicalStorageFixture(root)
  const project = projectAccess.probeExistingProject(root)
  if (project.kind !== 'manifest') throw new Error('FICTIONAL_PROJECT_IDENTITY_MISSING')
  const database = new Database(path.join(root, '.ai-novel', 'project.db'))
  databases.push(database)
  vi.mocked(getProjectDb).mockReturnValue(database)
  vi.mocked(getCurrentProjectPath).mockReturnValue(root)
  database.prepare("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main',?,100)").run(`Fictional ${label}`)
  const content = `Fictional ${label}: a sealed letter arrives at the harbor.`
  ImportRunRepository.prepare({ runId: RUN_ID, purpose: 'reference', sourceFingerprint: hash(`source:${label}`), locale: 'en-US',
    sourceDisplay: [{ displayName: `fictional-${label}.txt`, mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: `Fictional ${label}`, content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }] })
  const execution = ImportRunRepository.startOrResume(RUN_ID, 'fictional-owner', Date.now(), 60_000).execution
  database.prepare("UPDATE import_runs SET stage='global' WHERE id=?").run(RUN_ID)
  return { root, database, projectId: project.projectId, execution }
}

type FictionalBook = ReturnType<typeof book>

function ownerFor(book: FictionalBook, options: Pick<MainGenerationOwnerDependencies, 'scheduling' | 'beforeDispatch'> = {}, dispatch = stop) {
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch)
  const source = { db: book.database, projectStorageRoot: book.root, globalDataRoot: book.root,
    readBuiltinPrompt: (key: string) => JSON.stringify({ key, content: 'Frozen fictional prompt.', systemRole: 'Fictional writing assistant.' }) }
  const epoch = 'fictional-generation-epoch'
  const owner = createMainGenerationOwner({ ...options, database: book.database, projectPath: book.root, projectId: book.projectId,
    epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model,
    dispatch: spy,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(source, { ...selection, projectId: book.projectId,
      epoch, modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(source, previous, epoch, modelReceipt,
      readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  owners.push(owner)
  const selection: BeginGenerationRequest = { operation: 'import-global-facts', uiActionNonce: 'fictional-global', modelId: model.id,
    promptKeys: ['infer_novel_config_with_vectors', 'infer_novel_config'], skillStages: ['planning'], selectedDraftIds: [],
    selectedFinalizedDraftIds: [], output: 'structured-data', importSlot: slot, importExecution: book.execution }
  const handle = owner.begin(selection).handle
  const execute = (execution?: ImportRunExecutionAuthority, ordinal = 0) => owner.executeImportGeneration({ handle, execution, ordinal, task })
  const attempts = () => book.database.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()
  return { owner, spy, execute, attempts, handle }
}

function scheduler() {
  const result = new MainGenerationScheduler({ global: 1, provider: 1, credential: 1, model: 1, project: 1,
    maxQueued: 8, maxQuarantined: 2, interactiveBurst: 1 }, 32)
  schedulers.push(result)
  return result
}

describe('captured reference generation admission', () => {
  it('reads A authority/effects with colliding cancelled B current and leaves B unchanged', async () => {
    const a = book('A'), f = ownerFor(a)
    const b = book('B')
    b.database.prepare("UPDATE import_runs SET status='cancelled',cancel_requested=1 WHERE id=?").run(RUN_ID)
    const before = hash(b.database.serialize())
    expect((await f.execute(a.execution)).outcome.status).toBe('completed')
    expect(f.spy).toHaveBeenCalledOnce()
    expect(f.attempts()).toBe(1)
    expect(hash(b.database.serialize())).toBe(before)
  })

  it('refuses invalid A instead of borrowing valid same-ID B execution', async () => {
    const a = book('A'), f = ownerFor(a)
    const b = book('B'), before = hash(b.database.serialize())
    a.database.prepare('UPDATE import_runs SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, RUN_ID)
    await expect(f.execute(a.execution)).rejects.toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(f.spy).not.toHaveBeenCalled()
    expect(f.attempts()).toBe(0)
    expect(hash(b.database.serialize())).toBe(before)
  })

  it.each([
    ['takeover', 'execution_epoch=execution_epoch+1', 'IMPORT_RUN_EXECUTION_STALE'],
    ['expiry', 'lease_expires_at=0', 'IMPORT_RUN_EXECUTION_STALE'],
    ['cancel', 'cancel_requested=1', 'GENERATION_ACTION_CANCELLED'],
    ['stage', "stage='style'", 'GENERATION_IMPORT_EXECUTION_STALE'],
    ['status', "status='failed'", 'IMPORT_RUN_EXECUTION_STALE'],
  ])('requalifies queued %s before reserving an attempt', async (_kind, mutation, code) => {
    const a = book('A'), queue = scheduler()
    const held = await queue.acquire({ projectKey: 'fictional-blocker', model, lane: 'interactive', signal: new AbortController().signal })
    releases.push(() => held.finish())
    const f = ownerFor(a, { scheduling: { admission: queue, projectKey: 'fictional-A', quarantineAfterMs: 50 } })
    const pending = f.execute(a.execution).then(value => ({ value }), error => ({ error: error as Error }))
    await vi.waitFor(() => expect(queue.getStats().queued).toBe(1))
    a.database.prepare(`UPDATE import_runs SET ${mutation} WHERE id=?`).run(RUN_ID)
    held.finish()
    const result = await pending
    expect('error' in result ? result.error.message : null).toBe(code)
    expect(f.spy).not.toHaveBeenCalled()
    expect(f.attempts()).toBe(0)
    expect(queue.getStats()).toMatchObject({ queued: 0, occupied: 0 })
  })

  it('uses the frozen authority when the caller mutates its object during queueing', async () => {
    const a = book('A'), queue = scheduler()
    const held = await queue.acquire({ projectKey: 'fictional-blocker', model, lane: 'interactive', signal: new AbortController().signal })
    releases.push(() => held.finish())
    const f = ownerFor(a, { scheduling: { admission: queue, projectKey: 'fictional-A', quarantineAfterMs: 50 } })
    const execution = { owner: a.execution.owner, epoch: a.execution.epoch }
    const pending = f.execute(execution).catch(error => error as Error)
    await vi.waitFor(() => expect(queue.getStats().queued).toBe(1))
    a.database.prepare('UPDATE import_runs SET execution_owner=?,execution_epoch=execution_epoch+1 WHERE id=?').run('fictional-takeover', RUN_ID)
    execution.owner = 'fictional-takeover'
    execution.epoch += 1
    held.finish()
    expect(await pending).toEqual(expect.objectContaining({ message: 'IMPORT_RUN_EXECUTION_STALE' }))
    expect(f.spy).not.toHaveBeenCalled()
    expect(f.attempts()).toBe(0)
  })

  it('rechecks the native reserve/mark boundary even without a scheduler', async () => {
    const a = book('A')
    const f = ownerFor(a, { beforeDispatch: () => {
      a.database.prepare('UPDATE import_runs SET execution_epoch=execution_epoch+1 WHERE id=?').run(RUN_ID)
    } })
    await expect(f.execute(a.execution)).rejects.toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(f.spy).not.toHaveBeenCalled()
    expect(f.attempts()).toBe(0)
    expect(a.database.prepare('SELECT blocked_code FROM generation_roots').pluck().get()).toBeNull()
  })

  it.each(['stop', 'unknown'] as const)('replays original %s ordinal after execution revocation without redispatch', async finishReason => {
    const a = book('A')
    const f = ownerFor(a, {}, async (_request, options) => {
      options.onVisible({ kind: 'delta', text: '{"fictional":"original output"}' })
      return { finishReason, usage: null }
    })
    const first = await f.execute(a.execution)
    a.database.prepare('UPDATE import_runs SET execution_epoch=execution_epoch+1 WHERE id=?').run(RUN_ID)
    const replay = await f.execute()
    expect(replay.outcome).toMatchObject({ status: first.outcome.status, content: first.outcome.content,
      finishReason: first.outcome.finishReason })
    expect(replay.outcome.receipt.visibleArtifact).toEqual(first.outcome.receipt.visibleArtifact)
    expect(replay.outcome.receipt.model).toEqual(first.outcome.receipt.model)
    expect(replay.run.handle).toEqual(first.run.handle)
    expect(f.spy).toHaveBeenCalledOnce()
    expect(f.attempts()).toBe(1)
    await expect(f.execute(a.execution, 1)).rejects.toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(f.spy).toHaveBeenCalledOnce()
    expect(f.attempts()).toBe(1)
  })
})

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportRunLocale, ImportRunPrepareRequest } from '../../../src/shared/import-run'
import type { ReferenceRefreshRequest } from '../../../src/shared/reference-refresh-contract'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { ReferenceImportGrantRepository } from '../../repositories/reference-import-grant-repository'
import { captureReferenceImportResources } from '../../knowledge-base'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
// @ts-expect-error Existing JavaScript cleanup helper has no declaration.
import { removeTemporaryTree } from '../../../test/helpers/remove-temporary-tree.mjs'
import { projectRuntimeHost, type ProjectRuntime } from '../project-runtime'
import { ReferenceKnowledgeAuthority, ReferenceKnowledgeExecutionFailure } from '../reference-knowledge-authority'
import { acquireImportRunParentFlight } from '../import-stage-flight'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const apiKey = Buffer.alloc(32, 31)
const content = 'A fictional chapter used only by the refresh authority fixture.'

let temporaryParent = ''
let temporaryRoot = ''
let runtime: ProjectRuntime
let sender: EventEmitter & { isDestroyed(): boolean }
let authority: ReferenceKnowledgeAuthority
let runId: string
let prepared: ReturnType<ReferenceKnowledgeAuthority['prepare']>

function verifiedCleanupRoot(): string {
  const normal = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const parent = path.resolve(temporaryParent)
  const target = path.resolve(temporaryRoot)
  if (normal(path.dirname(target)) !== normal(parent) || !path.basename(target).startsWith('pk-reference-refresh-driver-')) {
    throw new Error('FIXTURE_CLEANUP_OUTSIDE_PARENT')
  }
  for (const directory of [parent, target]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normal(fs.realpathSync.native(directory)) !== normal(directory)) {
      throw new Error('FIXTURE_CLEANUP_LINK')
    }
  }
  const pending = [target]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      const stat = fs.lstatSync(child)
      if (stat.isSymbolicLink() || normal(fs.realpathSync.native(child)) !== normal(child)) throw new Error('FIXTURE_CLEANUP_LINK')
      if (entry.isDirectory()) pending.push(child)
    }
  }
  return target
}

function makeRequest(): ImportRunPrepareRequest {
  return { runId, purpose: 'reference', sourceFingerprint: digest(runId), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional-reference.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'Fictional', content, contentSize: Buffer.byteLength(content), contentFingerprint: digest(content) }] }
}

function makeAuthority() {
  authority = new ReferenceKnowledgeAuthority(runtime, {
    resources: captureReferenceImportResources(runtime),
    captureEmbedding: () => ({ modelId: 'fictional-embedding', protocol: 'openai', model: {
      provider: 'fictional-provider', baseUrl: 'https://fictional.invalid', apiKey: '', modelName: 'fictional-embedding',
      embeddingOptions: { chunkSize: 500, chunkOverlap: 50, batchSize: 50, concurrencyLimit: 1 },
    } }),
    importReference: async input => ({ success: true, docId: digest(input.binding.stableKey) }),
  })
  prepared = authority.prepare(sender, { operationId: randomUUID(), runId, executionOwner: randomUUID() },
    () => projectRuntimeHost.assertOpen(runtime))
  runtime.database.prepare("UPDATE import_runs SET stage='refresh' WHERE id=?").run(runId)
}

function refreshRequest(): ReferenceRefreshRequest {
  return { reference: prepared.reference, execution: { owner: prepared.execution.owner, epoch: prepared.execution.epoch } }
}

function hooks(overrides: Partial<{
  signal: AbortSignal; assertCurrent(): void; refresh(): Promise<void>; progress(value: 100): void;
  failureMessage(code: string, locale: ImportRunLocale): string
}> = {}) {
  return { signal: new AbortController().signal, assertCurrent: vi.fn(), refresh: vi.fn(async () => undefined),
    progress: vi.fn(), failureMessage: (code: string, locale: ImportRunLocale) => `${locale}:${code}`, ...overrides }
}

beforeEach(() => {
  temporaryParent = fs.realpathSync.native(os.tmpdir())
  temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'pk-reference-refresh-driver-'))
  const projectRoot = path.join(temporaryRoot, 'project')
  fs.mkdirSync(projectRoot)
  openCanonicalProjectFixture(projectRoot, apiKey)
  runtime = projectRuntimeHost.getActiveView()!
  sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  runId = randomUUID()
  ImportRunRepository.prepare(makeRequest())
  makeAuthority()
})

afterEach(() => {
  const cleanupErrors: Error[] = []
  if (authority) {
    try { authority.requestProjectClose(); authority.retire() }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error('FIXTURE_AUTHORITY_CLEANUP_FAILED')) }
  }
  for (const openRuntime of projectRuntimeHost.getOpenRuntimes()) {
    try { projectRuntimeHost.releaseIdle(openRuntime) }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error('FIXTURE_RUNTIME_CLEANUP_FAILED')) }
  }
  try { if (temporaryRoot) removeTemporaryTree(verifiedCleanupRoot(), temporaryParent) }
  catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error('FIXTURE_TREE_CLEANUP_FAILED')) }
  temporaryParent = ''; temporaryRoot = ''
  vi.restoreAllMocks()
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'REFERENCE_REFRESH_FIXTURE_CLEANUP_FAILED')
})

describe('main-owned reference refresh completion', () => {
  it('allows only the original issuance to join a completed run and finish its active grant', async () => {
    runtime.database.exec("CREATE TRIGGER fictional_refresh_grant_failure BEFORE UPDATE OF state ON reference_import_grants WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fictional grant failure'); END")
    await expect(authority.executeRefresh(sender, refreshRequest(), hooks())).rejects.toBeInstanceOf(ReferenceKnowledgeExecutionFailure)
    expect(ImportRunRepository.get(runId)).toMatchObject({ status: 'completed', stage: 'completed' })
    runtime.database.exec('DROP TRIGGER fictional_refresh_grant_failure')
    const request = refreshRequest()
    const parent = acquireImportRunParentFlight(runtime.database, runId)
    const other = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    expect(() => authority.beginRun(other, request.reference, request.execution, parent.token))
      .toThrow('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REQUIRED')
    expect(() => authority.beginRun(sender, request.reference, { ...request.execution, epoch: request.execution.epoch + 1 }, parent.token))
      .toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_MISMATCH')
    const grantId = prepared.reference.grantId
    const originalHash = runtime.database.prepare('SELECT request_hash FROM reference_import_grants WHERE grant_id=?').pluck().get(grantId)
    runtime.database.prepare('UPDATE reference_import_grants SET request_hash=? WHERE grant_id=?').run(digest('other'), grantId)
    expect(() => authority.beginRun(sender, request.reference, request.execution, parent.token))
      .toThrow('REFERENCE_IMPORT_GRANT_SCOPE_MISMATCH')
    runtime.database.prepare('UPDATE reference_import_grants SET request_hash=? WHERE grant_id=?').run(originalHash, grantId)
    const releaseRun = authority.beginRun(sender, request.reference, request.execution, parent.token)
    const refreshHooks = hooks()
    const result = await authority.executeRefresh(sender, request, refreshHooks, parent.token)
    expect(result).toMatchObject({ run: { status: 'completed' }, execution: null, replayed: true })
    expect(refreshHooks.refresh).not.toHaveBeenCalled()
    expect(authority.hasIssuance(grantId)).toBe(true)
    releaseRun(); parent.release()
    expect(authority.hasIssuance(grantId)).toBe(false)
  })
  it('preserves projection, checkpoint, progress, run completion, then original grant completion order', async () => {
    const order: string[] = []
    const refreshHooks = hooks({ refresh: vi.fn(async () => { order.push('projection') }),
      progress: vi.fn(() => { order.push('progress') }) })
    const originalCompleteBatch = ImportRunRepository.completeBatch
    const completeBatch = vi.spyOn(ImportRunRepository, 'completeBatch').mockImplementation((...args) => {
      const result = originalCompleteBatch.apply(ImportRunRepository, args)
      order.push('checkpoint')
      return result
    })
    const originalCompleteRun = ImportRunRepository.complete
    const completeRun = vi.spyOn(ImportRunRepository, 'complete').mockImplementation((...args) => {
      const result = originalCompleteRun.apply(ImportRunRepository, args)
      order.push('run')
      return result
    })
    const originalCompleteGrant = ReferenceImportGrantRepository.prototype.complete
    const completeGrant = vi.spyOn(ReferenceImportGrantRepository.prototype, 'complete').mockImplementation(function (this: ReferenceImportGrantRepository, ref) {
      const result = originalCompleteGrant.call(this, ref)
      order.push('grant')
      return result
    })

    const result = await authority.executeRefresh(sender, refreshRequest(), refreshHooks)
    expect(result).toMatchObject({ version: 1, run: { status: 'completed', stage: 'completed' }, execution: null, replayed: false })
    expect(ImportRunRepository.get(runId)).not.toHaveProperty('manifestFingerprint')
    expect(order).toEqual(['projection', 'checkpoint', 'progress', 'run', 'grant'])
    expect(refreshHooks.refresh).toHaveBeenCalledTimes(1)
    expect(completeBatch).toHaveBeenCalledTimes(1)
    expect(completeRun).toHaveBeenCalledTimes(1)
    expect(completeGrant).toHaveBeenCalledTimes(1)
  })

  it('records projection failure without a checkpoint and leaves the original grant active', async () => {
    const refreshHooks = hooks({ refresh: vi.fn(async () => { throw new Error('IMPORT_RUN_REFRESH_PROJECTION_FAILED') }) })
    await expect(authority.executeRefresh(sender, refreshRequest(), refreshHooks)).rejects.toMatchObject({
      name: 'ReferenceKnowledgeExecutionFailure', errorCode: 'IMPORT_RUN_REFRESH_PROJECTION_FAILED',
      displayMessage: 'en-US:IMPORT_RUN_REFRESH_PROJECTION_FAILED',
    } satisfies Partial<ReferenceKnowledgeExecutionFailure>)
    expect(ImportRunRepository.get(runId)).toMatchObject({ status: 'failed', stage: 'refresh', completedBatches: {} })
    expect(runtime.database.prepare('SELECT state FROM reference_import_grants WHERE grant_id=?').pluck().get(prepared.reference.grantId)).toBe('active')
  })

  it('after a completed run retries only grant completion, then serves completed history read-only', async () => {
    runtime.database.exec("CREATE TRIGGER fictional_refresh_grant_failure BEFORE UPDATE OF state ON reference_import_grants WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fictional grant failure'); END")
    const refreshHooks = hooks()
    const completeRun = vi.spyOn(ImportRunRepository, 'complete')
    await expect(authority.executeRefresh(sender, refreshRequest(), refreshHooks)).rejects.toBeInstanceOf(ReferenceKnowledgeExecutionFailure)
    expect(ImportRunRepository.get(runId)).toMatchObject({ status: 'completed', stage: 'completed' })
    expect(refreshHooks.refresh).toHaveBeenCalledTimes(1)
    runtime.database.exec('DROP TRIGGER fictional_refresh_grant_failure')

    const retryHooks = hooks()
    const retried = await authority.executeRefresh(sender, refreshRequest(), retryHooks)
    expect(retried).toMatchObject({ run: { status: 'completed' }, execution: null, replayed: true })
    expect(retryHooks.refresh).not.toHaveBeenCalled()
    expect(completeRun).toHaveBeenCalledTimes(1)

    const historicalHooks = hooks()
    const history = await authority.executeRefresh(sender, refreshRequest(), historicalHooks)
    expect(history).toMatchObject({ run: { status: 'completed' }, execution: null, replayed: true })
    expect(historicalHooks.refresh).not.toHaveBeenCalled()
    expect(historicalHooks.progress).not.toHaveBeenCalled()
  })
})

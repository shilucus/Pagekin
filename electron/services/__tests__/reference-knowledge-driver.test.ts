import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportRunLocale, ImportRunPrepareRequest } from '../../../src/shared/import-run'
import type { ReferenceKnowledgeProgress } from '../../../src/shared/reference-knowledge-contract'
import { LEGACY_VECTOR_MIGRATION_BLOCKED } from '../knowledge-base-migration-error'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { captureReferenceImportResources } from '../../knowledge-base'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
// @ts-expect-error Existing JavaScript cleanup helper has no declaration.
import { removeTemporaryTree } from '../../../test/helpers/remove-temporary-tree.mjs'
import { projectRuntimeHost, type ProjectRuntime } from '../project-runtime'
import { ReferenceKnowledgeAuthority, ReferenceKnowledgeExecutionFailure,
  assertReferenceKnowledgeUnmanagedMutationAllowed } from '../reference-knowledge-authority'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const apiKey = Buffer.alloc(32, 31)
const contents = [
  'Fictional courier finds a blue glass key.',
  'Fictional keeper hides the key beneath a clock.',
]
type FixtureBinding = { stableKey: string; content: string }
type FixtureImport = (input: { binding: FixtureBinding }) => Promise<{
  success: boolean; docId?: string; idempotent?: boolean; errorCode?: string
}>

let temporaryParent = ''
let temporaryRoot = ''
let runtime: ProjectRuntime
let sender: EventEmitter & { isDestroyed(): boolean }
let authority: ReferenceKnowledgeAuthority
let runId: string
let request: ImportRunPrepareRequest
let prepared: ReturnType<ReferenceKnowledgeAuthority['prepare']>
let importReference: ReturnType<typeof vi.fn<FixtureImport>>

function verifiedCleanupRoot(): string {
  const normal = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const parent = path.resolve(temporaryParent)
  const target = path.resolve(temporaryRoot)
  if (normal(path.dirname(target)) !== normal(parent) || !path.basename(target).startsWith('pk-reference-knowledge-driver-')) {
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
      if (stat.isSymbolicLink() || normal(fs.realpathSync.native(child)) !== normal(child)) {
        throw new Error('FIXTURE_CLEANUP_LINK')
      }
      if (entry.isDirectory()) pending.push(child)
    }
  }
  return target
}

function createDocument(binding: FixtureBinding) {
  const docId = digest(`reference-import:${binding.stableKey}`)
  runtime.database.prepare(`
    INSERT INTO import_reference_documents (
      document_id, idempotency_key_hash, content_hash, chunk_set_hash,
      expected_chunk_count, corpus_kind, state
    ) VALUES (?, ?, ?, ?, 1, 'reference', 'committed')
    ON CONFLICT(document_id) DO NOTHING
  `).run(docId, digest(binding.stableKey), digest(binding.content), digest('fictional-chunks'))
  return { success: true, docId, idempotent: false }
}

function makeAuthority() {
  authority = new ReferenceKnowledgeAuthority(runtime, {
    resources: captureReferenceImportResources(runtime),
    captureEmbedding: () => ({ modelId: 'fictional-embedding', protocol: 'openai', model: {
      provider: 'fictional-provider', baseUrl: 'https://fictional.invalid', apiKey: '', modelName: 'fictional-embedding',
      embeddingOptions: { chunkSize: 500, chunkOverlap: 50, batchSize: 50, concurrencyLimit: 1 },
    } }),
    importReference: importReference,
  })
  prepared = authority.prepare(sender, {
    operationId: randomUUID(), runId, executionOwner: randomUUID(),
  }, () => projectRuntimeHost.assertOpen(runtime))
}

function executionRequest() {
  return { reference: prepared.reference,
    execution: { owner: prepared.execution.owner, epoch: prepared.execution.epoch } }
}

function hooks(progress: (event: ReferenceKnowledgeProgress) => void = vi.fn()) {
  return {
    progress,
    failureMessage: (code: string, locale: ImportRunLocale, source: 'result' | 'throw') => `${locale}:${source}:${code}`,
  }
}

beforeEach(() => {
  temporaryParent = fs.realpathSync.native(os.tmpdir())
  temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'pk-reference-knowledge-driver-'))
  const projectRoot = path.join(temporaryRoot, 'project')
  fs.mkdirSync(projectRoot)
  openCanonicalProjectFixture(projectRoot, apiKey)
  runtime = projectRuntimeHost.getActiveView()!
  sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  runId = randomUUID()
  request = {
    runId, purpose: 'reference', sourceFingerprint: digest('fictional-source'), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional-reference.txt', mediaType: 'text/plain',
      size: contents.reduce((size, content) => size + Buffer.byteLength(content), 0) }],
    chapters: contents.map((content, index) => ({ number: index + 1, title: `Chapter ${index + 1}`,
      content, contentSize: Buffer.byteLength(content), contentFingerprint: digest(content) })),
  }
  ImportRunRepository.prepare(request)
  importReference = vi.fn(async ({ binding }: { binding: FixtureBinding }) => createDocument(binding))
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
  temporaryParent = ''
  temporaryRoot = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'REFERENCE_KNOWLEDGE_FIXTURE_CLEANUP_FAILED')
})

describe('main-owned reference knowledge driver', () => {
  it('imports in original contiguous batches, persists receipts before progress, advances to global, and replays without fetch', async () => {
    const events: unknown[] = []
    const receiptCountsAtChapterProgress: number[] = []
    const progress = vi.fn((event: ReferenceKnowledgeProgress) => {
      if (event.kind === 'chapter') {
        receiptCountsAtChapterProgress.push(
          runtime.database.prepare('SELECT COUNT(*) FROM import_run_knowledge_receipts').pluck().get() as number)
      }
      events.push(event)
    })
    const input = executionRequest()
    const first = await authority.executeKnowledge(sender, input, hooks(progress))

    expect(first.run.stage).toBe('global')
    expect(importReference).toHaveBeenCalledTimes(2)
    expect(runtime.database.prepare('SELECT chapter_number FROM import_run_knowledge_receipts ORDER BY chapter_number').pluck().all())
      .toEqual([1, 2])
    expect(receiptCountsAtChapterProgress).toEqual([1, 2])
    expect(first.run.completedBatches.knowledge).toHaveLength(1)
    expect(progress.mock.calls.map(([event]) => event.kind)).toEqual(['chapter', 'chapter', 'batch'])

    const replay = await authority.executeKnowledge(sender, input, hooks())
    expect(replay.run.stage).toBe('global')
    expect(importReference).toHaveBeenCalledTimes(2)
  })

  it('keeps committed facts when the best-effort progress projection throws', async () => {
    const progress = vi.fn(() => { throw new Error('FICTIONAL_VIEW_SEND_FAILURE') })
    const result = await authority.executeKnowledge(sender, executionRequest(), hooks(progress))

    expect(result.run.stage).toBe('global')
    expect(progress).toHaveBeenCalledTimes(3)
    expect(runtime.database.prepare('SELECT chapter_number FROM import_run_knowledge_receipts ORDER BY chapter_number').pluck().all())
      .toEqual([1, 2])
    expect(result.run.completedBatches.knowledge).toHaveLength(1)
  })

  it('joins duplicate execution and blocks manual import, resume, and unmanaged writers until drain', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    importReference.mockImplementationOnce(async ({ binding }: { binding: FixtureBinding }) => {
      await gate
      return createDocument(binding)
    })
    const input = executionRequest()
    const first = authority.executeKnowledge(sender, input, hooks())
    void first.catch(() => {})
    const joined = authority.executeKnowledge(sender, input, hooks())
    expect(joined).toBe(first)
    try {
      await vi.waitFor(() => expect(importReference).toHaveBeenCalledOnce())
      expect(() => authority.resume(sender, prepared.reference)).toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
      await expect(authority.importChapter(sender, { reference: prepared.reference, chapterNumber: 1,
        execution: input.execution })).rejects.toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
      expect(() => authority.prepare(sender, { operationId: randomUUID(), runId,
        executionOwner: randomUUID() }, () => projectRuntimeHost.assertOpen(runtime)))
        .toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
      expect(() => assertReferenceKnowledgeUnmanagedMutationAllowed(runtime.database, runId))
        .toThrow('KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE')
    } finally {
      release()
      await Promise.allSettled([first])
    }
    expect(() => assertReferenceKnowledgeUnmanagedMutationAllowed(runtime.database, runId)).not.toThrow()
  })

  it('does not start the whole-stage loop while a manually admitted chapter is already in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    importReference.mockImplementationOnce(async ({ binding }: { binding: FixtureBinding }) => {
      await gate
      return createDocument(binding)
    })
    const input = executionRequest()
    const manual = authority.importChapter(sender, { reference: prepared.reference,
      chapterNumber: 1, execution: input.execution })
    void manual.catch(() => {})
    try {
      await vi.waitFor(() => expect(importReference).toHaveBeenCalledOnce())
      expect(() => authority.executeKnowledge(sender, input, hooks()))
        .toThrow('KNOWLEDGE_BASE_REFERENCE_IMPORT_IN_FLIGHT')
    } finally {
      release()
      await Promise.allSettled([manual])
    }
    await expect(manual).resolves.toMatchObject({ success: true })
    await expect(authority.executeKnowledge(sender, input, hooks())).resolves.toMatchObject({ run: { stage: 'global' } })
    expect(importReference).toHaveBeenCalledTimes(3)
  })

  it('keeps migration failure distinct from cancellation and persists the safe legacy explanation', async () => {
    importReference.mockResolvedValueOnce({ success: false, errorCode: LEGACY_VECTOR_MIGRATION_BLOCKED })
    const failureHooks = hooks()
    await expect(authority.executeKnowledge(sender, executionRequest(), failureHooks)).rejects.toMatchObject({
      errorCode: LEGACY_VECTOR_MIGRATION_BLOCKED,
      displayMessage: `en-US:result:${LEGACY_VECTOR_MIGRATION_BLOCKED}`,
    } satisfies Partial<ReferenceKnowledgeExecutionFailure>)
    expect(ImportRunRepository.get(runId, runtime)).toMatchObject({ status: 'failed', stage: 'knowledge',
      lastError: `en-US:result:${LEGACY_VECTOR_MIGRATION_BLOCKED}` })
    expect(importReference).toHaveBeenCalledOnce()
  })

  it('renews the captured lease during a long chapter and clears its heartbeat after drain', async () => {
    vi.useFakeTimers()
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    importReference.mockImplementationOnce(async ({ binding }: { binding: FixtureBinding }) => {
      markStarted()
      await gate
      return createDocument(binding)
    })
    const pending = authority.executeKnowledge(sender, executionRequest(), hooks())
    void pending.catch(() => {})
    try {
      await started
      const before = runtime.database.prepare(`SELECT lease_expires_at, execution_owner, execution_epoch
        FROM import_runs WHERE id=?`).get(runId) as { lease_expires_at: number; execution_owner: string; execution_epoch: number }
      await vi.advanceTimersByTimeAsync(60_000)
      const after = runtime.database.prepare(`SELECT lease_expires_at, execution_owner, execution_epoch
        FROM import_runs WHERE id=?`).get(runId) as { lease_expires_at: number; execution_owner: string; execution_epoch: number }
      expect(after.lease_expires_at).toBeGreaterThan(before.lease_expires_at)
      expect(after.execution_owner).toBe(before.execution_owner)
      expect(after.execution_epoch).toBe(before.execution_epoch)
      release()
      await expect(pending).resolves.toMatchObject({ run: { stage: 'global' } })
      expect(vi.getTimerCount()).toBe(0)
      expect(runtime.database.prepare('SELECT COUNT(*) FROM import_run_knowledge_receipts').pluck().get()).toBe(2)
    } finally {
      release()
      await Promise.allSettled([pending])
      vi.useRealTimers()
    }
  })

  it('preserves a delayed structured chapter failure over revoke and heartbeat cancellation', async () => {
    vi.useFakeTimers()
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    importReference.mockImplementationOnce(async () => {
      markStarted()
      await gate
      return { success: false, errorCode: LEGACY_VECTOR_MIGRATION_BLOCKED }
    })
    const pending = authority.executeKnowledge(sender, executionRequest(), hooks())
    void pending.catch(() => {})
    try {
      await started
      await vi.advanceTimersByTimeAsync(60_000)
      authority.revoke(sender, prepared.reference)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(vi.getTimerCount()).toBe(0)
      release()
      await expect(pending).rejects.toMatchObject({
        errorCode: LEGACY_VECTOR_MIGRATION_BLOCKED,
        displayMessage: `en-US:result:${LEGACY_VECTOR_MIGRATION_BLOCKED}`,
      } satisfies Partial<ReferenceKnowledgeExecutionFailure>)
      expect(ImportRunRepository.get(runId, runtime)).toMatchObject({ status: 'failed', stage: 'knowledge',
        lastError: `en-US:result:${LEGACY_VECTOR_MIGRATION_BLOCKED}` })
      expect(runtime.database.prepare('SELECT COUNT(*) FROM import_run_knowledge_receipts').pluck().get()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release()
      await Promise.allSettled([pending])
      vi.useRealTimers()
    }
  })

  it('keeps the chapter failure primary when safe failure persistence also fails', async () => {
    importReference.mockRejectedValueOnce(new Error('EMBEDDING_FICTIONAL_FAILURE'))
    const persistenceError = new Error('IMPORT_RUN_STORAGE_FAILURE')
    vi.spyOn(ImportRunRepository, 'fail').mockImplementationOnce(() => { throw persistenceError })

    await expect(authority.executeKnowledge(sender, executionRequest(), hooks())).rejects.toMatchObject({
      errorCode: 'EMBEDDING_FICTIONAL_FAILURE',
      displayMessage: 'en-US:throw:EMBEDDING_FICTIONAL_FAILURE',
      secondaryErrors: [expect.objectContaining({ message: 'IMPORT_RUN_STORAGE_FAILURE' })],
    })
  })

  it('persists capability revocation as failure when the issuance was not stopped', async () => {
    importReference.mockRejectedValueOnce(new Error('KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REVOKED'))

    await expect(authority.executeKnowledge(sender, executionRequest(), hooks())).rejects.toMatchObject({
      errorCode: 'KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REVOKED',
      displayMessage: 'en-US:throw:KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REVOKED',
    } satisfies Partial<ReferenceKnowledgeExecutionFailure>)
    expect(ImportRunRepository.get(runId, runtime)).toMatchObject({ status: 'failed', stage: 'knowledge',
      lastError: 'en-US:throw:KNOWLEDGE_BASE_REFERENCE_CAPABILITY_REVOKED' })
  })

  it('applies revoke at the next chapter boundary after the committed chapter receipt', async () => {
    const input = executionRequest()
    const progress = vi.fn((event: ReferenceKnowledgeProgress) => {
      if (event.kind === 'chapter') authority.revoke(sender, prepared.reference)
    })
    await expect(authority.executeKnowledge(sender, input, hooks(progress))).rejects.toMatchObject({
      errorCode: 'IMPORT_RUN_CANCELLED',
      displayMessage: 'en-US:throw:IMPORT_RUN_CANCELLED',
    } satisfies Partial<ReferenceKnowledgeExecutionFailure>)
    expect(importReference).toHaveBeenCalledOnce()
    expect(runtime.database.prepare('SELECT chapter_number FROM import_run_knowledge_receipts').pluck().all()).toEqual([1])
    expect(ImportRunRepository.get(runId, runtime)?.status).toBe('cancelled')
  })
})

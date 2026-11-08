import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getProjectDb, initProjectDatabase } from '../../database'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'
import { captureReferenceImportResources } from '../../knowledge-base'
import { readPortableRuntimeFreeze } from '../../services/portable-runtime-freeze'
import { CharacterProposalService } from '../../services/character-proposal-service'
import { proveCharacterProposal } from '../../services/generation-character-proposal-proof'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ImportRunRepository, type CapturedImportRunContext } from '../import-run-repository'
import { ImportGlobalFactsRepository } from '../import-global-facts-repository'
import { BlueprintRepository, type BlueprintRangeCommitReceipt } from '../blueprint-repository'
import { GenerationRunRepository } from '../generation-run-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { ReferenceImportGrantRepository } from '../reference-import-grant-repository'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
import type {
  ImportRunExecutionLease, ImportRunPrepareEffectReceiptRequest, ImportRunPrepareRequest,
} from '../../../src/shared/import-run'
import type { ImportGlobalFactsRequest } from '../../../src/shared/import-global-facts'

const RUN_ID = 'fictional-captured-runtime-run'
const OWNER = 'fictional-captured-owner'
const base = path.resolve('.runtime/creation-runtime-modernization/stage-6b-captured-runtime-tests')
const runtimes: ProjectRuntime[] = []
let root = ''
let now = 0

interface Book {
  context: CapturedImportRunContext
  runtime: ProjectRuntime
  execution: ImportRunExecutionLease
  checkpoint: string
  content: string
}
let a: Book
let b: Book

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function request(content: string): ImportRunPrepareRequest {
  return {
    runId: RUN_ID, purpose: 'reference', sourceFingerprint: hash(`source:${content}`), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional-reference.txt', mediaType: 'text/plain', size: Buffer.byteLength(content) }],
    chapters: [{ number: 1, title: 'Fictional chapter', content, contentSize: Buffer.byteLength(content), contentFingerprint: hash(content) }],
  }
}

function openBook(name: string, content: string): Book {
  openCanonicalProjectFixture(path.join(root, name))
  const runtime = projectRuntimeHost.getActiveView()!
  runtimes.push(runtime)
  ProjectCoreRepository.init(`Fictional ${name}`)
  const input = request(content)
  ImportRunRepository.prepare(input)
  const execution = ImportRunRepository.startOrResume(RUN_ID, OWNER, now, 120_000).execution
  return { runtime, context: runtime, execution, content,
    checkpoint: createImportRunChapterBatchCheckpointId(input.chapters) }
}

function verifiedCleanupRoot(): string {
  const assertChild = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
    }
  }
  const workspace = path.resolve('.')
  const absolute = path.resolve(root)
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  assertChild(workspace, base)
  assertChild(base, absolute)
  for (let directory = absolute; ; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
      throw new Error('FICTIONAL_CLEANUP_LINK')
    }
    if (normalized(directory) === normalized(workspace)) break
  }
  const realRoot = fs.realpathSync.native(absolute)
  assertChild(fs.realpathSync.native(base), realRoot)
  const pending = [absolute]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const realTarget = fs.realpathSync.native(target)
      if (fs.lstatSync(target).isSymbolicLink() || normalized(realTarget) !== normalized(target)) {
        throw new Error('FICTIONAL_CLEANUP_LINK')
      }
      assertChild(realRoot, realTarget)
      if (entry.isDirectory()) pending.push(target)
    }
  }
  return absolute
}

function state(database: Database.Database) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>
  return Object.fromEntries(tables.map(({ name }) => [name,
    database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort(),
  ]))
}

function finishKnowledge(book: Book): void {
  const database = book.context.database
  const binding = ImportRunRepository.resolveReferenceImportAuthority(RUN_ID, book.execution, 1, undefined, database)
  const documentId = hash(`reference-import:${binding.stableKey}`)
  database.prepare(`INSERT INTO import_reference_documents (
    document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state
  ) VALUES(?,?,?,?,1,'reference','committed')`).run(documentId, hash(binding.stableKey), binding.contentFingerprint, hash('fictional chunks'))
  ImportRunRepository.commitReferenceImportReceipt(RUN_ID, book.execution, 1, documentId, database)
  expect(ImportRunRepository.completeBatch(RUN_ID, 'knowledge', book.checkpoint, book.execution, book.context))
    .toMatchObject({ newlyCompleted: true, cancelApplied: false, run: { progressCompleted: 1 } })
  ImportRunRepository.advanceStage(RUN_ID, 'knowledge', 'global', book.execution, book.context)
}

function globalPayload(): ImportGlobalFactsRequest {
  return {
    operationId: `novel-import-global-${RUN_ID}`, expectedRosterRevision: 0,
    core: {
      genre: 'Science fiction', subGenre: 'Mystery', targetAudience: 'Adults', totalChapters: 1,
      wordsPerChapter: 2000, plotStructure: 'three_act', narrativePov: 'third_limited',
      goldenFinger: 'A predictive signal', globalGuidance: 'Keep the mystery coherent.',
      coreOutline: 'Mara follows a signal.', worldSetting: 'A remote station.', protagonistProfile: 'Mara is a navigator.',
      premise: 'A signal predicts failures.', worldbuilding: 'Machines preserve unreliable archives.', synopsis: 'Mara finds the source.',
    },
    characterEntries: [{ name: 'Mara', role: 'protagonist', gender: '', age: '', appearance: '', personality: '',
      background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }],
  }
}

function styleRequest(writingStyle = 'Fictional precise prose'): ImportRunPrepareEffectReceiptRequest {
  return { runId: RUN_ID, stage: 'style', batchId: 'done', effectKey: 'writing-style',
    kind: 'project-writing-style', payload: { writingStyle } }
}

function prepareAndCommit(book: Book, effect: ImportRunPrepareEffectReceiptRequest) {
  const prepared = ImportRunRepository.prepareEffectReceipt(effect, book.execution, undefined, undefined, book.context)
  expect(prepared.state).toBe('prepared')
  expect(ImportRunRepository.getEffectReceipt(RUN_ID, effect.stage, effect.batchId, book.context)).toEqual(prepared)
  return ImportRunRepository.commitEffectReceipt(RUN_ID, effect.stage, effect.batchId, book.execution, undefined, undefined, book.context)
}

function moveToStyle(book: Book): void {
  book.context.database.prepare("UPDATE import_runs SET stage='style' WHERE id=?").run(RUN_ID)
}

function freeze(book: Book): void {
  fs.writeFileSync(path.join(book.runtime.projectStorageRoot, 'portable-runtime-freeze.json'), JSON.stringify({
    version: 1, originProjectId: '11111111-1111-4111-8111-111111111111', snapshotGeneration: 'fictional-snapshot',
    nonReplayable: true, requiresRuntimeFreezeGuard: true, avatarReferenceProjections: [], records: [{
      projectionId: `history:import_runs:${RUN_ID}`, table: 'import_runs', recordId: RUN_ID,
      terminalState: 'ready', projection: {}, projectionHash: 'a'.repeat(64), excludedFields: [],
      nonReplayable: true, originalReceiptVerified: false,
    }],
  }), { mode: 0o600 })
}

beforeEach(() => {
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'fictional-'))
  now = Date.now()
  a = openBook('a', 'Fictional reference A')
  b = openBook('b', 'Different fictional reference B')
  expect(a.execution).toEqual(b.execution)
  expect(a.context.database).not.toBe(b.context.database)
  expect(a.context.projectId).not.toBe(b.context.projectId)
  expect(getProjectDb()).toBe(b.context.database)
})

afterEach(() => {
  for (const runtime of runtimes.splice(0).reverse()) projectRuntimeHost.releaseIdle(runtime)
  if (root) fs.rmSync(verifiedCleanupRoot(), { recursive: true, force: true })
  root = ''
})

describe('captured reference import runtime', () => {
  it('reads writer-owned grant scope from A without borrowing colliding B or changing either DB', () => {
    const beforeA = state(a.context.database), beforeB = state(b.context.database)
    const expected = a.context.database.prepare('SELECT manifest_fingerprint FROM import_runs WHERE id=?').pluck().get(RUN_ID)
    expect(ImportRunRepository.captureReferenceGrantScope(RUN_ID, a.context))
      .toEqual({ runId: RUN_ID, manifestFingerprint: expected, status: 'running', stage: 'knowledge' })
    expect(ImportRunRepository.captureReferenceGrantScope(RUN_ID, b.context).manifestFingerprint).not.toBe(expected)
    expect(state(a.context.database)).toEqual(beforeA)
    expect(state(b.context.database)).toEqual(beforeB)
    expect(projectRuntimeHost.getActiveView()).toBe(b.runtime)
  })

  it('keeps grant scope independent of an execution fence and reports the actual failed stage', () => {
    const scope = ImportRunRepository.captureReferenceGrantScope(RUN_ID, a.context)
    const beforeB = state(b.context.database)
    ImportRunRepository.fail(RUN_ID, 'knowledge', 'Fictional interrupted reference import', a.execution, a.context)
    const beforeA = state(a.context.database)
    expect(ImportRunRepository.captureReferenceGrantScope(RUN_ID, a.context))
      .toEqual({ ...scope, status: 'failed' })
    expect(state(a.context.database)).toEqual(beforeA)
    expect(state(b.context.database)).toEqual(beforeB)
  })

  it.each([
    ["purpose='author-manuscript'", 'IMPORT_RUN_REFERENCE_UNBOUND'],
    ["stage='parsing'", 'IMPORT_RUN_GRANT_SCOPE_INVALID'],
    ["manifest_fingerprint='fictional-invalid-manifest'", 'IMPORT_RUN_GRANT_SCOPE_INVALID'],
    ["stage='completed'", 'IMPORT_RUN_GRANT_SCOPE_INVALID'],
  ])('refuses invalid captured grant scope %s without granting or changing B', (mutation, code) => {
    a.context.database.exec(`UPDATE import_runs SET ${mutation} WHERE id='${RUN_ID}'`)
    const beforeA = state(a.context.database), beforeB = state(b.context.database)
    expect(() => ImportRunRepository.captureReferenceGrantScope(RUN_ID, a.context)).toThrow(code)
    expect(state(a.context.database)).toEqual(beforeA)
    expect(state(b.context.database)).toEqual(beforeB)
  })

  it('does not turn frozen import history into grant scope or use current B freeze for A', () => {
    freeze(b)
    expect(ImportRunRepository.captureReferenceGrantScope(RUN_ID, a.context).runId).toBe(RUN_ID)
    expect(() => ImportRunRepository.captureReferenceGrantScope(RUN_ID, b.context)).toThrow('PORTABLE_RUNTIME_FROZEN')
    freeze(a)
    expect(() => ImportRunRepository.captureReferenceGrantScope(RUN_ID, a.context)).toThrow('PORTABLE_RUNTIME_FROZEN')
  })

  it('rejects a closed captured DB rather than reading grant scope from current B', () => {
    const beforeB = state(b.context.database)
    projectRuntimeHost.releaseIdle(a.runtime)
    runtimes.splice(runtimes.indexOf(a.runtime), 1)
    expect(a.context.database.open).toBe(false)
    expect(() => ImportRunRepository.captureReferenceGrantScope(RUN_ID, a.context)).toThrow('IMPORT_RUN_REFERENCE_UNBOUND')
    expect(state(b.context.database)).toEqual(beforeB)
    expect(getProjectDb()).toBe(b.context.database)
  })

  it('reads A snapshots and frozen chapter pages while omitted context still reads B', () => {
    moveToStyle(b)
    ImportRunRepository.prepareEffectReceipt(styleRequest('Fictional B prose'), b.execution)
    const beforeA = state(a.context.database), beforeB = state(b.context.database)
    expect(ImportRunRepository.get(RUN_ID, a.context)).toMatchObject({ stage: 'knowledge', progressTotal: 1 })
    expect(ImportRunRepository.get(RUN_ID)?.stage).toBe('style')
    expect(ImportRunRepository.listChapterBatch(RUN_ID, { afterChapterNumber: 0, limit: 10 }, a.context))
      .toEqual([expect.objectContaining({ content: a.content, contentFingerprint: hash(a.content) })])
    expect(ImportRunRepository.listChapterBatch(RUN_ID, { afterChapterNumber: 0, limit: 10 }))
      .toEqual([expect.objectContaining({ content: b.content })])
    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'style', 'done', a.context)).toBeNull()
    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'style', 'done')?.state).toBe('prepared')
    expect(state(a.context.database)).toEqual(beforeA)
    expect(state(b.context.database)).toEqual(beforeB)
    expect(projectRuntimeHost.getActiveView()).toBe(b.runtime)
  })

  it('runs knowledge, global, style, blueprints and refresh entirely in A with durable replay', () => {
    const beforeB = state(b.context.database)
    const writesInTransaction: boolean[] = []
    a.context.database.function('observe_captured_effect', () => {
      writesInTransaction.push(a.context.database.inTransaction)
      return 1
    })
    a.context.database.exec(`CREATE TEMP TRIGGER observe_captured_effect_commit
      BEFORE UPDATE OF state ON import_run_receipts BEGIN SELECT observe_captured_effect(); END`)
    expect(ImportRunRepository.startOrResume(RUN_ID, OWNER, now, 120_000, a.context).execution).toEqual(a.execution)
    finishKnowledge(a)
    const global = prepareAndCommit(a, { runId: RUN_ID, stage: 'global', batchId: 'done', effectKey: 'global-facts',
      kind: 'project-global-facts', payload: globalPayload() })
    expect(global.receipt).toMatchObject({ state: 'committed', effectReceipt: { characterProposal: { proposalBatchId: expect.any(String) } } })
    ImportRunRepository.advanceStage(RUN_ID, 'global', 'style', a.execution, a.context)
    prepareAndCommit(a, styleRequest())
    ImportRunRepository.advanceStage(RUN_ID, 'style', 'blueprints', a.execution, a.context)
    const blueprints = prepareAndCommit(a, {
      runId: RUN_ID, stage: 'blueprints', batchId: a.checkpoint, effectKey: `blueprints:${a.checkpoint}`,
      kind: 'chapter-blueprint-range', payload: {
        mode: 'replace-range', operationId: `import-blueprints-${RUN_ID}-1-1`, startChapter: 1, endChapter: 1,
        blueprints: [{ chapterNumber: 1, title: 'Fictional generated A', role: 'setup', purpose: 'Discover the signal',
          keyEvents: 'Mara finds a clue', characters: ['Mara'], suspenseHook: 'An archive opens',
          userGuidance: '', notes: '', notesUpdatedAt: '' }],
      },
    }).receipt.effectReceipt as BlueprintRangeCommitReceipt
    const database = a.context.database
    new CharacterProposalService(database, a.context.projectId, source => proveCharacterProposal(database,
      new GenerationRunRepository(() => database), a.context.projectId, source, false, () => {}))
      .stage({ kind: 'directory', operationId: blueprints.characterSyncOperation.operationId })
    BlueprintRepository.completeCharacterSyncOperation(blueprints.characterSyncOperation.operationId, database)
    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'blueprints', a.checkpoint, a.context)?.state).toBe('committed')
    ImportRunRepository.advanceStage(RUN_ID, 'blueprints', 'refresh', a.execution, a.context)
    ImportRunRepository.completeBatch(RUN_ID, 'refresh', 'done', a.execution, a.context)
    expect(ImportRunRepository.complete(RUN_ID, a.execution, a.context))
      .toMatchObject({ stage: 'completed', status: 'completed', resumable: false })
    const committedA = state(database)
    for (const [stage, batchId] of [['global', 'done'], ['style', 'done'], ['blueprints', a.checkpoint]] as const) {
      expect(ImportRunRepository.commitEffectReceipt(RUN_ID, stage, batchId, a.execution, undefined, undefined, a.context).receipt.state)
        .toBe('committed')
    }
    expect(ImportGlobalFactsRepository.getCommittedOperation(`novel-import-global-${RUN_ID}`, {
      database, projectRoot: a.context.canonicalRoot, projectId: a.context.projectId,
    })).not.toBeNull()
    expect(ProjectCoreRepository.get(database)?.writingStyle).toBe('Fictional precise prose')
    expect(state(database)).toEqual(committedA)
    expect(writesInTransaction).toEqual([true, true, true])
    expect(state(b.context.database)).toEqual(beforeB)
    expect(projectRuntimeHost.getActiveView()).toBe(b.runtime)
  })

  it('preserves omitted-context effect writes on B', () => {
    moveToStyle(b)
    const beforeA = state(a.context.database)
    ImportRunRepository.prepareEffectReceipt(styleRequest('Fictional B prose'), b.execution)
    ImportRunRepository.commitEffectReceipt(RUN_ID, 'style', 'done', b.execution)
    expect(ProjectCoreRepository.get()?.writingStyle).toBe('Fictional B prose')
    expect(state(a.context.database)).toEqual(beforeA)
  })

  it('renews only A, fences takeover, and resumes a prepared effect without changing its payload', () => {
    moveToStyle(a)
    const beforeB = state(b.context.database)
    const renewed = ImportRunRepository.renewExecution(RUN_ID, a.execution, now + 1, 180_000, a.context)
    expect(renewed.expiresAt).toBe(now + 180_001)
    const prepared = ImportRunRepository.prepareEffectReceipt(styleRequest(), renewed, undefined, undefined, a.context)
    expect(ImportRunRepository.fail(RUN_ID, 'style', 'Fictional interrupted effect', renewed, a.context).status).toBe('failed')
    const resumed = ImportRunRepository.startOrResume(RUN_ID, 'fictional-next-owner', undefined, 120_000, a.context)
    expect(resumed.execution.epoch).toBeGreaterThan(a.execution.epoch)
    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'style', 'done', a.context)).toEqual(prepared)
    expect(() => ImportRunRepository.renewExecution(RUN_ID, a.execution, undefined, undefined, a.context))
      .toThrow('IMPORT_RUN_EXECUTION_STALE')
    const result = ImportRunRepository.commitEffectReceipt(RUN_ID, 'style', 'done', resumed.execution, undefined, undefined, a.context)
    expect(result.receipt).toMatchObject({ state: 'committed', payloadHash: prepared.payloadHash, payload: prepared.payload })
    expect(state(b.context.database)).toEqual(beforeB)
  })

  it('recovers the original prepared A effect after actual native close and reopen while B is current', () => {
    moveToStyle(a)
    const prepared = ImportRunRepository.prepareEffectReceipt(styleRequest(), a.execution, undefined, undefined, a.context)
    const beforeB = state(b.context.database)
    const original = a.runtime
    projectRuntimeHost.releaseIdle(original)
    runtimes.splice(runtimes.indexOf(original), 1)
    expect(original.phase).toBe('closed')
    expect(original.database.open).toBe(false)
    expect(getProjectDb()).toBe(b.context.database)

    initProjectDatabase(original.canonicalRoot)
    const reopened = projectRuntimeHost.getActiveView()!
    runtimes.push(reopened)
    const context: CapturedImportRunContext = reopened
    expect(reopened.database).not.toBe(original.database)
    expect(reopened.databaseIdentity).not.toBe(original.databaseIdentity)
    expect(reopened.executionEpoch).not.toBe(original.executionEpoch)
    expect(reopened.projectId).toBe(original.projectId)
    projectRuntimeHost.activateView(b.runtime)

    expect(ImportRunRepository.getEffectReceipt(RUN_ID, 'style', 'done', context)).toEqual(prepared)
    const resumed = ImportRunRepository.startOrResume(RUN_ID, 'fictional-reopened-owner', undefined, 120_000, context)
    expect(resumed.execution.epoch).toBeGreaterThan(a.execution.epoch)
    expect(() => ImportRunRepository.commitEffectReceipt(RUN_ID, 'style', 'done', a.execution, undefined, undefined, context))
      .toThrow('IMPORT_RUN_EXECUTION_STALE')
    const result = ImportRunRepository.commitEffectReceipt(RUN_ID, 'style', 'done', resumed.execution, undefined, undefined, context)
    expect(result.receipt).toMatchObject({ state: 'committed', payload: prepared.payload,
      payloadHash: prepared.payloadHash, effectNamespace: prepared.effectNamespace })
    expect(ProjectCoreRepository.get(reopened.database)?.writingStyle).toBe('Fictional precise prose')
    expect(state(b.context.database)).toEqual(beforeB)
    expect(projectRuntimeHost.getActiveView()).toBe(b.runtime)
  })

  it('reads the original grant after true native reopen without reconstructing execution authority or effects', () => {
    const repository = (runtime: ProjectRuntime) => {
      const resources = captureReferenceImportResources(runtime)
      return { resources, grants: new ReferenceImportGrantRepository(runtime.database, {
        projectId: runtime.projectId, context: runtime, assertCurrent: resources.assertResources,
        isFrozen: id => readPortableRuntimeFreeze(runtime.canonicalRoot).isFrozen('reference_import_grants', id),
        now: () => now,
      }) }
    }
    const original = repository(a.runtime)
    const grant = original.grants.issue({ grantId: '11111111-1111-4111-8111-111111111111',
      operationKey: '22222222-2222-4222-8222-222222222222', runId: RUN_ID,
      manifestFingerprint: ImportRunRepository.captureReferenceGrantScope(RUN_ID, a.context).manifestFingerprint,
      requestHash: hash('fictional-explicit-reference-authorization') })
    const beforeA = state(a.context.database), beforeB = state(b.context.database)
    const runBefore = a.context.database.prepare('SELECT * FROM import_runs WHERE id=?').get(RUN_ID) as Record<string, unknown>
    projectRuntimeHost.releaseIdle(a.runtime)
    runtimes.splice(runtimes.indexOf(a.runtime), 1)
    expect(a.runtime.phase).toBe('closed')
    expect(a.runtime.database.open).toBe(false)
    expect(() => original.resources.assertResources()).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
    expect(() => original.grants.get(grant.grantId)).toThrow('REFERENCE_IMPORT_GRANT_DATABASE_NOT_READY')

    initProjectDatabase(a.runtime.canonicalRoot)
    const reopened = projectRuntimeHost.getActiveView()!
    runtimes.push(reopened)
    projectRuntimeHost.activateView(b.runtime)
    expect(reopened.database).not.toBe(a.runtime.database)
    expect(reopened.databaseIdentity).not.toBe(a.runtime.databaseIdentity)
    expect(reopened.executionEpoch).not.toBe(a.runtime.executionEpoch)
    expect(reopened.projectId).toBe(a.runtime.projectId)
    expect(() => original.resources.assertResources()).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
    expect(repository(reopened).grants.get(grant.grantId)).toEqual(grant)
    const runAfter = reopened.database.prepare('SELECT * FROM import_runs WHERE id=?').get(RUN_ID) as Record<string, unknown>
    expect(runAfter.execution_epoch).toBeGreaterThan(runBefore.execution_epoch as number)
    expect(runAfter).toEqual({ ...runBefore, execution_owner: '', execution_epoch: runAfter.execution_epoch,
      lease_expires_at: 0, updated_at: runAfter.updated_at })
    expect({ ...state(reopened.database), import_runs: [] }).toEqual({ ...beforeA, import_runs: [] })
    expect(state(b.context.database)).toEqual(beforeB)
    expect(getProjectDb()).toBe(b.context.database)
  })

  it('applies a requested cancel at A checkpoint without cancelling B and keeps safe resume', () => {
    finishKnowledge(a)
    const beforeB = state(b.context.database)
    expect(ImportRunRepository.requestCancel(RUN_ID, a.execution, a.context).cancelRequested).toBe(true)
    const committed = prepareAndCommit(a, { runId: RUN_ID, stage: 'global', batchId: 'done', effectKey: 'global-facts',
      kind: 'project-global-facts', payload: globalPayload() })
    expect(committed).toMatchObject({ cancelApplied: true, run: { status: 'cancelled', cancelRequested: true } })
    expect(() => ImportRunRepository.fail(RUN_ID, 'global', 'Fictional late failure', a.execution, a.context))
      .toThrow('IMPORT_RUN_EXECUTION_STALE')
    const resumed = ImportRunRepository.startOrResume(RUN_ID, 'fictional-resumed-owner', undefined, undefined, a.context)
    expect(resumed.run).toMatchObject({ status: 'running', cancelRequested: false, completedBatches: { global: ['done'] } })
    expect(state(b.context.database)).toEqual(beforeB)
  })

  it('cancels A immediately at a safe boundary without releasing B execution', () => {
    const beforeB = state(b.context.database)
    expect(ImportRunRepository.cancelAtBoundary(RUN_ID, a.execution, a.context))
      .toMatchObject({ status: 'cancelled', resumable: true, cancelRequested: true })
    expect(() => ImportRunRepository.requestCancel(RUN_ID, a.execution, a.context)).toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(state(b.context.database)).toEqual(beforeB)
  })

  it.each([
    ['missing run', 'DELETE FROM import_runs'],
    ['stale owner', "UPDATE import_runs SET execution_owner='fictional-other-owner'"],
    ['stale epoch', 'UPDATE import_runs SET execution_epoch=execution_epoch+1'],
    ['expired lease', 'UPDATE import_runs SET lease_expires_at=0'],
    ['nonrunning status', "UPDATE import_runs SET status='failed'"],
  ])('rejects %s in captured A despite valid same-ID B', (_name, sql) => {
    a.context.database.exec(sql)
    const beforeA = state(a.context.database), beforeB = state(b.context.database)
    const mutations = [
      () => ImportRunRepository.renewExecution(RUN_ID, a.execution, undefined, undefined, a.context),
      () => ImportRunRepository.requestCancel(RUN_ID, a.execution, a.context),
      () => ImportRunRepository.cancelAtBoundary(RUN_ID, a.execution, a.context),
      () => ImportRunRepository.completeBatch(RUN_ID, 'knowledge', a.checkpoint, a.execution, a.context),
      () => ImportRunRepository.advanceStage(RUN_ID, 'knowledge', 'global', a.execution, a.context),
      () => ImportRunRepository.fail(RUN_ID, 'knowledge', 'Fictional failure', a.execution, a.context),
      () => ImportRunRepository.complete(RUN_ID, a.execution, a.context),
      () => ImportRunRepository.prepareEffectReceipt(styleRequest(), a.execution, undefined, undefined, a.context),
    ]
    for (const mutate of mutations) expect(mutate).toThrow('IMPORT_RUN_EXECUTION_STALE')
    expect(state(a.context.database)).toEqual(beforeA)
    expect(state(b.context.database)).toEqual(beforeB)
    expect(() => ImportRunRepository.assertExecutionAuthority(RUN_ID, b.execution)).not.toThrow()
  })

  it('keeps stage, fingerprint checkpoint and incomplete-receipt guards on A', () => {
    const beforeA = state(a.context.database), beforeB = state(b.context.database)
    expect(() => ImportRunRepository.advanceStage(RUN_ID, 'knowledge', 'global', a.execution, a.context))
      .toThrow('IMPORT_RUN_STAGE_INCOMPLETE')
    expect(() => ImportRunRepository.completeBatch(RUN_ID, 'knowledge', b.checkpoint, a.execution, a.context))
      .toThrow('IMPORT_RUN_BATCH_ID_INVALID')
    expect(() => ImportRunRepository.completeBatch(RUN_ID, 'knowledge', a.checkpoint, a.execution, a.context))
      .toThrow('IMPORT_RUN_REFERENCE_RECEIPT_INCOMPLETE')
    expect(() => ImportRunRepository.prepareEffectReceipt(styleRequest(), a.execution, undefined, undefined, a.context))
      .toThrow('IMPORT_RUN_BATCH_STAGE_MISMATCH')
    expect(() => ImportRunRepository.complete(RUN_ID, a.execution, a.context)).toThrow('IMPORT_RUN_STAGE_MISMATCH')
    expect(state(a.context.database)).toEqual(beforeA)
    expect(state(b.context.database)).toEqual(beforeB)
  })

  it('does not treat B complete history as proof for unknown A history', () => {
    a.context.database.prepare(`INSERT INTO import_effect_ledger(
      run_id,stage,batch_id,effect_namespace,effect_key,state,evidence_kind,diagnostic_code
    ) VALUES(?,'knowledge','__legacy_unknown',?,'legacy:unknown','unknown','legacy-checkpoint','FICTIONAL_UNPROVEN')`)
      .run(RUN_ID, `import:reference:${RUN_ID}`)
    finishKnowledge(b)
    const beforeA = state(a.context.database), beforeB = state(b.context.database)
    expect(() => ImportRunRepository.completeBatch(RUN_ID, 'knowledge', a.checkpoint, a.execution, a.context))
      .toThrow('IMPORT_RUN_EFFECT_HISTORY_UNKNOWN')
    expect(state(a.context.database)).toEqual(beforeA)
    expect(state(b.context.database)).toEqual(beforeB)
  })

  it('keeps prepared conflict and generated-source guards atomic inside A transaction', () => {
    moveToStyle(a)
    const handle = { projectId: a.context.projectId, epoch: 'fictional-epoch', rootActionId: 'fictional-root', runId: 'fictional-generation' }
    const effect = { ...styleRequest(), payload: { writingStyle: 'Fictional precise prose', generationRunHandle: handle } }
    ImportRunRepository.prepareEffectReceipt(effect, a.execution, undefined, undefined, a.context)
    const beforeA = state(a.context.database), beforeB = state(b.context.database)
    expect(() => ImportRunRepository.prepareEffectReceipt(styleRequest('Different prose'), a.execution, undefined, undefined, a.context))
      .toThrow('IMPORT_RUN_RECEIPT_CONFLICT')
    expect(() => ImportRunRepository.commitEffectReceipt(RUN_ID, 'style', 'done', a.execution, undefined, undefined, a.context))
      .toThrow('GENERATION_GUARD_REQUIRED')
    expect(() => ImportRunRepository.commitEffectReceipt(RUN_ID, 'style', 'done', a.execution, undefined, actual => {
      expect(actual).toEqual(handle)
      expect(a.context.database.inTransaction).toBe(true)
      expect(b.context.database.inTransaction).toBe(false)
      throw new Error('GENERATION_SOURCE_CHANGED')
    }, a.context)).toThrow('GENERATION_SOURCE_CHANGED')
    expect(state(a.context.database)).toEqual(beforeA)
    expect(state(b.context.database)).toEqual(beforeB)
  })

  it('uses the captured root for portable freeze, not current B root', () => {
    freeze(b)
    expect(ImportRunRepository.startOrResume(RUN_ID, OWNER, now, 120_000, a.context).run.status).toBe('running')
    expect(() => ImportRunRepository.startOrResume(RUN_ID, OWNER)).toThrow('PORTABLE_RUNTIME_FROZEN')
    freeze(a)
    const beforeA = state(a.context.database), beforeB = state(b.context.database)
    expect(ImportRunRepository.get(RUN_ID, a.context)?.status).toBe('running')
    expect(() => ImportRunRepository.startOrResume(RUN_ID, OWNER, undefined, undefined, a.context)).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(() => ImportRunRepository.renewExecution(RUN_ID, a.execution, undefined, undefined, a.context)).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(() => ImportRunRepository.requestCancel(RUN_ID, a.execution, a.context)).toThrow('PORTABLE_RUNTIME_FROZEN')
    expect(state(a.context.database)).toEqual(beforeA)
    expect(state(b.context.database)).toEqual(beforeB)
  })

  it('rejects actual author-manuscript resources without changing the legacy author path', () => {
    openCanonicalProjectFixture(path.join(root, 'author'))
    const runtime = projectRuntimeHost.getActiveView()!
    runtimes.push(runtime)
    const content = 'Fictional author manuscript'
    const preview = FinalizedDraftImportRepository.preview([{ chapterNumber: 1, title: 'Fictional chapter', content, wordCount: countDraftUnits(content) }])
    ImportRunRepository.prepare({ ...request(content), purpose: 'author-manuscript',
      authorityFingerprint: preview.authorityFingerprint, expectedManifestFingerprint: preview.manifestFingerprint })
    const execution = ImportRunRepository.startOrResume(RUN_ID, OWNER, now, 120_000).execution
    expect(ImportRunRepository.get(RUN_ID)?.purpose).toBe('author-manuscript')
    projectRuntimeHost.activateView(b.runtime)
    const beforeAuthor = state(runtime.database), beforeB = state(b.context.database)
    for (const operation of [
      () => ImportRunRepository.get(RUN_ID, runtime),
      () => ImportRunRepository.listChapterBatch(RUN_ID, { afterChapterNumber: 0, limit: 10 }, runtime),
      () => ImportRunRepository.startOrResume(RUN_ID, OWNER, undefined, undefined, runtime),
      () => ImportRunRepository.requestCancel(RUN_ID, execution, runtime),
      () => ImportRunRepository.prepareEffectReceipt(styleRequest(), execution, undefined, undefined, runtime),
    ]) expect(operation).toThrow('IMPORT_RUN_REFERENCE_UNBOUND')
    expect(state(runtime.database)).toEqual(beforeAuthor)
    expect(state(b.context.database)).toEqual(beforeB)
  })
})

import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getProjectDb } from '../../database'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ProjectCoreRepository } from '../project-core-repository'
import { CharacterRosterRepository } from '../character-roster-repository'
import { ImportGlobalFactsRepository, type ImportGlobalFactsContext } from '../import-global-facts-repository'
import { BlueprintRepository, type BlueprintRangeCommitRequest } from '../blueprint-repository'
import { CharacterProposalService } from '../../services/character-proposal-service'
import { proveCharacterProposal } from '../../services/generation-character-proposal-proof'
import { GenerationRunRepository } from '../generation-run-repository'
import type { ImportGlobalFactsReceipt, ImportGlobalFactsRequest } from '../../../src/shared/import-global-facts'

const base = path.resolve('.runtime/creation-runtime-modernization/stage-6b-captured-domain-tests')
const GLOBAL_OPERATION = 'fictional-shared-global-operation'
const BLUEPRINT_OPERATION = 'fictional-shared-blueprint-operation'
const runtimes: ProjectRuntime[] = []
let root = ''
let a: ImportGlobalFactsContext
let b: ImportGlobalFactsContext

function openBook(name: string): ImportGlobalFactsContext {
  openCanonicalProjectFixture(path.join(root, name))
  const runtime = projectRuntimeHost.getActiveView()!
  runtimes.push(runtime)
  ProjectCoreRepository.init(`Fictional ${name}`)
  return { database: runtime.database, projectRoot: runtime.canonicalRoot, projectId: runtime.projectId }
}

function verifiedCleanupRoot(): string {
  const assertChild = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
    }
  }
  const workspace = path.resolve('.')
  const target = path.resolve(root)
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  assertChild(workspace, base)
  assertChild(base, target)
  for (let directory = target; ; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
      throw new Error('FICTIONAL_CLEANUP_LINK')
    }
    if (normalized(directory) === normalized(workspace)) break
  }
  const realRoot = fs.realpathSync.native(target)
  assertChild(fs.realpathSync.native(base), realRoot)
  const pending = [target]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      const realChild = fs.realpathSync.native(child)
      if (fs.lstatSync(child).isSymbolicLink() || normalized(realChild) !== normalized(child)) {
        throw new Error('FICTIONAL_CLEANUP_LINK')
      }
      assertChild(realRoot, realChild)
      if (entry.isDirectory()) pending.push(child)
    }
  }
  return target
}

beforeEach(() => {
  fs.mkdirSync(base, { recursive: true })
  root = fs.mkdtempSync(path.join(base, 'fictional-'))
  a = openBook('a')
  b = openBook('b')
  expect(getProjectDb()).toBe(b.database)
  expect(a.database).not.toBe(b.database)
  expect(a.projectId).not.toBe(b.projectId)
})

afterEach(() => {
  for (const runtime of runtimes.splice(0).reverse()) projectRuntimeHost.releaseIdle(runtime)
  if (root) fs.rmSync(verifiedCleanupRoot(), { recursive: true, force: true })
  root = ''
})

function request(marker: string): ImportGlobalFactsRequest {
  return {
    operationId: GLOBAL_OPERATION,
    expectedRosterRevision: 0,
    core: {
      genre: `Fictional ${marker}`, subGenre: 'Mystery', targetAudience: 'Fictional adults',
      totalChapters: 2, wordsPerChapter: 100, plotStructure: 'three_act', narrativePov: 'third_limited',
      goldenFinger: 'None', globalGuidance: `Preserve fictional ${marker}`, coreOutline: `${marker} delivers a letter`,
      worldSetting: `${marker} harbor`, protagonistProfile: `${marker} courier`, premise: `${marker} premise`,
      worldbuilding: `${marker} world`, synopsis: `${marker} synopsis`,
    },
    characterEntries: [{ name: `${marker} courier`, role: 'supporting', gender: 'unknown', age: '', appearance: '',
      personality: '', background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }],
  }
}

function rows(db: Database.Database, table: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return []
  const queries: Record<string, string> = {
    import_global_fact_operations: 'SELECT * FROM import_global_fact_operations ORDER BY operation_id',
    character_identity_proposals: 'SELECT * FROM character_identity_proposals ORDER BY proposal_id',
    character_identity_approvals: 'SELECT * FROM character_identity_approvals ORDER BY rowid',
    characters: 'SELECT * FROM characters ORDER BY character_id',
    character_relationships: 'SELECT * FROM character_relationships ORDER BY rowid',
    blueprints: 'SELECT * FROM blueprints ORDER BY chapter_number',
    blueprint_commit_operations: 'SELECT * FROM blueprint_commit_operations ORDER BY operation_id',
    blueprint_character_sync_operations: 'SELECT * FROM blueprint_character_sync_operations ORDER BY operation_id',
  }
  return db.prepare(queries[table]!).all()
}

function state(context: ImportGlobalFactsContext) {
  return {
    core: ProjectCoreRepository.get(context.database), roster: CharacterRosterRepository.readCaptured(context.database),
    facts: rows(context.database, 'import_global_fact_operations'), proposals: rows(context.database, 'character_identity_proposals'),
    approvals: rows(context.database, 'character_identity_approvals'), characters: rows(context.database, 'characters'),
    relationships: rows(context.database, 'character_relationships'), blueprints: rows(context.database, 'blueprints'),
    blueprintOperations: rows(context.database, 'blueprint_commit_operations'), sync: rows(context.database, 'blueprint_character_sync_operations'),
  }
}

function blueprints(marker: string): BlueprintRangeCommitRequest {
  return { mode: 'replace-range', operationId: BLUEPRINT_OPERATION, startChapter: 1, endChapter: 1,
    blueprints: [{ chapterNumber: 1, title: `${marker} letter`, role: 'opening', purpose: `${marker} delivery`,
      keyEvents: `${marker} arrives`, characters: [`${marker} courier`],
      newCharacterCandidates: [{ name: `${marker} courier`, role: 'supporting' }],
      suspenseHook: `${marker} waits`, userGuidance: '', notes: '', notesUpdatedAt: '' }] }
}

function proposals(context: ImportGlobalFactsContext) {
  return new CharacterProposalService(context.database, context.projectId, source => proveCharacterProposal(
    context.database, new GenerationRunRepository(() => context.database), context.projectId, source, false, () => {},
  ))
}

describe('captured reference global facts', () => {
  it('commits and replays A with a distinct same-operation B current, without adopting characters', () => {
    const other = ImportGlobalFactsRepository.commit(request('B'))
    const beforeB = state(b)
    const committed = ImportGlobalFactsRepository.commit(request('A'), 'replace', a)
    expect(committed.core.genre).toBe('Fictional A')
    expect(committed.characterProposal?.proposalBatchId).not.toBe(other.characterProposal?.proposalBatchId)
    expect(ImportGlobalFactsRepository.getCommittedOperation(GLOBAL_OPERATION, a)).toEqual(committed)
    expect(ImportGlobalFactsRepository.readHistoricalCommittedOperation(GLOBAL_OPERATION, a)).toEqual(committed)
    expect(ImportGlobalFactsRepository.commit(request('A'), 'replace', a)).toEqual({ ...committed, idempotent: true })
    expect(state(b)).toEqual(beforeB)
    expect(rows(a.database, 'character_identity_proposals')).toHaveLength(1)
    expect(rows(a.database, 'character_identity_approvals')).toHaveLength(0)
    expect(rows(a.database, 'characters')).toHaveLength(0)
    expect(rows(a.database, 'character_relationships')).toHaveLength(0)
    expect(CharacterRosterRepository.readCaptured(a.database).revision).toBe(0)
  })

  it('uses captured core for fill-empty and style saves without changing either roster or B', () => {
    ProjectCoreRepository.update({ genre: 'Fictional author genre', writingStyle: 'Fictional author style' }, a.database)
    const beforeB = state(b)
    const committed = ImportGlobalFactsRepository.commit(request('A'), 'fill-empty', a)
    expect(committed.core.genre).toBe('Fictional author genre')
    expect(committed.suggestions).toEqual(expect.arrayContaining([{ field: 'genre', current: 'Fictional author genre', inferred: 'Fictional A' }]))
    ProjectCoreRepository.update({ writingStyle: 'Fictional saved style' }, a.database)
    expect(ProjectCoreRepository.get(a.database)?.writingStyle).toBe('Fictional saved style')
    expect(ImportGlobalFactsRepository.getCommittedOperation(GLOBAL_OPERATION, a)).toEqual(committed)
    expect(state(b)).toEqual(beforeB)
    expect(rows(a.database, 'characters')).toHaveLength(0)
  })

  it('rejects superseded A current facts but retains its historical ACK without reading B', () => {
    ImportGlobalFactsRepository.commit(request('B'))
    const committed = ImportGlobalFactsRepository.commit(request('A'), 'replace', a)
    const beforeB = state(b)
    ProjectCoreRepository.update({ coreOutline: 'Fictional author replacement' }, a.database)
    expect(() => ImportGlobalFactsRepository.getCommittedOperation(GLOBAL_OPERATION, a)).toThrow('IMPORT_GLOBAL_FACTS_SUPERSEDED')
    expect(() => ImportGlobalFactsRepository.commit(request('A'), 'replace', a)).toThrow('IMPORT_GLOBAL_FACTS_SUPERSEDED')
    expect(ImportGlobalFactsRepository.readHistoricalCommittedOperation(GLOBAL_OPERATION, a)).toEqual(committed)
    expect(state(b)).toEqual(beforeB)
  })

  it('rolls back A core, ledger and proposals together when captured proposal staging fails', () => {
    const beforeA = state(a), beforeB = state(b)
    a.database.exec("CREATE TEMP TRIGGER reject_captured_proposal BEFORE INSERT ON character_identity_proposals BEGIN SELECT RAISE(ABORT, 'FICTIONAL_PROPOSAL_FAILURE'); END;")
    expect(() => ImportGlobalFactsRepository.commit(request('A'), 'replace', a)).toThrow('FICTIONAL_PROPOSAL_FAILURE')
    expect(state(a)).toEqual(beforeA)
    expect(state(b)).toEqual(beforeB)
  })

  it('does not borrow B proposal evidence when A has lost its committed proposal', () => {
    ImportGlobalFactsRepository.commit(request('B'))
    ImportGlobalFactsRepository.commit(request('A'), 'replace', a)
    const beforeB = state(b)
    a.database.prepare('DELETE FROM character_identity_proposals').run()
    expect(() => ImportGlobalFactsRepository.getCommittedOperation(GLOBAL_OPERATION, a)).toThrow()
    expect(state(b)).toEqual(beforeB)
  })

  it('rejects a captured project identity mismatch before changing facts', () => {
    const beforeA = state(a), beforeB = state(b)
    expect(() => ImportGlobalFactsRepository.commit(request('A'), 'replace', { ...a, projectRoot: b.projectRoot }))
      .toThrow('IMPORT_GLOBAL_FACTS_PROJECT_IDENTITY_MISSING')
    expect(state(a)).toEqual(beforeA)
    expect(state(b)).toEqual(beforeB)
  })

  it('retains captured historical legacy receipt proof but never grants a new name-only write', () => {
    const committed = ImportGlobalFactsRepository.commit(request('A'), 'replace', a)
    const roster = CharacterRosterRepository.readCaptured(a.database)
    const receipt: ImportGlobalFactsReceipt = { operationId: 'fictional-legacy-ack', payloadHash: 'a'.repeat(64),
      idempotent: false, core: committed.core, roster: { operationId: 'fictional-legacy-roster', payloadHash: 'b'.repeat(64),
        revision: roster.revision, idempotent: false, snapshot: { ...roster, factHash: roster.nameOnlyFactHash } } }
    a.database.prepare('INSERT INTO import_global_fact_operations(operation_id,payload_hash,receipt_json) VALUES(?,?,?)')
      .run(receipt.operationId, receipt.payloadHash, JSON.stringify(receipt))
    const beforeB = state(b)
    expect(ImportGlobalFactsRepository.getCommittedOperation(receipt.operationId, a)).toEqual(receipt)
    a.database.exec('DROP TABLE character_identity_meta')
    expect(() => ImportGlobalFactsRepository.commit(request('A'), 'replace', a)).toThrow('CHARACTER_ID_WRITE_REQUIRED')
    expect(ImportGlobalFactsRepository.readHistoricalCommittedOperation(receipt.operationId, a)).toEqual(receipt)
    expect(state(b)).toEqual(beforeB)
  })
})

describe('captured reference blueprint character sync', () => {
  it('reads pending A and completes only its staged proposal while same-operation B is current', () => {
    const other = BlueprintRepository.commitRange(blueprints('B'))
    proposals(b).stage({ kind: 'directory', operationId: other.characterSyncOperation.operationId })
    BlueprintRepository.completeCharacterSyncOperation(other.characterSyncOperation.operationId)
    const beforeB = state(b)
    const committed = BlueprintRepository.commitRange(blueprints('A'), undefined, a.database)
    const operationId = committed.characterSyncOperation.operationId
    expect(BlueprintRepository.listPendingCharacterSyncOperations(a.database).map(item => item.operationId)).toEqual([operationId])
    expect(BlueprintRepository.getCharacterSyncOperation(operationId, a.database)?.status).toBe('pending')
    expect(() => BlueprintRepository.completeCharacterSyncOperation(operationId, a.database)).toThrow()
    expect(BlueprintRepository.getCharacterSyncOperation(operationId, a.database)?.status).toBe('pending')
    const staged = proposals(a).stage({ kind: 'directory', operationId })
    const completed = BlueprintRepository.completeCharacterSyncOperation(operationId, a.database)
    expect(completed.completionReceipt).toMatchObject({ status: 'proposal-staged', proposalReceipt: { proposalBatchId: staged.proposalBatchId } })
    expect(BlueprintRepository.completeCharacterSyncOperation(operationId, a.database)).toEqual(completed)
    expect(BlueprintRepository.getCharacterSyncOperation(operationId, a.database)).toEqual(completed)
    expect(BlueprintRepository.getCommittedRangeOperation(BLUEPRINT_OPERATION, a.database)?.snapshot[0]?.title).toBe('A letter')
    expect(BlueprintRepository.commitRange(blueprints('A'), undefined, a.database)).toMatchObject({ idempotent: true, characterSyncOperation: completed })
    expect(BlueprintRepository.listPendingCharacterSyncOperations(a.database)).toEqual([])
    expect(rows(a.database, 'characters')).toHaveLength(0)
    expect(rows(a.database, 'character_identity_approvals')).toHaveLength(0)
    expect(state(b)).toEqual(beforeB)
  })

  it('rolls back captured range writes and both operation ledgers on a native insert failure', () => {
    const beforeA = state(a), beforeB = state(b)
    a.database.exec("CREATE TEMP TRIGGER reject_captured_blueprint BEFORE INSERT ON blueprint_commit_operations BEGIN SELECT RAISE(ABORT, 'FICTIONAL_BLUEPRINT_FAILURE'); END;")
    expect(() => BlueprintRepository.commitRange(blueprints('A'), undefined, a.database)).toThrow('FICTIONAL_BLUEPRINT_FAILURE')
    expect(state(a)).toEqual(beforeA)
    expect(state(b)).toEqual(beforeB)
  })

  it('rolls back captured sync completion and retries only the original proposal receipt', () => {
    const committed = BlueprintRepository.commitRange(blueprints('A'), undefined, a.database)
    const operationId = committed.characterSyncOperation.operationId
    proposals(a).stage({ kind: 'directory', operationId })
    const beforeA = state(a), beforeB = state(b)
    a.database.exec("CREATE TEMP TRIGGER reject_captured_sync BEFORE UPDATE ON blueprint_character_sync_operations BEGIN SELECT RAISE(ABORT, 'FICTIONAL_SYNC_FAILURE'); END;")
    expect(() => BlueprintRepository.completeCharacterSyncOperation(operationId, a.database)).toThrow('FICTIONAL_SYNC_FAILURE')
    expect(state(a)).toEqual(beforeA)
    expect(state(b)).toEqual(beforeB)
    a.database.exec('DROP TRIGGER reject_captured_sync')
    expect(BlueprintRepository.completeCharacterSyncOperation(operationId, a.database).status).toBe('completed')
    expect(rows(a.database, 'character_identity_proposals')).toHaveLength(1)
    expect(rows(a.database, 'characters')).toHaveLength(0)
  })

  it('refuses A completed sync after A evidence disappears instead of accepting B same-operation proof', () => {
    for (const context of [a, b]) {
      const committed = BlueprintRepository.commitRange(blueprints(context === a ? 'A' : 'B'), undefined, context.database)
      proposals(context).stage({ kind: 'directory', operationId: committed.characterSyncOperation.operationId })
      BlueprintRepository.completeCharacterSyncOperation(committed.characterSyncOperation.operationId, context.database)
    }
    const beforeB = state(b)
    a.database.prepare('DELETE FROM character_identity_proposals').run()
    const operationId = `blueprint-sync-${BLUEPRINT_OPERATION}`
    expect(() => BlueprintRepository.getCharacterSyncOperation(operationId, a.database)).toThrow()
    expect(() => BlueprintRepository.getCommittedRangeOperation(BLUEPRINT_OPERATION, a.database)).toThrow()
    expect(() => BlueprintRepository.commitRange(blueprints('A'), undefined, a.database)).toThrow()
    expect(state(b)).toEqual(beforeB)
  })
})

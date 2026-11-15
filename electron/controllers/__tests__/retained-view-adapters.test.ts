import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { SecureFileCapability, WindowsSafeFileSystem } from '../../security/windows-safe-file-system'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, IpcHandler>()
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)) },
}))
const mocks = vi.hoisted(() => ({ globalRoot: '' }))
vi.mock('../../utils/config-utils', () => ({
  GLOBAL_CONFIG_PATH: 'fictional-global.json', MODELS_CONFIG_PATH: 'fictional-models.json',
  DEFAULT_GLOBAL_CONFIG: { defaultModelId: null, defaultEmbeddingModelId: null },
  readJsonFile: (_file: string, fallback: unknown) => fallback,
}))
vi.mock('../../services/app-data-locator', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/app-data-locator')>(),
  getGlobalDataRoot: () => {
    if (!mocks.globalRoot) throw new Error('FICTIONAL_GLOBAL_ROOT_REQUIRED')
    return mocks.globalRoot
  },
}))

import { createProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
// @ts-expect-error Existing JavaScript cleanup helper has no declaration.
import { removeTemporaryTree } from '../../../test/helpers/remove-temporary-tree.mjs'
import { DraftRepository } from '../../repositories/draft-repository'
import { RecoveryCandidateRepository } from '../../repositories/recovery-candidate-repository'
import { ReviewRepository } from '../../repositories/review-repository'
import { RevisionRepository } from '../../repositories/revision-repository'
import { projectAccess, type TrustedProject } from '../../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'
import { registerDatabaseController } from '../db-controller'
import { registerFSController } from '../fs-controller'

const containers: string[] = []
const fixtureBase = path.resolve('.runtime/retained-view-adapters')
let holdWrite: (() => Promise<void>) | undefined

function verifiedCleanupRoot(container: string): string {
  const target = path.resolve(container)
  const normal = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  if (normal(path.dirname(target)) !== normal(fixtureBase) || !path.basename(target).startsWith('fictional-')) {
    throw new Error('FIXTURE_CLEANUP_OUTSIDE_BASE')
  }
  for (const directory of [fixtureBase, target]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normal(fs.realpathSync.native(directory)) !== normal(directory)) {
      throw new Error('FIXTURE_CLEANUP_LINK')
    }
  }
  return target
}

function capabilityPath(capability: SecureFileCapability): string {
  return path.join(capability.rootPath, ...capability.relativePath.split('\\'))
}

const fileSystem: WindowsSafeFileSystem = {
  async readBytes(capability) { return fs.readFileSync(capabilityPath(capability)) },
  async readText(capability) { return fs.readFileSync(capabilityPath(capability), 'utf8') },
  async writeTextAtomically(capability, content, beforeReplace) {
    await holdWrite?.()
    await beforeReplace?.()
    fs.writeFileSync(capabilityPath(capability), content, 'utf8')
  },
  async mkdir(capability) { fs.mkdirSync(capabilityPath(capability), { recursive: true }) },
  async exists(capability) { return fs.existsSync(capabilityPath(capability)) },
  async listDirectory(capability) {
    return fs.readdirSync(capabilityPath(capability), { withFileTypes: true }).map(entry => ({
      name: entry.name, isDirectory: entry.isDirectory(),
    }))
  },
}

function fixture(): { project: TrustedProject; runtime: ProjectRuntime; file: string } {
  fs.mkdirSync(fixtureBase, { recursive: true })
  const container = fs.mkdtempSync(path.join(fixtureBase, 'fictional-'))
  containers.push(container)
  if (!mocks.globalRoot) {
    mocks.globalRoot = path.join(container, 'global')
    fs.mkdirSync(mocks.globalRoot)
  }
  const rootPath = path.join(container, 'project')
  fs.mkdirSync(path.join(rootPath, '.ai-novel'), { recursive: true })
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: '2026-11-15T00:00:00.000Z' })
  fs.writeFileSync(path.join(rootPath, '.ai-novel', 'project.json'), JSON.stringify(manifest))
  createProjectDatabase(rootPath)
  const project: TrustedProject = { kind: 'manifest', rootPath, projectId: manifest.projectId, storageFormat: 'canonical' }
  const runtime = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareRetainedOpen(project))
  const file = path.join(rootPath, 'fictional.txt')
  fs.writeFileSync(file, 'unchanged')
  return { project, runtime, file }
}

function view(runtime: ProjectRuntime): ProjectSessionContext {
  const lease = projectAccess.beginViewSession(runtime)
  return { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
}

function invoke(channel: string, session: ProjectSessionContext, ...args: unknown[]) {
  return handlers.get(channel)!({}, ...args, session.projectPath, session)
}

beforeAll(() => {
  registerDatabaseController()
  registerFSController(fileSystem)
})

afterEach(() => {
  holdWrite = undefined
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) projectRuntimeHost.releaseIdle(runtime)
  projectAccess.invalidateCurrentSession()
  for (const container of containers.splice(0)) removeTemporaryTree(verifiedCleanupRoot(container), fixtureBase)
  mocks.globalRoot = ''
})

describe('registered retained-view DB and FS adapters', () => {
  it.each(['db:revision-list', 'db:review-list', 'db:revision-get-pending', 'db:review-get-full', 'db:revision-get-full', 'db:review-cycle-get'])(
    'reads only current author history through %s with two native runtimes and preserves write admission', async channel => {
      const seed = (marker: string, count: number) => {
        const draft = DraftRepository.create({ chapterNumber: 1, source: 'write', content: marker, wordCount: marker.length })
        const source = DraftRepository.getFull(draft)
        if (!source) throw new Error('FICTIONAL_DRAFT_REQUIRED')
        for (let index = 0; index < count; index++) {
          ReviewRepository.create({ baseDraftId: draft, content: `${marker} review ${index}`, expectedSource: source })
          RevisionRepository.create({ baseDraftId: draft, revisionType: 'refine', content: `${marker} revision ${index}`,
            userPrompt: `${marker} prompt ${index}`, wordCount: marker.length, expectedSource: source })
        }
        const reviews = ReviewRepository.listByDraft(draft), revisions = RevisionRepository.listByDraft(draft)
        return { draft, source, reviews, revisions,
          review: ReviewRepository.getFull(reviews[0].id), revision: RevisionRepository.getFull(revisions[0].id) }
      }
      const target = (history: ReturnType<typeof seed>) => channel === 'db:review-get-full' || channel === 'db:review-cycle-get' ? history.reviews[0].id
        : channel === 'db:revision-get-full' ? history.revisions[0].id : history.draft
      const expected = (history: ReturnType<typeof seed>) => channel === 'db:review-cycle-get' ? null : channel === 'db:review-get-full' ? history.review
        : channel === 'db:revision-get-full' ? history.revision : channel === 'db:review-list' ? history.reviews : history.revisions
      const changes = (runtime: ProjectRuntime) => runtime.database.prepare('SELECT total_changes()').pluck().get()
      const a = fixture(), aSession = view(a.runtime), aHistory = seed('fictional A', 2)
      const releaseA = projectRuntimeHost.acquireWork(a.runtime)
      try {
        const b = fixture(), bSession = view(b.runtime), bHistory = seed('fictional B', 1)
        const beforeA = changes(a.runtime), beforeB = changes(b.runtime)
        await expect(invoke(channel, bSession, target(bHistory))).resolves.toEqual(expected(bHistory))
        await expect(invoke(channel, aSession, target(aHistory))).rejects.toThrow('PROJECT_SESSION_STALE')
        await expect(invoke(channel, { ...bSession, projectPath: a.runtime.canonicalRoot }, target(aHistory)))
          .rejects.toThrow('PROJECT_SESSION_ROOT_MISMATCH')
        await expect(handlers.get(channel)!({}, target(aHistory), a.runtime.canonicalRoot, bSession))
          .rejects.toThrow('PROJECT_CONTEXT_CHANGED')
        await expect(invoke('db:revision-mark-discarded', bSession, bHistory.revisions[0].id))
          .resolves.toMatchObject({ success: false, error: 'Error: PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE' })
        await expect(invoke('db:review-create', bSession, { baseDraftId: bHistory.draft, content: 'not admitted', expectedSource: bHistory.source }))
          .resolves.toMatchObject({ success: false, error: 'Error: PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE' })
        const renewedA = view(a.runtime)
        await expect(invoke(channel, renewedA, target(aHistory))).resolves.toEqual(expected(aHistory))
        await expect(invoke(channel, aSession, target(aHistory))).rejects.toThrow('PROJECT_SESSION_STALE')
        await expect(invoke(channel, bSession, target(bHistory))).rejects.toThrow('PROJECT_SESSION_STALE')
        expect(changes(a.runtime)).toBe(beforeA)
        expect(changes(b.runtime)).toBe(beforeB)
      } finally { releaseA() }
    },
  )

  it('reads only the current book recovery candidates with two native runtimes and preserves mutation guards', async () => {
    const a = fixture(), aSession = view(a.runtime)
    const record = (projectId: string, text: string) => RecoveryCandidateRepository.record({
      projectId, runId: `fictional-${projectId}`, stepId: 'draft', chapterNumber: 1, chapterTitle: 'Fictional chapter',
      source: { chapterNumber: 1, title: 'Fictional chapter', role: '', purpose: '', keyEvents: '', characters: [] },
      sourceDraft: null, visibleText: text, failureCode: 'FICTIONAL_INTERRUPTION', failureReason: 'Isolated test',
    })
    const candidateA = record(a.project.projectId, 'A pending author candidate')
    const releaseA = projectRuntimeHost.acquireWork(a.runtime)
    try {
      const b = fixture(), bSession = view(b.runtime)
      const candidateB = record(b.project.projectId, 'B pending author candidate')
      await expect(invoke('db:recovery-candidate-list', bSession)).resolves.toEqual([candidateB])
      await expect(invoke('db:recovery-candidate-list', aSession)).rejects.toThrow('PROJECT_SESSION_STALE')
      await expect(invoke('db:recovery-candidate-update', bSession, candidateB.candidateId, 'must not write'))
        .resolves.toMatchObject({ success: false, error: 'Error: PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE' })
      expect(b.runtime.database.prepare('SELECT visible_text FROM recovery_candidates').pluck().all()).toEqual(['B pending author candidate'])
      const renewedA = view(a.runtime)
      await expect(invoke('db:recovery-candidate-list', renewedA)).resolves.toEqual([candidateA])
      expect(a.runtime.database.prepare('SELECT visible_text FROM recovery_candidates').pluck().all()).toEqual(['A pending author candidate'])
    } finally { releaseA() }
  })

  it('loads B and writes only B while captured A work remains admitted, then reattaches A with a fresh lease', async () => {
    const a = fixture(), aSession = view(a.runtime)
    const aDraft = DraftRepository.create({ chapterNumber: 1, source: 'write', content: 'fictional A', wordCount: 11 })
    const releaseBackground = projectRuntimeHost.acquireWork(a.runtime)
    try {
      const b = fixture(), bSession = view(b.runtime)
      const bDraft = DraftRepository.create({ chapterNumber: 1, source: 'write', content: 'fictional B', wordCount: 11 })
      await expect(invoke('db:draft-list-all', bSession)).resolves.toMatchObject([{ id: bDraft }])
      await expect(invoke('db:draft-get-full', bSession, bDraft)).resolves.toMatchObject({ content: 'fictional B' })
      await expect(invoke('db:blueprint-get-all', bSession)).resolves.toEqual([])
      await expect(invoke('db:character-roster-read', bSession)).resolves.toHaveProperty('currentDerivedFields')
      await expect(invoke('fs:list-dir', bSession, b.runtime.canonicalRoot)).resolves.toEqual(expect.any(Array))
      await expect(invoke('fs:write-file', bSession, b.file, 'B author edit')).resolves.toMatchObject({ success: true, commitState: 'committed' })
      expect(fs.readFileSync(b.file, 'utf8')).toBe('B author edit')
      expect(fs.readFileSync(a.file, 'utf8')).toBe('unchanged')
      expect(() => projectRuntimeHost.acquireLegacyOperation('unmigrated')).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
      await expect(invoke('db:draft-update-content', bSession, bDraft, 'not admitted', 12)).resolves.toMatchObject({ success: false, error: 'Error: PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE' })
      await expect(invoke('db:draft-get-full', aSession, aDraft)).rejects.toThrow('PROJECT_SESSION_STALE')
      await expect(invoke('fs:write-file', bSession, a.file, 'cross project')).resolves.toMatchObject({ success: false, commitState: 'not_committed' })
      const renewedA = view(a.runtime)
      expect(renewedA.leaseId).not.toBe(aSession.leaseId)
      await expect(invoke('db:draft-get-full', renewedA, aDraft)).resolves.toMatchObject({ content: 'fictional A' })
      await expect(invoke('fs:read-file', renewedA, a.file)).resolves.toMatchObject({ success: true, content: 'unchanged' })
      expect(fs.readFileSync(b.file, 'utf8')).toBe('B author edit')
    } finally { releaseBackground() }
  })

  it('retains the view and native handles until the registered filesystem physical write settles', async () => {
    const a = fixture(), b = fixture(), session = view(b.runtime)
    let entered!: () => void, finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const physical = new Promise<void>(resolve => { finish = resolve })
    holdWrite = async () => { entered(); await physical }
    const writing = invoke('fs:write-file', session, b.file, 'physically settled B')
    try {
      await started
      expect(() => view(a.runtime)).toThrow('PROJECT_RUNTIME_VIEW_OPERATION_BUSY')
      expect(() => projectRuntimeHost.prepareRetainedOpen(a.project)).toThrow('PROJECT_RUNTIME_VIEW_OPERATION_BUSY')
      expect(() => projectRuntimeHost.acquireRestoreOperation()).toThrow('PROJECT_RUNTIME_VIEW_OPERATION_BUSY')
      await expect(projectRuntimeHost.requestClose(a.runtime)).rejects.toThrow('PROJECT_RUNTIME_VIEW_OPERATION_BUSY')
      await expect(projectRuntimeHost.requestClose(b.runtime)).rejects.toThrow('PROJECT_RUNTIME_VIEW_OPERATION_BUSY')
      expect(a.runtime.database.open && b.runtime.database.open).toBe(true)
      expect(fs.readFileSync(b.file, 'utf8')).toBe('unchanged')
    } finally { finish() }
    await expect(writing).resolves.toMatchObject({ success: true, commitState: 'committed' })
    view(a.runtime)
    expect(fs.readFileSync(a.file, 'utf8')).toBe('unchanged')
    expect(fs.readFileSync(b.file, 'utf8')).toBe('physically settled B')
  })
})

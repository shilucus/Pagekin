import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type Sqlite from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import type { AiNovelAPI } from '../../../src/shared/desktop-api'
import { projectSessionContextFromProject } from '../../../src/shared/project-session-context'
import { ipc } from '../../../src/services/ipc-client'
import { characterRosterEntriesFromCards } from '../../../src/services/character-roster-client'
import { EMPTY_CARD, useCharacterStore } from '../../../src/stores/character-store'
import { useDraftStore } from '../../../src/stores/draft-store'
import { useEditorStore } from '../../../src/stores/editor-store'
import { useLayoutStore } from '../../../src/stores/layout-store'
import { useProjectStore } from '../../../src/stores/project-store'
import { useWorkflowStore } from '../../../src/stores/workflow-store'
import { createProjectDatabase } from '../../database'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import { DraftRepository } from '../../repositories/draft-repository'
import { CharacterRosterRepository } from '../../repositories/character-roster-repository'
import { commitAuthorCharacterRoster } from '../../services/character-roster-author'
import { projectAccess } from '../../services/project-access'
import { deactivateProjectData } from '../../services/project-data-locator'
import { projectRuntimeHost } from '../../services/project-runtime'
import { registerDatabaseController } from '../db-controller'
import { registerFSController } from '../fs-controller'
import { registerProjectController } from '../project-controller'

type Handler = (...args: unknown[]) => unknown
interface RecentProject { name: string; path: string; projectId: string; updatedAt: string }
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  recent: [] as RecentProject[],
  alertError: vi.fn(),
  confirm: vi.fn(async () => true),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US', isPackaged: false },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) },
}))
vi.mock('../../utils/config-utils', () => ({
  RECENT_PROJECTS_PATH: 'fictional-switch-recent.json',
  GLOBAL_CONFIG_PATH: 'fictional-switch-config.json',
  DEFAULT_GLOBAL_CONFIG: { locale: 'en-US' },
  readJsonFile: (file: string, fallback: unknown) => file === 'fictional-switch-recent.json' ? mocks.recent : fallback,
  writeJsonFile: (file: string, value: RecentProject[]) => {
    if (file !== 'fictional-switch-recent.json') throw new Error('UNEXPECTED_SWITCH_CONFIG_WRITE')
    mocks.recent = value
  },
}))
vi.mock('../../utils/remembered-dialog', () => ({ showOpenDialogInLastDirectory: vi.fn() }))
vi.mock('../../services/external-file-grant-service', () => ({
  externalFileGrants: { resolveDirectoryPath: vi.fn(), issueDirectory: vi.fn(), revokeWebContents: vi.fn() },
}))
vi.mock('../../services/project-peek', () => ({
  projectPeekService: { issueCapability: () => null, revokeCapability: vi.fn() },
}))
vi.mock('../../../src/components/ui/AlertDialog', () => ({ alertError: mocks.alertError }))
vi.mock('../../../src/components/ui/Confirm', () => ({ confirm: mocks.confirm }))

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof Sqlite
const fixtureBase = path.resolve('.runtime/.cache/creation-runtime-modernization/renderer-switch')
const ownedRoots: string[] = []
const event = { sender: { id: 29, once: () => undefined } }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

let delayedOpen: {
  rootPath: string
  arrived: ReturnType<typeof deferred<unknown>>
  release: ReturnType<typeof deferred<void>>
} | null = null

const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`UNREGISTERED_SWITCH_CHANNEL:${channel}`)
  const result = await handler(event, ...args)
  const held = delayedOpen
  if (held && channel === 'project:open' && args[0] === held.rootPath) {
    held.arrived.resolve(result)
    await held.release.promise
  }
  return result
})

function withDatabase<T>(rootPath: string, operation: (database: Sqlite.Database) => T, readonly = false): T {
  const database = new Database(path.join(rootPath, '.ai-novel', 'project.db'), { readonly, fileMustExist: true })
  try { return operation(database) } finally { database.close() }
}

function fixture(label: string) {
  fs.mkdirSync(fixtureBase, { recursive: true })
  const rootPath = fs.mkdtempSync(path.join(fixtureBase, 'fiction-'))
  ownedRoots.push(rootPath)
  fs.mkdirSync(path.join(rootPath, '.ai-novel'))
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: '2026-11-07T00:00:00.000Z' })
  fs.writeFileSync(path.join(rootPath, '.ai-novel', 'project.json'), JSON.stringify(manifest))
  createProjectDatabase(rootPath)
  const seeded = withDatabase(rootPath, database => {
    ProjectCoreRepository.init(`Fiction ${label}`, 'en-US', database)
    ProjectCoreRepository.update({ coreOutline: `Fictional ${label} outline` }, database)
    const roster = CharacterRosterRepository.read(database)
    const receipt = commitAuthorCharacterRoster(database, {
      schemaVersion: 1, intent: 'manual_edit', operationId: `fiction-seed-${randomUUID()}`,
      expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision!,
      entries: characterRosterEntriesFromCards([{ ...EMPTY_CARD, characterId: `draft:${randomUUID()}`,
        name: `Fictional ${label} Keeper`, role: 'protagonist' }]),
    }, { projectId: manifest.projectId, epoch: 'isolated-fixture-seed' }, () => undefined)
    const draftId = DraftRepository.create({ chapterNumber: 1, source: 'write',
      content: `Fictional ${label} draft`, wordCount: 3 }, database)
    return { characterId: receipt.snapshot.entries[0].characterId!, draftId }
  })
  const filePath = path.join(rootPath, `fiction-${label}.txt`)
  fs.writeFileSync(filePath, `Fictional ${label} file`, 'utf8')
  mocks.recent.push({ name: `Fiction ${label}`, path: rootPath, projectId: manifest.projectId, updatedAt: manifest.createdAt })
  return { rootPath, projectId: manifest.projectId, filePath, ...seeded }
}

function snapshot(project: ReturnType<typeof fixture>) {
  return withDatabase(project.rootPath, database => ({
    coreOutline: ProjectCoreRepository.get(database)?.coreOutline,
    characters: database.prepare('SELECT character_id,name,notes FROM characters WHERE retired=0 ORDER BY character_id').all(),
    drafts: database.prepare('SELECT d.id,d.status,c.body FROM drafts_all d JOIN contents c ON c.id=d.content_id ORDER BY d.id').all(),
    file: fs.readFileSync(project.filePath, 'utf8'),
  }), true)
}

function currentSession() {
  const session = projectSessionContextFromProject(useProjectStore.getState().currentProject)
  if (!session) throw new Error('SWITCH_TEST_RENDERER_SESSION_MISSING')
  return session
}

function stageUnsavedChapter(project: ReturnType<typeof fixture>) {
  const tab = { id: 'fictional-unsaved-tab', type: 'chapter' as const, name: 'Fictional unsaved chapter',
    projectKey: project.rootPath, projectSessionLease: currentSession().leaseId,
    content: 'Fictional unsaved author buffer', contentRevision: 3, dirty: true }
  useEditorStore.setState({ tabs: [tab], activeTabId: tab.id })
  // The existing transition promises discard only after a successful open.
  mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  return tab
}

function removeOwnedFixture(rootPath: string) {
  if (!fs.existsSync(rootPath)) return
  if (path.dirname(rootPath) !== fixtureBase || fs.realpathSync.native(rootPath) !== rootPath) {
    throw new Error('SWITCH_FIXTURE_ROOT_MISMATCH')
  }
  const pending = [rootPath]
  for (const directory of pending) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('SWITCH_FIXTURE_REPARSE_POINT')
      if (entry.isDirectory()) pending.push(target)
    }
  }
  fs.rmSync(rootPath, { recursive: true, force: true })
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.recent = []
  vi.clearAllMocks()
  mocks.confirm.mockResolvedValue(true)
  delayedOpen = null
  useProjectStore.setState({ currentProject: null, fileTree: [], loading: false,
    projectSessionEpoch: 0, recentProjects: [], recentProjectsLoaded: false })
  useEditorStore.getState().clearTabs()
  useEditorStore.setState({ draftLedgers: {} })
  useCharacterStore.getState().reset()
  useDraftStore.getState().reset()
  useLayoutStore.setState({ settingsOpen: false, sidebarView: 'home' })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {},
    currentRun: null, waitingForConfirm: false, waitingAfterStepIndex: -1 })
  projectAccess.invalidateCurrentSession()
  const bridge = { invoke, on: () => () => undefined, once: () => undefined, send: () => undefined,
    setZoomLevel: () => undefined, setZoomFactor: () => undefined, getZoomLevel: () => 0 } as unknown as AiNovelAPI
  vi.stubGlobal('window', { aiNovelAPI: bridge })
  registerProjectController()
  registerDatabaseController()
  // Exercise the production handle-based filesystem, not a permissive Node fallback.
  registerFSController()
})

afterEach(() => {
  delayedOpen?.release.resolve()
  delayedOpen = null
  vi.restoreAllMocks()
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) {
    if (runtime.phase === 'open') projectRuntimeHost.releaseIdle(runtime)
    else {
      // A quarantined close is intentionally the final case in this module.
      if (runtime.database.open) runtime.database.close()
      deactivateProjectData(runtime.canonicalRoot)
    }
  }
  projectAccess.invalidateCurrentSession()
  useProjectStore.setState({ currentProject: null, fileTree: [], loading: false })
  useEditorStore.getState().clearTabs()
  useEditorStore.setState({ draftLedgers: {} })
  useCharacterStore.getState().reset()
  useDraftStore.getState().reset()
  vi.unstubAllGlobals()
  for (const root of ownedRoots.splice(0)) removeOwnedFixture(root)
})

describe('ordinary renderer switch through registered project resources', () => {
  it('loads and saves B files, cast, drafts and config without borrowing A resources', async () => {
    const a = fixture('A'), b = fixture('B')
    await expect(useProjectStore.getState().openProject(a.rootPath)).resolves.toBe(true)
    const runtimeA = projectRuntimeHost.getActiveView()!, sessionA = currentSession()
    expect(useCharacterStore.getState().characters.map(card => card.name)).toEqual(['Fictional A Keeper'])
    expect(useDraftStore.getState().draftsByChapter[1][0].id).toBe(a.draftId)
    expect(useProjectStore.getState().fileTree.map(node => node.name)).toEqual(['fiction-A.txt'])
    const beforeA = snapshot(a)

    await expect(useProjectStore.getState().openProject(b.rootPath)).resolves.toBe(true)
    const sessionB = currentSession(), runtimeB = projectRuntimeHost.getActiveView()!
    expect(runtimeA.database.open).toBe(false)
    expect(projectRuntimeHost.getOpenRuntimes()).toEqual([runtimeB])
    expect(runtimeB.projectId).toBe(b.projectId)
    expect(useProjectStore.getState().fileTree.map(node => node.name)).toEqual(['fiction-B.txt'])
    expect(useCharacterStore.getState().characters.map(card => card.name)).toEqual(['Fictional B Keeper'])
    expect(useCharacterStore.getState().dataProjectSession).toEqual(sessionB)
    expect(useDraftStore.getState().dataProjectSession).toEqual(sessionB)
    expect(useDraftStore.getState().draftsByChapter[1][0].id).toBe(b.draftId)
    expect(mocks.alertError).not.toHaveBeenCalled()
    await expect(ipc.invokeWithProjectSession(sessionA, 'db:draft-list-all', a.rootPath)).rejects.toThrow('PROJECT_SESSION')

    useCharacterStore.getState().updateField(b.characterId, 'notes', 'Fictional B edited notes')
    await useCharacterStore.getState().saveAll(b.rootPath, sessionB)
    await expect(ipc.invokeWithProjectSession(sessionB, 'db:draft-update-content', b.draftId,
      'Fictional B edited draft', 4, b.rootPath)).resolves.toMatchObject({ success: true })
    useProjectStore.getState().updateNovelConfig({ coreOutline: 'Fictional B edited outline' }, sessionB)
    await expect(useProjectStore.getState().saveProject(sessionB)).resolves.toBe(true)
    await expect(ipc.invokeWithProjectSession(sessionB, 'fs:write-file', b.filePath,
      'Fictional B edited file', b.rootPath)).resolves.toMatchObject({ success: true, commitState: 'committed' })
    await useDraftStore.getState().loadAllDrafts(b.rootPath, sessionB)
    expect(snapshot(b)).toMatchObject({ coreOutline: 'Fictional B edited outline',
      characters: [{ character_id: b.characterId, name: 'Fictional B Keeper', notes: 'Fictional B edited notes' }],
      drafts: [{ id: b.draftId, body: 'Fictional B edited draft' }], file: 'Fictional B edited file' })
    expect(snapshot(a)).toEqual(beforeA)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(expect.arrayContaining([
      'project:open', 'fs:list-dir', 'db:character-roster-read', 'db:draft-list-all',
      'db:character-roster-commit', 'db:draft-update-content', 'project:save', 'fs:write-file',
    ]))
  }, 60_000)

  it('keeps the original A handle, epoch, lease and author buffer when B preparation fails', async () => {
    const a = fixture('A'), b = fixture('B')
    await expect(useProjectStore.getState().openProject(a.rootPath)).resolves.toBe(true)
    const runtimeA = projectRuntimeHost.getActiveView()!, sessionA = currentSession()
    const nativeA = runtimeA.database, epochA = runtimeA.executionEpoch, tab = stageUnsavedChapter(a)
    const beforeA = snapshot(a)
    fs.writeFileSync(path.join(b.rootPath, '.ai-novel', 'project.db'), 'fictional invalid sqlite')

    await expect(useProjectStore.getState().openProject(b.rootPath)).resolves.toBe(false)
    expect(currentSession()).toEqual(sessionA)
    expect(projectAccess.captureCurrentSession()?.leaseId).toBe(sessionA.leaseId)
    expect(projectRuntimeHost.getActiveView()).toBe(runtimeA)
    expect(runtimeA.database).toBe(nativeA)
    expect(runtimeA.executionEpoch).toBe(epochA)
    expect(nativeA.open).toBe(true)
    expect(useEditorStore.getState().tabs).toEqual([tab])
    expect(snapshot(a)).toEqual(beforeA)
    expect(useCharacterStore.getState().characters[0].characterId).toBe(a.characterId)
    expect(useDraftStore.getState().dataProjectSession).toEqual(sessionA)
  }, 60_000)

  it('does not resurrect A when a committed B response arrives after newer C has loaded', async () => {
    const a = fixture('A'), b = fixture('B'), c = fixture('C')
    await expect(useProjectStore.getState().openProject(a.rootPath)).resolves.toBe(true)
    const runtimeA = projectRuntimeHost.getActiveView()!, sessionA = currentSession()
    const held = { rootPath: b.rootPath, arrived: deferred<unknown>(), release: deferred<void>() }
    delayedOpen = held
    const openingB = useProjectStore.getState().openProject(b.rootPath)
    try {
      await expect(held.arrived.promise).resolves.toMatchObject({ success: true, activeProjectPath: b.rootPath })
      expect(projectRuntimeHost.getActiveView()?.projectId).toBe(b.projectId)
      expect(currentSession()).toEqual(sessionA)
      await expect(useProjectStore.getState().openProject(c.rootPath)).resolves.toBe(true)
      const sessionC = currentSession(), runtimeC = projectRuntimeHost.getActiveView()!
      held.release.resolve()
      await expect(openingB).resolves.toBe(false)
      expect(currentSession()).toEqual(sessionC)
      expect(projectRuntimeHost.getActiveView()).toBe(runtimeC)
      expect(projectAccess.captureCurrentSession()?.leaseId).toBe(sessionC.leaseId)
      expect(runtimeA.database.open).toBe(false)
      expect(projectRuntimeHost.getOpenRuntimes()).toEqual([runtimeC])
      expect(useCharacterStore.getState().characters.map(card => card.name)).toEqual(['Fictional C Keeper'])
      expect(useDraftStore.getState().dataProjectSession).toEqual(sessionC)
      expect(useProjectStore.getState().fileTree.map(node => node.name)).toEqual(['fiction-C.txt'])
      expect(mocks.alertError).not.toHaveBeenCalled()
    } finally {
      held.release.resolve()
      await openingB
    }
  }, 60_000)

  it('detaches the old renderer and preserves its buffer if A release fails after B commits', async () => {
    const a = fixture('A'), b = fixture('B')
    withDatabase(b.rootPath, database => database.prepare("DELETE FROM project_core WHERE id='main'").run())
    await expect(useProjectStore.getState().openProject(a.rootPath)).resolves.toBe(true)
    const runtimeA = projectRuntimeHost.getActiveView()!, sessionA = currentSession()
    const tab = stageUnsavedChapter(a)
    const dispose = projectRuntimeHost.onBeforeRelease(runtime => {
      if (runtime === runtimeA) throw new Error('FICTIONAL_SWITCH_OLD_CLOSE_FAILURE')
    })
    try {
      await expect(useProjectStore.getState().openProject(b.rootPath)).resolves.toBe(false)
      const runtimeB = projectRuntimeHost.getActiveView()!
      expect(runtimeB.projectId).toBe(b.projectId)
      expect(ProjectCoreRepository.get(runtimeB.database)?.projectName).toBe(path.basename(b.rootPath))
      expect(projectAccess.captureCurrentSession()?.projectId).toBe(b.projectId)
      expect(projectAccess.captureCurrentSession()?.leaseId).not.toBe(sessionA.leaseId)
      expect(runtimeA.phase).toBe('closing')
      expect(useProjectStore.getState().currentProject).toBeNull()
      expect(useProjectStore.getState().fileTree).toEqual([])
      expect(useEditorStore.getState().tabs).toEqual([tab])
      expect(useCharacterStore.getState().dataProjectSession).toBeNull()
      expect(useDraftStore.getState().dataProjectSession).toBeNull()
      await expect(ipc.invokeWithProjectSession(sessionA, 'db:draft-update-content', a.draftId,
        'must not save through detached A', 5, a.rootPath)).resolves.toMatchObject({ success: false })
      expect(mocks.alertError).toHaveBeenCalledOnce()
    } finally { dispose() }
  }, 60_000)
})

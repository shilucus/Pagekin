import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterAvatarControllerDependencies } from '../controllers/character-avatar-controller'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const mocks = vi.hoisted(() => ({
  avatarDependencies: undefined as CharacterAvatarControllerDependencies | undefined,
  assertViewContext: vi.fn(),
  closeConnection: vi.fn(),
  database: null as import('better-sqlite3').Database | null,
  projectPath: '',
  storageRoot: '',
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  nativeImage: { createFromBuffer: vi.fn() },
}))
vi.mock('../services/app-data-locator', () => ({
  assertGlobalDataReady: vi.fn(),
  getGlobalDataRoot: () => mocks.storageRoot,
}))
vi.mock('../services/project-access', () => ({
  projectAccess: { assertViewContext: mocks.assertViewContext },
}))
vi.mock('../vector-store', () => ({ closeConnection: mocks.closeConnection }))
vi.mock('../utils/config-utils', () => ({
  tryReadJsonFile: vi.fn(() => { throw new Error('Unexpected global config read') }),
  readJsonFile: vi.fn(() => { throw new Error('Unexpected global config read') }),
  writeJsonFile: vi.fn(() => { throw new Error('Unexpected global config write') }),
}))
vi.mock('../controllers/character-avatar-controller', () => ({
  registerCharacterAvatarController: vi.fn((dependencies: CharacterAvatarControllerDependencies) => {
    mocks.avatarDependencies = dependencies
  }),
}))
vi.mock('../controllers/config-controller', () => ({ registerConfigController: vi.fn() }))
vi.mock('../controllers/project-controller', () => ({ registerProjectController: vi.fn() }))
vi.mock('../controllers/project-archive-controller', () => ({ registerProjectArchiveController: vi.fn() }))
vi.mock('../controllers/cloud-backup-controller', () => ({ registerCloudBackupController: vi.fn() }))
vi.mock('../controllers/fs-controller', () => ({ registerFSController: vi.fn() }))
vi.mock('../controllers/llm-controller', () => ({ registerLLMController: vi.fn() }))
vi.mock('../controllers/generation-controller', () => ({ registerGenerationController: vi.fn() }))
vi.mock('../controllers/db-controller', () => ({ registerDatabaseController: vi.fn() }))
vi.mock('../controllers/kb-controller', () => ({ registerKBController: vi.fn() }))
vi.mock('../controllers/import-controller', () => ({ registerImportController: vi.fn() }))
vi.mock('../controllers/window-controller', () => ({ registerWindowController: vi.fn() }))
vi.mock('../controllers/official-homepage-controller', () => ({ registerOfficialHomepageController: vi.fn() }))
vi.mock('../controllers/model-provider-resource-controller', () => ({ registerModelProviderResourceController: vi.fn() }))
vi.mock('../controllers/finalization-controller', () => ({ registerFinalizationController: vi.fn() }))
vi.mock('../controllers/chapter-lifecycle-controller', () => ({ registerChapterLifecycleController: vi.fn() }))
vi.mock('../controllers/external-file-grant-controller', () => ({ registerExternalFileGrantController: vi.fn() }))
vi.mock('../controllers/app-data-controller', () => ({ registerAppDataController: vi.fn() }))

import { registerIPCHandlers } from '../ipc-handlers'
import { M05_CHARACTER_ASSET_SQL } from '../migrations/m05-character-assets'
import { CharacterAssetService } from '../services/character-asset-service'
import { createProjectDatabase } from '../database'
import { createCanonicalProjectManifest } from '../../src/shared/project-format'
import { onProjectDatabaseBeforeClose, projectRuntimeHost, type ProjectRuntime } from '../services/project-runtime'
import { assertKnowledgeSourceIdle, isKnowledgeSourceBusy, withKnowledgeSourceGate } from '../services/knowledge-source-gate'

const roots: string[] = []
const disposers: Array<() => void> = []
const context = { projectId: 'project-a', leaseId: 'lease-a', projectPath: 'C:\\Novel' }

function openRuntime(): ProjectRuntime {
  const base = path.resolve('.runtime/rt-avatar-ipc-lifecycle')
  fs.mkdirSync(base, { recursive: true })
  const rootPath = fs.mkdtempSync(path.join(base, 'project-'))
  roots.push(rootPath)
  fs.mkdirSync(path.join(rootPath, '.ai-novel'))
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: '2026-11-07T00:00:00.000Z' })
  fs.writeFileSync(path.join(rootPath, '.ai-novel', 'project.json'), JSON.stringify(manifest))
  createProjectDatabase(rootPath)
  return projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen({
    kind: 'manifest', rootPath, projectId: manifest.projectId, storageFormat: 'canonical',
  }))
}

beforeEach(() => {
  mocks.avatarDependencies = undefined
  mocks.assertViewContext.mockReset()
  mocks.closeConnection.mockReset()
  mocks.projectPath = context.projectPath
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-ipc-lifecycle-'))
  roots.push(root)
  mocks.storageRoot = root
  mocks.database = new Database(':memory:')
  mocks.database.exec('CREATE TABLE characters(character_id TEXT PRIMARY KEY)')
  mocks.database.exec(M05_CHARACTER_ASSET_SQL)
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) projectRuntimeHost.releaseIdle(runtime)
  mocks.database?.close()
  mocks.database = null
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('character avatar production lifecycle', () => {
  it('records a crash leftover only after the current project session is validated', () => {
    const avatarDirectory = path.join(mocks.storageRoot, 'avatars')
    fs.mkdirSync(avatarDirectory)
    fs.writeFileSync(path.join(avatarDirectory, 'crash.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const scan = vi.spyOn(CharacterAssetService.prototype, 'recordReclaimableOrphans')
    registerIPCHandlers()
    const resolve = mocks.avatarDependencies!.resolveService

    mocks.assertViewContext.mockImplementationOnce(() => { throw new Error('stale session') })
    expect(resolve({}, context)).toBeNull()
    expect(scan).not.toHaveBeenCalled()
    expect(mocks.database!.prepare('SELECT COUNT(*) AS count FROM character_avatar_unresolved').get()).toEqual({ count: 0 })

    mocks.assertViewContext.mockReturnValue({ projectStorageRoot: mocks.storageRoot, database: mocks.database })
    expect(resolve({}, context)).toBeInstanceOf(CharacterAssetService)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(mocks.database!.prepare('SELECT disposition,source_reference FROM character_avatar_unresolved').get())
      .toEqual({ disposition: 'orphan', source_reference: 'runtime-crash' })
  })

  it('surfaces recovery scan failure after validation instead of returning a usable service', () => {
    mocks.assertViewContext.mockReturnValue({ projectStorageRoot: mocks.storageRoot, database: mocks.database })
    vi.spyOn(CharacterAssetService.prototype, 'recordReclaimableOrphans').mockImplementation(() => {
      throw new Error('orphan scan failed')
    })
    registerIPCHandlers()

    expect(() => mocks.avatarDependencies!.resolveService({}, context)).toThrow('orphan scan failed')
    expect(mocks.assertViewContext).toHaveBeenCalledOnce()
  })

  it('wires the real KB busy predicate before owner/hooks/native close, including the caller own gate', async () => {
    registerIPCHandlers()
    const a = openRuntime(), b = openRuntime()
    projectRuntimeHost.activateView(b)
    const owner = vi.fn()
    const releaseHook = vi.fn()
    disposers.push(onProjectDatabaseBeforeClose(owner))
    disposers.push(projectRuntimeHost.onBeforeRelease(releaseHook))
    const nativeClose = vi.spyOn(a.database, 'close')

    await withKnowledgeSourceGate(a.projectStorageRoot, async () => {
      // Source verification is reentrant; resource release deliberately is not.
      expect(() => assertKnowledgeSourceIdle(a.projectStorageRoot)).not.toThrow()
      expect(isKnowledgeSourceBusy(a.projectStorageRoot)).toBe(true)
      expect(isKnowledgeSourceBusy(b.projectStorageRoot)).toBe(false)
      expect(() => projectRuntimeHost.releaseIdle(a)).toThrow('PROJECT_RUNTIME_BUSY')
      expect(a.phase).toBe('open')
      expect(owner).not.toHaveBeenCalled()
      expect(releaseHook).not.toHaveBeenCalled()
      expect(mocks.closeConnection).not.toHaveBeenCalled()
      expect(nativeClose).not.toHaveBeenCalled()
      expect(a.database.prepare('SELECT 1').pluck().get()).toBe(1)
      expect(b.database.prepare('SELECT 1').pluck().get()).toBe(1)
    })

    expect(isKnowledgeSourceBusy(a.projectStorageRoot)).toBe(false)
    projectRuntimeHost.releaseIdle(a)
    expect(owner).toHaveBeenCalledExactlyOnceWith({ projectPath: a.canonicalRoot, database: a.database })
    expect(releaseHook).toHaveBeenCalledExactlyOnceWith(a)
    expect(mocks.closeConnection).toHaveBeenCalledExactlyOnceWith(a.canonicalRoot)
    expect(nativeClose).toHaveBeenCalledOnce()
    expect(a.database.open).toBe(false)
    expect(b.phase).toBe('open')
    expect(b.database.prepare('SELECT 1').pluck().get()).toBe(1)
    expect(projectRuntimeHost.getActiveView()).toBe(b)
  })
})

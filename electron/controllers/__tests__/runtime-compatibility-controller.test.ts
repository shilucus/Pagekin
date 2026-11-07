import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import type { ProjectSessionContext } from '../../../src/shared/ipc-channels'
import { createProjectDatabase } from '../../database'
import { projectAccess, type TrustedProject } from '../../services/project-access'
import { projectRuntimeHost, type ProjectRuntime } from '../../services/project-runtime'
import { externalFileGrants } from '../../services/external-file-grant-service'
import type { SecureFileCapability, WindowsSafeFileSystem } from '../../security/windows-safe-file-system'

type IpcHandler = (...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  run: vi.fn(), importText: vi.fn(), finalize: vi.fn(), retry: vi.fn(), readJsonFile: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US', isPackaged: false },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../utils/config-utils', () => ({
  readJsonFile: mocks.readJsonFile, GLOBAL_CONFIG_PATH: 'fixture-global.json', MODELS_CONFIG_PATH: 'fixture-models.json', DEFAULT_GLOBAL_CONFIG: {},
}))
vi.mock('../../utils/remembered-dialog', () => ({ showOpenDialogInLastDirectory: vi.fn() }))
vi.mock('../../services/knowledge-base-loader', () => ({ knowledgeBaseLoader: { run: mocks.run } }))
vi.mock('../../services/finalization-service', () => ({ FinalizationService: class {
  finalize = mocks.finalize
  retry = mocks.retry
} }))
vi.mock('../../i18n', () => ({ mainText: (_locale: string, _zh: string, en: string) => en }))

import { registerKBController } from '../kb-controller'
import { registerFinalizationController } from '../finalization-controller'

const roots: string[] = [], grants: string[] = []
const fileSystem = {
  readText: vi.fn<(capability: SecureFileCapability) => Promise<string>>(),
  listDirectory: vi.fn<WindowsSafeFileSystem['listDirectory']>(),
}
const event = { sender: { id: 71, once: vi.fn() } }

function fixture(): TrustedProject {
  const base = path.resolve('.runtime/rt-compat-controller')
  fs.mkdirSync(base, { recursive: true })
  const rootPath = fs.mkdtempSync(path.join(base, 'p-'))
  roots.push(rootPath)
  fs.mkdirSync(path.join(rootPath, '.ai-novel'))
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: '2026-11-07T00:00:00.000Z' })
  fs.writeFileSync(path.join(rootPath, '.ai-novel', 'project.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(rootPath, 'manuscript.txt'), 'fictional original manuscript')
  createProjectDatabase(rootPath)
  return { kind: 'manifest', rootPath, projectId: manifest.projectId, storageFormat: 'canonical' }
}

function open(project: TrustedProject): ProjectRuntime {
  const runtime = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen(project))
  runtime.database.exec(`INSERT INTO contents(id,body) VALUES(1,'fictional original manuscript');
    INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,3);
    INSERT INTO finalization_outbox_all(finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,target_file_name)
    VALUES('fixture-final',1,1,'Fictional chapter','${'a'.repeat(64)}',1,'fictional original manuscript','manuscript.txt')`)
  return runtime
}

function view(runtime: ProjectRuntime): ProjectSessionContext {
  const lease = projectAccess.beginViewSession(runtime)
  return { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
}

function handler(channel: string): IpcHandler {
  const value = mocks.handlers.get(channel)
  if (!value) throw new Error(`Missing fixture handler: ${channel}`)
  return value
}

function snapshot(context: ProjectSessionContext) {
  return { tabId: 'fictional-tab', projectPath: context.projectPath, projectSession: context,
    draftId: 1, chapterNumber: 1, chapterTitle: 'Fictional chapter', content: 'fictional replacement', contentRevision: 2 }
}

function state(runtime: ProjectRuntime) {
  return { contents: runtime.database.prepare('SELECT * FROM contents').all(),
    drafts: runtime.database.prepare('SELECT * FROM drafts_all').all(),
    outbox: runtime.database.prepare('SELECT * FROM finalization_outbox').all(),
    manuscript: fs.readFileSync(path.join(runtime.canonicalRoot, 'manuscript.txt')) }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function assertLifecycleBlocked(project: TrustedProject, other: TrustedProject, runtime: ProjectRuntime) {
  expect(() => projectRuntimeHost.prepareOpen(other)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
  expect(() => projectRuntimeHost.prepareOpen(project)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
  expect(() => projectRuntimeHost.activateView(runtime)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
  expect(() => projectRuntimeHost.activateView(null)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
  expect(() => projectRuntimeHost.releaseIdle(runtime)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
  expect(projectRuntimeHost.getActiveView()).toBe(runtime)
  expect(runtime.database.open).toBe(true)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.readJsonFile.mockImplementation((_file: string, fallback: unknown) => fallback)
  mocks.run.mockImplementation((operation: (kb: { importText: typeof mocks.importText }) => unknown) => operation({ importText: mocks.importText }))
  fileSystem.readText.mockResolvedValue('fictional external document')
  registerKBController(fileSystem as unknown as WindowsSafeFileSystem)
  registerFinalizationController()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const grant of grants.splice(0)) externalFileGrants.revoke(grant)
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) projectRuntimeHost.releaseIdle(runtime)
  projectAccess.invalidateCurrentSession()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('real controller legacy runtime interlocks', () => {
  it('rejects a two-runtime document import before consuming its grant or reading/configuring/loading', async () => {
    const a = open(fixture()), b = open(fixture()), context = view(a), beforeA = state(a), beforeB = state(b)
    const file = path.join(a.canonicalRoot, 'external.txt')
    fs.writeFileSync(file, 'fictional external document')
    const grant = externalFileGrants.issueFile({ webContentsId: event.sender.id, filePath: file,
      operations: ['read'], ttlMs: 60_000, maxUses: 1 })
    grants.push(grant.grantId)
    const resolve = vi.spyOn(externalFileGrants, 'resolve')
    await expect(handler('kb:import-document')(event, grant.grantId, a.canonicalRoot, context))
      .rejects.toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
    expect(resolve).not.toHaveBeenCalled()
    expect(fileSystem.readText).not.toHaveBeenCalled()
    expect(mocks.readJsonFile).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.importText).not.toHaveBeenCalled()
    expect(externalFileGrants.revalidate({ grantId: grant.grantId, webContentsId: event.sender.id, operation: 'read' }).relativePath).toBe('external.txt')
    expect(state(a)).toEqual(beforeA)
    expect(state(b)).toEqual(beforeB)
  })

  it.each(['success', 'throw'] as const)('holds the single-runtime KB operation across await and releases on %s', async mode => {
    const project = fixture(), other = fixture(), runtime = open(project), context = view(runtime)
    const entered = deferred(), finish = deferred()
    mocks.importText.mockImplementation(async () => {
      entered.resolve()
      await finish.promise
      if (mode === 'throw') throw new Error('fictional KB failure')
      return { success: true, docId: 'fictional-doc' }
    })
    const result = handler('kb:import-text')(event, 'fictional reference', 'notes.txt', runtime.canonicalRoot, context)
    const settled = result.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    await entered.promise
    try { assertLifecycleBlocked(project, other, runtime) }
    finally { finish.resolve(); await settled }
    const outcome = await settled
    if (mode === 'throw') {
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toEqual(new Error('fictional KB failure'))
    } else {
      expect(outcome).toEqual({ ok: true, value: { success: true, docId: 'fictional-doc' } })
    }
    expect(mocks.run).toHaveBeenCalledOnce()
    expect(mocks.importText).toHaveBeenCalledOnce()
    expect(projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen(project))).toBe(runtime)
    const second = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen(other))
    projectRuntimeHost.activateView(second)
    projectRuntimeHost.releaseIdle(second)
    expect(runtime.database.open).toBe(true)
  })

  it.each(['finalization:commit', 'finalization:retry'] as const)('rejects multi-runtime %s before service and preserves both outboxes/manuscripts', async channel => {
    const a = open(fixture()), b = open(fixture()), context = view(a), beforeA = state(a), beforeB = state(b)
    const input = channel === 'finalization:commit' ? snapshot(context) : 'fixture-final'
    await expect(handler(channel)(event, input, context)).resolves.toEqual({
      success: false, committed: false, error: 'Error: PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE',
    })
    expect(mocks.finalize).not.toHaveBeenCalled()
    expect(mocks.retry).not.toHaveBeenCalled()
    expect(state(a)).toEqual(beforeA)
    expect(state(b)).toEqual(beforeB)
  })

  it.each([
    ['finalization:commit', 'success'], ['finalization:commit', 'throw'],
    ['finalization:retry', 'success'], ['finalization:retry', 'throw'],
  ] as const)('holds %s across await and releases its lifecycle interlock on %s', async (channel, mode) => {
    const project = fixture(), other = fixture(), runtime = open(project), context = view(runtime), before = state(runtime)
    const entered = deferred(), finish = deferred()
    const service = channel === 'finalization:commit' ? mocks.finalize : mocks.retry
    service.mockImplementation(async () => {
      entered.resolve()
      await finish.promise
      if (mode === 'throw') throw new Error('fictional finalization failure')
      return { success: true, committed: true, finalizationId: 'fictional-result' }
    })
    const input = channel === 'finalization:commit' ? snapshot(context) : 'fixture-final'
    const result = handler(channel)(event, input, context)
    await entered.promise
    try { assertLifecycleBlocked(project, other, runtime) }
    finally { finish.resolve(); await result }
    await expect(result).resolves.toEqual(mode === 'throw'
      ? { success: false, committed: false, error: 'Error: fictional finalization failure' }
      : { success: true, committed: true, finalizationId: 'fictional-result' })
    expect(service).toHaveBeenCalledOnce()
    expect(state(runtime)).toEqual(before)
    expect(projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen(project))).toBe(runtime)
    const second = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen(other))
    projectRuntimeHost.activateView(second)
    projectRuntimeHost.releaseIdle(second)
    expect(runtime.database.open).toBe(true)
  })
})

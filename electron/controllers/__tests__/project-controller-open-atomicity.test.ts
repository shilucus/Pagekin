import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type Sqlite from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { createProjectDatabase } from '../../database'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'
import { projectAccess, type TrustedProject } from '../../services/project-access'
import { projectRuntimeHost, type PreparedRuntimeOpen, type ProjectRuntime } from '../../services/project-runtime'
import { deactivateProjectData } from '../../services/project-data-locator'
import { createPortableTransferAuthority, mapPortableTransferAuthority,
  serializePortableTransferAuthority } from '../../services/portable-transfer-authority'
import { readPortableCurrentAuthority } from '../../services/portable-current-authority'
import { registerProjectController } from '../project-controller'

type Handler = (...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  recent: [] as Array<{ name: string; path: string; projectId: string; updatedAt: string }>,
  writeRecent: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) },
}))
vi.mock('../../utils/config-utils', () => ({
  RECENT_PROJECTS_PATH: 'fictional-recent-projects.json',
  readJsonFile: (_file: string, fallback: unknown) => mocks.recent.length ? mocks.recent : fallback,
  writeJsonFile: mocks.writeRecent,
}))
vi.mock('../../utils/remembered-dialog', () => ({ showOpenDialogInLastDirectory: vi.fn() }))
vi.mock('../../services/external-file-grant-service', () => ({
  externalFileGrants: { resolveDirectoryPath: vi.fn(), issueDirectory: vi.fn(), revokeWebContents: vi.fn() },
}))
vi.mock('../../services/project-peek', () => ({
  projectPeekService: { issueCapability: vi.fn(), revokeCapability: vi.fn() },
}))
vi.mock('../../services/legacy-project-copy-import', () => ({ importLegacyProjectCopy: vi.fn() }))
vi.mock('../../i18n', () => ({ mainText: (_locale: string, _zh: string, en: string) => en }))

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof Sqlite
const roots: string[] = []
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

function fixture(): TrustedProject {
  const base = path.resolve('.runtime/.cache/creation-runtime-modernization/controller-open-atomicity')
  fs.mkdirSync(base, { recursive: true })
  const rootPath = fs.mkdtempSync(path.join(base, 'fiction-'))
  roots.push(rootPath)
  fs.mkdirSync(path.join(rootPath, '.ai-novel'))
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: '2026-11-07T00:00:00.000Z' })
  fs.writeFileSync(path.join(rootPath, '.ai-novel', 'project.json'), JSON.stringify(manifest))
  createProjectDatabase(rootPath)
  mocks.recent.push({ name: 'Fictional book', path: rootPath, projectId: manifest.projectId, updatedAt: manifest.createdAt })
  return { kind: 'manifest', rootPath, projectId: manifest.projectId, storageFormat: 'canonical' }
}

function withDatabase<T>(project: TrustedProject, operation: (db: Sqlite.Database) => T): T {
  const db = new Database(path.join(project.rootPath, '.ai-novel', 'project.db'))
  try { return operation(db) } finally { db.close() }
}

function seedTransferredTarget(project: TrustedProject) {
  const originProjectId = randomUUID()
  withDatabase(project, db => {
    for (const version of [1, 2]) {
      const body = `fictional final ${version}`
      db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(version, body)
      db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id) VALUES(?,1,?,'finalized',?)")
        .run(version, version, version)
      db.prepare(`INSERT INTO finalization_outbox_all(finalization_id,draft_id,chapter_number,content_hash,content_revision,
        content_snapshot,target_file_name,knowledge_document_id,publication_status) VALUES(?,?,1,?,1,?,?,?,'published')`)
        .run(`final-${version}`, version, sha256(body), body, `chapter-${version}.txt`, `kb-${version}`)
    }
    db.prepare(`INSERT INTO post_process_runs(id,trigger_source_type,trigger_source_id,source_label,all_critical_passed)
      VALUES('fiction-run','chapter_finalize','finalization:final-2','fictional',1)`).run()
    db.prepare("INSERT INTO post_process_steps(run_id,step_key,label,critical) VALUES('fiction-run','review','Review',1)")
      .run()
    db.prepare(`INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,
      total_chapters,manifest_chapter_count,status,execution_owner,execution_epoch,lease_expires_at)
      VALUES('fiction-import','fiction-import','fiction-import','source','manifest','en-US',1,1,'running','previous-owner',5,12345)`)
      .run()
    const provenance = { location: { kind: 'derived', revision: 1,
      source: { draftId: 2, finalizationId: 'final-2', chapterNumber: 1, contentHash: sha256('fictional final 2') },
      sourceOrder: { chapterNumber: 1, continuityEpoch: `${originProjectId}:0` } } }
    db.prepare(`INSERT INTO characters(character_id,static_provenance,identity_revision,retired,name,role,cs_location,cs_provenance)
      VALUES(?,'{"kind":"author"}',0,0,'Fictional Keeper','protagonist','Fictional Tower',?)`)
      .run(randomUUID(), JSON.stringify(provenance))
    const authority = mapPortableTransferAuthority(createPortableTransferAuthority({ database: db, originProjectId,
      snapshotGeneration: 'fiction-open-atomicity', portableDatabaseSha256: sha256('fictional donor') }), project.projectId)
    fs.writeFileSync(path.join(project.rootPath, '.ai-novel', 'portable-transfer-authority.json'),
      serializePortableTransferAuthority(authority))
    fs.writeFileSync(path.join(project.rootPath, '.ai-novel', 'portable-runtime-freeze.json'), JSON.stringify({
      version: 1, originProjectId, snapshotGeneration: 'fiction-open-atomicity', nonReplayable: true,
      requiresRuntimeFreezeGuard: true, records: [], avatarReferenceProjections: [],
    }))
    expect(readPortableCurrentAuthority({ database: db, projectId: project.projectId,
      projectStorageRoot: path.join(project.rootPath, '.ai-novel') })).toMatchObject({ originProjectId })
  })
  return originProjectId
}

function snapshot(project: TrustedProject) {
  return withDatabase(project, db => ({
    tables: (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[])
      .map(name => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
        .map(row => JSON.stringify(row)).sort() })),
    authority: fs.readFileSync(path.join(project.rootPath, '.ai-novel', 'portable-transfer-authority.json'), 'utf8'),
    freeze: fs.readFileSync(path.join(project.rootPath, '.ai-novel', 'portable-runtime-freeze.json'), 'utf8'),
  }))
}

function open(project: TrustedProject, token: string, retained = true) {
  const channel = retained ? 'project-runtime:v1:open-view' : 'project:open'
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`Missing ${channel} handler`)
  return handler({ sender: { id: 17 } }, project.rootPath, token)
}

function currentView(project: TrustedProject) {
  const runtime = projectRuntimeHost.commitOpen(projectRuntimeHost.prepareOpen(project))
  ProjectCoreRepository.init('Fictional A', 'en-US', runtime.database)
  const session = projectAccess.beginViewSession(runtime)
  return { runtime, session, database: runtime.database, identity: runtime.databaseIdentity, epoch: runtime.executionEpoch }
}

function expectUnchangedView(before: ReturnType<typeof currentView>) {
  expect(projectRuntimeHost.getActiveView()).toBe(before.runtime)
  expect(projectAccess.captureCurrentSession()).toEqual(before.session)
  expect(before.runtime.database).toBe(before.database)
  expect(before.runtime.databaseIdentity).toBe(before.identity)
  expect(before.runtime.executionEpoch).toBe(before.epoch)
  expect(before.database.prepare('SELECT 1').pluck().get()).toBe(1)
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.recent = []
  mocks.writeRecent.mockReset()
  mocks.writeRecent.mockImplementation((_file: string, entries: typeof mocks.recent) => { mocks.recent = entries })
  registerProjectController()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) {
    if (runtime.phase === 'open') projectRuntimeHost.releaseIdle(runtime)
    else {
      // Keep failed-release quarantine semantics; dispose only the owned fictional native handle.
      if (runtime.database.open) runtime.database.close()
      deactivateProjectData(runtime.canonicalRoot)
    }
  }
  projectAccess.invalidateCurrentSession()
  const base = path.resolve('.runtime/.cache/creation-runtime-modernization/controller-open-atomicity')
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== base) throw new Error('FICTION_FIXTURE_ROOT_MISMATCH')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('registered project open native transaction boundary', () => {
  it.each([false, true])('rolls back real continuity adoption and core initialization if recent registration fails (retained=%s)', async retained => {
    const a = currentView(fixture()), b = fixture()
    seedTransferredTarget(b)
    const before = snapshot(b)
    mocks.writeRecent.mockImplementationOnce(() => { throw new Error('FICTION_RECENT_FAILURE') })
    await expect(open(b, 'recent-fails', retained)).resolves.toMatchObject({ success: false, error: expect.stringContaining('FICTION_RECENT_FAILURE') })
    expect(snapshot(b)).toEqual(before)
    expect(projectRuntimeHost.getOpenRuntimes()).toEqual([a.runtime])
    expectUnchangedView(a)
  })

  it.each([false, true])('does not start business writes when the final lease identity preflight fails (retained=%s)', async retained => {
    const a = currentView(fixture()), b = fixture()
    seedTransferredTarget(b)
    const before = snapshot(b), probe = projectAccess.probeExistingProject.bind(projectAccess)
    vi.spyOn(projectAccess, 'probeExistingProject').mockImplementation(root => {
      if (root === b.rootPath && projectRuntimeHost.getOpenRuntimes().some(runtime => runtime.canonicalRoot === b.rootPath)) {
        throw new Error('FICTION_LEASE_PREFLIGHT_FAILURE')
      }
      return probe(root)
    })
    await expect(open(b, 'lease-fails', retained)).resolves.toMatchObject({ success: false })
    expect(snapshot(b)).toEqual(before)
    expect(mocks.writeRecent).not.toHaveBeenCalled()
    expectUnchangedView(a)
  })

  it.each([false, true])('rolls back adoption, repair, initialization and the first fence on a real SQLite COMMIT failure (retained=%s)', async retained => {
    const a = currentView(fixture()), b = fixture()
    seedTransferredTarget(b)
    const before = snapshot(b), commit = projectRuntimeHost.commitViewOpen.bind(projectRuntimeHost)
    function failCommit<T>(ticket: PreparedRuntimeOpen, operation: (runtime: ProjectRuntime) => T, publishSession?: () => void): T {
      return commit(ticket, runtime => {
        const value = operation(runtime)
        // Existing FK, deferred until native COMMIT: no production schema changes or mocked transactions.
        runtime.database.pragma('defer_foreign_keys = ON')
        runtime.database.prepare("INSERT INTO post_process_steps(run_id,step_key,label) VALUES('fiction-missing-run','invalid','Fictional')").run()
        return value
      }, publishSession)
    }
    vi.spyOn(projectRuntimeHost, 'commitViewOpen').mockImplementation(failCommit)
    await expect(open(b, 'commit-fails', retained)).resolves.toMatchObject({ success: false, error: expect.stringContaining('FOREIGN KEY') })
    expect(snapshot(b)).toEqual(before)
    expect(mocks.writeRecent).toHaveBeenCalledOnce()
    expectUnchangedView(a)
  })

  it.each([false, true])('rolls back an in-flight superseded B before the queued C publishes, without resurrecting A (retained=%s)', async retained => {
    const a = currentView(fixture()), b = fixture(), c = fixture()
    seedTransferredTarget(b)
    const before = snapshot(b), get = ProjectCoreRepository.get.bind(ProjectCoreRepository)
    let next: Promise<unknown> | undefined
    vi.spyOn(ProjectCoreRepository, 'get').mockImplementation(db => {
      const value = get(db)
      if (db !== a.database && !next) next = open(c, 'winner-C', retained)
      return value
    })
    await expect(open(b, 'superseded-B', retained)).resolves.toMatchObject({ success: false, stale: true })
    expect(snapshot(b)).toEqual(before)
    await expect(next).resolves.toMatchObject({ success: true, project: { id: c.projectId } })
    expect(projectRuntimeHost.getActiveView()?.projectId).toBe(c.projectId)
    expect(projectAccess.captureCurrentSession()?.projectId).toBe(c.projectId)
    expect(a.database.open).toBe(retained)
  })

  it('commits actual source-proven adoption, duplicate repair, initialization and fencing before publishing B', async () => {
    const a = currentView(fixture()), b = fixture()
    const origin = seedTransferredTarget(b), sidecars = snapshot(b)
    await expect(open(b, 'successful-B')).resolves.toMatchObject({ success: true, project: { id: b.projectId },
      finalizationRepair: { status: 'checked', chapters: [{ keptDraftId: 2 }] } })
    const runtime = projectRuntimeHost.getActiveView()!
    expect(runtime.projectId).toBe(b.projectId)
    expect(projectAccess.captureCurrentSession()?.projectId).toBe(b.projectId)
    expect(ProjectCoreRepository.get(runtime.database)?.projectName).toBe(path.basename(b.rootPath))
    expect(runtime.database.prepare('SELECT id,status FROM drafts_all ORDER BY id').all()).toEqual([
      { id: 1, status: 'superseded' }, { id: 2, status: 'finalized' },
    ])
    const provenance = JSON.parse(runtime.database.prepare('SELECT cs_provenance FROM characters').pluck().get() as string)
    expect(provenance.location.sourceOrder.continuityEpoch).toBe(`${b.projectId}:0`)
    expect(provenance.location.sourceOrder.continuityEpoch).not.toContain(origin)
    expect(runtime.database.prepare('SELECT step_key FROM post_process_steps ORDER BY id').pluck().all()).toEqual([
      'review', 'remove_replaced_knowledge', 'remove_replaced_manuscripts',
    ])
    expect(runtime.database.prepare("SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs WHERE id='fiction-import'").get())
      .toEqual({ execution_owner: '', execution_epoch: 6, lease_expires_at: 0 })
    const after = snapshot(b)
    expect(after.authority).toBe(sidecars.authority)
    expect(after.freeze).toBe(sidecars.freeze)
    expect(a.database.open).toBe(true)
  })

  it('keeps the ordinary single-book UI usable by releasing only its previous idle compatibility runtime', async () => {
    const a = currentView(fixture()), b = fixture()
    await expect(open(b, 'ordinary-B', false)).resolves.toMatchObject({ success: true, activeProjectPath: b.rootPath })
    const active = projectRuntimeHost.getActiveView()!
    expect(active.projectId).toBe(b.projectId)
    expect(projectRuntimeHost.getOpenRuntimes()).toEqual([active])
    expect(a.database.open).toBe(false)
    const release = projectRuntimeHost.acquireLegacyOperation('fictional-existing-ui-read')
    release()
  })

  it('rejects an ordinary switch before admitting B when A is physically busy', async () => {
    const a = currentView(fixture()), b = fixture()
    seedTransferredTarget(b)
    const before = snapshot(b)
    const dispose = projectRuntimeHost.registerBusyPredicate(runtime => runtime === a.runtime)
    try {
      await expect(open(b, 'busy-A', false)).resolves.toMatchObject({ success: false })
      expect(snapshot(b)).toEqual(before)
      expect(projectRuntimeHost.getOpenRuntimes()).toEqual([a.runtime])
      expectUnchangedView(a)
    } finally { dispose() }
  })

  it('does not grant an old open permission to release an explicitly retained A', async () => {
    const a = currentView(fixture()), b = fixture()
    await expect(open({ kind: 'manifest', rootPath: a.runtime.canonicalRoot, projectId: a.runtime.projectId }, 'retain-A'))
      .resolves.toMatchObject({ success: true })
    const retainedLease = projectAccess.captureCurrentSession()
    await expect(open(b, 'cannot-release-retained-A', false)).resolves.toMatchObject({ success: false })
    expect(projectRuntimeHost.getOpenRuntimes()).toEqual([a.runtime])
    expect(projectRuntimeHost.getActiveView()).toBe(a.runtime)
    expect(projectAccess.captureCurrentSession()).toEqual(retainedLease)
    expect(a.database.open).toBe(true)
  })

  it('rotates only the lease when an ordinary open addresses the same canonical A through an alias', async () => {
    const a = currentView(fixture()), rootPath = `${a.runtime.canonicalRoot}${path.sep}.`
    mocks.recent.push({ name: 'Fictional alias', path: rootPath, projectId: a.runtime.projectId, updatedAt: '2026-11-07' })
    await expect(open({ kind: 'manifest', rootPath, projectId: a.runtime.projectId }, 'ordinary-alias-A', false))
      .resolves.toMatchObject({ success: true })
    expect(projectRuntimeHost.getOpenRuntimes()).toEqual([a.runtime])
    expect(projectRuntimeHost.getActiveView()).toBe(a.runtime)
    expect(a.database.open).toBe(true)
    expect(a.runtime.executionEpoch).toBe(a.epoch)
    expect(projectAccess.captureCurrentSession()?.leaseId).not.toBe(a.session.leaseId)
  })

  it('reports committed B accurately if releasing A fails after native COMMIT, without reopening A', async () => {
    const a = currentView(fixture()), b = fixture()
    const abort = vi.spyOn(projectRuntimeHost, 'abortOpen')
    const dispose = projectRuntimeHost.onBeforeRelease(runtime => {
      if (runtime === a.runtime) throw new Error('FICTION_A_CLOSE_FAILURE')
    })
    try {
      await expect(open(b, 'A-close-partially-fails', false)).resolves.toMatchObject({
        success: false, databaseRestored: false, dbReady: true, activeProjectPath: b.rootPath,
        error: expect.stringContaining('PROJECT_RUNTIME_PREVIOUS_CLOSE_FAILED'),
      })
      expect(projectRuntimeHost.getActiveView()?.projectId).toBe(b.projectId)
      expect(projectAccess.captureCurrentSession()?.projectId).toBe(b.projectId)
      expect(abort).not.toHaveBeenCalled()
      expect(a.runtime.phase).toBe('closing')
      expect(a.runtime.databaseIdentity).toBe(a.identity)
      expect(a.runtime.executionEpoch).toBe(a.epoch)
      expect(withDatabase(b, db => ProjectCoreRepository.get(db)?.projectName)).toBe(path.basename(b.rootPath))
    } finally { dispose() }
  })
})

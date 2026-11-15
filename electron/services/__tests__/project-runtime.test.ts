import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectDatabase, getCurrentProjectPath, getProjectDb, initProjectDatabase, closeProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { ProjectAccessService, type TrustedProject } from '../project-access'
import { deactivateProjectData, getProjectDataRoot } from '../project-data-locator'
import { onProjectDatabaseBeforeClose, ProjectRuntimeHost, ProjectRuntimePreviousCloseError, projectRuntimeHost, type ProjectRuntime } from '../project-runtime'

const roots: string[] = []
const hosts = new Set<ProjectRuntimeHost>()
const disposers: Array<() => void> = []
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function fixture(): TrustedProject {
  const base = path.resolve('.runtime/.cache/creation-runtime-modernization/runtime-host')
  fs.mkdirSync(base, { recursive: true })
  const rootPath = fs.mkdtempSync(path.join(base, 'project-'))
  roots.push(rootPath)
  fs.mkdirSync(path.join(rootPath, '.ai-novel'))
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: '2026-11-07T00:00:00.000Z' })
  fs.writeFileSync(path.join(rootPath, '.ai-novel', 'project.json'), JSON.stringify(manifest))
  createProjectDatabase(rootPath)
  return { kind: 'manifest', rootPath, projectId: manifest.projectId, storageFormat: 'canonical' }
}

function host(): ProjectRuntimeHost {
  const value = new ProjectRuntimeHost()
  hosts.add(value)
  return value
}

function open(value: ProjectRuntimeHost, project: TrustedProject): ProjectRuntime {
  return value.commitOpen(value.prepareOpen(project))
}

function backgroundView(value: ProjectRuntimeHost, project: TrustedProject): ProjectRuntime {
  const ticket = value.prepareBackgroundViewOpen(project)
  value.commitViewOpen(ticket, () => undefined)
  value.finishBackgroundViewOpen(ticket)
  return ticket.runtime
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dispose of disposers.splice(0)) dispose()
  for (const value of hosts) {
    for (const runtime of value.getOpenRuntimes()) {
      if (runtime.phase === 'open') value.releaseIdle(runtime)
      else {
        // A failed-release quarantine cannot be reused; dispose test-only handles.
        if (runtime.database.open) runtime.database.close()
        deactivateProjectData(runtime.canonicalRoot)
      }
    }
  }
  hosts.clear()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('explicit native project runtime host', () => {
  it('rejects the original async assertion before its first segment through the managed open wrapper', async () => {
    const value = host(), a = open(value, fixture()), target = fixture()
    value.activateView(a)
    const release = value.acquireViewOperation(a), called = vi.fn()
    const pending = value.prepareBackgroundViewOpenAfterDrain(target, async () => { called() })
    const rejected = expect(pending).rejects.toThrow('PROJECT_RUNTIME_VIEW_PREFLIGHT_MUST_BE_SYNCHRONOUS')
    try {
      expect(release).not.toThrow()
      await rejected
      expect(called).not.toHaveBeenCalled()
      expect(value.getOpenRuntimes()).toEqual([a])
      expect(value.getActiveView()).toBe(a)
      value.acquireViewOperation(a)()
      value.assertCompatibilityOpenAvailable()
    } finally { release() }
  })

  it.each(['throw', 'async'] as const)('rejects a %s drain callback without poisoning completed physical work or retaining a ticket', async mode => {
    const value = host(), a = open(value, fixture())
    value.activateView(a)
    const release = value.acquireViewOperation(a)
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const physical = gate.then(() => 'physical result').finally(release)
    const called = vi.fn()
    const callback = mode === 'async' ? async () => { called(); return 'must not be admitted' }
      : () => { called(); throw new Error('FICTIONAL_DRAIN_CALLBACK_FAILURE') }
    const pending = value.runAfterViewOperationsDrained(a, callback)
    const rejected = expect(pending).rejects.toThrow(mode === 'async'
      ? 'PROJECT_RUNTIME_VIEW_PREFLIGHT_MUST_BE_SYNCHRONOUS' : 'FICTIONAL_DRAIN_CALLBACK_FAILURE')
    try {
      finish()
      await expect(physical).resolves.toBe('physical result')
      await rejected
      if (mode === 'async') expect(called).not.toHaveBeenCalled()
      else expect(called).toHaveBeenCalledOnce()
      expect(value.getOpenRuntimes()).toEqual([a])
      expect(value.getActiveView()).toBe(a)
      value.acquireViewOperation(a)()
      value.assertCompatibilityOpenAvailable()
    } finally { finish(); release() }
  })

  it('prepares a managed view only after every captured physical view operation settles', async () => {
    const value = host(), a = open(value, fixture()), target = fixture()
    value.activateView(a)
    const first = value.acquireViewOperation(a), second = value.acquireViewOperation(a)
    const validate = vi.fn()
    const pending = value.prepareBackgroundViewOpenAfterDrain(target, validate)
    expect(value.getOpenRuntimes()).toEqual([a])
    first()
    expect(validate).not.toHaveBeenCalled()
    expect(() => value.activateView(null)).toThrow('PROJECT_RUNTIME_VIEW_OPERATION_BUSY')
    second()
    // The last release prepares the ticket before another physical view operation can enter.
    expect(() => value.acquireViewOperation(a)).toThrow('PROJECT_RUNTIME_BUSY')
    const ticket = await pending
    expect(validate).toHaveBeenCalledOnce()
    expect(value.getActiveView()).toBe(a)
    value.commitViewOpen(ticket, () => undefined)
    value.finishBackgroundViewOpen(ticket)
    expect(value.getActiveView()).toBe(ticket.runtime)
  })

  it('seals close-all synchronously on the last captured view release before new work can enter', async () => {
    const value = host(), a = open(value, fixture()), b = open(value, fixture()), target = fixture()
    value.activateView(b)
    const releaseBackground = value.acquireWork(a)
    const first = value.acquireViewOperation(b), second = value.acquireViewOperation(b)
    const visited: ProjectRuntime[] = []
    disposers.push(value.onCloseRequested(runtime => {
      visited.push(runtime)
      expect(() => value.acquireWork(a)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
      expect(() => value.prepareOpen(target)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
    }))
    let closing!: Promise<void>
    const pending = value.runAfterViewOperationsDrained(b, () => {
      closing = value.requestCloseAll({ shutdown: false })
    })
    try {
      first()
      expect(visited).toEqual([])
      expect(a.database.open).toBe(true)
      expect(b.database.open).toBe(true)
      expect(second).not.toThrow()
      // No await separates the last physical release from these competing admissions.
      expect(() => value.acquireWork(a)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
      expect(() => value.acquireWork(b)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
      expect(() => value.acquireViewOperation(b)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
      expect(() => value.prepareOpen(target)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
      expect(visited).toEqual([a, b])
      expect(a.database.open).toBe(true)
      expect(b.database.open).toBe(false)
      expect(value.requestCloseAll({ shutdown: true })).toBe(closing)
      expect(value.requestCloseAll({ shutdown: false })).toBe(closing)
      await pending
      expect(a.database.open).toBe(true)
      expect(visited).toEqual([a, b])
      releaseBackground()
      await closing
      expect(a.database.open).toBe(false)
      value.finishWindowClose()
      expect(() => value.prepareOpen(target)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
    } finally { first(); second(); releaseBackground(); if (closing) await closing }
  })

  it('times out a managed view drain without releasing physical work or closing its native handle', async () => {
    const value = host(), a = open(value, fixture()), target = fixture()
    value.activateView(a)
    const release = value.acquireViewOperation(a)
    vi.useFakeTimers()
    try {
      const pending = value.prepareBackgroundViewOpenAfterDrain(target, () => undefined)
      const rejected = expect(pending).rejects.toThrow('PROJECT_RUNTIME_VIEW_DRAIN_TIMEOUT')
      await vi.advanceTimersByTimeAsync(5_000)
      await rejected
      expect(value.getOpenRuntimes()).toEqual([a])
      expect(a.database.open).toBe(true)
      expect(() => value.activateView(null)).toThrow('PROJECT_RUNTIME_VIEW_OPERATION_BUSY')
      release()
      value.acquireViewOperation(a)()
      expect(value.getOpenRuntimes()).toEqual([a])
    } finally { release(); vi.useRealTimers() }
  })

  it.each(['source', 'target'] as const)('rechecks %s identity after the physical view drain without opening the target', async changedSide => {
    const value = host(), source = fixture(), a = open(value, source), target = fixture()
    value.activateView(a)
    const release = value.acquireViewOperation(a)
    const pending = value.prepareBackgroundViewOpenAfterDrain(target, () => undefined)
    const manifest = path.join(changedSide === 'source' ? source.rootPath : target.rootPath, '.ai-novel', 'project.json')
    const original = fs.readFileSync(manifest, 'utf8'), changed = JSON.parse(original)
    try {
      changed.projectId = randomUUID()
      fs.writeFileSync(manifest, JSON.stringify(changed))
      release()
      await expect(pending).rejects.toThrow(changedSide === 'source' ? 'PROJECT_MANIFEST_CHANGED' : 'PROJECT_RUNTIME_IDENTITY_MISMATCH')
    } finally { fs.writeFileSync(manifest, original); release() }
    expect(value.getOpenRuntimes()).toEqual([a])
    expect(value.getActiveView()).toBe(a)
    value.acquireViewOperation(a)()
  })

  it('releases only idle managed views after COMMIT and restores ordinary single-view compatibility after A settles', () => {
    const value = host(), a = open(value, fixture())
    value.activateView(a)
    const identity = a.databaseIdentity, epoch = a.executionEpoch
    const release = value.acquireWork(a)
    try {
      const b = backgroundView(value, fixture())
      const c = backgroundView(value, fixture())
      expect(b.database.open).toBe(false)
      expect(value.getOpenRuntimes()).toEqual([a, c])
      expect(a.databaseIdentity).toBe(identity)
      expect(a.executionEpoch).toBe(epoch)
      expect(value.hasBackgroundViewsRetained()).toBe(true)
      expect(() => value.acquireLegacyOperation('unmigrated')).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
      release()
      const d = backgroundView(value, fixture())
      expect(a.database.open || c.database.open).toBe(false)
      expect(value.getOpenRuntimes()).toEqual([d])
      expect(value.hasBackgroundViewsRetained()).toBe(false)
      value.acquireLegacyOperation('ordinary-read')()
      const next = value.prepareCompatibilityOpen(fixture())
      value.commitViewOpen(next, () => undefined)
      expect(d.database.open).toBe(false)
      expect(value.getOpenRuntimes()).toEqual([next.runtime])
    } finally { release() }
  })

  it('keeps claim/unknown owners until a pure retirement guard confirms they are actually idle', () => {
    const value = host(), a = open(value, fixture())
    value.activateView(a)
    let liveClaim = true
    const guard = vi.fn((runtime: ProjectRuntime) => runtime !== a || !liveClaim)
    disposers.push(value.registerRetirementGuard(guard))
    const b = backgroundView(value, fixture())
    const c = backgroundView(value, fixture())
    expect(value.getOpenRuntimes()).toEqual([a, c])
    expect(b.database.open).toBe(false)
    expect(a.database.open).toBe(true)
    liveClaim = false
    const d = backgroundView(value, fixture())
    expect(value.getOpenRuntimes()).toEqual([d])
    expect(a.database.open).toBe(false)
    expect(guard).toHaveBeenCalledWith(a)
  })

  it('reports raw explicit retained resources as requiring the background adapter without enrolling them in cleanup', () => {
    const value = host(), project = fixture()
    const a = value.commitViewOpen(value.prepareRetainedOpen(project), runtime => runtime)
    expect(value.hasBackgroundViewsRetained()).toBe(true)
    const b = backgroundView(value, fixture())
    const c = backgroundView(value, fixture())
    expect(a.database.open).toBe(true)
    expect(b.database.open).toBe(false)
    expect(value.getOpenRuntimes()).toEqual([a, c])
    expect(value.hasBackgroundViewsRetained()).toBe(true)
    expect(() => value.prepareCompatibilityOpen(fixture())).toThrow('PROJECT_RUNTIME_COMPATIBILITY_UNAVAILABLE')
  })

  it('does not enroll or release A when the background target transaction fails', () => {
    const value = host(), a = open(value, fixture())
    value.activateView(a)
    const epoch = a.executionEpoch, identity = a.databaseIdentity
    const ticket = value.prepareBackgroundViewOpen(fixture())
    expect(() => value.commitViewOpen(ticket, () => { throw new Error('fictional target rollback') })).toThrow('fictional target rollback')
    value.abortOpen(ticket)
    expect(value.getOpenRuntimes()).toEqual([a])
    expect(value.getActiveView()).toBe(a)
    expect(a.databaseIdentity).toBe(identity)
    expect(a.executionEpoch).toBe(epoch)
    expect(value.hasBackgroundViewsRetained()).toBe(false)
    value.assertCompatibilityOpenAvailable()
  })

  it('preserves the committed managed winner and quarantines a real idle-close failure', () => {
    const value = host(), a = open(value, fixture())
    value.activateView(a)
    disposers.push(value.onBeforeRelease(runtime => { if (runtime === a) throw new Error('fictional idle close failure') }))
    const ticket = value.prepareBackgroundViewOpen(fixture())
    value.commitViewOpen(ticket, () => undefined)
    expect(() => value.finishBackgroundViewOpen(ticket)).toThrow(ProjectRuntimePreviousCloseError)
    expect(value.getActiveView()).toBe(ticket.runtime)
    expect(ticket.runtime.database.open).toBe(true)
    expect(a.phase).toBe('closing')
    expect(value.hasBackgroundViewsRetained()).toBe(true)
    expect(() => value.prepareCompatibilityOpen(fixture())).toThrow('PROJECT_RUNTIME_COMPATIBILITY_UNAVAILABLE')
  })

  it('propagates a retirement diagnostic instead of interpreting a damaged owner as idle', () => {
    const value = host(), a = open(value, fixture())
    value.activateView(a)
    disposers.push(value.registerRetirementGuard(runtime => {
      if (runtime === a) throw new Error('fictional owner cleanup debt')
      return true
    }))
    const ticket = value.prepareBackgroundViewOpen(fixture())
    value.commitViewOpen(ticket, () => undefined)
    expect(() => value.finishBackgroundViewOpen(ticket)).toThrow(ProjectRuntimePreviousCloseError)
    expect(a.phase).toBe('open')
    expect(a.database.open).toBe(true)
    expect(value.getActiveView()).toBe(ticket.runtime)
    expect(value.hasBackgroundViewsRetained()).toBe(true)
  })

  it('reclaims settled inactive managed A after current B closes and a new view successfully commits', async () => {
    const value = host(), a = open(value, fixture())
    value.activateView(a)
    const release = value.acquireWork(a)
    try {
      const b = backgroundView(value, fixture())
      await value.requestClose(b)
      expect(value.getActiveView()).toBeNull()
      expect(value.hasBackgroundViewsRetained()).toBe(true)
      release()
      const c = backgroundView(value, fixture())
      expect(a.database.open).toBe(false)
      expect(value.getOpenRuntimes()).toEqual([c])
      expect(value.hasBackgroundViewsRetained()).toBe(false)
      value.acquireLegacyOperation('ordinary-read')()
    } finally { release() }
  })

  it('opens the first compatibility view and closes only idle A after B and its fresh session publish', () => {
    hosts.add(projectRuntimeHost)
    const a = fixture(), b = fixture(), access = new ProjectAccessService({ homePath: path.dirname(a.rootPath) })
    const openedA = access.commitViewSession(projectRuntimeHost.prepareCompatibilityOpen(a), () => 'A')
    const first = projectRuntimeHost.getActiveView()!, oldEpoch = first.executionEpoch
    const ticket = projectRuntimeHost.prepareCompatibilityOpen(b)
    const beforeClose = vi.fn((context: { database: ProjectRuntime['database'] }) => {
      if (context.database !== first.database) return
      expect(projectRuntimeHost.getActiveView()).toBe(ticket.runtime)
      const fresh = access.captureCurrentSession()!
      expect(fresh.projectId).toBe(b.projectId)
      expect(fresh.leaseId).not.toBe(openedA.session.leaseId)
      expect(ticket.runtime.database.prepare('SELECT body FROM contents').pluck().all()).toEqual(['fictional B'])
      expect(first.phase).toBe('closing')
      expect(() => projectRuntimeHost.assertOpen(ticket.runtime)).toThrow('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
      expect(() => access.beginViewSession(ticket.runtime)).toThrow('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
      expect(() => projectRuntimeHost.prepareOpen(a)).toThrow('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
      expect(() => projectRuntimeHost.releaseIdle(ticket.runtime)).toThrow('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
      expect(() => projectRuntimeHost.activateView(first)).toThrow('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
      expect(() => projectRuntimeHost.acquireLegacyOperation('fictional:reentrant')).toThrow('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
    })
    disposers.push(onProjectDatabaseBeforeClose(beforeClose))
    const openedB = access.commitViewSession(ticket, runtime => {
      expect(first.database.open).toBe(true)
      expect(first.executionEpoch).toBe(oldEpoch)
      expect(access.captureCurrentSession()).toEqual(openedA.session)
      runtime.database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional B')
      return 'B'
    })
    expect(beforeClose).toHaveBeenCalledOnce()
    expect(openedB.value).toBe('B')
    expect(access.captureCurrentSession()).toEqual(openedB.session)
    expect(() => access.assertCurrentSession(openedA.session)).toThrow('PROJECT_SESSION_STALE')
    expect(first.phase).toBe('closed')
    expect(first.database.open).toBe(false)
    expect(projectRuntimeHost.getOpenRuntimes()).toEqual([ticket.runtime])
    expect(access.assertViewContext({ projectId: b.projectId, leaseId: openedB.session.leaseId, projectPath: b.rootPath })).toBe(ticket.runtime)
  })

  it('holds compatibility preparation until its exact ticket aborts and does not close reused A', () => {
    const value = host(), a = fixture(), b = fixture(), first = open(value, a)
    value.activateView(first)
    const ticket = value.prepareCompatibilityOpen(a)
    expect(ticket.runtime).toBe(first)
    const attempts = [
      () => value.assertLifecycleAvailable(), () => value.assertCompatibilityOpenAvailable(),
      () => value.prepareOpen(b), () => value.prepareCompatibilityOpen(b), () => value.prepareRetainedOpen(b),
      () => value.activateView(first), () => value.releaseIdle(first), () => value.assertOpen(first),
      () => value.acquireLegacyOperation('fictional:legacy'), () => value.acquireRestoreOperation(),
      () => value.commitOpen(ticket),
    ]
    for (const attempt of attempts) expect(attempt).toThrow('PROJECT_RUNTIME_COMPATIBILITY_OPEN_BUSY')
    expect(() => value.abortOpen({ ...ticket })).toThrow('PROJECT_RUNTIME_COMPATIBILITY_OPEN_BUSY')
    value.abortOpen(ticket)
    expect(first.database.open).toBe(true)
    expect(value.getActiveView()).toBe(first)
    value.assertCompatibilityOpenAvailable()
    value.acquireLegacyOperation('fictional:legacy')()
  })

  it('preserves A on compatibility preparation failure and a real B COMMIT failure', () => {
    hosts.add(projectRuntimeHost)
    const a = fixture(), b = fixture(), corrupt = fixture(), first = open(projectRuntimeHost, a)
    const access = new ProjectAccessService({ homePath: path.dirname(a.rootPath) })
    const original = access.beginViewSession(first), epoch = first.executionEpoch, nativeIdentity = first.databaseIdentity
    fs.writeFileSync(path.join(corrupt.rootPath, '.ai-novel', 'project.db'), 'fictional invalid sqlite')
    expect(() => projectRuntimeHost.prepareCompatibilityOpen(corrupt)).toThrow()
    projectRuntimeHost.assertCompatibilityOpenAvailable()
    expect(access.captureCurrentSession()).toEqual(original)
    const ticket = projectRuntimeHost.prepareCompatibilityOpen(b), db = ticket.runtime.database
    db.exec('CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(parent_id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED)')
    expect(() => access.commitViewSession(ticket, runtime => {
      runtime.database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional uncommitted B')
      runtime.database.exec('INSERT INTO fixture_child(parent_id) VALUES(99)')
    })).toThrow('FOREIGN KEY constraint failed')
    expect(db.prepare('SELECT body FROM contents').all()).toEqual([])
    expect(ticket.runtime.phase).toBe('opening')
    expect(projectRuntimeHost.getActiveView()).toBe(first)
    expect(access.captureCurrentSession()).toEqual(original)
    expect(first.databaseIdentity).toBe(nativeIdentity)
    expect(first.executionEpoch).toBe(epoch)
    expect(first.database.prepare('SELECT 1').pluck().get()).toBe(1)
    projectRuntimeHost.abortOpen(ticket)
    expect(db.open).toBe(false)
    expect(access.assertViewContext({ projectId: a.projectId, leaseId: original.leaseId, projectPath: a.rootPath })).toBe(first)
  })

  it('treats a canonical alias as the same compatibility view, rotating only the UI lease', () => {
    hosts.add(projectRuntimeHost)
    const a = fixture(), first = open(projectRuntimeHost, a)
    const access = new ProjectAccessService({ homePath: path.dirname(a.rootPath) }), original = access.beginViewSession(first)
    const aliasParent = fs.mkdtempSync(path.join(path.dirname(a.rootPath), 'compat-alias-'))
    roots.push(aliasParent)
    const alias = path.join(aliasParent, 'link')
    fs.symlinkSync(a.rootPath, alias, process.platform === 'win32' ? 'junction' : 'dir')
    first.database.exec(`INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count,status,execution_owner,execution_epoch,lease_expires_at)
      VALUES('fiction','fiction','fiction','source','manifest','zh-CN',1,1,'running','live-owner',7,123)`)
    const beforeClose = vi.fn()
    disposers.push(onProjectDatabaseBeforeClose(beforeClose))
    const ticket = projectRuntimeHost.prepareCompatibilityOpen({ ...a, rootPath: alias })
    const reopened = access.commitViewSession(ticket, () => 'same native')
    expect(ticket.reused).toBe(true)
    expect(ticket.runtime).toBe(first)
    expect(reopened.session.leaseId).not.toBe(original.leaseId)
    expect(reopened.session.rootPath).toBe(first.canonicalRoot)
    expect(beforeClose).not.toHaveBeenCalled()
    expect(first.database.prepare('SELECT execution_owner,execution_epoch FROM import_runs').get()).toEqual({ execution_owner: 'live-owner', execution_epoch: 7 })
    expect(projectRuntimeHost.getOpenRuntimes()).toEqual([first])
  })

  it.each([0, 1, 2])('consults registered busy predicate %i before compatibility preparation', busyIndex => {
    const value = host(), a = fixture(), b = fixture(), first = open(value, a)
    value.activateView(first)
    let busy = true
    const predicates = [0, 1, 2].map(index => vi.fn((runtime: ProjectRuntime) => runtime === first && busy && index === busyIndex))
    for (const predicate of predicates) disposers.push(value.registerBusyPredicate(predicate))
    const beforeClose = vi.fn()
    disposers.push(value.onBeforeRelease(beforeClose))
    expect(() => value.assertCompatibilityOpenAvailable()).toThrow('PROJECT_RUNTIME_BUSY')
    expect(() => value.prepareCompatibilityOpen(b)).toThrow('PROJECT_RUNTIME_BUSY')
    expect(predicates[busyIndex]).toHaveBeenCalledWith(first)
    expect(beforeClose).not.toHaveBeenCalled()
    expect(value.getOpenRuntimes()).toEqual([first])
    expect(value.getActiveView()).toBe(first)
    busy = false
    const ticket = value.prepareCompatibilityOpen(b)
    value.abortOpen(ticket)
    expect(first.database.open).toBe(true)
  })

  it('rejects retained, inactive, multiple, pending, legacy-held and restore-held resources without widening legacy admission', () => {
    const value = host(), a = fixture(), b = fixture(), first = open(value, a)
    expect(() => value.prepareCompatibilityOpen(b)).toThrow('PROJECT_RUNTIME_COMPATIBILITY_UNAVAILABLE')
    value.activateView(first)
    const pending = value.prepareOpen(a)
    expect(() => value.prepareCompatibilityOpen(b)).toThrow('PROJECT_RUNTIME_BUSY')
    value.abortOpen(pending)
    const legacy = value.acquireLegacyOperation('fictional:operation')
    expect(() => value.prepareCompatibilityOpen(b)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
    legacy()
    const restore = value.acquireRestoreOperation()
    expect(() => value.prepareCompatibilityOpen(b)).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    restore()
    const second = value.commitViewOpen(value.prepareRetainedOpen(b), () => 'explicit retain')
    expect(second).toBe('explicit retain')
    expect(() => value.prepareCompatibilityOpen(a)).toThrow('PROJECT_RUNTIME_COMPATIBILITY_UNAVAILABLE')
    expect(() => value.acquireLegacyOperation('fictional:operation')).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
    value.releaseIdle(first)
    expect(() => value.prepareCompatibilityOpen(a)).toThrow('PROJECT_RUNTIME_RETAINED')
  })

  it('marks explicit retention only after successful commit, including reuse, and preserves it until real close', () => {
    const value = host(), a = fixture(), first = open(value, a)
    value.activateView(first)
    const aborted = value.prepareRetainedOpen(a)
    value.abortOpen(aborted)
    value.assertCompatibilityOpenAvailable()
    const failed = value.prepareRetainedOpen(a)
    expect(() => value.commitViewOpen(failed, () => { throw new Error('fictional rollback') })).toThrow('fictional rollback')
    value.abortOpen(failed)
    value.assertCompatibilityOpenAvailable()
    const commitFailure = value.prepareRetainedOpen(a)
    // This case truly reopens A, so fault injection must not fork its durable schema.
    first.database.exec('CREATE TEMP TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TEMP TABLE fixture_child(parent_id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED)')
    expect(() => value.commitViewOpen(commitFailure, runtime => {
      runtime.database.exec('INSERT INTO fixture_child(parent_id) VALUES(99)')
    })).toThrow('FOREIGN KEY constraint failed')
    expect(first.database.prepare("SELECT name FROM main.sqlite_master WHERE name IN ('fixture_parent','fixture_child')").all()).toEqual([])
    value.abortOpen(commitFailure)
    value.assertCompatibilityOpenAvailable()
    value.commitViewOpen(value.prepareRetainedOpen(a), () => 'retained')
    expect(() => value.prepareCompatibilityOpen(a)).toThrow('PROJECT_RUNTIME_RETAINED')
    value.abortOpen(value.prepareRetainedOpen(a))
    expect(() => value.assertCompatibilityOpenAvailable()).toThrow('PROJECT_RUNTIME_RETAINED')
    value.releaseIdle(first)
    const ticket = value.prepareCompatibilityOpen(a)
    value.commitViewOpen(ticket, () => 'new native')
    expect(ticket.runtime.databaseIdentity).not.toBe(first.databaseIdentity)
    value.assertCompatibilityOpenAvailable()
  })

  it.each(['owner', 'kb', 'native'] as const)('keeps committed B and its published lease when captured A %s close fails', failure => {
    const value = host(), a = fixture(), b = fixture(), first = open(value, a)
    value.activateView(first)
    const ticket = value.prepareCompatibilityOpen(b)
    let publishedLease = 'fictional-lease-a'
    const cause = new Error('fictional previous close failure')
    if (failure === 'owner') disposers.push(onProjectDatabaseBeforeClose(context => {
      if (context.database === first.database) {
        expect(publishedLease).toBe('fictional-lease-b')
        throw cause
      }
    }))
    if (failure === 'kb') disposers.push(value.onBeforeRelease(runtime => {
      expect(runtime).toBe(first)
      expect(publishedLease).toBe('fictional-lease-b')
      throw cause
    }))
    if (failure === 'native') vi.spyOn(first.database, 'close').mockImplementation(() => {
      expect(publishedLease).toBe('fictional-lease-b')
      throw cause
    })
    let error: unknown
    try {
      value.commitViewOpen(ticket, runtime => {
        runtime.database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional committed B')
      }, () => { publishedLease = 'fictional-lease-b' })
    } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(ProjectRuntimePreviousCloseError)
    expect(error).toMatchObject({ code: 'PROJECT_RUNTIME_PREVIOUS_CLOSE_FAILED', previousRuntime: first, activeRuntime: ticket.runtime, cause })
    expect(first.phase).toBe('closing')
    expect(first.database.open).toBe(true)
    expect(ticket.runtime.phase).toBe('open')
    expect(value.getActiveView()).toBe(ticket.runtime)
    expect(publishedLease).toBe('fictional-lease-b')
    expect(ticket.runtime.database.prepare('SELECT body FROM contents').pluck().all()).toEqual(['fictional committed B'])
    expect(() => value.abortOpen(ticket)).toThrow('PROJECT_RUNTIME_TICKET_INVALID')
    expect(() => value.prepareOpen(a)).toThrow('PROJECT_RUNTIME_NOT_OPEN')
    expect(() => value.prepareCompatibilityOpen(a)).toThrow('PROJECT_RUNTIME_COMPATIBILITY_UNAVAILABLE')
    expect(() => value.acquireLegacyOperation('fictional:operation')).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
    value.assertOpen(ticket.runtime)
  })

  it('rechecks captured idle A before the compatibility transaction instead of publishing over a busy resource', () => {
    const value = host(), a = fixture(), first = open(value, a), b = fixture()
    value.activateView(first)
    let busy = false
    disposers.push(value.registerBusyPredicate(runtime => runtime === first && busy))
    const ticket = value.prepareCompatibilityOpen(b), operation = vi.fn(), publish = vi.fn()
    busy = true
    expect(() => value.commitViewOpen(ticket, operation, publish)).toThrow('PROJECT_RUNTIME_BUSY')
    expect(operation).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(value.getActiveView()).toBe(first)
    expect(ticket.runtime.phase).toBe('opening')
    busy = false
    value.abortOpen(ticket)
    expect(first.database.open).toBe(true)
  })

  it('prepares B without changing or closing A and routes native writes independently', () => {
    const value = host(), a = fixture(), b = fixture()
    const first = open(value, a)
    value.activateView(first)
    const pending = value.prepareOpen(b)
    expect(pending.runtime.phase).toBe('opening')
    expect(value.getActiveView()).toBe(first)
    expect(first.database.open).toBe(true)
    expect(pending.runtime.database).not.toBe(first.database)
    expect(() => value.assertOpen(pending.runtime)).toThrow('PROJECT_RUNTIME_NOT_OPEN')
    const second = value.commitOpen(pending)
    value.activateView(second)
    first.database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional A')
    second.database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional B')
    expect(first.database.prepare('SELECT body FROM contents').pluck().all()).toEqual(['fictional A'])
    expect(second.database.prepare('SELECT body FROM contents').pluck().all()).toEqual(['fictional B'])
    value.releaseIdle(second)
    expect(first.database.open).toBe(true)
    expect(() => getProjectDataRoot(second.canonicalRoot)).toThrow('PROJECT_DATA_NOT_READY')
    expect(getProjectDataRoot(first.canonicalRoot)).toBe(first.projectStorageRoot)
  })

  it('keeps A and its view when B verification or identity fails', () => {
    const value = host(), a = fixture(), b = fixture(), first = open(value, a)
    value.activateView(first)
    expect(() => value.prepareOpen({ ...b, projectId: randomUUID() })).toThrow('PROJECT_RUNTIME_IDENTITY_MISMATCH')
    fs.writeFileSync(path.join(b.rootPath, '.ai-novel', 'project.db'), 'not sqlite')
    expect(() => value.prepareOpen(b)).toThrow()
    expect(value.getOpenRuntimes()).toEqual([first])
    expect(value.getActiveView()).toBe(first)
    expect(first.database.prepare('SELECT 1').pluck().get()).toBe(1)
    value.assertOpen(first)
  })

  it('does not fence prepared/aborted B when C wins, and fences only its first commit', () => {
    const value = host(), a = open(value, fixture()), b = fixture(), c = fixture()
    value.activateView(a)
    const file = path.join(b.rootPath, '.ai-novel', 'project.db'), seed = new Database(file)
    seed.exec(`INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count,status,execution_owner,execution_epoch,lease_expires_at)
      VALUES('fiction','fiction','fiction','source','manifest','zh-CN',1,1,'running','previous-owner',5,12345)`)
    seed.close()
    const read = () => {
      const db = new Database(file, { readonly: true, fileMustExist: true })
      try { return db.prepare('SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs').get() }
      finally { db.close() }
    }
    const original = { execution_owner: 'previous-owner', execution_epoch: 5, lease_expires_at: 12345 }
    expect(read()).toEqual(original)
    const pending = value.prepareOpen(b)
    expect(read()).toEqual(original)
    value.activateView(open(value, c))
    expect(read()).toEqual(original)
    value.abortOpen(pending)
    expect(read()).toEqual(original)
    const committed = open(value, b)
    expect(read()).toEqual({ execution_owner: '', execution_epoch: 6, lease_expires_at: 0 })
    committed.database.exec("UPDATE import_runs SET execution_owner='current-owner',lease_expires_at=999")
    expect(open(value, b)).toBe(committed)
    expect(read()).toEqual({ execution_owner: 'current-owner', execution_epoch: 6, lease_expires_at: 999 })
    expect(a.database.open).toBe(true)
  })

  it('deduplicates canonical aliases and concurrent prepare without refencing a live DB', () => {
    const value = host(), a = fixture(), firstTicket = value.prepareOpen(a)
    const aliasParent = fs.mkdtempSync(path.join(path.dirname(a.rootPath), 'alias-'))
    roots.push(aliasParent)
    const alias = path.join(aliasParent, 'link')
    fs.symlinkSync(a.rootPath, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const secondTicket = value.prepareOpen({ ...a, rootPath: alias })
    expect(secondTicket.reused).toBe(true)
    expect(secondTicket.runtime).toBe(firstTicket.runtime)
    value.abortOpen(firstTicket)
    const runtime = value.commitOpen(secondTicket)
    runtime.database.exec(`INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count,status,execution_owner,execution_epoch,lease_expires_at)
      VALUES('fiction','fiction','fiction','source','manifest','zh-CN',1,1,'running','live-owner',7,123)`)
    const repeated = value.prepareOpen(a)
    value.abortOpen(repeated)
    expect(runtime.database.prepare('SELECT execution_epoch FROM import_runs').pluck().get()).toBe(7)
    expect(runtime.database.prepare('SELECT execution_owner FROM import_runs').pluck().get()).toBe('live-owner')
    expect(value.getByRoot(alias)).toBe(runtime)
    expect(value.getOpenRuntimes()).toEqual([runtime])
  })

  it('aborts only an uncommitted preparation and rejects consumed or forged tickets', () => {
    const value = host(), a = fixture(), b = fixture(), first = open(value, a)
    const reused = value.prepareOpen(a)
    value.abortOpen(reused)
    expect(first.database.open).toBe(true)
    expect(() => value.commitOpen(reused)).toThrow('PROJECT_RUNTIME_TICKET_INVALID')
    const pending = value.prepareOpen(b)
    expect(() => value.commitOpen({ ...pending })).toThrow('PROJECT_RUNTIME_TICKET_INVALID')
    value.abortOpen(pending)
    expect(pending.runtime.phase).toBe('closed')
    expect(pending.runtime.database.open).toBe(false)
    expect(value.getOpenRuntimes()).toEqual([first])
  })

  it('rotates native identity and epoch only after a real close/reopen', () => {
    const value = host(), a = fixture(), first = open(value, a)
    const repeated = open(value, a)
    expect(repeated).toBe(first)
    value.releaseIdle(first)
    const reopened = open(value, a)
    expect(reopened.database).not.toBe(first.database)
    expect(reopened.databaseIdentity).not.toBe(first.databaseIdentity)
    expect(reopened.executionEpoch).not.toBe(first.executionEpoch)
    expect(() => value.assertOpen(first)).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
    expect(() => value.assertOpen({ ...reopened, executionEpoch: first.executionEpoch })).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
    expect(() => value.assertOpen({ ...reopened, database: first.database })).toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
    expect(Object.isFrozen(reopened)).toBe(true)
    expect(Object.isFrozen(reopened.databaseIdentity)).toBe(true)
  })

  it('refuses a busy owner or pending preparation before any close hook runs', () => {
    const value = host(), a = fixture(), runtime = open(value, a)
    let busy = true, calls = 0
    disposers.push(value.registerBusyPredicate(candidate => candidate === runtime && busy))
    disposers.push(value.onBeforeRelease(() => { calls++ }))
    expect(() => value.releaseIdle(runtime)).toThrow('PROJECT_RUNTIME_BUSY')
    expect(runtime.phase).toBe('open')
    expect(calls).toBe(0)
    busy = false
    const pending = value.prepareOpen(a)
    expect(() => value.releaseIdle(runtime)).toThrow('PROJECT_RUNTIME_BUSY')
    value.abortOpen(pending)
    value.releaseIdle(runtime)
    expect(calls).toBe(1)
    expect(runtime.database.open).toBe(false)
  })

  it('flushes the exact target before KB release and native close, without disturbing A', () => {
    const value = host(), a = open(value, fixture()), b = open(value, fixture()), events: string[] = []
    value.activateView(a)
    disposers.push(onProjectDatabaseBeforeClose(context => {
      if (context.database !== b.database) return
      events.push('owner')
      expect(context.projectPath).toBe(b.canonicalRoot)
      context.database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional final flush')
    }))
    disposers.push(value.onBeforeRelease(runtime => {
      expect(runtime).toBe(b)
      expect(runtime.phase).toBe('closing')
      expect(runtime.database.open).toBe(true)
      expect(runtime.database.prepare('SELECT body FROM contents').pluck().get()).toBe('fictional final flush')
      events.push('kb')
    }))
    value.releaseIdle(b)
    expect(events).toEqual(['owner', 'kb'])
    expect(b.database.open).toBe(false)
    expect(value.getActiveView()).toBe(a)
    value.assertOpen(a)
  })

  it.each(['owner', 'kb', 'native'] as const)('quarantines a %s close failure rather than readmitting the target', failure => {
    const value = host(), project = fixture(), runtime = open(value, project)
    value.activateView(runtime)
    if (failure === 'owner') disposers.push(onProjectDatabaseBeforeClose(context => {
      if (context.database === runtime.database) throw new Error('fictional close failure')
    }))
    if (failure === 'kb') disposers.push(value.onBeforeRelease(() => { throw new Error('fictional close failure') }))
    if (failure === 'native') vi.spyOn(runtime.database, 'close').mockImplementation(() => { throw new Error('fictional close failure') })
    expect(() => value.releaseIdle(runtime)).toThrow('fictional close failure')
    expect(runtime.phase).toBe('closing')
    expect(getProjectDataRoot(runtime.canonicalRoot)).toBe(runtime.projectStorageRoot)
    expect(() => value.assertOpen(runtime)).toThrow('PROJECT_RUNTIME_NOT_OPEN')
    expect(() => value.prepareOpen(project)).toThrow('PROJECT_RUNTIME_NOT_OPEN')
    expect(() => value.releaseIdle(runtime)).toThrow('PROJECT_RUNTIME_NOT_OPEN')
  })

  it('holds the only-runtime legacy interlock across await and releases idempotently', async () => {
    const value = host(), a = fixture(), b = fixture(), runtime = open(value, a)
    value.activateView(runtime)
    const release = value.acquireLegacyOperation('fictional:legacy')
    await Promise.resolve()
    expect(() => value.assertLifecycleAvailable()).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
    expect(() => value.prepareOpen(b)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
    expect(() => value.prepareOpen(a)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
    expect(() => value.activateView(null)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
    expect(() => value.releaseIdle(runtime)).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
    expect(value.getActiveView()).toBe(runtime)
    release(); release()
    expect(() => value.assertLifecycleAvailable()).not.toThrow()
    const second = open(value, b)
    expect(() => value.acquireLegacyOperation('fictional:legacy')).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
    value.releaseIdle(second)
    value.acquireLegacyOperation('fictional:legacy')()
  })

  it('keeps legacy DB getters as view pointers and rotates UI leases without reopening', () => {
    hosts.add(projectRuntimeHost)
    const a = fixture(), b = fixture()
    initProjectDatabase(a.rootPath)
    const first = projectRuntimeHost.getActiveView()!
    const access = new ProjectAccessService({ homePath: path.dirname(a.rootPath) })
    const original = access.beginViewSession(first)
    const repeated = access.beginViewSession(first)
    const context = { projectId: a.projectId, leaseId: repeated.leaseId, projectPath: a.rootPath }
    expect(repeated.leaseId).not.toBe(original.leaseId)
    expect(() => access.assertCurrentSession(original)).toThrow('PROJECT_SESSION_STALE')
    expect(access.assertViewContext(context)).toBe(first)
    initProjectDatabase(b.rootPath)
    const second = projectRuntimeHost.getActiveView()!
    access.beginViewSession(second)
    expect(getProjectDb()).toBe(second.database)
    expect(getCurrentProjectPath()).toBe(second.canonicalRoot)
    expect(first.database.open).toBe(true)
    expect(() => access.assertViewContext(context)).toThrow('PROJECT_SESSION_STALE')
    const resumed = access.beginViewSession(first)
    expect(first.executionEpoch).toBe(projectRuntimeHost.getActiveView()!.executionEpoch)
    expect(first.databaseIdentity).toBe(projectRuntimeHost.getActiveView()!.databaseIdentity)
    expect(resumed.leaseId).not.toBe(repeated.leaseId)
    expect(getProjectDb()).toBe(first.database)
    closeProjectDatabase()
    expect(second.database.open).toBe(true)
    expect(getProjectDb()).toBeNull()
  })

  it.each(['operation', 'commit'] as const)('rolls back view initialization/fence on %s failure without publishing B or losing its abort ticket', failure => {
    hosts.add(projectRuntimeHost)
    const a = fixture(), b = fixture(), first = open(projectRuntimeHost, a)
    const access = new ProjectAccessService({ homePath: path.dirname(a.rootPath) })
    const original = access.beginViewSession(first)
    const ticket = projectRuntimeHost.prepareOpen(b), database = ticket.runtime.database
    database.exec(`INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count,status,execution_owner,execution_epoch,lease_expires_at)
      VALUES('fiction','fiction','fiction','source','manifest','zh-CN',1,1,'running','previous-owner',5,12345);
      CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE fixture_child(parent_id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED)`)
    const operation = vi.fn((runtime: ProjectRuntime) => {
      expect(runtime).toBe(ticket.runtime)
      expect(projectRuntimeHost.getActiveView()).toBe(first)
      expect(access.captureCurrentSession()).toEqual(original)
      database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional uncommitted B')
      if (failure === 'operation') throw new Error('fictional initialization failure')
      database.exec('INSERT INTO fixture_child(parent_id) VALUES(99)')
      return 'uncommitted value'
    })
    expect(() => access.commitViewSession(ticket, operation)).toThrow(
      failure === 'operation' ? 'fictional initialization failure' : 'FOREIGN KEY constraint failed',
    )
    expect(operation).toHaveBeenCalledOnce()
    expect(database.prepare('SELECT body FROM contents').all()).toEqual([])
    expect(database.prepare('SELECT * FROM fixture_child').all()).toEqual([])
    expect(database.prepare('SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs').get())
      .toEqual({ execution_owner: 'previous-owner', execution_epoch: 5, lease_expires_at: 12345 })
    expect(ticket.runtime.phase).toBe('opening')
    expect(projectRuntimeHost.getActiveView()).toBe(first)
    expect(access.captureCurrentSession()).toEqual(original)
    expect(access.assertViewContext({ projectId: original.projectId, leaseId: original.leaseId, projectPath: original.rootPath })).toBe(first)
    projectRuntimeHost.abortOpen(ticket)
    expect(database.open).toBe(false)
    expect(first.database.prepare('SELECT 1').pluck().get()).toBe(1)
  })

  it('publishes the new view and lease only after initialization and its first fence commit, without refencing reuse', () => {
    hosts.add(projectRuntimeHost)
    const a = fixture(), b = fixture(), first = open(projectRuntimeHost, a)
    const access = new ProjectAccessService({ homePath: path.dirname(a.rootPath) })
    const original = access.beginViewSession(first), ticket = projectRuntimeHost.prepareOpen(b)
    const database = ticket.runtime.database
    database.exec(`INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count,status,execution_owner,execution_epoch,lease_expires_at)
      VALUES('fiction','fiction','fiction','source','manifest','zh-CN',1,1,'running','previous-owner',5,12345)`)
    const result = access.commitViewSession(ticket, runtime => {
      expect(runtime.phase).toBe('opening')
      expect(projectRuntimeHost.getActiveView()).toBe(first)
      expect(access.captureCurrentSession()).toEqual(original)
      runtime.database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional committed B')
      return { initialized: true }
    })
    expect(result.value).toEqual({ initialized: true })
    expect(result.session.projectId).toBe(b.projectId)
    expect(result.session.leaseId).not.toBe(original.leaseId)
    expect(projectRuntimeHost.getActiveView()).toBe(ticket.runtime)
    expect(access.captureCurrentSession()).toEqual(result.session)
    expect(ticket.runtime.phase).toBe('open')
    expect(database.prepare('SELECT body FROM contents').pluck().all()).toEqual(['fictional committed B'])
    expect(database.prepare('SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs').get())
      .toEqual({ execution_owner: '', execution_epoch: 6, lease_expires_at: 0 })
    expect(() => projectRuntimeHost.abortOpen(ticket)).toThrow('PROJECT_RUNTIME_TICKET_INVALID')
    database.exec("UPDATE import_runs SET execution_owner='current-owner',lease_expires_at=999")
    const reused = access.commitViewSession(projectRuntimeHost.prepareOpen(b), () => 'reused')
    expect(reused.session.leaseId).not.toBe(result.session.leaseId)
    expect(database.prepare('SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs').get())
      .toEqual({ execution_owner: 'current-owner', execution_epoch: 6, lease_expires_at: 999 })
    expect(first.database.open).toBe(true)
  })

  it('does not initialize B or publish its view when allocating a fresh UI lease fails', () => {
    hosts.add(projectRuntimeHost)
    const a = fixture(), b = fixture(), first = open(projectRuntimeHost, a)
    const newLeaseId = vi.fn().mockReturnValueOnce('fictional-lease-a').mockImplementationOnce(() => {
      throw new Error('fictional lease allocation failure')
    })
    const access = new ProjectAccessService({ homePath: path.dirname(a.rootPath), newLeaseId })
    const original = access.beginViewSession(first), ticket = projectRuntimeHost.prepareOpen(b), operation = vi.fn()
    expect(() => access.commitViewSession(ticket, operation)).toThrow('fictional lease allocation failure')
    expect(operation).not.toHaveBeenCalled()
    expect(projectRuntimeHost.getActiveView()).toBe(first)
    expect(access.captureCurrentSession()).toEqual(original)
    projectRuntimeHost.abortOpen(ticket)
    expect(first.database.open).toBe(true)
  })

  it('refuses lifecycle reentry throughout a view transaction and publishes only after it finishes', () => {
    const value = host(), a = fixture(), b = fixture(), first = open(value, a), ticket = value.prepareOpen(b)
    value.activateView(first)
    const runtime = ticket.runtime
    const result = value.commitViewOpen(ticket, captured => {
      expect(captured).toBe(runtime)
      const attempts = [
        () => value.assertLifecycleAvailable(),
        () => value.prepareOpen(a),
        () => value.prepareOpen(b),
        () => value.commitOpen(ticket),
        () => value.commitViewOpen(ticket, () => undefined),
        () => value.abortOpen(ticket),
        () => value.activateView(first),
        () => value.releaseIdle(first),
        () => value.acquireLegacyOperation('fictional:operation'),
        () => value.acquireRestoreOperation(),
      ]
      for (const attempt of attempts) expect(attempt).toThrow('PROJECT_RUNTIME_VIEW_COMMIT_BUSY')
      expect(value.getActiveView()).toBe(first)
      runtime.database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional transaction')
      return 'committed'
    })
    expect(result).toBe('committed')
    expect(value.getActiveView()).toBe(runtime)
    expect(runtime.database.prepare('SELECT body FROM contents').pluck().all()).toEqual(['fictional transaction'])
    value.releaseIdle(runtime)
    expect(first.database.open).toBe(true)
  })

  it('rejects async/thenable view operations and existing transactions without consuming the ticket', () => {
    const value = host(), project = fixture(), ticket = value.prepareOpen(project), database = ticket.runtime.database
    let calls = 0
    expect(() => value.commitViewOpen(ticket, async () => { calls++; return 'not invoked' }))
      .toThrow('PROJECT_RUNTIME_VIEW_OPERATION_MUST_BE_SYNCHRONOUS')
    expect(calls).toBe(0)
    expect(() => value.commitViewOpen(ticket, () => {
      database.prepare('INSERT INTO contents(body) VALUES (?)').run('fictional rolled back')
      return Promise.resolve('not committed')
    })).toThrow('PROJECT_RUNTIME_VIEW_OPERATION_MUST_BE_SYNCHRONOUS')
    expect(database.prepare('SELECT body FROM contents').all()).toEqual([])
    const operation = vi.fn()
    database.transaction(() => {
      expect(() => value.commitViewOpen(ticket, operation)).toThrow('PROJECT_RUNTIME_TRANSACTION_ACTIVE')
    })()
    expect(operation).not.toHaveBeenCalled()
    expect(ticket.runtime.phase).toBe('opening')
    expect(value.getActiveView()).toBeNull()
    value.abortOpen(ticket)
    expect(database.open).toBe(false)
  })

  it('allows restore with no active view and interlocks all lifecycle operations until released', () => {
    const value = host(), a = fixture()
    const release = value.acquireRestoreOperation()
    expect(() => value.assertLifecycleAvailable()).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    expect(() => value.prepareOpen(a)).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    expect(() => value.activateView(null)).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    expect(() => value.acquireLegacyOperation('fictional:legacy')).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    expect(() => value.acquireRestoreOperation()).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    release(); release()
    const first = open(value, a), second = open(value, fixture())
    value.activateView(first)
    const releaseWithOpen = value.acquireRestoreOperation()
    expect(() => value.prepareOpen(a)).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    expect(() => value.activateView(second)).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    expect(() => value.releaseIdle(first)).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    expect(first.database.open).toBe(true)
    expect(second.database.open).toBe(true)
    releaseWithOpen()
    value.activateView(second)
  })

  it('rejects restore during an uncommitted preparation or a legacy operation', () => {
    const value = host(), a = fixture(), ticket = value.prepareOpen(a)
    expect(() => value.acquireRestoreOperation()).toThrow('PROJECT_RUNTIME_BUSY')
    const first = value.commitOpen(ticket)
    const reused = value.prepareOpen(a)
    expect(() => value.acquireRestoreOperation()).toThrow('PROJECT_RUNTIME_BUSY')
    value.abortOpen(reused)
    value.activateView(first)
    const release = value.acquireLegacyOperation('fictional:legacy')
    expect(() => value.acquireRestoreOperation()).toThrow('PROJECT_RUNTIME_LEGACY_OPERATION_BUSY')
    release()
    value.acquireRestoreOperation()()
  })

  it('can close a captured native handle after manifest admission is revoked', () => {
    const value = host(), project = fixture(), runtime = open(value, project)
    const file = path.join(project.rootPath, '.ai-novel', 'project.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...manifest, projectId: randomUUID() }))
    expect(() => value.assertOpen(runtime)).toThrow('PROJECT_MANIFEST_CHANGED')
    value.releaseIdle(runtime)
    expect(runtime.database.open).toBe(false)
    expect(runtime.phase).toBe('closed')
  })

  it('rejects an asynchronous before-close hook without closing its native target', () => {
    const value = host(), runtime = open(value, fixture())
    disposers.push(onProjectDatabaseBeforeClose(async context => {
      if (context.database === runtime.database) await Promise.resolve()
    }))
    expect(() => value.releaseIdle(runtime)).toThrow('PROJECT_DATABASE_BEFORE_CLOSE_MUST_BE_SYNCHRONOUS')
    expect(runtime.phase).toBe('closing')
    expect(runtime.database.open).toBe(true)
    expect(() => value.acquireRestoreOperation()).toThrow('PROJECT_RUNTIME_BUSY')
  })
})

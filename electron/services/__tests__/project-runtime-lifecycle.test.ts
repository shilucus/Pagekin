import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import type { TrustedProject } from '../project-access'
import { deactivateProjectData } from '../project-data-locator'
import { onProjectDatabaseBeforeClose, ProjectRuntimeHost, type ProjectRuntime } from '../project-runtime'

const roots: string[] = [], hosts: ProjectRuntimeHost[] = [], disposers: Array<() => void> = []

function project(parent = os.tmpdir()): TrustedProject {
  const rootPath = fs.mkdtempSync(path.join(parent, 'pagekin-lifecycle-'))
  roots.push(rootPath)
  fs.mkdirSync(path.join(rootPath, '.ai-novel'))
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: '2026-11-07T00:00:00.000Z' })
  fs.writeFileSync(path.join(rootPath, '.ai-novel', 'project.json'), JSON.stringify(manifest))
  createProjectDatabase(rootPath)
  return { kind: 'manifest', rootPath, projectId: manifest.projectId, storageFormat: 'canonical' }
}

function fixture() {
  const host = new ProjectRuntimeHost()
  hosts.push(host)
  const source = project(), runtime = host.commitOpen(host.prepareOpen(source))
  host.activateView(runtime)
  return { host, source, runtime, open: (source = project()) => host.commitOpen(host.prepareOpen(source)) }
}

function track(release: () => void) { disposers.push(release); return release }

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of disposers.splice(0).reverse()) dispose()
  for (const host of hosts.splice(0)) {
    for (const runtime of host.getOpenRuntimes()) {
      try { await host.requestClose(runtime, { timeoutMs: 0 }) }
      catch {
        if (runtime.database.open) runtime.database.close()
        deactivateProjectData(runtime.canonicalRoot)
      }
    }
  }
  for (const root of roots.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true })
})

describe('project runtime close and maintenance admission', () => {
  it('notifies application cancellation after sealing an empty host but waits for real physical work', async () => {
    const host = new ProjectRuntimeHost()
    hosts.push(host)
    const release = track(host.acquireApplicationOperation())
    const cancel = vi.fn(() => {
      expect(() => host.acquireApplicationOperation()).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
    })
    track(host.onApplicationCloseRequested(cancel))
    const operation = host.requestCloseAll({ timeoutMs: 1000, shutdown: false })
    expect(host.requestCloseAll({ shutdown: false })).toBe(operation)
    let settled = false
    void operation.then(() => { settled = true })
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    release()
    await operation
    host.finishWindowClose()
    track(host.acquireApplicationOperation())()
  })

  it('does not cancel application network operations when only one book closes', async () => {
    const f = fixture(), cancel = vi.fn()
    track(f.host.onApplicationCloseRequested(cancel))
    await f.host.requestClose(f.runtime)
    expect(cancel).not.toHaveBeenCalled()
    track(f.host.acquireApplicationOperation())()
  })

  it('notifies all application listeners and retains physical work after a quiesce failure', async () => {
    const host = new ProjectRuntimeHost(), failure = new Error('fictional quiesce failure')
    hosts.push(host)
    const release = track(host.acquireApplicationOperation())
    const remove = track(host.onApplicationCloseRequested(() => { throw failure }))
    const other = vi.fn()
    track(host.onApplicationCloseRequested(other))
    await expect(host.requestCloseAll({ timeoutMs: 0, shutdown: false })).rejects.toBe(failure)
    expect(other).toHaveBeenCalledOnce()
    expect(() => host.finishWindowClose()).toThrow('PROJECT_RUNTIME_BUSY')
    remove()
    await expect(host.requestCloseAll({ timeoutMs: 0, shutdown: false })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
    release()
    await host.requestCloseAll({ timeoutMs: 0, shutdown: false })
    host.finishWindowClose()
  })

  it('rejects asynchronous application quiesce listeners without force releasing their operation', async () => {
    const host = new ProjectRuntimeHost()
    hosts.push(host)
    const release = track(host.acquireApplicationOperation())
    const remove = track(host.onApplicationCloseRequested(async () => {}))
    await expect(host.requestCloseAll({ timeoutMs: 0, shutdown: false }))
      .rejects.toThrow('PROJECT_RUNTIME_CLOSE_LISTENER_MUST_BE_SYNCHRONOUS')
    expect(() => host.finishWindowClose()).toThrow('PROJECT_RUNTIME_BUSY')
    remove()
    release()
    await host.requestCloseAll({ timeoutMs: 0, shutdown: false })
    host.finishWindowClose()
  })

  it.each([false, true])('waits for actual main application work even when has-project=%s, without trusting logical Agent completion', async hasProject => {
    const host = new ProjectRuntimeHost()
    hosts.push(host)
    const runtime = hasProject ? host.commitOpen(host.prepareOpen(project())) : null
    const release = track(host.acquireApplicationOperation())
    const operation = host.requestCloseAll({ timeoutMs: 1000, shutdown: false })
    let closed = false
    void operation.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    if (runtime) expect(runtime.database.open).toBe(true)
    expect(() => host.acquireApplicationOperation()).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
    release()
    release()
    await operation
    expect(closed).toBe(true)
    if (runtime) expect(runtime.database.open).toBe(false)
    host.finishWindowClose()
    track(host.acquireApplicationOperation())()
  })

  it('retains a no-project shutdown fence after application-work timeout and retries after the real handler settles', async () => {
    const host = new ProjectRuntimeHost()
    hosts.push(host)
    const release = track(host.acquireApplicationOperation())
    await expect(host.requestCloseAll({ timeoutMs: 0, shutdown: false })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
    expect(() => host.acquireApplicationOperation()).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
    expect(() => host.finishWindowClose()).toThrow('PROJECT_RUNTIME_BUSY')
    release()
    await host.requestCloseAll({ timeoutMs: 0, shutdown: false })
    host.finishWindowClose()
    track(host.acquireApplicationOperation())()
  })

  it('keeps a captured database open during global work without blocking unrelated book work', async () => {
    const f = fixture(), b = f.open(), release = track(f.host.acquireApplicationOperation())
    const closing = f.host.requestClose(f.runtime, { timeoutMs: 1000 })
    track(f.host.acquireWork(b))()
    expect(() => f.host.acquireMaintenance(b, 'backup')).toThrow('PROJECT_RUNTIME_BUSY')
    expect(f.runtime.database.open).toBe(true)
    release()
    await closing
    f.host.assertWorkAvailable(b)
  })

  it('mutually excludes application work and global restore or any canonical maintenance lease', () => {
    const f = fixture(), release = track(f.host.acquireApplicationOperation())
    expect(() => f.host.acquireRestoreOperation()).toThrow('PROJECT_RUNTIME_BUSY')
    release()
    const maintenance = f.host.acquireMaintenance(f.runtime, 'backup')
    track(maintenance.release)
    expect(() => f.host.acquireApplicationOperation()).toThrow('PROJECT_RUNTIME_MAINTENANCE_BUSY')
    maintenance.release()
    const restore = track(f.host.acquireRestoreOperation())
    expect(() => f.host.acquireApplicationOperation()).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    restore()
    track(f.host.acquireApplicationOperation())()
  })

  it.each(['legacy', 'editor'] as const)('rejects new task admission during an awaited %s operation without blocking its existing effect', kind => {
    const f = fixture(), release = track(kind === 'legacy' ? f.host.acquireLegacyOperation('fictional:awaited') : f.host.acquireWork(f.runtime))
    expect(() => f.host.assertTaskAvailable(f.runtime)).toThrow('PROJECT_RUNTIME_BUSY')
    f.host.assertWorkAvailable(f.runtime)
    f.runtime.database.exec('CREATE TABLE admitted_effect(value TEXT)')
    track(f.host.acquireWork(f.runtime))()
    release()
    f.host.assertTaskAvailable(f.runtime)
  })

  it('does not let another book operation or maintenance block task admission in an unrelated open book', () => {
    const f = fixture(), b = f.open(), release = track(f.host.acquireWork(b))
    f.host.assertTaskAvailable(f.runtime)
    release()
    const lease = f.host.acquireMaintenance(f.runtime, 'backup')
    track(lease.release)
    f.host.assertTaskAvailable(b)
    expect(() => f.host.assertTaskAvailable(f.runtime)).toThrow('PROJECT_RUNTIME_MAINTENANCE_BUSY')
  })

  it('seals before early cancellation and waits for full admitted work and physical settlement before flush, KB and native close', async () => {
    const f = fixture(), b = f.open(), events: string[] = [], abort = new AbortController()
    const release = track(f.host.acquireWork(f.runtime))
    let physical = true
    track(f.host.registerBusyPredicate(runtime => runtime === f.runtime && physical))
    track(f.host.onCloseRequested(runtime => {
      if (runtime !== f.runtime) return
      expect(() => f.host.acquireWork(runtime)).toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')
      f.host.assertOpen(runtime)
      abort.abort()
      events.push('quiesce')
    }))
    track(onProjectDatabaseBeforeClose(({ database }) => {
      if (database !== f.runtime.database) return
      expect(physical).toBe(false)
      database.exec("CREATE TABLE lifecycle_tail(value TEXT); INSERT INTO lifecycle_tail VALUES('settled')")
      events.push('flush')
    }))
    track(f.host.onBeforeRelease(runtime => {
      if (runtime !== f.runtime) return
      expect(runtime.database.prepare('SELECT value FROM lifecycle_tail').pluck().get()).toBe('settled')
      events.push('kb')
    }))
    const nativeClose = f.runtime.database.close.bind(f.runtime.database)
    vi.spyOn(f.runtime.database, 'close').mockImplementation(() => { events.push('native'); return nativeClose() })
    const operation = f.host.requestClose(f.runtime)
    expect(abort.signal.aborted).toBe(true)
    expect(events).toEqual(['quiesce'])
    expect(f.runtime.phase).toBe('open')
    expect(f.runtime.database.open).toBe(true)
    expect(f.host.requestClose(f.runtime)).toBe(operation)
    expect(() => f.host.prepareOpen(f.source)).toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')
    track(f.host.acquireWork(b))()
    release()
    await Promise.resolve()
    expect(f.runtime.database.open).toBe(true)
    physical = false
    await operation
    expect(events).toEqual(['quiesce', 'flush', 'kb', 'native'])
    expect(f.runtime.phase).toBe('closed')
    f.host.assertWorkAvailable(b)
  })

  it.each(['work', 'physical', 'legacy'] as const)('keeps native identity and the work fence after a %s drain timeout and permits a safe retry', async kind => {
    const f = fixture(), identity = f.runtime.databaseIdentity, epoch = f.runtime.executionEpoch
    let busy = kind === 'physical'
    track(f.host.registerBusyPredicate(runtime => runtime === f.runtime && busy))
    const release = kind === 'legacy' ? track(f.host.acquireLegacyOperation('fictional:await'))
      : kind === 'work' ? track(f.host.acquireWork(f.runtime)) : () => {}
    const flush = vi.fn()
    track(onProjectDatabaseBeforeClose(({ database }) => { if (database === f.runtime.database) flush() }))
    await expect(f.host.requestClose(f.runtime, { timeoutMs: 0 })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
    expect(f.runtime.phase).toBe('open')
    expect(f.runtime.databaseIdentity).toBe(identity)
    expect(f.runtime.executionEpoch).toBe(epoch)
    f.host.assertOpen(f.runtime)
    expect(() => f.host.acquireWork(f.runtime)).toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')
    expect(() => f.host.acquireLegacyOperation('fictional:new')).toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')
    expect(() => f.host.releaseIdle(f.runtime)).toThrow()
    expect(flush).not.toHaveBeenCalled()
    f.runtime.database.exec("CREATE TABLE retained_settlement(value TEXT); INSERT INTO retained_settlement VALUES('unknown retained')")
    busy = false
    release()
    await f.host.requestClose(f.runtime, { timeoutMs: 0 })
    expect(flush).toHaveBeenCalledTimes(1)
    await f.host.requestClose(f.runtime)
  })

  it.each(['owner', 'kb', 'native'] as const)('retries a quarantined %s close failure with the captured handle rather than admitting another owner', async failure => {
    const f = fixture(), database = f.runtime.database
    let fail = true
    track(onProjectDatabaseBeforeClose(context => {
      if (context.database === database && failure === 'owner' && fail) throw new Error('fictional owner flush failed')
    }))
    track(f.host.onBeforeRelease(runtime => {
      if (runtime === f.runtime && failure === 'kb' && fail) throw new Error('fictional kb close failed')
    }))
    if (failure === 'native') {
      const close = database.close.bind(database)
      vi.spyOn(database, 'close').mockImplementation(() => {
        if (fail) throw new Error('fictional native close failed')
        return close()
      })
    }
    await expect(f.host.requestClose(f.runtime)).rejects.toThrow(`fictional ${failure === 'owner' ? 'owner flush' : failure === 'kb' ? 'kb close' : 'native close'} failed`)
    expect(f.runtime.phase).toBe('closing')
    expect(database.open).toBe(true)
    expect(() => f.host.prepareOpen(f.source)).toThrow('PROJECT_RUNTIME_NOT_OPEN')
    fail = false
    await f.host.requestClose(f.runtime)
    expect(database.open).toBe(false)
    expect(f.runtime.phase).toBe('closed')
  })

  it('runs every synchronous quiesce listener, surfaces failure, and keeps the seal for a retry', async () => {
    const f = fixture(), later = vi.fn(), error = new Error('fictional revoke failed')
    const removeFailure = track(f.host.onCloseRequested(() => { throw error }))
    track(f.host.onCloseRequested(later))
    await expect(f.host.requestClose(f.runtime)).rejects.toBe(error)
    expect(later).toHaveBeenCalledExactlyOnceWith(f.runtime)
    expect(f.runtime.database.open).toBe(true)
    expect(() => f.host.acquireWork(f.runtime)).toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')
    removeFailure()
    await f.host.requestClose(f.runtime)
  })

  it('rejects asynchronous close listeners without closing the captured DB', async () => {
    const f = fixture(), invoked = vi.fn(), remove = track(f.host.onCloseRequested(async () => { invoked() }))
    await expect(f.host.requestClose(f.runtime)).rejects.toThrow('PROJECT_RUNTIME_CLOSE_LISTENER_MUST_BE_SYNCHRONOUS')
    expect(invoked).not.toHaveBeenCalled()
    expect(f.runtime.database.open).toBe(true)
    remove()
    await f.host.requestClose(f.runtime)
  })

  it('shares an in-flight request during synchronous quiesce reentry without recursively closing', async () => {
    const f = fixture(), release = track(f.host.acquireWork(f.runtime))
    let reentered: Promise<void> | undefined
    const listener = vi.fn(() => { reentered = f.host.requestClose(f.runtime) })
    track(f.host.onCloseRequested(listener))
    const operation = f.host.requestClose(f.runtime)
    expect(reentered).toBe(operation)
    expect(listener).toHaveBeenCalledTimes(1)
    release()
    await operation
  })

  it.each([-1, NaN, Infinity, 2_147_483_648])('rejects an invalid close timeout %s before sealing work', async timeoutMs => {
    const f = fixture()
    await expect(f.host.requestClose(f.runtime, { timeoutMs })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT_INVALID')
    track(f.host.acquireWork(f.runtime))()
  })

  it.each(['work', 'physical', 'ticket', 'legacy'] as const)('refuses maintenance while %s is admitted without cancelling it', kind => {
    const f = fixture(), quiesce = vi.fn()
    track(f.host.onCloseRequested(quiesce))
    if (kind === 'work') track(f.host.acquireWork(f.runtime))
    if (kind === 'legacy') track(f.host.acquireLegacyOperation('fictional:busy'))
    if (kind === 'physical') track(f.host.registerBusyPredicate(runtime => runtime === f.runtime))
    if (kind === 'ticket') {
      const ticket = f.host.prepareOpen(f.source)
      track(() => f.host.abortOpen(ticket))
    }
    expect(() => f.host.acquireMaintenance(f.runtime, 'backup')).toThrow()
    expect(f.host.getReservedRoots()).toEqual([])
    expect(quiesce).not.toHaveBeenCalled()
    expect(f.runtime.database.open).toBe(true)
  })

  it('fences only the maintained book and canonical aliases, while allowing unrelated open books and views', () => {
    const f = fixture(), b = f.open(), quiesce = vi.fn()
    track(f.host.onCloseRequested(quiesce))
    const lease = f.host.acquireMaintenance(f.runtime, 'backup')
    track(lease.release)
    f.host.assertOpen(f.runtime)
    expect(() => f.host.acquireWork(f.runtime)).toThrow('PROJECT_RUNTIME_MAINTENANCE_BUSY')
    expect(() => f.host.acquireMaintenance(f.runtime, 'delete')).toThrow('PROJECT_RUNTIME_MAINTENANCE_BUSY')
    expect(() => f.host.assertLifecycleAvailable()).toThrow('PROJECT_RUNTIME_MAINTENANCE_BUSY')
    expect(() => f.host.acquireRestoreOperation()).toThrow('PROJECT_RUNTIME_BUSY')
    const alias = path.join(b.canonicalRoot, 'fictional-alias')
    fs.symlinkSync(f.source.rootPath, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => f.host.prepareOpen({ ...f.source, rootPath: alias })).toThrow('PROJECT_RUNTIME_MAINTENANCE_BUSY')
    track(f.host.acquireWork(b))()
    f.host.activateView(b)
    const ticket = f.host.prepareOpen({ kind: 'manifest', rootPath: b.canonicalRoot, projectId: b.projectId, storageFormat: 'canonical' })
    f.host.abortOpen(ticket)
    expect(quiesce).not.toHaveBeenCalled()
    lease.release()
    lease.release()
    f.host.assertWorkAvailable(f.runtime)
  })

  it('retains a maintenance path reservation after native close until release, then reopens with new identity', () => {
    const f = fixture(), epoch = f.runtime.executionEpoch, identity = f.runtime.databaseIdentity
    const lease = f.host.acquireMaintenance(f.runtime, 'delete')
    track(lease.release)
    lease.closeIdle()
    lease.closeIdle()
    expect(f.runtime.database.open).toBe(false)
    expect(f.host.getOpenRuntimes()).toEqual([])
    expect(f.host.getReservedRoots()).toEqual([f.runtime.canonicalRoot])
    expect(Object.isFrozen(f.host.getReservedRoots())).toBe(true)
    expect(() => f.host.prepareOpen(f.source)).toThrow('PROJECT_RUNTIME_MAINTENANCE_BUSY')
    expect(() => f.host.acquireRestoreOperation()).toThrow('PROJECT_RUNTIME_BUSY')
    lease.release()
    expect(() => lease.closeIdle()).toThrow('PROJECT_RUNTIME_MAINTENANCE_LEASE_INVALID')
    const reopened = f.open(f.source)
    expect(reopened.executionEpoch).not.toBe(epoch)
    expect(reopened.databaseIdentity).not.toBe(identity)
  })

  it('rejects overlapping project maintenance and keeps nested paths reserved after closing the outer project', async () => {
    const f = fixture(), nested = project(f.runtime.canonicalRoot), child = f.open(nested)
    expect(() => f.host.acquireMaintenance(f.runtime, 'delete')).toThrow('PROJECT_RUNTIME_MAINTENANCE_BUSY')
    await f.host.requestClose(child)
    const lease = f.host.acquireMaintenance(f.runtime, 'delete')
    track(lease.release)
    lease.closeIdle()
    expect(() => f.host.prepareOpen(nested)).toThrow('PROJECT_RUNTIME_MAINTENANCE_BUSY')
  })

  it('does not release a reservation reentrantly from a close hook and permits retry after native close fails', () => {
    const f = fixture(), lease = f.host.acquireMaintenance(f.runtime, 'migration')
    track(lease.release)
    let fail = true
    track(f.host.onBeforeRelease(runtime => {
      if (runtime !== f.runtime) return
      expect(() => lease.release()).toThrow('PROJECT_RUNTIME_CLOSE_REENTRANT')
      if (fail) throw new Error('fictional maintenance close failed')
    }))
    expect(() => lease.closeIdle()).toThrow('fictional maintenance close failed')
    expect(f.runtime.phase).toBe('closing')
    expect(f.host.getReservedRoots()).toEqual([f.runtime.canonicalRoot])
    fail = false
    lease.closeIdle()
    expect(f.runtime.phase).toBe('closed')
    expect(f.host.getReservedRoots()).toEqual([f.runtime.canonicalRoot])
  })

  it('seals every runtime and host open/create before the first close-all listener, permanently by default', async () => {
    const f = fixture(), b = f.open(), source = project(), visited: ProjectRuntime[] = []
    track(f.host.onCloseRequested(runtime => {
      visited.push(runtime)
      expect(() => f.host.assertWorkAvailable(b)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
      expect(() => f.host.prepareOpen(source)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
      expect(() => f.host.assertLifecycleAvailable()).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
    }))
    await f.host.requestCloseAll()
    expect(visited).toEqual([f.runtime, b])
    expect(f.host.getOpenRuntimes()).toEqual([])
    f.host.finishWindowClose()
    expect(() => f.host.prepareOpen(source)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
  })

  it('holds a temporary window-close seal after drain until the actual native closed acknowledgement', async () => {
    const f = fixture(), epoch = f.runtime.executionEpoch
    await f.host.requestCloseAll({ shutdown: false })
    expect(() => f.host.prepareOpen(f.source)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
    f.host.finishWindowClose()
    const reopened = f.open(f.source)
    expect(reopened.executionEpoch).not.toBe(epoch)
    f.host.assertWorkAvailable(reopened)
    f.host.finishWindowClose()
  })

  it('monotonically upgrades a pending temporary close to permanent shutdown without starting another drain', async () => {
    const f = fixture(), release = track(f.host.acquireWork(f.runtime)), listener = vi.fn()
    track(f.host.onCloseRequested(listener))
    const operation = f.host.requestCloseAll({ shutdown: false })
    expect(() => f.host.finishWindowClose()).toThrow('PROJECT_RUNTIME_BUSY')
    expect(f.host.requestCloseAll({ shutdown: true })).toBe(operation)
    expect(f.host.requestCloseAll({ shutdown: false })).toBe(operation)
    expect(listener).toHaveBeenCalledTimes(1)
    release()
    await operation
    f.host.finishWindowClose()
    expect(() => f.host.prepareOpen(f.source)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
  })

  it('keeps a failed temporary close-all sealed and retries only still-live resources without force closing', async () => {
    const f = fixture(), b = f.open(), release = track(f.host.acquireWork(f.runtime))
    await expect(f.host.requestCloseAll({ timeoutMs: 0, shutdown: false })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
    expect(f.runtime.database.open).toBe(true)
    expect(b.database.open).toBe(false)
    f.host.assertOpen(f.runtime)
    expect(() => f.host.finishWindowClose()).toThrow('PROJECT_RUNTIME_BUSY')
    expect(() => f.host.acquireWork(f.runtime)).toThrow('PROJECT_RUNTIME_HOST_CLOSING')
    release()
    await f.host.requestCloseAll({ timeoutMs: 0, shutdown: false })
    f.host.finishWindowClose()
    f.open(f.source)
  })

  it('refuses close-all during a pending open before sealing and does not promote a refused request to permanent shutdown', async () => {
    const f = fixture(), ticket = f.host.prepareOpen(project())
    await expect(f.host.requestCloseAll()).rejects.toThrow()
    f.host.assertWorkAvailable(f.runtime)
    f.host.abortOpen(ticket)
    await f.host.requestCloseAll({ shutdown: false })
    f.host.finishWindowClose()
    f.open(f.source)
  })

  it.each(['work', 'physical', 'legacy', 'ticket', 'maintenance', 'closing-intent'] as const)('rejects global restore while %s is live', async kind => {
    const f = fixture()
    if (kind === 'work') track(f.host.acquireWork(f.runtime))
    if (kind === 'physical') track(f.host.registerBusyPredicate(runtime => runtime === f.runtime))
    if (kind === 'legacy') track(f.host.acquireLegacyOperation('fictional:legacy'))
    if (kind === 'ticket') { const ticket = f.host.prepareOpen(f.source); track(() => f.host.abortOpen(ticket)) }
    if (kind === 'maintenance') track(f.host.acquireMaintenance(f.runtime, 'backup').release)
    if (kind === 'closing-intent') {
      track(f.host.acquireWork(f.runtime))
      await expect(f.host.requestClose(f.runtime, { timeoutMs: 0 })).rejects.toThrow('PROJECT_RUNTIME_CLOSE_TIMEOUT')
    }
    expect(() => f.host.acquireRestoreOperation()).toThrow()
  })

  it('blocks new work in all books throughout a global restore while retaining resources for readonly cleanup', () => {
    const f = fixture(), b = f.open(), release = track(f.host.acquireRestoreOperation())
    for (const runtime of [f.runtime, b]) {
      f.host.assertOpen(runtime)
      expect(() => f.host.acquireWork(runtime)).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
      expect(() => f.host.acquireMaintenance(runtime, 'backup')).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
    }
    release()
    track(f.host.acquireWork(f.runtime))()
    track(f.host.acquireWork(b))()
  })

  it('propagates busy-predicate errors without force closing or dropping the close fence', async () => {
    const f = fixture(), error = new Error('fictional activity state unavailable')
    const remove = track(f.host.registerBusyPredicate(() => { throw error }))
    await expect(f.host.requestClose(f.runtime)).rejects.toBe(error)
    expect(f.runtime.database.open).toBe(true)
    expect(() => f.host.acquireWork(f.runtime)).toThrow('PROJECT_RUNTIME_CLOSE_REQUESTED')
    remove()
    await f.host.requestClose(f.runtime)
  })
})

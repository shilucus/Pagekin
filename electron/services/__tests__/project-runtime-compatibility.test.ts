import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import type { TrustedProject } from '../project-access'
import { deactivateProjectData } from '../project-data-locator'
import { ProjectRuntimeHost, projectRuntimeHost } from '../project-runtime'
import { projectAccess } from '../project-access'
import { acquireProjectBackupOperation, assertRestoreTargetOutsideRuntimes, withProjectRestoreOperation } from '../project-runtime-compatibility'

const containers: string[] = []
const isolatedHosts: ProjectRuntimeHost[] = []
const disposers: Array<() => void> = []

function fixture(): { project: TrustedProject; container: string } {
  const base = path.resolve('.runtime/rt-compat-path')
  fs.mkdirSync(base, { recursive: true })
  const container = fs.mkdtempSync(path.join(base, 'fixture-'))
  containers.push(container)
  const rootPath = path.join(container, 'project')
  fs.mkdirSync(path.join(rootPath, '.ai-novel'), { recursive: true })
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: '2026-11-07T00:00:00.000Z' })
  fs.writeFileSync(path.join(rootPath, '.ai-novel', 'project.json'), JSON.stringify(manifest))
  createProjectDatabase(rootPath)
  return { container, project: { kind: 'manifest', rootPath, projectId: manifest.projectId, storageFormat: 'canonical' } }
}

function open(project: TrustedProject, host = projectRuntimeHost) {
  return host.commitOpen(host.prepareOpen(project))
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dispose of disposers.splice(0)) dispose()
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) projectRuntimeHost.releaseIdle(runtime)
  for (const host of isolatedHosts.splice(0)) {
    for (const runtime of host.getOpenRuntimes()) {
      if (runtime.phase === 'open') host.releaseIdle(runtime)
      else {
        // Only this isolated test host may contain a deliberately failed release.
        if (runtime.database.open) runtime.database.close()
        deactivateProjectData(runtime.canonicalRoot)
      }
    }
  }
  for (const container of containers.splice(0)) fs.rmSync(container, { recursive: true, force: true })
})

describe('canonical restore target/runtime exclusion', () => {
  it('keeps a closed delete target reserved against restore overlap while B remains available', () => {
    const a = fixture(), b = fixture(), first = open(a.project), second = open(b.project)
    projectRuntimeHost.activateView(first)
    const maintenance = projectRuntimeHost.acquireMaintenance(first, 'delete')
    try {
      maintenance.closeIdle()
      expect(first.database.open).toBe(false)
      expect(projectRuntimeHost.getOpenRuntimes()).not.toContain(first)
      expect(() => assertRestoreTargetOutsideRuntimes(first.canonicalRoot)).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
      expect(() => assertRestoreTargetOutsideRuntimes(path.join(first.canonicalRoot, 'copy'))).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
      expect(() => assertRestoreTargetOutsideRuntimes(a.container)).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
      const release = projectRuntimeHost.acquireWork(second)
      release()
    } finally { maintenance.release() }
    expect(() => assertRestoreTargetOutsideRuntimes(first.canonicalRoot)).not.toThrow()
  })

  it('freezes backup authorization to A resources across a B view switch until release', () => {
    const a = fixture(), b = fixture(), first = open(a.project), second = open(b.project)
    const lease = projectAccess.beginViewSession(first)
    const session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
    const maintenance = acquireProjectBackupOperation(session)
    try {
      expect(() => projectRuntimeHost.acquireWork(first)).toThrow()
      projectAccess.beginViewSession(second)
      expect(maintenance.assertCurrentContext(session, first.canonicalRoot)).toBe(true)
      expect(maintenance.assertCurrentContext({ ...session, projectId: second.projectId }, first.canonicalRoot)).toBe(false)
      expect(maintenance.assertCurrentContext(session, second.canonicalRoot)).toBe(false)
      expect(first.database.prepare('SELECT 1').pluck().get()).toBe(1)
      const release = projectRuntimeHost.acquireWork(second)
      release()
    } finally { maintenance.release() }
    const release = projectRuntimeHost.acquireWork(first)
    release()
  })
  it('rejects the runtime itself, its child, and an ancestor containing it', () => {
    const { project, container } = fixture(), runtime = open(project)
    expect(() => assertRestoreTargetOutsideRuntimes(runtime.canonicalRoot)).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
    expect(() => assertRestoreTargetOutsideRuntimes(path.join(runtime.canonicalRoot, 'copy'))).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
    expect(() => assertRestoreTargetOutsideRuntimes(container)).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
    expect(runtime.database.prepare('SELECT 1').pluck().get()).toBe(1)
  })

  it('resolves a parent junction into the actual runtime before deciding containment', () => {
    const { project, container } = fixture(), runtime = open(project)
    const inside = path.join(runtime.canonicalRoot, 'inside'), alias = path.join(container, 'alias')
    fs.mkdirSync(inside)
    fs.symlinkSync(inside, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => assertRestoreTargetOutsideRuntimes(path.join(alias, 'new-copy'))).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
    expect(fs.realpathSync.native(alias)).toBe(fs.realpathSync.native(inside))
  })

  it('allows a physically separate sibling, including a shared lexical prefix', () => {
    const { project, container } = fixture()
    open(project)
    expect(() => assertRestoreTargetOutsideRuntimes(path.join(container, 'outside'))).not.toThrow()
    expect(() => assertRestoreTargetOutsideRuntimes(path.join(container, 'project-copy'))).not.toThrow()
  })

  it('checks every real open runtime rather than only the active view', () => {
    const a = fixture(), b = fixture(), first = open(a.project), second = open(b.project)
    projectRuntimeHost.activateView(first)
    expect(() => assertRestoreTargetOutsideRuntimes(path.join(second.canonicalRoot, 'copy'))).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
    expect(projectRuntimeHost.getActiveView()).toBe(first)
  })

  it('includes a real closing entry without placing the singleton in quarantine', () => {
    const { project } = fixture(), isolated = new ProjectRuntimeHost()
    isolatedHosts.push(isolated)
    const runtime = open(project, isolated)
    disposers.push(isolated.onBeforeRelease(() => { throw new Error('fictional release failure') }))
    expect(() => isolated.releaseIdle(runtime)).toThrow('fictional release failure')
    expect(runtime.phase).toBe('closing')
    expect(projectRuntimeHost.getOpenRuntimes()).toEqual([])
    vi.spyOn(projectRuntimeHost, 'getOpenRuntimes').mockReturnValue(isolated.getOpenRuntimes())
    expect(() => assertRestoreTargetOutsideRuntimes(path.join(runtime.canonicalRoot, 'copy'))).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
    expect(() => assertRestoreTargetOutsideRuntimes(runtime.canonicalRoot)).toThrow('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
  })

  it.each(['success', 'throw'] as const)('releases the no-active restore wrapper after %s', async mode => {
    const { project } = fixture()
    expect(projectRuntimeHost.getActiveView()).toBeNull()
    const operation = withProjectRestoreOperation(async () => {
      await Promise.resolve()
      expect(() => projectRuntimeHost.prepareOpen(project)).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
      expect(() => projectRuntimeHost.activateView(null)).toThrow('PROJECT_RUNTIME_RESTORE_BUSY')
      if (mode === 'throw') throw new Error('fictional restore failure')
      return 'fictional restored copy'
    })
    if (mode === 'throw') await expect(operation).rejects.toThrow('fictional restore failure')
    else await expect(operation).resolves.toBe('fictional restored copy')
    const runtime = open(project)
    projectRuntimeHost.assertOpen(runtime)
  })
})

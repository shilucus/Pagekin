import fs from 'node:fs'
import path from 'node:path'
import { projectRuntimeHost } from './project-runtime'
import { projectAccess } from './project-access'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'

export interface ProjectBackupOperation {
  readonly project: { readonly projectId: string; readonly leaseId: string; readonly rootPath: string }
  assertCurrentContext(context: ProjectSessionContext, sourceRoot: string): boolean
  release(): void
}

/** The initial UI lease authorizes this captured snapshot, not subsequent view changes. */
export function acquireProjectBackupOperation(context: ProjectSessionContext | undefined): ProjectBackupOperation {
  const runtime = projectAccess.assertViewContext(context)
  const session = Object.freeze({ ...context! })
  const maintenance = projectRuntimeHost.acquireMaintenance(runtime, 'backup')
  return {
    project: Object.freeze({ projectId: runtime.projectId, leaseId: session.leaseId, rootPath: runtime.canonicalRoot }),
    assertCurrentContext(candidate, sourceRoot) {
      projectRuntimeHost.assertOpen(runtime)
      return candidate.projectId === session.projectId && candidate.leaseId === session.leaseId
        && candidate.projectPath === session.projectPath
        && projectAccess.sameCanonicalProjectRoot(runtime.canonicalRoot, sourceRoot)
    },
    release: () => maintenance.release(),
  }
}

/** Unadapted async handlers may not change their compatibility DB while awaiting. */
export async function withLegacyProjectOperation<T>(channel: string, operation: () => T | Promise<T>): Promise<T> {
  const release = projectRuntimeHost.acquireLegacyOperation(channel)
  try { return await operation() } finally { release() }
}

/** Restoring a new copy is authorized by its external target grant, not a UI lease. */
export async function withProjectRestoreOperation<T>(operation: () => T | Promise<T>): Promise<T> {
  const release = projectRuntimeHost.acquireRestoreOperation()
  try { return await operation() } finally { release() }
}

export function assertRestoreTargetOutsideRuntimes(targetRoot: string): void {
  const absolute = path.resolve(targetRoot)
  const physicalParent = fs.realpathSync.native(path.dirname(absolute))
  const target = path.join(physicalParent, path.basename(absolute))
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  const contains = (parent: string, child: string) => {
    const relative = path.relative(key(parent), key(child))
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  const roots = [...projectRuntimeHost.getOpenRuntimes().map(runtime => runtime.canonicalRoot),
    ...projectRuntimeHost.getReservedRoots()]
  for (const root of roots) {
    if (contains(root, target) || contains(target, root)) {
      throw new Error('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
    }
  }
}

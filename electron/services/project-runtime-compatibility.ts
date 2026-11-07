import fs from 'node:fs'
import path from 'node:path'
import { projectRuntimeHost } from './project-runtime'

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
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) {
    if (contains(runtime.canonicalRoot, target) || contains(target, runtime.canonicalRoot)) {
      throw new Error('PROJECT_RUNTIME_RESTORE_TARGET_OVERLAP')
    }
  }
}

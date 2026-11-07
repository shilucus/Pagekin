import {
  normalizeWorkflowResourceKeys,
  workflowResourceClaimsConflict,
  type WorkflowResourceClaims,
} from '../../src/shared/workflow-resource-claims'

export interface MainResourceClaimLease {
  release(): void
}

/** Freeze queue inputs without changing the shared read/write conflict semantics. */
export function normalizeMainResourceClaims(claims: WorkflowResourceClaims = {}): WorkflowResourceClaims {
  const resourceKeys = normalizeWorkflowResourceKeys(claims.resourceKeys)
  const readResourceKeys = normalizeWorkflowResourceKeys(claims.readResourceKeys)
  return Object.freeze({
    resourceKeys: resourceKeys && Object.freeze([...resourceKeys].sort()),
    readResourceKeys: readResourceKeys && Object.freeze([...readResourceKeys].sort()),
  })
}

/** Process-local coordination only; projectKey must already be a trusted main-process identity. */
export class MainResourceClaimRegistry {
  private readonly held = new Map<symbol, { projectKey: string; claims: WorkflowResourceClaims }>()
  private readonly releaseListeners = new Set<() => void>()

  tryAcquire(projectKey: string, requested: WorkflowResourceClaims = {}): MainResourceClaimLease | null {
    const claims = normalizeMainResourceClaims(requested)
    for (const active of this.held.values()) {
      if (active.projectKey === projectKey && workflowResourceClaimsConflict(active.claims, claims)) return null
    }

    const token = Symbol()
    this.held.set(token, { projectKey, claims })
    return Object.freeze({ release: () => {
      if (!this.held.delete(token)) return
      for (const listener of [...this.releaseListeners]) listener()
    } })
  }

  onRelease(listener: () => void): () => void {
    this.releaseListeners.add(listener)
    return () => { this.releaseListeners.delete(listener) }
  }

  getStats(): Readonly<{ active: number }> {
    return Object.freeze({ active: this.held.size })
  }
}

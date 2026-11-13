import { createHash } from 'node:crypto'
import type { ReferenceImportResources } from '../knowledge-base'
import { ReferenceImportGrantRepository } from '../repositories/reference-import-grant-repository'
import { assertReferenceImportGrantId, assertReferenceImportGrantRef,
  type ReferenceImportGrantRef } from '../../src/shared/reference-import-grant'
import { isContentHash } from '../../src/shared/source-ref'
import type { ReferenceEmbeddingBudgetCapability, ReferenceEmbeddingBudgetFlight,
  ReferenceEmbeddingBudgetRepository } from '../repositories/reference-embedding-budget-repository'
import type { ReferenceEmbeddingDispatchRecord } from './reference-embedding-dispatch-contract'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'
import { projectRuntimeHost, type ProjectRuntime } from './project-runtime'

export interface ReferenceImportAdmission {
  readonly bindingKey: string
  readonly budget?: {
    assertEffect(): void
    openFlight(): ReferenceEmbeddingBudgetFlight
    beforeDispatch(flight: ReferenceEmbeddingBudgetFlight, mark: () => ReferenceEmbeddingDispatchRecord): ReferenceEmbeddingDispatchRecord
    settle(flight: ReferenceEmbeddingBudgetFlight, mark: ReferenceEmbeddingDispatchRecord, settle: () => void): void
    finish(flight: ReferenceEmbeddingBudgetFlight): void
  }
  assertCurrent(resources: ReferenceImportResources, runId: string): void
  withTransaction<T>(resources: ReferenceImportResources, runId: string, operation: () => T): T
}

const issuedAdmissions = new WeakSet<object>()
function fail(code: string): never { throw new Error(`REFERENCE_IMPORT_ADMISSION_${code}`) }

function synchronous<T>(operation: () => T): T {
  if (Object.prototype.toString.call(operation) === '[object AsyncFunction]') fail('ASYNC_GUARD_INVALID')
  const result = operation()
  if (result && (typeof result === 'object' || typeof result === 'function')
    && typeof (result as { then?: unknown }).then === 'function') {
    if (result instanceof Promise) void result.catch(() => {})
    fail('ASYNC_GUARD_INVALID')
  }
  return result
}

export function assertIssuedReferenceImportAdmission(value: unknown): asserts value is ReferenceImportAdmission {
  if (!value || typeof value !== 'object' || !issuedAdmissions.has(value)) fail('INVALID')
}

/** Main-only capture of existing grant authority; never a grant issuer or workflow launcher. */
export function captureReferenceImportAdmission(
  runtime: ProjectRuntime,
  ref: ReferenceImportGrantRef,
  expectedRequestHash: string,
  assertLocallyCurrent?: () => void,
  budget?: { repository: ReferenceEmbeddingBudgetRepository; capability: ReferenceEmbeddingBudgetCapability },
): ReferenceImportAdmission {
  assertReferenceImportGrantRef(ref)
  if (typeof expectedRequestHash !== 'string' || !isContentHash(expectedRequestHash)) fail('REQUEST_HASH_INVALID')
  const capturedRef = Object.freeze({ grantId: ref.grantId, revision: ref.revision, runId: ref.runId })
  assertReferenceImportGrantRef(capturedRef)
  if (synchronous(() => projectRuntimeHost.assertWorkAvailable(runtime)) !== undefined) fail('ASYNC_GUARD_INVALID')
  const { database, databaseIdentity, canonicalRoot, projectId, projectPath, projectStorageRoot, executionEpoch } = runtime
  const context = Object.freeze({ database, canonicalRoot, projectId })

  const assertRuntime = () => {
    if (synchronous(() => projectRuntimeHost.assertOpen(runtime)) !== undefined) fail('ASYNC_GUARD_INVALID')
    if (!database.open || runtime.database !== database || runtime.databaseIdentity !== databaseIdentity
      || runtime.canonicalRoot !== canonicalRoot || runtime.executionEpoch !== executionEpoch
      || runtime.projectId !== projectId || runtime.projectPath !== projectPath || runtime.projectStorageRoot !== projectStorageRoot
      || projectRuntimeHost.getByRoot(canonicalRoot) !== runtime) fail('RESOURCES_CHANGED')
  }
  const grants = new ReferenceImportGrantRepository(database, { projectId, context, assertCurrent: assertRuntime,
    isFrozen: grantId => readPortableRuntimeFreeze(canonicalRoot).isFrozen('reference_import_grants', grantId) })

  const assertGrant = () => {
    // A failed durable revoke must not revive an issuer's already retired local capability.
    if (assertLocallyCurrent && synchronous(assertLocallyCurrent) !== undefined) fail('ASYNC_GUARD_INVALID')
    const grant = synchronous(() => grants.assertActive(capturedRef))
    if (budget && (budget.capability.runId !== capturedRef.runId
      || budget.capability.manifestFingerprint !== grant.manifestFingerprint)) fail('INVALID')
    if (grant.requestHash !== expectedRequestHash) fail('REQUEST_MISMATCH')
    if (assertLocallyCurrent && synchronous(assertLocallyCurrent) !== undefined) fail('ASYNC_GUARD_INVALID')
  }
  const transaction = <T>(operation: () => T, isolateEffects = false): T => {
    assertRuntime()
    const checked = () => { assertRuntime(); return synchronous(operation) }
    // An outer catch must not commit effects rejected by the admission's post-check.
    return database.inTransaction && !isolateEffects ? checked() : database.transaction(checked).immediate()
  }
  const assertResources = (resources: ReferenceImportResources, runId: string) => {
    assertReferenceImportGrantId(runId)
    if (runId !== capturedRef.runId) fail('RUN_MISMATCH')
    if (!resources || resources.database !== database || resources.databaseIdentity !== databaseIdentity
      || resources.canonicalRoot !== canonicalRoot || resources.executionEpoch !== executionEpoch
      || typeof resources.assertResources !== 'function') fail('RESOURCES_CHANGED')
    if (synchronous(resources.assertResources) !== undefined) fail('ASYNC_GUARD_INVALID')
    assertRuntime()
  }

  transaction(assertGrant)
  const admission: ReferenceImportAdmission = Object.freeze({
    bindingKey: createHash('sha256').update(JSON.stringify([projectId, canonicalRoot, executionEpoch,
      capturedRef.grantId, capturedRef.revision, capturedRef.runId, expectedRequestHash])).digest('hex'),
    ...(budget ? { budget: Object.freeze({
      assertEffect: () => transaction(() => { assertGrant(); budget.repository.assertEffect(budget.capability) }),
      openFlight: () => budget.repository.openFlight(budget.capability),
      beforeDispatch: (flight: ReferenceEmbeddingBudgetFlight, mark: () => ReferenceEmbeddingDispatchRecord) =>
        budget.repository.beforeDispatch(flight, mark),
      settle: (flight: ReferenceEmbeddingBudgetFlight, mark: ReferenceEmbeddingDispatchRecord, settle: () => void) =>
        budget.repository.settle(flight, mark, settle),
      finish: (flight: ReferenceEmbeddingBudgetFlight) => flight.finish(),
    }) } : {}),
    assertCurrent(resources: ReferenceImportResources, runId: string): void {
      transaction(() => { assertResources(resources, runId); assertGrant() })
    },
    withTransaction<T>(resources: ReferenceImportResources, runId: string, operation: () => T): T {
      return transaction(() => {
        assertResources(resources, runId)
        assertGrant()
        const result = synchronous(operation)
        assertResources(resources, runId)
        assertGrant()
        return result
      }, true)
    },
  })
  issuedAdmissions.add(admission)
  return admission
}

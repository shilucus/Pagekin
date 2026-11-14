import { normalizePayload, type InboundReceipt, type InboundRequest } from '../../../src/shared/inbound-domain-contract'
import type { InboundApiService } from '../../services/inbound-api-service'

// Fictional in-memory history only; no production history injection is exposed.
function state(service: InboundApiService) {
  return service as unknown as {
    taskOwners: Map<string, { projectId: string; callerId: string; grantId: string }>
    idempotencyStore: Map<string, { normalizedHash: string; receipt: InboundReceipt; createdAt: number }>
    pendingIdempotency: Map<string, { normalizedHash: string; promise: Promise<InboundReceipt> }>
  }
}

function key(request: InboundRequest): string {
  return JSON.stringify([request.projectId, request.callerId, request.grantId, request.command, request.idempotencyKey])
}

export function fictionalReceipt(request: InboundRequest, status: 'succeeded' | 'unknown' = 'succeeded'): InboundReceipt {
  return { operationKey: `${request.command}:${request.idempotencyKey}`, idempotencyKey: request.idempotencyKey,
    projectId: request.projectId, grantId: request.grantId, command: request.command,
    payloadHash: normalizePayload(request.payload).hash, status, createdAt: 1, completedAt: 1,
    ...(status === 'succeeded' ? { result: { taskId: request.payload.taskId ?? 'fictional-task', state: 'running' } } : {}) }
}

export function seedFictionalReceipt(service: InboundApiService, request: InboundRequest, status: 'succeeded' | 'unknown' = 'succeeded') {
  const receipt = fictionalReceipt(request, status)
  state(service).idempotencyStore.set(key(request), { normalizedHash: normalizePayload(request.payload).hash, receipt, createdAt: 1 })
  return receipt
}

export function seedFictionalPending(service: InboundApiService, request: InboundRequest, promise: Promise<InboundReceipt>) {
  state(service).pendingIdempotency.set(key(request), { normalizedHash: normalizePayload(request.payload).hash, promise })
}

export function clearFictionalPending(service: InboundApiService, request: InboundRequest) {
  state(service).pendingIdempotency.delete(key(request))
}

export function seedFictionalTask(service: InboundApiService, request: InboundRequest, taskId: string) {
  state(service).taskOwners.set(taskId, { projectId: request.projectId, callerId: request.callerId, grantId: request.grantId })
  service.recordEvent(taskId, { taskId, projectId: request.projectId, type: 'status_changed', data: { status: 'running' } })
  service.recordEvent(taskId, { taskId, projectId: request.projectId, type: 'step_completed', data: { stepIndex: 0, name: 'initialized' } })
}

export function fictionalStateCounts(service: InboundApiService) {
  const snapshot = state(service)
  return { owners: snapshot.taskOwners.size, receipts: snapshot.idempotencyStore.size, pending: snapshot.pendingIdempotency.size }
}

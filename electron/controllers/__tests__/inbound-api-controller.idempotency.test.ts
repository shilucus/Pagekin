import { describe, expect, it } from 'vitest'
import { INBOUND_ERROR_CODES, type InboundReceipt, type InboundRequest } from '../../../src/shared/inbound-domain-contract'
import type { WorkflowDriverAuthority } from '../../services/workflow-driver-authority'
import { InboundApiService } from '../../services/inbound-api-service'
import { InboundApiController } from '../inbound-api-controller'
import { clearFictionalPending, fictionalReceipt, fictionalStateCounts, seedFictionalPending,
  seedFictionalReceipt, seedFictionalTask } from './inbound-api-history-fixture'

const projectId = 'fictional-project'
function fixture(callerId = 'fictional-caller', grantId = 'fictional-grant', service = new InboundApiService()) {
  const controller = new InboundApiController({ service })
  const token = service.issueToken({ callerId, scopes: ['task'], allowedProjectIds: [projectId] })
  const request: InboundRequest = { callerId, token: token.token, projectId, grantId,
    command: 'workflow:start', idempotencyKey: 'fictional-key', payload: { taskId: 'fictional-task' } }
  return { controller, request }
}

describe('inbound fail-closed execution and idempotency', () => {
  it.each(['none', 'raw authority'] as const)('rejects new starts with %s without effects or cached receipt', async mode => {
    const service = mode === 'none' ? new InboundApiService() : new InboundApiService({ workflowDriverAuthority: {} as WorkflowDriverAuthority })
    const { controller, request } = fixture(undefined, undefined, service)
    for (const results of [await Promise.allSettled([controller.handleRequest(request), controller.handleRequest(request)]),
      await Promise.allSettled([controller.handleRequest(request)])]) {
      for (const result of results) {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED, status: 503 })
      }
    }
    expect(service.getEvents('fictional-task')).toEqual([])
    expect(fictionalStateCounts(service)).toEqual({ owners: 0, receipts: 0, pending: 0 })
    const query = await controller.handleRequest({ ...request, command: 'workflow:receipt', idempotencyKey: 'query',
      payload: { targetCommand: 'workflow:start', targetIdempotencyKey: request.idempotencyKey } })
    expect(query).toMatchObject({ status: 'failed', error: { code: 'RECEIPT_NOT_FOUND' } })
  })

  it('joins equivalent pending requests and rejects mismatched payload before a pending result', async () => {
    const { controller, request } = fixture()
    const receipt = fictionalReceipt(request)
    let resolve!: (value: InboundReceipt) => void
    const pending = new Promise<InboundReceipt>(done => { resolve = done })
    seedFictionalPending(controller.service, request, pending)
    const first = controller.handleRequest(request)
    const second = controller.handleRequest({ ...request, payload: { ...request.payload } })
    await expect(controller.handleRequest({ ...request, payload: { ...request.payload, different: true } }))
      .rejects.toMatchObject({ code: INBOUND_ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH, status: 409 })
    resolve(receipt)
    expect(await Promise.all([first, second])).toEqual([receipt, receipt])
    clearFictionalPending(controller.service, request)
    expect(controller.service.getEvents('fictional-task')).toEqual([])
  })

  it.each(['succeeded', 'unknown'] as const)('preserves historical %s replay and new-key collision', async status => {
    const { controller, request } = fixture()
    seedFictionalTask(controller.service, request, 'fictional-task')
    const receipt = seedFictionalReceipt(controller.service, request, status)
    if (status === 'succeeded') expect(await controller.handleRequest(request)).toEqual(receipt)
    else await expect(controller.handleRequest(request)).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.UNKNOWN_STATUS_NON_RETRYABLE, status: 409 })
    const collision = { ...request, idempotencyKey: 'different-key' }
    const results = await Promise.allSettled([controller.handleRequest(collision), controller.handleRequest({ ...collision, idempotencyKey: 'third-key' })])
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED, status: 409 })
    }
    expect(controller.service.getEvents('fictional-task')).toHaveLength(2)
  })

  it('keeps colon-bearing identity tuples separate for pending and historical receipts', async () => {
    const { controller } = fixture('c:g', 'x')
    const leftToken = controller.service.issueToken({ callerId: 'c:g', scopes: ['task'], allowedProjectIds: [projectId] })
    const rightToken = controller.service.issueToken({ callerId: 'c', scopes: ['task'], allowedProjectIds: [projectId] })
    const left: InboundRequest = { callerId: 'c:g', token: leftToken.token, projectId, grantId: 'x',
      command: 'workflow:start', idempotencyKey: 'key', payload: { taskId: 'left' } }
    const right: InboundRequest = { ...left, callerId: 'c', token: rightToken.token, grantId: 'g:x', payload: { taskId: 'right' } }
    const a = fictionalReceipt(left)
    const b = fictionalReceipt(right)
    seedFictionalPending(controller.service, left, Promise.resolve(a))
    seedFictionalPending(controller.service, right, Promise.resolve(b))
    expect(await Promise.all([controller.handleRequest(left), controller.handleRequest(right)])).toEqual([a, b])
    clearFictionalPending(controller.service, left)
    clearFictionalPending(controller.service, right)
    seedFictionalReceipt(controller.service, left)
    seedFictionalReceipt(controller.service, right)
    const query = (base: InboundRequest): InboundRequest => ({ ...base, command: 'workflow:receipt',
      idempotencyKey: 'receipt-query', payload: { targetCommand: 'workflow:start', targetIdempotencyKey: 'key' } })
    const [l, r] = await Promise.all([controller.handleRequest(query(left)), controller.handleRequest(query(right))])
    expect(l.result?.receipt).toEqual(a)
    expect(r.result?.receipt).toEqual(b)
  })

  it('authenticates before serving pending or completed history', async () => {
    const { controller, request } = fixture()
    const forbidden = controller.service.issueToken({ callerId: request.callerId, scopes: ['task'], allowedProjectIds: ['other-project'] })
    const revoked = controller.service.issueToken({ callerId: request.callerId, scopes: ['task'], allowedProjectIds: [projectId] })
    controller.service.revokeToken(revoked.token)
    const receipt = fictionalReceipt(request)
    seedFictionalPending(controller.service, request, Promise.resolve(receipt))
    for (const phase of ['pending', 'completed']) {
      if (phase === 'completed') { clearFictionalPending(controller.service, request); seedFictionalReceipt(controller.service, request) }
      expect(await controller.handleRequest(request)).toEqual(receipt)
      await expect(controller.handleRequest({ ...request, token: revoked.token })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN })
      await expect(controller.handleRequest({ ...request, token: forbidden.token })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID })
    }
  })

  it('does not let a task token reuse a pending or completed human approval receipt', async () => {
    const { controller, request } = fixture()
    const reviewer = controller.service.issueToken({ callerId: request.callerId, scopes: ['human_review'], allowedProjectIds: [projectId] })
    controller.service.setTrustedReviewChannelReady(true)
    controller.service.addReviewItem({ reviewId: 'fictional-review', taskId: 'fictional-task', projectId, proposal: {} })
    const approval: InboundRequest = { ...request, token: reviewer.token, command: 'human-review:approve', payload: { reviewId: 'fictional-review' } }
    const receipt = fictionalReceipt(approval)
    seedFictionalPending(controller.service, approval, Promise.resolve(receipt))
    expect(await controller.handleRequest(approval)).toEqual(receipt)
    await expect(controller.handleRequest({ ...approval, token: request.token })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED })
    clearFictionalPending(controller.service, approval)
    seedFictionalReceipt(controller.service, approval)
    await expect(controller.handleRequest({ ...approval, token: request.token })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED })
  })

  it.each(['none', 'raw authority'] as const)('rejects missing task before closed executor and owned resume with %s without appending', async mode => {
    const service = mode === 'none' ? new InboundApiService() : new InboundApiService({ workflowDriverAuthority: {} as WorkflowDriverAuthority })
    const { controller, request } = fixture(undefined, undefined, service)
    const invalid: InboundRequest = { ...request, command: 'workflow:resume', payload: {} }
    await expect(controller.handleRequest(invalid)).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED, status: 400 })
    seedFictionalTask(controller.service, request, 'fictional-task')
    const valid = { ...invalid, payload: { taskId: 'fictional-task' } }
    for (const result of await Promise.allSettled([controller.handleRequest(valid), controller.handleRequest(valid)])) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED, status: 503 })
    }
    expect(controller.service.getEvents('fictional-task')).toHaveLength(2)
    expect(fictionalStateCounts(controller.service)).toEqual({ owners: 1, receipts: 0, pending: 0 })
  })

  it('keeps orphaned task event history inaccessible before checking executor availability', async () => {
    const { controller, request } = fixture()
    controller.service.recordEvent('fictional-task', { taskId: 'fictional-task', projectId, type: 'log', data: {} })
    await expect(controller.handleRequest(request)).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID, status: 403 })
    expect(controller.service.getEvents('fictional-task')).toHaveLength(1)
    expect(fictionalStateCounts(controller.service)).toEqual({ owners: 0, receipts: 0, pending: 0 })
  })
})

import { describe, expect, it } from 'vitest'
import { INBOUND_ERROR_CODES, type InboundRequest } from '../../../src/shared/inbound-domain-contract'
import { InboundApiController } from '../inbound-api-controller'

const projectId = 'fictional-project'

function fixture(callerId = 'fictional-caller', grantId = 'fictional-grant') {
  const controller = new InboundApiController()
  const token = controller.service.issueToken({ callerId, scopes: ['task'], allowedProjectIds: [projectId] })
  const request: InboundRequest = { callerId, token: token.token, projectId, grantId,
    command: 'workflow:start', idempotencyKey: 'fictional-key', payload: {} }
  return { controller, request }
}

describe('in-process inbound idempotency at the controller boundary', () => {
  it.each(['fixed', 'automatic'] as const)('joins overlapping equivalent starts with %s task identity', async (mode) => {
    const { controller, request } = fixture()
    const task = mode === 'fixed' ? { taskId: 'fictional-task' } : {}
    const first = { ...request, payload: { ...task, outer: { alpha: 1, beta: 2 }, suffix: 'value' } }
    const reordered = { ...request, payload: { suffix: 'value', outer: { beta: 2, alpha: 1 }, ...task } }
    const [a, b] = await Promise.all([controller.handleRequest(first), controller.handleRequest(reordered)])
    expect(a).toEqual(b)
    expect(a.status).toBe('succeeded')
    const taskId = a.result?.taskId as string
    expect(taskId).toBeTruthy()
    if (mode === 'fixed') expect(taskId).toBe('fictional-task')
    expect(controller.service.getEvents(taskId).map(event => event.type)).toEqual(['status_changed', 'step_completed'])
    expect(await controller.handleRequest(first)).toEqual(a)
    expect(controller.service.getEvents(taskId)).toHaveLength(2)
  })

  it('rejects a different payload while the first attempt is still pending', async () => {
    const { controller, request } = fixture()
    const first = { ...request, payload: { taskId: 'fictional-task', version: 1 } }
    const different = { ...request, payload: { taskId: 'fictional-task', version: 2 } }
    const original = controller.handleRequest(first)
    const conflict = controller.handleRequest(different)
    const [a, b] = await Promise.allSettled([original, conflict])
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('rejected')
    if (b.status === 'rejected') expect(b.reason).toMatchObject({ code: INBOUND_ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH })
    expect(controller.service.getEvents('fictional-task')).toHaveLength(2)
    await expect(controller.handleRequest(different)).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH })
  })

  it('shares an overlapping unknown attempt but rejects a later retry without another effect', async () => {
    const { controller, request } = fixture()
    const unknown = { ...request, payload: { taskId: 'fictional-task', simulateTerminalStatus: 'unknown' } }
    const [a, b] = await Promise.all([controller.handleRequest(unknown), controller.handleRequest(unknown)])
    expect(a.status).toBe('unknown')
    expect(b).toEqual(a)
    expect(controller.service.getEvents('fictional-task')).toHaveLength(2)
    await expect(controller.handleRequest(unknown)).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.UNKNOWN_STATUS_NON_RETRYABLE })
    expect(controller.service.getEvents('fictional-task')).toHaveLength(2)
  })

  it.each(['pending', 'completed'] as const)('keeps colon-bearing identity tuples separate when %s and queries each receipt', async (phase) => {
    const { controller } = fixture('c:g', 'x')
    const leftToken = controller.service.issueToken({ callerId: 'c:g', scopes: ['task'], allowedProjectIds: [projectId] })
    const rightToken = controller.service.issueToken({ callerId: 'c', scopes: ['task'], allowedProjectIds: [projectId] })
    const left: InboundRequest = { callerId: 'c:g', token: leftToken.token, projectId, grantId: 'x',
      command: 'workflow:start', idempotencyKey: 'key', payload: {} }
    const right: InboundRequest = { ...left, callerId: 'c', token: rightToken.token, grantId: 'g:x' }
    const pending = controller.handleRequest(left)
    const [a, b] = phase === 'pending'
      ? await Promise.all([pending, controller.handleRequest(right)])
      : [await pending, await controller.handleRequest(right)] as const
    expect(a.grantId).toBe('x')
    expect(b.grantId).toBe('g:x')
    expect(a.result?.taskId).not.toBe(b.result?.taskId)
    expect(controller.service.getEvents(a.result?.taskId as string)).toHaveLength(2)
    expect(controller.service.getEvents(b.result?.taskId as string)).toHaveLength(2)
    expect(await controller.handleRequest(left)).toEqual(a)
    expect(await controller.handleRequest(right)).toEqual(b)
    const query = (base: InboundRequest): InboundRequest => ({ ...base, command: 'workflow:receipt',
      idempotencyKey: 'receipt-query', payload: { targetCommand: 'workflow:start', targetIdempotencyKey: 'key' } })
    const [leftQuery, rightQuery] = await Promise.all([controller.handleRequest(query(left)), controller.handleRequest(query(right))])
    expect(leftQuery.result?.receipt).toEqual(a)
    expect(rightQuery.result?.receipt).toEqual(b)
  })

  it('authenticates every overlapping and completed reuse before returning a receipt', async () => {
    const { controller, request } = fixture()
    const revoked = controller.service.issueToken({ callerId: request.callerId, scopes: ['task'], allowedProjectIds: [projectId] })
    const forbidden = controller.service.issueToken({ callerId: request.callerId, scopes: ['task'], allowedProjectIds: ['other-project'] })
    const original = controller.handleRequest({ ...request, payload: { taskId: 'fictional-task' } })
    controller.service.revokeToken(revoked.token)
    const badToken = controller.handleRequest({ ...request, token: revoked.token, payload: { taskId: 'fictional-task' } })
    const badProject = controller.handleRequest({ ...request, token: forbidden.token, payload: { taskId: 'fictional-task' } })
    const [a, b, c] = await Promise.allSettled([original, badToken, badProject])
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('rejected')
    if (b.status === 'rejected') expect(b.reason).toMatchObject({ code: INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN })
    expect(c.status).toBe('rejected')
    if (c.status === 'rejected') expect(c.reason).toMatchObject({ code: INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID })
    controller.service.revokeToken(request.token)
    await expect(controller.handleRequest({ ...request, payload: { taskId: 'fictional-task' } })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN })
    await expect(controller.handleRequest({ ...request, token: forbidden.token, payload: { taskId: 'fictional-task' } })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID })
    expect(controller.service.getEvents('fictional-task')).toHaveLength(2)
  })

  it('does not let a task token reuse a pending or completed human approval receipt', async () => {
    const { controller, request } = fixture()
    const reviewer = controller.service.issueToken({ callerId: request.callerId, scopes: ['human_review'], allowedProjectIds: [projectId] })
    controller.service.setTrustedReviewChannelReady(true)
    controller.service.addReviewItem({ reviewId: 'fictional-review', taskId: 'fictional-task', projectId, proposal: {} })
    const approval: InboundRequest = { ...request, token: reviewer.token, command: 'human-review:approve', payload: { reviewId: 'fictional-review' } }
    const pending = controller.handleRequest(approval)
    const forbidden = controller.handleRequest({ ...approval, token: request.token })
    const [a, b] = await Promise.allSettled([pending, forbidden])
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('rejected')
    if (b.status === 'rejected') expect(b.reason).toMatchObject({ code: INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED })
    await expect(controller.handleRequest({ ...approval, token: request.token })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED })
  })

  it('propagates a known dispatch error to overlapping callers without hanging or an automatic effect', async () => {
    const { controller, request } = fixture()
    const invalid: InboundRequest = { ...request, command: 'workflow:resume', payload: {} }
    const results = await Promise.allSettled([controller.handleRequest(invalid), controller.handleRequest(invalid)])
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED })
    }
    expect(controller.service.getEvents('fictional-task')).toEqual([])
    const valid = { ...invalid, payload: { taskId: 'fictional-task' } }
    const receipt = await controller.handleRequest(valid)
    expect(receipt.status).toBe('succeeded')
    expect(receipt.result).toMatchObject({ taskId: 'fictional-task', state: 'resumed' })
    expect(controller.service.getEvents('fictional-task')).toMatchObject([
      { type: 'status_changed', data: { status: 'resumed' } },
    ])
    expect(await controller.handleRequest(valid)).toEqual(receipt)
    expect(controller.service.getEvents('fictional-task')).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import { INBOUND_ERROR_CODES, type InboundRequest } from '../../../src/shared/inbound-domain-contract'
import { InboundApiController } from '../inbound-api-controller'
import { clearFictionalPending, fictionalReceipt, fictionalStateCounts, seedFictionalPending, seedFictionalReceipt, seedFictionalTask } from './inbound-api-history-fixture'

function fixture() {
  const controller = new InboundApiController()
  const callerId = 'fictional-reviewer'
  const token = controller.service.issueToken({ callerId, scopes: ['human_review'],
    allowedProjectIds: ['fictional-project-a', 'fictional-project-b'] })
  controller.service.setTrustedReviewChannelReady(true)
  for (const suffix of ['a', 'b']) {
    controller.service.addReviewItem({ reviewId: `fictional-review-${suffix}`,
      taskId: `fictional-task-${suffix}`, projectId: `fictional-project-${suffix}`, proposal: {} })
  }
  const request: InboundRequest = { callerId, token: token.token, projectId: 'fictional-project-a',
    grantId: 'fictional-grant-a', command: 'human-review:approve', idempotencyKey: 'fictional-approval',
    payload: { reviewId: 'fictional-review-a' } }
  let query = 0
  const reviews = async (projectId: string) => (await controller.handleRequest({ ...request, projectId,
    command: 'human-review:list', idempotencyKey: `fictional-list-${++query}`, payload: {} })).result?.reviews
  return { controller, request, reviews }
}

describe('inbound approval without a trusted single-use capability', () => {
  it.each(['project:get', 'project:list', 'workflow:start', 'workflow:resume', 'workflow:get', 'workflow:events', 'workflow:receipt'] as const)(
    'requires task scope before dispatching or replaying %s', async command => {
      const { controller, request } = fixture()
      const task = controller.service.issueToken({ callerId: request.callerId, scopes: ['task'], allowedProjectIds: [request.projectId] })
      const empty = controller.service.issueToken({ callerId: request.callerId, scopes: [], allowedProjectIds: [request.projectId] })
      const action: InboundRequest = { ...request, token: task.token, command, idempotencyKey: `scope-${command}`,
        payload: { taskId: 'fictional-task-a', targetIdempotencyKey: 'fictional-start' } }
      seedFictionalTask(controller.service, action, 'fictional-task-a')
      const before = fictionalStateCounts(controller.service)
      for (const token of [request.token, empty.token]) {
        await expect(controller.handleRequest({ ...action, token })).rejects.toMatchObject({
          code: INBOUND_ERROR_CODES.INSUFFICIENT_SCOPE, status: 403,
        })
      }
      expect(fictionalStateCounts(controller.service)).toEqual(before)
      seedFictionalReceipt(controller.service, action)
      for (const token of [request.token, empty.token]) {
        await expect(controller.handleRequest({ ...action, token })).rejects.toMatchObject({
          code: INBOUND_ERROR_CODES.INSUFFICIENT_SCOPE, status: 403,
        })
      }
    },
  )
  it.each(['fictional-review-a', 'fictional-review-b', 'fictional-missing-review'])(
    'rejects %s without mutating local or foreign reviews or caching an approval', async reviewId => {
      const { controller, request, reviews } = fixture()
      const before = await Promise.all(['fictional-project-a', 'fictional-project-b'].map(reviews))
      const counts = fictionalStateCounts(controller.service)
      const attempt = { ...request, payload: { reviewId } }
      for (const requests of [[attempt, attempt], [attempt]]) {
        for (const result of await Promise.allSettled(requests.map(value => controller.handleRequest(value)))) {
          expect(result.status).toBe('rejected')
          if (result.status === 'rejected') expect(result.reason).toMatchObject({
            code: INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED, status: 423,
          })
        }
      }
      expect(fictionalStateCounts(controller.service)).toEqual(counts)
      expect(await Promise.all(['fictional-project-a', 'fictional-project-b'].map(reviews))).toEqual(before)
      const task = controller.service.issueToken({ callerId: request.callerId, scopes: ['task'], allowedProjectIds: [request.projectId] })
      const receipt = await controller.handleRequest({ ...request, token: task.token, command: 'workflow:receipt',
        idempotencyKey: 'fictional-query-approval', payload: {
          targetCommand: 'human-review:approve', targetIdempotencyKey: request.idempotencyKey,
        } })
      expect(receipt).toMatchObject({ status: 'failed', error: { code: 'RECEIPT_NOT_FOUND' } })
    },
  )

  it('authenticates task credentials before an unavailable approval dispatch', async () => {
    const { controller, request } = fixture()
    const token = controller.service.issueToken({ callerId: request.callerId, scopes: ['task'],
      allowedProjectIds: [request.projectId] })
    await expect(controller.handleRequest({ ...request, token: token.token })).rejects.toMatchObject({
      code: INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED, status: 403,
    })
    expect(fictionalStateCounts(controller.service)).toEqual({ owners: 0, receipts: 0, pending: 0 })
  })

  it.each(['task', 'admin'] as const)('preserves %s project access and the unavailable executor', async scope => {
    const { controller, request } = fixture()
    const token = controller.service.issueToken({ callerId: request.callerId, scopes: [scope], allowedProjectIds: [request.projectId] })
    await expect(controller.handleRequest({ ...request, token: token.token, command: 'project:get', payload: {} }))
      .resolves.toMatchObject({ status: 'succeeded' })
    await expect(controller.handleRequest({ ...request, token: token.token, command: 'workflow:start',
      idempotencyKey: 'fictional-start', payload: {} })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED, status: 503 })
  })

  it('checks scope before pending and unknown history while keeping authentication and project checks first', async () => {
    const { controller, request } = fixture()
    const task = controller.service.issueToken({ callerId: request.callerId, scopes: ['task'], allowedProjectIds: [request.projectId] })
    const unauthorizedProject = controller.service.issueToken({ callerId: request.callerId, scopes: [], allowedProjectIds: ['other-project'] })
    const action: InboundRequest = { ...request, token: task.token, command: 'workflow:start', idempotencyKey: 'fictional-history', payload: {} }
    seedFictionalPending(controller.service, action, Promise.resolve(fictionalReceipt(action)))
    await expect(controller.handleRequest({ ...action, token: request.token })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.INSUFFICIENT_SCOPE, status: 403 })
    clearFictionalPending(controller.service, action)
    seedFictionalReceipt(controller.service, action, 'unknown')
    await expect(controller.handleRequest({ ...action, token: request.token })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.INSUFFICIENT_SCOPE, status: 403 })
    await expect(controller.handleRequest({ ...action, token: task.token })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.UNKNOWN_STATUS_NON_RETRYABLE, status: 409 })
    await expect(controller.handleRequest({ ...action, token: unauthorizedProject.token })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID, status: 403 })
    await expect(controller.handleRequest({ ...action, token: 'fictional-invalid' })).rejects.toMatchObject({ code: INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN, status: 401 })
  })

  it.each(['succeeded', 'unknown'] as const)('retains fictional %s historical idempotency decisions without a new approval', async status => {
    const { controller, request, reviews } = fixture()
    const before = await reviews(request.projectId)
    const receipt = seedFictionalReceipt(controller.service, request, status)
    if (status === 'succeeded') expect(await controller.handleRequest(request)).toBe(receipt)
    else await expect(controller.handleRequest(request)).rejects.toMatchObject({
      code: INBOUND_ERROR_CODES.UNKNOWN_STATUS_NON_RETRYABLE, status: 409,
    })
    await expect(controller.handleRequest({ ...request, payload: { reviewId: 'different-review' } }))
      .rejects.toMatchObject({ code: INBOUND_ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH, status: 409 })
    await expect(controller.handleRequest({ ...request, idempotencyKey: 'new-approval-key' }))
      .rejects.toMatchObject({ code: INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED, status: 423 })
    expect(await reviews(request.projectId)).toEqual(before)
  })
})

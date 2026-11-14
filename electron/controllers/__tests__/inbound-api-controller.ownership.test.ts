import { describe, expect, it } from 'vitest'
import { INBOUND_ERROR_CODES, type InboundCommand, type InboundRequest } from '../../../src/shared/inbound-domain-contract'
import { InboundApiController } from '../inbound-api-controller'

describe('inbound task ownership', () => {
  it('isolates task reads and resume across project, caller and grant, including start collisions', async () => {
    const controller = new InboundApiController()
    const token = controller.service.issueToken({ callerId: 'owner', scopes: ['task'], allowedProjectIds: ['book-a', 'book-b'] })
    const otherToken = controller.service.issueToken({ callerId: 'other', scopes: ['task'], allowedProjectIds: ['book-a'] })
    const owner: InboundRequest = { callerId: 'owner', token: token.token, projectId: 'book-a', grantId: 'grant-a',
      command: 'workflow:start', idempotencyKey: 'start', payload: { taskId: 'task-a' } }
    await controller.handleRequest(owner)
    const strangers = [
      { ...owner, projectId: 'book-b' },
      { ...owner, callerId: 'other', token: otherToken.token },
      { ...owner, grantId: 'grant-b' },
    ]
    const commands: InboundCommand[] = ['workflow:get', 'workflow:events', 'workflow:resume', 'workflow:start']
    for (const [index, stranger] of strangers.entries()) {
      for (const command of commands) {
        await expect(controller.handleRequest({ ...stranger, command, idempotencyKey: `${index}-${command}` }))
          .rejects.toMatchObject({ code: INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID, status: 403 })
      }
    }
    expect(controller.service.getEvents('task-a')).toHaveLength(2)

    const read = (command: InboundCommand, idempotencyKey: string, sequenceCursor?: number): InboundRequest =>
      ({ ...owner, command, idempotencyKey, sequenceCursor })
    const initial = await controller.handleRequest(read('workflow:get', 'get'))
    expect(initial.result).toMatchObject({ taskId: 'task-a', eventCount: 2 })
    const cursor = await controller.handleRequest(read('workflow:events', 'events', 1))
    expect(cursor.result?.events).toMatchObject([{ sequenceNumber: 2, type: 'step_completed' }])
    const resumed = await controller.handleRequest(read('workflow:resume', 'resume'))
    expect(resumed.result).toMatchObject({ taskId: 'task-a', state: 'resumed' })
    expect(controller.service.getEvents('task-a')).toHaveLength(3)
  })

  it.each(['workflow:get', 'workflow:events', 'workflow:resume'] as const)(
    'denies an unknown task for %s without creating events', async command => {
      const controller = new InboundApiController()
      const token = controller.service.issueToken({ callerId: 'owner', scopes: ['task'], allowedProjectIds: ['book-a'] })
      const request: InboundRequest = { callerId: 'owner', token: token.token, projectId: 'book-a', grantId: 'grant-a',
        command, idempotencyKey: 'unknown', payload: { taskId: 'missing' } }
      await expect(controller.handleRequest(request)).rejects.toMatchObject({
        code: INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID, status: 403,
      })
      expect(controller.service.getEvents('missing')).toEqual([])
    },
  )
})

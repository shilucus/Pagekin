import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type InboundRequest,
  INBOUND_ERROR_CODES,
  InboundDomainError,
} from '../../../src/shared/inbound-domain-contract'
import { InboundApiController } from '../inbound-api-controller'

describe('inbound-api-controller and service integration', () => {
  let controller: InboundApiController
  let port: number
  let taskToken: string
  let reviewToken: string
  const projectId = 'novel-proj-001'
  const grantId = 'grant-session-001'

  beforeAll(async () => {
    controller = new InboundApiController()
    port = await controller.startServer(0)

    const token1 = controller.service.issueToken({
      callerId: 'test-cli-caller',
      scopes: ['task'],
      allowedProjectIds: [projectId],
    })
    taskToken = token1.token

    const token2 = controller.service.issueToken({
      callerId: 'test-human-reviewer',
      scopes: ['task', 'human_review'],
      allowedProjectIds: [projectId],
    })
    reviewToken = token2.token
  })

  afterAll(async () => {
    await controller.stopServer()
  })

  describe('AC-1: Command Whitelist, Execution & Project Grant Validation', () => {
    it('executes workflow:start successfully for an authorized project', async () => {
      const request: InboundRequest = {
        callerId: 'test-cli-caller',
        token: taskToken,
        projectId,
        grantId,
        command: 'workflow:start',
        idempotencyKey: 'idem-start-1',
        payload: { chapterId: 'ch-1' },
      }

      const receipt = await controller.handleRequest(request)
      expect(receipt.status).toBe('succeeded')
      expect(receipt.command).toBe('workflow:start')
      expect(receipt.result?.taskId).toBeDefined()
    })

    it('rejects commands for unauthorized projects with PROJECT_GRANT_INVALID', async () => {
      const request: InboundRequest = {
        callerId: 'test-cli-caller',
        token: taskToken,
        projectId: 'unauthorized-book-999',
        grantId,
        command: 'workflow:start',
        idempotencyKey: 'idem-unauthorized-1',
        payload: {},
      }

      await expect(controller.handleRequest(request)).rejects.toThrowError(InboundDomainError)
      await expect(controller.handleRequest(request)).rejects.toMatchObject({
        code: INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID,
      })
    })

    it('rejects unknown commands with COMMAND_NOT_ALLOWED', async () => {
      const request = {
        callerId: 'test-cli-caller',
        token: taskToken,
        projectId,
        grantId,
        command: 'dangerous:raw_shell' as unknown as 'workflow:start',
        idempotencyKey: 'idem-danger-1',
        payload: {},
      }

      await expect(controller.handleRequest(request)).rejects.toMatchObject({
        code: INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED,
      })
    })
  })

  describe('AC-2: Idempotency Contract, Duplicate Payload Mismatch & Cursor Event Streaming', () => {
    it('returns the identical cached receipt when retried with exact same payload (packet loss recovery)', async () => {
      const request: InboundRequest = {
        callerId: 'test-cli-caller',
        token: taskToken,
        projectId,
        grantId,
        command: 'workflow:start',
        idempotencyKey: 'idem-packet-loss-check',
        payload: { seed: 100 },
      }

      const receipt1 = await controller.handleRequest(request)
      const receipt2 = await controller.handleRequest(request)

      expect(receipt1).toEqual(receipt2)
      expect(receipt1.idempotencyKey).toBe('idem-packet-loss-check')
    })

    it('rejects with IDEMPOTENCY_KEY_PAYLOAD_MISMATCH when same key is reused with different payload', async () => {
      const req1: InboundRequest = {
        callerId: 'test-cli-caller',
        token: taskToken,
        projectId,
        grantId,
        command: 'workflow:start',
        idempotencyKey: 'idem-conflict-key',
        payload: { param: 'first-attempt' },
      }
      const req2: InboundRequest = {
        ...req1,
        payload: { param: 'second-attempt-with-different-param' },
      }

      await controller.handleRequest(req1)
      await expect(controller.handleRequest(req2)).rejects.toMatchObject({
        code: INBOUND_ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
      })
    })

    it('rejects retrying when previous attempt finished in unknown state', async () => {
      const unknownReq: InboundRequest = {
        callerId: 'test-cli-caller',
        token: taskToken,
        projectId,
        grantId,
        command: 'workflow:start',
        idempotencyKey: 'idem-unknown-state-key',
        payload: { simulateTerminalStatus: 'unknown' },
      }

      const receipt = await controller.handleRequest(unknownReq)
      expect(receipt.status).toBe('unknown')

      // Subsequent retry with same key must be rejected
      await expect(controller.handleRequest(unknownReq)).rejects.toMatchObject({
        code: INBOUND_ERROR_CODES.UNKNOWN_STATUS_NON_RETRYABLE,
      })
    })

    it('supports cursor event streaming via afterSequence', async () => {
      const taskId = 'task-event-cursor-test'
      await controller.handleRequest({ callerId: 'test-cli-caller', token: taskToken, projectId, grantId,
        command: 'workflow:start', idempotencyKey: 'idem-cursor-start', payload: { taskId } })
      controller.service.recordEvent(taskId, {
        taskId,
        projectId,
        type: 'log',
        data: { message: 'msg 1' },
      })
      controller.service.recordEvent(taskId, {
        taskId,
        projectId,
        type: 'log',
        data: { message: 'msg 2' },
      })
      controller.service.recordEvent(taskId, {
        taskId,
        projectId,
        type: 'log',
        data: { message: 'msg 3' },
      })

      const allEventsReq: InboundRequest = {
        callerId: 'test-cli-caller',
        token: taskToken,
        projectId,
        grantId,
        command: 'workflow:events',
        idempotencyKey: 'idem-events-1',
        payload: { taskId },
        sequenceCursor: 2,
      }
      const allRes = await controller.handleRequest(allEventsReq)
      const events = allRes.result?.events as { sequenceNumber: number }[]
      expect(events).toHaveLength(3)
      expect(events.map(e => e.sequenceNumber)).toEqual([3, 4, 5])

      // Query only after sequence 4
      const nextEventsReq: InboundRequest = {
        ...allEventsReq,
        idempotencyKey: 'idem-events-2',
        sequenceCursor: 4,
      }
      const partialRes = await controller.handleRequest(nextEventsReq)
      const partialEvents = partialRes.result?.events as { sequenceNumber: number }[]
      expect(partialEvents).toHaveLength(1)
      expect(partialEvents[0]!.sequenceNumber).toBe(5)
    })
  })

  describe('AC-3: Channel Auth, Human Review Scope Separation & Host/Origin Protection', () => {
    it('prohibits task-scoped credentials from calling human-review:approve (self-approval defense)', async () => {
      controller.service.addReviewItem({
        reviewId: 'review-101',
        taskId: 'task-101',
        projectId,
        proposal: { text: 'Draft replacement' },
      })

      const req: InboundRequest = {
        callerId: 'test-cli-caller',
        token: taskToken, // Only has 'task' scope!
        projectId,
        grantId,
        command: 'human-review:approve',
        idempotencyKey: 'idem-self-approve-attempt',
        payload: { reviewId: 'review-101' },
      }

      await expect(controller.handleRequest(req)).rejects.toMatchObject({
        code: INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED,
      })
    })

    it('blocks human-review:approve if trusted physical channel is not yet opened', async () => {
      controller.service.setTrustedReviewChannelReady(false)

      const req: InboundRequest = {
        callerId: 'test-human-reviewer',
        token: reviewToken, // Has human_review scope
        projectId,
        grantId,
        command: 'human-review:approve',
        idempotencyKey: 'idem-channel-closed-attempt',
        payload: { reviewId: 'review-101' },
      }

      await expect(controller.handleRequest(req)).rejects.toMatchObject({
        code: INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED,
      })
    })

    it('allows human-review:approve when trusted channel is open and scope is present', async () => {
      controller.service.setTrustedReviewChannelReady(true)

      const req: InboundRequest = {
        callerId: 'test-human-reviewer',
        token: reviewToken,
        projectId,
        grantId,
        command: 'human-review:approve',
        idempotencyKey: 'idem-valid-approve',
        payload: { reviewId: 'review-101' },
      }

      const receipt = await controller.handleRequest(req)
      expect(receipt.status).toBe('succeeded')
      expect(receipt.result?.approved).toBe(true)
    })

    it('handles HTTP requests over loopback with Host and Origin validation', async () => {
      const url = `http://127.0.0.1:${port}/api/inbound`

      const payload: InboundRequest = {
        callerId: 'test-cli-caller',
        token: taskToken,
        projectId,
        grantId,
        command: 'project:get',
        idempotencyKey: 'idem-http-1',
        payload: {},
      }

      // Valid loopback request
      const validResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      expect(validResponse.status).toBe(200)
      const data = await validResponse.json()
      expect(data.status).toBe('succeeded')

      // Malicious Host header (DNS rebinding simulation using raw http.request)
      const badHostStatus = await new Promise<{ status: number; body: { error: { code: string } } }>((resolve, reject) => {
        const httpReq = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/inbound',
            headers: {
              'Content-Type': 'application/json',
              Host: 'malicious-attacker.com',
            },
          },
          res => {
            let buf = ''
            res.on('data', c => (buf += c))
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) })
            })
          },
        )
        httpReq.on('error', reject)
        httpReq.write(JSON.stringify(payload))
        httpReq.end()
      })

      expect(badHostStatus.status).toBe(403)
      expect(badHostStatus.body.error.code).toBe(INBOUND_ERROR_CODES.INVALID_HOST_HEADER)

      // Malicious Origin header (CSRF simulation)
      const badOriginResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil-cross-site.com',
        },
        body: JSON.stringify(payload),
      })
      expect(badOriginResponse.status).toBe(403)
      const badOriginData = await badOriginResponse.json()
      expect(badOriginData.error.code).toBe(INBOUND_ERROR_CODES.INVALID_ORIGIN_HEADER)
    })
  })
})

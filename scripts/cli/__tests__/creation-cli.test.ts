import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InboundApiController } from '../../../electron/controllers/inbound-api-controller'
import { seedFictionalReceipt, seedFictionalTask } from '../../../electron/controllers/__tests__/inbound-api-history-fixture'
import type { InboundRequest } from '../../../src/shared/inbound-domain-contract'
import { CLI_EXIT_CODES, CreationCli, maskSecret } from '../creation-cli'

describe('creation-cli', () => {
  let controller: InboundApiController
  let port: number
  let cli: CreationCli
  let taskToken: string
  let reviewToken: string
  const projectId = 'proj-cli-test-01'
  const grantId = 'grant-cli-01'

  function fictionalHistory(taskId: string, idempotencyKey: string, status: 'succeeded' | 'unknown' = 'succeeded') {
    const request: InboundRequest = { callerId: 'pagekin-cli', token: taskToken, projectId, grantId,
      command: 'workflow:start', idempotencyKey, payload: { taskId } }
    seedFictionalTask(controller.service, request, taskId)
    return seedFictionalReceipt(controller.service, request, status)
  }

  beforeAll(async () => {
    controller = new InboundApiController()
    port = await controller.startServer(0)

    const t1 = controller.service.issueToken({
      callerId: 'pagekin-cli',
      scopes: ['task'],
      allowedProjectIds: [projectId],
    })
    taskToken = t1.token

    const t2 = controller.service.issueToken({
      callerId: 'pagekin-cli',
      scopes: ['task', 'human_review'],
      allowedProjectIds: [projectId],
    })
    reviewToken = t2.token

    cli = new CreationCli({
      endpoint: `http://127.0.0.1:${port}`,
      token: taskToken,
      projectId,
      grantId,
      callerId: 'pagekin-cli',
    })
  })

  afterAll(async () => {
    await controller.stopServer()
  })

  describe('maskSecret', () => {
    it('masks tokens properly to avoid leaking into logs or stdout', () => {
      expect(maskSecret('ink_inbound_1234567890abcdef')).toBe('ink_...cdef')
      expect(maskSecret('short')).toBe('********')
      expect(maskSecret('')).toBe('<none>')
      expect(maskSecret(undefined)).toBe('<none>')
    })
  })

  describe('AC-1: run --wait and submit distinctions', () => {
    it('submit propagates executor unavailable without a success receipt', async () => {
      await expect(cli.submit({ chapterId: 'ch-1' }, { idempotencyKey: 'cli-unavailable-submit' }))
        .rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED', status: 503 })
    })

    it('runAndWait returns FAILED when the executor is unavailable', async () => {
      const eventsCaptured: string[] = []
      const res = await cli.runAndWait(
        { chapterId: 'ch-2' },
        {
          pollIntervalMs: 10,
          timeoutMs: 3000,
          onEvent: ev => eventsCaptured.push(ev.type),
        },
      )

      expect(res.exitCode).toBe(CLI_EXIT_CODES.FAILED)
      expect(res.receipt).toBeUndefined()
      expect(res.error).toContain('Workflow execution is unavailable')
      expect(eventsCaptured).toEqual([])
    })

    it('runAndWait reads events and a fictional completed historical receipt', async () => {
      fictionalHistory('task-success-history', 'cli-success-history')
      const eventsCaptured: string[] = []
      const res = await cli.runAndWait({ taskId: 'task-success-history' }, {
        idempotencyKey: 'cli-success-history', pollIntervalMs: 10, timeoutMs: 1000,
        onEvent: ev => eventsCaptured.push(ev.type),
      })
      expect(res.exitCode).toBe(CLI_EXIT_CODES.SUCCESS)
      expect(res.receipt?.status).toBe('succeeded')
      expect(eventsCaptured).toEqual(['status_changed', 'step_completed'])
    })

    it('runAndWait reports pending_review (code 4) when task requires human decision', async () => {
      const customCli = new CreationCli({
        endpoint: `http://127.0.0.1:${port}`,
        token: taskToken,
        projectId,
        grantId,
      })

      const taskId = 'task-review-test-1'
      fictionalHistory(taskId, 'cli-review-history')
      controller.service.recordEvent(taskId, {
        taskId,
        projectId,
        type: 'review_required',
        data: { reason: 'Continuity deviation review required' },
      })

      const res = await customCli.runAndWait(
        { taskId: 'task-review-test-1' },
        {
          idempotencyKey: 'cli-review-history',
          pollIntervalMs: 10,
          timeoutMs: 1000,
        },
      )

      expect(res.exitCode).toBe(CLI_EXIT_CODES.PENDING_REVIEW)
    })

    it('runAndWait reports cancelled (code 2) when task is cancelled via event or receipt', async () => {
      const customCli = new CreationCli({
        endpoint: `http://127.0.0.1:${port}`,
        token: taskToken,
        projectId,
        grantId,
      })

      const taskId = 'task-cancel-test-1'
      fictionalHistory(taskId, 'cli-cancel-history')
      controller.service.recordEvent(taskId, {
        taskId,
        projectId,
        type: 'status_changed',
        data: { status: 'cancelled', reason: 'User requested cancellation' },
      })

      const res = await customCli.runAndWait(
        { taskId: 'task-cancel-test-1' },
        {
          idempotencyKey: 'cli-cancel-history',
          pollIntervalMs: 10,
          timeoutMs: 1000,
        },
      )

      expect(res.exitCode).toBe(CLI_EXIT_CODES.CANCELLED)
    })

    it('reads a fictional unknown receipt and blocks same-key retry without resending', async () => {
      const initial = fictionalHistory('task-unknown-history', 'cli-unknown-history', 'unknown')
      expect(await cli.getReceipt('cli-unknown-history')).toEqual(initial)
      const res = await cli.runAndWait(
        { taskId: 'task-unknown-history' },
        { idempotencyKey: 'cli-unknown-history', pollIntervalMs: 10, timeoutMs: 1000 },
      )

      expect(res.exitCode).toBe(CLI_EXIT_CODES.UNKNOWN)
      expect(res.error).toContain('UNKNOWN_STATUS_NON_RETRYABLE')
      expect(controller.service.getEvents('task-unknown-history')).toHaveLength(2)
    })
  })

  describe('AC-2: Idempotency, Receipt Retrieval & Packet Loss Recovery', () => {
    it('retrieves the same fictional in-memory historical receipt using getReceipt', async () => {
      const initialReceipt = fictionalHistory('task-receipt-history', 'cli-receipt-history')
      const fetchedReceipt = await cli.getReceipt(initialReceipt.idempotencyKey)

      expect(fetchedReceipt.idempotencyKey).toBe(initialReceipt.idempotencyKey)
      expect(fetchedReceipt.payloadHash).toBe(initialReceipt.payloadHash)
    })
  })

  describe('AC-3: approve non-interactive human review consumption', () => {
    it('refuses self-approval when using task token without human_review scope (code 5)', async () => {
      controller.service.addReviewItem({
        reviewId: 'rev-cli-99',
        taskId: 'task-cli-99',
        projectId,
        proposal: { title: 'New chapter outline' },
      })

      // Default CLI has taskToken (scope: ['task'])
      const result = await cli.approve('rev-cli-99')
      expect(result.exitCode).toBe(CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
      expect(result.error).toContain('HUMAN_REVIEW_SCOPE_REQUIRED')
    })

    it('approves successfully when human_review token is provided and channel is open', async () => {
      controller.service.setTrustedReviewChannelReady(true)

      const result = await cli.approve('rev-cli-99', {
        humanReviewToken: reviewToken,
      })

      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS)
      expect(result.receipt?.status).toBe('succeeded')
      expect(result.receipt?.result?.approved).toBe(true)
    })
  })

  describe('executeCli entrypoint and formatting', () => {
    it('reports unavailable for run --wait and masks secrets in JSON output', async () => {
      const res = await cli.executeCli([
        'run',
        '--wait',
        '--chapterId',
        'ch-10',
        '--json',
      ])

      expect(res.exitCode).toBe(CLI_EXIT_CODES.FAILED)
      expect(res.output).toContain('Workflow execution is unavailable')
      // Secret must never appear in raw text
      expect(res.output).not.toContain(taskToken)
    })

    it('executes events subcommand via CLI arguments', async () => {
      const taskId = 'task-events-cli-1'
      fictionalHistory(taskId, 'cli-events-history')

      const res = await cli.executeCli([
        'events',
        '--taskId',
        taskId,
        '--json',
      ])

      expect(res.exitCode).toBe(CLI_EXIT_CODES.SUCCESS)
      expect(res.output).toContain('"events"')
    })

    it('executes approve via CLI and returns code 5 when unpermitted', async () => {
      controller.service.addReviewItem({
        reviewId: 'rev-entrypoint-1',
        taskId: 'task-entrypoint-1',
        projectId,
        proposal: {},
      })

      const res = await cli.executeCli([
        'approve',
        '--reviewId',
        'rev-entrypoint-1',
      ])

      expect(res.exitCode).toBe(CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
      expect(res.output).toContain('HUMAN_REVIEW_SCOPE_REQUIRED')
      expect(res.output).not.toContain(taskToken)
    })
  })
})


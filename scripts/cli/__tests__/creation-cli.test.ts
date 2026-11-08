import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InboundApiController } from '../../../electron/controllers/inbound-api-controller'
import { CLI_EXIT_CODES, CreationCli, maskSecret } from '../creation-cli'

describe('creation-cli', () => {
  let controller: InboundApiController
  let port: number
  let cli: CreationCli
  let taskToken: string
  let reviewToken: string
  const projectId = 'proj-cli-test-01'
  const grantId = 'grant-cli-01'

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
    it('submit returns immediate receipt without waiting', async () => {
      const receipt = await cli.submit({ chapterId: 'ch-1' })
      expect(receipt.status).toBe('succeeded')
      expect(receipt.command).toBe('workflow:start')
      expect(receipt.result?.taskId).toBeDefined()
    })

    it('runAndWait waits for completion and exits with code 0 on success', async () => {
      const eventsCaptured: string[] = []
      const res = await cli.runAndWait(
        { chapterId: 'ch-2' },
        {
          pollIntervalMs: 10,
          timeoutMs: 3000,
          onEvent: ev => eventsCaptured.push(ev.type),
        },
      )

      expect(res.exitCode).toBe(CLI_EXIT_CODES.SUCCESS)
      expect(res.receipt?.status).toBe('succeeded')
      expect(eventsCaptured).toContain('status_changed')
      expect(eventsCaptured).toContain('step_completed')
    })

    it('runAndWait reports pending_review (code 4) when task requires human decision', async () => {
      const customCli = new CreationCli({
        endpoint: `http://127.0.0.1:${port}`,
        token: taskToken,
        projectId,
        grantId,
      })

      // Simulate a task that requires review
      const startReceipt = await customCli.submit({ taskId: 'task-review-test-1' })
      const taskId = startReceipt.result?.taskId as string
      controller.service.recordEvent(taskId, {
        taskId,
        projectId,
        type: 'review_required',
        data: { reason: 'Continuity deviation review required' },
      })

      const res = await customCli.runAndWait(
        { taskId: 'task-review-test-1' },
        {
          idempotencyKey: startReceipt.idempotencyKey,
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

      const startReceipt = await customCli.submit({ taskId: 'task-cancel-test-1' })
      const taskId = startReceipt.result?.taskId as string
      controller.service.recordEvent(taskId, {
        taskId,
        projectId,
        type: 'status_changed',
        data: { status: 'cancelled', reason: 'User requested cancellation' },
      })

      const res = await customCli.runAndWait(
        { taskId: 'task-cancel-test-1' },
        {
          idempotencyKey: startReceipt.idempotencyKey,
          pollIntervalMs: 10,
          timeoutMs: 1000,
        },
      )

      expect(res.exitCode).toBe(CLI_EXIT_CODES.CANCELLED)
    })

    it('runAndWait stops and reports unknown state (code 3) without endless retries', async () => {
      const res = await cli.runAndWait(
        { simulateTerminalStatus: 'unknown' },
        { pollIntervalMs: 10, timeoutMs: 1000 },
      )

      expect(res.exitCode).toBe(CLI_EXIT_CODES.UNKNOWN)
      expect(res.receipt?.status).toBe('unknown')
      expect(res.error).toBeDefined()
    })
  })

  describe('AC-2: Idempotency, Receipt Retrieval & Packet Loss Recovery', () => {
    it('retrieves the same persistent receipt using getReceipt', async () => {
      const initialReceipt = await cli.submit({ chapterNumber: 5 })
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
    it('executes run --wait via CLI arguments and masks secrets in JSON output', async () => {
      const res = await cli.executeCli([
        'run',
        '--wait',
        '--chapterId',
        'ch-10',
        '--json',
      ])

      expect(res.exitCode).toBe(CLI_EXIT_CODES.SUCCESS)
      expect(res.output).toContain('"status": "succeeded"')
      // Secret must never appear in raw text
      expect(res.output).not.toContain(taskToken)
    })

    it('executes events subcommand via CLI arguments', async () => {
      const startRes = await cli.submit({ taskId: 'task-events-cli-1' })
      const taskId = startRes.result?.taskId as string

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


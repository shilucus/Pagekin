import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { InboundApiController } from '../../../electron/controllers/inbound-api-controller'
import { seedFictionalReceipt, seedFictionalTask } from '../../../electron/controllers/__tests__/inbound-api-history-fixture'
import { type InboundRequest, normalizePayload } from '../../../src/shared/inbound-domain-contract'
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

    it('queries live receipt history rather than replaying an earlier not-found response', async () => {
      const key = 'fictional-late-receipt-key'
      await expect(cli.getReceipt(key)).rejects.toThrow('RECEIPT_NOT_FOUND')
      const receipt = fictionalHistory('fictional-late-receipt-task', key)
      expect(await cli.getReceipt(key)).toEqual(receipt)
    })
  })

  describe('live wait polling and error propagation', () => {
    function socketReset() {
      return new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    }

    it('reads a late event after an empty poll without replaying the cached empty response', async () => {
      const taskId = 'fictional-live-event-task', key = 'fictional-live-event-key'
      fictionalHistory(taskId, key)
      const requests: InboundRequest[] = []
      let receiptQueries = 0
      const liveCli = new CreationCli({ endpoint: `http://127.0.0.1:${port}`, token: taskToken,
        projectId, grantId, fetchFn: async (input, init) => {
          const request = JSON.parse(String(init?.body)) as InboundRequest
          requests.push(request)
          if (request.command === 'workflow:receipt') {
            receiptQueries++
            if (receiptQueries === 2) controller.service.recordEvent(taskId, {
              taskId, projectId, type: 'review_required', data: { reason: 'Fictional late review' },
            })
            throw socketReset()
          }
          return fetch(input, init)
        } })
      const result = await liveCli.runAndWait({ taskId }, { idempotencyKey: key, pollIntervalMs: 1, timeoutMs: 500 })
      expect(result.exitCode).toBe(CLI_EXIT_CODES.PENDING_REVIEW)
      expect(result.events?.map(event => event.type)).toEqual(['status_changed', 'step_completed', 'review_required'])
      const polls = requests.filter(request => request.command === 'workflow:events')
      expect(polls.map(request => request.sequenceCursor)).toEqual([0, 2, 2])
      expect(new Set(polls.map(request => request.idempotencyKey)).size).toBe(polls.length)
      expect(requests.filter(request => request.command === 'workflow:start')).toHaveLength(1)
    })

    it('waits through a confirmed socket reset and returns the actual queried terminal receipt', async () => {
      const taskId = 'fictional-live-success-task', key = 'fictional-live-success-key'
      const terminal = fictionalHistory(taskId, key)
      const requests: InboundRequest[] = []
      let receiptQueries = 0
      const liveCli = new CreationCli({ endpoint: `http://127.0.0.1:${port}`, token: taskToken,
        projectId, grantId, fetchFn: async (input, init) => {
          const request = JSON.parse(String(init?.body)) as InboundRequest
          requests.push(request)
          if (request.command === 'workflow:receipt' && ++receiptQueries === 1) throw socketReset()
          return fetch(input, init)
        } })
      const result = await liveCli.runAndWait({ taskId }, { idempotencyKey: key, pollIntervalMs: 1, timeoutMs: 500 })
      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS)
      expect(result.receipt).toEqual(terminal)
      expect(receiptQueries).toBe(2)
      expect(requests.filter(request => request.command === 'workflow:start')).toHaveLength(1)
    })

    it.each(['workflow:start', 'workflow:events', 'workflow:receipt', 'nested-start'] as const)(
      'rejects a complete receipt envelope with the wrong payload hash at %s without restarting', async phase => {
        const taskId = `fictional-wrong-hash-${phase}`, key = `fictional-wrong-hash-key-${phase}`
        fictionalHistory(taskId, key)
        const requests: InboundRequest[] = []
        const liveCli = new CreationCli({ endpoint: `http://127.0.0.1:${port}`, token: taskToken,
          projectId, grantId, fetchFn: async (input, init) => {
            const request = JSON.parse(String(init?.body)) as InboundRequest
            requests.push(request)
            const response = await fetch(input, init)
            if (request.command !== (phase === 'nested-start' ? 'workflow:receipt' : phase)) return response
            const body = await response.json()
            if (phase === 'nested-start') body.result.receipt.payloadHash = '0'.repeat(64)
            else body.payloadHash = '0'.repeat(64)
            return new Response(JSON.stringify(body), { status: response.status })
          } })
        const result = await liveCli.runAndWait({ taskId }, { idempotencyKey: key, pollIntervalMs: 1, timeoutMs: 100 })
        expect(result.exitCode).toBe(CLI_EXIT_CODES.FAILED)
        expect(result.error).toBe('Invalid inbound receipt response from server')
        expect(requests.filter(request => request.command === 'workflow:start')).toHaveLength(1)
        const rejectedCommand = phase === 'nested-start' ? 'workflow:receipt' : phase
        expect(requests.filter(request => request.command === rejectedCommand)).toHaveLength(1)
      },
    )

    it('rejects an initial unknown receipt with a wrong payload hash without polling or resending', async () => {
      const taskId = 'fictional-unknown-wrong-hash', key = 'fictional-unknown-wrong-hash-key'
      const unknown = fictionalHistory(taskId, key, 'unknown')
      const requests: InboundRequest[] = []
      const liveCli = new CreationCli({ endpoint: `http://127.0.0.1:${port}`, token: taskToken,
        projectId, grantId, fetchFn: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)) as InboundRequest)
          return new Response(JSON.stringify({ ...unknown, payloadHash: '0'.repeat(64) }), { status: 200 })
        } })
      const result = await liveCli.runAndWait({ taskId }, { idempotencyKey: key, pollIntervalMs: 1, timeoutMs: 100 })
      expect(result.exitCode).toBe(CLI_EXIT_CODES.FAILED)
      expect(result.error).toBe('Invalid inbound receipt response from server')
      expect(requests.map(request => request.command)).toEqual(['workflow:start'])
    })

    it.each(['workflow:events', 'workflow:receipt'] as const)(
      'propagates authentication, permission and protocol errors immediately from %s', async phase => {
        const failures = [
          { status: 401, code: 'UNAUTHORIZED_TOKEN', exit: CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR },
          { status: 403, code: 'PROJECT_GRANT_INVALID', exit: CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR },
          { status: 400, code: 'COMMAND_NOT_ALLOWED', exit: CLI_EXIT_CODES.FAILED },
          { status: 409, code: 'UNKNOWN_STATUS_NON_RETRYABLE', exit: CLI_EXIT_CODES.UNKNOWN },
          { status: 200, code: 'invalid-json', exit: CLI_EXIT_CODES.FAILED },
          { status: 200, code: 'invalid-contract', exit: CLI_EXIT_CODES.FAILED },
          { status: 200, code: 'missing-result', exit: CLI_EXIT_CODES.FAILED },
        ]
        for (const failure of failures) {
          const taskId = `fictional-error-${phase}-${failure.code}`, key = `fictional-key-${taskId}`
          fictionalHistory(taskId, key)
          const requests: InboundRequest[] = []
          const liveCli = new CreationCli({ endpoint: `http://127.0.0.1:${port}`, token: taskToken,
            projectId, grantId, fetchFn: async (input, init) => {
              const request = JSON.parse(String(init?.body)) as InboundRequest
              requests.push(request)
              if (request.command === phase && failure.code === 'missing-result') {
                const response = await fetch(input, init)
                return new Response(JSON.stringify({ ...await response.json(), result: {} }), { status: 200 })
              }
              if (request.command === phase) return new Response(failure.code === 'invalid-json' ? 'not-json'
                : failure.code === 'invalid-contract' ? '{}'
                  : JSON.stringify({ error: { code: failure.code, message: 'Fictional query rejection' } }), { status: failure.status })
              return fetch(input, init)
            } })
          const result = await liveCli.runAndWait({ taskId }, { idempotencyKey: key, pollIntervalMs: 1, timeoutMs: 100 })
          expect(result.exitCode, failure.code).toBe(failure.exit)
          expect(result.error, failure.code).not.toContain('timed out')
          expect(requests.filter(request => request.command === phase), failure.code).toHaveLength(1)
          expect(requests.filter(request => request.command === 'workflow:start'), failure.code).toHaveLength(1)
        }
      },
    )

    it('does not treat an unclassified polling exception as a retryable transport failure', async () => {
      const taskId = 'fictional-unclassified-task', key = 'fictional-unclassified-key'
      fictionalHistory(taskId, key)
      let eventQueries = 0
      const liveCli = new CreationCli({ endpoint: `http://127.0.0.1:${port}`, token: taskToken,
        projectId, grantId, fetchFn: async (input, init) => {
          const request = JSON.parse(String(init?.body)) as InboundRequest
          if (request.command === 'workflow:events') { eventQueries++; throw new TypeError('Fictional protocol failure') }
          return fetch(input, init)
        } })
      const result = await liveCli.runAndWait({ taskId }, { idempotencyKey: key, pollIntervalMs: 1, timeoutMs: 100 })
      expect(result.exitCode).toBe(CLI_EXIT_CODES.FAILED)
      expect(result.error).toBe('Fictional protocol failure')
      expect(eventQueries).toBe(1)
    })

    it('returns an initial unknown response without another start or polling request', async () => {
      const taskId = 'fictional-initial-unknown-task', key = 'fictional-initial-unknown-key'
      const unknown = fictionalHistory(taskId, key, 'unknown')
      const requests: InboundRequest[] = []
      const liveCli = new CreationCli({ endpoint: `http://127.0.0.1:${port}`, token: taskToken,
        projectId, grantId, fetchFn: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)) as InboundRequest)
          return new Response(JSON.stringify(unknown), { status: 200 })
        } })
      const result = await liveCli.runAndWait({ taskId }, { idempotencyKey: key, pollIntervalMs: 1, timeoutMs: 100 })
      expect(result.exitCode).toBe(CLI_EXIT_CODES.UNKNOWN)
      expect(requests.map(request => request.command)).toEqual(['workflow:start'])
    })

    it.each([
      ['failed', CLI_EXIT_CODES.FAILED, false], ['failed', CLI_EXIT_CODES.FAILED, true],
      ['cancelled', CLI_EXIT_CODES.CANCELLED, false], ['cancelled', CLI_EXIT_CODES.CANCELLED, true],
      ['pending_review', CLI_EXIT_CODES.PENDING_REVIEW, false], ['pending_review', CLI_EXIT_CODES.PENDING_REVIEW, true],
      ['unknown', CLI_EXIT_CODES.UNKNOWN, false], ['unknown', CLI_EXIT_CODES.UNKNOWN, true],
    ] as const)('maps initial %s to exit %s with taskId=%s without polling or another start', async (status, expected, hasTaskId) => {
      const payload = { chapterId: 'fictional-initial-terminal-chapter' }
      const key = `fictional-initial-${status}-${hasTaskId}`
      const initialReceipt = { operationKey: 'fictional-initial-operation', idempotencyKey: key,
        projectId, grantId, command: 'workflow:start', payloadHash: normalizePayload(payload).hash,
        status, createdAt: 1, error: { code: 'FICTIONAL_INITIAL_STATE', message: `Fictional initial ${status}` },
        ...(hasTaskId ? { result: { taskId: 'fictional-initial-terminal-task' } } : {}) }
      const requests: InboundRequest[] = []
      const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token: 'fictional-initial-token',
        projectId, grantId, fetchFn: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)) as InboundRequest)
          return new Response(JSON.stringify(initialReceipt), { status: 200 })
        } })
      const result = await isolatedCli.runAndWait(payload, { idempotencyKey: key, pollIntervalMs: 1, timeoutMs: 100 })
      expect(result.exitCode).toBe(expected)
      expect(result.receipt).toEqual(initialReceipt)
      expect(result.error).toBe(status === 'unknown' ? 'Initial submission ended in non-retryable unknown state'
        : initialReceipt.error.message)
      expect(requests.map(request => [request.command, request.idempotencyKey])).toEqual([['workflow:start', key]])
    })

    it.each([
      ['cancelled', CLI_EXIT_CODES.CANCELLED], ['pending_review', CLI_EXIT_CODES.PENDING_REVIEW],
    ] as const)('preserves an initial %s result through the run --wait dispatcher', async (status, expected) => {
      const requests: InboundRequest[] = []
      const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token: 'fictional-initial-dispatch-token',
        projectId, grantId, fetchFn: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as InboundRequest
          requests.push(request)
          return new Response(JSON.stringify({ operationKey: 'fictional-initial-dispatch-operation',
            idempotencyKey: request.idempotencyKey, projectId, grantId, command: request.command,
            payloadHash: normalizePayload(request.payload).hash, status, createdAt: 1 }), { status: 200 })
        } })
      const result = await isolatedCli.executeCli(['run', '--wait', '--chapterId', 'fictional-dispatch-chapter',
        '--idempotencyKey', 'fictional-initial-dispatch-key'])
      expect(result.exitCode).toBe(expected)
      expect(JSON.parse(result.output).receipt.status).toBe(status)
      expect(requests.map(request => request.command)).toEqual(['workflow:start'])
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

    it('reports unavailable rather than a false approval when scope and channel are present', async () => {
      controller.service.setTrustedReviewChannelReady(true)

      const result = await cli.approve('rev-cli-99', {
        humanReviewToken: reviewToken,
      })

      expect(result.exitCode).toBe(CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
      expect(result.receipt).toBeUndefined()
      expect(result.error).toContain('HUMAN_REVIEW_SCOPE_REQUIRED')
    })
  })

  describe('executeCli entrypoint and formatting', () => {
    it.each(['submit', 'run', 'receipt', 'resume', 'approve'] as const)(
      'maps known terminal historical receipt statuses to the existing exit codes for %s', async command => {
        for (const [status, expected] of [
          ['succeeded', CLI_EXIT_CODES.SUCCESS], ['failed', CLI_EXIT_CODES.FAILED],
          ['cancelled', CLI_EXIT_CODES.CANCELLED], ['unknown', CLI_EXIT_CODES.UNKNOWN],
          ['pending_review', CLI_EXIT_CODES.PENDING_REVIEW],
        ] as const) {
          const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token: 'fictional-history-token',
            projectId, grantId, fetchFn: async (_input, init) => {
              const request = JSON.parse(String(init?.body)) as InboundRequest
              const receipt = { operationKey: 'fictional-operation', idempotencyKey: request.idempotencyKey,
                projectId, grantId, command: request.command, payloadHash: normalizePayload(request.payload).hash,
                status, createdAt: 1 }
              const response = request.command === 'workflow:receipt'
                ? { ...receipt, status: 'succeeded', result: { receipt: { ...receipt, command: 'workflow:start',
                  idempotencyKey: request.payload.targetIdempotencyKey,
                  payloadHash: normalizePayload({ taskId: 'fictional-terminal-task' }).hash } } }
                : receipt
              return new Response(JSON.stringify(response), { status: 200 })
            } })
          const argv = command === 'receipt' ? ['receipt', 'fictional-terminal-key']
            : command === 'resume' ? ['resume', 'fictional-terminal-task']
              : command === 'approve' ? ['approve', '--reviewId', 'fictional-terminal-review']
              : [command, '--taskId', 'fictional-terminal-task', '--idempotencyKey', 'fictional-terminal-key']
          const result = await isolatedCli.executeCli(argv)
          expect(result.exitCode, status).toBe(expected)
          expect(JSON.parse(result.output).receipt.status).toBe(status)
        }
      },
    )

    it('does not return a missing-target query failure as a target receipt', async () => {
      await expect(cli.getReceipt('fictional-absent-target-key')).rejects.toThrow('RECEIPT_NOT_FOUND')
    })

    it.each([
      ['missing-result', undefined], ['missing-array', {}], ['null-array', { events: null }],
      ['non-array', { events: {} }],
    ])('rejects a fictional events response with %s instead of reporting an empty success', async (_name, result) => {
      const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token: 'fictional-events-token',
        projectId, grantId, fetchFn: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as InboundRequest
          return new Response(JSON.stringify({ operationKey: 'fictional-events-operation', idempotencyKey: request.idempotencyKey,
            projectId, grantId, command: request.command, payloadHash: normalizePayload(request.payload).hash,
            status: 'succeeded', createdAt: 1, result }), { status: 200 })
        } })
      const response = await isolatedCli.executeCli(['events', '--taskId', 'fictional-events-task'])
      expect(response.exitCode).toBe(CLI_EXIT_CODES.FAILED)
      expect(JSON.parse(response.output).error).toBe('Invalid workflow events response from server')
      expect(JSON.parse(response.output).events).toBeUndefined()
    })

    it('retains success for a valid fictional events response with an explicitly empty array', async () => {
      const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token: 'fictional-events-token',
        projectId, grantId, fetchFn: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as InboundRequest
          return new Response(JSON.stringify({ operationKey: 'fictional-empty-events-operation', idempotencyKey: request.idempotencyKey,
            projectId, grantId, command: request.command, payloadHash: normalizePayload(request.payload).hash,
            status: 'succeeded', createdAt: 1, result: { events: [] } }), { status: 200 })
        } })
      const result = await isolatedCli.executeCli(['events', '--taskId', 'fictional-empty-events-task'])
      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS)
      expect(JSON.parse(result.output).events).toEqual([])
    })

    it('rejects credential argv and unknown flags without echoing their values or sending a request', async () => {
      let requests = 0
      const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token: 'fictional-task-secret',
        fetchFn: async () => { requests++; throw new Error('Unexpected request') } })
      for (const argv of [
        ['submit', '--token', 'fictional-argv-secret'],
        ['approve', '--humanReviewToken=fictional-argv-secret'],
        ['submit', '--arbitrary', 'fictional-argv-secret'],
        ['events', '--wait'],
        ['not-a-command'],
      ]) {
        const result = await isolatedCli.executeCli(argv)
        expect(result.exitCode).not.toBe(CLI_EXIT_CODES.SUCCESS)
        expect(result.output).not.toContain('fictional-argv-secret')
        expect(() => JSON.parse(result.output)).not.toThrow()
      }
      expect(requests).toBe(0)
    })

    it('rejects missing, duplicate, ambiguous and nonnumeric command options before dispatch', async () => {
      let requests = 0
      const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token: 'fictional-task-secret',
        fetchFn: async () => { requests++; throw new Error('Unexpected request') } })
      for (const argv of [
        ['events'], ['events', '--taskId'], ['events', 'one', '--taskId', 'two'],
        ['events', '--taskId', 'one', '--taskId', 'two'], ['events', 'one', '--after', '-1'],
        ['events', 'one', '--after', '1.5'], ['events', 'one', '--after', '9007199254740992'],
        ['run', '--wait', '--timeout', '0'], ['run', '--timeout', '5'], ['submit', 'unexpected'],
      ]) {
        const result = await isolatedCli.executeCli(argv)
        expect(result.exitCode).toBe(CLI_EXIT_CODES.FAILED)
        expect(() => JSON.parse(result.output)).not.toThrow()
      }
      expect(requests).toBe(0)
    })

    it('only sends command fields, not transport or control flags, as workflow payload', async () => {
      const requests: InboundRequest[] = []
      const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token: 'fictional-task-secret',
        projectId, grantId, fetchFn: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as InboundRequest
          requests.push(request)
          return new Response(JSON.stringify({ operationKey: 'fictional-operation', ...request,
            payloadHash: normalizePayload(request.payload).hash, status: 'succeeded', createdAt: 1 }), { status: 200 })
        } })
      const result = await isolatedCli.executeCli(['submit', '--chapterId', 'fictional-chapter',
        '--idempotencyKey', 'fictional-key', '--endpoint', 'http://127.0.0.1:1', '--json'])
      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.payload).toEqual({ chapterId: 'fictional-chapter' })
      expect(requests[0]?.idempotencyKey).toBe('fictional-key')
    })

    it('masks both credentials before JSON serialization, including short and escaped secrets', async () => {
      const token = 'x"\nfictional-task-token'
      const humanReviewToken = 'z9'
      const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token, humanReviewToken,
        fetchFn: async () => new Response(JSON.stringify({ error: { code: 'HUMAN_REVIEW_SCOPE_REQUIRED',
          message: `Denied ${token} and ${humanReviewToken}` } }), { status: 423 }) })
      const result = await isolatedCli.executeCli(['approve', '--reviewId', 'fictional-review'])
      expect(result.exitCode).toBe(CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
      const parsed = JSON.parse(result.output)
      expect(parsed.error).not.toContain(token)
      expect(parsed.error).not.toContain(humanReviewToken)
      expect(result.output).not.toContain(JSON.stringify(token).slice(1, -1))
    })

    it('does not disclose a malformed response body in an error', async () => {
      const isolatedCli = new CreationCli({ endpoint: 'http://127.0.0.1:1', token: 'fictional-task-secret',
        fetchFn: async () => new Response('private-fictional-response-body', { status: 502 }) })
      const result = await isolatedCli.executeCli(['submit'])
      expect(result.exitCode).toBe(CLI_EXIT_CODES.FAILED)
      expect(result.output).not.toContain('private-fictional-response-body')
      expect(JSON.parse(result.output).error).toContain('HTTP 502')
    })
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

  describe('actual client-only process entry', () => {
    const entry = fileURLToPath(new URL('../creation-cli-main.ts', import.meta.url))

    function runProcess(args: string[], credentials: Record<string, string> = {}, input = '') {
      return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {}
        for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) {
          if (process.env[name]) env[name] = process.env[name]
        }
        const child = spawn(process.execPath, ['--experimental-strip-types', entry, ...args], {
          env: { ...env, ...credentials }, windowsHide: true, timeout: 10000,
        })
        let stdout = '', stderr = ''
        child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.on('error', reject)
        child.on('close', code => resolve({ code, stdout, stderr }))
        child.stdin.on('error', () => { /* The process may reject argv before consuming stdin. */ })
        child.stdin.end(input)
      })
    }

    function args(command: string, ...rest: string[]) {
      return [command, '--endpoint', `http://127.0.0.1:${port}`, '--projectId', projectId,
        '--grantId', grantId, ...rest]
    }

    it('prints JSON help from a real Node process without configuration or activating a server', async () => {
      const result = await runProcess(['help'])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout).help).toContain('PAGEKIN_API_TOKEN')
      expect(result.stderr).toBe('')
    })

    it('reads fictional history using an explicitly named environment credential or stdin', async () => {
      const taskId = 'fictional-process-history'
      fictionalHistory(taskId, 'fictional-process-history-key')
      for (const source of ['environment', 'stdin']) {
        const result = await runProcess(args('events', '--taskId', taskId,
          ...(source === 'stdin' ? ['--token-stdin'] : [])),
        source === 'environment' ? { PAGEKIN_API_TOKEN: taskToken } : {}, source === 'stdin' ? `${taskToken}\n` : '')
        expect(result.code, result.stderr).toBe(0)
        expect(JSON.parse(result.stdout).events).toHaveLength(2)
        expect(result.stdout).not.toContain(taskToken)
        expect(result.stderr).toBe('')
      }
    })

    it('uses the separate review credential without gaining approval capability', async () => {
      const dispatch = vi.spyOn(controller.service, 'executeInboundRequest')
      try {
        for (const source of ['environment', 'stdin']) {
          dispatch.mockClear()
          const result = await runProcess(args('approve', '--reviewId', 'fictional-process-review',
            ...(source === 'stdin' ? ['--human-review-token-stdin'] : [])),
          { PAGEKIN_API_TOKEN: taskToken, ...(source === 'environment' ? { PAGEKIN_HUMAN_REVIEW_TOKEN: reviewToken } : {}) },
          source === 'stdin' ? `${reviewToken}\n` : '')
          expect(result.code, result.stderr).toBe(CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
          expect(dispatch).toHaveBeenCalledTimes(1)
          expect(dispatch.mock.calls[0]?.[0].token).toBe(reviewToken)
          expect(JSON.parse(result.stdout).error).toContain('HUMAN_REVIEW_SCOPE_REQUIRED')
          expect(result.stdout).not.toContain(taskToken)
          expect(result.stdout).not.toContain(reviewToken)
          expect(result.stderr).toBe('')
        }
      } finally {
        dispatch.mockRestore()
      }
    })

    it('rejects ambiguous credential sources, secret argv and unknown flags as stable JSON', async () => {
      for (const extra of [
        ['--token-stdin'], ['--token-stdin', '--human-review-token-stdin'],
        ['--token', 'fictional-argv-secret'], ['--humanReviewToken=fictional-argv-secret'],
        ['--unexpected', 'fictional-argv-secret'],
      ]) {
        const result = await runProcess(args('submit', ...extra), { PAGEKIN_API_TOKEN: taskToken }, 'fictional-stdin-secret')
        expect(result.code).not.toBe(0)
        expect(JSON.parse(result.stdout).error).toBeTypeOf('string')
        expect(result.stdout + result.stderr).not.toContain('fictional-argv-secret')
        expect(result.stdout + result.stderr).not.toContain('fictional-stdin-secret')
        expect(result.stdout + result.stderr).not.toContain(taskToken)
        expect(result.stderr).toBe('')
      }
    })

    it('rejects a nonliteral loopback, embedded credentials or remote endpoint before dispatch', async () => {
      const dispatch = vi.spyOn(controller.service, 'executeInboundRequest')
      try {
        for (const endpoint of [`http://2130706433:${port}`, `http://127.0.0.1:${port}?token=fictional-url-secret`,
          `http://fictional-url-secret@127.0.0.1:${port}`, 'https://localhost:1234', 'http://example.invalid']) {
          const result = await runProcess(['submit', '--endpoint', endpoint], { PAGEKIN_API_TOKEN: taskToken })
          expect(result.code).toBe(CLI_EXIT_CODES.FAILED)
          expect(JSON.parse(result.stdout).error).toContain('CLI_EXPLICIT_LOOPBACK_ENDPOINT_REQUIRED')
          expect(result.stdout + result.stderr).not.toContain('fictional-url-secret')
          expect(result.stderr).toBe('')
        }
        expect(dispatch).not.toHaveBeenCalled()
      } finally {
        dispatch.mockRestore()
      }
    })

    it('rejects ambiguous review sources and empty or multiline stdin without disclosing input', async () => {
      const dispatch = vi.spyOn(controller.service, 'executeInboundRequest')
      try {
        for (const input of ['', 'fictional-first\nfictional-second']) {
          const result = await runProcess(args('approve', '--reviewId', 'fictional-review', '--human-review-token-stdin'),
            { PAGEKIN_API_TOKEN: taskToken }, input)
          expect(result.code).toBe(CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
          expect(JSON.parse(result.stdout).error).toBe('CLI_SINGLE_CREDENTIAL_REQUIRED')
          expect(result.stdout + result.stderr).not.toContain('fictional-first')
          expect(result.stderr).toBe('')
        }
        const result = await runProcess(args('approve', '--reviewId', 'fictional-review', '--human-review-token-stdin'),
          { PAGEKIN_API_TOKEN: taskToken, PAGEKIN_HUMAN_REVIEW_TOKEN: reviewToken }, 'fictional-stdin-review')
        expect(result.code).toBe(CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR)
        expect(JSON.parse(result.stdout).error).toBe('CLI_AMBIGUOUS_CREDENTIAL_SOURCE')
        expect(result.stderr).toBe('')
        expect(dispatch).not.toHaveBeenCalled()
      } finally {
        dispatch.mockRestore()
      }
    })

    it('keeps unavailable production dispatch as failure rather than process success', async () => {
      const result = await runProcess(args('run', '--wait', '--chapterId', 'fictional-process-chapter'),
        { PAGEKIN_API_TOKEN: taskToken })
      expect(result.code).toBe(CLI_EXIT_CODES.FAILED)
      expect(JSON.parse(result.stdout).error).toContain('Workflow execution is unavailable')
      expect(result.stderr).toBe('')
    })

    it.each([
      ['failed', CLI_EXIT_CODES.FAILED], ['unknown', CLI_EXIT_CODES.UNKNOWN],
      ['pending_review', CLI_EXIT_CODES.PENDING_REVIEW],
    ] as const)('returns the terminal historical exit code in a real process for %s', async (status, expected) => {
      const taskId = `fictional-process-terminal-${status}`
      const key = `fictional-process-terminal-key-${status}`
      const receipt = fictionalHistory(taskId, key)
      receipt.status = status
      for (const command of ['submit', 'run', 'receipt']) {
        const result = await runProcess(args(command, ...(command === 'receipt' ? [key]
          : ['--taskId', taskId, '--idempotencyKey', key])), { PAGEKIN_API_TOKEN: taskToken })
        expect(result.code, `${command}: ${result.stderr}`).toBe(expected)
        const output = JSON.parse(result.stdout)
        if (command === 'receipt' || status !== 'unknown') expect(output.receipt.status).toBe(status)
        else expect(output.error).toContain('UNKNOWN_STATUS_NON_RETRYABLE')
        expect(result.stdout).not.toContain(taskToken)
        expect(result.stderr).toBe('')
      }
    })

    it('returns a failed process result without a target receipt when the real service cannot find the key', async () => {
      const result = await runProcess(args('receipt', 'fictional-process-absent-target-key'),
        { PAGEKIN_API_TOKEN: taskToken })
      expect(result.code).toBe(CLI_EXIT_CODES.FAILED)
      const output = JSON.parse(result.stdout)
      expect(output.error).toContain('RECEIPT_NOT_FOUND')
      expect(output.receipt).toBeUndefined()
      expect(result.stderr).toBe('')
    })
  })
})


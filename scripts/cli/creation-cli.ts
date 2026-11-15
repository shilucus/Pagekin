import { randomUUID } from 'node:crypto'
import {
  type InboundCommand,
  type InboundEvent,
  type InboundReceipt,
  type InboundRequest,
  INBOUND_ERROR_CODES,
  InboundDomainError,
  normalizePayload,
} from '../../src/shared/inbound-domain-contract'

export const CLI_EXIT_CODES = {
  SUCCESS: 0,
  FAILED: 1,
  CANCELLED: 2,
  UNKNOWN: 3,
  PENDING_REVIEW: 4,
  AUTH_OR_PERMISSION_ERROR: 5,
} as const

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES]

export interface CreationCliConfig {
  endpoint: string
  token?: string
  callerId?: string
  projectId?: string
  grantId?: string
  fetchFn?: typeof fetch
}

export interface CliRunResult {
  exitCode: CliExitCode
  receipt?: InboundReceipt
  events?: InboundEvent[]
  error?: string
}

export function maskSecret(secret?: string): string {
  if (!secret) return '<none>'
  if (secret.length <= 8) return '********'
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`
}

function isRetryablePollingTransportError(error: unknown): boolean {
  if (!(error instanceof TypeError) || !error.cause || typeof error.cause !== 'object') return false
  const code = (error.cause as { code?: unknown }).code
  return code === 'ECONNRESET' || code === 'UND_ERR_SOCKET'
}

function readInboundReceipt(value: unknown,
  expected: Pick<InboundRequest<unknown>, 'command' | 'projectId' | 'grantId' | 'idempotencyKey' | 'payload'>): InboundReceipt {
  const receipt = value as Partial<InboundReceipt> | null
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.command !== expected.command || receipt.projectId !== expected.projectId
    || receipt.grantId !== expected.grantId || receipt.idempotencyKey !== expected.idempotencyKey
    || typeof receipt.operationKey !== 'string' || !receipt.operationKey
    || receipt.payloadHash !== normalizePayload(expected.payload).hash
    || !Number.isFinite(receipt.createdAt) || typeof receipt.status !== 'string'
    || !['succeeded', 'failed', 'unknown', 'pending_review', 'cancelled'].includes(receipt.status)) {
    throw new Error('Invalid inbound receipt response from server')
  }
  return receipt as InboundReceipt
}

export class CreationCli {
  private readonly endpoint: string
  private readonly token: string
  private readonly callerId: string
  private readonly projectId: string
  private readonly grantId: string
  private readonly fetch: typeof fetch

  constructor(config: CreationCliConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '')
    this.token = config.token || process.env.PAGEKIN_API_TOKEN || ''
    this.callerId = config.callerId || 'pagekin-cli'
    this.projectId = config.projectId || ''
    this.grantId = config.grantId || ''
    this.fetch = config.fetchFn || globalThis.fetch
  }

  /**
   * Sends a structured inbound request to the domain API endpoint.
   */
  async sendRequest<TPayload = Record<string, unknown>>(
    command: InboundCommand,
    payload: TPayload,
    options: {
      idempotencyKey?: string
      projectId?: string
      grantId?: string
      token?: string
      sequenceCursor?: number
    } = {},
  ): Promise<InboundReceipt> {
    const token = options.token || this.token
    const projectId = options.projectId || this.projectId
    const grantId = options.grantId || this.grantId
    const idempotencyKey = options.idempotencyKey || `cli_${randomUUID()}`

    if (!token) {
      throw new InboundDomainError(
        INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN,
        'API Token is missing (provide via option or PAGEKIN_API_TOKEN env var)',
        401,
      )
    }

    const requestBody: InboundRequest<TPayload> = {
      callerId: this.callerId,
      token,
      projectId,
      grantId,
      command,
      idempotencyKey,
      payload,
      sequenceCursor: options.sequenceCursor,
    }

    const url = this.endpoint.endsWith('/api/inbound')
      ? this.endpoint
      : `${this.endpoint}/api/inbound`

    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    })

    const text = await response.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`Invalid JSON response from server (HTTP ${response.status})`)
    }

    if (!response.ok) {
      const err = (data as { error?: { code?: string; message?: string } })?.error
      const code = (err?.code as (typeof INBOUND_ERROR_CODES)[keyof typeof INBOUND_ERROR_CODES]) || 'UNKNOWN_ERROR'
      const message = err?.message || `HTTP ${response.status} error`
      throw new InboundDomainError(code, message, response.status)
    }

    return readInboundReceipt(data, requestBody)
  }

  /**
   * Submits a creation workflow asynchronously and returns immediately.
   */
  async submit(
    payload: Record<string, unknown> = {},
    options: { idempotencyKey?: string } = {},
  ): Promise<InboundReceipt> {
    return this.sendRequest('workflow:start', payload, options)
  }

  /**
   * Runs a creation workflow and waits for completion by polling events and final receipts.
   */
  async runAndWait(
    payload: Record<string, unknown> = {},
    options: {
      idempotencyKey?: string
      pollIntervalMs?: number
      timeoutMs?: number
      onEvent?: (event: InboundEvent) => void
    } = {},
  ): Promise<CliRunResult> {
    const idempotencyKey = options.idempotencyKey || `cli_run_${randomUUID()}`
    const pollInterval = options.pollIntervalMs ?? 50
    const timeout = options.timeoutMs ?? 30000
    const startTime = Date.now()

    let initialReceipt: InboundReceipt
    try {
      initialReceipt = await this.submit(payload, { idempotencyKey })
    } catch (err: unknown) {
      return this.handleErrorToResult(err)
    }

    // Check if initial submission failed or finished in unknown terminal state
    if (initialReceipt.status === 'unknown') {
      return {
        exitCode: CLI_EXIT_CODES.UNKNOWN,
        receipt: initialReceipt,
        error: 'Initial submission ended in non-retryable unknown state',
      }
    }

    const taskId = (initialReceipt.result?.taskId as string) || ''
    if (!taskId) return this.handleErrorToResult(new Error('Workflow start response is missing taskId'))
    const collectedEvents: InboundEvent[] = []
    let cursor = 0

    while (Date.now() - startTime < timeout) {
      // 1. Fetch incremental events
      if (taskId) {
        try {
          const eventsReceipt = await this.sendRequest(
            'workflow:events',
            { taskId },
            { sequenceCursor: cursor },
          )
          const newEvents = eventsReceipt.result?.events as InboundEvent[] | undefined
          if (!Array.isArray(newEvents)) throw new Error('Invalid workflow events response from server')
          for (const ev of newEvents) {
            collectedEvents.push(ev)
            cursor = Math.max(cursor, ev.sequenceNumber)
            options.onEvent?.(ev)

            // Check for review requirement
            if (ev.type === 'review_required') {
              return {
                exitCode: CLI_EXIT_CODES.PENDING_REVIEW,
                receipt: initialReceipt,
                events: collectedEvents,
              }
            }

            // Check for explicit cancellation event
            if (
              ev.type === 'status_changed' &&
              (ev.data?.status === 'cancelled' || ev.data?.status === 'canceled')
            ) {
              return {
                exitCode: CLI_EXIT_CODES.CANCELLED,
                receipt: initialReceipt,
                events: collectedEvents,
              }
            }
          }
        } catch (error: unknown) {
          if (!isRetryablePollingTransportError(error)) {
            return { ...this.handleErrorToResult(error), receipt: initialReceipt, events: collectedEvents }
          }
        }
      }

      // 2. Fetch updated receipt
      try {
        const receiptQuery = await this.sendRequest(
          'workflow:receipt',
          { targetIdempotencyKey: idempotencyKey, targetCommand: 'workflow:start' },
        )

        const currentReceipt = readInboundReceipt(receiptQuery.result?.receipt, {
          command: 'workflow:start', projectId: this.projectId, grantId: this.grantId, idempotencyKey, payload,
        })
        if (currentReceipt.status === 'succeeded') {
          return {
            exitCode: CLI_EXIT_CODES.SUCCESS,
            receipt: currentReceipt,
            events: collectedEvents,
          }
        }
        if (currentReceipt.status === 'failed') {
          return {
            exitCode: CLI_EXIT_CODES.FAILED,
            receipt: currentReceipt,
            events: collectedEvents,
            error: currentReceipt.error?.message,
          }
        }
        if (currentReceipt.status === 'cancelled') {
          return {
            exitCode: CLI_EXIT_CODES.CANCELLED,
            receipt: currentReceipt,
            events: collectedEvents,
          }
        }
        if (currentReceipt.status === 'unknown') {
          return {
            exitCode: CLI_EXIT_CODES.UNKNOWN,
            receipt: currentReceipt,
            events: collectedEvents,
            error: currentReceipt.error?.message || 'Task ended in unknown terminal state',
          }
        }
        if (currentReceipt.status === 'pending_review') {
          return {
            exitCode: CLI_EXIT_CODES.PENDING_REVIEW,
            receipt: currentReceipt,
            events: collectedEvents,
          }
        }
      } catch (error: unknown) {
        if (!isRetryablePollingTransportError(error)) {
          return { ...this.handleErrorToResult(error), receipt: initialReceipt, events: collectedEvents }
        }
      }

      await new Promise(r => setTimeout(r, pollInterval))
    }

    return {
      exitCode: CLI_EXIT_CODES.UNKNOWN,
      receipt: initialReceipt,
      events: collectedEvents,
      error: `runAndWait timed out after ${timeout}ms`,
    }
  }

  /**
   * Fetches events for an existing task, optionally filtering by sequenceNumber cursor.
   */
  async events(
    taskId: string,
    options: { afterSequence?: number } = {},
  ): Promise<InboundEvent[]> {
    const res = await this.sendRequest(
      'workflow:events',
      { taskId, afterSequence: options.afterSequence ?? 0 },
      { sequenceCursor: options.afterSequence },
    )
    return (res.result?.events as InboundEvent[]) || []
  }

  /**
   * Resumes a paused or checkpointed workflow task.
   */
  async resume(taskId: string): Promise<InboundReceipt> {
    return this.sendRequest('workflow:resume', { taskId })
  }

  /**
   * Queries the immutable domain receipt for a given idempotency key.
   */
  async getReceipt(
    targetIdempotencyKey: string,
    targetCommand: InboundCommand = 'workflow:start',
  ): Promise<InboundReceipt> {
    const res = await this.sendRequest(
      'workflow:receipt',
      { targetIdempotencyKey, targetCommand },
    )
    return (res.result?.receipt as InboundReceipt) || res
  }

  /**
   * Submits an approval for a human review item. Requires human_review scope token.
   */
  async approve(
    reviewId: string,
    options: { humanReviewToken?: string } = {},
  ): Promise<CliRunResult> {
    try {
      const receipt = await this.sendRequest(
        'human-review:approve',
        { reviewId },
        { token: options.humanReviewToken },
      )
      return {
        exitCode: CLI_EXIT_CODES.SUCCESS,
        receipt,
      }
    } catch (err: unknown) {
      return this.handleErrorToResult(err)
    }
  }

  /**
   * Command-line dispatcher: parses CLI argv arguments, executes matching subcommands,
   * formats stdout JSON, masks all credentials, and returns structured result with exitCode.
   */
  async executeCli(argv: string[]): Promise<{ exitCode: CliExitCode; output: string }> {
    const parsed = parseCliArgs(argv)
    const isJson = parsed.flags.json ?? true

    try {
      const command = parsed.positionals[0] || 'help'

      switch (command) {
        case 'submit': {
          const receipt = await this.submit(parsed.payload, {
            idempotencyKey: parsed.flags.idempotencyKey,
          })
          const out = formatOutput({ command, status: receipt.status, receipt }, isJson, this.token)
          return { exitCode: CLI_EXIT_CODES.SUCCESS, output: out }
        }

        case 'run': {
          const wait = parsed.flags.wait ?? false
          if (!wait) {
            // submit mode without waiting
            const receipt = await this.submit(parsed.payload, {
              idempotencyKey: parsed.flags.idempotencyKey,
            })
            const out = formatOutput({ command, status: receipt.status, receipt }, isJson, this.token)
            return { exitCode: CLI_EXIT_CODES.SUCCESS, output: out }
          }

          const res = await this.runAndWait(parsed.payload, {
            idempotencyKey: parsed.flags.idempotencyKey,
            timeoutMs: parsed.flags.timeout ? Number(parsed.flags.timeout) : undefined,
          })
          const out = formatOutput(res, isJson, this.token)
          return { exitCode: res.exitCode, output: out }
        }

        case 'events': {
          const taskId = parsed.flags.taskId || (parsed.positionals[1] ?? '')
          const after = parsed.flags.after ? Number(parsed.flags.after) : 0
          const evs = await this.events(taskId, { afterSequence: after })
          const out = formatOutput({ taskId, events: evs }, isJson, this.token)
          return { exitCode: CLI_EXIT_CODES.SUCCESS, output: out }
        }

        case 'receipt': {
          const key = parsed.flags.idempotencyKey || (parsed.positionals[1] ?? '')
          const rc = await this.getReceipt(key)
          const out = formatOutput({ receipt: rc }, isJson, this.token)
          return { exitCode: CLI_EXIT_CODES.SUCCESS, output: out }
        }

        case 'resume': {
          const taskId = parsed.flags.taskId || (parsed.positionals[1] ?? '')
          const rc = await this.resume(taskId)
          const out = formatOutput({ receipt: rc }, isJson, this.token)
          return { exitCode: CLI_EXIT_CODES.SUCCESS, output: out }
        }

        case 'approve': {
          const reviewId = parsed.flags.reviewId || (parsed.positionals[1] ?? '')
          const res = await this.approve(reviewId, {
            humanReviewToken: parsed.flags.humanReviewToken || parsed.flags.token,
          })
          const out = formatOutput(res, isJson, this.token)
          return { exitCode: res.exitCode, output: out }
        }

        case 'help':
        default: {
          const help = `Pagekin Creation CLI
Usage: creation-cli <command> [options]

Commands:
  submit                 Submit creation workflow asynchronously
  run --wait             Run creation workflow and wait for terminal state
  events --taskId <id>   List incremental events for a task
  receipt <key>          Query immutable execution receipt
  resume --taskId <id>   Resume paused workflow task
  approve --reviewId <id> Approve human review item (requires human_review scope)

Options:
  --wait                 Wait for task completion
  --json                 Output structured JSON
  --chapterId <id>       Chapter identifier
  --taskId <id>          Workflow task identifier
  --reviewId <id>        Review item identifier
  --after <seq>          Events sequence cursor
  --token <token>        Authentication token (or use PAGEKIN_API_TOKEN)
  --endpoint <url>       Local domain API endpoint`
          return { exitCode: CLI_EXIT_CODES.SUCCESS, output: help }
        }
      }
    } catch (err: unknown) {
      const errRes = this.handleErrorToResult(err)
      const out = formatOutput(errRes, isJson, this.token)
      return { exitCode: errRes.exitCode, output: out }
    }
  }

  private handleErrorToResult(err: unknown): CliRunResult {
    if (err instanceof InboundDomainError) {
      if (
        err.code === INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN ||
        err.code === INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED ||
        err.code === INBOUND_ERROR_CODES.INSUFFICIENT_SCOPE ||
        err.code === INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID
      ) {
        return {
          exitCode: CLI_EXIT_CODES.AUTH_OR_PERMISSION_ERROR,
          error: `[${err.code}] ${err.message}`,
        }
      }
      if (err.code === INBOUND_ERROR_CODES.UNKNOWN_STATUS_NON_RETRYABLE) {
        return {
          exitCode: CLI_EXIT_CODES.UNKNOWN,
          error: `[${err.code}] ${err.message}`,
        }
      }
    }
    return {
      exitCode: CLI_EXIT_CODES.FAILED,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function parseCliArgs(argv: string[]): {
  positionals: string[]
  flags: Record<string, string | boolean>
  payload: Record<string, unknown>
} {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  const payload: Record<string, unknown> = {}

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      const flagName = arg.slice(2)
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
        flags[flagName] = argv[i + 1]!
        payload[flagName] = argv[i + 1]!
        i += 2
      } else {
        flags[flagName] = true
        i += 1
      }
    } else {
      positionals.push(arg)
      i += 1
    }
  }

  return { positionals, flags, payload }
}

function formatOutput(data: unknown, isJson: boolean, sensitiveToken?: string): string {
  let str = isJson ? JSON.stringify(data, null, 2) : String(data)
  if (sensitiveToken && sensitiveToken.length > 4) {
    str = str.replaceAll(sensitiveToken, maskSecret(sensitiveToken))
  }
  return str
}

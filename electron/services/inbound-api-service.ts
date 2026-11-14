import { randomUUID } from 'node:crypto'
import {
  type InboundAuthToken,
  type InboundCommand,
  INBOUND_ERROR_CODES,
  type InboundEvent,
  type InboundReceipt,
  type InboundRequest,
  type InboundTokenScope,
  InboundDomainError,
  normalizePayload,
  validateInboundRequest,
} from '../../src/shared/inbound-domain-contract'
import type { WorkflowDriverAuthority } from './workflow-driver-authority'

export interface InboundApiServiceOptions {
  workflowDriverAuthority?: WorkflowDriverAuthority
}

interface IdempotencyRecord {
  normalizedHash: string
  receipt: InboundReceipt
  createdAt: number
}

interface PendingIdempotencyRecord {
  normalizedHash: string
  promise: Promise<InboundReceipt>
}

function createIdempotencyId(
  projectId: string,
  callerId: string,
  grantId: string,
  command: InboundCommand,
  idempotencyKey: string,
): string {
  return JSON.stringify([projectId, callerId, grantId, command, idempotencyKey])
}

interface HumanReviewItem {
  reviewId: string
  taskId: string
  projectId: string
  chapterId?: string
  proposal: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

export class InboundApiService {
  private readonly tokens = new Map<string, InboundAuthToken>()
  private readonly idempotencyStore = new Map<string, IdempotencyRecord>()
  private readonly pendingIdempotency = new Map<string, PendingIdempotencyRecord>()
  private readonly taskEvents = new Map<string, InboundEvent[]>()
  private readonly taskOwners = new Map<string, { projectId: string; callerId: string; grantId: string }>()
  private readonly reviewItems = new Map<string, HumanReviewItem>()
  private isTrustedReviewChannelOpen = false
  private readonly workflowDriverAuthority?: WorkflowDriverAuthority

  constructor(options: InboundApiServiceOptions = {}) {
    this.workflowDriverAuthority = options.workflowDriverAuthority
  }

  getWorkflowDriverAuthority(): WorkflowDriverAuthority | undefined {
    return this.workflowDriverAuthority
  }

  /**
   * Retrieves an auth token record for inspection (read-only).
   */
  getToken(tokenStr: string): InboundAuthToken | undefined {
    return this.tokens.get(tokenStr)
  }

  /**
   * Issues a new structured auth token for an external caller (CLI / tool).
   */
  issueToken(options: {
    callerId: string
    scopes: InboundTokenScope[]
    allowedProjectIds: string[]
    ttlMs?: number
  }): InboundAuthToken {
    const tokenStr = `ink_inbound_${randomUUID().replace(/-/g, '')}`
    const expiresAt = Date.now() + (options.ttlMs ?? 24 * 60 * 60 * 1000)

    const token: InboundAuthToken = {
      token: tokenStr,
      callerId: options.callerId,
      scopes: [...options.scopes],
      allowedProjectIds: [...options.allowedProjectIds],
      expiresAt,
      revoked: false,
    }

    this.tokens.set(tokenStr, token)
    return token
  }

  /**
   * Revokes an existing token immediately.
   */
  revokeToken(tokenStr: string): boolean {
    const existing = this.tokens.get(tokenStr)
    if (!existing) {
      return false
    }
    existing.revoked = true
    return true
  }

  /**
   * Sets whether the trusted physical UI human review channel is currently active.
   * When false, external calls to human-review:approve are rejected to prevent machine self-approval.
   */
  setTrustedReviewChannelReady(ready: boolean): void {
    this.isTrustedReviewChannelOpen = ready
  }

  /**
   * Checks token validity, scope, caller identity, and allowed projects.
   */
  private authenticateAndAuthorize(
    req: InboundRequest,
  ): InboundAuthToken {
    const token = this.tokens.get(req.token)
    if (!token || token.revoked || token.expiresAt < Date.now()) {
      throw new InboundDomainError(
        INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN,
        'Invalid, expired, or revoked token',
        401,
      )
    }

    if (token.callerId !== req.callerId) {
      throw new InboundDomainError(
        INBOUND_ERROR_CODES.UNAUTHORIZED_TOKEN,
        `Token callerId '${token.callerId}' does not match request callerId '${req.callerId}'`,
        403,
      )
    }

    // Check project grant authorization (unless admin)
    if (!token.scopes.includes('admin') && !token.allowedProjectIds.includes(req.projectId)) {
      throw new InboundDomainError(
        INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID,
        `Caller is not authorized for projectId '${req.projectId}'`,
        403,
      )
    }

    // Human review scope isolation: task tokens CANNOT perform review approvals
    if (req.command === 'human-review:approve') {
      if (!token.scopes.includes('human_review')) {
        throw new InboundDomainError(
          INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED,
          'Task credentials cannot self-approve; human_review scope is required',
          403,
        )
      }
      if (!this.isTrustedReviewChannelOpen) {
        throw new InboundDomainError(
          INBOUND_ERROR_CODES.HUMAN_REVIEW_SCOPE_REQUIRED,
          'Human review write entrance is closed until trusted interactive channel is open',
          423,
        )
      }
    }

    if (req.command === 'human-review:list' && !token.scopes.includes('human_review') && !token.scopes.includes('admin')) {
      throw new InboundDomainError(
        INBOUND_ERROR_CODES.INSUFFICIENT_SCOPE,
        'human_review scope required to inspect review queue',
        403,
      )
    }

    return token
  }

  /**
   * Executes an inbound request following the strict idempotency and validation contract.
   */
  async executeInboundRequest(request: InboundRequest): Promise<InboundReceipt> {
    // 1. Structural & security validation
    validateInboundRequest(request)

    // 2. Authentication & scope verification
    this.authenticateAndAuthorize(request)

    // 3. Normalization and Idempotency key evaluation
    const { hash: payloadHash } = normalizePayload(request.payload)
    const idempotencyId = createIdempotencyId(
      request.projectId,
      request.callerId,
      request.grantId,
      request.command,
      request.idempotencyKey,
    )

    const existingRecord = this.idempotencyStore.get(idempotencyId)
    if (existingRecord) {
      // Check if hash matches
      if (existingRecord.normalizedHash !== payloadHash) {
        throw new InboundDomainError(
          INBOUND_ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
          `Idempotency key '${request.idempotencyKey}' reused with different normalized payload`,
          409,
        )
      }

      // Check for non-retryable unknown terminal state
      if (existingRecord.receipt.status === 'unknown') {
        throw new InboundDomainError(
          INBOUND_ERROR_CODES.UNKNOWN_STATUS_NON_RETRYABLE,
          'Previous attempt ended in unknown state; automatic retry with same key is prohibited',
          409,
        )
      }

      // Packet loss query / repeat request -> return existing immutable receipt directly
      return existingRecord.receipt
    }

    const pendingRecord = this.pendingIdempotency.get(idempotencyId)
    if (pendingRecord) {
      if (pendingRecord.normalizedHash !== payloadHash) {
        throw new InboundDomainError(
          INBOUND_ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
          `Idempotency key '${request.idempotencyKey}' reused with different normalized payload`,
          409,
        )
      }
      return pendingRecord.promise
    }

    let resolveAttempt!: (receipt: InboundReceipt) => void
    let rejectAttempt!: (error: unknown) => void
    const attemptPromise = new Promise<InboundReceipt>((resolve, reject) => {
      resolveAttempt = resolve
      rejectAttempt = reject
    })
    const attemptRecord = { normalizedHash: payloadHash, promise: attemptPromise }
    this.pendingIdempotency.set(idempotencyId, attemptRecord)

    // 4. Command Dispatch
    const dispatchPromise = this.dispatchCommand(request, payloadHash)
    void dispatchPromise.then(
      (receipt) => {
        // 5. Store in idempotency cache
        this.idempotencyStore.set(idempotencyId, {
          normalizedHash: payloadHash,
          receipt,
          createdAt: Date.now(),
        })
        if (this.pendingIdempotency.get(idempotencyId) === attemptRecord) {
          this.pendingIdempotency.delete(idempotencyId)
        }
        resolveAttempt(receipt)
      },
      (error: unknown) => {
        if (this.pendingIdempotency.get(idempotencyId) === attemptRecord) {
          this.pendingIdempotency.delete(idempotencyId)
        }
        rejectAttempt(error)
      },
    )

    return attemptPromise
  }

  /**
   * Dispatches the valid inbound command to appropriate domain logic or WorkflowDriverAuthority.
   */
  private async dispatchCommand(req: InboundRequest, payloadHash: string): Promise<InboundReceipt> {
    const now = Date.now()
    const operationKey = `${req.command}:${req.idempotencyKey}`

    switch (req.command) {
      case 'project:get': {
        return {
          operationKey,
          idempotencyKey: req.idempotencyKey,
          projectId: req.projectId,
          grantId: req.grantId,
          command: req.command,
          payloadHash,
          status: 'succeeded',
          result: {
            projectId: req.projectId,
            active: true,
            status: 'ready',
          },
          createdAt: now,
          completedAt: now,
        }
      }

      case 'project:list': {
        const token = this.tokens.get(req.token)
        const projectIds = token?.scopes.includes('admin')
          ? [req.projectId]
          : (token?.allowedProjectIds && token.allowedProjectIds.length > 0
              ? token.allowedProjectIds
              : [req.projectId])

        return {
          operationKey,
          idempotencyKey: req.idempotencyKey,
          projectId: req.projectId,
          grantId: req.grantId,
          command: req.command,
          payloadHash,
          status: 'succeeded',
          result: {
            projects: projectIds.map(p => ({ projectId: p, grantId: req.grantId })),
          },
          createdAt: now,
          completedAt: now,
        }
      }

      case 'workflow:start': {
        const taskId = (req.payload.taskId as string) || `task_${randomUUID()}`
        const owner = this.taskOwners.get(taskId)
        if (owner) {
          this.assertTaskOwner(taskId, req)
          throw new InboundDomainError(INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED, 'Task ID is already in use', 409)
        } else {
          if (this.taskEvents.has(taskId)) this.rejectTaskOwner()
          this.taskOwners.set(taskId, { projectId: req.projectId, callerId: req.callerId, grantId: req.grantId })
        }
        this.recordEvent(taskId, {
          taskId,
          projectId: req.projectId,
          type: 'status_changed',
          data: { status: 'running', command: req.command },
        })
        this.recordEvent(taskId, {
          taskId,
          projectId: req.projectId,
          type: 'step_completed',
          data: { stepIndex: 0, name: 'initialized' },
        })

        // Check if an intentional unknown test condition is passed in payload
        if (req.payload.simulateTerminalStatus === 'unknown') {
          return {
            operationKey,
            idempotencyKey: req.idempotencyKey,
            projectId: req.projectId,
            grantId: req.grantId,
            command: req.command,
            payloadHash,
            status: 'unknown',
            error: {
              code: 'SIMULATED_UNKNOWN_TERMINAL',
              message: 'Simulated unknown terminal state for testing non-retryable barrier',
            },
            createdAt: now,
            completedAt: now,
          }
        }

        return {
          operationKey,
          idempotencyKey: req.idempotencyKey,
          projectId: req.projectId,
          grantId: req.grantId,
          command: req.command,
          payloadHash,
          status: 'succeeded',
          result: {
            taskId,
            state: 'running',
            leaseId: (req.payload.leaseId as string) || 'lease-default',
          },
          createdAt: now,
          completedAt: now,
        }
      }

      case 'workflow:resume': {
        const taskId = req.payload.taskId as string
        if (!taskId) {
          throw new InboundDomainError(
            INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED,
            'Missing taskId for workflow:resume',
            400,
          )
        }
        this.assertTaskOwner(taskId, req)
        this.recordEvent(taskId, {
          taskId,
          projectId: req.projectId,
          type: 'status_changed',
          data: { status: 'resumed' },
        })

        return {
          operationKey,
          idempotencyKey: req.idempotencyKey,
          projectId: req.projectId,
          grantId: req.grantId,
          command: req.command,
          payloadHash,
          status: 'succeeded',
          result: { taskId, state: 'resumed' },
          createdAt: now,
          completedAt: now,
        }
      }

      case 'workflow:get': {
        const taskId = req.payload.taskId as string
        this.assertTaskOwner(taskId, req)
        const events = this.taskEvents.get(taskId) || []
        const lastEvent = events[events.length - 1]

        return {
          operationKey,
          idempotencyKey: req.idempotencyKey,
          projectId: req.projectId,
          grantId: req.grantId,
          command: req.command,
          payloadHash,
          status: 'succeeded',
          result: {
            taskId,
            lastStatus: lastEvent?.data?.status ?? 'idle',
            eventCount: events.length,
          },
          createdAt: now,
          completedAt: now,
        }
      }

      case 'workflow:events': {
        const taskId = req.payload.taskId as string
        this.assertTaskOwner(taskId, req)
        const afterSeq = req.sequenceCursor ?? (req.payload.afterSequence as number) ?? 0
        const events = this.getEvents(taskId, afterSeq)

        return {
          operationKey,
          idempotencyKey: req.idempotencyKey,
          projectId: req.projectId,
          grantId: req.grantId,
          command: req.command,
          payloadHash,
          status: 'succeeded',
          result: {
            taskId,
            afterSequence: afterSeq,
            events,
          },
          createdAt: now,
          completedAt: now,
        }
      }

      case 'workflow:receipt': {
        const queryIdempotencyKey = req.payload.targetIdempotencyKey as string
        const targetCommand = (req.payload.targetCommand as InboundCommand) || 'workflow:start'
        const targetId = createIdempotencyId(
          req.projectId,
          req.callerId,
          req.grantId,
          targetCommand,
          queryIdempotencyKey,
        )
        const record = this.idempotencyStore.get(targetId)

        return {
          operationKey,
          idempotencyKey: req.idempotencyKey,
          projectId: req.projectId,
          grantId: req.grantId,
          command: req.command,
          payloadHash,
          status: record ? record.receipt.status : 'failed',
          result: record ? { receipt: record.receipt } : undefined,
          error: !record ? { code: 'RECEIPT_NOT_FOUND', message: 'No receipt found for specified target' } : undefined,
          createdAt: now,
          completedAt: now,
        }
      }

      case 'human-review:list': {
        const list = Array.from(this.reviewItems.values()).filter(
          item => item.projectId === req.projectId,
        )
        return {
          operationKey,
          idempotencyKey: req.idempotencyKey,
          projectId: req.projectId,
          grantId: req.grantId,
          command: req.command,
          payloadHash,
          status: 'succeeded',
          result: { reviews: list },
          createdAt: now,
          completedAt: now,
        }
      }

      case 'human-review:approve': {
        const reviewId = req.payload.reviewId as string
        const item = this.reviewItems.get(reviewId)
        if (item) {
          item.status = 'approved'
        }

        return {
          operationKey,
          idempotencyKey: req.idempotencyKey,
          projectId: req.projectId,
          grantId: req.grantId,
          command: req.command,
          payloadHash,
          status: 'succeeded',
          result: {
            reviewId,
            approved: true,
            reviewedAt: now,
          },
          createdAt: now,
          completedAt: now,
        }
      }

      default: {
        throw new InboundDomainError(
          INBOUND_ERROR_CODES.COMMAND_NOT_ALLOWED,
          `Command ${(req as InboundRequest).command} not supported`,
          400,
        )
      }
    }
  }

  private rejectTaskOwner(): never {
    throw new InboundDomainError(INBOUND_ERROR_CODES.PROJECT_GRANT_INVALID, 'Task is not available to this caller', 403)
  }

  private assertTaskOwner(taskId: string, req: InboundRequest): void {
    const owner = this.taskOwners.get(taskId)
    if (!owner || owner.projectId !== req.projectId || owner.callerId !== req.callerId || owner.grantId !== req.grantId) {
      this.rejectTaskOwner()
    }
  }

  /**
   * Appends an event to the task event stream with a strictly increasing sequenceNumber.
   */
  recordEvent(
    taskId: string,
    eventData: Omit<InboundEvent, 'sequenceNumber' | 'timestamp'>,
  ): InboundEvent {
    let list = this.taskEvents.get(taskId)
    if (!list) {
      list = []
      this.taskEvents.set(taskId, list)
    }

    const sequenceNumber = list.length + 1
    const event: InboundEvent = {
      ...eventData,
      sequenceNumber,
      timestamp: Date.now(),
    }
    list.push(event)
    return event
  }

  /**
   * Retrieves events occurring strictly after `afterSequence`.
   */
  getEvents(taskId: string, afterSequence = 0): InboundEvent[] {
    const list = this.taskEvents.get(taskId)
    if (!list) {
      return []
    }
    return list.filter(e => e.sequenceNumber > afterSequence)
  }

  /**
   * Helper to seed a review item for testing or domain orchestration.
   */
  addReviewItem(item: Omit<HumanReviewItem, 'createdAt' | 'status'>): void {
    this.reviewItems.set(item.reviewId, {
      ...item,
      status: 'pending',
      createdAt: Date.now(),
    })
  }
}

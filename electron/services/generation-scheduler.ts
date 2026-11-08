import type { ModelProfile } from '../../src/shared/ipc-channels'
import { resolveAnthropicMessagesUrl } from '../llm/anthropic-provider'
import { resolveOpenAIChatCompletionsUrl } from '../llm/openai-compatible-endpoint'
import {
  MainProcessScheduler,
  type MainProcessSchedulerPermit,
  type MainProcessSchedulerPolicy,
  type SchedulerLane,
} from './main-process-scheduler'
import { MainResourceClaimRegistry } from './main-resource-claims'
import { SchedulerNetworkSubjectRegistry } from './scheduler-network-subject'

export interface GenerationSchedulingAdmission {
  acquire(request: {
    projectKey: string
    model: ModelProfile
    lane: SchedulerLane
    signal: AbortSignal
  }): Promise<MainProcessSchedulerPermit>
}

/** Only the resolved request origin is used for grouping, not redirect targets. */
function groupingProfile(model: ModelProfile): ModelProfile {
  try {
    const snapshot = structuredClone(model)
    const requestUrl = snapshot.protocol === 'anthropic'
      ? resolveAnthropicMessagesUrl(snapshot.baseUrl)
      : snapshot.protocol === 'gemini'
        ? `${snapshot.baseUrl.replace(/\/$/u, '')}/v1beta/models/${snapshot.modelName}:streamGenerateContent?alt=sse`
        : resolveOpenAIChatCompletionsUrl(snapshot.baseUrl, snapshot.provider)
    const origin = new URL(requestUrl).origin
    return { ...snapshot, baseUrl: origin }
  } catch {
    throw new Error('SCHEDULER_SUBJECT_ENDPOINT_INVALID')
  }
}

/** Main-only admission; this does not replace dispatch authorization checks. */
export class MainGenerationScheduler implements GenerationSchedulingAdmission {
  readonly #subjects: SchedulerNetworkSubjectRegistry
  readonly #scheduler: MainProcessScheduler

  constructor(policy: MainProcessSchedulerPolicy, maxSubjects: number) {
    this.#subjects = new SchedulerNetworkSubjectRegistry(maxSubjects)
    const resources = new MainResourceClaimRegistry()
    this.#scheduler = new MainProcessScheduler(policy, subject => this.#subjects.retain(subject), resources)
  }

  async acquire(request: {
    projectKey: string
    model: ModelProfile
    lane: SchedulerLane
    signal: AbortSignal
  }): Promise<MainProcessSchedulerPermit> {
    const lease = this.#subjects.capture(groupingProfile(request.model))
    try {
      return await this.#scheduler.acquire({
        projectKey: request.projectKey, subject: lease.subject, lane: request.lane, signal: request.signal,
      })
    } finally {
      lease.release()
    }
  }

  /** Operator must identify the affected credential by a main-process profile. */
  resetCredential(model: ModelProfile): void {
    const lease = this.#subjects.capture(groupingProfile(model))
    try {
      this.#scheduler.resetCredential(lease.subject.credential)
    } finally {
      lease.release()
    }
  }

  close(): void {
    this.#scheduler.close()
  }

  getStats(): Readonly<{
    active: number; occupied: number; queued: number; quarantined: number
    blockedCredentials: number; subjects: number; subjectLeases: number
  }> {
    const { active, occupied, queued, quarantined, blockedCredentials } = this.#scheduler.getStats()
    const { subjects, leases: subjectLeases } = this.#subjects.stats()
    return Object.freeze({ active, occupied, queued, quarantined, blockedCredentials, subjects, subjectLeases })
  }
}

import type { ModelProfile } from '../../src/shared/ipc-channels'
import type { EmbeddingModel } from '../../src/shared/embedding-options'
import { embeddingRequestUrl } from '../embedding'
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

// Shared only by independent query transports; ordinary generation stays exclusive.
const PROJECT_NETWORK_RESOURCE = 'generation-network'

export interface GenerationSchedulingAdmission {
  acquire(request: {
    projectKey: string
    model: ModelProfile
    lane: SchedulerLane
    signal: AbortSignal
  }): Promise<MainProcessSchedulerPermit>
  acquireEmbedding?(request: EmbeddingSchedulingRequest): Promise<MainProcessSchedulerPermit>
}

export interface EmbeddingSchedulingRequest {
  projectKey: string
  configuration: { protocol: 'openai' | 'gemini'; model: EmbeddingModel }
  lane: SchedulerLane
  signal: AbortSignal
}

export interface NetworkSchedulingRequest {
  projectKey: string
  /** Resolved transport URL, not a renderer profile ID or configured base URL. */
  endpoint: string
  apiKey: string
  modelName: string
  lane: SchedulerLane
  signal: AbortSignal
}

export interface MainNetworkSchedulingAdmission extends GenerationSchedulingAdmission {
  acquireEmbedding(request: EmbeddingSchedulingRequest): Promise<MainProcessSchedulerPermit>
  acquireNetwork(request: NetworkSchedulingRequest): Promise<MainProcessSchedulerPermit>
}

const INITIAL_NETWORK_SCHEDULING = Object.freeze({
  global: 2, provider: 2, credential: 2, model: 2, project: 2,
  maxQueued: 32, maxQuarantined: 2, interactiveBurst: 1,
})

/** The composition root shares this instance; isolated consumers may create their own. */
export function createMainNetworkScheduler(): MainGenerationScheduler {
  return new MainGenerationScheduler(INITIAL_NETWORK_SCHEDULING,
    3 * (INITIAL_NETWORK_SCHEDULING.global + INITIAL_NETWORK_SCHEDULING.maxQueued + INITIAL_NETWORK_SCHEDULING.maxQuarantined))
}

export function generationSchedulingEndpoint(model: ModelProfile): string {
  return model.protocol === 'anthropic'
    ? resolveAnthropicMessagesUrl(model.baseUrl)
    : model.protocol === 'gemini'
      ? `${model.baseUrl.replace(/\/$/u, '')}/v1beta/models/${model.modelName}:streamGenerateContent?alt=sse`
      : resolveOpenAIChatCompletionsUrl(model.baseUrl, model.provider)
}

/** Only the resolved request origin is used for grouping, not redirect targets. */
function groupingProfile(model: ModelProfile): ModelProfile {
  try {
    const snapshot = structuredClone(model)
    const requestUrl = generationSchedulingEndpoint(snapshot)
    const origin = new URL(requestUrl).origin
    return { ...snapshot, baseUrl: origin }
  } catch {
    throw new Error('SCHEDULER_SUBJECT_ENDPOINT_INVALID')
  }
}

/** Main-only admission; this does not replace dispatch authorization checks. */
export class MainGenerationScheduler implements MainNetworkSchedulingAdmission {
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
        claims: { resourceKeys: [PROJECT_NETWORK_RESOURCE] },
      })
    } finally {
      lease.release()
    }
  }

  async acquireEmbedding(request: EmbeddingSchedulingRequest): Promise<MainProcessSchedulerPermit> {
    let origin: string
    try {
      const endpoint = new URL(embeddingRequestUrl(request.configuration.protocol, request.configuration.model))
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw new Error('SCHEDULER_SUBJECT_ENDPOINT_INVALID')
      }
      origin = endpoint.origin
    }
    catch { throw new Error('SCHEDULER_SUBJECT_ENDPOINT_INVALID') }
    const lease = this.#subjects.capture({ baseUrl: origin, apiKey: request.configuration.model.apiKey,
      modelName: request.configuration.model.modelName || (request.configuration.protocol === 'gemini' ? 'gemini-embedding-001' : 'text-embedding-3-small') })
    try {
      return await this.#scheduler.acquire({ projectKey: request.projectKey, subject: lease.subject,
        lane: request.lane, signal: request.signal, claims: { readResourceKeys: [PROJECT_NETWORK_RESOURCE] } })
    } finally { lease.release() }
  }

  async acquireNetwork(request: NetworkSchedulingRequest): Promise<MainProcessSchedulerPermit> {
    const lease = this.#subjects.capture({ baseUrl: request.endpoint,
      apiKey: request.apiKey, modelName: request.modelName })
    try {
      return await this.#scheduler.acquire({ projectKey: request.projectKey, subject: lease.subject,
        lane: request.lane, signal: request.signal, claims: { readResourceKeys: [PROJECT_NETWORK_RESOURCE] } })
    } finally { lease.release() }
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

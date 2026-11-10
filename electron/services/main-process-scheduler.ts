import type { WorkflowResourceClaims } from '../../src/shared/workflow-resource-claims'
import { MainResourceClaimRegistry, normalizeMainResourceClaims, type MainResourceClaimLease } from './main-resource-claims'
import type { SchedulerNetworkSubject } from './scheduler-network-subject'
import { performanceStarted, recordPerformanceCount, recordPerformanceDuration, recordPerformanceMetric } from './performance-diagnostics'

export interface MainProcessSchedulerPolicy {
  readonly global: number
  readonly provider: number
  readonly credential: number
  readonly model: number
  readonly project: number
  readonly maxQueued: number
  readonly maxQuarantined: number
  /** Maximum consecutive interactive grants while a background head is runnable. */
  readonly interactiveBurst: number
}

export type SchedulerLane = 'interactive' | 'background'
export type SchedulerAdmissionErrorCode =
  | 'SCHEDULER_INVALID_POLICY'
  | 'SCHEDULER_SUBJECT_INVALID'
  | 'SCHEDULER_CLOSED'
  | 'SCHEDULER_CANCELLED'
  | 'SCHEDULER_QUEUE_FULL'
  | 'SCHEDULER_CREDENTIAL_BUSY'

export class SchedulerAdmissionError extends Error {
  constructor(readonly code: SchedulerAdmissionErrorCode) {
    super(code)
    this.name = 'SchedulerAdmissionError'
  }
}

export interface SchedulerAcquireRequest {
  readonly projectKey: string
  readonly subject: SchedulerNetworkSubject
  readonly lane: SchedulerLane
  readonly claims?: WorkflowResourceClaims
  readonly signal?: AbortSignal
}

export interface MainProcessSchedulerPermit {
  /** Call only after real local provider settlement/confirmed close, not a cancellation race. */
  finish(): void
  /** False means finished or quarantine full; an active permit then remains held. */
  quarantine(): boolean
}

export interface MainProcessSchedulerStats {
  readonly active: number
  /** Physical local transports including quarantine; all network limits include this debt. */
  readonly occupied: number
  readonly queued: number
  readonly quarantined: number
  readonly blockedCredentials: number
  readonly closed: boolean
}

interface QueueEntry {
  readonly projectKey: string
  readonly subject: SchedulerNetworkSubject
  readonly releaseSubject: () => void
  readonly lane: SchedulerLane
  readonly claims: WorkflowResourceClaims
  readonly signal?: AbortSignal
  readonly resolve: (permit: MainProcessSchedulerPermit) => void
  readonly reject: (error: SchedulerAdmissionError) => void
  /** Queued admission only; pre-queue rejection and physical lifetime have no wait sample. */
  readonly waitStarted: number | null
  onAbort?: () => void
  queued: boolean
}

interface ProjectQueue {
  readonly projectKey: string
  readonly interactive: QueueEntry[]
  readonly background: QueueEntry[]
}

interface InFlight {
  readonly projectKey: string
  readonly subject: SchedulerNetworkSubject
  readonly releaseSubject: () => void
  readonly resources: MainResourceClaimLease
  state: 'active' | 'quarantined' | 'finished'
}

function adjustCount(counts: Map<string, number>, key: string, delta: 1 | -1): void {
  const next = (counts.get(key) ?? 0) + delta
  if (next === 0) counts.delete(key)
  else counts.set(key, next)
}

/** Admission only: callers still recheck grant/epoch/source/ledger before physical dispatch. */
export class MainProcessScheduler {
  private readonly policy: MainProcessSchedulerPolicy
  private readonly projects: ProjectQueue[] = []
  private readonly active = new Set<InFlight>()
  private readonly quarantined = new Set<InFlight>()
  private readonly blockedCredentials = new Map<string, InFlight>()
  private readonly providerCounts = new Map<string, number>()
  private readonly credentialCounts = new Map<string, number>()
  private readonly modelCounts = new Map<string, number>()
  private readonly projectCounts = new Map<string, number>()
  private readonly unsubscribeResources: () => void
  private queued = 0
  private interactiveStreak = 0
  private closed = false

  constructor(
    policy: MainProcessSchedulerPolicy,
    private readonly retainSubject: (subject: SchedulerNetworkSubject) => () => void,
    private readonly resources = new MainResourceClaimRegistry(),
  ) {
    const snapshot = {
      global: policy.global, provider: policy.provider, credential: policy.credential,
      model: policy.model, project: policy.project, maxQueued: policy.maxQueued,
      maxQuarantined: policy.maxQuarantined, interactiveBurst: policy.interactiveBurst,
    }
    if (!Object.values(snapshot).every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new SchedulerAdmissionError('SCHEDULER_INVALID_POLICY')
    }
    this.policy = Object.freeze(snapshot)
    this.unsubscribeResources = this.resources.onRelease(() => { this.drain() })
  }

  acquire(request: SchedulerAcquireRequest): Promise<MainProcessSchedulerPermit> {
    recordPerformanceCount('scheduler.acquire.calls')
    if (this.closed || request.signal?.aborted) {
      recordPerformanceCount('scheduler.acquire.rejected')
      return Promise.reject(new SchedulerAdmissionError(this.closed ? 'SCHEDULER_CLOSED' : 'SCHEDULER_CANCELLED'))
    }

    return new Promise((resolve, reject) => {
      let claims: WorkflowResourceClaims
      try { claims = normalizeMainResourceClaims(request.claims) }
      catch (error) { recordPerformanceCount('scheduler.acquire.rejected'); reject(error); return }
      let releaseSubject: () => void
      try {
        releaseSubject = this.retainSubject(request.subject)
      } catch {
        recordPerformanceCount('scheduler.acquire.rejected')
        reject(new SchedulerAdmissionError('SCHEDULER_SUBJECT_INVALID'))
        return
      }
      const entry: QueueEntry = {
        projectKey: request.projectKey, subject: request.subject, releaseSubject,
        lane: request.lane, claims, signal: request.signal, resolve, reject, queued: true,
        waitStarted: performanceStarted(),
      }
      let project = this.projects.find(value => value.projectKey === entry.projectKey)
      if (!project) {
        project = { projectKey: entry.projectKey, interactive: [], background: [] }
        this.projects.push(project)
      }
      project[entry.lane].push(entry)
      this.queued += 1
      recordPerformanceMetric('scheduler.queue', this.queued)
      entry.onAbort = () => {
        if (!entry.queued) return
        this.rejectQueued(entry, 'SCHEDULER_CANCELLED')
        this.drain()
      }
      entry.signal?.addEventListener('abort', entry.onAbort, { once: true })
      if (entry.signal?.aborted) entry.onAbort()
      this.drain()

      // Immediately granted requests consume no waiting capacity. This whole
      // enqueue/admit/check sequence is synchronous and holds no partial claims.
      if (entry.queued && this.queued > this.policy.maxQueued) this.rejectQueued(entry, 'SCHEDULER_QUEUE_FULL')
    })
  }

  cancelProject(projectKey: string): number {
    const project = this.projects.find(value => value.projectKey === projectKey)
    if (!project) return 0
    const entries = [...project.interactive, ...project.background]
    for (const entry of entries) this.rejectQueued(entry, 'SCHEDULER_CANCELLED')
    this.drain()
    return entries.length
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeResources()
    for (const project of [...this.projects]) {
      for (const entry of [...project.interactive, ...project.background]) this.rejectQueued(entry, 'SCHEDULER_CLOSED')
    }
    for (const [credential, entry] of this.blockedCredentials) {
      if (entry.state === 'finished') {
        entry.releaseSubject()
        this.blockedCredentials.delete(credential)
      }
    }
  }

  /** Explicit operator action; a late finish never silently unblocks the channel. */
  resetCredential(credential: string): void {
    for (const entry of [...this.active, ...this.quarantined]) {
      if (entry.subject.credential === credential) throw new SchedulerAdmissionError('SCHEDULER_CREDENTIAL_BUSY')
    }
    this.blockedCredentials.get(credential)?.releaseSubject()
    this.blockedCredentials.delete(credential)
    this.drain()
  }

  getStats(): MainProcessSchedulerStats {
    return Object.freeze({
      active: this.active.size,
      occupied: this.active.size + this.quarantined.size,
      queued: this.queued,
      quarantined: this.quarantined.size,
      blockedCredentials: this.blockedCredentials.size,
      closed: this.closed,
    })
  }

  private rejectQueued(entry: QueueEntry, code: SchedulerAdmissionErrorCode): void {
    this.removeQueued(entry)
    recordPerformanceMetric('scheduler.queue', this.queued)
    recordPerformanceCount('scheduler.acquire.rejected')
    recordPerformanceDuration('scheduler.wait.rejected_ms', entry.waitStarted)
    entry.releaseSubject()
    entry.reject(new SchedulerAdmissionError(code))
  }

  private removeQueued(entry: QueueEntry): void {
    if (!entry.queued) return
    const projectIndex = this.projects.findIndex(value => value.projectKey === entry.projectKey)
    const project = this.projects[projectIndex]!
    const lane = project[entry.lane]
    lane.splice(lane.indexOf(entry), 1)
    entry.queued = false
    this.queued -= 1
    if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort)
    if (project.interactive.length === 0 && project.background.length === 0) this.projects.splice(projectIndex, 1)
  }

  private drain(): void {
    while (!this.closed
      && this.active.size + this.quarantined.size < this.policy.global
      && this.quarantined.size < this.policy.maxQuarantined) {
      if (this.interactiveStreak >= this.policy.interactiveBurst && this.dispatchNext('background')) continue
      if (this.dispatchNext('interactive')) continue
      if (!this.dispatchNext('background')) return
    }
  }

  private dispatchNext(lane: SchedulerLane): boolean {
    for (const project of this.projects) {
      const entry = project[lane][0]
      if (!entry || !this.hasNetworkCapacity(entry)) continue
      const resources = this.resources.tryAcquire(entry.projectKey, entry.claims)
      if (!resources) continue

      // No await/callback occurs between checking all network counts, acquiring
      // all resource claims, and charging the complete permit.
      this.removeQueued(entry)
      const remainingIndex = this.projects.indexOf(project)
      if (remainingIndex !== -1) this.projects.push(...this.projects.splice(remainingIndex, 1))
      const flight: InFlight = {
        projectKey: entry.projectKey, subject: entry.subject, releaseSubject: entry.releaseSubject,
        resources, state: 'active',
      }
      this.active.add(flight)
      this.changeCounts(flight, 1)
      this.interactiveStreak = lane === 'interactive'
        ? Math.min(this.policy.interactiveBurst, this.interactiveStreak + 1)
        : 0
      recordPerformanceMetric('scheduler.queue', this.queued)
      recordPerformanceCount('scheduler.acquire.admitted')
      recordPerformanceDuration('scheduler.wait.admitted_ms', entry.waitStarted)
      entry.resolve(Object.freeze({ finish: () => { this.finish(flight) }, quarantine: () => this.quarantine(flight) }))
      return true
    }
    return false
  }

  private hasNetworkCapacity(entry: QueueEntry): boolean {
    return !this.blockedCredentials.has(entry.subject.credential)
      && (this.providerCounts.get(entry.subject.provider) ?? 0) < this.policy.provider
      && (this.credentialCounts.get(entry.subject.credential) ?? 0) < this.policy.credential
      && (this.modelCounts.get(entry.subject.model) ?? 0) < this.policy.model
      && (this.projectCounts.get(entry.projectKey) ?? 0) < this.policy.project
  }

  private changeCounts(entry: InFlight, delta: 1 | -1): void {
    adjustCount(this.providerCounts, entry.subject.provider, delta)
    adjustCount(this.credentialCounts, entry.subject.credential, delta)
    adjustCount(this.modelCounts, entry.subject.model, delta)
    adjustCount(this.projectCounts, entry.projectKey, delta)
  }

  private finish(entry: InFlight): void {
    if (entry.state === 'finished') return
    this.active.delete(entry)
    this.quarantined.delete(entry)
    this.changeCounts(entry, -1)
    entry.state = 'finished'
    entry.resources.release()
    const ownsChannelHold = this.blockedCredentials.get(entry.subject.credential) === entry
    if (!ownsChannelHold || this.closed) entry.releaseSubject()
    if (ownsChannelHold && this.closed) this.blockedCredentials.delete(entry.subject.credential)
    this.drain()
  }

  private quarantine(entry: InFlight): boolean {
    if (entry.state === 'finished') return false
    if (entry.state === 'quarantined') return true
    // Keep one opaque grouping reference until reset, even after late finish;
    // otherwise recapturing the same credential could mint a fresh unblocked key.
    if (!this.blockedCredentials.has(entry.subject.credential)) this.blockedCredentials.set(entry.subject.credential, entry)
    if (this.quarantined.size >= this.policy.maxQuarantined) return false
    // Parking does not erase physical occupancy, network counts or claims.
    this.active.delete(entry)
    entry.state = 'quarantined'
    this.quarantined.add(entry)
    return true
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import {
  MainProcessScheduler,
  type MainProcessSchedulerPermit,
  type MainProcessSchedulerPolicy,
  type SchedulerAcquireRequest,
} from '../main-process-scheduler'
import { MainResourceClaimRegistry } from '../main-resource-claims'
import { SchedulerNetworkSubjectRegistry } from '../scheduler-network-subject'
import { readPerformanceDiagnostics } from '../performance-diagnostics'
import type { PerformanceMetric } from '../../../src/shared/performance-baseline'

const basePolicy: MainProcessSchedulerPolicy = {
  global: 8, provider: 8, credential: 8, model: 8, project: 8,
  maxQueued: 16, maxQuarantined: 4, interactiveBurst: 2,
}

function fixture(overrides: Partial<MainProcessSchedulerPolicy> = {}) {
  const subjects = new SchedulerNetworkSubjectRegistry(256)
  const resources = new MainResourceClaimRegistry()
  const scheduler = new MainProcessScheduler({ ...basePolicy, ...overrides }, subject => subjects.retain(subject), resources)
  const model = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
    id: 'fictional-profile', name: 'Fictional profile', provider: 'custom', protocol: 'openai',
    modelName: 'fictional-model', apiKey: 'fictional-key', baseUrl: 'https://fictional.invalid/v1',
    temperature: 0.5, maxTokens: 128, purposes: ['generation'], ...overrides,
  })
  const capture = (overrides: Partial<ModelProfile> = {}) => subjects.capture(model(overrides))
  const standard = capture()
  const request = (overrides: Partial<SchedulerAcquireRequest> = {}): SchedulerAcquireRequest => ({
    projectKey: 'fictional-a', subject: standard.subject, lane: 'background', ...overrides,
  })
  return { scheduler, resources, subjects, capture, standard, request }
}

function observed(promise: Promise<MainProcessSchedulerPermit>) {
  const result: { permit?: MainProcessSchedulerPermit; code?: string } = {}
  const settled = promise.then(permit => { result.permit = permit }, (error: { code: string }) => { result.code = error.code })
  return { result, settled }
}

describe('main process scheduler', () => {
  it.each(Object.keys(basePolicy) as (keyof MainProcessSchedulerPolicy)[])('requires an explicit finite positive integer %s', key => {
    for (const invalid of [undefined, 0, -1, 1.5, Infinity, NaN]) {
      expect(() => new MainProcessScheduler({ ...basePolicy, [key]: invalid } as MainProcessSchedulerPolicy, () => () => {}))
        .toThrow('SCHEDULER_INVALID_POLICY')
    }
  })

  it('snapshots the caller policy instead of accepting later limit mutation', async () => {
    const policy = { ...basePolicy, global: 1 }
    const subjects = new SchedulerNetworkSubjectRegistry(8)
    const subject = subjects.capture({
      id: 'fictional', name: 'Fictional', provider: 'custom', protocol: 'openai', modelName: 'fictional',
      apiKey: 'fictional', baseUrl: 'https://fictional.invalid', temperature: 0, maxTokens: 1, purposes: [],
    })
    const scheduler = new MainProcessScheduler(policy, value => subjects.retain(value))
    const request = { projectKey: 'fictional-a', subject: subject.subject, lane: 'background' as const }
    const first = await scheduler.acquire(request)
    policy.global = 8
    const queued = observed(scheduler.acquire(request))
    await Promise.resolve()
    expect(queued.result.permit).toBeUndefined()
    first.finish()
    await queued.settled
    queued.result.permit!.finish()
    subject.release()
  })
  it.each(['global', 'provider', 'credential', 'model', 'project'] as const)('enforces %s limits independently', async dimension => {
    const f = fixture({ [dimension]: 1 })
    const first = await f.scheduler.acquire(f.request())
    const blocked = observed(f.scheduler.acquire(f.request()))
    await Promise.resolve()
    expect(blocked.result.permit).toBeUndefined()
    expect(f.resources.getStats().active).toBe(1)
    let independent: MainProcessSchedulerPermit | undefined
    if (dimension !== 'global') {
      const other = f.capture(dimension === 'provider' ? { baseUrl: 'https://other.invalid' }
        : dimension === 'credential' ? { apiKey: 'other-fictional-key' }
          : dimension === 'model' ? { modelName: 'other-fictional-model' } : {})
      independent = await f.scheduler.acquire(f.request({
        subject: other.subject, projectKey: 'fictional-b',
      }))
      expect(f.scheduler.getStats().occupied).toBe(2)
    }
    first.finish()
    await blocked.settled
    expect(blocked.result.permit).toBeDefined()
    blocked.result.permit!.finish()
    independent?.finish()
    expect(f.scheduler.getStats().occupied).toBe(0)
  })

  it('groups profile and protocol aliases of the same remote model under model capacity', async () => {
    const f = fixture({ model: 1 })
    const alias = f.capture({ id: 'other-profile', protocol: 'anthropic', apiKey: 'other-key' })
    const first = await f.scheduler.acquire(f.request())
    const second = observed(f.scheduler.acquire(f.request({ projectKey: 'fictional-b', subject: alias.subject })))
    await Promise.resolve()
    expect(second.result.permit).toBeUndefined()
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
    first.finish()
    await second.settled
    expect(second.result.permit).toBeDefined()
    second.result.permit!.finish()
  })

  it('rotates runnable projects while preserving each project lane FIFO', async () => {
    const f = fixture({ global: 1 })
    const first = await f.scheduler.acquire(f.request({ projectKey: 'blocker' }))
    const order: string[] = []
    const enqueue = (projectKey: string, name: string) => f.scheduler.acquire(f.request({ projectKey })).then(permit => {
      order.push(name)
      return permit
    })
    const a1 = enqueue('a', 'a1'), a2 = enqueue('a', 'a2'), a3 = enqueue('a', 'a3')
    const b1 = enqueue('b', 'b1'), b2 = enqueue('b', 'b2')
    first.finish()
    ;(await a1).finish()
    ;(await b1).finish()
    ;(await a2).finish()
    ;(await b2).finish()
    ;(await a3).finish()
    expect(order).toEqual(['a1', 'b1', 'a2', 'b2', 'a3'])
  })

  it('gives interactive the next opportunity but bounds its burst to protect background', async () => {
    const f = fixture({ global: 1, interactiveBurst: 2 })
    const first = await f.scheduler.acquire(f.request())
    const order: string[] = []
    const enqueue = (name: string, lane: 'background' | 'interactive') => f.scheduler.acquire(f.request({ projectKey: name[0], lane })).then(permit => {
      order.push(name)
      return permit
    })
    const background = enqueue('background', 'background')
    const i1 = enqueue('i1', 'interactive'), i2 = enqueue('i2', 'interactive'), i3 = enqueue('i3', 'interactive')
    first.finish()
    ;(await i1).finish()
    ;(await i2).finish()
    ;(await background).finish()
    ;(await i3).finish()
    expect(order).toEqual(['i1', 'i2', 'background', 'i3'])
  })

  it('lets either lane use otherwise idle slots without preempting dispatched work', async () => {
    const f = fixture({ global: 2 })
    const first = await f.scheduler.acquire(f.request({ lane: 'interactive' }))
    const second = await f.scheduler.acquire(f.request({ lane: 'interactive' }))
    const background = observed(f.scheduler.acquire(f.request()))
    await Promise.resolve()
    expect(f.scheduler.getStats()).toMatchObject({ active: 2, queued: 1 })
    expect(background.result.permit).toBeUndefined()
    first.finish()
    await background.settled
    background.result.permit!.finish()
    second.finish()
  })

  it('skips a blocked book, keeps same-lane FIFO and holds no partial claims while queued', async () => {
    const f = fixture({ global: 3 })
    const first = await f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:1'] } }))
    const blocked = observed(f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:2', 'chapter:1'] } })))
    const later = observed(f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:2'] } })))
    const other = await f.scheduler.acquire(f.request({ projectKey: 'fictional-b', claims: { resourceKeys: ['chapter:1'] } }))
    const interactive = await f.scheduler.acquire(f.request({ lane: 'interactive', claims: { resourceKeys: ['chapter:3'] } }))
    await Promise.resolve()
    expect(blocked.result.permit).toBeUndefined()
    expect(later.result.permit).toBeUndefined()
    expect(f.resources.getStats().active).toBe(3)
    first.finish()
    await blocked.settled
    expect(blocked.result.permit).toBeDefined()
    expect(later.result.permit).toBeUndefined()
    blocked.result.permit!.finish()
    await later.settled
    later.result.permit!.finish()
    other.finish()
    interactive.finish()
    expect(f.resources.getStats().active).toBe(0)
  })

  it('rejects queue overflow without claims or retained subject leaks', async () => {
    const f = fixture({ global: 1, maxQueued: 1 })
    const first = await f.scheduler.acquire(f.request())
    const waiting = observed(f.scheduler.acquire(f.request()))
    const before = f.subjects.stats().leases
    await expect(f.scheduler.acquire(f.request())).rejects.toMatchObject({ code: 'SCHEDULER_QUEUE_FULL' })
    expect(f.scheduler.getStats()).toMatchObject({ active: 1, queued: 1 })
    expect(f.resources.getStats().active).toBe(1)
    expect(f.subjects.stats().leases).toBe(before)
    first.finish()
    await waiting.settled
    waiting.result.permit!.finish()
    expect(f.subjects.stats().leases).toBe(1)
  })

  it('wakes a resource-only wait when an external domain writer releases its shared claim', async () => {
    const f = fixture()
    const domain = f.resources.tryAcquire('fictional-a', { resourceKeys: ['chapter:1'] })!
    const waiting = observed(f.scheduler.acquire(f.request({ claims: { readResourceKeys: ['chapter:1'] } })))
    await Promise.resolve()
    expect(waiting.result.permit).toBeUndefined()
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, queued: 1 })
    domain.release()
    await waiting.settled
    expect(waiting.result.permit).toBeDefined()
    domain.release()
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 0 })
    waiting.result.permit!.finish()
  })

  it('can immediately grant an unrelated subject even when the waiting queue is full', async () => {
    const f = fixture({ global: 2, credential: 1, maxQueued: 1 })
    const first = await f.scheduler.acquire(f.request())
    const waiting = observed(f.scheduler.acquire(f.request()))
    const other = f.capture({ apiKey: 'other-key' })
    const independent = await f.scheduler.acquire(f.request({ subject: other.subject, projectKey: 'fictional-b' }))
    expect(f.scheduler.getStats()).toMatchObject({ active: 2, queued: 1 })
    independent.finish()
    first.finish()
    await waiting.settled
    waiting.result.permit!.finish()
  })

  it('rejects forged, cloned and expired subjects without claiming network or resources', async () => {
    const f = fixture()
    const expired = f.capture()
    expired.release()
    for (const subject of [
      { provider: 'forged', credential: 'forged', model: 'forged' },
      { ...f.standard.subject },
      expired.subject,
    ]) {
      await expect(f.scheduler.acquire(f.request({ subject }))).rejects.toMatchObject({ code: 'SCHEDULER_SUBJECT_INVALID' })
    }
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
    expect(f.resources.getStats().active).toBe(0)
    expect(f.subjects.stats().leases).toBe(1)
  })

  it('retains group identity independently of early caller release through queue and transport life', async () => {
    const f = fixture({ credential: 1 })
    const first = await f.scheduler.acquire(f.request())
    const waiting = observed(f.scheduler.acquire(f.request()))
    const credential = f.standard.subject.credential
    f.standard.release()
    const recaptured = f.capture()
    expect(recaptured.subject.credential).toBe(credential)
    const next = observed(f.scheduler.acquire(f.request({ subject: recaptured.subject })))
    first.finish()
    await waiting.settled
    expect(waiting.result.permit).toBeDefined()
    expect(next.result.permit).toBeUndefined()
    waiting.result.permit!.finish()
    await next.settled
    next.result.permit!.finish()
    recaptured.release()
    expect(f.subjects.stats()).toEqual({ subjects: 0, leases: 0 })
  })

  it('snapshots queued claims rather than observing caller mutation', async () => {
    const f = fixture({ global: 2 })
    const first = await f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:1'] } }))
    const keys = ['chapter:1']
    const waiting = observed(f.scheduler.acquire(f.request({ claims: { resourceKeys: keys } })))
    keys[0] = 'chapter:2'
    const other = await f.scheduler.acquire(f.request({ lane: 'interactive', claims: { resourceKeys: ['chapter:2'] } }))
    await Promise.resolve()
    expect(waiting.result.permit).toBeUndefined()
    first.finish()
    await waiting.settled
    waiting.result.permit!.finish()
    other.finish()
  })

  it('rejects an already aborted request and removes an aborted queued head without touching active work', async () => {
    const f = fixture({ global: 1 })
    const already = new AbortController()
    already.abort('fictional-private-reason')
    await expect(f.scheduler.acquire(f.request({ signal: already.signal }))).rejects.toMatchObject({ code: 'SCHEDULER_CANCELLED' })
    const first = await f.scheduler.acquire(f.request())
    const abort = new AbortController()
    const waiting = observed(f.scheduler.acquire(f.request({ signal: abort.signal, claims: { resourceKeys: ['chapter:1'] } })))
    const later = observed(f.scheduler.acquire(f.request()))
    abort.abort('fictional-private-reason')
    await waiting.settled
    expect(waiting.result.code).toBe('SCHEDULER_CANCELLED')
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
    expect(f.resources.getStats().active).toBe(1)
    first.finish()
    await later.settled
    later.result.permit!.finish()
    expect(f.subjects.stats().leases).toBe(1)
  })

  it.each([true, false])('linearizes abort/finish microtasks without double release (abort first %s)', async abortFirst => {
    const f = fixture({ global: 1 })
    const first = await f.scheduler.acquire(f.request())
    const abort = new AbortController()
    const waiting = observed(f.scheduler.acquire(f.request({ signal: abort.signal })))
    const abortQueued = () => { abort.abort() }
    const finish = () => { first.finish() }
    queueMicrotask(abortFirst ? abortQueued : finish)
    queueMicrotask(abortFirst ? finish : abortQueued)
    await waiting.settled
    if (abortFirst) {
      expect(waiting.result.code).toBe('SCHEDULER_CANCELLED')
      expect(f.scheduler.getStats().occupied).toBe(0)
    } else {
      expect(waiting.result.permit).toBeDefined()
      expect(f.scheduler.getStats().occupied).toBe(1)
      waiting.result.permit!.finish()
    }
    first.finish()
    expect(f.resources.getStats().active).toBe(0)
    expect(f.subjects.stats().leases).toBe(1)
  })

  it('does not release an ignored-abort transport until its real finally', async () => {
    const f = fixture({ global: 1 })
    const abort = new AbortController()
    const first = await f.scheduler.acquire(f.request({ signal: abort.signal, claims: { resourceKeys: ['chapter:1'] } }))
    const waiting = observed(f.scheduler.acquire(f.request()))
    abort.abort()
    await Promise.resolve()
    expect(waiting.result.permit).toBeUndefined()
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
    expect(f.resources.getStats().active).toBe(1)
    first.finish()
    await waiting.settled
    waiting.result.permit!.finish()
  })

  it('cancels only queued requests for the exact project and is safe in promise callbacks', async () => {
    const f = fixture({ global: 1 })
    const first = await f.scheduler.acquire(f.request())
    const waiting = observed(f.scheduler.acquire(f.request()))
    const other = observed(f.scheduler.acquire(f.request({ projectKey: 'fictional-ab' })))
    expect(f.scheduler.cancelProject('fictional-a')).toBe(1)
    expect(f.scheduler.cancelProject('fictional-a')).toBe(0)
    await waiting.settled
    expect(waiting.result.code).toBe('SCHEDULER_CANCELLED')
    expect(f.scheduler.getStats().occupied).toBe(1)
    first.finish()
    await other.settled
    const nested = observed(f.scheduler.acquire(f.request({ projectKey: 'fictional-ab' })))
    await Promise.resolve().then(() => { expect(f.scheduler.cancelProject('fictional-ab')).toBe(1) })
    await nested.settled
    expect(nested.result.code).toBe('SCHEDULER_CANCELLED')
    expect(f.scheduler.getStats().occupied).toBe(1)
    other.result.permit!.finish()
  })

  it.each(['global', 'provider', 'model', 'project'] as const)('keeps quarantine debt inside the %s physical limit', async dimension => {
    const f = fixture({ [dimension]: 1 })
    const first = await f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:1'] } }))
    expect(first.quarantine()).toBe(true)
    expect(first.quarantine()).toBe(true)
    const other = f.capture({
      apiKey: 'other-fictional-key',
      ...(dimension === 'provider' || dimension === 'model' ? {} : { baseUrl: 'https://other.invalid' }),
      ...(dimension === 'model' ? {} : { modelName: 'other-model' }),
    })
    const waiting = observed(f.scheduler.acquire(f.request({
      subject: other.subject, projectKey: dimension === 'project' ? 'fictional-a' : 'fictional-b',
    })))
    await Promise.resolve()
    expect(waiting.result.permit).toBeUndefined()
    expect(f.scheduler.getStats()).toMatchObject({ active: 0, occupied: 1, quarantined: 1, queued: 1 })
    expect(f.resources.getStats().active).toBe(1)
    first.finish()
    await waiting.settled
    expect(waiting.result.permit).toBeDefined()
    waiting.result.permit!.finish()
    f.scheduler.resetCredential(f.standard.subject.credential)
  })

  it('bounds quarantine, halts all admissions at its cap, and does not free overflow permits', async () => {
    const f = fixture({ global: 4, maxQuarantined: 1 })
    const secondSubject = f.capture({ apiKey: 'second-key' })
    const thirdSubject = f.capture({ apiKey: 'third-key' })
    const first = await f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:1'] } }))
    const second = await f.scheduler.acquire(f.request({ subject: secondSubject.subject }))
    expect(first.quarantine()).toBe(true)
    const waiting = observed(f.scheduler.acquire(f.request({ subject: thirdSubject.subject, claims: { resourceKeys: ['chapter:1'] } })))
    expect(second.quarantine()).toBe(false)
    expect(second.quarantine()).toBe(false)
    await Promise.resolve()
    expect(waiting.result.permit).toBeUndefined()
    expect(f.scheduler.getStats()).toMatchObject({ active: 1, occupied: 2, quarantined: 1, blockedCredentials: 2, queued: 1 })
    expect(f.resources.getStats().active).toBe(2)
    first.finish()
    await waiting.settled
    expect(waiting.result.permit).toBeDefined()
    expect(f.scheduler.getStats()).toMatchObject({ active: 2, occupied: 2, quarantined: 0 })
    first.finish()
    expect(f.scheduler.getStats().occupied).toBe(2)
    second.finish()
    waiting.result.permit!.finish()
    f.scheduler.resetCredential(f.standard.subject.credential)
    f.scheduler.resetCredential(secondSubject.subject.credential)
    expect(f.resources.getStats().active).toBe(0)
  })

  it('holds resource claims throughout quarantine and skips that blocked book', async () => {
    const f = fixture({ global: 3, maxQuarantined: 2 })
    const otherSubject = f.capture({ apiKey: 'other-key' })
    const first = await f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:1'] } }))
    first.quarantine()
    const blocked = observed(f.scheduler.acquire(f.request({ subject: otherSubject.subject, claims: { readResourceKeys: ['chapter:1'] } })))
    const other = await f.scheduler.acquire(f.request({ subject: otherSubject.subject, projectKey: 'fictional-b', claims: { resourceKeys: ['chapter:1'] } }))
    await Promise.resolve()
    expect(blocked.result.permit).toBeUndefined()
    expect(f.scheduler.getStats()).toMatchObject({ active: 1, occupied: 2, quarantined: 1, queued: 1 })
    expect(() => f.scheduler.resetCredential(f.standard.subject.credential)).toThrow('SCHEDULER_CREDENTIAL_BUSY')
    first.finish()
    await blocked.settled
    blocked.result.permit!.finish()
    other.finish()
    f.scheduler.resetCredential(f.standard.subject.credential)
  })

  it('keeps the credential stopped after late finish and recapture until explicit idle reset', async () => {
    const f = fixture({ credential: 1, maxQuarantined: 2 })
    const first = await f.scheduler.acquire(f.request())
    const credential = f.standard.subject.credential
    f.standard.release()
    expect(first.quarantine()).toBe(true)
    expect(() => f.scheduler.resetCredential(credential)).toThrow('SCHEDULER_CREDENTIAL_BUSY')
    first.finish()
    first.finish()
    expect(first.quarantine()).toBe(false)
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, quarantined: 0, blockedCredentials: 1 })
    const recaptured = f.capture()
    expect(recaptured.subject.credential).toBe(credential)
    const waiting = observed(f.scheduler.acquire(f.request({ subject: recaptured.subject })))
    await Promise.resolve()
    expect(waiting.result.permit).toBeUndefined()
    f.scheduler.resetCredential(credential)
    await waiting.settled
    expect(waiting.result.permit).toBeDefined()
    expect(() => f.scheduler.resetCredential(credential)).toThrow('SCHEDULER_CREDENTIAL_BUSY')
    waiting.result.permit!.finish()
    f.scheduler.resetCredential(credential)
    recaptured.release()
    expect(f.subjects.stats()).toEqual({ subjects: 0, leases: 0 })
  })

  it('closes queued work, keeps actual active/quarantine lifetime and releases blocked holds at final close', async () => {
    const f = fixture({ global: 2, maxQuarantined: 2 })
    const otherSubject = f.capture({ apiKey: 'other-key' })
    const first = await f.scheduler.acquire(f.request())
    const second = await f.scheduler.acquire(f.request({ subject: otherSubject.subject }))
    first.quarantine()
    const waiting = observed(f.scheduler.acquire(f.request()))
    f.scheduler.close()
    f.scheduler.close()
    await waiting.settled
    expect(waiting.result.code).toBe('SCHEDULER_CLOSED')
    await expect(f.scheduler.acquire(f.request())).rejects.toMatchObject({ code: 'SCHEDULER_CLOSED' })
    expect(f.scheduler.getStats()).toMatchObject({ closed: true, occupied: 2, active: 1, quarantined: 1, queued: 0 })
    expect(f.resources.getStats().active).toBe(2)
    first.finish()
    second.finish()
    f.standard.release()
    otherSubject.release()
    expect(f.subjects.stats()).toEqual({ subjects: 0, leases: 0 })
    expect(f.resources.getStats().active).toBe(0)
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, blockedCredentials: 0 })
  })

  it('duplicate and late finish cannot release a later permit or its claims', async () => {
    const f = fixture({ global: 1 })
    const first = await f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:1'] } }))
    const second = observed(f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:1'] } })))
    first.finish()
    await second.settled
    first.finish()
    expect(first.quarantine()).toBe(false)
    expect(f.scheduler.getStats().occupied).toBe(1)
    expect(f.resources.getStats().active).toBe(1)
    second.result.permit!.finish()
    second.result.permit!.finish()
    expect(f.scheduler.getStats().occupied).toBe(0)
  })

  it('reports only frozen counts and safe codes, never project, subject, resource or abort reason', async () => {
    const f = fixture({ global: 1, maxQueued: 1 })
    const first = await f.scheduler.acquire(f.request({ projectKey: 'fictional-private-project', claims: { resourceKeys: ['fictional-private-body'] } }))
    const abort = new AbortController()
    const waiting = observed(f.scheduler.acquire(f.request({ signal: abort.signal })))
    abort.abort('fictional-private-abort-reason')
    await waiting.settled
    const stats = f.scheduler.getStats()
    expect(Object.isFrozen(stats)).toBe(true)
    expect(Object.keys(stats).sort()).toEqual(['active', 'blockedCredentials', 'closed', 'occupied', 'quarantined', 'queued'])
    expect(JSON.stringify(stats)).not.toMatch(/fictional|provider|credential|model|project|body|reason/u)
    expect(waiting.result.code).toBe('SCHEDULER_CANCELLED')
    first.finish()
  })
})

describe('scheduler performance observation', () => {
  let now = 10
  let previousFlag: string | undefined
  let before: ReturnType<typeof readPerformanceDiagnostics>
  const sum = (name: PerformanceMetric) => (readPerformanceDiagnostics().metrics[name]?.sum ?? 0) - (before.metrics[name]?.sum ?? 0)
  const count = (name: PerformanceMetric) => (readPerformanceDiagnostics().metrics[name]?.count ?? 0) - (before.metrics[name]?.count ?? 0)

  beforeEach(() => {
    previousFlag = process.env.PAGEKIN_PERFORMANCE_BASELINE
    process.env.PAGEKIN_PERFORMANCE_BASELINE = '1'
    before = readPerformanceDiagnostics()
    now = 10
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.PAGEKIN_PERFORMANCE_BASELINE
    else process.env.PAGEKIN_PERFORMANCE_BASELINE = previousFlag
    vi.restoreAllMocks()
  })

  it('samples immediate and queued admission once, never physical finish or quarantine', async () => {
    const f = fixture({ global: 1 })
    const abort = new AbortController()
    const first = await f.scheduler.acquire(f.request({ signal: abort.signal }))
    const waiting = observed(f.scheduler.acquire(f.request()))
    now = 45
    first.finish()
    await waiting.settled
    expect(sum('scheduler.acquire.calls')).toBe(2)
    expect(sum('scheduler.acquire.admitted')).toBe(2)
    expect(sum('scheduler.acquire.rejected')).toBe(0)
    expect(count('scheduler.wait.admitted_ms')).toBe(2)
    expect(sum('scheduler.wait.admitted_ms')).toBe(35)
    expect(count('scheduler.wait.rejected_ms')).toBe(0)
    expect(count('scheduler.queue')).toBe(4)
    expect(sum('scheduler.queue')).toBe(2)
    const settled = readPerformanceDiagnostics()
    now = 1000
    abort.abort('private-abort-reason')
    first.finish()
    expect(waiting.result.permit!.quarantine()).toBe(true)
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, quarantined: 1 })
    waiting.result.permit!.finish()
    waiting.result.permit!.finish()
    f.scheduler.resetCredential(f.standard.subject.credential)
    f.scheduler.close()
    expect(readPerformanceDiagnostics()).toEqual(settled)
    expect(f.resources.getStats().active).toBe(0)
  })

  it.each(['cancel', 'project-cancel', 'close', 'full'] as const)('observes %s rejection once without changing active work', async action => {
    const f = fixture({ global: 1, maxQueued: 1 })
    const first = await f.scheduler.acquire(f.request())
    now = 20
    const abort = new AbortController()
    const waiting = observed(f.scheduler.acquire(f.request({ signal: abort.signal })))
    now = 50
    if (action === 'full') {
      await expect(f.scheduler.acquire(f.request())).rejects.toMatchObject({ code: 'SCHEDULER_QUEUE_FULL' })
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
      now = 60
      abort.abort()
    } else if (action === 'cancel') abort.abort()
    else if (action === 'project-cancel') expect(f.scheduler.cancelProject('fictional-a')).toBe(1)
    else f.scheduler.close()
    await waiting.settled
    expect(waiting.result.code).toBe(action === 'close' ? 'SCHEDULER_CLOSED' : 'SCHEDULER_CANCELLED')
    expect(sum('scheduler.acquire.calls')).toBe(action === 'full' ? 3 : 2)
    expect(sum('scheduler.acquire.admitted')).toBe(1)
    expect(sum('scheduler.acquire.rejected')).toBe(action === 'full' ? 2 : 1)
    expect(count('scheduler.wait.rejected_ms')).toBe(action === 'full' ? 2 : 1)
    expect(sum('scheduler.wait.rejected_ms')).toBe(action === 'full' ? 40 : 30)
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 0 })
    const settled = readPerformanceDiagnostics()
    abort.abort()
    f.scheduler.cancelProject('fictional-a')
    f.scheduler.close()
    first.finish()
    first.finish()
    expect(readPerformanceDiagnostics()).toEqual(settled)
    expect(f.resources.getStats().active).toBe(0)
  })

  it('counts pre-queue rejection without inventing queue depth or wait samples and preserves original claim errors', async () => {
    const f = fixture()
    const abort = new AbortController()
    abort.abort()
    await expect(f.scheduler.acquire(f.request({ signal: abort.signal }))).rejects.toMatchObject({ code: 'SCHEDULER_CANCELLED' })
    await expect(f.scheduler.acquire(f.request({ subject: { ...f.standard.subject } }))).rejects.toMatchObject({ code: 'SCHEDULER_SUBJECT_INVALID' })
    const original = new Error('private-claim-error')
    const claims = { get resourceKeys(): string[] { throw original } }
    await expect(f.scheduler.acquire(f.request({ claims }))).rejects.toBe(original)
    f.scheduler.close()
    await expect(f.scheduler.acquire(f.request())).rejects.toMatchObject({ code: 'SCHEDULER_CLOSED' })
    expect(sum('scheduler.acquire.calls')).toBe(4)
    expect(sum('scheduler.acquire.rejected')).toBe(4)
    expect(count('scheduler.queue')).toBe(0)
    expect(count('scheduler.wait.admitted_ms')).toBe(0)
    expect(count('scheduler.wait.rejected_ms')).toBe(0)
    expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
    expect(JSON.stringify(readPerformanceDiagnostics())).not.toContain('private-claim-error')
  })

  it('does no timing or recording when diagnostics are disabled', async () => {
    process.env.PAGEKIN_PERFORMANCE_BASELINE = '0'
    const f = fixture({ global: 1 })
    const first = await f.scheduler.acquire(f.request())
    const waiting = observed(f.scheduler.acquire(f.request()))
    f.scheduler.close()
    await waiting.settled
    first.finish()
    expect(performance.now).not.toHaveBeenCalled()
    expect(readPerformanceDiagnostics()).toEqual(before)
  })

  it.each(['clock', 'sink'] as const)('keeps admission, cancellation and physical claims intact after a diagnostic %s failure', async failure => {
    if (failure === 'clock') vi.mocked(performance.now).mockImplementation(() => { throw new Error('private-clock-error') })
    else vi.spyOn(Number, 'isFinite').mockImplementation(() => { throw new Error('private-sink-error') })
    const f = fixture({ global: 1 })
    const first = await f.scheduler.acquire(f.request({ claims: { resourceKeys: ['chapter:1'] } }))
    const abort = new AbortController()
    const waiting = observed(f.scheduler.acquire(f.request({ signal: abort.signal })))
    abort.abort()
    await waiting.settled
    const quarantined = first.quarantine()
    const stats = f.scheduler.getStats()
    const heldClaims = f.resources.getStats().active
    first.finish()
    f.scheduler.resetCredential(f.standard.subject.credential)
    vi.restoreAllMocks()
    expect(waiting.result.code).toBe('SCHEDULER_CANCELLED')
    expect(quarantined).toBe(true)
    expect(stats).toMatchObject({ occupied: 1, quarantined: 1, queued: 0 })
    expect(heldClaims).toBe(1)
    expect(f.resources.getStats().active).toBe(0)
    expect(count('scheduler.wait.admitted_ms')).toBe(0)
    expect(count('scheduler.wait.rejected_ms')).toBe(0)
    if (failure === 'sink') expect(readPerformanceDiagnostics()).toEqual(before)
    else expect(sum('scheduler.acquire.rejected')).toBe(1)
    expect(JSON.stringify(readPerformanceDiagnostics())).not.toMatch(/private-(?:clock|sink)-error/u)
  })
})

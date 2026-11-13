import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { MainGenerationScheduler } from '../generation-scheduler'
import type { MainProcessSchedulerPermit, MainProcessSchedulerPolicy } from '../main-process-scheduler'

const policy: MainProcessSchedulerPolicy = {
  global: 2, provider: 2, credential: 2, model: 2, project: 2,
  maxQueued: 8, maxQuarantined: 2, interactiveBurst: 2,
}

function profile(id: string, overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { id, name: id, provider: 'custom', protocol: 'openai', baseUrl: 'https://fixture.invalid/v1',
    apiKey: `fictional-${id}`, modelName: `model-${id}`, temperature: 0.5, maxTokens: 128,
    purposes: ['generation'], ...overrides }
}

function fixture(overrides: Partial<MainProcessSchedulerPolicy> = {}) {
  const scheduler = new MainGenerationScheduler({ ...policy, ...overrides }, 32)
  const permits: MainProcessSchedulerPermit[] = []
  const requests: Promise<MainProcessSchedulerPermit>[] = []
  function track(work: Promise<MainProcessSchedulerPermit>) {
    const tracked = work.then(permit => { permits.push(permit); return permit })
    void tracked.catch(() => {})
    requests.push(tracked)
    return tracked
  }
  function ordinary(model: ModelProfile, projectKey = 'book-a', signal = new AbortController().signal) {
    return track(scheduler.acquire({ projectKey, model, lane: 'background', signal }))
  }
  function query(model: ModelProfile, projectKey = 'book-a', signal = new AbortController().signal) {
    return track(scheduler.acquireEmbedding({ projectKey, configuration: { protocol: 'openai', model }, lane: 'background', signal }))
  }
  return { scheduler, ordinary, query, close: async () => {
    scheduler.close()
    await Promise.allSettled(requests)
    for (const permit of permits) permit.finish()
  } }
}

describe('generation scheduler query overlap', () => {
  it('keeps ordinary requests on one project exclusive', async () => {
    const f = fixture()
    try {
      const first = await f.ordinary(profile('one'))
      const second = f.ordinary(profile('two'))
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
      first.finish()
      ;(await second).finish()
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
    } finally { await f.close() }
  })

  it('shares query claims up to the project and global limit', async () => {
    const f = fixture()
    try {
      const first = await f.query(profile('one'))
      const second = await f.query(profile('two'))
      const third = f.query(profile('three'))
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 2, queued: 1 })
      first.finish()
      ;(await third).finish()
      second.finish()
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
    } finally { await f.close() }
  })

  it.each(['ordinary-first', 'query-first'] as const)('excludes the opposite request on the same project: %s', async order => {
    const f = fixture()
    try {
      const first = await (order === 'ordinary-first' ? f.ordinary(profile('one')) : f.query(profile('one')))
      const second = order === 'ordinary-first' ? f.query(profile('two')) : f.ordinary(profile('two'))
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
      first.finish()
      ;(await second).finish()
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
    } finally { await f.close() }
  })

  it('isolates the same claim across projects', async () => {
    const f = fixture()
    try {
      const first = await f.ordinary(profile('one'), 'book-a')
      const second = await f.query(profile('two'), 'book-b')
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 2, queued: 0 })
      first.finish(); second.finish()
    } finally { await f.close() }
  })

  it('keeps an aborted and quarantined query physically occupied until finish and requires credential reset', async () => {
    const f = fixture(), controller = new AbortController(), firstModel = profile('one')
    try {
      const first = await f.query(firstModel, 'book-a', controller.signal)
      controller.abort()
      const blocked = f.ordinary(profile('two'))
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
      expect(first.quarantine()).toBe(true)
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, quarantined: 1, queued: 1, blockedCredentials: 1 })
      first.finish()
      ;(await blocked).finish()
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, blockedCredentials: 1 })
      f.scheduler.resetCredential(firstModel)
      expect(f.scheduler.getStats()).toMatchObject({ blockedCredentials: 0, subjects: 0, subjectLeases: 0 })
    } finally { await f.close() }
  })

  it('cancels a queued conflicting query without retaining its subject or disturbing the flight', async () => {
    const f = fixture(), controller = new AbortController()
    try {
      const first = await f.ordinary(profile('one'))
      const waiting = f.query(profile('two'), 'book-a', controller.signal)
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
      const rejected = expect(waiting).rejects.toThrow('SCHEDULER_CANCELLED')
      controller.abort()
      await rejected
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 0, subjectLeases: 1 })
      first.finish()
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, subjects: 0, subjectLeases: 0 })
    } finally { await f.close() }
  })

  it.each(['provider', 'model'] as const)('still enforces the %s cap for shared queries', async dimension => {
    const f = fixture({ [dimension]: 1 }), shared = profile('same')
    try {
      const first = await f.query(shared)
      const second = f.query(shared)
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
      first.finish()
      ;(await second).finish()
      expect(f.scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
    } finally { await f.close() }
  })
})

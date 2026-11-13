import { afterEach, expect, it, vi } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { generateEmbeddings } from '../../embedding'
import { MainGenerationScheduler } from '../generation-scheduler'

const profile: ModelProfile = {
  id: 'fictional-query', name: 'fictional', provider: 'custom', protocol: 'openai',
  baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-key', modelName: 'fictional-generation',
  temperature: 0.5, maxTokens: 128, purposes: ['generation'],
}
const policy = { global: 2, provider: 2, credential: 1, model: 2, project: 2,
  maxQueued: 4, maxQuarantined: 2, interactiveBurst: 1 }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each(['openai', 'gemini'] as const)('rejects credentials in the actual %s embedding URL before admitting a transport', async protocol => {
  const scheduler = new MainGenerationScheduler(policy, 8)
  try {
    const pending = scheduler.acquireEmbedding({ projectKey: 'fictional', lane: 'background',
      signal: new AbortController().signal, configuration: { protocol,
        model: { ...profile, baseUrl: 'https://user:synthetic-password@fixture.invalid/v1' } } })
    await expect(pending.then(permit => { permit.finish(); return permit })).rejects.toThrow('SCHEDULER_SUBJECT_ENDPOINT_INVALID')
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0, subjects: 0 })
  } finally { scheduler.close() }
})

it.each(['openai', 'gemini'] as const)('groups actual %s embedding with the generation credential without rewriting its request', async protocol => {
  const scheduler = new MainGenerationScheduler(policy, 12)
  const configuration = { protocol, model: { provider: 'custom', baseUrl: profile.baseUrl,
    apiKey: profile.apiKey, modelName: 'fictional-embedding' } }
  const original = structuredClone(configuration)
  const controller = new AbortController()
  const first = await scheduler.acquire({ projectKey: 'first', model: profile, lane: 'interactive', signal: controller.signal })
  const waiting = scheduler.acquireEmbedding({ projectKey: 'second', configuration, lane: 'background', signal: controller.signal })
  expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
  first.finish()
  const permit = await waiting
  const fetch = vi.fn(async () => new Response(JSON.stringify(protocol === 'gemini'
    ? { embeddings: [{ values: [1, 0] }] } : { data: [{ index: 0, embedding: [1, 0] }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  try {
    expect(await generateEmbeddings(['fixed query'], protocol, configuration.model, 1, undefined, controller.signal)).toEqual([[1, 0]])
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(protocol === 'gemini'
      ? 'https://fixture.invalid/v1/v1beta/models/fictional-embedding:batchEmbedContents'
      : 'https://fixture.invalid/v1/embeddings')
    expect(init.signal).toBe(controller.signal)
    expect(init.headers).toEqual(protocol === 'gemini'
      ? { 'Content-Type': 'application/json', 'x-goog-api-key': 'synthetic-key' }
      : { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-key' })
    expect(configuration).toEqual(original)
    expect(scheduler.getStats().occupied).toBe(1)
  } finally { permit.finish(); scheduler.close() }
  expect(scheduler.getStats()).toMatchObject({ occupied: 0, subjects: 0, subjectLeases: 0 })
})

it('cancels a queued embedding without a transport or retained scheduler subject', async () => {
  const scheduler = new MainGenerationScheduler(policy, 8), controller = new AbortController()
  const first = await scheduler.acquire({ projectKey: 'first', model: profile, lane: 'interactive', signal: new AbortController().signal })
  const waiting = scheduler.acquireEmbedding({ projectKey: 'second', configuration: { protocol: 'openai', model: profile }, lane: 'background', signal: controller.signal })
  const rejected = expect(waiting).rejects.toThrow('SCHEDULER_CANCELLED')
  controller.abort()
  await rejected
  expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 0, subjectLeases: 1 })
  first.finish(); scheduler.close()
  expect(scheduler.getStats()).toMatchObject({ occupied: 0, subjects: 0, subjectLeases: 0 })
})

it('keeps embedding quarantine as physical debt until finish and an explicit credential reset', async () => {
  const scheduler = new MainGenerationScheduler(policy, 8), signal = new AbortController().signal
  const configuration = { protocol: 'openai' as const, model: profile }
  const first = await scheduler.acquireEmbedding({ projectKey: 'first', configuration, lane: 'background', signal })
  expect(first.quarantine()).toBe(true)
  const waiting = scheduler.acquire({ projectKey: 'second', model: profile, lane: 'interactive', signal })
  expect(scheduler.getStats()).toMatchObject({ occupied: 1, quarantined: 1, queued: 1 })
  first.finish()
  expect(scheduler.getStats()).toMatchObject({ occupied: 0, blockedCredentials: 1, queued: 1 })
  scheduler.resetCredential(profile)
  ;(await waiting).finish(); scheduler.close()
  expect(JSON.stringify(scheduler.getStats())).not.toContain(profile.apiKey)
  expect(scheduler.getStats()).toMatchObject({ occupied: 0, subjects: 0, subjectLeases: 0 })
})

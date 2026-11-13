import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { createMainNetworkScheduler, MainGenerationScheduler } from '../generation-scheduler'

const policy = { global: 2, provider: 2, credential: 2, model: 2, project: 2,
  maxQueued: 8, maxQuarantined: 2, interactiveBurst: 1 }
const model: ModelProfile = { id: 'fictional', name: 'fictional', provider: 'custom', protocol: 'openai',
  baseUrl: 'https://model.invalid/v1', apiKey: 'fictional-key', modelName: 'fictional-model',
  temperature: 0.5, maxTokens: 128, purposes: ['generation'] }
const signal = () => new AbortController().signal
const network = (projectKey: string) => ({ projectKey, endpoint: 'https://model.invalid/v1/models',
  apiKey: model.apiKey, modelName: model.modelName, lane: 'interactive' as const, signal: signal() })

describe('one main-process network scheduler', () => {
  it('accounts generation, embedding and direct requests against the same physical ceiling', async () => {
    const scheduler = new MainGenerationScheduler(policy, 30)
    const generation = await scheduler.acquire({ projectKey: 'runtime-a', model, lane: 'background', signal: signal() })
    const embedding = await scheduler.acquireEmbedding({ projectKey: 'runtime-b',
      configuration: { protocol: 'openai', model }, lane: 'background', signal: signal() })
    const direct = scheduler.acquireNetwork(network('application-outbound-network'))
    expect(scheduler.getStats()).toMatchObject({ occupied: 2, queued: 1 })
    generation.finish()
    const next = await direct
    expect(scheduler.getStats()).toMatchObject({ occupied: 2, queued: 0 })
    embedding.finish()
    next.finish()
    scheduler.close()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, subjects: 0, subjectLeases: 0 })
  })

  it('shares read claims but preserves ordinary generation exclusivity within a runtime', async () => {
    const scheduler = new MainGenerationScheduler({ ...policy, global: 3, provider: 3, credential: 3, model: 3, project: 3 }, 30)
    const direct = await scheduler.acquireNetwork(network('runtime-a'))
    const embedding = await scheduler.acquireEmbedding({ projectKey: 'runtime-a',
      configuration: { protocol: 'openai', model }, lane: 'background', signal: signal() })
    const generation = scheduler.acquire({ projectKey: 'runtime-a', model, lane: 'background', signal: signal() })
    expect(scheduler.getStats()).toMatchObject({ occupied: 2, queued: 1 })
    direct.finish()
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
    embedding.finish()
    ;(await generation).finish()
    scheduler.close()
    expect(scheduler.getStats().occupied).toBe(0)
  })

  it('coalesces actual origins and credentials without exposing transport configuration', async () => {
    const scheduler = new MainGenerationScheduler({ ...policy, credential: 1 }, 30)
    const first = await scheduler.acquireNetwork(network('runtime-a'))
    const request = { ...network('runtime-b'), endpoint: 'https://model.invalid/other/models?route=fictional',
      apiKey: ' fictional-key\t', modelName: 'another-fictional-model' }
    const before = { ...request }
    const second = scheduler.acquireNetwork(request)
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
    expect(request).toEqual(before)
    const diagnostics = JSON.stringify([scheduler, scheduler.getStats()])
    expect(diagnostics).not.toContain(model.apiKey)
    expect(diagnostics).not.toContain('model.invalid')
    first.finish()
    ;(await second).finish()
    scheduler.close()
  })

  it.each(['file:///fictional/models', 'https://name:secret@model.invalid/models', 'secret-invalid-url'])(
    'rejects invalid or credential-bearing generic endpoint without retaining subjects: %s', async endpoint => {
      const scheduler = createMainNetworkScheduler()
      await expect(scheduler.acquireNetwork({ ...network('application-outbound-network'), endpoint }))
        .rejects.toThrow('SCHEDULER_SUBJECT_ENDPOINT_INVALID')
      expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0, subjects: 0, subjectLeases: 0 })
      scheduler.close()
    })
})

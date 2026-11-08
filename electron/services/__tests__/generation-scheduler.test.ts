import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { MainProcessSchedulerPolicy } from '../main-process-scheduler'
import { MainGenerationScheduler } from '../generation-scheduler'
import { resolveAnthropicMessagesUrl } from '../../llm/anthropic-provider'
import { resolveOpenAIChatCompletionsUrl } from '../../llm/openai-compatible-endpoint'
import { LLMFactory } from '../../llm/llm-factory'

const policy: MainProcessSchedulerPolicy = {
  global: 8, provider: 8, credential: 8, model: 1, project: 8,
  maxQueued: 8, maxQuarantined: 4, interactiveBurst: 2,
}

function model(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'profile', name: 'fictional', provider: 'custom', protocol: 'openai',
    baseUrl: 'https://service.invalid/v1', apiKey: 'fictional-secret', modelName: 'fictional-model',
    temperature: 0.5, maxTokens: 128, purposes: ['generation'], ...overrides,
  }
}

function request(profile: ModelProfile, projectKey = 'a', signal = new AbortController().signal) {
  return { projectKey, model: profile, lane: 'interactive' as const, signal }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('main generation scheduler', () => {
  it.each([
    {
      protocol: 'openai' as const, baseUrl: 'https://service.invalid/v1?route=x#fragment',
      wireUrl: 'https://service.invalid/v1/chat/completions?route=x#fragment',
    },
    {
      protocol: 'openai' as const, baseUrl: 'https://name:secret@service.invalid/v1?route=x#fragment',
      wireUrl: 'https://name:secret@service.invalid/v1/chat/completions?route=x#fragment',
    },
    {
      protocol: 'anthropic' as const, baseUrl: 'https://service.invalid/other?x=1#fragment',
      wireUrl: 'https://service.invalid/other/v1/messages',
    },
    {
      protocol: 'anthropic' as const, baseUrl: 'https://user:password@service.invalid/other?x=1#fragment',
      wireUrl: 'https://service.invalid/other/v1/messages',
    },
    {
      protocol: 'gemini' as const, baseUrl: 'https://service.invalid/path?route=x#fragment',
      wireUrl: 'https://service.invalid/path?route=x#fragment/v1beta/models/Fictional/Model:V1:streamGenerateContent?alt=sse',
    },
    {
      protocol: 'gemini' as const, baseUrl: 'https://name:secret@service.invalid/path?route=x#fragment',
      wireUrl: 'https://name:secret@service.invalid/path?route=x#fragment/v1beta/models/Fictional/Model:V1:streamGenerateContent?alt=sse',
    },
  ])('keeps the actual $protocol adapter wire request after acquiring $baseUrl', async ({ protocol, baseUrl, wireUrl }) => {
    const scheduler = new MainGenerationScheduler(policy, 10)
    const profile = model({ protocol, baseUrl, modelName: 'Fictional/Model:V1', apiKey: ' fictional-secret \t' })
    const before = structuredClone(profile), controller = new AbortController()
    const fetchFailure = new TypeError('Request cannot be constructed from a URL that includes credentials')
    const sse = protocol === 'openai'
      ? 'data: {"choices":[{"delta":{"content":"visible"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      : protocol === 'anthropic'
        ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"visible"}}\n\n'
          + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
          + 'data: {"type":"message_stop"}\n\n'
        : 'data: {"candidates":[{"content":{"parts":[{"text":"visible"}]},"finishReason":"STOP"}]}\n'
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async url => {
      const endpoint = new URL(url)
      if (endpoint.username || endpoint.password) throw fetchFailure
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onChunk = vi.fn(), onDone = vi.fn(), onError = vi.fn()
    const permit = await scheduler.acquire(request(profile, 'a', controller.signal))
    try {
      expect(profile).toEqual(before)
      expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 0 })
      await LLMFactory.getProvider(profile).generateStream(profile, [{ role: 'user', content: 'fictional prompt' }], {
        temperature: 0.5, maxTokens: 128, signal: controller.signal, visibleOnly: true, onChunk, onDone, onError,
      })
      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(wireUrl)
      expect(init.method).toBe('POST')
      expect(init.signal).toBe(controller.signal)
      expect(init.redirect).toBe(protocol === 'anthropic' ? 'error' : undefined)
      expect(init.headers).toEqual(protocol === 'anthropic' ? {
        'Content-Type': 'application/json', 'x-api-key': profile.apiKey,
        'Authorization': `Bearer ${profile.apiKey}`, 'anthropic-version': '2023-06-01',
      } : protocol === 'gemini' ? {
        'Content-Type': 'application/json', 'x-goog-api-key': profile.apiKey,
      } : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${profile.apiKey}` })
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      if (protocol === 'gemini') {
        expect(url).toContain(`/models/${profile.modelName}:streamGenerateContent?alt=sse`)
        expect(body).not.toHaveProperty('model')
      } else expect(body.model).toBe(profile.modelName)
      if (new URL(wireUrl).username) {
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          protocol === 'openai' ? 'LLM_STREAM_FAILED' : String(fetchFailure),
          protocol === 'openai' ? undefined : '', undefined,
        )
        expect(onChunk).not.toHaveBeenCalled()
        expect(onDone).not.toHaveBeenCalled()
      } else {
        expect(onChunk).toHaveBeenCalledExactlyOnceWith('visible')
        expect(onDone).toHaveBeenCalledExactlyOnceWith('visible', undefined, 'stop')
        expect(onError).not.toHaveBeenCalled()
      }
      expect(profile).toEqual(before)
      expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 0 })
    } finally {
      permit.finish()
      scheduler.close()
    }
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, subjects: 0, subjectLeases: 0 })
  })

  it('groups actual request origins and model aliases across the three protocols without mutating profiles', async () => {
    const scheduler = new MainGenerationScheduler(policy, 20)
    const a = model()
    const b = model({ id: 'alias', protocol: 'anthropic', baseUrl: 'https://user:password@service.invalid/other?x=1', apiKey: 'another-key' })
    const c = model({ id: 'gemini', protocol: 'gemini', baseUrl: 'https://service.invalid/path?route=x#fragment', apiKey: 'third-key' })
    const before = structuredClone([a, b, c])
    const first = await scheduler.acquire(request(a))
    const second = scheduler.acquire(request(b, 'b'))
    const third = scheduler.acquire(request(c, 'c'))
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 2 })
    expect([a, b, c]).toEqual(before)
    expect(resolveAnthropicMessagesUrl(b.baseUrl)).not.toContain('user:password')
    expect(resolveOpenAIChatCompletionsUrl('https://user:password@service.invalid', 'custom')).toContain('user:password')
    first.finish()
    const next = await second
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 })
    next.finish()
    ;(await third).finish()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0, subjects: 0 })
  })

  it('keeps origin identities for credential-bearing OpenAI and Gemini URLs without rewriting input', async () => {
    const scheduler = new MainGenerationScheduler(policy, 10)
    const a = model({ baseUrl: 'https://name:secret@service.invalid/v1' })
    const b = model({ protocol: 'gemini', baseUrl: 'https://name:secret@service.invalid' })
    const before = structuredClone([a, b])
    const first = await scheduler.acquire(request(a))
    const second = scheduler.acquire(request(b, 'b'))
    expect(scheduler.getStats().queued).toBe(1)
    expect([a, b]).toEqual(before)
    first.finish()
    ;(await second).finish()
  })

  it('retains queued and physical references, releases cancellation, and enforces capacity atomically', async () => {
    const scheduler = new MainGenerationScheduler(policy, 3)
    const p = model()
    const first = await scheduler.acquire(request(p))
    const controller = new AbortController()
    const queued = scheduler.acquire(request(model({ id: 'alias' }), 'b', controller.signal))
    const rejected = expect(queued).rejects.toThrow('SCHEDULER_CANCELLED')
    expect(scheduler.getStats()).toMatchObject({ subjects: 3, queued: 1, occupied: 1 })
    await expect(scheduler.acquire(request(model({ modelName: 'another' })))).rejects.toThrow('SCHEDULER_SUBJECT_CAPACITY_EXCEEDED')
    controller.abort()
    await rejected
    expect(scheduler.getStats()).toMatchObject({ subjects: 3, queued: 0, occupied: 1, subjectLeases: 1 })
    first.finish()
    expect(scheduler.getStats()).toMatchObject({ subjects: 0, subjectLeases: 0 })
  })

  it('holds quarantine until physical finish and an explicit reset; close does not release a flight', async () => {
    const scheduler = new MainGenerationScheduler(policy, 3)
    const p = model()
    const first = await scheduler.acquire(request(p))
    expect(first.quarantine()).toBe(true)
    expect(() => scheduler.resetCredential(p)).toThrow('SCHEDULER_CREDENTIAL_BUSY')
    const queued = scheduler.acquire(request(model({ id: 'alias' }), 'b'))
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, quarantined: 1, queued: 1 })
    first.finish()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, blockedCredentials: 1, queued: 1, subjects: 3 })
    scheduler.resetCredential(p)
    const next = await queued
    scheduler.close()
    expect(scheduler.getStats()).toMatchObject({ occupied: 1, subjects: 3 })
    next.finish()
    expect(scheduler.getStats()).toMatchObject({ occupied: 0, subjects: 0 })
  })

  it('keeps secrets out of stats and errors, including malformed request URLs', async () => {
    const scheduler = new MainGenerationScheduler(policy, 3)
    const p = model()
    const permit = await scheduler.acquire(request(p))
    expect(JSON.stringify(scheduler)).not.toContain(p.apiKey)
    expect(JSON.stringify(scheduler.getStats())).not.toContain(p.baseUrl)
    await expect(scheduler.acquire(request(model({ baseUrl: 'secret-invalid-endpoint' }))))
      .rejects.toThrow('SCHEDULER_SUBJECT_ENDPOINT_INVALID')
    permit.finish()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../openai-provider'
import { AnthropicProvider } from '../anthropic-provider'
import { GeminiProvider } from '../gemini-provider'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationTransportDiagnostics } from '../../../src/shared/generation-contract'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const usage = { promptTokens: 2, completionTokens: 3, totalTokens: 5 }
const protocols = [
  {
    protocol: 'openai' as const, provider: new OpenAIProvider(),
    content: 'data: {"choices":[{"delta":{"content":"visible"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
    end: 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    invalid: 'data: {"choices":"invalid"}\n\n', error: 'LLM_STREAM_INVALID',
  },
  {
    protocol: 'anthropic' as const, provider: new AnthropicProvider(),
    content: 'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n'
      + 'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n'
      + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"visible"}}\n\n',
    end: 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n'
      + 'data: {"type":"message_stop"}\n\n',
    invalid: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":42}}\n\n', error: 'LLM_STREAM_INVALID',
  },
  {
    protocol: 'gemini' as const, provider: new GeminiProvider(),
    content: 'data: {"candidates":[{"content":{"parts":[{"text":"visible"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}\n',
    end: 'data: {"candidates":[{"finishReason":"STOP"}]}\n',
    invalid: 'data: {"candidates":"invalid"}\n', error: 'Error: LLM_STREAM_INVALID',
  },
]

function model(protocol: ModelProfile['protocol']): ModelProfile {
  return { id: 'physical-close', name: 'Physical close', provider: 'custom', protocol,
    baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic-key', modelName: 'synthetic-model',
    maxTokens: 64, temperature: 0, purposes: ['generation'] }
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe.each(protocols)('$protocol local transport close', ({ protocol, provider, content, end, invalid, error }) => {
  it.each(['done', 'cancelled', 'network', 'invalid'] as const)(
    'keeps the provider pending after %s notification until cancel settles and the lock is released', async outcome => {
      const close = deferred(), notified = deferred(), controller = new AbortController()
      const events: string[] = [], diagnostics: GenerationTransportDiagnostics[] = []
      const onDone = vi.fn(() => { events.push('done'); notified.resolve() })
      const onError = vi.fn(() => { events.push('error'); notified.resolve() })
      const onChunk = vi.fn(), onUsageEvidence = vi.fn(), settled = vi.fn()
      let reads = 0
      const reader = {
        read: vi.fn(async () => {
          if (reads++ === 0) return { done: false, value: new TextEncoder().encode(content) }
          if (outcome === 'cancelled') {
            controller.abort(); controller.abort()
            throw new DOMException('synthetic abort', 'AbortError')
          }
          if (outcome === 'network') throw new TypeError('synthetic network failure')
          if (reads === 2) return { done: false, value: new TextEncoder().encode(outcome === 'invalid' ? invalid : end) }
          return { done: true, value: undefined }
        }),
        cancel: vi.fn(() => { events.push('cancel'); return close.promise.then(() => { events.push('cancel-settled') }) }),
        releaseLock: vi.fn(() => { events.push('release') }),
      }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } }))
      const result = provider.generateStream(model(protocol), [], { temperature: 0, maxTokens: 64, signal: controller.signal, visibleOnly: true,
        onChunk, onDone, onError, onUsageEvidence, onDiagnostics: value => diagnostics.push(value) })
      void result.then(settled, settled)
      try {
        await notified.promise
        await nextTurn()
        expect(onChunk).toHaveBeenCalledExactlyOnceWith('visible')
        expect(onUsageEvidence).toHaveBeenCalled()
        expect(reader.cancel).toHaveBeenCalledOnce()
        expect(reader.releaseLock).not.toHaveBeenCalled()
        expect(settled).not.toHaveBeenCalled()
        if (outcome === 'done') {
          expect(onDone).toHaveBeenCalledExactlyOnceWith('visible', usage, 'stop')
          expect(onError).not.toHaveBeenCalled()
          expect(diagnostics.at(-1)).toMatchObject({ endReason: 'completed' })
        } else {
          expect(onError).toHaveBeenCalledExactlyOnceWith(
            outcome === 'cancelled' ? 'LLM_CANCELLED' : outcome === 'network' ? 'LLM_STREAM_NETWORK_FAILED' : error,
            'visible', usage,
          )
          expect(onDone).not.toHaveBeenCalled()
          expect(diagnostics.at(-1)).toMatchObject({ endReason: outcome === 'cancelled' ? 'cancelled' : 'failed' })
        }
      } finally {
        close.resolve()
        await result
      }
      expect(events).toEqual([outcome === 'done' ? 'done' : 'error', 'cancel', 'cancel-settled', 'release'])
      expect(reader.cancel).toHaveBeenCalledOnce()
      expect(reader.releaseLock).toHaveBeenCalledOnce()
      expect(settled).toHaveBeenCalledOnce()
    })

  it('retains an actual response stream lock until its underlying cancel settles', async () => {
    const close = deferred(), notified = deferred(), settled = vi.fn()
    const cancel = vi.fn(() => close.promise)
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(content + invalid)) },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    const onError = vi.fn(() => notified.resolve()), onDone = vi.fn()
    const result = provider.generateStream(model(protocol), [], { temperature: 0, maxTokens: 64, signal: new AbortController().signal,
      visibleOnly: true, onChunk: vi.fn(), onDone, onError })
    void result.then(settled, settled)
    try {
      await notified.promise
      await nextTurn()
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(true)
      expect(settled).not.toHaveBeenCalled()
    } finally {
      close.resolve()
      await result
    }
    expect(body.locked).toBe(false)
    expect(onError).toHaveBeenCalledExactlyOnceWith(error, 'visible', usage)
    expect(onDone).not.toHaveBeenCalled()
  })

  it.each([
    { failure: 'reject', succeeded: false }, { failure: 'throw', succeeded: false },
    { failure: 'reject', succeeded: true }, { failure: 'throw', succeeded: true },
  ])('observes cancel $failure without replacing the notified outcome (succeeded=$succeeded) or closing twice', async ({ failure, succeeded }) => {
    const close = deferred(), notified = deferred(), onError = vi.fn(() => notified.resolve())
    const onDone = vi.fn(() => notified.resolve()), chunks = [content, end]
    const reader = {
      read: vi.fn(async () => {
        if (!succeeded) throw new TypeError('synthetic network failure')
        return chunks.length ? { done: false, value: new TextEncoder().encode(chunks.shift()) } : { done: true, value: undefined }
      }),
      cancel: vi.fn(() => { if (failure === 'throw') throw new Error('synthetic cancel failure'); return close.promise }),
      releaseLock: vi.fn(),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } }))
    const result = provider.generateStream(model(protocol), [], { temperature: 0, maxTokens: 64, signal: new AbortController().signal,
      visibleOnly: true, onChunk: vi.fn(), onDone, onError })
    const settled = vi.fn()
    void result.then(settled, settled)
    try {
      await notified.promise
      await nextTurn()
      if (failure === 'reject') {
        expect(settled).not.toHaveBeenCalled()
        expect(reader.releaseLock).not.toHaveBeenCalled()
      }
    } finally {
      if (failure === 'reject' && reader.cancel.mock.calls.length) close.reject(new Error('synthetic cancel failure'))
      else close.resolve()
      await expect(result).resolves.toBeUndefined()
    }
    if (succeeded) {
      expect(onDone).toHaveBeenCalledExactlyOnceWith('visible', usage, 'stop')
      expect(onError).not.toHaveBeenCalled()
    } else {
      expect(onError).toHaveBeenCalledExactlyOnceWith('LLM_STREAM_NETWORK_FAILED', protocol === 'gemini' ? '' : undefined, undefined)
      expect(onDone).not.toHaveBeenCalled()
    }
    expect(reader.cancel).toHaveBeenCalledOnce()
    expect(reader.releaseLock).toHaveBeenCalledOnce()
  })

  it('keeps unknown finish reasons and supports readers without optional cleanup methods', async () => {
    const chunks = [content, protocol === 'openai' ? 'data: [DONE]\n\n'
      : protocol === 'anthropic' ? 'data: {"type":"message_stop"}\n\n' : '']
    const reader = { read: vi.fn(async () => chunks.length
      ? { done: false, value: new TextEncoder().encode(chunks.shift()) } : { done: true, value: undefined }) }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } }))
    const onDone = vi.fn(), onError = vi.fn()
    await provider.generateStream(model(protocol), [], { temperature: 0, maxTokens: 64, signal: new AbortController().signal,
      visibleOnly: true, onChunk: vi.fn(), onDone, onError })
    expect(onDone).toHaveBeenCalledExactlyOnceWith('visible', usage, 'unknown')
    expect(onError).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject', 'throw'] as const)('notifies the non-400 HTTP category before physical body cleanup (%s)', async outcome => {
    const close = deferred(), events: string[] = [], settled = vi.fn(), text = vi.fn(), controller = new AbortController()
    const getReader = vi.fn(), onChunk = vi.fn()
    const cancel = vi.fn(() => {
      events.push('cancel')
      if (outcome === 'throw') throw new Error('synthetic cancel failure')
      return close.promise
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text, body: { cancel, getReader } }))
    const onError = vi.fn<(error: string) => void>(() => { events.push('error') }), onDone = vi.fn()
    const result = provider.generateStream(model(protocol), [], { temperature: 0, maxTokens: 64, signal: controller.signal,
      visibleOnly: true, onChunk, onDone, onError })
    void result.then(settled, settled)
    try {
      await nextTurn()
      expect(cancel).toHaveBeenCalledOnce()
      expect(text).not.toHaveBeenCalled()
      expect(getReader).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledExactlyOnceWith('LLM_REQUEST_FAILED', ...(protocol === 'gemini' ? [] : [undefined, undefined]))
      expect(onDone).not.toHaveBeenCalled()
      expect(onChunk).not.toHaveBeenCalled()
      expect(events).toEqual(['error', 'cancel'])
      if (outcome !== 'throw') expect(settled).not.toHaveBeenCalled()
      controller.abort()
    } finally {
      if (outcome === 'reject') close.reject(new Error('synthetic cancel failure'))
      else close.resolve()
      await expect(result).resolves.toBeUndefined()
    }
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[0]).toBe('LLM_REQUEST_FAILED')
    expect(onDone).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expect(events).toEqual(['error', 'cancel'])
  })

  it('retains a real failed Response body cancellation without acquiring a stream reader', async () => {
    const close = deferred(), settled = vi.fn(), events: string[] = []
    const cancel = vi.fn(() => { events.push('cancel'); return close.promise })
    const body = new ReadableStream<Uint8Array>({ cancel })
    const response = new Response(body, { status: 503 })
    const getReader = vi.spyOn(body, 'getReader'), text = vi.spyOn(response, 'text')
    const onError = vi.fn<(error: string) => void>(() => { events.push('error') }), onDone = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    const result = provider.generateStream(model(protocol), [], { temperature: 0, maxTokens: 64,
      signal: new AbortController().signal, visibleOnly: true, onChunk: vi.fn(), onDone, onError })
    void result.then(settled, settled)
    try {
      await nextTurn()
      expect(onError).toHaveBeenCalledOnce()
      expect(onError.mock.calls[0]?.[0]).toBe('LLM_REQUEST_FAILED')
      expect(onDone).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledOnce()
      expect(events).toEqual(['error', 'cancel'])
      expect(getReader).not.toHaveBeenCalled()
      expect(text).not.toHaveBeenCalled()
      expect(response.bodyUsed).toBe(true)
      expect(body.locked).toBe(false)
      expect(settled).not.toHaveBeenCalled()
    } finally {
      close.resolve()
      await expect(result).resolves.toBeUndefined()
    }
    expect(onError).toHaveBeenCalledOnce()
    expect(onDone).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([false, true])('covers the 400 body consumption lifetime and preserves its abort classification (%s)', async aborted => {
    const body = deferred(), controller = new AbortController(), settled = vi.fn()
    const text = vi.fn(async () => {
      await body.promise
      if (aborted) throw new DOMException('synthetic abort', 'AbortError')
      return '{"error":{"message":"maximum context length is 64 tokens"}}'
    })
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text, body: { cancel } }))
    const onError = vi.fn(), onDone = vi.fn()
    const result = provider.generateStream(model(protocol), [], { temperature: 0, maxTokens: 64, signal: controller.signal,
      visibleOnly: true, onChunk: vi.fn(), onDone, onError })
    void result.then(settled, settled)
    try {
      await nextTurn()
      expect(text).toHaveBeenCalledOnce()
      expect(settled).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      if (aborted) controller.abort()
    } finally {
      body.resolve()
      await result
    }
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[0]).toBe(aborted ? 'LLM_CANCELLED' : 'LLM_CONTEXT_LENGTH_EXCEEDED')
    expect(cancel).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })
})

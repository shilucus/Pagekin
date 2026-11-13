import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { MainGenerationScheduler } from '../../services/generation-scheduler'

type Handler = (...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), send: vi.fn(), models: [] as ModelProfile[] }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' },
  ipcMain: { handle: (name: string, handler: Handler) => mocks.handlers.set(name, handler) },
  BrowserWindow: { fromWebContents: () => ({ webContents: { send: mocks.send } }) } }))
vi.mock('../../utils/config-utils', () => ({ MODELS_CONFIG_PATH: 'fictional-models', GLOBAL_CONFIG_PATH: 'fictional-config',
  DEFAULT_GLOBAL_CONFIG: { proxy: { enabled: false } },
  readJsonFile: (file: string, fallback: unknown) => file === 'fictional-models' ? mocks.models : fallback,
  tryReadJsonFile: () => ({ status: 'missing' }), writeJsonFile: vi.fn() }))
vi.mock('../../database', () => ({ getCurrentProjectPath: () => null }))
vi.mock('../../repositories/llm-repository', () => ({ LLMHistoryRepository: { logCall: vi.fn() } }))

import { registerLLMController } from '../llm-controller'

const model: ModelProfile = { id: 'fictional', name: 'Fictional', provider: 'custom', protocol: 'openai',
  baseUrl: 'https://fixture.invalid/v1', apiKey: 'fictional-key', modelName: 'fictional-model',
  maxTokens: 128, temperature: 0, purposes: ['generation'] }
const embedding: ModelProfile = { ...model, id: 'fictional-embedding', modelName: 'fictional-embedding', purposes: ['embedding'] }
const request = { modelId: model.id, messages: [{ role: 'user', content: 'fictional' }] }
class Sender extends EventEmitter { readonly id = 7101; isDestroyed() { return false } }
const sender = new Sender()
const policy = (global: number) => ({ global, provider: global, credential: global, model: global, project: global,
  maxQueued: 8, maxQuarantined: 2, interactiveBurst: 1 })
function handler(name: string) {
  const result = mocks.handlers.get(name)
  if (!result) throw new Error(`MISSING_HANDLER:${name}`)
  return result
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function register(scheduler: MainGenerationScheduler) {
  registerLLMController({ scheduler })
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); mocks.handlers.clear(); mocks.send.mockClear() })

describe('registered direct network operations share physical capacity', () => {
  it.each([1, 2])('bounds direct generation, discovery and embedding probe at global=%i', async global => {
    const scheduler = new MainGenerationScheduler(policy(global), 16)
    mocks.models = [model, embedding]
    register(scheduler)
    const gates: Array<ReturnType<typeof deferred>> = []
    let draining = false
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const gate = deferred(); gates.push(gate); if (draining) gate.resolve()
      await gate.promise
      const address = String(url)
      if (address.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fictional-model' }] }))
      if (address.endsWith('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    })
    vi.stubGlobal('fetch', fetch)
    const pending: Promise<unknown>[] = []
    try {
      pending.push(handler('llm:generate')({ sender }, request))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      pending.push(handler('llm:discover-models')({ sender }, model))
      if (global === 2) await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
      pending.push(handler('llm:test-connection')({ sender }, embedding))
      await vi.waitFor(() => expect(scheduler.getStats()).toMatchObject({ occupied: global, queued: 3 - global }))
      expect(fetch).toHaveBeenCalledTimes(global)
      for (let i = 0; i < 3; i++) {
        await vi.waitFor(() => expect(gates.length).toBeGreaterThan(i))
        gates[i].resolve()
      }
      const results = await Promise.all(pending)
      expect(results).toEqual([expect.objectContaining({ success: true }), expect.objectContaining({ success: true }),
        expect.objectContaining({ success: true })])
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(scheduler.getStats()).toMatchObject({ occupied: 0, queued: 0 })
    } finally {
      draining = true; gates.forEach(gate => gate.resolve())
      await Promise.allSettled(pending)
      scheduler.close()
    }
  }, 15_000)

  it('holds the slot after the real provider done callback until reader cleanup settles', async () => {
    const scheduler = new MainGenerationScheduler(policy(1), 16), close = deferred()
    mocks.models = [model]; register(scheduler)
    let reads = 0
    const reader = {
      read: vi.fn(async () => reads++ === 0
        ? { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') }
        : { done: true, value: undefined }),
      cancel: vi.fn(() => close.promise), releaseLock: vi.fn(),
    }
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { stream?: boolean }
      if (payload.stream) return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    })
    vi.stubGlobal('fetch', fetch)
    let waiting: Promise<unknown> | undefined
    try {
      expect(await handler('llm:generate-stream')({ sender }, 'fictional-stream', request)).toMatchObject({ started: true })
      await vi.waitFor(() => expect(reader.cancel).toHaveBeenCalledOnce())
      expect(mocks.send).toHaveBeenCalledWith('llm:stream-done', expect.objectContaining({ requestId: 'fictional-stream' }))
      expect(reader.releaseLock).not.toHaveBeenCalled()
      waiting = handler('llm:generate')({ sender }, request)
      await vi.waitFor(() => expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 }))
      expect(fetch).toHaveBeenCalledTimes(1)
      close.resolve()
      expect(await waiting).toMatchObject({ success: true })
      expect(reader.releaseLock).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      close.resolve(); if (waiting) await waiting.catch(() => {})
      await vi.waitFor(() => expect(reader.releaseLock).toHaveBeenCalledOnce())
      scheduler.close()
    }
  }, 15_000)

  it('does not release a logically cancelled stream before reader cancellation physically settles', async () => {
    const scheduler = new MainGenerationScheduler(policy(1), 16), close = deferred()
    mocks.models = [model]; register(scheduler)
    const reading = deferred()
    let signal: AbortSignal | undefined
    const reader = {
      read: vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
        reading.resolve()
        signal!.addEventListener('abort', () => reject(new DOMException('fictional abort', 'AbortError')), { once: true })
      })),
      cancel: vi.fn(() => close.promise), releaseLock: vi.fn(),
    }
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { stream?: boolean }
      if (payload.stream) {
        signal = init?.signal ?? undefined
        return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    })
    vi.stubGlobal('fetch', fetch)
    let waiting: Promise<unknown> | undefined
    try {
      expect(await handler('llm:generate-stream')({ sender }, 'fictional-cancel', request)).toMatchObject({ started: true })
      await reading.promise
      expect(await handler('llm:cancel')({ sender }, 'fictional-cancel')).toEqual({ success: true })
      await vi.waitFor(() => expect(reader.cancel).toHaveBeenCalledOnce())
      expect(reader.releaseLock).not.toHaveBeenCalled()
      waiting = handler('llm:generate')({ sender }, request)
      await vi.waitFor(() => expect(scheduler.getStats()).toMatchObject({ occupied: 1, queued: 1 }))
      expect(fetch).toHaveBeenCalledTimes(1)
      close.resolve()
      expect(await waiting).toMatchObject({ success: true })
      expect(reader.releaseLock).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      await handler('llm:cancel')({ sender }, 'fictional-cancel')
      close.resolve(); if (waiting) await waiting.catch(() => {})
      if (signal) await vi.waitFor(() => expect(reader.releaseLock).toHaveBeenCalledOnce())
      scheduler.close()
    }
  }, 15_000)
})

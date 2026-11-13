import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

import type { LLMRequest, ModelProfile } from '../../../src/shared/ipc-channels'
import { createMainNetworkScheduler, type MainGenerationScheduler } from '../../services/generation-scheduler'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  generate: vi.fn(),
  generateStream: vi.fn(),
  send: vi.fn(),
  models: [] as ModelProfile[],
  applicationCloseListeners: new Set<() => void>(),
  releaseApplicationOperation: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  BrowserWindow: { fromWebContents: vi.fn(() => ({ webContents: { send: mocks.send } })) },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
}))

vi.mock('../../utils/config-utils', () => ({
  MODELS_CONFIG_PATH: 'models.json',
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: { proxy: { enabled: false } },
  readJsonFile: vi.fn((path: string, fallback: unknown) => path === 'models.json' ? mocks.models : fallback),
  tryReadJsonFile: vi.fn(() => ({ status: 'missing' })),
  writeJsonFile: vi.fn(),
}))

vi.mock('../../llm/llm-factory', () => ({
  LLMFactory: { getProvider: vi.fn(() => ({ generate: mocks.generate, generateStream: mocks.generateStream })) },
}))
vi.mock('../../database', () => ({ getCurrentProjectPath: () => null }))
vi.mock('../../repositories/llm-repository', () => ({ LLMHistoryRepository: { logCall: vi.fn() } }))
vi.mock('../../services/project-access', () => ({ projectAccess: { assertCurrentProjectContext: vi.fn() } }))
vi.mock('../../services/project-runtime', () => ({
  projectRuntimeHost: {
    assertApplicationWorkAvailable: vi.fn(),
    acquireApplicationOperation: vi.fn(() => mocks.releaseApplicationOperation),
    onApplicationCloseRequested: vi.fn((listener: () => void) => {
      mocks.applicationCloseListeners.add(listener)
      return () => mocks.applicationCloseListeners.delete(listener)
    }),
  },
}))

import { registerLLMController } from '../llm-controller'

const model: ModelProfile = {
  id: 'profile-a', name: 'Profile A', provider: 'custom', protocol: 'openai', modelName: 'model-a',
  apiKey: 'test-key', baseUrl: 'https://provider.example/v1', temperature: 0.7, maxTokens: 1024, purposes: ['generation'],
}
const request: LLMRequest = { modelId: model.id, messages: [{ role: 'user', content: 'hello' }] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function handler(channel: string): IpcHandler {
  const value = mocks.handlers.get(channel)
  if (!value) throw new Error(`Missing handler: ${channel}`)
  return value
}

function registerWithScheduler(scheduler: MainGenerationScheduler): { scheduler?: MainGenerationScheduler } {
  const register = registerLLMController as unknown as (options: { scheduler: MainGenerationScheduler }) => { scheduler?: MainGenerationScheduler }
  return register({ scheduler })
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.applicationCloseListeners.clear()
  vi.clearAllMocks()
  mocks.models = [model]
})

describe('LLM controller shared network admission', () => {
  it('uses the injected main scheduler for direct calls and returns that same instance to generation wiring', async () => {
    const physical = deferred<unknown>()
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
    const scheduler = createMainNetworkScheduler()
    const acquire = vi.spyOn(scheduler, 'acquireNetwork').mockResolvedValue(permit)
    mocks.generate.mockImplementationOnce(() => physical.promise)

    const composition = registerWithScheduler(scheduler)
    const operation = handler('llm:generate')({}, request)

    try {
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
      expect(composition.scheduler).toBe(scheduler)
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
        projectKey: 'application-outbound-network', lane: 'interactive',
      }))
      expect(mocks.generate).toHaveBeenCalledOnce()
      physical.resolve({ success: true, content: 'ok', finishReason: 'stop' })
      await expect(operation).resolves.toMatchObject({ success: true, content: 'ok' })
      expect(permit.finish).toHaveBeenCalledOnce()
    } finally {
      physical.resolve({ success: true, content: 'ok', finishReason: 'stop' })
      await operation.catch(() => {})
    }
  })

  it('keeps a stream permit occupied after cancel until provider cleanup settles', async () => {
    const physical = deferred<void>()
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
    const scheduler = createMainNetworkScheduler()
    const acquire = vi.spyOn(scheduler, 'acquireNetwork').mockResolvedValue(permit)
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    let providerSignal: AbortSignal | undefined
    mocks.generateStream.mockImplementationOnce((_model: ModelProfile, _messages: unknown, options: { signal: AbortSignal }) => {
      providerSignal = options.signal
      return physical.promise
    })

    registerWithScheduler(scheduler)
    try {
      await expect(handler('llm:generate-stream')({ sender }, 'stream-a', request)).resolves.toMatchObject({
        requestId: 'stream-a', started: true,
      })
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())

      await expect(handler('llm:cancel')({ sender }, 'stream-a')).resolves.toEqual({ success: true })
      expect(providerSignal?.aborted).toBe(true)
      expect(permit.finish).not.toHaveBeenCalled()

      physical.resolve()
      await vi.waitFor(() => expect(permit.finish).toHaveBeenCalledOnce())
    } finally {
      physical.resolve()
      if (providerSignal) await vi.waitFor(() => expect(permit.finish).toHaveBeenCalledOnce())
    }
  })

  it('aborts a sessionless direct request on confirmed application close but retains its permit until cleanup', async () => {
    const physical = deferred<unknown>()
    const permit = { finish: vi.fn(), quarantine: vi.fn(() => true) }
    const scheduler = createMainNetworkScheduler()
    vi.spyOn(scheduler, 'acquireNetwork').mockResolvedValue(permit)
    let providerSignal: AbortSignal | undefined
    mocks.generate.mockImplementationOnce((_model: ModelProfile, _messages: unknown, options: { signal?: AbortSignal }) => {
      providerSignal = options.signal
      return physical.promise
    })
    registerWithScheduler(scheduler)
    const operation = handler('llm:generate')({}, request)

    try {
      await vi.waitFor(() => expect(mocks.applicationCloseListeners.size).toBe(1))
      expect(mocks.releaseApplicationOperation).not.toHaveBeenCalled()
      for (const listener of [...mocks.applicationCloseListeners]) listener()
      expect(providerSignal?.aborted).toBe(true)
      expect(permit.finish).not.toHaveBeenCalled()
      physical.resolve({ success: false, content: '', finishReason: 'error', error: 'LLM_CANCELLED' })
      await operation
      expect(permit.finish).toHaveBeenCalledOnce()
      expect(mocks.releaseApplicationOperation).toHaveBeenCalledOnce()
    } finally {
      physical.resolve({ success: false, content: '', finishReason: 'error', error: 'LLM_CANCELLED' })
      await operation.catch(() => {})
    }
  })
})

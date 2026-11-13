import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedGemini, embedOpenAI, generateEmbeddings } from '../embedding'
import { EmbeddingResponseValidationError } from '../services/embedding-response-error'
import {
  EmbeddingDispatchBarrierError,
  type EmbeddingBatchObserver,
  type EmbeddingRequestLifecycle,
  type EmbeddingRequestOutcome,
} from '../services/reference-embedding-dispatch-contract'

const model = { baseUrl: 'https://embedding.example/v1', apiKey: 'fictional-key', modelName: 'fictional-embedding' }
const protocols = [
  { protocol: 'openai', embed: embedOpenAI },
  { protocol: 'gemini', embed: embedGemini },
] as const
const barrierCode = 'REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED'
const privateError = 'PRIVATE_PROVIDER_OR_DATABASE_DETAIL'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function payload(protocol: 'openai' | 'gemini', vector: number[] = [0.25, 0.5]) {
  return protocol === 'openai'
    ? { data: [{ index: 0, embedding: vector }] }
    : { embeddings: [{ values: vector }] }
}

function response(protocol: 'openai' | 'gemini', status = 200, valid = true) {
  return new Response(JSON.stringify(valid ? payload(protocol) : {}), { status })
}

function lifecycle() {
  return { beforeDispatch: vi.fn(() => {}), settled: vi.fn<(outcome: EmbeddingRequestOutcome) => void>(() => {}) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe.each(protocols)('$protocol physical embedding lifecycle', ({ protocol, embed }) => {
  it('marks immediately before fetch and settles only after full JSON and local vector validation', async () => {
    const events: string[] = []
    const body = deferred<unknown>()
    const hooks = lifecycle()
    hooks.beforeDispatch.mockImplementation(() => { events.push('mark') })
    hooks.settled.mockImplementation(() => { events.push('settled') })
    const json = vi.fn(() => body.promise)
    const fetchMock = vi.fn(async () => {
      events.push('fetch')
      return { ok: true, status: 201, json }
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = embed(['fictional text'], model, undefined, hooks)
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce())
    expect(events).toEqual(['mark', 'fetch'])
    expect(hooks.settled).not.toHaveBeenCalled()
    body.resolve(payload(protocol))
    await expect(result).resolves.toEqual([[0.25, 0.5]])
    expect(events).toEqual(['mark', 'fetch', 'settled'])
    expect(hooks.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'response_received', httpStatus: 201 })
  })

  it('records actual non-2xx status without parsing the error body', async () => {
    const hooks = lifecycle()
    const json = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json }))
    await expect(embed(['fictional text'], model, undefined, hooks)).rejects.toMatchObject({ code: 'EMBEDDING_REQUEST_FAILED', status: 429 })
    expect(hooks.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'http_failed', httpStatus: 429 })
    expect(json).not.toHaveBeenCalled()
  })

  it('holds a known HTTP failure until its actual delayed response body closes', async () => {
    const hooks = lifecycle()
    let body!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      body = controller
      controller.enqueue(new TextEncoder().encode('fictional error body'))
    } })
    const fetchMock = vi.fn(async () => new Response(stream, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const outcome = embed(['fictional text'], model, undefined, hooks).catch(error => error)
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      expect(hooks.settled).not.toHaveBeenCalled()
    } finally { body.close(); await outcome }
    expect(await outcome).toMatchObject({ code: 'EMBEDDING_REQUEST_FAILED', status: 503 })
    expect(hooks.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'http_failed', httpStatus: 503 })
  })

  it.each([200, 503])('records a failed HTTP %i body read as transport unknown, not valid FTS fallback', async status => {
    const hooks = lifecycle(), original = new TypeError('fictional interrupted body')
    let body!: ReadableStreamDefaultController<Uint8Array>
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }), { status }))
    vi.stubGlobal('fetch', fetchMock)
    const outcome = embed(['fictional text'], model, undefined, hooks).catch(error => error)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    body.error(original)
    expect(await outcome).toBe(original)
    expect(hooks.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'transport_unknown' })
  })

  it('does not reclassify an aborted successful response body as invalid JSON', async () => {
    const hooks = lifecycle(), original = new DOMException('fictional cancellation', 'AbortError')
    let body!: ReadableStreamDefaultController<Uint8Array>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }), { status: 200 })))
    const outcome = embed(['fictional text'], model, undefined, hooks).catch(error => error)
    await Promise.resolve()
    body.error(original)
    expect(await outcome).toBe(original)
    expect(hooks.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'transport_unknown' })
  })

  it.each(['json', 'shape', 'vector'] as const)('records successful HTTP with invalid %s as response_invalid', async (invalid) => {
    const hooks = lifecycle()
    const json = vi.fn(async () => {
      if (invalid === 'json') throw new SyntaxError(privateError)
      return invalid === 'shape' ? {} : payload(protocol, [])
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202, json }))
    await expect(embed(['fictional text'], model, undefined, hooks)).rejects.toBeInstanceOf(EmbeddingResponseValidationError)
    expect(hooks.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'response_invalid', httpStatus: 202 })
  })

  it('records fetch rejection as unknown without inferring a status from its message or properties', async () => {
    const hooks = lifecycle()
    const error = Object.assign(new Error('HTTP 503 response_received'), { status: 503 })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
    await expect(embed(['fictional text'], model, undefined, hooks)).rejects.toBe(error)
    expect(hooks.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'transport_unknown' })
  })

  it('records a synchronous fetch throw as unknown without replacing the original error', async () => {
    const hooks = lifecycle()
    const original = new Error(privateError)
    vi.stubGlobal('fetch', vi.fn(() => { throw original }))
    await expect(embed(['fictional text'], model, undefined, hooks)).rejects.toBe(original)
    expect(hooks.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'transport_unknown' })
  })

  it('does not fetch when the synchronous mark fails and never exposes its cause', async () => {
    const hooks = lifecycle()
    hooks.beforeDispatch.mockImplementation(() => { throw new Error(privateError) })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const error: unknown = await embed(['fictional text'], model, undefined, hooks).catch(reason => reason)
    expect(error).toBeInstanceOf(EmbeddingDispatchBarrierError)
    expect(error).toMatchObject({ message: barrierCode, code: barrierCode })
    expect(error).not.toHaveProperty('cause')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hooks.settled).not.toHaveBeenCalled()
  })

  it.each(['received', 'http', 'invalid', 'transport'] as const)('makes %s settlement failure a hard barrier exactly once', async (kind) => {
    const hooks = lifecycle()
    hooks.settled.mockImplementation(() => { throw new Error(privateError) })
    const fetchMock = kind === 'transport'
      ? vi.fn().mockRejectedValue(new Error(privateError))
      : vi.fn().mockResolvedValue(response(protocol, kind === 'http' ? 503 : 200, kind !== 'invalid'))
    vi.stubGlobal('fetch', fetchMock)
    const error: unknown = await embed(['fictional text'], model, undefined, hooks).catch(reason => reason)
    expect(error).toBeInstanceOf(EmbeddingDispatchBarrierError)
    expect(error).toMatchObject({ message: barrierCode, code: barrierCode })
    expect(error).not.toHaveProperty('cause')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(hooks.beforeDispatch).toHaveBeenCalledOnce()
    expect(hooks.settled).toHaveBeenCalledOnce()
  })

  describe.each(['beforeDispatch', 'settled'] as const)('%s must be synchronous void', (phase) => {
    const invalidHooks = [
      { name: 'async function', hook: async () => {} },
      { name: 'returned promise', hook: () => Promise.reject(new Error(privateError)) },
      { name: 'thenable', hook: () => ({ then(resolve: (value: unknown) => void) { resolve(undefined) } }) },
      { name: 'nonvoid value', hook: () => true },
    ]
    it.each(invalidHooks)('rejects $name without ordinary fallback', async ({ hook }) => {
      const hooks = { ...lifecycle(), [phase]: hook } as unknown as EmbeddingRequestLifecycle
      const fetchMock = vi.fn().mockResolvedValue(response(protocol))
      vi.stubGlobal('fetch', fetchMock)
      await expect(embed(['fictional text'], model, undefined, hooks)).rejects.toMatchObject({ code: barrierCode })
      expect(fetchMock).toHaveBeenCalledTimes(phase === 'beforeDispatch' ? 0 : 1)
    })
  })

  it('retains no-observer direct-call results and original failure identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(protocol)))
    await expect(embed(['fictional text'], model)).resolves.toEqual([[0.25, 0.5]])
    const original = new Error(privateError)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(original))
    await expect(embed(['fictional text'], model)).rejects.toBe(original)
  })

  it('supplies original zero-based ordinal and actual input count in serial batches', async () => {
    const hooks = [lifecycle(), lifecycle()]
    const observer = { forBatch: vi.fn((ordinal: number) => hooks[ordinal]) }
    const firstPayload = protocol === 'openai'
      ? { data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3, 4] }] }
      : { embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(firstPayload), { status: 200 }))
      .mockResolvedValueOnce(response(protocol)))
    await expect(generateEmbeddings(['a', 'b', 'c'], protocol, model, 2, undefined, undefined, 1, observer))
      .resolves.toEqual([[1, 2], [3, 4], [0.25, 0.5]])
    expect(observer.forBatch.mock.calls).toEqual([[0, 2], [1, 1]])
    for (const hook of hooks) expect(hook.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'response_received', httpStatus: 200 })
  })

  it('keeps truthful successful batch facts when whole-document dimensions differ', async () => {
    const hooks = [lifecycle(), lifecycle()]
    const observer = { forBatch: (ordinal: number) => hooks[ordinal] }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload(protocol, [1])), { status: 200 }))
      .mockResolvedValueOnce(response(protocol)))
    await expect(generateEmbeddings(['a', 'b'], protocol, model, 1, undefined, undefined, 1, observer))
      .rejects.toBeInstanceOf(EmbeddingResponseValidationError)
    for (const hook of hooks) expect(hook.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'response_received', httpStatus: 200 })
  })
})

describe('embedding lifecycle no-dispatch boundaries', () => {
  it('validates the endpoint before invoking an OpenAI mark', async () => {
    const hooks = lifecycle()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(embedOpenAI(['a'], { ...model, baseUrl: 'http://localhost:11434/api' }, undefined, hooks))
      .rejects.toMatchObject({ code: 'EMBEDDING_OLLAMA_NATIVE_URL' })
    expect(hooks.beforeDispatch).not.toHaveBeenCalled()
    expect(hooks.settled).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not fabricate lifecycle records for empty input or release smoke vectors', async () => {
    const token = 'a'.repeat(32)
    const originalArgv = process.argv
    vi.stubEnv('AI_NOVEL_RELEASE_SMOKE', '1')
    vi.stubEnv('AI_NOVEL_RELEASE_SMOKE_TOKEN', token)
    process.argv = [...originalArgv, `--ai-novel-release-smoke=${token}`]
    const observer = { forBatch: vi.fn(() => lifecycle()) }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(generateEmbeddings([], 'openai', model, 1, undefined, undefined, 1, observer)).resolves.toEqual([])
      const result = await generateEmbeddings(['a'], 'openai', {
        baseUrl: `vela-release-smoke://${token}`, apiKey: token, modelName: 'release-smoke-768',
      }, 1, undefined, undefined, 1, observer)
      expect(result).toHaveLength(1)
      expect(result[0]).toHaveLength(768)
      expect(observer.forBatch).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.argv = originalArgv
    }
  })

  it.each([
    { name: 'factory throws', value: { forBatch() { throw new Error(privateError) } } },
    { name: 'async factory', value: { forBatch: async () => lifecycle() } },
    { name: 'factory returns promise', value: { forBatch: () => Promise.reject(new Error(privateError)) } },
    { name: 'missing settlement guard', value: { forBatch: () => ({ beforeDispatch() {} }) } },
    { name: 'missing factory', value: {} },
    { name: 'null lifecycle', value: { forBatch: () => null } },
  ])('rejects $name before any physical fetch', async ({ value }) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateEmbeddings(['a'], 'openai', model, 1, undefined, undefined, 1,
      value as unknown as EmbeddingBatchObserver)).rejects.toMatchObject({ code: barrierCode })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe.each(protocols)('$protocol concurrent lifecycle adjudication', ({ protocol }) => {
  it('drains an earlier physical request before surfacing a later synchronous mark failure', async () => {
    const request = deferred<Response>()
    const first = lifecycle()
    const observer: EmbeddingBatchObserver = { forBatch: ordinal => ordinal === 0 ? first : {
      beforeDispatch() { throw new Error(privateError) }, settled() {},
    } }
    const fetchMock = vi.fn(() => request.promise)
    vi.stubGlobal('fetch', fetchMock)
    let finished = false
    const result = generateEmbeddings(['a', 'mark fails', 'not dispatched'], protocol, model, 1, undefined, undefined, 2, observer)
      .catch((error: unknown) => { finished = true; return error })
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(finished).toBe(false)
    expect(first.settled).not.toHaveBeenCalled()
    request.resolve(response(protocol, 503))
    expect(await result).toBeInstanceOf(EmbeddingDispatchBarrierError)
    expect(first.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'http_failed', httpStatus: 503 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  const hardCases = ([0, 1] as const).flatMap(hardOrdinal => ([0, 1] as const).flatMap(firstCompleted =>
    (['ordinary', 'validation'] as const).map(other => ({ hardOrdinal, firstCompleted, other }))))

  it.each(hardCases)('hard batch $hardOrdinal beats $other after batch $firstCompleted completes first, draining physical siblings', async ({ hardOrdinal, firstCompleted, other }) => {
    const requests = [deferred<Response>(), deferred<Response>()]
    const settled: number[] = []
    const observer: EmbeddingBatchObserver = {
      forBatch: ordinal => ({
        beforeDispatch() {},
        settled() {
          settled.push(ordinal)
          if (ordinal === hardOrdinal) throw new Error(privateError)
        },
      }),
    }
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => requests[0].promise)
      .mockImplementationOnce(() => requests[1].promise)
    vi.stubGlobal('fetch', fetchMock)
    let finished = false
    const result = generateEmbeddings(['a', 'b', 'not dispatched'], protocol, model, 1, undefined, undefined, 2, observer)
      .then(value => { finished = true; return { value, error: undefined } }, error => { finished = true; return { value: undefined, error } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const complete = (ordinal: number) => requests[ordinal].resolve(ordinal === hardOrdinal
      ? response(protocol)
      : response(protocol, other === 'ordinary' ? 503 : 200, false))
    complete(firstCompleted)
    await vi.waitFor(() => expect(settled).toEqual([firstCompleted]))
    expect(finished).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    complete(1 - firstCompleted)
    const outcome = await result
    expect(outcome.error).toBeInstanceOf(EmbeddingDispatchBarrierError)
    expect(outcome.error).toMatchObject({ code: barrierCode, message: barrierCode })
    expect(settled).toEqual([firstCompleted, 1 - firstCompleted])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  const originalOrderCases = ([0, 1] as const).flatMap(validationOrdinal => ([0, 1] as const)
    .map(firstCompleted => ({ validationOrdinal, firstCompleted })))
  it.each(originalOrderCases)('ordinary/validation retains original order with validation batch $validationOrdinal and completion $firstCompleted first', async ({ validationOrdinal, firstCompleted }) => {
    const requests = [deferred<Response>(), deferred<Response>()]
    const settled: number[] = []
    const observer: EmbeddingBatchObserver = { forBatch: ordinal => ({ beforeDispatch() {}, settled() { settled.push(ordinal) } }) }
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => requests[0].promise)
      .mockImplementationOnce(() => requests[1].promise))
    const result = generateEmbeddings(['a', 'b'], protocol, model, 1, undefined, undefined, 2, observer)
      .catch((error: unknown) => error)
    const complete = (ordinal: number) => requests[ordinal].resolve(response(protocol, ordinal === validationOrdinal ? 200 : 503, false))
    complete(firstCompleted)
    await vi.waitFor(() => expect(settled).toEqual([firstCompleted]))
    complete(1 - firstCompleted)
    const error = await result
    if (validationOrdinal === 0) expect(error).toBeInstanceOf(EmbeddingResponseValidationError)
    else expect(error).toMatchObject({ code: 'EMBEDDING_REQUEST_FAILED', status: 503 })
    expect(error).not.toBeInstanceOf(EmbeddingDispatchBarrierError)
  })
})

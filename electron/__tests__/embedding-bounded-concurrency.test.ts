import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateEmbeddings } from '../embedding'
import { EmbeddingResponseValidationError } from '../services/embedding-response-error'

const model = {
  baseUrl: 'https://embedding.example/v1',
  apiKey: 'test-key',
  modelName: 'test-embedding-model',
}

function successfulResponse(embeddings: number[][]) {
  return {
    ok: true,
    json: async () => ({
      data: embeddings.map((embedding, index) => ({ index, embedding })),
    }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SCHED-001: Bounded Concurrency & First-Failure Adjudication for Single-Book Network Tasks', () => {
  it('enforces bounded concurrency limit on multiple embedding batches', async () => {
    let currentInFlight = 0
    let peakInFlight = 0
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const fetchMock = vi.fn().mockImplementation(async () => {
      currentInFlight++
      peakInFlight = Math.max(peakInFlight, currentInFlight)
      await delay(25)
      currentInFlight--
      return successfulResponse([[0.1, 0.2]])
    })
    vi.stubGlobal('fetch', fetchMock)

    // 6 个文本，batchSize = 1，共 6 个批次。concurrencyLimit = 2
    const texts = ['段落1', '段落2', '段落3', '段落4', '段落5', '段落6']
    const result = await generateEmbeddings(texts, 'openai', model, 1, undefined, undefined, 2)

    expect(result.length).toBe(6)
    expect(peakInFlight).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('assembles results in original text order even when network responses return out-of-order', async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    // 模拟批次耗时倒序返回：批次0耗时40ms，批次1耗时10ms
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      const input = body.input as string[]
      if (input.includes('第一批')) {
        await delay(40)
        return successfulResponse([[1.0, 1.0]])
      }
      if (input.includes('第二批')) {
        await delay(10)
        return successfulResponse([[2.0, 2.0]])
      }
      return successfulResponse([[0.0, 0.0]])
    })
    vi.stubGlobal('fetch', fetchMock)

    const texts = ['第一批', '第二批']
    const result = await generateEmbeddings(texts, 'openai', model, 1, undefined, undefined, 2)

    expect(result).toEqual([
      [1.0, 1.0],
      [2.0, 2.0],
    ])
  })

  it('adjudicates by original batch order: earlier network error prevails over later validation error', async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    // 批次 0：较慢返回普通网络错误 (HTTP 500)
    // 批次 1：较快返回致命校验错误 (维度不匹配，返回 1 维向量，期望与其它向量不一致或空畸形数据)
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      const input = body.input as string[]
      if (input.includes('批次0')) {
        await delay(35)
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        }
      }
      if (input.includes('批次1')) {
        await delay(10)
        // 返回畸形 HTML 触发 EmbeddingResponseValidationError
        return new Response('<!doctype html><html>502 Bad Gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      return successfulResponse([[0.1, 0.2]])
    })
    vi.stubGlobal('fetch', fetchMock)

    const texts = ['批次0', '批次1']
    // 原串行路径首先遭遇批次 0，因此即使批次 1 先返回 HTML 畸形错误，最终裁决必须抛出批次 0 的普通网络错误
    const promise = generateEmbeddings(texts, 'openai', model, 1, undefined, undefined, 2)
    await expect(promise).rejects.toMatchObject({
      message: 'EMBEDDING_REQUEST_FAILED',
      status: 500,
    })
  })

  it('adjudicates by original batch order: earlier validation error prevails over later network error', async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    // 批次 0：较慢返回致命校验错误 (HTML 畸形)
    // 批次 1：较快返回普通网络错误 (HTTP 500)
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      const input = body.input as string[]
      if (input.includes('批次0')) {
        await delay(35)
        return new Response('<!doctype html><html>502 Bad Gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      if (input.includes('批次1')) {
        await delay(10)
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        }
      }
      return successfulResponse([[0.1, 0.2]])
    })
    vi.stubGlobal('fetch', fetchMock)

    const texts = ['批次0', '批次1']
    // 原串行路径首先遭遇批次 0，因此裁决必须抛出 EmbeddingResponseValidationError（硬失败）
    const promise = generateEmbeddings(texts, 'openai', model, 1, undefined, undefined, 2)
    await expect(promise).rejects.toBeInstanceOf(EmbeddingResponseValidationError)
  })

  it('drains in-flight requests and avoids dispatching subsequent queued batches when a failure occurs', async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let inFlightCount = 0
    let totalDispatched = 0
    let drainedCleanly = false

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      totalDispatched++
      inFlightCount++
      const body = JSON.parse(init?.body as string)
      const input = body.input as string[]
      if (input.includes('批次0')) {
        await delay(10)
        inFlightCount--
        return { ok: false, status: 503 }
      }
      if (input.includes('批次1')) {
        await delay(30)
        inFlightCount--
        drainedCleanly = true
        return successfulResponse([[0.1, 0.2]])
      }
      inFlightCount--
      return successfulResponse([[0.1, 0.2]])
    })
    vi.stubGlobal('fetch', fetchMock)

    // 4 个批次，并发为 2。批次 0 失败，批次 1 正在链路上，批次 2 和 3 不应派发
    const texts = ['批次0', '批次1', '批次2', '批次3']
    await expect(
      generateEmbeddings(texts, 'openai', model, 1, undefined, undefined, 2),
    ).rejects.toMatchObject({
      message: 'EMBEDDING_REQUEST_FAILED',
      status: 503,
    })

    // 吸收在途结果：批次 1 被等待完成
    expect(drainedCleanly).toBe(true)
    expect(inFlightCount).toBe(0)
    // 批次 2 和 3 未被派发
    expect(totalDispatched).toBe(2)
  })

  it('falls back to strict serial execution when concurrencyLimit is 1', async () => {
    let currentInFlight = 0
    let peakInFlight = 0
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const fetchMock = vi.fn().mockImplementation(async () => {
      currentInFlight++
      peakInFlight = Math.max(peakInFlight, currentInFlight)
      await delay(15)
      currentInFlight--
      return successfulResponse([[0.5, 0.5]])
    })
    vi.stubGlobal('fetch', fetchMock)

    const texts = ['一', '二', '三']
    const result = await generateEmbeddings(texts, 'openai', model, 1, undefined, undefined, 1)

    expect(result.length).toBe(3)
    expect(peakInFlight).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

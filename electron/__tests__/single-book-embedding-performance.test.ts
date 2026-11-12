import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateEmbeddings } from '../embedding'

const TEXT_COUNT = 8
const BATCH_SIZE = 2
const BATCH_COUNT = TEXT_COUNT / BATCH_SIZE
const CONTROLLED_DELAY_MS = 10
const START_TIMEOUT_MS = 2000
const texts = Array.from({ length: TEXT_COUNT }, (_, index) => `fictional-${index}`)
const expected = texts.map((_, index) => [index + 1, 0.25])
const model = { baseUrl: 'https://embedding.example/v1', apiKey: 'fictional-key', modelName: 'fictional-model' }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function observe(concurrency: 1 | 2) {
  const gates = Array.from({ length: BATCH_COUNT }, deferred)
  const started = Array.from({ length: BATCH_COUNT }, deferred)
  const sendOrder: number[] = []
  const completionOrder: number[] = []
  let inFlight = 0
  let maxInFlight = 0
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    const first = texts.indexOf(body.input[0]!)
    const ordinal = first / BATCH_SIZE
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= BATCH_COUNT
      || JSON.stringify(body.input) !== JSON.stringify(texts.slice(first, first + BATCH_SIZE))) {
      throw new Error('SCHED_BENCHMARK_BATCH_INVALID')
    }
    sendOrder.push(ordinal)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    started[ordinal]!.resolve()
    try {
      await gates[ordinal]!.promise
      await new Promise<void>(resolve => setTimeout(resolve, CONTROLLED_DELAY_MS))
      completionOrder.push(ordinal)
      return new Response(JSON.stringify({ data: body.input.map((_, index) => ({
        index, embedding: expected[first + index],
      })) }), { status: 200, headers: { 'content-type': 'application/json' } })
    } finally {
      inFlight--
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  const begin = performance.now()
  const running = generateEmbeddings(texts, 'openai', model, BATCH_SIZE, undefined, undefined, concurrency)
  const outcome = running.then(value => ({ value }), error => ({ error }))
  const waitForStart = async (index: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        started[index]!.promise,
        outcome.then(result => { throw 'error' in result ? result.error : new Error('SCHED_BENCHMARK_EARLY_COMPLETION') }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('SCHED_BENCHMARK_START_TIMEOUT')), START_TIMEOUT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await waitForStart(0)
    if (concurrency === 1) {
      expect(sendOrder).toEqual([0])
      for (let index = 0; index < BATCH_COUNT; index++) {
        await waitForStart(index)
        expect(inFlight).toBe(1)
        gates[index]!.resolve()
      }
    } else {
      await waitForStart(1)
      expect(sendOrder).toEqual([0, 1])
      expect(inFlight).toBe(2)
      gates[1]!.resolve()
      await waitForStart(2)
      expect(completionOrder).toEqual([1])
      gates[0]!.resolve()
      await waitForStart(3)
      expect(completionOrder.slice(0, 2)).toEqual([1, 0])
      gates[2]!.resolve()
      gates[3]!.resolve()
    }
    const output = await running
    const elapsedMs = performance.now() - begin
    expect(output).toEqual(expected)
    expect(fetchMock).toHaveBeenCalledTimes(BATCH_COUNT)
    expect(sendOrder).toEqual([0, 1, 2, 3])
    expect(completionOrder).toHaveLength(BATCH_COUNT)
    expect([...completionOrder].sort()).toEqual([0, 1, 2, 3])
    expect(inFlight).toBe(0)
    expect(maxInFlight).toBe(concurrency)
    expect(Number.isFinite(elapsedMs) && elapsedMs >= 0).toBe(true)
    if (concurrency === 1) expect(completionOrder).toEqual([0, 1, 2, 3])
    return { protocol: 'openai', concurrency, textCount: TEXT_COUNT, batchSize: BATCH_SIZE,
      requestCount: sendOrder.length, completionCount: completionOrder.length, maxInFlight,
      sendOrder, completionOrder, fullOutput: true, elapsedMs, controlledDelayMs: CONTROLLED_DELAY_MS }
  } finally {
    for (const gate of gates) gate.resolve()
    await outcome
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('single-book embedding controlled network observation', () => {
  it('observes serial and bounded-two physical waves with identical ordered output', async () => {
    const serial = await observe(1)
    const parallel = await observe(2)
    expect(serial.completionOrder).not.toEqual(parallel.completionOrder)
    for (const sample of [serial, parallel]) console.info(`PAGEKIN_SCHED_BENCHMARK ${JSON.stringify(sample)}`)
  })
})

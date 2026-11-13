/**
 * Vela 嵌入服务 — 主进程使用
 *
 * 提供文本向量化能力（调用远程 Embedding API）
 * 支持 OpenAI 和 Gemini 两种 Embedding API
 *
 * 注意：向量存储和检索能力已迁移至 vector-store.ts (LanceDB)
 * 本模块仅保留 Embedding API 调用和文本分块功能
 */

import { normalizeEmbeddingOptions, type EmbeddingOptions } from '../src/shared/embedding-options'
import { EmbeddingResponseValidationError } from './services/embedding-response-error'
import { EmbeddingSchedulingError, type EmbeddingSchedulingContext } from './services/embedding-scheduling'
import { createNetworkPermitLifetime } from './services/network-permit-lifetime'
import {
  EmbeddingDispatchBarrierError,
  type EmbeddingBatchObserver,
  type EmbeddingRequestLifecycle,
  type EmbeddingRequestOutcome,
} from './services/reference-embedding-dispatch-contract'

const RELEASE_SMOKE_BASE_URL_PREFIX = 'vela-release-smoke://'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function invalidEmbeddingResponse(provider: 'OpenAI' | 'Gemini', details: string): never {
  throw new EmbeddingResponseValidationError(provider, details)
}

async function parseEmbeddingJsonResponse(
  provider: 'OpenAI' | 'Gemini',
  res: Response,
): Promise<unknown> {
  try {
    return await res.json() as unknown
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    invalidEmbeddingResponse(
      provider,
      `服务端返回非 JSON 响应（HTTP ${res.status}；响应体无法解析为 JSON）。请检查 Base URL、网关或鉴权页。`,
    )
  }
}

/** 界面按码说明；服务商与 HTTP 状态留在异常上，供日志定位。 */
function embeddingHttpError(provider: 'OpenAI' | 'Gemini', status: number): never {
  throw Object.assign(new Error('EMBEDDING_REQUEST_FAILED'), { code: 'EMBEDDING_REQUEST_FAILED', provider, status })
}

function validateEmbeddingVectors(
  provider: 'OpenAI' | 'Gemini',
  vectors: readonly unknown[],
): number[][] {
  let expectedDimension: number | undefined
  const validated: number[][] = []

  for (let vectorIndex = 0; vectorIndex < vectors.length; vectorIndex += 1) {
    const vector = vectors[vectorIndex]
    if (!Array.isArray(vector) || vector.length === 0) {
      invalidEmbeddingResponse(provider, `第 ${vectorIndex + 1} 个向量为空或不是数组`)
    }
    if (expectedDimension === undefined) {
      expectedDimension = vector.length
    } else if (vector.length !== expectedDimension) {
      invalidEmbeddingResponse(
        provider,
        `第 ${vectorIndex + 1} 个向量为 ${vector.length} 维，期望 ${expectedDimension} 维`,
      )
    }

    const values: number[] = []
    for (let valueIndex = 0; valueIndex < vector.length; valueIndex += 1) {
      const value = vector[valueIndex]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        invalidEmbeddingResponse(
          provider,
          `第 ${vectorIndex + 1} 个向量的第 ${valueIndex + 1} 个值不是有限数字（收到 ${String(value)}）`,
        )
      }
      values.push(value)
    }
    validated.push(values)
  }

  return validated
}

function validateOpenAIEmbeddings(data: unknown, batchLength: number): number[][] {
  if (!isRecord(data) || !Array.isArray(data.data)) {
    invalidEmbeddingResponse('OpenAI', 'data 不是数组')
  }

  const responseItems = data.data
  const errors: string[] = []
  if (responseItems.length !== batchLength) {
    errors.push(`数量 ${responseItems.length}，期望 ${batchLength}`)
  }

  const seenIndexes = new Set<number>()
  const embeddingsByIndex: Array<number[] | undefined> = Array.from({ length: batchLength })
  for (const item of responseItems) {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      errors.push('data 项缺少 embedding 数组')
      continue
    }

    const rawIndex = item.index
    if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex)) {
      errors.push(`index ${String(rawIndex)} 不是整数`)
      continue
    }
    const index = rawIndex
    if (index < 0 || index >= batchLength) {
      errors.push(`index ${index} 超出范围 0..${Math.max(batchLength - 1, 0)}`)
      continue
    }
    if (seenIndexes.has(index)) {
      errors.push(`index ${index} 重复`)
      continue
    }

    seenIndexes.add(index)
    embeddingsByIndex[index] = item.embedding as number[]
  }

  const missingIndexes = Array.from({ length: batchLength }, (_value, index) => index)
    .filter(index => !seenIndexes.has(index))
  if (missingIndexes.length > 0) {
    errors.push(`index 覆盖不完整，缺少 ${missingIndexes.join(', ')}`)
  }
  if (errors.length > 0) {
    invalidEmbeddingResponse('OpenAI', errors.join('；'))
  }

  return validateEmbeddingVectors('OpenAI', embeddingsByIndex)
}

function validateGeminiEmbeddings(data: unknown, batchLength: number): number[][] {
  if (!isRecord(data) || !Array.isArray(data.embeddings)) {
    invalidEmbeddingResponse('Gemini', 'embeddings 不是数组')
  }

  const responseItems = data.embeddings
  const errors: string[] = []
  if (responseItems.length !== batchLength) {
    errors.push(`数量 ${responseItems.length}，期望 ${batchLength}`)
  }

  const embeddings: number[][] = []
  for (const item of responseItems) {
    if (!isRecord(item) || !Array.isArray(item.values)) {
      errors.push('embeddings 项缺少 values 数组')
      continue
    }
    embeddings.push(item.values as number[])
  }
  if (errors.length > 0) {
    invalidEmbeddingResponse('Gemini', errors.join('；'))
  }

  return validateEmbeddingVectors('Gemini', embeddings)
}

/**
 * This is deliberately not a user-selectable embedding provider. It exists
 * solely for the installed-package qualification process, which requires both
 * a launch-time environment gate and a matching one-time token in the model.
 */
function releaseSmokeEmbeddings(
  texts: string[],
  model: { baseUrl: string; apiKey: string; modelName?: string; releaseSmokeDimension?: 768 | 1536 },
): number[][] | undefined {
  const token = process.env.AI_NOVEL_RELEASE_SMOKE_TOKEN
  const commandArgument = token ? `--ai-novel-release-smoke=${token}` : ''
  const dimension = model.releaseSmokeDimension ?? Number(/^release-smoke-(768|1536)$/.exec(model.modelName ?? '')?.[1])
  if (
    process.env.AI_NOVEL_RELEASE_SMOKE !== '1'
    || !token
    || !/^[a-f0-9]{32,128}$/i.test(token)
    || process.argv.filter(argument => argument === commandArgument).length !== 1
    || model.apiKey !== token
    || model.baseUrl !== `${RELEASE_SMOKE_BASE_URL_PREFIX}${token}`
    || (dimension !== 768 && dimension !== 1536)
  ) {
    return undefined
  }

  const size = dimension
  return texts.map((text) => {
    let state = 2166136261
    for (let index = 0; index < text.length; index += 1) {
      state = Math.imul(state ^ text.charCodeAt(index), 16777619) >>> 0
    }
    return Array.from({ length: size }, (_value, index) => {
      state = Math.imul(state ^ (index + 1), 16777619) >>> 0
      return (state / 0xffffffff) * 2 - 1
    })
  })
}

// ===== Embedding API 调用 =====

const KNOWN_OPENAI_COMPATIBLE_ROOTS = new Set([
  'https://api.openai.com',
  'https://api.deepseek.com',
  'http://localhost:11434',
  'http://127.0.0.1:11434',
])

const OLLAMA_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

function ollamaOpenAIEmbeddingBaseUrl(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl)
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    if (
      parsed.protocol !== 'http:'
      || parsed.port !== '11434'
      || !OLLAMA_LOCAL_HOSTS.has(parsed.hostname.toLowerCase())
      || pathname !== '/api'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return undefined
    }
    return `${parsed.protocol}//${parsed.host}/v1`
  } catch {
    return undefined
  }
}

function buildOpenAIEmbeddingUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (base.endsWith('/embeddings')) {
    return base
  }
  if (/\/v\d+(?:[a-z0-9.-]*)$/i.test(base)) {
    return `${base}/embeddings`
  }
  if (KNOWN_OPENAI_COMPATIBLE_ROOTS.has(base.toLowerCase())) {
    return `${base}/v1/embeddings`
  }
  // A user-provided /api path is not an inferred OpenAI-compatible root.
  return `${base}/embeddings`
}

/** Shared with transport admission so grouping follows the actual adapter URL. */
export function embeddingRequestUrl(protocol: 'openai' | 'gemini', model: { baseUrl: string; modelName?: string }): string {
  return protocol === 'gemini'
    ? `${model.baseUrl.replace(/\/$/, '')}/v1beta/models/${model.modelName || 'gemini-embedding-001'}:batchEmbedContents`
    : buildOpenAIEmbeddingUrl(model.baseUrl)
}

function dispatchBarrier(): never {
  throw new EmbeddingDispatchBarrierError('REFERENCE_EMBEDDING_DISPATCH_PERSISTENCE_FAILED')
}

function assertLifecycle(lifecycle: unknown): asserts lifecycle is EmbeddingRequestLifecycle {
  if (!isRecord(lifecycle) || typeof lifecycle.beforeDispatch !== 'function' || typeof lifecycle.settled !== 'function') {
    dispatchBarrier()
  }
}

function lifecycleHook(lifecycle: EmbeddingRequestLifecycle | undefined, phase: 'beforeDispatch' | 'settled', outcome?: EmbeddingRequestOutcome): void {
  if (lifecycle === undefined) return
  try {
    assertLifecycle(lifecycle)
    const hook = lifecycle[phase]
    if (Object.prototype.toString.call(hook) === '[object AsyncFunction]') dispatchBarrier()
    const result: unknown = phase === 'beforeDispatch' ? lifecycle.beforeDispatch() : lifecycle.settled(outcome!)
    if (result !== undefined) {
      // A rejected asynchronous guard must not escape as an unhandled rejection.
      if (result && (typeof result === 'object' || typeof result === 'function')
        && typeof (result as { then?: unknown }).then === 'function') void Promise.resolve(result).catch(() => {})
      dispatchBarrier()
    }
  } catch (error) {
    if (error instanceof EmbeddingDispatchBarrierError) throw error
    dispatchBarrier()
  }
}

function batchLifecycle(observer: EmbeddingBatchObserver | undefined, ordinal: number, count: number): EmbeddingRequestLifecycle | undefined {
  if (observer === undefined) return undefined
  try {
    if (!isRecord(observer) || typeof observer.forBatch !== 'function'
      || Object.prototype.toString.call(observer.forBatch) === '[object AsyncFunction]') dispatchBarrier()
    const lifecycle: unknown = observer.forBatch(ordinal, count)
    if (lifecycle && (typeof lifecycle === 'object' || typeof lifecycle === 'function')
      && typeof (lifecycle as { then?: unknown }).then === 'function') {
      void Promise.resolve(lifecycle).catch(() => {})
      dispatchBarrier()
    }
    assertLifecycle(lifecycle)
    return lifecycle
  } catch (error) {
    if (error instanceof EmbeddingDispatchBarrierError) throw error
    dispatchBarrier()
  }
}

async function requestEmbeddings(
  provider: 'OpenAI' | 'Gemini',
  url: string,
  init: RequestInit,
  batchLength: number,
  lifecycle?: EmbeddingRequestLifecycle,
): Promise<number[][]> {
  lifecycleHook(lifecycle, 'beforeDispatch')
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (error) {
    lifecycleHook(lifecycle, 'settled', { kind: 'transport_unknown' })
    throw error
  }
  if (!res.ok) {
    // Headers do not close a physical request. Discard chunks without retaining
    // a potentially sensitive or unbounded provider error body.
    const reader = res.body?.getReader()
    try {
      if (reader) while (!(await reader.read()).done) { /* drain */ }
    } catch (error) {
      lifecycleHook(lifecycle, 'settled', { kind: 'transport_unknown' })
      throw error
    } finally { reader?.releaseLock() }
    lifecycleHook(lifecycle, 'settled', { kind: 'http_failed', httpStatus: res.status })
    embeddingHttpError(provider, res.status)
  }
  let vectors: number[][]
  try {
    const data = await parseEmbeddingJsonResponse(provider, res)
    vectors = provider === 'OpenAI' ? validateOpenAIEmbeddings(data, batchLength) : validateGeminiEmbeddings(data, batchLength)
  } catch (error) {
    lifecycleHook(lifecycle, 'settled', error instanceof EmbeddingResponseValidationError
      ? { kind: 'response_invalid', httpStatus: res.status } : { kind: 'transport_unknown' })
    throw error
  }
  lifecycleHook(lifecycle, 'settled', { kind: 'response_received', httpStatus: res.status })
  return vectors
}

/** OpenAI Embedding API */
export async function embedOpenAI(
  texts: string[],
  model: { baseUrl: string; apiKey: string; modelName?: string },
  signal?: AbortSignal,
  lifecycle?: EmbeddingRequestLifecycle,
): Promise<number[][]> {
  const ollamaCompatibleBaseUrl = ollamaOpenAIEmbeddingBaseUrl(model.baseUrl)
  if (ollamaCompatibleBaseUrl) {
    throw Object.assign(new Error('EMBEDDING_OLLAMA_NATIVE_URL'), { code: 'EMBEDDING_OLLAMA_NATIVE_URL', suggestedBaseUrl: ollamaCompatibleBaseUrl })
  }
  const embeddingModel = model.modelName || 'text-embedding-3-small'
  const url = embeddingRequestUrl('openai', model)
  return requestEmbeddings('OpenAI', url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: texts,
    }),
    signal,
  }, texts.length, lifecycle)
}

/** Gemini Embedding API */
export async function embedGemini(
  texts: string[],
  model: { baseUrl: string; apiKey: string; modelName?: string },
  signal?: AbortSignal,
  lifecycle?: EmbeddingRequestLifecycle,
): Promise<number[][]> {
  const embeddingModel = model.modelName || 'gemini-embedding-001'
  // Gemini batchEmbedContents 支持批量
  const url = embeddingRequestUrl('gemini', model)
  const requests = texts.map((text) => ({
    model: `models/${embeddingModel}`,
    content: { parts: [{ text }] },
    taskType: 'RETRIEVAL_DOCUMENT',
  }))

  return requestEmbeddings('Gemini', url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': model.apiKey,
    },
    body: JSON.stringify({ requests }),
    signal,
  }, texts.length, lifecycle)
}

/** 统一的 Embedding 调用接口 (支持 SCHED-001 单书独立网络任务有界并发与首失败保序裁决) */
export async function generateEmbeddings(
  texts: string[],
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; apiKey: string; modelName?: string; embeddingOptions?: Partial<EmbeddingOptions> | null },
  configuredBatchSize?: number,
  assertActive?: () => void,
  signal?: AbortSignal,
  configuredConcurrencyLimit?: number,
  observer?: EmbeddingBatchObserver,
  scheduling?: EmbeddingSchedulingContext,
): Promise<number[][]> {
  // 空文本处理
  if (texts.length === 0) return []
  const smokeEmbeddings = releaseSmokeEmbeddings(texts, model)
  if (smokeEmbeddings) return smokeEmbeddings

  // 批量与并发参数规范化
  const normalizedOptions = normalizeEmbeddingOptions(model.embeddingOptions)
  const batchSize = configuredBatchSize === undefined
    ? (protocol === 'gemini' ? 100 : 50)
    : normalizeEmbeddingOptions({ batchSize: configuredBatchSize }).batchSize

  const concurrencyLimit = configuredConcurrencyLimit === undefined
    ? (normalizedOptions.concurrencyLimit ?? 1)
    : Math.min(4, Math.max(1, Math.trunc(configuredConcurrencyLimit)))

  // 将 texts 切割为带有原始 batch 序号的批次
  const batches: Array<{ index: number; texts: string[] }> = []
  for (let i = 0, batchIdx = 0; i < texts.length; i += batchSize, batchIdx++) {
    batches.push({ index: batchIdx, texts: texts.slice(i, i + batchSize) })
  }

  const queueStop = new AbortController()
  const siblingStopped = Symbol('embedding sibling stopped')
  const externalSignals = [signal, scheduling?.signal].filter((value): value is AbortSignal => value !== undefined)
  const physicalSignal = externalSignals.length ? AbortSignal.any(externalSignals) : undefined
  const queueSignal = AbortSignal.any([...externalSignals, ...(scheduling?.queueSignal ? [scheduling.queueSignal] : []), queueStop.signal])
  const assertBatchActive = () => {
    if (!scheduling) { assertActive?.(); return }
    try {
      if (physicalSignal?.aborted) throw new Error('GENERATION_ACTION_CANCELLED')
      scheduling.assertActive()
      assertActive?.()
    } catch (error) {
      if (error instanceof EmbeddingDispatchBarrierError || error instanceof EmbeddingSchedulingError) throw error
      throw new EmbeddingSchedulingError(error)
    }
  }
  const executeBatch = async (batch: { index: number; texts: string[] }) => {
    assertBatchActive()
    const lifecycle = batchLifecycle(observer, batch.index, batch.texts.length)
    let lifetime: ReturnType<typeof createNetworkPermitLifetime> | undefined
    if (scheduling) {
      try {
        const acquire = scheduling.admission.acquireEmbedding
        if (!acquire) throw new Error('GENERATION_REQUEST_FAILED')
        const permit = await acquire.call(scheduling.admission, {
          projectKey: scheduling.projectKey, configuration: { protocol, model: {
            provider: '', baseUrl: model.baseUrl, apiKey: model.apiKey, modelName: model.modelName,
          } }, lane: scheduling.lane, signal: queueSignal,
        })
        lifetime = createNetworkPermitLifetime(permit, physicalSignal, scheduling.quarantineAfterMs)
        if (queueStop.signal.aborted) throw new Error('GENERATION_ACTION_CANCELLED')
        assertBatchActive()
      } catch (error) {
        lifetime?.finish()
        if (queueStop.signal.aborted && !physicalSignal?.aborted) throw siblingStopped
        if (error instanceof EmbeddingDispatchBarrierError || error instanceof EmbeddingSchedulingError) throw error
        throw new EmbeddingSchedulingError(error)
      }
    }
    try {
      const embeddings = protocol === 'gemini'
        ? await embedGemini(batch.texts, model, physicalSignal, lifecycle)
        : await embedOpenAI(batch.texts, model, physicalSignal, lifecycle)
      assertBatchActive()
      return embeddings
    } finally { lifetime?.finish() }
  }

  // 若只有一个 batch 或并发限制为 1，直接保序串行执行并返回
  if (batches.length <= 1 || concurrencyLimit === 1) {
    const results: number[][] = []
    for (const batch of batches) {
      const embeddings = await executeBatch(batch)
      results.push(...embeddings)
    }
    return validateEmbeddingVectors(protocol === 'gemini' ? 'Gemini' : 'OpenAI', results)
  }

  // 有界并发调度池（bounded concurrency pool）
  type BatchOutcome =
    | { status: 'fulfilled'; embeddings: number[][] }
    | { status: 'rejected'; error: unknown }

  const outcomes: BatchOutcome[] = new Array(batches.length)
  let nextBatchIndex = 0
  let stopped = false
  const activeWorkerPromises: Array<Promise<void>> = []

  const worker = async () => {
    while (!stopped && !signal?.aborted) {
      const current = nextBatchIndex++
      if (current >= batches.length) break

      const batch = batches[current]
      try {
        assertBatchActive()
        if (signal?.aborted) {
          throw new Error('EMBEDDING_REQUEST_ABORTED')
        }
        const embeddings = await executeBatch(batch)
        outcomes[current] = { status: 'fulfilled', embeddings }
      } catch (error) {
        if (error === siblingStopped && stopped) return
        outcomes[current] = { status: 'rejected', error }
        // 标记后续未派发 batch 停止派发，但已在途请求必须等待其自然返回（吸收在途结果）
        stopped = true
        if (scheduling) queueStop.abort()
      }
    }
  }

  // 启动并发 worker，有界容量为 concurrencyLimit
  const workersCount = Math.min(concurrencyLimit, batches.length)
  for (let w = 0; w < workersCount; w++) {
    activeWorkerPromises.push(worker())
  }

  // 等待所有在途 worker 彻底退出并吸收所有在途请求结果
  await Promise.allSettled(activeWorkerPromises)

  // A lost dispatch/settlement receipt forbids fallback even if an earlier batch failed normally.
  for (const outcome of outcomes) {
    if (outcome?.status === 'rejected' && (outcome.error instanceof EmbeddingDispatchBarrierError
      || outcome.error instanceof EmbeddingSchedulingError)) throw outcome.error
  }

  // 按原 batch 序号严格首失败裁决（First-Failure Adjudication by Original Batch Order）
  for (let i = 0; i < batches.length; i++) {
    const outcome = outcomes[i]
    if (!outcome) {
      assertActive?.()
      if (signal?.aborted) throw new Error('EMBEDDING_REQUEST_ABORTED')
      throw new Error(`EMBEDDING_BATCH_UNPROCESSED: batch ${i} was not processed due to prior failure`)
    }
    if (outcome.status === 'rejected') {
      throw outcome.error
    }
  }

  // 组装结果并执行整文档整体校验
  const allResults: number[][] = []
  for (let i = 0; i < batches.length; i++) {
    const outcome = outcomes[i]
    if (outcome.status === 'fulfilled') {
      allResults.push(...outcome.embeddings)
    }
  }

  return validateEmbeddingVectors(protocol === 'gemini' ? 'Gemini' : 'OpenAI', allResults)
}

// ===== 文本分块 =====

/** 将文本按段落分块，每块约 maxChars 字符 */
export function chunkText(
  text: string,
  maxChars: number = 500,
  overlap: number = 50,
): string[] {
  // 先按段落分割
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)

  const chunks: string[] = []
  const pushWithinLimit = (value: string) => {
    const normalized = value.trim()
    if (!normalized) return
    if (normalized.length <= maxChars) {
      chunks.push(normalized)
      return
    }

    // 单句可能远超分块上限；强制切分，防止本地模型仍收到超长输入。
    let start = 0
    while (start < normalized.length) {
      const end = Math.min(start + maxChars, normalized.length)
      chunks.push(normalized.slice(start, end))
      if (end === normalized.length) break
      start = Math.max(start + 1, end - overlap)
    }
  }
  let currentChunk = ''

  for (const para of paragraphs) {
    // 如果段落本身就超过 maxChars，按句号分割
    if (para.length > maxChars) {
      if (currentChunk) {
        pushWithinLimit(currentChunk)
        currentChunk = ''
      }
      // 按句号分割长段落
      const sentences = para.split(/(?<=[。！？.!?])\s*/)
      let sentenceChunk = ''
      for (const sentence of sentences) {
        if (sentenceChunk.length + sentence.length > maxChars && sentenceChunk.length > 0) {
          pushWithinLimit(sentenceChunk)
          // 保留 overlap
          sentenceChunk = (overlap === 0 ? '' : sentenceChunk.slice(-overlap)) + sentence
        } else {
          sentenceChunk += sentence
        }
      }
      if (sentenceChunk.trim()) {
        currentChunk = sentenceChunk
      }
      continue
    }

    // 累积段落
    if (currentChunk.length + para.length > maxChars && currentChunk.length > 0) {
      pushWithinLimit(currentChunk)
      // 保留 overlap
      currentChunk = (overlap === 0 ? '' : currentChunk.slice(-overlap)) + '\n\n' + para
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para
    }
  }

  if (currentChunk.trim()) {
    pushWithinLimit(currentChunk)
  }

  return chunks.length > 0 ? chunks : [text.trim()]
}

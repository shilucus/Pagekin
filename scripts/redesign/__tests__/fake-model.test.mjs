import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, it } from 'vitest'
import { FAKE_MODEL, startFakeModel, streamingProse } from '../fake-model.mjs'

let fake
afterEach(async () => { await fake?.close() })

/** 按模型客户端的方式请求一次正文，返回各块的 finish_reason 与拼出的正文。 */
async function writeProse() {
  const response = await fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FAKE_MODEL.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FAKE_MODEL.modelName, stream: true, messages: [{ role: 'user', content: '写第 3 章正文。' }] }),
  })
  const chunks = (await response.text()).split('\n\n')
    .filter(line => line.startsWith('data: {'))
    .flatMap(line => JSON.parse(line.slice('data: '.length)).choices)
  return { finish: chunks.map(choice => choice.finish_reason), text: chunks.map(choice => choice.delta.content ?? '').join('') }
}

function chatRequest(options = {}) {
  return fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${FAKE_MODEL.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FAKE_MODEL.modelName, stream: true, messages: [{ role: 'user', content: 'Fictional prompt.' }] }),
    ...options,
  })
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fake-model test timeout')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

it.each(['openai', 'anthropic'])('hashes all non-message request parameters for %s without retaining their values', async protocol => {
  fake = await startFakeModel([])
  const base = { model: FAKE_MODEL.modelName, stream: true, stream_options: { include_usage: true },
    response_format: { type: 'json_schema', json_schema: { name: 'fictional', schema: { type: 'object' } } },
    additional: { nested: [{ value: 'fictional-private-parameter' }] },
    messages: [{ role: 'user', content: 'Fictional prompt.' }] }
  const variants = [base,
    { ...base, messages: [{ role: 'user', content: 'Different fictional prompt.' }] },
    { ...base, stream_options: { include_usage: false } },
    { ...base, response_format: { ...base.response_format, json_schema: { ...base.response_format.json_schema, schema: { type: 'array' } } } },
    { ...base, additional: { nested: [{ value: 'different-private-parameter' }] } }]
  const path = protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages'
  const auth = protocol === 'openai' ? { Authorization: `Bearer ${FAKE_MODEL.apiKey}` } : { 'x-api-key': FAKE_MODEL.apiKey }
  for (const body of variants) {
    const response = await fetch(`http://127.0.0.1:${fake.port}${path}`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    await response.text()
  }
  const hashes = fake.chats.map(chat => chat.requestParametersHash)
  const expected = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'messages'))
  assert.equal(hashes[0], createHash('sha256').update(JSON.stringify(expected), 'utf8').digest('hex'))
  assert.equal(hashes[0], hashes[1])
  assert.equal(new Set([hashes[0], ...hashes.slice(2)]).size, 4)
  assert.ok(hashes.every(hash => /^[0-9a-f]{64}$/u.test(hash)))
  assert.doesNotMatch(JSON.stringify(fake.chats), /fictional-private-parameter|different-private-parameter/u)
  assert.doesNotMatch(JSON.stringify(fake.chats), new RegExp(FAKE_MODEL.apiKey, 'u'))
})

it('records completed chats with a monotonic clock and no prompt or credentials', async () => {
  fake = await startFakeModel([])
  const response = await chatRequest()
  await response.text()
  await waitFor(() => fake.chatTimings[0]?.endMs !== null)
  const [timing] = fake.chatTimings
  assert.deepEqual(Object.keys(timing).sort(), ['completed', 'endMs', 'index', 'startMs', 'statusCode'])
  assert.equal(timing.index, 0)
  assert.equal(timing.completed, true)
  assert.equal(timing.statusCode, 200)
  assert.ok(timing.endMs >= timing.startMs)
  assert.equal(fake.chats.length, 1)
})

it('delays concurrent chats independently before headers and restores zero delay', async () => {
  fake = await startFakeModel([])
  fake.setChatDelay(120)
  const requests = [chatRequest(), chatRequest()]
  await waitFor(() => fake.chatTimings.length === 2)
  assert.ok(fake.chatTimings.every(item => item.endMs === null && item.statusCode === null && !item.completed))
  const responses = await Promise.all(requests)
  await Promise.all(responses.map(response => response.text()))
  await waitFor(() => fake.chatTimings.every(item => item.endMs !== null))
  const [first, second] = fake.chatTimings
  assert.ok(first.endMs - first.startMs >= 100)
  assert.ok(second.endMs - second.startMs >= 100)
  assert.ok(Math.max(first.startMs, second.startMs) < Math.min(first.endMs, second.endMs))
  assert.deepEqual(fake.chatTimings.map(item => [item.index, item.statusCode, item.completed]), [[0, 200, true], [1, 200, true]])
  fake.setChatDelay(0)
  await (await chatRequest()).text()
  assert.equal(fake.chatTimings[2].completed, true)
})

it('validates delay and preserves the previous setting after invalid inputs', async () => {
  fake = await startFakeModel([])
  fake.setChatDelay(100)
  for (const value of [-1, 0.5, 2001, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => fake.setChatDelay(value), RangeError)
  }
  await (await chatRequest()).text()
  assert.ok(fake.chatTimings[0].endMs - fake.chatTimings[0].startMs >= 80)
})

it('records aborted requests once and does not send after gate release or delay', async () => {
  fake = await startFakeModel([])
  fake.setChatDelay(200)
  fake.gate.hold()
  const abort = new AbortController()
  const pending = chatRequest({ signal: abort.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  try {
    await waitFor(() => fake.gate.waiting === 1 && fake.chatTimings.length === 1)
    abort.abort()
    await rejected
    await waitFor(() => fake.chatTimings[0].endMs !== null)
    const ended = fake.chatTimings[0].endMs
    assert.deepEqual({ completed: fake.chatTimings[0].completed, statusCode: fake.chatTimings[0].statusCode }, { completed: false, statusCode: null })
    fake.gate.release()
    await waitFor(() => fake.gate.waiting === 0)
    assert.equal(fake.chatTimings[0].endMs, ended)
    assert.deepEqual(fake.chats, [])
    assert.deepEqual(fake.requests, [])
  } finally { fake.gate.release() }
})

it('settles an abort during delay and a server close without late responses', async () => {
  fake = await startFakeModel([])
  fake.setChatDelay(1000)
  const abort = new AbortController()
  const first = chatRequest({ signal: abort.signal })
  const firstRejected = assert.rejects(first, { name: 'AbortError' })
  await waitFor(() => fake.chatTimings.length === 1)
  abort.abort()
  await firstRejected
  await waitFor(() => fake.chatTimings[0].endMs !== null)
  const second = chatRequest()
  const secondRejected = assert.rejects(second)
  await waitFor(() => fake.chatTimings.length === 2)
  await fake.close()
  await secondRejected
  await waitFor(() => fake.chatTimings[1].endMs !== null)
  assert.deepEqual(fake.chatTimings.map(item => [item.completed, item.statusCode]), [[false, null], [false, null]])
  assert.deepEqual(fake.chats, [])
  assert.deepEqual(fake.requests, [])
  fake = undefined
})

it('tracks anthropic chats and preserves gate and rate-limit response behavior', async () => {
  fake = await startFakeModel([])
  fake.gate.hold()
  fake.rejectRateLimit()
  const pending = chatRequest()
  try {
    await waitFor(() => fake.gate.waiting === 1)
    assert.equal(fake.chatTimings[0].endMs, null)
  } finally { fake.gate.release() }
  const limited = await pending
  assert.equal(limited.status, 429)
  await limited.text()
  assert.deepEqual(fake.requests, ['rate-limit'])
  assert.deepEqual(fake.chats, [])
  assert.deepEqual([fake.chatTimings[0].statusCode, fake.chatTimings[0].completed], [429, true])
  const anthropic = await fetch(`http://127.0.0.1:${fake.port}/v1/messages`, {
    method: 'POST', headers: { 'x-api-key': FAKE_MODEL.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FAKE_MODEL.modelName, messages: [{ role: 'user', content: 'Fictional prompt.' }], stream: false }),
  })
  assert.equal(anthropic.status, 200)
  await anthropic.text()
  assert.deepEqual([fake.chatTimings[1].statusCode, fake.chatTimings[1].completed], [200, true])
})

it('failProse 之后流式正文也以 content_filter 结束', async () => {
  fake = await startFakeModel([])
  const chunks = streamingProse(2, 12)
  fake.streamProse({ chunks, intervalMs: 0 })
  fake.failProse()
  assert.deepEqual(await writeProse(), { finish: [null, null, 'content_filter'], text: chunks.join('') })
})

it('failProse(false) 恢复后流式正文照常以 stop 结束', async () => {
  fake = await startFakeModel([])
  const chunks = streamingProse(2, 12)
  fake.streamProse({ chunks, intervalMs: 0 })
  fake.failProse()
  fake.failProse(false)
  assert.deepEqual((await writeProse()).finish, [null, null, 'stop'])
})

async function embedWithoutKey() {
  const response = await fetch(`http://127.0.0.1:${fake.port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: ['潮位'] }),
  })
  return response.status
}

it('acceptKeylessEmbeddings 只在打开期间接受不带 Key 的嵌入请求', async () => {
  fake = await startFakeModel([])
  const refusedBefore = await embedWithoutKey()
  fake.acceptKeylessEmbeddings()
  const accepted = await embedWithoutKey()
  fake.acceptKeylessEmbeddings(false)
  assert.deepEqual({ refusedBefore, accepted, refusedAfter: await embedWithoutKey(), authorizations: fake.embeddingAuthorizations },
    { refusedBefore: 403, accepted: 200, refusedAfter: 403, authorizations: [null] })
})

it('rejectContextLength 让对话请求回 400 上下文超长错误体，记成 context-length；关掉后照常回正文', async () => {
  fake = await startFakeModel([])
  fake.rejectContextLength()
  const response = await fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FAKE_MODEL.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FAKE_MODEL.modelName, stream: true, messages: [{ role: 'user', content: '写第 3 章正文。' }] }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error.message, /maximum context length is \d+ tokens/u)
  assert.deepEqual(fake.requests, ['context-length'])
  assert.deepEqual(fake.chats, [])
  fake.rejectContextLength(false)
  assert.deepEqual((await writeProse()).finish.at(-1), 'stop')
})

it('rejectRateLimit returns an actual local HTTP 429 and disabling it restores the original stream', async () => {
  fake = await startFakeModel([])
  fake.rejectRateLimit()
  const response = await fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${FAKE_MODEL.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FAKE_MODEL.modelName, stream: true, messages: [{ role: 'user', content: 'Fictional prose.' }] }),
  })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '1')
  assert.equal((await response.json()).error.code, 'rate_limit_exceeded')
  assert.deepEqual(fake.requests, ['rate-limit'])
  assert.deepEqual(fake.chats, [])
  fake.rejectRateLimit(false)
  assert.equal((await writeProse()).finish.at(-1), 'stop')
})

it('streams independent reasoning before visible prose without putting reasoning in the visible stream log', async () => {
  fake = await startFakeModel([])
  const chunks = streamingProse(3, 16)
  fake.streamProse({ chunks, intervalMs: 0, reasoningChunks: ['Reason one.', 'Reason two.'], reasoningIntervalMs: 0 })
  const response = await fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${FAKE_MODEL.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FAKE_MODEL.modelName, stream: true, messages: [{ role: 'user', content: 'Fictional prose.' }] }),
  })
  const events = (await response.text()).split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
  const deltas = events.flatMap(event => event.choices).map(choice => choice.delta)
  assert.deepEqual(deltas.slice(0, 2), [{ reasoning_content: 'Reason one.' }, { reasoning_content: 'Reason two.' }])
  assert.equal(deltas.map(delta => delta.content ?? '').join(''), chunks.join(''))
  assert.equal(events.at(-1).usage.completion_tokens_details.reasoning_tokens, 32)
  assert.equal(fake.streamLog.length, 3)
  fake.streamProse(null)
  assert.equal((await writeProse()).finish.at(-1), 'stop')
})


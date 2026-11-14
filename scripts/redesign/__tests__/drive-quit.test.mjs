import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { captureFixtureRequestCutoff, observeFixtureQuitCutoff, quit } from '../drive.mjs'
import { FAKE_MODEL, startFakeModel } from '../fake-model.mjs'

const fakeApp = (child, close) => ({ process: () => child, close })

it('retains a settled cutoff and detects timing status changes even with unchanged counts', () => {
  const fake = { requests: ['prose'], chatTimings: [{ index: 0, startMs: 1, endMs: 2, statusCode: 200, completed: true }] }
  const cutoff = captureFixtureRequestCutoff(fake)
  assert.deepEqual(observeFixtureQuitCutoff(fake, cutoff), { modelRequestsAfterFinalCutoff: 0,
    modelTimingRecordsAfterFinalCutoff: 0, unchanged: true })
  fake.chatTimings[0].completed = false
  assert.equal(cutoff.timings[0].completed, true)
  assert.equal(observeFixtureQuitCutoff(fake, cutoff).unchanged, false)
  fake.chatTimings[0].endMs = null
  assert.equal(observeFixtureQuitCutoff(fake, captureFixtureRequestCutoff(fake)).unchanged, false)
})

it('detects a request received after cutoff and closed before fake acceptance', async () => {
  const fake = await startFakeModel([])
  fake.setChatDelay(1000)
  const cutoff = captureFixtureRequestCutoff(fake)
  const request = fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, { method: 'POST',
    headers: { Authorization: `Bearer ${FAKE_MODEL.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FAKE_MODEL.modelName, messages: [{ role: 'user', content: 'Fictional cutoff input.' }] }) })
  const rejected = assert.rejects(request)
  try {
    const deadline = Date.now() + 2000
    while (fake.chatTimings.length === 0) {
      assert.ok(Date.now() < deadline, 'fixture request did not arrive')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    await fake.close()
    await rejected
    assert.equal(fake.requests.length, 0)
    assert.deepEqual(observeFixtureQuitCutoff(fake, cutoff), { modelRequestsAfterFinalCutoff: 0,
      modelTimingRecordsAfterFinalCutoff: 1, unchanged: false })
  } finally { await fake.close() }
})

it('close 失败但进程已自行退出时不再强杀，也不把「not found」当成失败', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  const result = await quit(fakeApp(child, () => Promise.reject(new Error('Target page, context or browser has been closed'))))
  assert.deepEqual(result, { forced: false })
})

it('宽限期内未关闭且进程仍在时强杀整棵进程树', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  const result = await quit(fakeApp(child, () => new Promise(() => {})), 50)
  assert.deepEqual(result, { forced: true })
  await exited
})

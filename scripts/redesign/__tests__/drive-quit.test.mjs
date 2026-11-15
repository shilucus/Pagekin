import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { assertNormalQuitOutcome, captureFixtureRequestCutoff, observeFixtureQuitCutoff, quit, recordQuitOutcome, sessionIsClean } from '../drive.mjs'
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
  const result = await quit(fakeApp(child, () => Promise.reject(new Error('closed [synthetic-private-detail]'))))
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.forced, false)
  assert.equal(result.killStatus, 'not-needed')
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0)
  assert.equal(JSON.stringify(result).includes('synthetic-private-detail'), false)
})

it('宽限期内未关闭且进程仍在时强杀整棵进程树', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  const result = await quit(fakeApp(child, () => new Promise(() => {})), 50)
  assert.equal(result.outcome, 'timeout')
  assert.equal(result.forced, true)
  assert.equal(result.killStatus, 'completed')
  assert.ok(result.elapsedMs >= 50)
  await exited
})

it('已完成关闭的子进程记录 resolved outcome 与耗时', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  const result = await quit(fakeApp(child, () => Promise.resolve()))
  assert.deepEqual({ outcome: result.outcome, forced: result.forced, killStatus: result.killStatus },
    { outcome: 'resolved', forced: false, killStatus: 'not-needed' })
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0)
})

it('forced close marks the session failed and unclean without retaining a close error', () => {
  const shared = {}
  const sessionErrors = []
  const quitResult = { outcome: 'timeout', elapsedMs: 50, forced: true, killStatus: 'completed' }
  recordQuitOutcome(shared, sessionErrors, quitResult)
  assert.deepEqual(shared.quit, quitResult)
  assert.deepEqual(sessionErrors, ['DRIVE_APP_FORCED_CLOSE'])
  assert.equal(sessionIsClean({ failedAt: null, sessionErrors, residualProcesses: [], externalWrites: [], quit: quitResult }), false)
})

it.each(['rejected', 'timeout'])('a dead PID after %s close is not a normal session quit', outcome => {
  const quitResult = { outcome, elapsedMs: 1, forced: false, killStatus: 'not-needed' }
  const shared = {}, sessionErrors = []
  recordQuitOutcome(shared, sessionErrors, quitResult)
  assert.equal(sessionIsClean({ failedAt: null, sessionErrors, residualProcesses: [], externalWrites: [], quit: quitResult }), false)
  assert.throws(() => assertNormalQuitOutcome(quitResult), /DRIVE_APP_QUIT_NOT_NORMAL/u)
  assert.doesNotThrow(() => assertNormalQuitOutcome({ outcome: 'resolved', forced: false, killStatus: 'not-needed' }))
})

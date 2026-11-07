import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'

async function waitForGate(gate, waiting, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (waiting ? !gate.waiting : gate.waiting) {
    if (Date.now() >= deadline) throw new Error('RUNTIME_FEEDBACK_SCENARIO_GATE_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function bounded(promise, timeoutMs = 60_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('RUNTIME_FEEDBACK_SCENARIO_SETTLEMENT_TIMEOUT')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

async function guardedRequestCount(app) {
  return app.evaluate(() => {
    if (!Array.isArray(globalThis.__driveModelRequests)) throw new Error('RUNTIME_FEEDBACK_SCENARIO_REQUEST_LOG_MISSING')
    return globalThis.__driveModelRequests.filter(entry => entry.path === '/v1/chat/completions').length
  })
}

async function waitForHandoff(invoke, page, session, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return await invoke(page, 'planning-feedback:v1:capture', { target: 'coreOutline' }, session) }
    catch (error) {
      if (!/GENERATION_OWNER_BUSY/u.test(String(error?.message ?? error))) throw error
      if (Date.now() >= deadline) throw new Error('RUNTIME_FEEDBACK_SCENARIO_DRAIN_TIMEOUT', { cause: error })
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

export async function runRuntimeFeedbackScenario(context, dependencies = {}) {
  const { app, page, roots, invoke, fake } = context
  const grantDirectory = dependencies.grantDirectory ?? chooseProjectDirectoryGrant
  const awaitGate = dependencies.awaitGate ?? waitForGate
  const requestCount = dependencies.requestCount ?? guardedRequestCount
  const awaitHandoff = dependencies.awaitHandoff ?? waitForHandoff
  const opened = new Map()
  let pending, outcome
  async function open(project) {
    const result = await invoke(page, 'project-runtime:v1:open-view', project.projectPath, randomUUID(), null)
    assert.equal(result?.success, true, 'fictional project open failed')
    opened.set(project.projectPath, project)
    return { projectId: project.projectId, projectPath: project.projectPath, leaseId: result.project.sessionLease }
  }
  async function create(name) {
    const grant = await grantDirectory(app, page, roots.projects)
    const result = await invoke(page, 'project:create', { parentGrantId: grant.grantId,
      name, genre: '', targetAudience: '', writingLanguage: 'en-US' }, randomUUID(), null)
    assert.equal(result?.success, true, `fictional project creation failed: ${result?.error ?? 'no error receipt'}`)
    return { projectId: result.projectId, projectPath: result.projectPath }
  }
  async function prepare(session, baseId) {
    const request = { operationId: randomUUID(), input: { baseId, feedback: 'Revise fictional outline', constraints: [] }, modelId: FAKE_MODEL.id }
    const result = await invoke(page, 'runtime-feedback:v1:prepare', request, session)
    assert.ok(result.reference, 'fresh grant must have a capability reference')
    assert.equal(result.receipt.grant.state, 'active')
    return { request, ...result }
  }
  async function close(project, session) {
    const result = await invoke(page, 'db:close', project.projectPath, session)
    assert.equal(result?.success, true, 'fictional runtime close failed')
    opened.delete(project.projectPath)
  }
  async function closeOpened() {
    const failures = []
    for (const project of [...opened.values()]) {
      try { await close(project, await open(project)) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'RUNTIME_FEEDBACK_SCENARIO_CLEANUP_FAILED')
  }
  try {
    assert.ok(fake?.gate, 'RUNTIME_FEEDBACK_SCENARIO_FAKE_REQUIRED')
    const initial = await requestCount(app)
    const projectA = await create('Feedback A'), projectB = await create('Feedback B')
    assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
    const sessionA = await open(projectA)
    assert.equal((await invoke(page, 'db:project-core-update', { coreOutline: 'Fictional A' }, projectA.projectPath, sessionA)).success, true)
    const baseA = await invoke(page, 'planning-feedback:v1:capture', { target: 'coreOutline' }, sessionA)
    const beforeA = await prepare(sessionA, baseA.baseId)
    const sessionB = await open(projectB)
    assert.equal((await invoke(page, 'db:project-core-update', { coreOutline: 'Fictional B' }, projectB.projectPath, sessionB)).success, true)
    const baseB = await invoke(page, 'planning-feedback:v1:capture', { target: 'coreOutline' }, sessionB)
    const workB = await prepare(sessionB, baseB.baseId)
    assert.notEqual(beforeA.reference.projectId, workB.reference.projectId)
    await assert.rejects(invoke(page, 'runtime-feedback:v1:prepare', { ...beforeA.request, operationId: randomUUID() }, sessionA))
    await assert.rejects(invoke(page, 'runtime-feedback:v1:execute', { ...beforeA.reference, projectId: projectB.projectId }))
    const revokedA = await invoke(page, 'runtime-feedback:v1:revoke', beforeA.reference)
    assert.equal(revokedA.grant.state, 'revoked')
    assert.equal(revokedA.attempts.length, 0)
    assert.equal((await invoke(page, 'runtime-feedback:v1:execute', beforeA.reference)).grant.state, 'revoked')
    assert.equal(await requestCount(app), initial, 'pre-dispatch revoke sent a request')
    const completedB = await invoke(page, 'runtime-feedback:v1:execute', workB.reference)
    assert.equal(completedB.grant.state, 'completed')
    assert.ok(completedB.candidate?.candidateId, 'B candidate receipt missing')
    assert.deepEqual((await invoke(page, 'runtime-feedback:v1:revoke', workB.reference)).candidate, completedB.candidate)
    assert.equal(await requestCount(app), initial + 1)
    const reopenedA = await open(projectA)
    const freshBase = await invoke(page, 'planning-feedback:v1:capture', { target: 'coreOutline' }, reopenedA)
    const workA = await prepare(reopenedA, freshBase.baseId)
    const currentB = await open(projectB)
    fake.gate.hold()
    pending = invoke(page, 'runtime-feedback:v1:execute', workA.reference).then(
      receipt => ({ receipt }), error => ({ error }))
    await awaitGate(fake.gate, true)
    const absent = { projectId: projectA.projectId, grantId: randomUUID(), revision: 1 }
    const batch = await invoke(page, 'runtime-feedback:v1:revoke-many', { references: [workA.reference, absent, workB.reference] })
    assert.equal(batch.completeForRequestedScope, false)
    assert.equal(batch.projects.length, 2)
    const aBatch = batch.projects.find(project => project.projectId === projectA.projectId)
    const bBatch = batch.projects.find(project => project.projectId === projectB.projectId)
    assert.equal(aBatch?.completeForRequestedScope, false)
    assert.equal(bBatch?.completeForRequestedScope, true)
    const aItem = aBatch.grants.find(item => item.grantId === workA.reference.grantId)
    const missingItem = aBatch.grants.find(item => item.grantId === absent.grantId)
    const bItem = bBatch.grants.find(item => item.grantId === workB.reference.grantId)
    assert.equal(aBatch.grants.length, 2)
    assert.equal(bBatch.grants.length, 1)
    assert.equal(aItem?.requestedRevision, workA.reference.revision)
    assert.equal(aItem?.fenced, true)
    assert.equal(aItem.receipt.grant.state, 'revoked')
    assert.equal(aItem.errorCode, null)
    assert.equal(missingItem?.requestedRevision, absent.revision)
    assert.equal(missingItem?.fenced, false)
    assert.equal(missingItem.receipt, null)
    assert.ok(missingItem.errorCode)
    assert.equal(bItem?.requestedRevision, workB.reference.revision)
    assert.equal(bItem?.fenced, true)
    assert.equal(bItem.errorCode, null)
    assert.deepEqual(bItem.receipt.candidate, completedB.candidate)
    const settled = await bounded(pending)
    if (settled.error) throw settled.error
    assert.equal(settled.receipt.grant.state, 'revoked')
    assert.equal(settled.receipt.candidate, null)
    assert.equal(settled.receipt.attempts.length, 1)
    assert.equal(settled.receipt.attempts[0].status, 'unknown')
    assert.deepEqual(await invoke(page, 'runtime-feedback:v1:execute', workA.reference), settled.receipt)
    assert.equal(await requestCount(app), initial + 2, 'unknown attempt was redispatched')
    assert.equal((await invoke(page, 'db:project-core-get', projectB.projectPath, currentB)).coreOutline, 'Fictional B')
    assert.ok(fake.gate.waiting, 'in-flight fake request must remain gated until released')
    fake.gate.release()
    await awaitGate(fake.gate, false)
    const sessionAAfter = await open(projectA)
    await awaitHandoff(invoke, page, sessionAAfter)
    const legacyRuns = await invoke(page, 'generation:list', sessionAAfter)
    assert.ok(Array.isArray(legacyRuns))
    assert.equal(legacyRuns.some(run => run.handle?.runId === workA.receipt.grant.runId), false,
      'grant run leaked through legacy list')
    await assert.rejects(invoke(page, 'planning-feedback:v1:read-run', { handle: { projectId: projectA.projectId,
      epoch: sessionA.leaseId, rootActionId: 'invalid-legacy-root', runId: workA.receipt.grant.runId } }, sessionAAfter))
    assert.equal((await invoke(page, 'db:project-core-get', projectA.projectPath, sessionAAfter)).coreOutline, 'Fictional A')
    await close(projectA, sessionAAfter)
    const freshA = await open(projectA)
    const history = await invoke(page, 'runtime-feedback:v1:prepare', workA.request, freshA)
    assert.equal(history.reference, null, 'reopening reconstructed a capability')
    assert.equal(history.receipt.grant.state, 'revoked')
    assert.equal(history.receipt.attempts[0].status, 'unknown')
    assert.equal(await requestCount(app), initial + 2)
    outcome = { receipt: { scenario: 'runtime-feedback-v1', source: 'isolated-electron-registered-ipc',
      guardedFetchAttempts: 2, projects: 2, preDispatchRevoked: true, inFlightUnknown: true,
      candidatePreserved: true, reopenedHistoryOnly: true, gateDrained: true,
      fences: { aPreDispatch: 'revoked', aInFlight: 'revoked-unknown', b: 'completed', legacyList: 'filtered' },
      batchFences: { completeForRequestedScope: batch.completeForRequestedScope,
        projects: batch.projects.map(project => ({ projectId: project.projectId, completeForRequestedScope: project.completeForRequestedScope,
          grants: project.grants.map(({ grantId, requestedRevision, fenced, errorCode }) => ({ grantId, requestedRevision, fenced, errorCode })) })) },
      notCovered: ['exact-v1-handle-firewall', 'different-sender', 'unsaved-tail', 'native-platform-qualification'] } }
  } catch (error) { outcome = { error } }
  const failures = []
  try { fake?.gate?.release() } catch (error) { failures.push(error) }
  try {
    if (pending) {
      const result = await bounded(pending)
      if (result.error && result.error !== outcome.error) failures.push(result.error)
    }
  } catch (error) { failures.push(error) }
  try { if (fake?.gate) await awaitGate(fake.gate, false) } catch (error) { failures.push(error) }
  try { await closeOpened() } catch (error) { failures.push(error) }
  if (failures.length) {
    const cleanup = new AggregateError(failures, 'RUNTIME_FEEDBACK_SCENARIO_CLEANUP_FAILED')
    if ('error' in outcome) throw new AggregateError([outcome.error, cleanup], 'RUNTIME_FEEDBACK_SCENARIO_AND_CLEANUP_FAILED')
    throw cleanup
  }
  if ('error' in outcome) throw outcome.error
  return outcome.receipt
}

export const RUNTIME_FEEDBACK_SCENARIOS = {
  'runtime-feedback-v1': { model: true, shell: 'stage', timeout: 120_000, run: runRuntimeFeedbackScenario },
}

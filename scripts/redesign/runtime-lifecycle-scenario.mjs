import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'

async function waitGate(gate, waiting) {
  const deadline = Date.now() + 60_000
  while (Boolean(gate.waiting) !== waiting) {
    if (Date.now() >= deadline) throw new Error('RUNTIME_LIFECYCLE_GATE_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RUNTIME_LIFECYCLE_SETTLEMENT_TIMEOUT')), 60_000) })])
  } finally { clearTimeout(timer) }
}

// This wraps the driver's existing guarded fetch, never replaces the network policy.
async function installTransportHold(app) {
  await app.evaluate(() => {
    if (globalThis.__runtimeLifecycleTransport) throw new Error('RUNTIME_LIFECYCLE_HOLD_ALREADY_INSTALLED')
    const original = globalThis.fetch
    let release
    const gate = new Promise(resolve => { release = resolve })
    globalThis.__runtimeLifecycleTransport = { original, release }
    globalThis.fetch = (...args) => original(...args).then(
      async value => { await gate; return value },
      async error => { await gate; throw error })
  })
}
async function releaseTransportHold(app) {
  await app.evaluate(() => globalThis.__runtimeLifecycleTransport?.release())
}
async function restoreTransportHold(app) {
  await app.evaluate(() => {
    const hold = globalThis.__runtimeLifecycleTransport
    if (!hold) return
    hold.release()
    globalThis.fetch = hold.original
    delete globalThis.__runtimeLifecycleTransport
  })
}
async function guardedRequestCount(app) {
  return app.evaluate(() => {
    if (!Array.isArray(globalThis.__driveModelRequests)) throw new Error('RUNTIME_LIFECYCLE_REQUEST_LOG_MISSING')
    return globalThis.__driveModelRequests.filter(entry => entry.path === '/v1/chat/completions').length
  })
}
async function selectArchive(app, page, invoke, target) {
  await app.evaluate(({ dialog }, target) => {
    if (globalThis.__runtimeLifecycleDialog) throw new Error('RUNTIME_LIFECYCLE_DIALOG_ALREADY_INSTALLED')
    globalThis.__runtimeLifecycleDialog = dialog.showSaveDialog
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, target)
  try { return await invoke(page, 'dialog:select-project-archive-export', 'Fiction B') }
  finally {
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = globalThis.__runtimeLifecycleDialog
      delete globalThis.__runtimeLifecycleDialog
    })
  }
}

export async function runRuntimeLifecycleScenario(context, dependencies = {}) {
  const { app, page, roots, invoke, fake } = context
  const grantDirectory = dependencies.grantDirectory ?? chooseProjectDirectoryGrant
  const awaitGate = dependencies.awaitGate ?? waitGate
  const requestCount = dependencies.requestCount ?? guardedRequestCount
  const installHold = dependencies.installHold ?? installTransportHold
  const releaseHold = dependencies.releaseHold ?? releaseTransportHold
  const restoreHold = dependencies.restoreHold ?? restoreTransportHold
  const chooseArchive = dependencies.chooseArchive ?? selectArchive
  const opened = new Map()
  let execution, closing, outcome, holdInstalled = false
  async function create(name) {
    const grant = await grantDirectory(app, page, roots.projects)
    const result = await invoke(page, 'project:create', { parentGrantId: grant.grantId, name, genre: '', targetAudience: '', writingLanguage: 'en-US' }, randomUUID(), null)
    assert.equal(result?.success, true, `fictional project creation failed: ${result?.error ?? 'no error receipt'}`)
    return { projectId: result.projectId, projectPath: result.projectPath }
  }
  async function open(project) {
    const result = await invoke(page, 'project-runtime:v1:open-view', project.projectPath, randomUUID(), null)
    assert.equal(result?.success, true, 'fictional project open failed')
    opened.set(project.projectPath, project)
    return { projectId: project.projectId, projectPath: project.projectPath, leaseId: result.project.sessionLease }
  }
  async function close(project, session) {
    const result = await invoke(page, 'db:close', project.projectPath, session)
    assert.equal(result?.success, true, 'fictional runtime close failed')
    opened.delete(project.projectPath)
  }
  async function cleanupProjects() {
    const failures = []
    for (const project of [...opened.values()]) {
      try { await close(project, await open(project)) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'RUNTIME_LIFECYCLE_PROJECT_CLEANUP_FAILED')
  }
  try {
    assert.ok(fake?.gate, 'RUNTIME_LIFECYCLE_FAKE_REQUIRED')
    const initial = await requestCount(app)
    const a = await create('Lifecycle A'), b = await create('Lifecycle B')
    assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
    const aSession = await open(a)
    assert.equal((await invoke(page, 'db:project-core-update', { coreOutline: 'Fictional A' }, a.projectPath, aSession)).success, true)
    const base = await invoke(page, 'planning-feedback:v1:capture', { target: 'coreOutline' }, aSession)
    const request = { operationId: randomUUID(), input: { baseId: base.baseId, feedback: 'Revise fictional outline', constraints: [] }, modelId: FAKE_MODEL.id }
    const prepared = await invoke(page, 'runtime-feedback:v1:prepare', request, aSession)
    assert.ok(prepared.reference)
    const firstB = await open(b)
    assert.equal((await invoke(page, 'db:project-core-update', { coreOutline: 'Fictional B' }, b.projectPath, firstB)).success, true)
    await installHold(app); holdInstalled = true
    fake.gate.hold()
    execution = invoke(page, 'runtime-feedback:v1:execute', prepared.reference).then(receipt => ({ receipt }), error => ({ error }))
    await awaitGate(fake.gate, true)
    const closingSession = await open(a)
    let closeSettled = false
    closing = invoke(page, 'db:close', a.projectPath, closingSession).then(result => { closeSettled = true; return { result } }, error => { closeSettled = true; return { error } })
    await assert.rejects(invoke(page, 'runtime-feedback:v1:prepare', { ...request, operationId: randomUUID() }, closingSession))
    const rejectedWrite = await invoke(page, 'db:project-core-update', { coreOutline: 'must not commit' }, a.projectPath, closingSession)
    assert.equal(rejectedWrite.success, false, 'sealed A accepted a write')
    const bSession = await open(b)
    assert.equal((await invoke(page, 'db:project-core-get', b.projectPath, bSession)).coreOutline, 'Fictional B')
    assert.equal(closeSettled, false, 'A closed before its physical provider settled')
    const settled = await bounded(execution)
    if (settled.error) throw settled.error
    assert.equal(settled.receipt.grant.state, 'revoked')
    assert.equal(settled.receipt.attempts.length, 1)
    assert.equal(settled.receipt.attempts[0].status, 'unknown')
    assert.equal(settled.receipt.candidate, null)
    assert.deepEqual(await invoke(page, 'runtime-feedback:v1:execute', prepared.reference), settled.receipt)
    assert.equal(await requestCount(app), initial + 1)
    fake.gate.release()
    await releaseHold(app)
    const closed = await bounded(closing)
    if (closed.error) throw closed.error
    assert.equal(closed.result?.success, true, 'fictional runtime close failed')
    opened.delete(a.projectPath)
    await awaitGate(fake.gate, false)
    assert.equal((await invoke(page, 'db:project-core-get', b.projectPath, bSession)).coreOutline, 'Fictional B')
    const reopenedA = await open(a)
    const history = await invoke(page, 'runtime-feedback:v1:read-history', { grantId: prepared.reference.grantId }, reopenedA)
    assert.equal(history.grant.state, 'revoked')
    assert.equal(history.attempts[0].status, 'unknown')
    assert.equal((await invoke(page, 'runtime-feedback:v1:prepare', request, reopenedA)).reference, null)
    assert.equal(await requestCount(app), initial + 1)
    const backupB = await open(b)
    const archiveGrant = await chooseArchive(app, page, invoke, path.join(roots.projects, 'lifecycle-fixture.ainovel'))
    assert.ok(archiveGrant?.grantId)
    const exported = await invoke(page, 'project:archive-export', { projectSession: backupB, targetArchiveGrantId: archiveGrant.grantId })
    assert.equal(exported.success, true, 'fictional archive export failed')
    assert.equal((await invoke(page, 'db:project-core-get', b.projectPath, backupB)).coreOutline, 'Fictional B')
    const deleted = await invoke(page, 'project:delete', b.projectPath, b.projectId, backupB.leaseId, backupB)
    assert.equal(deleted.success, true, 'fictional project deletion failed')
    assert.equal(deleted.directoryDeleted, true)
    opened.delete(b.projectPath)
    const retainedA = await open(a)
    assert.equal((await invoke(page, 'db:project-core-get', a.projectPath, retainedA)).coreOutline, 'Fictional A')
    outcome = { receipt: { scenario: 'runtime-lifecycle-v1', source: 'isolated-electron-registered-ipc',
      guardedFetchAttempts: 1, closeWaitedForTransport: true, sealedWriteRejected: true, unknownNotReplayed: true,
      otherViewPreserved: true, archiveExported: true, deletedBRetainedA: true, transportHold: 'main-process-diagnostic-wrapper',
      notCovered: ['backup-inflight-writer-interleaving', 'window-native-close', 'native-platform-qualification'] } }
  } catch (error) { outcome = { error } }
  const failures = []
  try { fake?.gate?.release() } catch (error) { failures.push(error) }
  try { if (holdInstalled) await releaseHold(app) } catch (error) { failures.push(error) }
  try {
    if (execution) { const result = await bounded(execution); if (result.error && result.error !== outcome.error) failures.push(result.error) }
  } catch (error) { failures.push(error) }
  try {
    if (closing) { const result = await bounded(closing); if (result.error && result.error !== outcome.error) failures.push(result.error) }
  } catch (error) { failures.push(error) }
  try { if (fake?.gate) await awaitGate(fake.gate, false) } catch (error) { failures.push(error) }
  try { if (holdInstalled) await restoreHold(app) } catch (error) { failures.push(error) }
  try { await cleanupProjects() } catch (error) { failures.push(error) }
  if (failures.length) {
    const cleanup = new AggregateError(failures, 'RUNTIME_LIFECYCLE_CLEANUP_FAILED')
    if ('error' in outcome) throw new AggregateError([outcome.error, cleanup], 'RUNTIME_LIFECYCLE_SCENARIO_AND_CLEANUP_FAILED')
    throw cleanup
  }
  if ('error' in outcome) throw outcome.error
  return outcome.receipt
}

export const RUNTIME_LIFECYCLE_SCENARIOS = {
  'runtime-lifecycle-v1': { model: true, shell: 'stage', timeout: 120_000, run: runRuntimeLifecycleScenario },
}

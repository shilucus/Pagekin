import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'

const A_TEXT = 'Fictional A baseline'
const B_TEXT = 'Fictional B edited'
const LEGACY_REJECTION = /PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE/u

async function waitForGate(gate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!gate.waiting) {
    if (Date.now() >= deadline) throw new Error('RUNTIME_SCENARIO_GATE_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function bounded(promise, timeoutMs = 60_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('RUNTIME_SCENARIO_SETTLEMENT_TIMEOUT')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

async function guardedRequestCount(app) {
  return app.evaluate(() => {
    if (!Array.isArray(globalThis.__driveModelRequests)) throw new Error('RUNTIME_SCENARIO_REQUEST_LOG_MISSING')
    return globalThis.__driveModelRequests.filter(entry => entry.path === '/v1/chat/completions').length
  })
}

export async function runRuntimeRoutingScenario(context, dependencies = {}) {
  const { app, page, roots, invoke, fake } = context
  const grantDirectory = dependencies.grantDirectory ?? chooseProjectDirectoryGrant
  const awaitGate = dependencies.awaitGate ?? waitForGate
  const requestCount = dependencies.requestCount ?? guardedRequestCount
  const opened = new Map()
  let pending
  async function open(project) {
    const result = await invoke(page, 'project-runtime:v1:open-view', project.projectPath, randomUUID(), null)
    assert.equal(result?.success, true, 'fictional project open failed')
    const session = { projectId: project.projectId, projectPath: project.projectPath, leaseId: result.project.sessionLease }
    opened.set(project.projectPath, project)
    return session
  }
  async function create(name) {
    const grant = await grantDirectory(app, page, roots.projects)
    const result = await invoke(page, 'project:create', { parentGrantId: grant.grantId,
      name, genre: '', targetAudience: '', writingLanguage: 'en-US' }, randomUUID(), null)
    assert.equal(result?.success, true, `fictional project creation failed: ${result?.error ?? 'no error receipt'}`)
    return { projectId: result.projectId, projectPath: result.projectPath }
  }
  async function closeOpened() {
    const failures = []
    for (const project of opened.values()) {
      try {
        const session = await open(project)
        const closed = await invoke(page, 'db:close', project.projectPath, session)
        assert.equal(closed?.success, true, 'fictional runtime close failed')
      } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'RUNTIME_SCENARIO_CLEANUP_FAILED')
  }
  let outcome
  try {
    const projectA = await create('A')
    const projectB = await create('B')
    assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
    const sessionA = await open(projectA)
    assert.equal((await invoke(page, 'db:project-core-update', { coreOutline: A_TEXT }, projectA.projectPath, sessionA)).success, true)
    const base = await invoke(page, 'planning-feedback:v1:capture', { target: 'coreOutline' }, sessionA)
    const run = await invoke(page, 'planning-feedback:v1:begin', { input: { baseId: base.baseId,
      feedback: 'Revise the fictional outline', constraints: [] }, modelId: FAKE_MODEL.id, uiActionNonce: randomUUID() }, sessionA)
    fake.gate.hold()
    pending = invoke(page, 'planning-feedback:v1:execute', { handle: run.handle }, sessionA)
      .then(() => ({ returned: true }), error => ({ returned: false, error: String(error?.message ?? error) }))
    await awaitGate(fake.gate)
    const sessionB = await open(projectB)
    assert.equal((await invoke(page, 'db:project-core-update', { coreOutline: B_TEXT }, projectB.projectPath, sessionB)).success, true)
    await assert.rejects(invoke(page, 'planning-feedback:v1:read-run', { handle: run.handle }, sessionA), /GENERATION_PROJECT_SESSION_STALE/u)
    await assert.rejects(invoke(page, 'db:blueprint-get-all', projectB.projectPath, sessionB), LEGACY_REJECTION)
    await assert.rejects(invoke(page, 'kb:list-documents', projectB.projectPath, sessionB), LEGACY_REJECTION)
    const finalization = await invoke(page, 'finalization:commit', { tabId: 'fictional-tab', projectPath: projectB.projectPath,
      projectSession: sessionB, draftId: 1, chapterNumber: 1, chapterTitle: 'Fiction', content: 'Fiction', contentRevision: 1 }, sessionB)
    assert.equal(finalization?.success, false)
    assert.match(finalization.error, LEGACY_REJECTION)
    const archive = await invoke(page, 'project:archive-export', { projectSession: sessionB, targetArchiveGrantId: 'unused-fictional-grant' })
    assert.equal(archive?.success, false)
    assert.match(archive.error, LEGACY_REJECTION)
    fake.gate.release()
    const settled = await bounded(pending)
    assert.equal(settled.returned, false, 'stale A execution returned to the old view')
    assert.match(settled.error, /GENERATION_PROJECT_SESSION_STALE/u)
    const requestsAfterSettlement = await requestCount(app)
    assert.equal(requestsAfterSettlement, 1, 'expected one guarded physical fetch attempt')
    const bCore = await invoke(page, 'db:project-core-get', projectB.projectPath, sessionB)
    assert.equal(bCore.coreOutline, B_TEXT)
    const resumedA = await open(projectA)
    const history = await invoke(page, 'planning-feedback:v1:read-run', { handle: run.handle }, resumedA)
    assert.equal(history.view.handle.runId, run.handle.runId)
    assert.equal(history.view.ledger.physicalRequests, 1)
    assert.ok(history.view.artifacts.length > 0, 'A receipt has no persisted artifact')
    assert.equal((await invoke(page, 'db:project-core-get', projectA.projectPath, resumedA)).coreOutline, A_TEXT)
    await invoke(page, 'planning-feedback:v1:execute', { handle: run.handle }, resumedA)
    assert.equal(await requestCount(app), requestsAfterSettlement, 'receipt replay dispatched another request')
    const resumedB = await open(projectB)
    assert.equal((await invoke(page, 'db:project-core-get', projectB.projectPath, resumedB)).coreOutline, B_TEXT)
    outcome = { receipt: { scenario: 'runtime-routing-v1', source: 'isolated-electron-registered-ipc',
      guardedFetchAttempts: requestsAfterSettlement, legacyRejected: ['database', 'knowledge', 'finalization', 'archive'],
      scope: 'view-lease-fail-closed-not-background-grant' } }
  } catch (error) {
    outcome = { error }
  }
  fake.gate.release()
  try {
    if (pending) await bounded(pending)
    await closeOpened()
  } catch (error) {
    if ('error' in outcome) throw new AggregateError([outcome.error, error], 'RUNTIME_SCENARIO_AND_CLEANUP_FAILED')
    throw error
  }
  if ('error' in outcome) throw outcome.error
  return outcome.receipt
}

export const RUNTIME_ROUTING_SCENARIOS = {
  'runtime-routing-v1': { model: true, shell: 'stage', timeout: 120_000, run: runRuntimeRoutingScenario },
}

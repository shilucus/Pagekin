import { describe, expect, it, vi } from 'vitest'
import { RUNTIME_ROUTING_SCENARIOS, runRuntimeRoutingScenario } from '../runtime-routing-scenario.mjs'

function fixture({ allowLegacy = false, returnStale = false, failClose = false, createError } = {}) {
  const projects = [], cores = new Map(), calls = []
  let active, lease = 0, pendingReject, pendingResolve, requestCount = 0, dispatched = false
  const fake = { gate: { waiting: 0, hold() {}, release() {
    if (!pendingResolve) return
    requestCount++
    this.waiting = 0
    if (returnStale) pendingResolve({ outcome: { status: 'completed' } })
    else pendingReject(new Error('GENERATION_PROJECT_SESSION_STALE'))
    pendingResolve = undefined
  } } }
  const invoke = vi.fn(async (_page, channel, ...args) => {
    calls.push(channel)
    if (channel === 'project:create') {
      if (createError) return { success: false, error: createError }
      const id = `fiction-${projects.length + 1}`, projectPath = `/fixture/${id}`
      projects.push({ projectId: id, projectPath }); cores.set(projectPath, '')
      return { success: true, projectId: id, projectPath }
    }
    if (channel === 'project-runtime:v1:open-view') {
      const project = projects.find(item => item.projectPath === args[0])
      active = { ...project, leaseId: `lease-${++lease}` }
      return { success: true, project: { sessionLease: active.leaseId } }
    }
    if (channel === 'llm:save-model') return { success: true }
    if (channel === 'db:project-core-update') { cores.set(args[1], args[0].coreOutline); return { success: true } }
    if (channel === 'db:project-core-get') return { coreOutline: cores.get(args[0]) }
    if (channel === 'db:close') {
      if (failClose) throw new Error('FICTIONAL_RUNTIME_CLOSE_FAILED')
      return { success: true }
    }
    if (channel === 'planning-feedback:v1:capture') return { baseId: 'fictional-base' }
    if (channel === 'planning-feedback:v1:begin') return { handle: { runId: 'fictional-run' } }
    if (channel === 'planning-feedback:v1:read-run') {
      if (args[1].leaseId !== active.leaseId) throw new Error('GENERATION_PROJECT_SESSION_STALE')
      return { view: { handle: { runId: 'fictional-run' }, ledger: { physicalRequests: 1 }, artifacts: [{}] } }
    }
    if (channel === 'planning-feedback:v1:execute') {
      if (dispatched) return { outcome: { status: 'completed' } }
      dispatched = true; fake.gate.waiting = 1
      return new Promise((resolve, reject) => { pendingResolve = resolve; pendingReject = reject })
    }
    if (channel === 'db:blueprint-get-all' || channel === 'kb:list-documents') {
      if (allowLegacy) return []
      throw new Error('PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE')
    }
    if (channel === 'finalization:commit' || channel === 'project:archive-export') {
      return { success: false, error: 'PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE' }
    }
    throw new Error(`UNEXPECTED_TEST_CHANNEL:${channel}`)
  })
  const context = { app: {}, page: {}, roots: { projects: '/fixture' }, invoke, fake }
  const dependencies = { grantDirectory: async () => ({ grantId: 'fictional-grant' }),
    awaitGate: async gate => { expect(gate.waiting).toBe(1) }, requestCount: async () => requestCount }
  return { context, dependencies, calls, invoke, fake }
}

describe('runtime routing scenario contract', () => {
  it('registers an isolated fake-model scenario and closes both opened runtimes', async () => {
    expect(RUNTIME_ROUTING_SCENARIOS['runtime-routing-v1']).toMatchObject({ model: true, shell: 'stage' })
    const f = fixture()
    const receipt = await runRuntimeRoutingScenario(f.context, f.dependencies)
    expect(receipt).toEqual({ scenario: 'runtime-routing-v1', source: 'isolated-electron-registered-ipc',
      guardedFetchAttempts: 1, legacyRejected: ['database', 'knowledge', 'finalization', 'archive'],
      scope: 'view-lease-fail-closed-not-background-grant' })
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(2)
    expect(f.calls.filter(channel => channel === 'planning-feedback:v1:execute')).toHaveLength(2)
    expect(f.calls).not.toContain('project:open')
    expect(f.invoke.mock.calls.filter(([, channel]) => channel === 'project:create')
      .map(([, , config]) => config.name)).toEqual(['A', 'B'])
  })

  it('retains the fictional creation failure receipt without attempting an unowned close', async () => {
    const f = fixture({ createError: 'PROJECT_STORAGE_PATH_UNSUPPORTED' })
    await expect(runRuntimeRoutingScenario(f.context, f.dependencies))
      .rejects.toThrow('fictional project creation failed: PROJECT_STORAGE_PATH_UNSUPPORTED')
    expect(f.calls).not.toContain('db:close')
  })

  it('fails when a legacy entry is admitted, releases the gate and closes both runtimes', async () => {
    const f = fixture({ allowLegacy: true })
    await expect(runRuntimeRoutingScenario(f.context, f.dependencies)).rejects.toThrow()
    expect(f.fake.gate.waiting).toBe(0)
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(2)
  })

  it('fails when the stale execution returns to the old view', async () => {
    const f = fixture({ returnStale: true })
    await expect(runRuntimeRoutingScenario(f.context, f.dependencies)).rejects.toThrow('stale A execution returned')
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(2)
  })
  it('preserves a cleanup failure after otherwise successful execution', async () => {
    const f = fixture({ failClose: true })
    await expect(runRuntimeRoutingScenario(f.context, f.dependencies)).rejects.toMatchObject({
      message: 'RUNTIME_SCENARIO_CLEANUP_FAILED', errors: [expect.any(Error), expect.any(Error)],
    })
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(2)
  })
  it('preserves both the original failure and cleanup errors', async () => {
    const f = fixture({ allowLegacy: true, failClose: true })
    await expect(runRuntimeRoutingScenario(f.context, f.dependencies)).rejects.toMatchObject({
      message: 'RUNTIME_SCENARIO_AND_CLEANUP_FAILED',
      errors: [expect.any(Error), expect.objectContaining({ message: 'RUNTIME_SCENARIO_CLEANUP_FAILED' })],
    })
    expect(f.fake.gate.waiting).toBe(0)
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(2)
  })
})

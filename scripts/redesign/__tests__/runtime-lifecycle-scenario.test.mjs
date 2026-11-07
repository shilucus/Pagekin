import { describe, expect, it } from 'vitest'
import { RUNTIME_LIFECYCLE_SCENARIOS, runRuntimeLifecycleScenario } from '../runtime-lifecycle-scenario.mjs'

function fixture(options = {}) {
  const projects = [], calls = [], cores = new Map()
  let active, lease = 0, requests = 0, reference, savedRequest, result, executionResolve, closeResolve, hold = false, sealed = false
  let archiveSelected = false, restored = false, closeCount = 0
  const fake = { gate: { waiting: 0, hold() {}, release() { this.waiting = 0 } } }
  const clone = value => structuredClone(value)
  const invoke = async (_page, channel, ...args) => {
    calls.push(channel)
    if (channel === 'project:create') {
      if (options.createError) return { success: false, error: options.createError }
      const project = { projectId: `project-${projects.length}`, projectPath: `/fixture/${projects.length}` }
      projects.push(project); cores.set(project.projectPath, '')
      return { success: true, ...project }
    }
    if (channel === 'project-runtime:v1:open-view') {
      const project = projects.find(item => item.projectPath === args[0])
      active = { ...project, leaseId: `lease-${++lease}` }
      return { success: true, project: { sessionLease: active.leaseId } }
    }
    if (channel === 'llm:save-model') return { success: true }
    if (channel === 'db:project-core-update') {
      if (sealed && args[1] === projects[0].projectPath && !options.allowWrite) return { success: false, error: 'CLOSING' }
      cores.set(args[1], args[0].coreOutline); return { success: true }
    }
    if (channel === 'db:project-core-get') return { coreOutline: cores.get(args[0]) }
    if (channel === 'planning-feedback:v1:capture') return { baseId: 'fixture-base' }
    if (channel === 'runtime-feedback:v1:prepare') {
      const [request] = args
      if (sealed && savedRequest && request.operationId !== savedRequest.operationId) throw new Error('CLOSING')
      if (savedRequest && request.operationId === savedRequest.operationId)
        return { reference: options.resign ? reference : null, receipt: clone(result) }
      savedRequest = request
      reference = { projectId: active.projectId, grantId: 'grant-a', revision: 1 }
      result = { grant: { state: 'active', grantId: reference.grantId }, attempts: [], candidate: null }
      return { reference, receipt: clone(result) }
    }
    if (channel === 'runtime-feedback:v1:execute') {
      if (result.grant.state === 'revoked') { if (options.redispatch) requests++; return clone(result) }
      requests++; fake.gate.waiting = 1
      return new Promise(resolve => { executionResolve = resolve })
    }
    if (channel === 'db:close') {
      if (options.failClose && (sealed || !executionResolve)) throw new Error('FICTIONAL_CLOSE_FAILED')
      if (args[0] === projects[0].projectPath && executionResolve && !sealed) {
        sealed = true
        result = { grant: { state: 'revoked', grantId: reference.grantId }, attempts: [{ status: 'unknown' }], candidate: null }
        executionResolve(clone(result))
        if (options.closeEarly) { closeCount++; return { success: true } }
        return new Promise(resolve => { closeResolve = () => { closeCount++; resolve({ success: true }) } })
      }
      return { success: true }
    }
    if (channel === 'runtime-feedback:v1:read-history') return clone(result)
    if (channel === 'project:archive-export') return options.failBackup ? { success: false } : { success: true, receipt: {} }
    if (channel === 'project:delete') return options.failDelete ? { success: false } : { success: true, directoryDeleted: true }
    throw new Error(`UNEXPECTED_TEST_CHANNEL:${channel}`)
  }
  const context = { app: {}, page: {}, roots: { projects: '/fixture' }, invoke, fake }
  const dependencies = {
    grantDirectory: async () => ({ grantId: 'directory-grant' }),
    awaitGate: async (gate, waiting) => expect(Boolean(gate.waiting)).toBe(waiting),
    requestCount: async () => requests,
    installHold: async () => { hold = true },
    releaseHold: async () => { if (hold) { hold = false; closeResolve?.() } },
    restoreHold: async () => { restored = true },
    chooseArchive: async () => { archiveSelected = true; return { grantId: 'archive-grant' } },
  }
  return { context, dependencies, calls, fake, get restored() { return restored }, get archiveSelected() { return archiveSelected }, get closeCount() { return closeCount } }
}

describe('runtime lifecycle scenario', () => {
  it('exercises close drain, isolated archive and deletion through registered channels', async () => {
    expect(RUNTIME_LIFECYCLE_SCENARIOS['runtime-lifecycle-v1']).toMatchObject({ model: true, shell: 'stage' })
    const f = fixture(), receipt = await runRuntimeLifecycleScenario(f.context, f.dependencies)
    expect(receipt).toMatchObject({ guardedFetchAttempts: 1, closeWaitedForTransport: true, sealedWriteRejected: true,
      unknownNotReplayed: true, otherViewPreserved: true, archiveExported: true, deletedBRetainedA: true,
      transportHold: 'main-process-diagnostic-wrapper' })
    expect(receipt.notCovered).toContain('backup-inflight-writer-interleaving')
    expect(f.archiveSelected).toBe(true)
    expect(f.restored).toBe(true)
    expect(f.closeCount).toBe(1)
    expect(f.calls).toContain('project:archive-export')
    expect(f.calls).toContain('project:delete')
  })
  it('retains creation failures without closing unowned projects', async () => {
    const f = fixture({ createError: 'FICTIONAL_CREATE_FAILED' })
    await expect(runRuntimeLifecycleScenario(f.context, f.dependencies)).rejects.toThrow('FICTIONAL_CREATE_FAILED')
    expect(f.calls).not.toContain('db:close')
  })
  it('rejects an early physical close', async () => {
    const f = fixture({ closeEarly: true })
    await expect(runRuntimeLifecycleScenario(f.context, f.dependencies)).rejects.toThrow('A closed before its physical provider settled')
    expect(f.restored).toBe(true)
  })
  it('rejects a write after the close seal', async () => {
    const f = fixture({ allowWrite: true })
    await expect(runRuntimeLifecycleScenario(f.context, f.dependencies)).rejects.toThrow('sealed A accepted a write')
    expect(f.restored).toBe(true)
    expect(f.fake.gate.waiting).toBe(0)
  })
  it('detects a redispatched unknown attempt', async () => {
    const f = fixture({ redispatch: true })
    await expect(runRuntimeLifecycleScenario(f.context, f.dependencies)).rejects.toThrow()
    expect(f.restored).toBe(true)
  })
  it('rejects capability reconstruction after reopening', async () => {
    const f = fixture({ resign: true })
    await expect(runRuntimeLifecycleScenario(f.context, f.dependencies)).rejects.toThrow()
  })
  it('reports an archive export failure without deleting B', async () => {
    const f = fixture({ failBackup: true })
    await expect(runRuntimeLifecycleScenario(f.context, f.dependencies)).rejects.toThrow('fictional archive export failed')
    expect(f.calls).not.toContain('project:delete')
  })
  it('reports failed deletion and retains cleanup evidence', async () => {
    const f = fixture({ failDelete: true })
    await expect(runRuntimeLifecycleScenario(f.context, f.dependencies)).rejects.toThrow('fictional project deletion failed')
    expect(f.restored).toBe(true)
  })
  it('preserves the original failure together with cleanup failures', async () => {
    const f = fixture({ allowWrite: true, failClose: true })
    await expect(runRuntimeLifecycleScenario(f.context, f.dependencies)).rejects.toMatchObject({
      message: 'RUNTIME_LIFECYCLE_SCENARIO_AND_CLEANUP_FAILED',
      errors: [expect.any(Error), expect.objectContaining({ message: 'RUNTIME_LIFECYCLE_CLEANUP_FAILED' })],
    })
  })
})

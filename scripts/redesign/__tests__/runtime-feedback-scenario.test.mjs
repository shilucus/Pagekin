import { describe, expect, it } from 'vitest'
import { RUNTIME_FEEDBACK_SCENARIOS, runRuntimeFeedbackScenario } from '../runtime-feedback-scenario.mjs'

function fixture(options = {}) {
  const projects = [], calls = [], cores = new Map(), grants = new Map()
  let active, lease = 0, requests = 0, pendingResolve
  const fake = { gate: { waiting: 0, held: false,
    hold() { this.held = true },
    release() { this.held = false; this.waiting = 0 },
  } }
  const receipt = grant => structuredClone({ grant: { projectId: grant.projectId, grantId: grant.grantId,
    revision: 1, runId: grant.runId, state: grant.state }, candidate: grant.candidate, attempts: grant.attempts,
    nonReplayable: true })
  const reference = grant => ({ projectId: grant.projectId, grantId: grant.grantId, revision: 1 })
  const invoke = async (_page, channel, ...args) => {
    calls.push(channel)
    if (channel === 'project:create') {
      if (options.createError) return { success: false, error: options.createError }
      const project = { projectId: `project-${projects.length}`, projectPath: `/fixture/${projects.length}`, generation: 0 }
      projects.push(project); cores.set(project.projectPath, '')
      return { success: true, ...project }
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
      if (options.failClose) throw new Error('FICTIONAL_CLOSE_FAILED')
      projects.find(item => item.projectPath === args[0]).generation++
      return { success: true }
    }
    if (channel === 'planning-feedback:v1:capture') return { baseId: `base-${active.projectId}` }
    if (channel === 'planning-feedback:v1:read-run') throw new Error('GENERATION_RUN_ACCESS_DENIED')
    if (channel === 'generation:list') return options.leakLegacy ? [{ handle: { runId: 'run-2' } }] : []
    if (channel === 'runtime-feedback:v1:prepare') {
      const [request, session] = args
      if (!options.allowStale && session.leaseId !== active.leaseId) throw new Error('STALE_VIEW')
      const project = projects.find(item => item.projectId === session.projectId)
      let grant = [...grants.values()].find(item => item.projectId === project.projectId && item.operationId === request.operationId)
      if (grant) return { reference: options.resign ? reference(grant) : null, receipt: receipt(grant) }
      grant = { projectId: project.projectId, grantId: `grant-${grants.size}`, runId: `run-${grants.size}`,
        operationId: request.operationId, state: 'active', candidate: null, attempts: [] }
      grants.set(grant.grantId, grant)
      return { reference: reference(grant), receipt: receipt(grant) }
    }
    if (channel === 'runtime-feedback:v1:revoke-many') {
      const groups = new Map()
      for (const ref of args[0].references) {
        let group = groups.get(ref.projectId)
        if (!group) { group = { projectId: ref.projectId, completeForRequestedScope: true, grants: [] }; groups.set(ref.projectId, group) }
        const grant = grants.get(ref.grantId)
        if (!grant || grant.projectId !== ref.projectId) {
          group.completeForRequestedScope = false
          group.grants.push({ grantId: ref.grantId, requestedRevision: ref.revision, fenced: false, receipt: null, errorCode: 'CAPABILITY_DENIED' })
        } else {
          const result = await invoke(_page, 'runtime-feedback:v1:revoke', ref)
          group.grants.push({ grantId: ref.grantId, requestedRevision: ref.revision, fenced: true, receipt: result, errorCode: null })
        }
      }
      const projects = [...groups.values()]
      return { completeForRequestedScope: projects.every(group => group.completeForRequestedScope), projects }
    }
    if (channel === 'runtime-feedback:v1:execute' || channel === 'runtime-feedback:v1:revoke') {
      const grant = grants.get(args[0].grantId)
      if (!grant || (!options.allowWrongProject && grant.projectId !== args[0].projectId)) throw new Error('CAPABILITY_DENIED')
      if (channel.endsWith(':revoke')) {
        if (grant.state === 'active') {
          grant.state = 'revoked'
          if (grant.attempts.length) {
            grant.attempts[0].status = 'unknown'
            if (options.candidateAfterRevoke) grant.candidate = { candidateId: 'improper' }
            pendingResolve?.(receipt(grant))
          }
        }
        return receipt(grant)
      }
      if (grant.state !== 'active') {
        if (options.redispatch && grant.attempts.length) requests++
        return receipt(grant)
      }
      requests++
      grant.attempts.push({ attemptId: `attempt-${requests}`, status: 'dispatched' })
      if (fake.gate.held) {
        fake.gate.waiting = 1
        return new Promise(resolve => { pendingResolve = resolve })
      }
      grant.state = 'completed'; grant.attempts[0].status = 'completed'
      grant.candidate = { candidateId: 'candidate-b' }
      return receipt(grant)
    }
    throw new Error(`UNEXPECTED_TEST_CHANNEL:${channel}`)
  }
  const context = { app: {}, page: {}, roots: { projects: '/fixture' }, invoke, fake }
  const dependencies = { grantDirectory: async () => ({ grantId: 'directory-grant' }),
    requestCount: async () => requests, awaitGate: async (gate, waiting) => expect(Boolean(gate.waiting)).toBe(waiting),
    awaitHandoff: async () => ({ baseId: 'after-drain' }) }
  return { context, dependencies, calls, fake }
}

describe('runtime feedback scenario', () => {
  it('registers an isolated scenario and preserves both projects through revoke and reopen', async () => {
    expect(RUNTIME_FEEDBACK_SCENARIOS['runtime-feedback-v1']).toMatchObject({ model: true, shell: 'stage' })
    const f = fixture()
    const result = await runRuntimeFeedbackScenario(f.context, f.dependencies)
    expect(result).toMatchObject({ guardedFetchAttempts: 2, projects: 2, preDispatchRevoked: true,
      inFlightUnknown: true, candidatePreserved: true, reopenedHistoryOnly: true, gateDrained: true })
    expect(result.notCovered).toContain('exact-v1-handle-firewall')
    expect(result.batchFences.completeForRequestedScope).toBe(false)
    expect(result.batchFences.projects.map(project => project.completeForRequestedScope)).toEqual([false, true])
    expect(result.batchFences.projects.flatMap(project => project.grants).map(item => item.fenced)).toEqual([true, false, true])
    expect(f.fake.gate.waiting).toBe(0)
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(3)
  })
  it('retains creation errors without closing unowned projects', async () => {
    const f = fixture({ createError: 'PROJECT_STORAGE_PATH_UNSUPPORTED' })
    await expect(runRuntimeFeedbackScenario(f.context, f.dependencies)).rejects.toThrow('PROJECT_STORAGE_PATH_UNSUPPORTED')
    expect(f.calls).not.toContain('db:close')
  })
  it('rejects stale-view admission regressions', async () => {
    const f = fixture({ allowStale: true })
    await expect(runRuntimeFeedbackScenario(f.context, f.dependencies)).rejects.toThrow()
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(2)
  })
  it('rejects cross-project capability admission', async () => {
    const f = fixture({ allowWrongProject: true })
    await expect(runRuntimeFeedbackScenario(f.context, f.dependencies)).rejects.toThrow()
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(2)
  })
  it('detects redispatch of an unknown attempt', async () => {
    const f = fixture({ redispatch: true })
    await expect(runRuntimeFeedbackScenario(f.context, f.dependencies)).rejects.toThrow('unknown attempt was redispatched')
    expect(f.fake.gate.waiting).toBe(0)
  })
  it('rejects a candidate created after in-flight revocation', async () => {
    const f = fixture({ candidateAfterRevoke: true })
    await expect(runRuntimeFeedbackScenario(f.context, f.dependencies)).rejects.toThrow()
    expect(f.fake.gate.waiting).toBe(0)
  })
  it('rejects re-signing a historical grant after close', async () => {
    const f = fixture({ resign: true })
    await expect(runRuntimeFeedbackScenario(f.context, f.dependencies)).rejects.toThrow('reopening reconstructed a capability')
  })
  it('rejects grant runs leaked by the legacy list', async () => {
    const f = fixture({ leakLegacy: true })
    await expect(runRuntimeFeedbackScenario(f.context, f.dependencies)).rejects.toThrow('grant run leaked through legacy list')
  })
  it('retains both scenario and cleanup failures', async () => {
    const f = fixture({ allowStale: true, failClose: true })
    await expect(runRuntimeFeedbackScenario(f.context, f.dependencies)).rejects.toMatchObject({
      message: 'RUNTIME_FEEDBACK_SCENARIO_AND_CLEANUP_FAILED',
      errors: [expect.any(Error), expect.objectContaining({ message: 'RUNTIME_FEEDBACK_SCENARIO_CLEANUP_FAILED' })],
    })
    expect(f.calls.filter(channel => channel === 'db:close')).toHaveLength(2)
  })
})

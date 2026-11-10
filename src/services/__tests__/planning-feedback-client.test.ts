import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import type { BeginPlanningFeedbackRequest, PlanningFeedbackChannel, PlanningFeedbackFieldBase,
  PlanningFeedbackRangeBase, PlanningFeedbackRangeBaseSummary, PlanningFeedbackRangeScope } from '../../shared/planning-feedback-ipc'
import type { AdoptPlanningFeedbackCandidate, PlanningFeedbackCandidate, PlanningFeedbackCoreTarget } from '../../shared/planning-feedback'
import type { MainGenerationExecuteReceipt, MainGenerationRunView } from '../generation/generation-runtime'
import type { GenerationAttemptReceipt } from '../generation/generation-harness'
import { createPlanningFeedbackClient, createPlanningFeedbackRangeClient,
  type PlanningFeedbackClient, type PlanningFeedbackRangeClient } from '../planning-feedback-client'

const session: ProjectSessionContext = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/synthetic/A' }
const handle = { projectId: 'project-A', epoch: 'lease-A', rootActionId: 'root-A', runId: 'run-A' }
const view: MainGenerationRunView = { handle, operation: 'planning-feedback', status: 'running', nonReplayable: false,
  budget: { maxAttempts: 2, maxRequestedOutputTokens: 100, maxRequestedOutputTokensPerAttempt: 50, deadlineAt: 1000 }, artifacts: [] }
const intent: BeginPlanningFeedbackRequest = { input: { baseId: 'base-A', parentCandidateId: 'candidate-parent',
  feedback: 'Remove the repeated sentence', constraints: ['Keep the lighthouse'] }, modelId: 'synthetic-model', uiActionNonce: 'author-action-A' }
const execution: MainGenerationExecuteReceipt = { run: view, outcome: { status: 'completed', content: 'Revised candidate', finishReason: 'stop',
  receipt: { finishReason: 'stop', visibleArtifact: { artifactId: 'artifact-main', attemptId: 'attempt-main', revision: 7, textHash: 'a'.repeat(64) } } as GenerationAttemptReceipt } }
const candidate: PlanningFeedbackCandidate = { schemaVersion: 1, candidateId: 'candidate-main', projectId: 'project-A', baseId: 'base-A',
  parentCandidateId: 'candidate-parent', generationParentHash: 'b'.repeat(64), text: 'Revised candidate', textHash: 'a'.repeat(64),
  feedback: intent.input.feedback, constraints: [...intent.input.constraints], origin: { kind: 'generated', runId: 'run-A', attemptId: 'attempt-main',
    artifactId: 'artifact-main', modelLeaseRevision: 'c'.repeat(64), skillSnapshotHash: 'd'.repeat(64), contextSnapshotHash: 'e'.repeat(64) }, createdAt: 1000 }

function fixture() {
  const sessionInput = { ...session }, executed = structuredClone(execution)
  const responses: Partial<Record<PlanningFeedbackChannel, unknown>> = {
    'planning-feedback:v1:capture': { baseId: 'base-A' }, 'planning-feedback:v1:list-bases': [],
    'planning-feedback:v1:read-history': { base: { baseId: 'base-A' }, candidates: [], adoptions: [] },
    'planning-feedback:v1:begin': structuredClone(view), 'planning-feedback:v1:execute': executed,
    'planning-feedback:v1:read-run': { view: structuredClone(view), modelId: intent.modelId, input: structuredClone(intent.input), sourceStatus: 'current' },
    'planning-feedback:v1:list-runs': [{ handle, operation: 'planning-feedback', status: 'running' }],
    'planning-feedback:v1:cancel': { ...structuredClone(view), status: 'cancelled' },
    'planning-feedback:v1:stage': structuredClone(candidate), 'planning-feedback:v1:relineage': structuredClone(candidate),
    'planning-feedback:v1:adopt': { adoptionId: 'adoption-main' },
  }
  const invoke = vi.fn(async (channel: string): Promise<unknown> => responses[channel as PlanningFeedbackChannel])
  vi.stubGlobal('window', { aiNovelAPI: { invoke } })
  setActiveProjectSessionContext(session)
  const client = createPlanningFeedbackClient(sessionInput)
  return { client, invoke, executed, responses, sessionInput }
}
const rangeTarget: PlanningFeedbackRangeScope = { kind: 'plot-outline-range', from: 3, to: 4 }
const rangeCandidate: PlanningFeedbackCandidate = { ...candidate, schemaVersion: 2 }
function rangeFixture() {
  const f = fixture()
  for (const [channel, response] of Object.entries(f.responses)) {
    f.responses[channel.replace('planning-feedback:v1:', 'planning-feedback:v2:') as PlanningFeedbackChannel] = response
  }
  f.responses['planning-feedback:v2:stage'] = structuredClone(rangeCandidate)
  f.responses['planning-feedback:v2:relineage'] = structuredClone(rangeCandidate)
  return { ...f, client: createPlanningFeedbackRangeClient(f.sessionInput) }
}
afterEach(() => { setActiveProjectSessionContext(null); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('project-bound dedicated planning feedback client', () => {
  it('rejects missing or empty sessions and does not dispatch during construction', () => {
    for (const value of [null, undefined, {}, { ...session, leaseId: '' }, { ...session, projectPath: ' ' }]) {
      expect(() => createPlanningFeedbackClient(value as ProjectSessionContext)).toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    }
    const f = fixture()
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('routes all eleven operations through only the frozen project-session namespace', async () => {
    const f = fixture()
    await f.client.capture({ target: 'coreOutline' })
    await f.client.listBases({ target: 'premise' })
    await f.client.readHistory({ baseId: 'base-A' })
    await f.client.begin(intent)
    await f.client.execute({ handle })
    await f.client.readRun({ handle })
    await f.client.listRuns({ baseId: 'base-A' })
    await f.client.cancel({ handle })
    await f.client.stage({ ...intent.input, runId: 'run-A', attemptId: 'attempt-main', artifactId: 'artifact-main' })
    await f.client.relineage({ baseId: 'base-A', sourceCandidateId: 'candidate-old', feedback: 'Explicit copy', constraints: [] })
    await f.client.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'adopt-A', decision: 'edited', text: 'Author final\r\n' })
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual(['capture', 'list-bases', 'read-history', 'begin', 'execute',
      'read-run', 'list-runs', 'cancel', 'stage', 'relineage', 'adopt'].map(command => `planning-feedback:v1:${command}`))
    for (const call of f.invoke.mock.calls as unknown[][]) expect(call[2]).toEqual(session)
  })

  it('deep-copies author input, model and nonce before awaiting and stages only real receipt references', async () => {
    const f = fixture(), request = structuredClone(intent)
    let finish!: (value: unknown) => void
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.client.generateCandidate(request)
    request.input.baseId = 'changed-base'; request.input.parentCandidateId = 'changed-parent'
    request.input.feedback = 'changed-feedback'; (request.input.constraints as string[]).push('changed-constraint')
    request.modelId = 'changed-model'; request.uiActionNonce = 'changed-nonce'; f.sessionInput.leaseId = 'changed-session'
    finish(structuredClone(view))
    expect(await pending).toEqual(candidate)
    expect(f.invoke).toHaveBeenNthCalledWith(1, 'planning-feedback:v1:begin', intent, session)
    expect(f.invoke).toHaveBeenNthCalledWith(2, 'planning-feedback:v1:execute', { handle }, session)
    expect(f.invoke).toHaveBeenNthCalledWith(3, 'planning-feedback:v1:stage', { ...intent.input,
      runId: 'run-A', attemptId: 'attempt-main', artifactId: 'artifact-main' }, session)
    expect(f.invoke).toHaveBeenCalledTimes(3)
  })

  it.each(['begin', 'execute', 'stage'] as const)('does not retry, resume, cancel or adopt when %s fails', async phase => {
    const f = fixture(), original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async channel => {
      if (channel === `planning-feedback:v1:${phase}`) throw new Error('Synthetic lost reply')
      return original(channel)
    })
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('Synthetic lost reply')
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual(['begin', 'execute', 'stage']
      .slice(0, phase === 'begin' ? 1 : phase === 'execute' ? 2 : 3).map(command => `planning-feedback:v1:${command}`))
  })

  it.each(['missing-artifact', 'length', 'storage-failure', 'cancelled'] as const)('does not invent completion proof for %s', async kind => {
    const f = fixture()
    if (kind === 'missing-artifact') delete f.executed.outcome.receipt.visibleArtifact
    if (kind === 'storage-failure') f.executed.outcome.receipt.failureCode = 'GENERATION_STORAGE_FAILED'
    if (kind === 'cancelled') f.executed.run.status = 'cancelled'
    if (kind === 'length') {
      f.executed.outcome = { ...f.executed.outcome, status: 'incomplete', finishReason: 'length' }
      f.executed.outcome.receipt.finishReason = 'length'
    }
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual(['planning-feedback:v1:begin', 'planning-feedback:v1:execute'])
  })

  it('rejects a known stale client before dispatching any request', async () => {
    const f = fixture()
    setActiveProjectSessionContext({ ...session, leaseId: 'reopened-lease' })
    await expect(f.client.capture({ target: 'premise' })).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    await expect(f.client.adopt({ candidateId: 'candidate-main', idempotencyKey: 'adopt', decision: 'edited', text: 'Author final' }))
      .rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it.each(['switch-project', 'same-path-reopen', 'close-project'] as const)('rejects a stale begin reply after %s without continuing', async kind => {
    const f = fixture()
    let finish!: (value: unknown) => void
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.client.generateCandidate(intent)
    setActiveProjectSessionContext(kind === 'close-project' ? null : kind === 'same-path-reopen'
      ? { ...session, leaseId: 'lease-new' } : { projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/synthetic/B' })
    finish(structuredClone(view))
    await expect(pending).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('planning-feedback:v1:begin', intent, session)
  })

  it('rejects a stale execute reply before staging and never routes into the new active project', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    f.invoke.mockImplementation(channel => channel === 'planning-feedback:v1:execute'
      ? new Promise(resolve => { finish = resolve }) : original(channel))
    const pending = f.client.generateCandidate(intent)
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(2))
    setActiveProjectSessionContext({ ...session, leaseId: 'new-lease' })
    finish(f.executed)
    await expect(pending).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(f.invoke).toHaveBeenCalledTimes(2)
    for (const call of f.invoke.mock.calls as unknown[][]) expect(call[2]).toEqual(session)
  })

  it.each(['stage', 'adopt'] as const)('does not expose or repeat a late %s reply after the session changes', async phase => {
    const f = fixture()
    let finish!: (value: unknown) => void
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = phase === 'stage'
      ? f.client.stage({ ...intent.input, runId: 'run-A', attemptId: 'attempt-main', artifactId: 'artifact-main' })
      : f.client.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'adopt-A', decision: 'edited', text: 'Author final' })
    setActiveProjectSessionContext(null)
    finish(phase === 'stage' ? candidate : { adoptionId: 'adoption-main' })
    await expect(pending).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(f.invoke).toHaveBeenCalledTimes(1)
    expect(f.invoke.mock.calls[0]?.[0]).toBe(`planning-feedback:v1:${phase}`)
  })

  it('reads original-run history using the captured current session without automatic resume', async () => {
    const f = fixture(), historical = { ...handle, epoch: 'old-lease' }
    f.responses['planning-feedback:v1:read-run'] = { view: { ...view, handle: historical }, modelId: intent.modelId,
      input: intent.input, sourceStatus: 'conflict' }
    expect(await f.client.readRun({ handle: historical })).toMatchObject({ sourceStatus: 'conflict', view: { handle: historical } })
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('planning-feedback:v1:read-run', { handle: historical }, session)
  })

  it('accepts main-authorized epoch rebinding for explicit old-run execution but preserves root and run identity', async () => {
    const f = fixture(), historical = { ...handle, epoch: 'old-lease' }
    expect(await f.client.execute({ handle: historical })).toEqual(f.executed)
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('planning-feedback:v1:execute', { handle: historical }, session)
  })

  it('rejects closed-wire overrides and foreign run identity without invoking generic generation', async () => {
    const f = fixture()
    await expect(f.client.execute({ handle, task: { messages: [] } } as Parameters<typeof f.client.execute>[0])).rejects.toThrow()
    await expect(f.client.execute({ handle: { ...handle, projectId: 'project-B' } })).rejects.toThrow('IDENTITY_MISMATCH')
    await expect(f.client.adopt({ candidateId: 'candidate-main', idempotencyKey: 'adopt', decision: 'full', text: 'x',
      decisionSource: 'author-action' } as Parameters<typeof f.client.adopt>[0])).rejects.toThrow()
    expect(f.invoke).not.toHaveBeenCalled()
    f.responses['planning-feedback:v1:execute'] = { ...execution, run: { ...view, handle: { ...handle, runId: 'other-run' } } }
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('IDENTITY_MISMATCH')
    expect(f.invoke).toHaveBeenCalledTimes(2)
  })
})

describe('project-bound dedicated outline-range feedback client', () => {
  it('keeps field and range request and result types separate', () => {
    expectTypeOf<Parameters<PlanningFeedbackClient['capture']>[0]>().toEqualTypeOf<{ target: PlanningFeedbackCoreTarget }>()
    expectTypeOf<Parameters<PlanningFeedbackRangeClient['capture']>[0]>().toEqualTypeOf<{ target: PlanningFeedbackRangeScope }>()
    expectTypeOf<Awaited<ReturnType<PlanningFeedbackClient['capture']>>>().toEqualTypeOf<PlanningFeedbackFieldBase>()
    expectTypeOf<Awaited<ReturnType<PlanningFeedbackRangeClient['capture']>>>().toEqualTypeOf<PlanningFeedbackRangeBase>()
    expectTypeOf<Awaited<ReturnType<PlanningFeedbackRangeClient['listBases']>>>().toEqualTypeOf<PlanningFeedbackRangeBaseSummary[]>()
    expectTypeOf<Parameters<PlanningFeedbackClient['adopt']>[0]>().toEqualTypeOf<Omit<AdoptPlanningFeedbackCandidate, 'adoptedRange'>>()
    expectTypeOf<Parameters<PlanningFeedbackRangeClient['adopt']>[0]>().toEqualTypeOf<AdoptPlanningFeedbackCandidate>()
  })

  it('requires a complete session without dispatching during construction', () => {
    for (const value of [null, undefined, {}, { ...session, leaseId: '' }, { ...session, projectPath: ' ' }]) {
      expect(() => createPlanningFeedbackRangeClient(value as ProjectSessionContext)).toThrow('GENERATION_PROJECT_SESSION_REQUIRED')
    }
    expect(rangeFixture().invoke).not.toHaveBeenCalled()
  })

  it('routes all eleven range operations through the frozen project-session v2 namespace', async () => {
    const f = rangeFixture()
    await f.client.capture({ target: rangeTarget })
    await f.client.listBases({ target: rangeTarget })
    await f.client.readHistory({ baseId: 'base-A' })
    await f.client.begin(intent)
    await f.client.execute({ handle })
    await f.client.readRun({ handle })
    await f.client.listRuns({ baseId: 'base-A' })
    await f.client.cancel({ handle })
    await f.client.stage({ ...intent.input, runId: 'run-A', attemptId: 'attempt-main', artifactId: 'artifact-main' })
    await f.client.relineage({ baseId: 'base-A', sourceCandidateId: 'candidate-old', feedback: 'Explicit copy', constraints: [] })
    await f.client.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'range-adopt-A', decision: 'partial',
      text: 'Author range text\r\n', adoptedRange: { from: 3, to: 3 } })

    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual(['capture', 'list-bases', 'read-history', 'begin', 'execute',
      'read-run', 'list-runs', 'cancel', 'stage', 'relineage', 'adopt'].map(command => `planning-feedback:v2:${command}`))
    for (const call of f.invoke.mock.calls as unknown[][]) expect(call[2]).toEqual(session)
  })

  it('freezes author input, model, nonce and session before awaiting generation, without adopting', async () => {
    const f = rangeFixture(), request = structuredClone(intent)
    let finish!: (value: unknown) => void
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.client.generateCandidate(request)
    request.input.baseId = 'changed-base'; request.input.parentCandidateId = 'changed-parent'
    request.input.feedback = 'changed-feedback'; (request.input.constraints as string[]).push('changed-constraint')
    request.modelId = 'changed-model'; request.uiActionNonce = 'changed-nonce'; f.sessionInput.leaseId = 'changed-session'
    finish(structuredClone(view))

    expect(await pending).toEqual(rangeCandidate)
    expect(f.invoke).toHaveBeenNthCalledWith(1, 'planning-feedback:v2:begin', intent, session)
    expect(f.invoke).toHaveBeenNthCalledWith(2, 'planning-feedback:v2:execute', { handle }, session)
    expect(f.invoke).toHaveBeenNthCalledWith(3, 'planning-feedback:v2:stage', { ...intent.input,
      runId: 'run-A', attemptId: 'attempt-main', artifactId: 'artifact-main' }, session)
    expect(f.invoke).toHaveBeenCalledTimes(3)
  })

  it('copies nested capture and adopted ranges rather than retaining caller-owned objects', async () => {
    const f = rangeFixture(), target = { ...rangeTarget }
    const capture = f.client.capture({ target })
    target.from = 1; target.to = 10
    await capture
    expect(f.invoke).toHaveBeenNthCalledWith(1, 'planning-feedback:v2:capture', { target: rangeTarget }, session)
    const adoption = { candidateId: candidate.candidateId, idempotencyKey: 'range-adopt', decision: 'partial' as const,
      text: 'Author range text\r\n', adoptedRange: { from: 3, to: 3 } }
    const pending = f.client.adopt(adoption)
    adoption.adoptedRange.to = 4; adoption.text = 'Changed text'
    await pending
    expect(f.invoke).toHaveBeenNthCalledWith(2, 'planning-feedback:v2:adopt', { candidateId: candidate.candidateId,
      idempotencyKey: 'range-adopt', decision: 'partial', text: 'Author range text\r\n', adoptedRange: { from: 3, to: 3 } }, session)
  })

  it.each(['begin', 'execute', 'stage'] as const)('does not retry, resume, cancel or adopt after %s fails', async phase => {
    const f = rangeFixture(), original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async channel => {
      if (channel === `planning-feedback:v2:${phase}`) throw new Error('Synthetic range lost reply')
      return original(channel)
    })
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('Synthetic range lost reply')
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual(['begin', 'execute', 'stage']
      .slice(0, phase === 'begin' ? 1 : phase === 'execute' ? 2 : 3).map(command => `planning-feedback:v2:${command}`))
  })

  it('leaves an unknown dispatch available for explicit history reads without automatically sending it again', async () => {
    const f = rangeFixture(), original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async channel => {
      if (channel === 'planning-feedback:v2:execute') throw new Error('GENERATION_ATTEMPT_UNKNOWN')
      return original(channel)
    })
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('GENERATION_ATTEMPT_UNKNOWN')
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual(['planning-feedback:v2:begin', 'planning-feedback:v2:execute'])
    await f.client.readRun({ handle })
    await f.client.readHistory({ baseId: intent.input.baseId })
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual(['planning-feedback:v2:begin', 'planning-feedback:v2:execute',
      'planning-feedback:v2:read-run', 'planning-feedback:v2:read-history'])
  })

  it('retains original run, artifact references and history access after staging fails', async () => {
    const f = rangeFixture(), original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async channel => {
      if (channel === 'planning-feedback:v2:stage') throw new Error('PLANNING_FEEDBACK_SOURCE_CONFLICT')
      return original(channel)
    })
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('PLANNING_FEEDBACK_SOURCE_CONFLICT')
    expect(f.invoke).toHaveBeenNthCalledWith(3, 'planning-feedback:v2:stage', { ...intent.input,
      runId: 'run-A', attemptId: 'attempt-main', artifactId: 'artifact-main' }, session)
    expect(await f.client.readRun({ handle })).toMatchObject({ view: { handle }, input: intent.input })
    await f.client.readHistory({ baseId: intent.input.baseId })
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual(['begin', 'execute', 'stage', 'read-run', 'read-history']
      .map(command => `planning-feedback:v2:${command}`))
  })

  it.each(['missing-artifact', 'length', 'storage-failure', 'cancelled'] as const)('does not stage unproven %s output', async kind => {
    const f = rangeFixture()
    if (kind === 'missing-artifact') delete f.executed.outcome.receipt.visibleArtifact
    if (kind === 'storage-failure') f.executed.outcome.receipt.failureCode = 'GENERATION_STORAGE_FAILED'
    if (kind === 'cancelled') f.executed.run.status = 'cancelled'
    if (kind === 'length') {
      f.executed.outcome = { ...f.executed.outcome, status: 'incomplete', finishReason: 'length' }
      f.executed.outcome.receipt.finishReason = 'length'
    }
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
    expect(f.invoke.mock.calls.map(([channel]) => channel)).toEqual(['planning-feedback:v2:begin', 'planning-feedback:v2:execute'])
  })

  it('rejects an already stale session before any range operation is dispatched', async () => {
    const f = rangeFixture()
    setActiveProjectSessionContext({ ...session, leaseId: 'lease-new' })
    await expect(f.client.capture({ target: rangeTarget })).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    await expect(f.client.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'adopt-A', decision: 'full', text: 'Author range' }))
      .rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it.each(['switch-project', 'same-path-reopen', 'close-project'] as const)('rejects a late range begin reply after %s', async kind => {
    const f = rangeFixture()
    let finish!: (value: unknown) => void
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.client.generateCandidate(intent)
    setActiveProjectSessionContext(kind === 'close-project' ? null : kind === 'same-path-reopen'
      ? { ...session, leaseId: 'lease-new' } : { projectId: 'project-B', leaseId: 'lease-B', projectPath: 'C:/synthetic/B' })
    finish(structuredClone(view))
    await expect(pending).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('planning-feedback:v2:begin', intent, session)
  })

  it('rejects a late execute reply without staging or routing into a reopened session', async () => {
    const f = rangeFixture(), original = f.invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    f.invoke.mockImplementation(channel => channel === 'planning-feedback:v2:execute'
      ? new Promise(resolve => { finish = resolve }) : original(channel))
    const pending = f.client.generateCandidate(intent)
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(2))
    setActiveProjectSessionContext({ ...session, leaseId: 'lease-new' })
    finish(f.executed)
    await expect(pending).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(f.invoke).toHaveBeenCalledTimes(2)
    for (const call of f.invoke.mock.calls as unknown[][]) expect(call[2]).toEqual(session)
  })

  it.each(['stage', 'adopt'] as const)('rejects a late range %s response without repeating it', async phase => {
    const f = rangeFixture()
    let finish!: (value: unknown) => void
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = phase === 'stage'
      ? f.client.stage({ ...intent.input, runId: 'run-A', attemptId: 'attempt-main', artifactId: 'artifact-main' })
      : f.client.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'range-adopt', decision: 'partial',
          text: 'Author range text', adoptedRange: { from: 3, to: 3 } })
    setActiveProjectSessionContext(null)
    finish(phase === 'stage' ? rangeCandidate : { adoptionId: 'adoption-main' })
    await expect(pending).rejects.toThrow('GENERATION_PROJECT_SESSION_STALE')
    expect(f.invoke).toHaveBeenCalledTimes(1)
    expect(f.invoke.mock.calls[0]?.[0]).toBe(`planning-feedback:v2:${phase}`)
  })

  it('reads historical range runs and accepts explicit epoch rebinding without automatic resume', async () => {
    const f = rangeFixture(), historical = { ...handle, epoch: 'old-lease' }
    f.responses['planning-feedback:v2:read-run'] = { view: { ...view, handle: historical }, modelId: intent.modelId,
      input: intent.input, sourceStatus: 'conflict' }
    expect(await f.client.readRun({ handle: historical })).toMatchObject({ sourceStatus: 'conflict', view: { handle: historical } })
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('planning-feedback:v2:read-run', { handle: historical }, session)
    expect(await f.client.execute({ handle: historical })).toEqual(f.executed)
    expect(f.invoke).toHaveBeenNthCalledWith(2, 'planning-feedback:v2:execute', { handle: historical }, session)
  })

  it('rejects field targets, payload smuggling and foreign identities before generic generation is invoked', async () => {
    const f = rangeFixture()
    await expect(f.client.capture({ target: 'coreOutline' } as unknown as Parameters<typeof f.client.capture>[0])).rejects.toThrow()
    await expect(f.client.listBases({ target: { ...rangeTarget, to: 20 } })).rejects.toThrow()
    await expect(f.client.execute({ handle, task: { messages: [] } } as Parameters<typeof f.client.execute>[0])).rejects.toThrow()
    await expect(f.client.execute({ handle: { ...handle, projectId: 'project-B' } })).rejects.toThrow('IDENTITY_MISMATCH')
    await expect(f.client.adopt({ candidateId: candidate.candidateId, idempotencyKey: 'adopt-A', decision: 'partial',
      text: 'Author range', adoptedRange: { from: 3, to: 3 }, decisionSource: 'author-action' } as Parameters<typeof f.client.adopt>[0])).rejects.toThrow()
    expect(f.invoke).not.toHaveBeenCalled()
    f.responses['planning-feedback:v2:execute'] = { ...execution, run: { ...view, handle: { ...handle, runId: 'other-run' } } }
    await expect(f.client.generateCandidate(intent)).rejects.toThrow('IDENTITY_MISMATCH')
    expect(f.invoke).toHaveBeenCalledTimes(2)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import type { BeginPlanningFeedbackRequest, PlanningFeedbackChannel } from '../../shared/planning-feedback-ipc'
import type { PlanningFeedbackCandidate } from '../../shared/planning-feedback'
import type { MainGenerationExecuteReceipt, MainGenerationRunView } from '../generation/generation-runtime'
import type { GenerationAttemptReceipt } from '../generation/generation-harness'
import { createPlanningFeedbackClient } from '../planning-feedback-client'

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

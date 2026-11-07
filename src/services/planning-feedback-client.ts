import { ipc } from './ipc-client'
import type { AllInvokeChannels, ProjectSessionContext } from '../shared/ipc-channels'
import { getActiveProjectSessionContext, isProjectSessionContext, sameProjectSessionContext } from '../shared/project-session-context'
import type { PlanningFeedbackCandidate } from '../shared/planning-feedback'
import { assertPlanningFeedbackRequest, type BeginPlanningFeedbackRequest,
  type PlanningFeedbackChannel, type PlanningFeedbackChannels } from '../shared/planning-feedback-ipc'
import type { MainGenerationRunHandle } from './generation/generation-runtime'

type Request<C extends PlanningFeedbackChannel> = PlanningFeedbackChannels[C]['args'][0]

/** The caller resolves author intent and unsaved buffers before constructing this project-bound client. */
export function createPlanningFeedbackClient(sessionInput: ProjectSessionContext) {
  if (!isProjectSessionContext(sessionInput)
    || ![sessionInput.projectId, sessionInput.leaseId, sessionInput.projectPath].every(value => value.trim())) {
    throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
  }
  const session = Object.freeze({ projectId: sessionInput.projectId, leaseId: sessionInput.leaseId, projectPath: sessionInput.projectPath })

  function assertSessionCurrent(): void {
    if (!sameProjectSessionContext(session, getActiveProjectSessionContext())) throw new Error('GENERATION_PROJECT_SESSION_STALE')
  }

  function assertRun(value: unknown, expected?: MainGenerationRunHandle): void {
    const request = { handle: value }
    assertPlanningFeedbackRequest('planning-feedback:v1:read-run', request)
    const handle = request.handle
    if (handle.projectId !== session.projectId
      || expected && (handle.rootActionId !== expected.rootActionId || handle.runId !== expected.runId)) {
      throw new Error('GENERATION_RESPONSE_IDENTITY_MISMATCH')
    }
  }

  async function invoke<C extends PlanningFeedbackChannel>(channel: C, request: Request<C>): Promise<PlanningFeedbackChannels[C]['return']> {
    const frozen = structuredClone(request)
    assertPlanningFeedbackRequest(channel, frozen)
    if ('handle' in frozen) assertRun(frozen.handle)
    assertSessionCurrent()
    const result = await ipc.invokeWithProjectSession(session, channel, ...([frozen] as AllInvokeChannels[C]['args']))
    assertSessionCurrent()
    return result
  }

  const client = {
    capture: (request: Request<'planning-feedback:v1:capture'>) => invoke('planning-feedback:v1:capture', request),
    listBases: (request: Request<'planning-feedback:v1:list-bases'>) => invoke('planning-feedback:v1:list-bases', request),
    readHistory: (request: Request<'planning-feedback:v1:read-history'>) => invoke('planning-feedback:v1:read-history', request),
    async begin(request: BeginPlanningFeedbackRequest) {
      const view = await invoke('planning-feedback:v1:begin', request)
      assertRun(view.handle)
      return view
    },
    async execute(request: Request<'planning-feedback:v1:execute'>) {
      const frozen = structuredClone(request)
      const receipt = await invoke('planning-feedback:v1:execute', frozen)
      assertRun(receipt.run.handle, frozen.handle)
      return receipt
    },
    async readRun(request: Request<'planning-feedback:v1:read-run'>) {
      const frozen = structuredClone(request)
      const recovery = await invoke('planning-feedback:v1:read-run', frozen)
      assertRun(recovery.view.handle, frozen.handle)
      return recovery
    },
    listRuns: (request: Request<'planning-feedback:v1:list-runs'>) => invoke('planning-feedback:v1:list-runs', request),
    async cancel(request: Request<'planning-feedback:v1:cancel'>) {
      const frozen = structuredClone(request)
      const view = await invoke('planning-feedback:v1:cancel', frozen)
      assertRun(view.handle, frozen.handle)
      return view
    },
    stage: (request: Request<'planning-feedback:v1:stage'>) => invoke('planning-feedback:v1:stage', request),
    relineage: (request: Request<'planning-feedback:v1:relineage'>) => invoke('planning-feedback:v1:relineage', request),
    adopt: (request: Request<'planning-feedback:v1:adopt'>) => invoke('planning-feedback:v1:adopt', request),
    async generateCandidate(request: BeginPlanningFeedbackRequest): Promise<PlanningFeedbackCandidate> {
      const frozen = structuredClone(request)
      assertPlanningFeedbackRequest('planning-feedback:v1:begin', frozen)
      const view = await client.begin(frozen)
      const executed = await client.execute({ handle: view.handle })
      const receipt = executed.outcome.receipt, artifact = receipt.visibleArtifact
      if (executed.outcome.finishReason !== 'stop' || receipt.finishReason !== 'stop' || receipt.failureCode || !artifact
        || executed.run.status === 'cancelled') {
        throw new Error('PLANNING_FEEDBACK_GENERATION_UNPROVEN')
      }
      return client.stage({ ...frozen.input, runId: executed.run.handle.runId,
        attemptId: artifact.attemptId, artifactId: artifact.artifactId })
    },
  }
  return client
}

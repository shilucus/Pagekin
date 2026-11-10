import { ipc } from './ipc-client'
import type { AllInvokeChannels, ProjectSessionContext } from '../shared/ipc-channels'
import { getActiveProjectSessionContext, isProjectSessionContext, sameProjectSessionContext } from '../shared/project-session-context'
import type { PlanningFeedbackCandidate } from '../shared/planning-feedback'
import { assertPlanningFeedbackRequest, type BeginPlanningFeedbackRequest,
  type PlanningFeedbackChannel, type PlanningFeedbackChannels, type PlanningFeedbackFieldChannel } from '../shared/planning-feedback-ipc'
import type { MainGenerationRunHandle } from './generation/generation-runtime'

type Request<C extends PlanningFeedbackChannel> = PlanningFeedbackChannels[C]['args'][0]
type Command = PlanningFeedbackFieldChannel extends `planning-feedback:v1:${infer Value}` ? Value : never
type VersionedChannel<V extends 1 | 2 | 3, C extends Command> = Extract<PlanningFeedbackChannel, `planning-feedback:v${V}:${C}`>

/** The caller resolves author intent and unsaved buffers before constructing this project-bound client. */
export function createPlanningFeedbackClient(sessionInput: ProjectSessionContext) {
  return createProjectPlanningFeedbackClient(sessionInput, 1)
}

export function createPlanningFeedbackRangeClient(sessionInput: ProjectSessionContext) {
  return createProjectPlanningFeedbackClient(sessionInput, 2)
}

export function createPlanningFeedbackBlueprintClient(sessionInput: ProjectSessionContext) {
  return createProjectPlanningFeedbackClient(sessionInput, 3)
}

function createProjectPlanningFeedbackClient<V extends 1 | 2 | 3>(sessionInput: ProjectSessionContext, version: V) {
  if (!isProjectSessionContext(sessionInput)
    || ![sessionInput.projectId, sessionInput.leaseId, sessionInput.projectPath].every(value => value.trim())) {
    throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
  }
  const session = Object.freeze({ projectId: sessionInput.projectId, leaseId: sessionInput.leaseId, projectPath: sessionInput.projectPath })

  function channel<C extends Command>(command: C): VersionedChannel<V, C> {
    return `planning-feedback:v${version}:${command}` as VersionedChannel<V, C>
  }

  function assertSessionCurrent(): void {
    if (!sameProjectSessionContext(session, getActiveProjectSessionContext())) throw new Error('GENERATION_PROJECT_SESSION_STALE')
  }

  function assertRun(value: unknown, expected?: MainGenerationRunHandle): void {
    const request = { handle: value }
    assertPlanningFeedbackRequest(channel('read-run'), request)
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
    capture: (request: Request<VersionedChannel<V, 'capture'>>) => invoke(channel('capture'), request),
    listBases: (request: Request<VersionedChannel<V, 'list-bases'>>) => invoke(channel('list-bases'), request),
    readHistory: (request: Request<VersionedChannel<V, 'read-history'>>) => invoke(channel('read-history'), request),
    async begin(request: BeginPlanningFeedbackRequest) {
      const view = await invoke<VersionedChannel<1 | 2 | 3, 'begin'>>(channel('begin'), request)
      assertRun(view.handle)
      return view
    },
    async execute(request: Request<VersionedChannel<1 | 2 | 3, 'execute'>>) {
      const frozen = structuredClone(request)
      const receipt = await invoke<VersionedChannel<1 | 2 | 3, 'execute'>>(channel('execute'), frozen)
      assertRun(receipt.run.handle, frozen.handle)
      return receipt
    },
    async readRun(request: Request<VersionedChannel<V, 'read-run'>>) {
      const frozen = structuredClone(request)
      const recovery = await invoke(channel('read-run'), frozen)
      assertRun(recovery.view.handle, frozen.handle)
      return recovery
    },
    listRuns: (request: Request<VersionedChannel<V, 'list-runs'>>) => invoke(channel('list-runs'), request),
    async cancel(request: Request<VersionedChannel<V, 'cancel'>>) {
      const frozen = structuredClone(request)
      const view = await invoke(channel('cancel'), frozen)
      assertRun(view.handle, frozen.handle)
      return view
    },
    stage: (request: Request<VersionedChannel<1 | 2 | 3, 'stage'>>) => invoke<VersionedChannel<1 | 2 | 3, 'stage'>>(channel('stage'), request),
    relineage: (request: Request<VersionedChannel<V, 'relineage'>>) => invoke(channel('relineage'), request),
    adopt: (request: Request<VersionedChannel<V, 'adopt'>>) => invoke(channel('adopt'), request),
    async generateCandidate(request: BeginPlanningFeedbackRequest): Promise<PlanningFeedbackCandidate> {
      const frozen = structuredClone(request)
      assertPlanningFeedbackRequest(channel('begin'), frozen)
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

export type PlanningFeedbackClient = ReturnType<typeof createPlanningFeedbackClient>
export type PlanningFeedbackRangeClient = ReturnType<typeof createPlanningFeedbackRangeClient>
export type PlanningFeedbackBlueprintClient = ReturnType<typeof createPlanningFeedbackBlueprintClient>

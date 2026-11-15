import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData, ProjectSessionContext } from '../../shared/ipc-channels'
import { globalEventBus } from '../../shared/event-bus'
import { WorkflowCancelledError } from '../../services/workflows/workflow-cancellation'
import { isWorkflowBackgroundQualified } from '../../shared/workflow-background-qualification'
import { useProjectStore } from '../project-store'
import { useWorkflowStore, type WorkflowContext, type WorkflowDefinition } from '../workflow-store'

vi.mock('../../services/agent/writing-skill-bindings', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/agent/writing-skill-bindings')>(),
  freezeWritingSkillsSnapshot: vi.fn(async () => ({})),
}))

const session: ProjectSessionContext = { projectId: 'A', leaseId: 'lease-A', projectPath: 'C:\\novels\\A' }
function project(id: string, lease = `lease-${id}`): ProjectData {
  return { id, name: id, path: `C:\\novels\\${id}`, sessionLease: lease,
    novelConfig: {}, characterStates: '', createdAt: '', updatedAt: '' } as ProjectData
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}
function definition(executor: WorkflowDefinition['steps'][number]['executor']): WorkflowDefinition {
  return { runId: 'reference-A', type: 'novel_import', title: 'Reference A',
    backgroundExecution: 'reference-run', projectPath: session.projectPath, projectSession: session,
    steps: [{ name: 'reference', description: 'reference', executor }] }
}

beforeEach(() => {
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {},
    currentRun: null, waitingForConfirm: false, waitingAfterStepIndex: -1 })
  useProjectStore.setState({ currentProject: project('A'), loading: false, retainedViews: false })
})
afterEach(() => {
  vi.restoreAllMocks()
  useProjectStore.setState({ loading: false, retainedViews: false })
})

describe('retained reference view projection', () => {
  it('does not qualify the definition before main admission and keeps the execution session frozen', async () => {
    const gate = deferred()
    let context!: WorkflowContext
    const pending = useWorkflowStore.getState().startWorkflow(definition(async (_step, ctx) => {
      context = ctx
      await gate.promise
    }))
    await vi.waitFor(() => expect(context).toBeDefined())
    expect(isWorkflowBackgroundQualified(useWorkflowStore.getState().activeRuns[0]!)).toBe(false)
    context.markReferenceRunAdmitted!()
    context.markReferenceRunAdmitted!()
    expect(isWorkflowBackgroundQualified(useWorkflowStore.getState().activeRuns[0]!)).toBe(true)
    expect(Object.isFrozen(context.projectSession)).toBe(true)
    gate.resolve()
    await pending
    expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')
  })

  it('waits through B and A loading, then projects under A new lease without replacing execution identity', async () => {
    const inFlight = deferred()
    let context!: WorkflowContext
    let projected = false
    const completed = vi.fn()
    const unsubscribe = globalEventBus.on('WORKFLOW_COMPLETE', completed)
    const pending = useWorkflowStore.getState().startWorkflow(definition(async (_step, ctx, callbacks) => {
      context = ctx
      ctx.markReferenceRunAdmitted!()
      await inFlight.promise
      callbacks.setProgress(80)
      await ctx.waitForProjectView!()
      projected = true
    }))
    await vi.waitFor(() => expect(context).toBeDefined())
    useProjectStore.setState({ currentProject: project('B') })
    inFlight.resolve()
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns[0]?.steps[0]?.progress).toBe(80))
    expect(projected).toBe(false)
    expect(useProjectStore.getState().currentProject?.id).toBe('B')
    useProjectStore.setState({ currentProject: project('A', 'lease-A-new'), loading: true })
    await Promise.resolve()
    expect(projected).toBe(false)
    useProjectStore.setState({ loading: false })
    await pending
    unsubscribe()
    expect(projected).toBe(true)
    expect(context.projectSession).toEqual(session)
    expect(context.projectionSession).toEqual({ ...session, leaseId: 'lease-A-new' })
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      projectSession: { ...session, leaseId: 'lease-A-new' }, runId: 'reference-A',
    }))
    expect(useWorkflowStore.getState().history[0]?.status).toBe('completed')
  })

  it('does not retarget a completion projection after A has left the current view again', async () => {
    const gate = deferred()
    let context!: WorkflowContext
    const completed = vi.fn()
    const unsubscribe = globalEventBus.on('WORKFLOW_COMPLETE', completed)
    const pending = useWorkflowStore.getState().startWorkflow(definition(async (_step, ctx) => {
      context = ctx
      ctx.markReferenceRunAdmitted!()
      await ctx.waitForProjectView!()
      await gate.promise
    }))
    await vi.waitFor(() => expect(context?.projectionSession).toBeDefined())
    useProjectStore.setState({ currentProject: project('B') })
    gate.resolve()
    await pending
    unsubscribe()
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ projectSession: session }))
    expect(context.projectSession).toEqual(session)
    expect(useProjectStore.getState().currentProject?.id).toBe('B')
  })

  it('does not rebind by path when project identity differs', async () => {
    const inFlight = deferred()
    let context!: WorkflowContext
    const revoke = vi.fn(async () => {})
    const input = { ...definition(async (_step, ctx) => {
      context = ctx
      ctx.markReferenceRunAdmitted!()
      await inFlight.promise
      await ctx.waitForProjectView!()
    }), onCancelRequested: revoke }
    const pending = useWorkflowStore.getState().startWorkflow(input)
    await vi.waitFor(() => expect(context).toBeDefined())
    useProjectStore.setState({ currentProject: { ...project('B'), path: session.projectPath } })
    inFlight.resolve()
    await Promise.resolve()
    expect(context.projectionSession).toBeUndefined()
    useWorkflowStore.getState().cancelWorkflow('reference-A')
    await pending
    expect(revoke).toHaveBeenCalledOnce()
    expect(useWorkflowStore.getState().history[0]?.status).toBe('cancelled')
  })

  it('cancels an offscreen view waiter without requiring A to return', async () => {
    const gate = deferred()
    let context!: WorkflowContext
    const revoke = vi.fn(async () => {})
    const input = { ...definition(async (_step, ctx) => {
      context = ctx
      ctx.markReferenceRunAdmitted!()
      await gate.promise
      await ctx.waitForProjectView!()
    }), onCancelRequested: revoke }
    const pending = useWorkflowStore.getState().startWorkflow(input)
    await vi.waitFor(() => expect(context).toBeDefined())
    useProjectStore.setState({ currentProject: project('B') })
    gate.resolve()
    await Promise.resolve()
    useWorkflowStore.getState().cancelWorkflow('reference-A')
    await pending
    context.markReferenceRunAdmitted!()
    expect(revoke).toHaveBeenCalledOnce()
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(0)
    expect(useWorkflowStore.getState().history[0]?.status).toBe('cancelled')
  })

  it.each([false, true])('releases both view subscriptions when its projection is aborted (already aborted: %s)', async alreadyAborted => {
    const gate = deferred()
    let context!: WorkflowContext
    const pending = useWorkflowStore.getState().startWorkflow(definition(async (_step, ctx) => {
      context = ctx
      ctx.markReferenceRunAdmitted!()
      await gate.promise
    }))
    await vi.waitFor(() => expect(context).toBeDefined())
    useProjectStore.setState({ currentProject: project('B') })
    const projectSubscribe = useProjectStore.subscribe
    const workflowSubscribe = useWorkflowStore.subscribe
    const releasedProject = vi.fn(), releasedWorkflow = vi.fn()
    vi.spyOn(useProjectStore, 'subscribe').mockImplementation(listener => {
      const unsubscribe = projectSubscribe(listener)
      return () => { releasedProject(); unsubscribe() }
    })
    vi.spyOn(useWorkflowStore, 'subscribe').mockImplementation(listener => {
      const unsubscribe = workflowSubscribe(listener)
      return () => { releasedWorkflow(); unsubscribe() }
    })
    const abort = new AbortController()
    if (alreadyAborted) abort.abort()
    const waiting = context.waitForProjectView!(abort.signal)
    const rejected = expect(waiting).rejects.toBeInstanceOf(WorkflowCancelledError)
    if (!alreadyAborted) abort.abort()
    await rejected
    expect(releasedProject).toHaveBeenCalledOnce()
    expect(releasedWorkflow).toHaveBeenCalledOnce()
    expect(context.projectionSession).toBeUndefined()
    gate.resolve()
    await pending
  })

  it.each(['batch_generate', 'architecture_generation'] as const)('does not expose reference view methods to %s', async type => {
    let context!: WorkflowContext
    await useWorkflowStore.getState().startWorkflow({ ...definition(async (_step, ctx) => { context = ctx }), type })
    expect(context.waitForProjectView).toBeUndefined()
    expect(context.markReferenceRunAdmitted).toBeUndefined()
    expect(useWorkflowStore.getState().history[0]?.backgroundQualified).not.toBe(true)
  })
})

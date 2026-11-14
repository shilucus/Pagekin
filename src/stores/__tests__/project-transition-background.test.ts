import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData } from '../../shared/ipc-channels'
import { useEditorStore } from '../editor-store'
import { useProjectStore } from '../project-store'
import { useWorkflowStore, type WorkflowRun } from '../workflow-store'
import { createBatchChapterWorkflow } from '../../services/workflows/batch-chapter-workflow'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  alertError: vi.fn(),
  confirm: vi.fn(async () => true),
  onProjectOpening: vi.fn(),
  onProjectOpened: vi.fn(async () => undefined),
  disableProjectBindingsPreservingDrafts: vi.fn(),
  onProjectClosed: vi.fn(async () => {}),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    invokeWithProjectSession: (_context: unknown, channel: string, ...args: unknown[]) => (
      channel === 'fs:check-exists' ? Promise.resolve(false) : mocks.invoke(channel, ...args)
    ),
  },
}))

vi.mock('../../components/ui/AlertDialog', () => ({
  alertError: mocks.alertError,
}))

vi.mock('../../components/ui/Confirm', () => ({
  confirm: mocks.confirm,
}))

vi.mock('../../services/project-service', () => ({
  disableProjectBindingsPreservingDrafts: mocks.disableProjectBindingsPreservingDrafts,
  onProjectOpening: mocks.onProjectOpening,
  onProjectOpened: mocks.onProjectOpened,
  onProjectClosed: mocks.onProjectClosed,
}))

vi.mock('../../services/agent/writing-skill-bindings', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/agent/writing-skill-bindings')>(),
  freezeWritingSkillsSnapshot: vi.fn(async () => ({})),
}))

function project(key: 'A' | 'B'): ProjectData {
  return {
    id: key,
    name: `Project ${key}`,
    path: `C:\\novels\\${key}`,
    sessionLease: `lease-${key}`,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 3,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function makeRun(id: string, projectKey: 'A' | 'B', type: WorkflowRun['type'], backgroundQualified = false): WorkflowRun {
  return {
    id,
    projectPath: `C:\\novels\\${projectKey}`,
    projectSession: {
      projectId: projectKey,
      leaseId: `lease-${projectKey}`,
      projectPath: `C:\\novels\\${projectKey}`,
    },
    type,
    backgroundQualified,
    title: `Run ${id}`,
    status: 'running',
    steps: [{ id: 's1', name: 'Step 1', description: 'Step 1 description', logs: [], status: 'running' }],
    currentStepIndex: 0,
    createdAt: new Date().toISOString(),
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
  }
}

function startBlockedBatch() {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const fallback = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'generation:begin-batch') {
      const input = args[0] as { mode: string; targetUnits: number; range: { startChapter: number; endChapter: number } }
      await blocked
      return { ...input, batchId: 'fixture-batch', rootHandle: { projectId: 'A', epoch: 'lease-A',
        rootActionId: 'fixture-root', runId: 'fixture-run' },
      completedChapters: [{ chapterNumber: 1 }], nextChapterNumber: null }
    }
    return fallback(channel, ...args)
  })
  const definition = createBatchChapterWorkflow({ projectPath: 'C:\\novels\\A',
    projectSession: { projectId: 'A', leaseId: 'lease-A', projectPath: 'C:\\novels\\A' },
    startChapterNumber: 1, chapterCount: 1, generationModelId: 'fixture-model', completionMode: 'draft_review' })
  const completion = useWorkflowStore.getState().startWorkflow({ ...definition, runId: 'real-batch' })
  return { release, completion }
}

describe('Project Transition and Background Qualification (UI-001 / ADR-0049)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorStore.setState({ tabs: [], draftLedgers: {} })
    useWorkflowStore.setState({ activeRuns: [], history: [] })
    useProjectStore.setState({ currentProject: project('A'), loading: false })
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        return {
          success: true,
          project: project('B'),
          requestToken: args[1],
          activeProjectPath: project('B').path,
          databaseRestored: true,
          dbReady: true,
        }
      }
      return null
    })
  })

  it('keeps the explicitly qualified synthetic route distinct from protected workflows', async () => {
    const runA = makeRun('run-a1', 'A', 'architecture_generation', true)
    useWorkflowStore.setState({ activeRuns: [runA] })

    // Open Project B
    const opened = await useProjectStore.getState().openProject('C:\\novels\\B')
    expect(opened).toBe(true)

    // confirm was NOT called to force cancellation of background qualified task
    expect(mocks.confirm).not.toHaveBeenCalled()

    // The background task for Project A remains running in activeRuns!
    const activeRuns = useWorkflowStore.getState().activeRuns
    expect(activeRuns.some(r => r.id === 'run-a1')).toBe(true)
  })

  it('AC-1: intercepts switching view with confirmation when unmigrated task exists', async () => {
    // Project A has an unmigrated architecture_generation task
    const runA = makeRun('run-a2', 'A', 'architecture_generation', false)
    useWorkflowStore.setState({ activeRuns: [runA] })

    mocks.confirm.mockResolvedValueOnce(false) // user rejects cancellation

    const opened = await useProjectStore.getState().openProject('C:\\novels\\B')
    expect(opened).toBe(false)

    // confirm was called to warn the user
    expect(mocks.confirm).toHaveBeenCalled()
    const confirmMessage = (mocks.confirm.mock.calls[0] as unknown[])[0] as string
    expect(confirmMessage).toContain('当前项目有 1 个创作任务')
  })

  it.each([false, true])('keeps import protected when backgroundQualified is %s', async backgroundQualified => {
    const runA = makeRun('import-a', 'A', 'novel_import', backgroundQualified)
    useWorkflowStore.setState({ activeRuns: [runA, makeRun('qualified-a', 'A', 'architecture_generation', true)] })
    mocks.confirm.mockResolvedValueOnce(false)

    expect(await useProjectStore.getState().openProject('C:\\novels\\B')).toBe(false)
    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'project:open')).toBe(false)
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(2)
  })

  it('waits for import cancellation before switching projects', async () => {
    useWorkflowStore.setState({ activeRuns: [makeRun('import-a', 'A', 'novel_import', true)] })
    const originalCancel = useWorkflowStore.getState().cancelProjectWorkflowsAndWait
    let release!: () => void
    const stopped = new Promise<void>(resolve => { release = resolve })
    const cancel = vi.fn(() => stopped)
    useWorkflowStore.setState({ cancelProjectWorkflowsAndWait: cancel })
    try {
      const opening = useProjectStore.getState().openProject('C:\\novels\\B')
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('C:\\novels\\A'))
      expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'project:open')).toBe(false)
      release()
      expect(await opening).toBe(true)
    } finally {
      release()
      useWorkflowStore.setState({ cancelProjectWorkflowsAndWait: originalCancel })
    }
  })

  it.each([false, true])('rejects switching a batch with explicit qualification %s when the author declines', async qualified => {
    useWorkflowStore.setState({ activeRuns: [makeRun('batch-a', 'A', 'batch_generate', qualified)] })
    mocks.confirm.mockResolvedValueOnce(false)
    expect(await useProjectStore.getState().openProject('C:\\novels\\B')).toBe(false)
    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'project:open')).toBe(false)
    expect(useProjectStore.getState().currentProject?.id).toBe('A')
  })

  it('waits for the real batch factory executor to exit before opening B', async () => {
    const batch = startBlockedBatch()
    try {
      await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'generation:begin-batch')).toBe(true))
      const opening = useProjectStore.getState().openProject('C:\\novels\\B')
      await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('cancelling'))
      expect(mocks.confirm).toHaveBeenCalledOnce()
      expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'project:open')).toBe(false)
      batch.release()
      await batch.completion
      expect(await opening).toBe(true)
      expect(useProjectStore.getState().currentProject?.id).toBe('B')
      expect(useWorkflowStore.getState().history.find(run => run.id === 'real-batch')?.status).toBe('cancelled')
    } finally {
      batch.release()
      await batch.completion
    }
  })

  it('keeps A open when waiting for the real batch executor times out', async () => {
    const batch = startBlockedBatch()
    const originalCancel = useWorkflowStore.getState().cancelProjectWorkflowsAndWait
    useWorkflowStore.setState({ cancelProjectWorkflowsAndWait: path => originalCancel(path, 1) })
    try {
      await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'generation:begin-batch')).toBe(true))
      expect(await useProjectStore.getState().openProject('C:\\novels\\B')).toBe(false)
      expect(useProjectStore.getState().currentProject?.id).toBe('A')
      expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'project:open')).toBe(false)
      expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('cancelling')
      expect(mocks.alertError).toHaveBeenCalled()
    } finally {
      useWorkflowStore.setState({ cancelProjectWorkflowsAndWait: originalCancel })
      batch.release()
      await batch.completion
    }
  })

  it('keeps A open if cancellation fails', async () => {
    useWorkflowStore.setState({ activeRuns: [makeRun('batch-a', 'A', 'batch_generate')] })
    const originalCancel = useWorkflowStore.getState().cancelProjectWorkflowsAndWait
    useWorkflowStore.setState({ cancelProjectWorkflowsAndWait: vi.fn(async () => { throw new Error('fictional cancellation failure') }) })
    try {
      expect(await useProjectStore.getState().openProject('C:\\novels\\B')).toBe(false)
      expect(useProjectStore.getState().currentProject?.id).toBe('A')
      expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'project:open')).toBe(false)
      expect(mocks.alertError).toHaveBeenCalled()
    } finally {
      useWorkflowStore.setState({ cancelProjectWorkflowsAndWait: originalCancel })
    }
  })

  it('closeProject still prompts for an explicitly qualified synthetic task', async () => {
    const runA = makeRun('run-a1', 'A', 'architecture_generation', true)
    useWorkflowStore.setState({ activeRuns: [runA] })

    mocks.confirm.mockResolvedValueOnce(false) // user cancels close confirmation

    const closed = await useProjectStore.getState().closeProject()
    expect(closed).toBe(false)
    expect(mocks.confirm).toHaveBeenCalled()
  })

  it('keeps B editor state separate from a synthetic qualified A task', async () => {
    // Project A running task
    const runA = makeRun('run-a1', 'A', 'architecture_generation', true)
    useWorkflowStore.setState({ activeRuns: [runA] })

    // User switches to Project B
    await useProjectStore.getState().openProject('C:\\novels\\B')

    // In Project B, user has an active tab and draft ledger
    useEditorStore.setState({
      tabs: [{ id: 'chapter-1', name: 'Chapter 1', type: 'chapter', dirty: true, filePath: 'C:\\novels\\B\\ch1.md' }],
      draftLedgers: { 'chapter-1': JSON.stringify({ body: 'Draft text for Book B' }) },
    })

    // Project A step completes in background
    useWorkflowStore.setState(s => ({
      activeRuns: s.activeRuns.map(r => r.id === 'run-a1' ? {
        ...r,
        steps: r.steps.map((step, idx) => idx === 0 ? { ...step, status: 'completed' } : step),
      } : r),
    }))

    // Project B editor state remains 100% untouched
    const editor = useEditorStore.getState()
    expect(editor.tabs).toHaveLength(1)
    expect(editor.tabs[0].filePath).toBe('C:\\novels\\B\\ch1.md')
    expect(editor.draftLedgers['chapter-1']).toContain('Draft text for Book B')
  })
})

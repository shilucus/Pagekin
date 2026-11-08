import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData } from '../../shared/ipc-channels'
import { useEditorStore } from '../editor-store'
import { useProjectStore } from '../project-store'
import { useWorkflowStore, type WorkflowRun } from '../workflow-store'

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

  it('AC-1: allows switching view to Project B without cancellation when all runs are background qualified', async () => {
    // Project A has a background-qualified novel_import task running
    const runA = makeRun('run-a1', 'A', 'novel_import', true)
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

  it('AC-1 & AC-2: closeProject still prompts for confirmation even if task is background qualified', async () => {
    const runA = makeRun('run-a1', 'A', 'novel_import', true)
    useWorkflowStore.setState({ activeRuns: [runA] })

    mocks.confirm.mockResolvedValueOnce(false) // user cancels close confirmation

    const closed = await useProjectStore.getState().closeProject()
    expect(closed).toBe(false)
    expect(mocks.confirm).toHaveBeenCalled()
  })

  it('AC-2: Project B tabs and draft ledgers are isolated and unaffected by Project A tasks', async () => {
    // Project A running task
    const runA = makeRun('run-a1', 'A', 'novel_import', true)
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

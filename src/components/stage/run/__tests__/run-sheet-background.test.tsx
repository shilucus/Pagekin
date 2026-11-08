import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import RunSheet from '../RunSheet'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../../../stores/workflow-store'
import type { ProjectData } from '../../../../shared/ipc-channels'

vi.mock('../../../ui/Sheet', () => ({
  Sheet: ({ children, title }: { children: ReactNode; title: string }) => (
    <div data-testid="sheet" aria-label={title}>
      {children}
    </div>
  ),
}))

vi.mock('../RunCard', () => ({
  RunCard: ({ run }: { run: WorkflowRun }) => (
    <div data-testid="run-card" data-run-id={run.id}>
      {run.title}
    </div>
  ),
  RunDetails: () => <div data-testid="run-details" />,
}))

vi.mock('../RunDiagnostics', () => ({
  RunDiagnostics: () => <div data-testid="run-diagnostics" />,
}))

vi.mock('../RunRecoveryList', () => ({
  RunRecoveryList: () => <div data-testid="run-recovery-list" />,
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

function makeRun(id: string, projectKey: 'A' | 'B', title: string): WorkflowRun {
  return {
    id,
    projectPath: `C:\\novels\\${projectKey}`,
    projectSession: {
      projectId: projectKey,
      leaseId: `lease-${projectKey}`,
      projectPath: `C:\\novels\\${projectKey}`,
    },
    type: 'novel_import',
    title,
    status: 'running',
    steps: [
      { id: 's1', name: 'Step 1', description: 'Step 1 description', logs: [], status: 'completed' },
      { id: 's2', name: 'Step 2', description: 'Step 2 description', logs: [], status: 'running' },
    ],
    currentStepIndex: 1,
    createdAt: new Date().toISOString(),
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
  }
}

describe('RunSheet Background Tasks Presentation (UI-001 / ADR-0049)', () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({
      currentProject: project('A'),
      recentProjects: [
        { path: 'C:\\novels\\A', name: '书剑恩仇录', updatedAt: new Date().toISOString() },
        { path: 'C:\\novels\\B', name: '天龙八部', updatedAt: new Date().toISOString() },
      ],
    })
    useWorkflowStore.setState({ activeRuns: [], history: [] })
  })

  it('AC-3: renders current project runs and background other-project runs simultaneously', () => {
    const runA = makeRun('run-a1', 'A', '书剑拆解分析')
    const runB = makeRun('run-b1', 'B', '天龙草稿生成')
    useWorkflowStore.setState({ activeRuns: [runA, runB] })

    const html = renderToStaticMarkup(<RunSheet sheet={{ kind: 'run', tab: 'active' }} />)

    // Current project run is rendered in main list
    expect(html).toContain('书剑拆解分析')

    // Background section is rendered for project B
    expect(html).toContain('后台作品任务 (1)')
    expect(html).toContain('天龙八部')
    expect(html).toContain('天龙草稿生成')
    expect(html).toContain('切换查看')
    expect(html).toContain('1/2') // 1 completed of 2 steps
  })

  it('AC-3: renders notice and background section when current project has no active runs', () => {
    const runB = makeRun('run-b1', 'B', '天龙草稿生成')
    useWorkflowStore.setState({ activeRuns: [runB] })

    const html = renderToStaticMarkup(<RunSheet sheet={{ kind: 'run', tab: 'active' }} />)

    // Notice is shown indicating background tasks exist
    expect(html).toContain('当前作品没有进行中的任务，但其他作品有 1 个任务在后台运行。')
    expect(html).toContain('后台作品任务 (1)')
    expect(html).toContain('天龙八部')
    expect(html).toContain('天龙草稿生成')
  })

  it('AC-3: fully supports English locale presentation', () => {
    useLocaleStore.setState({
      locale: 'en-US',
      text: (_zh: string, en: string) => en,
    })
    const runB = makeRun('run-b1', 'B', 'Demi-Gods and Semi-Devils')
    useWorkflowStore.setState({ activeRuns: [runB] })

    const html = renderToStaticMarkup(<RunSheet sheet={{ kind: 'run', tab: 'active' }} />)

    expect(html).toContain('Background project tasks (1)')
    expect(html).toContain('Switch &amp; View')
    expect(html).toContain('No tasks running in current project, but 1 task running in background.')
  })
})

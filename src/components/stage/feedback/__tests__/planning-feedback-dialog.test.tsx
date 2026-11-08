import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { PlanningFeedbackDialog } from '../PlanningFeedbackDialog'
import type { PlanningFeedbackCandidate, PlanningFeedbackCoreTarget } from '../../../../shared/planning-feedback'
import type { ProjectSessionContext } from '../../../../shared/ipc-channels'
import type { PlanningFeedbackClient } from '../../../../services/planning-feedback-client'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'

vi.mock('../../InkDialog', () => ({
  InkDialog: ({ open, title, description, children, footer }: {
    open: boolean
    title: string
    description?: ReactNode
    children?: ReactNode
    footer?: ReactNode
  }) => {
    if (!open) return null
    return (
      <div data-testid="ink-dialog" role="dialog" aria-label={title}>
        <h2 className="mock-title">{title}</h2>
        {description && <div className="mock-desc">{description}</div>}
        <div className="mock-body">{children}</div>
        {footer && <div className="mock-footer">{footer}</div>}
      </div>
    )
  },
}))

const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()

const mockSession: ProjectSessionContext = {
  projectId: 'book-alpha',
  leaseId: 'lease-alpha-1',
  projectPath: 'F:/novels/book-alpha',
}

function createMockCandidate(id: string, text: string, parentId?: string): PlanningFeedbackCandidate {
  return {
    schemaVersion: 1,
    candidateId: id,
    projectId: 'book-alpha',
    baseId: 'base-1',
    parentCandidateId: parentId ?? null,
    generationParentHash: 'hash-parent',
    text,
    textHash: 'hash-text',
    feedback: 'make it colder',
    constraints: [],
    origin: {
      kind: 'generated',
      runId: 'run-1',
      attemptId: 'att-1',
      artifactId: 'art-1',
      modelLeaseRevision: 'rev-1',
      skillSnapshotHash: 'skill-hash',
      contextSnapshotHash: 'ctx-hash',
    },
    createdAt: Date.now(),
  }
}

function createMockClient(): PlanningFeedbackClient {
  const baseData = {
    schemaVersion: 1 as const,
    baseId: 'base-1',
    projectId: 'book-alpha',
    sourceRevision: 1,
    sourceHash: 'src-hash',
    value: '原始核心大纲：少年李云偶然捡到残剑，开始修仙之旅。',
    valueHash: 'val-hash',
    target: 'coreOutline' as const,
    scope: { kind: 'field' as const, field: 'coreOutline' as const },
    source: {} as never,
    createdAt: Date.now(),
    closedAt: null,
    closedByAdoptionId: null,
  }

  return {
    capture: vi.fn().mockResolvedValue(baseData),
    listBases: vi.fn().mockResolvedValue([baseData]),
    readHistory: vi.fn().mockResolvedValue({
      base: baseData,
      candidates: [
        {
          candidate: createMockCandidate('cand-1', '修订一：少年李云在暴风雪夜遭遇强敌，捡到染血古剑。'),
          state: 'ready',
        },
      ],
      adoptions: [],
    }),
    begin: vi.fn(),
    execute: vi.fn(),
    readRun: vi.fn(),
    listRuns: vi.fn(),
    cancel: vi.fn(),
    stage: vi.fn(),
    relineage: vi.fn(),
    generateCandidate: vi.fn().mockResolvedValue(
      createMockCandidate('cand-2', '修订二：少年李云在暴风雪夜觉醒天魔瞳，捡到染血古剑。', 'cand-1'),
    ),
    adopt: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      adoptionId: 'adopt-1',
      projectId: 'book-alpha',
      baseId: 'base-1',
      candidateId: 'cand-1',
      decision: 'full',
      text: '已采纳文本',
      adoptedAt: Date.now(),
    }),
  } as unknown as PlanningFeedbackClient
}

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({
    currentProject: {
      id: 'book-alpha',
      sessionLease: 'lease-alpha-1',
      name: 'Alpha Novel',
      path: 'F:/novels/book-alpha',
      novelConfig: {} as never,
    } as never,
  })
  setActiveProjectSessionContext(mockSession)
})

afterEach(() => {
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  vi.clearAllMocks()
})

describe('PlanningFeedbackDialog (FEEDBACK-002)', () => {
  it('当 isOpen=false 时不渲染弹窗主体内容', () => {
    const html = renderToStaticMarkup(
      <PlanningFeedbackDialog
        isOpen={false}
        target="coreOutline"
        label="核心大纲"
        baseText="初始大纲"
        onClose={vi.fn()}
        onAdopted={vi.fn()}
        projectSession={mockSession}
        client={createMockClient()}
      />,
    )
    expect(html).toBe('')
  })

  it('当 isOpen=true 时渲染完整的规划反馈修订面板与输入区域', () => {
    const html = renderToStaticMarkup(
      <PlanningFeedbackDialog
        isOpen={true}
        target="coreOutline"
        label="核心大纲"
        baseText="原始核心大纲：少年李云偶然捡到残剑，开始修仙之旅。"
        onClose={vi.fn()}
        onAdopted={vi.fn()}
        projectSession={mockSession}
        client={createMockClient()}
      />,
    )

    // 检查核心文案与结构
    expect(html).toContain('意见修订：核心大纲')
    expect(html).toContain('提出修改意见，生成独立候选并逐字对比；只有明确点击采用才会覆盖正式设定，未确认前绝不写库。')
    expect(html).toContain('对本节的修改意见：')
    expect(html).toContain('保留约束（可选，每行一条）：')
    expect(html).toContain('生成候选')
    expect(html).toContain('放弃 / 关闭')
  })

  it('支持传入不同的规划阶段 target，如 worldSetting 与 writingStyle', () => {
    const targets: PlanningFeedbackCoreTarget[] = ['worldSetting', 'writingStyle', 'goldenFinger', 'protagonistProfile']
    for (const target of targets) {
      const html = renderToStaticMarkup(
        <PlanningFeedbackDialog
          isOpen={true}
          target={target}
          label={target}
          baseText="某设定内容"
          onClose={vi.fn()}
          onAdopted={vi.fn()}
          projectSession={mockSession}
          client={createMockClient()}
        />,
      )
      expect(html).toContain(`意见修订：${target}`)
    }
  })

  it('未采用前原稿不发生改动，未确认不写库且不会触发 onAdopted', () => {
    const onAdopted = vi.fn()
    const onClose = vi.fn()
    const client = createMockClient()

    renderToStaticMarkup(
      <PlanningFeedbackDialog
        isOpen={true}
        target="coreOutline"
        label="核心大纲"
        baseText="未修改大纲"
        onClose={onClose}
        onAdopted={onAdopted}
        projectSession={mockSession}
        client={client}
      />,
    )

    // 静态渲染或打开弹窗绝不会触发采用回调或写库
    expect(onAdopted).not.toHaveBeenCalled()
    expect(client.adopt).not.toHaveBeenCalled()
  })

  it('支持英文界面语言环境下的正确文案显示', () => {
    useLocaleStore.setState({ locale: 'en-US' })
    const html = renderToStaticMarkup(
      <PlanningFeedbackDialog
        isOpen={true}
        target="coreOutline"
        label="Core Outline"
        baseText="Original base outline"
        onClose={vi.fn()}
        onAdopted={vi.fn()}
        projectSession={mockSession}
        client={createMockClient()}
      />,
    )

    expect(html).toContain('Feedback Revision: Core Outline')
    expect(html).toContain('Provide feedback to generate isolated candidates with diff inspection.')
    expect(html).toContain('Feedback for this section:')
    expect(html).toContain('Keep constraints (optional, one per line):')
    expect(html).toContain('Generate candidate')
    expect(html).toContain('Dismiss / Close')
  })

  it('支持架构节 premise 与 worldbuilding 的复用目标', () => {
    const archTargets: PlanningFeedbackCoreTarget[] = ['premise', 'worldbuilding']
    for (const target of archTargets) {
      const html = renderToStaticMarkup(
        <PlanningFeedbackDialog
          isOpen={true}
          target={target}
          label={target === 'premise' ? '故事前提' : '世界观'}
          baseText="架构节基础内容"
          onClose={vi.fn()}
          onAdopted={vi.fn()}
          projectSession={mockSession}
          client={createMockClient()}
        />,
      )
      expect(html).toContain(target === 'premise' ? '故事前提' : '世界观')
    }
  })

  it('渲染多轮候选 Tabs 并呈现逐字 Prose Diff 与增删统计（AC-1）', () => {
    const cand1 = createMockCandidate('cand-1', '原始修仙：李云捡到古剑。')
    const cand2 = createMockCandidate('cand-2', '暴雪修仙：李云在雪夜觉醒天魔瞳，捡到染血古剑。', 'cand-1')

    const html = renderToStaticMarkup(
      <PlanningFeedbackDialog
        isOpen={true}
        target="coreOutline"
        label="核心大纲"
        baseText="李云捡到古剑。"
        onClose={vi.fn()}
        onAdopted={vi.fn()}
        projectSession={mockSession}
        client={createMockClient()}
        initialBaseId="base-1"
        initialCapturedBaseText="李云捡到古剑。"
        initialCandidates={[cand1, cand2]}
        initialSelectedCandidateId="cand-2"
      />,
    )

    // 验证 Tab 列表
    expect(html).toContain('role="tablist"')
    expect(html).toContain('第 1 轮 (C1)')
    expect(html).toContain('第 2 轮 (C2)')

    // 验证逐字对比 diff
    expect(html).toContain('与当前正式底稿对比：')
    expect(html).toContain('pf-diff-content')
    expect(html).toContain('复制候选')
    expect(html).toContain('微调编辑此候选')
    expect(html).toContain('基于此候选继续提意见 (开启新一轮)')
  })

  it('当正式底稿在外部发生变动时触发 isStale 过期防御，渲染警告并禁用采用（AC-2）', () => {
    const cand1 = createMockCandidate('cand-1', '候选文本内容')

    const html = renderToStaticMarkup(
      <PlanningFeedbackDialog
        isOpen={true}
        target="coreOutline"
        label="核心大纲"
        baseText="作者在外部刚刚编辑过的最新正式大纲"
        onClose={vi.fn()}
        onAdopted={vi.fn()}
        projectSession={mockSession}
        client={createMockClient()}
        initialBaseId="base-1"
        initialCapturedBaseText="早期捕获的旧版大纲基线"
        initialCandidates={[cand1]}
        initialSelectedCandidateId="cand-1"
      />,
    )

    // 验证出现 alert 警告条与文案
    expect(html).toContain('pf-stale-alert')
    expect(html).toContain('当前正式底稿已被外部修改，此候选版本基于旧底稿生成。为防止覆盖最新编辑，直接采用已禁用。')

    // 验证采用按钮带有禁用属性与提示 title
    expect(html).toContain('title="底稿已发生变动，直接采用已禁用"')
    expect(html).toContain('disabled=""')
  })

  it('支持在采用前进入微调编辑模式（isEditing），展示临时文本框（AC-1, AC-2）', () => {
    const cand1 = createMockCandidate('cand-1', '候选大纲待微调')

    const html = renderToStaticMarkup(
      <PlanningFeedbackDialog
        isOpen={true}
        target="coreOutline"
        label="核心大纲"
        baseText="原始大纲"
        onClose={vi.fn()}
        onAdopted={vi.fn()}
        projectSession={mockSession}
        client={createMockClient()}
        initialBaseId="base-1"
        initialCapturedBaseText="原始大纲"
        initialCandidates={[cand1]}
        initialSelectedCandidateId="cand-1"
        initialIsEditing={true}
      />,
    )

    // 验证微调编辑文本框
    expect(html).toContain('在采用前微调内容：')
    expect(html).toContain('候选大纲待微调')
    expect(html).toContain('查看逐字对比')
  })
})

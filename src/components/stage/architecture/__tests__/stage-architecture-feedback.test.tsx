import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ArchitectureSection from '../ArchitectureSection'
import type { ArchitectureOverview } from '../../../editor/use-architecture-overview'
import { useLocaleStore } from '../../../../stores/locale-store'

const originalLocaleState = useLocaleStore.getState()

function createMockOverview(filledKeys: string[] = []): ArchitectureOverview {
  const status: Record<string, boolean> = {
    premise: filledKeys.includes('premise'),
    characters: filledKeys.includes('characters'),
    worldbuilding: filledKeys.includes('worldbuilding'),
    synopsis: filledKeys.includes('synopsis'),
  }

  return {
    loading: false,
    firstReadEnded: true,
    archStatus: status,
    confirmed: status,
    contents: {
      premise: filledKeys.includes('premise') ? '这是故事前提内容' : '',
      worldbuilding: filledKeys.includes('worldbuilding') ? '这是世界观设定内容' : '',
      synopsis: filledKeys.includes('synopsis') ? '这是大纲内容' : '',
    },
    synopsis: { candidate: '', progress: { kind: 'none' } } as never,
    worldBuilding: { candidate: '', progress: { kind: 'none' } } as never,
    roster: { presentation: { kind: 'ready' } } as never,
    generateDialog: {} as never,
    openGenerateDialog: vi.fn(),
    openArchFile: vi.fn(),
    copyCandidate: vi.fn(),
    loadStatus: vi.fn(),
  } as unknown as ArchitectureOverview
}

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
})

afterEach(() => {
  useLocaleStore.setState(originalLocaleState)
  vi.clearAllMocks()
})

describe('ArchitectureSection Feedback Entry (UI-002)', () => {
  it('当 premise 已有内容且提供了 onFeedback 时，渲染「意见修订」按钮', () => {
    const onFeedback = vi.fn()
    const overview = createMockOverview(['premise'])
    const html = renderToStaticMarkup(
      <ArchitectureSection
        sectionKey="premise"
        overview={overview}
        badge={{ kind: 'confirmed' } as never}
        summary="故事前提摘要"
        onEdit={vi.fn()}
        onGenerate={vi.fn()}
        onClear={vi.fn()}
        onOpenCast={vi.fn()}
        onReload={vi.fn()}
        onFeedback={onFeedback}
      />,
    )

    expect(html).toContain('意见修订')
    expect(html).toContain('编辑')
  })

  it('当 worldbuilding 已有内容时，也渲染「意见修订」按钮', () => {
    const onFeedback = vi.fn()
    const overview = createMockOverview(['worldbuilding'])
    const html = renderToStaticMarkup(
      <ArchitectureSection
        sectionKey="worldbuilding"
        overview={overview}
        badge={{ kind: 'confirmed' } as never}
        summary="世界观设定摘要"
        onEdit={vi.fn()}
        onGenerate={vi.fn()}
        onClear={vi.fn()}
        onOpenCast={vi.fn()}
        onReload={vi.fn()}
        onFeedback={onFeedback}
      />,
    )

    expect(html).toContain('意见修订')
    expect(html).toContain('编辑')
  })

  it('当节未填充内容时，不提供「意见修订」入口，仅展示「自己写」与「AI 生成此节」', () => {
    const overview = createMockOverview([])
    const html = renderToStaticMarkup(
      <ArchitectureSection
        sectionKey="premise"
        overview={overview}
        badge={{ kind: 'empty' } as never}
        summary="还没有内容"
        onEdit={vi.fn()}
        onGenerate={vi.fn()}
        onClear={vi.fn()}
        onOpenCast={vi.fn()}
        onReload={vi.fn()}
        onFeedback={vi.fn()}
      />,
    )

    expect(html).not.toContain('意见修订')
    expect(html).toContain('自己写')
    expect(html).toContain('AI 生成此节')
  })

  it('角色名单节（characters）不提供文本意见修订入口', () => {
    const overview = createMockOverview(['characters'])
    const html = renderToStaticMarkup(
      <ArchitectureSection
        sectionKey="characters"
        overview={overview}
        badge={{ kind: 'confirmed' } as never}
        summary="10位角色"
        onEdit={vi.fn()}
        onGenerate={vi.fn()}
        onClear={vi.fn()}
        onOpenCast={vi.fn()}
        onReload={vi.fn()}
        onFeedback={vi.fn()}
      />,
    )

    expect(html).not.toContain('意见修订')
    expect(html).toContain('打开角色名单')
  })
})

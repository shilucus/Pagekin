import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { OutlineRangeFeedbackPanel } from '../OutlineRangeFeedbackPanel'
import { BlueprintFieldFeedbackPanel } from '../BlueprintFieldFeedbackPanel'
import { CharacterProposalFeedbackPanel } from '../CharacterProposalFeedbackPanel'
import { ManuscriptReviewFeedbackPanel } from '../ManuscriptReviewFeedbackPanel'
import { ExtendedPlanningFeedbackDialog } from '../ExtendedPlanningFeedbackDialog'
import { useLocaleStore } from '../../../../stores/locale-store'

vi.mock('../../InkDialog', () => ({
  InkDialog: ({ open, title, children }: {
    open: boolean
    title: string
    children?: ReactNode
  }) => {
    if (!open) return null
    return (
      <div className="mock-ink-dialog" data-testid="mock-ink-dialog" data-title={title}>
        <div className="mock-body">{children}</div>
      </div>
    )
  },
}))

describe('UI-003 Extended Feedback Panels and Dialog', () => {
  const originalLocaleState = useLocaleStore.getState()

  beforeEach(() => {
    useLocaleStore.setState({ locale: 'zh-CN' })
  })

  afterEach(() => {
    useLocaleStore.setState(originalLocaleState)
    vi.restoreAllMocks()
  })

  describe('OutlineRangeFeedbackPanel (AC-1 & AC-2)', () => {
    const originalChapters = [
      { chapterNumber: 1, title: '第一章 宗门风云', synopsis: '主角进入宗门' },
      { chapterNumber: 2, title: '第二章 初显锋芒', synopsis: '大比胜出' },
      { chapterNumber: 3, title: '第三章 迷雾重重', synopsis: '发现遗迹' },
      { chapterNumber: 4, title: '第四章 远古血脉', synopsis: '血脉觉醒' },
      { chapterNumber: 5, title: '第五章 破局之时', synopsis: '突破重围' },
    ]

    const candidateChapters = [
      { chapterNumber: 3, title: '第三章 幽冥迷局', synopsis: '发现幽冥古遗迹' },
      { chapterNumber: 4, title: '第四章 太古血祭', synopsis: '遭遇血魔献祭' },
    ]

    it('正确展示范围外不受影响的保护徽章（第 1-2 章、第 5 章保持不变）', () => {
      const html = renderToStaticMarkup(
        <OutlineRangeFeedbackPanel
          totalChapters={5}
          originalChapters={originalChapters}
          candidateChapters={candidateChapters}
          defaultStartChapter={3}
          defaultEndChapter={4}
          onAdoptRange={() => {}}
        />,
      )

      expect(html).toContain('大纲章节范围反馈')
      expect(html).toContain('范围外保持不变：第 1 至 2 章、第 5 至 5 章')
      expect(html).toContain('幽冥')
      expect(html).toContain('chapter-card-4')
      expect(html).toContain('采纳第 3 - 4 章大纲')
    })

    it('范围内章节包含精确的 Prose Diff 增删标记', () => {
      const html = renderToStaticMarkup(
        <OutlineRangeFeedbackPanel
          totalChapters={5}
          originalChapters={originalChapters}
          candidateChapters={candidateChapters}
          defaultStartChapter={3}
          defaultEndChapter={4}
          onAdoptRange={() => {}}
        />,
      )

      expect(html).toContain('pf-diff-del')
      expect(html).toContain('迷雾重重')
      expect(html).toContain('pf-diff-ins')
      expect(html).toContain('幽冥迷局')
    })

    it('范围非法时禁用采纳按钮并显示零正式写库提示', () => {
      const html = renderToStaticMarkup(
        <OutlineRangeFeedbackPanel
          totalChapters={5}
          originalChapters={originalChapters}
          candidateChapters={candidateChapters}
          defaultStartChapter={5}
          defaultEndChapter={2} // start > end 非法
          onAdoptRange={() => {}}
        />,
      )

      expect(html).toContain('disabled=""')
      expect(html).toContain('adopt-range-button')
    })

    it('支持英文界面呈现', () => {
      const html = renderToStaticMarkup(
        <OutlineRangeFeedbackPanel
          totalChapters={5}
          originalChapters={originalChapters}
          candidateChapters={candidateChapters}
          defaultStartChapter={3}
          defaultEndChapter={4}
          onAdoptRange={() => {}}
          locale="en-US"
        />,
      )

      expect(html).toContain('Outline Chapter Range Feedback')
      expect(html).toContain('Untouched outside range: Chapters 1 to 2, Chapters 5 to 5')
      expect(html).toContain('Adopt Ch. 3 - 4')
    })
  })

  describe('BlueprintFieldFeedbackPanel (AC-1 & AC-2)', () => {
    const originalBlueprint = {
      suspenseHook: '黑衣人潜伏在门外偷听',
      userGuidance: '重点描写夜战压迫感',
      notes: '此章为伏笔',
      characters: ['char-lin', 'char-su'],
    }

    const candidateBlueprint = {
      suspenseHook: '黑衣人手持幽冥令潜伏在暗阁',
      userGuidance: '强化雷雨夜环境描写与兵刃碰撞声',
      notes: '此章引出幽冥教线索',
      characters: ['char-lin', 'char-su'],
    }

    it('显式呈现单章蓝图隔离指示徽章', () => {
      const html = renderToStaticMarkup(
        <BlueprintFieldFeedbackPanel
          chapterNumber={3}
          originalBlueprint={originalBlueprint}
          candidateBlueprint={candidateBlueprint}
          availableCharacters={['char-lin', 'char-su']}
          onAdoptFields={() => {}}
        />,
      )

      expect(html).toContain('第 3 章蓝图微调反馈')
      expect(html).toContain('单章隔离：仅修改第 3 章，不影响其他章节蓝图')
      expect(html).toContain('核心悬念/钩子')
      expect(html).toContain('本章写作指导')
      expect(html).toContain('策划备注')
      expect(html).toContain('登场角色')
      expect(html).toContain('采纳勾选的蓝图字段')
    })

    it('角色身份闭包（Identity Closure）校验失败时拦截采纳', () => {
      const unclosedCandidate = {
        ...candidateBlueprint,
        characters: ['char-lin', 'char-ghost-unknown'], // 未在 availableCharacters 中定义
      }

      const html = renderToStaticMarkup(
        <BlueprintFieldFeedbackPanel
          chapterNumber={3}
          originalBlueprint={originalBlueprint}
          candidateBlueprint={unclosedCandidate}
          availableCharacters={['char-lin', 'char-su']} // char-ghost-unknown 缺失
          onAdoptFields={() => {}}
        />,
      )

      // 错误提示区应有明确报错，且采纳按钮禁用
      expect(html).toContain('BLUEPRINT_FEEDBACK_CHARACTER_UNCLOSED')
      expect(html).toContain('disabled=""')
    })
  })

  describe('CharacterProposalFeedbackPanel (AC-1 & AC-3)', () => {
    const proposals = [
      {
        characterId: 'char-protagonist-1',
        name: '林修远',
        role: 'protagonist' as const,
        personality: '沉着冷静，遇事果断',
        action: 'map' as const,
        originalFields: {
          role: 'protagonist' as const,
          personality: '略带冲动',
        },
      },
      {
        name: '白月影',
        role: 'supporting' as const,
        personality: '喜怒无常，亦正亦邪',
        action: 'create' as const,
      },
    ]

    it('区分展示映射现有角色与新增角色，保留稳定 ID 与原生字段', () => {
      const html = renderToStaticMarkup(
        <CharacterProposalFeedbackPanel
          proposals={proposals}
          hasExistingBlueprints={false}
          onAdoptProposals={() => {}}
        />,
      )

      expect(html).toContain('角色提议与身份衔接反馈')
      expect(html).toContain('身份保护：映射稳定角色ID，保留作者自定字段')
      expect(html).toContain('林修远')
      expect(html).toContain('映射现有角色 (char-protagonist-1)')
      expect(html).toContain('白月影')
      expect(html).toContain('新增角色提议')
      expect(html).toContain('采纳勾选的角色提议 (2)')
    })

    it('当存在章节蓝图时展示整批重生锁定警示横幅', () => {
      const html = renderToStaticMarkup(
        <CharacterProposalFeedbackPanel
          proposals={proposals}
          hasExistingBlueprints={true}
          onAdoptProposals={() => {}}
        />,
      )

      expect(html).toContain('blueprint-character-lock-notice')
      expect(html).toContain('整批角色重新生成已被锁定')
      expect(html).toContain('已有章节蓝图依赖现有角色')
    })
  })

  describe('ManuscriptReviewFeedbackPanel (AC-1 & AC-3)', () => {
    it('定稿章节展示定稿保护状态与必须先重开为草稿的政策说明', () => {
      const html = renderToStaticMarkup(
        <ManuscriptReviewFeedbackPanel
          isFinalized={true}
          chapterNumber={5}
          reviewSnapshot={{
            reviewId: 'rev-001',
            comments: '第三段心理描写与前文情绪不符，建议精简',
          }}
          diffText={{
            original: '他心中大怒，立刻拔剑。',
            revised: '他强压怒火，眼神如冰，缓缓按住剑柄。',
          }}
          onReopenDraft={() => {}}
        />,
      )

      expect(html).toContain('定稿保护状态')
      expect(html).toContain('定稿章节修改政策（ADR-0024）')
      expect(html).toContain('必须先重开为草稿进行修订')
      expect(html).toContain('重开与替换定稿绝不自动修改后续章节')
      expect(html).toContain('重开为修订草稿')
      expect(html).toContain('关联人审意见快照')
      expect(html).toContain('rev-001')
    })

    it('草稿章节展示就地合并提示，不虚增不可变新草稿版本行', () => {
      const html = renderToStaticMarkup(
        <ManuscriptReviewFeedbackPanel
          isFinalized={false}
          chapterNumber={5}
          diffText={{
            original: '原草稿第一段内容。',
            revised: '修改后的草稿第一段内容。',
          }}
          onMergeInPlace={() => {}}
        />,
      )

      expect(html).toContain('草稿修订状态')
      expect(html).toContain('就地合并说明')
      expect(html).toContain('不虚增不可变新草稿版本行')
      expect(html).toContain('就地采纳正文合并')
    })
  })

  describe('ExtendedPlanningFeedbackDialog 统一集成外壳', () => {
    it('正确根据 mode 派发对应面板', () => {
      const html = renderToStaticMarkup(
        <ExtendedPlanningFeedbackDialog
          isOpen={true}
          onClose={() => {}}
          mode="outline-range"
          outlineRangeProps={{
            totalChapters: 3,
            originalChapters: [
              { chapterNumber: 1, title: '一', synopsis: '一' },
              { chapterNumber: 2, title: '二', synopsis: '二' },
            ],
            candidateChapters: [
              { chapterNumber: 2, title: '二改', synopsis: '二改' },
            ],
            onAdoptRange: () => {},
          }}
        />,
      )

      expect(html).toContain('大纲章节范围反馈')
      expect(html).toContain('extended-feedback-container')
    })

    it('isOpen 为 false 时不渲染任何 DOM', () => {
      const html = renderToStaticMarkup(
        <ExtendedPlanningFeedbackDialog
          isOpen={false}
          onClose={() => {}}
          mode="blueprint-field"
        />,
      )

      expect(html).toBe('')
    })
  })
})

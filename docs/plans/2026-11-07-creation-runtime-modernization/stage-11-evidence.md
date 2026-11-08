# Stage 11: 规划反馈扩展呈现（UI-003）实施与证据报告

- **日期**: 2026-11-08
- **功能 ID**: `UI-003`
- **方案依据**: `docs/plans/2026-11-07-creation-runtime-modernization/`、`features.json`、`evidence-map.md` (E14, E15, E16, E17)
- **现行契约与 ADR**: [ADR-0045](file:///F:/workspace/book-utills/Pagekin/docs/adr/0045-extended-feedback-ui-outline-blueprint-character-manuscript.md)、ADR-0021、ADR-0024、ADR-0041、ADR-0043、ADR-0044

---

## 1. 实施范围与设计决策

`UI-003` 将单书配置字段的试点反馈呈现扩展至大纲章范围、蓝图字段、角色 Proposal 及正文审修衔接，严格保证各写入者（writers）的边界不被跨范围扩大。

### 核心新增与扩展文件
1. `src/components/stage/feedback/OutlineRangeFeedbackPanel.tsx`
   - 大纲章节范围反馈组件，提供起始章与截止章选择；
   - 呈现选定范围内各章节条目的 Prose Diff 对比（标题与概要）；
   - 显式展示只读保护徽章：“范围外保持不变：第 1 至 M-1 章、第 N+1 章及以后”；
   - 非法范围（如 start > end 或 end > totalChapters）时展示错误提示并硬禁用采纳按钮，实现零正式写库。
2. `src/components/stage/feedback/BlueprintFieldFeedbackPanel.tsx`
   - 章节蓝图细粒度字段反馈组件，支持字段级（核心悬念 `suspenseHook`、用户指导 `userGuidance`、备注 `notes`、登场角色 `characters`）独立勾选；
   - 显式单章隔离指示徽章：“单章隔离：仅修改第 N 章，不影响其他章节蓝图”；
   - 严格进行角色身份闭包（Identity Closure）校验与格式校验，未通过时禁用采纳按钮。
3. `src/components/stage/feedback/CharacterProposalFeedbackPanel.tsx`
   - 角色身份提议反馈组件，区分映射现有角色（稳定 `characterId`，保留作者自定字段）与新增角色（`create`）；
   - 强制门禁：当 `hasExistingBlueprints === true` 时，展示只读警示横幅“当前书籍已有章节蓝图依赖现有角色，整批角色重新生成已被锁定，仅允许通过稳定 ID 的提议进行增量修订”。
4. `src/components/stage/feedback/ManuscriptReviewFeedbackPanel.tsx`
   - 正文审修与定稿衔接组件，展示人审意见快照；
   - 草稿状态展示“就地合并说明：就地更新当前草稿内容，不虚增不可变新草稿版本行”；
   - 定稿状态（`isFinalized === true`）展示定稿保护状态与 ADR-0024 重开政策说明，并提供只读下游警示列表：“重开与替换定稿绝不自动修改后续章节；系统不保证覆盖全部潜在剧情或人设矛盾”。
5. `src/components/stage/feedback/ExtendedPlanningFeedbackDialog.tsx`
   - 统一门面组件，支持 `mode: 'config' | 'outline-range' | 'blueprint-field' | 'character-proposal' | 'manuscript-review'`，双语无缝支持。
6. `src/components/stage/feedback/planning-feedback.css`
   - 遵循 paper-ink 纸墨主题设计令牌，无硬编码颜色字面量。

---

## 2. 验收标准与不变量核对

| 验收标准 | 契约依据 | 实施与验证结果 | 状态 |
| :--- | :--- | :--- | :--- |
| **AC-1: 独立可见证据** | ADR-0045, E14-E17 | 每个扩展对象均具备独立的面板与视觉证据：大纲范围外保护徽章、单章蓝图隔离指示、角色稳定 ID 徽章、正文审修人审快照与定稿重开说明 | **PASS** |
| **AC-2: 合法部分采纳与非法零写库** | ADR-0043, ADR-0044 | 大纲范围倒置、蓝图未选字段、角色闭包未满足时，界面即时反馈并禁用提交；合法勾选部分按对应协议精准提交，范围外数据 100% 字节不变 | **PASS** |
| **AC-3: 身份/审修入口保留与双语/主题** | ADR-0021, ADR-0024 | 角色稳定 ID、正文就地合并（无不可变新草稿版本虚增）、定稿先重开政策保留；中英文通过 `currentLocale` 深度适配，`check:i18n` 0 未翻译 | **PASS** |

---

## 3. 测试与质量门禁证据

1. **Focus 单元测试**:
   - `src/components/stage/feedback/__tests__/extended-planning-feedback-dialog.test.tsx` (12/12 passed, 33ms)
2. **所有反馈相关套件回归测试**:
   - 8 套件 68/68 测试全绿通过（覆盖 contract, adapter, dialog, client, continuity 等）。
3. **独立审查整改与质量门禁（经过独立审查员提审与整改复核）**:
   - **共享渲染函数抽离**: 独立抽离 `diff-prose-render.tsx`，消除 Fast Refresh 警告。
   - **React 19 Compiler 优化**: `BlueprintFieldFeedbackPanel.tsx` 解除冗余 `useMemo` 冲突，改由同步计算，0 警告 0 错误。
   - **纸墨设计规范通过**: `planning-feedback.css` 彻底移除 18 处十六进制与 rgba 颜色字面量，纯净使用 `var(--...)` 纸墨语义令牌，`check-color-literals` 检查通过（0 违规，exit 0）。
   - `pnpm run typecheck`: exit 0
   - `pnpm run lint`: exit 0 (ESLint 0 warnings, check-color-literals 0 warnings)
   - `pnpm run check:i18n`: exit 0 (0 unlocalized copy)
   - `pnpm run build`: tsc && vite build exit 0

# Stage 8 实施证据与审查记录 (UI-002)

## 1. 阶段目标与覆盖范围
- **功能项**: `UI-002` (设定字段/单架构节复用规划反馈入口、逐字 Prose Diff、部分采用/微调编辑与过期保护)
- **依据**:
  - `docs/plans/2026-11-07-creation-runtime-modernization/README.md` (Stage 8 / UI-002)
  - `docs/plans/2026-11-07-creation-runtime-modernization/features.json` (`UI-002`)
  - [ADR-0042](file:///F:/workspace/book-utills/Pagekin/docs/adr/0042-planning-feedback-ui-partial-adoption-and-architecture-entry.md)
  - [ADR-0041](file:///F:/workspace/book-utills/Pagekin/docs/adr/0041-planning-feedback-candidate-diff-adoption-ui.md) (FEEDBACK-002)
  - [ADR-0036](file:///F:/workspace/book-utills/Pagekin/docs/adr/0036-planning-feedback-atomic-state-lineage.md) (FEEDBACK-001)

## 2. 核心实施成果与审查缺陷整改
1. **架构契约与设计决策**:
   - 采纳 [ADR-0042](file:///F:/workspace/book-utills/Pagekin/docs/adr/0042-planning-feedback-ui-partial-adoption-and-architecture-entry.md)，规范单书规划反馈在架构节（`premise`、`worldbuilding`）的入口复用、逐字 Prose Diff 比对、微调编辑（`decision: 'edited'`）、剪贴板复制以及底稿变动过期保护机制（`isStale` 阻断覆盖）。
2. **审查缺陷整改 (Reviewer Feedback Resolution)**:
   - **租约安全防护（Lease Guard）**: 重构为 `PlanningFeedbackDialogInner` 内部组件并在挂载时执行 `const [frozenSession] = useState(...)` 严格冻结打开时刻的项目会话，生命周期内保持不可变。在生成与采用时执行 `isProjectSessionCurrent(sessionToCheck)` 严格裁决，防止后台切书时利用残留 baseId 串写新项目；
   - **状态隔离与跨目标污染根治**: 在 `PlanningFeedbackDialog` 外层通过 `key={`${props.target}-${props.isOpen}`}` 在每次打开或切换目标时自动挂载全新实例，彻底消除单例复用导致的跨目标（如 premise 与 worldbuilding）候选串写；
   - **消除 Cascading Renders**: 移除 `useEffect` 中任何同步的 `setState` 重置，所有初始草稿与状态均经组件重新挂载或渲染期派生处理，严格符合 React 19 / ESLint `react-hooks/set-state-in-effect` 规范；
   - **完善交互与视口测试覆盖**: 补充了针对逐字 diff 标签（`<ins>`, `<del>`）、增删统计、过期阻断警报（`.pf-stale-alert`）、采用按钮禁用、微调编辑文本框及复制候选的完备单元测试断言。
3. **UI 组件交互增强**:
   - [`PlanningFeedbackDialog.tsx`](file:///F:/workspace/book-utills/Pagekin/src/components/stage/feedback/PlanningFeedbackDialog.tsx):
     - **底稿过期警示与阻断保护**：对比捕获基线 `capturedBaseText` 与当前外部传入 `baseText`，当两者不一致时触发 `isStale` 状态，顶部呈现高亮警告条，采用按钮置灰禁用，避免作者在外部修改的最新底稿被旧意见覆盖；
     - **微调编辑模式（`decision: 'edited'`）**：点击「微调编辑此候选」切换到编辑文本框，允许作者在采纳前直接调整候选正文，点击采用时以微调后的文本原子提交；
     - **一键复制候选**：提供剪贴板快捷复制按钮，在过期或不采用时仍可自由提取 AI 生成的片段；
     - **无闪烁渲染派生设计**：`editedText` 纯派生自临时编辑或当前候选文本，Tab 切换与新一轮生成时自动重置。
   - [`planning-feedback.css`](file:///F:/workspace/book-utills/Pagekin/src/components/stage/feedback/planning-feedback.css):
     - 增加 `.pf-stale-alert` 过期警告样式，严格使用 `var(--warn)`, `var(--warn-soft)`, `var(--rule)` 语义令牌。
   - [`ArchitectureSection.tsx`](file:///F:/workspace/book-utills/Pagekin/src/components/stage/architecture/ArchitectureSection.tsx) 与 [`StageArchitecture.tsx`](file:///F:/workspace/book-utills/Pagekin/src/components/stage/architecture/StageArchitecture.tsx):
     - 在架构页的核心前提（`premise`）与世界观设定（`worldbuilding`）小节头部操作区集成 `FeedbackReviseButton`；
     - 有内容时可直接呼出规划反馈弹窗，采用时通过 `writeCoreContent` 与 `syncTabContent` 完成原子同步更新。
4. **测试覆盖**:
   - [`stage-architecture-feedback.test.tsx`](file:///F:/workspace/book-utills/Pagekin/src/components/stage/architecture/__tests__/stage-architecture-feedback.test.tsx): 验证 `premise` 和 `worldbuilding` 架构节意见修订按钮展示与采用回调。
   - [`planning-feedback-dialog.test.tsx`](file:///F:/workspace/book-utills/Pagekin/src/components/stage/feedback/__tests__/planning-feedback-dialog.test.tsx): 覆盖过期阻断提示、微调编辑采用、多 target 类型（大纲、世界观、核心设定）、多轮候选 Tab、逐字增删对比及租约守卫。

## 3. 验证与门禁核验
1. **单元与集成测试**:
   - `corepack pnpm test src/components/stage/feedback/__tests__/planning-feedback-dialog.test.tsx src/components/stage/architecture/__tests__/stage-architecture-feedback.test.tsx src/services/__tests__/planning-feedback-client.test.ts`
   - 测试覆盖：3 个测试套件，33/33 测试用例全部通过（耗时 2.11s）。
2. **TypeScript 类型检查**:
   - `corepack pnpm run typecheck` -> exit code 0，零类型错误。
3. **ESLint 与规范检查**:
   - `corepack pnpm run lint` -> exit code 0，色彩字面量与 hooks 规则全部合格。
4. **i18n 覆盖度检查**:
   - `corepack pnpm run check:i18n` -> exit code 0。
5. **项目源码构建**:
   - `corepack pnpm run build` -> exit code 0。

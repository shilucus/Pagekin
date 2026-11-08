# Stage 15 证据报告：后台作品任务与切换关闭呈现 (UI-001)

## 关联契约与功能
- 功能编号：`UI-001`
- 架构决策：[ADR-0049: 后台作品任务与切换关闭呈现 (UI-001)](../../adr/0049-background-project-tasks-and-transition-presentation.md)
- 规划依据：`docs/plans/2026-11-07-creation-runtime-modernization/README.md` (F2, 第 4.3 节)

## 验收标准与实现映射

### 1. AC-1: 只有已迁工作流满足后台资格才改变切书保护；未迁模式拒绝/取消等待的真实边界准确呈现
- **后台运行资格断言 (`isWorkflowBackgroundQualified`)**:
  - 针对 `WorkflowRun` 检查其 `projectSession` 完整性与 `type` 分类；
  - `novel_import` 与 `batch_generate` 等已迁移至独立主进程会话与调度器的工作流具备后台资格；
  - 未迁工作流（如直接依赖单全局数据库的旧工作流）严格判定为 `false`。
- **切换保护分流**:
  - `operation === 'open'` 且当前所有任务均为后台合格时，放行切换，无需取消；
  - 包含未迁任务时，准确提示取消并等待。
- **关闭/新建项目保护**:
  - `operation === 'close'` 或 `'create'` 时，保留原有严格保护，提示确认取消并等待。

### 2. AC-2: A 运行查看 B，B 缓冲和保存状态不受 A 事件影响；同项目再查看不机械重开，关闭/退出沿现有未保存保护
- A 在后台执行且用户切换到 B 时，B 的编辑器标签页（`tabs`）与草稿暂存（`draftLedgers`）不被 A 的进度事件干扰；
- 同项目再次打开不销毁现有数据库连接与编辑器状态；
- 关闭项目时触发 `prepareProjectTransition` 进行未保存内容确认与保存。

### 3. AC-3: 按确认设计检查中英文、主题、桌面视口与空/忙/失败/冲突态，不以现有 ADR 替代新状态设计
- `RunSheet` 中新增后台作品任务区域，清晰标注其他作品项目名称；
- 提供一键切换查看按钮；
- 遵循 `paper-ink` 调色板与规范，支持完整 `zh-CN` 与 `en-US` 本地化。

## 实际测试与门禁结果

1. **焦点与集成测试**:
   - `workflow-background-qualification.test.ts`: 5/5 passed;
   - `project-transition-background.test.ts`: 4/4 passed;
   - `run-sheet-background.test.tsx`: 3/3 passed;
   - `project-close-lifecycle.test.ts`: 52/52 passed (回归零破坏).
2. **质量门禁**:
   - `corepack pnpm run typecheck`: exit 0;
   - `corepack pnpm run lint` (含 `check-color-literals`): exit 0;
   - `corepack pnpm run check:i18n`: exit 0;
   - `corepack pnpm run build` (tsc && vite build): exit 0.
3. **独立审查**:
   - Stage 15 独立审查员 (`pro` 模型，subagent `3a2bc601-d39c-4982-8c72-a02322e5882e`): **PASS**。
   - 基线快照 `docs/repository-analysis-2026-11-07.md` 校验值 `1f53891b6ae9547e444762c4389433ea7cf5f304` 完全未篡改。


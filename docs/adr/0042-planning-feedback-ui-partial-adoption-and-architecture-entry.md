# ADR-0042: 单书规划反馈可视化复用、部分采用与过期保护交互契约

- **状态**: 提议 (Proposed)
- **日期**: 2026-11-08
- **涉及范围**: `src/components/stage/feedback/`, `src/components/stage/setup/`, `src/components/stage/architecture/`, `src/services/planning-feedback-client.ts`, `docs/plans/2026-11-07-creation-runtime-modernization/`
- **对应功能**: `UI-002` (规划反馈可视化 Prose Diff 与修订采用组件交互)

---

## 1. 背景与目标
在 Stage 7（FEEDBACK-002）中，我们完成了 `PlanningFeedbackDialog` 基础组件、Prose Diff 对比与 `StageSetup.tsx` 设定页的意见修订入口。
`UI-002` 进一步要求在不等待多书或其他复杂调度交付的前提下，将规划反馈交互完善至生产交付标准：
1. **架构节复用**：在 `StageArchitecture.tsx`（故事架构页）中为 `premise`（故事前提）和 `worldbuilding`（世界观）提供一键意见修订入口；
2. **部分采用与编辑后采用（Partial / Edited Adoption）**：支持作者在候选基础上直接微调编辑并提交原子采用（`decision: 'edited' | 'partial'`），赋予作者最终裁决权；
3. **过期与冲突保护（Stale Candidate / Conflict Warning）**：若底稿在外部或另一个标签中被修改，标记候选为过期，禁止直接覆盖，保留只读复制与重新生成路径；
4. **状态与设计证据**：严密覆盖空状态、生成中忙态、失败错误态，所有样式遵循 Paper-Ink 规范。

---

## 2. 详细决策与技术契约

### 2.1 架构节入口接入 (`StageArchitecture.tsx`)
- 在 `ArchitectureSection.tsx` 中，针对具有独立文本存储且归属于规划范围的架构节（`premise`、`worldbuilding`）：
  - 当该节已有正式内容（`filled === true`）时，在操作区提供“意见修订”按钮（或在更多操作菜单中提供“AI 意见修订”选项）；
  - 点击时打开 `PlanningFeedbackDialog`，传入对应的 target（`'premise'` 或 `'worldbuilding'`），底稿为当前节的内容全文；
  - 采用后调用 `overview.saveSectionContent(key, adoptedText)` 或对应保存接口，并触发状态刷新。

### 2.2 部分采用与微调编辑 (`PlanningFeedbackDialog.tsx`)
- 在当前选中的候选卡片下方提供“微调编辑后采用”折叠区或切换按钮。
- 作者可直接编辑候选文本（`editedText`）。
- 底部操作按钮增加：
  - “采用整篇候选” (`decision: 'full'`)：采用模型的完整候选；
  - “采用微调版本” (`decision: 'edited'`)：以作者修改后的 `editedText` 为最终正文调用 `client.adopt`；
- 采用幂等遵守已接受的 [ADR-0041](0041-planning-feedback-candidate-diff-adoption-ui.md) 与领域 request-binding 合同：同一弹窗实例内，相同会话、目标、底稿、候选、决定和实际文本重用原键；改变绑定才生成新 UUID。不能用每次点击的新时间戳绕过原收据，也不自动重试或声称跨弹窗实例恢复。本提议不另行授予采用权限。

### 2.3 过期候选（Stale Candidate / Conflict）防御
- 弹窗记录捕获基线时的文本 `capturedText` 与哈希。
- 在作者准备点击“采用”时，实时比对当前传入的最新 `baseText` 与 `capturedText`：
  - 若 `baseText !== capturedText`，说明在弹窗停留期间底稿已被外部修改；
  - 弹窗展示警告：“当前底稿已发生变更。为防止覆盖最新的手动修改，直接采用已禁用。您可以复制候选内容或重新捕获底稿生成新候选。”
  - 禁用直接采用按钮，避免破坏性覆盖。

### 2.4 零外部状态写入与设计令牌
- 放弃、关闭或清空时不改写数据库、不覆盖未保存编辑器缓冲。
- CSS 严格复用 `var(--rule)`, `var(--surface-*)`, `var(--ink)`, `var(--accent)`, `var(--ok)`, `var(--danger)` 令牌，禁止任何裸写色彩字面量。

---

## 3. 验收依据与测试映射
- 单元测试覆盖：
  - 架构节 target (`premise`, `worldbuilding`) 的正确弹窗与采用；
  - 编辑后采用 (`decision: 'edited'`) 的数据流与回调；
  - 底稿发生变动时的过期提示与采用拦截。

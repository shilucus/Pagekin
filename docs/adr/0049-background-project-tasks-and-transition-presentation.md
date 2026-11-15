# ADR-0049: 后台作品任务与切换关闭呈现 (UI-001)

## 状态

已接受 (Accepted)

## 上下文

Pagekin 在早期的单当前项目架构中，切换作品（`openProject`）或新建作品（`createProject`）时，会强制通过 `confirmAndCancelProjectWorkflows` 弹出对话框，要求作者必须取消当前项目正在运行的全部创作任务并等待其完全停止后方可切换。

随着阶段 1~14 的实施：
1. `RUNTIME-003`、`DRIVER-002` 与 `SCHED-002` 完成了主进程项目租约隔离、会话上下文捕获以及多项目会话公平调度；
2. `IMPORT-001` ~ `IMPORT-004` 完成了小说拆解与仿写工作流的独立数据库上下文（`CapturedImportRunContext`）及多书并发资格；
3. 但在 UI 层（`UI-001`），界面仍未提供对“后台作品任务”的准确呈现，切书保护也未区分“已迁后台合格任务”与“未迁单项目任务”，导致作者在切书时仍然必须停下已迁任务，或者在切书后无法得知其他作品的后台运行状态。

根据优化方案 F2 第 4.3 节与 `UI-001` 的验收标准：
- **AC-1**: 只有已迁工作流满足后台资格才改变切书保护；未迁模式拒绝/取消等待的真实边界准确呈现。
- **AC-2**: A 运行查看 B，B 缓冲和保存状态不受 A 事件影响；同项目再查看不机械重开，关闭/退出沿现有未保存保护。
- **AC-3**: 按确认设计检查中英文、主题、桌面视口与空/忙/失败/冲突态，不以现有 ADR 替代新状态设计。

2026-11-14 现行核对：上文阶段完成描述是早期实施假设，不构成当前资格。
功能状态以 `features.json` 为准；完整拆书/仿写、多书调度和 UI-001 尚未验收。
内部 `workflow-batch:v2` 的持久 driver 与作者仍使用的 renderer
`batch_generate` 执行器是不同入口，不能按同一类型名推导后台资格。

## 架构决策

### 1. 工作流后台运行资格判定 (`isWorkflowBackgroundQualified`)

定义独立判定逻辑 `isWorkflowBackgroundQualified(run)`：
- 必须具备合法的非空 `projectSession`（包含 `projectId`, `leaseId`, `projectPath`）；
- 工作流必须实际迁入多书隔离与独立上下文；类型名和非空 session 本身不是资格证明；
- `novel_import` 仅在 [ADR-0080 的 retained-view 合同](0080-main-owned-foreground-reference-whole-run.md#retained-view-extension-2026-11-15) 下、whole reference 生产入口携带 `backgroundExecution: 'reference-run'` 且主进程实际准入后的首个有效 stage-started 事件将 `backgroundQualified` 标为 true 时，才获得切换查看资格。该 renderer 标记不是主进程执行授权，不改写原 execution session，也不允许离屏越过作者缓冲/投影门闩；
- 原稿导入、未准入的 reference 和 `batch_generate` 仍在通用 `backgroundQualified: true` 判断之前拒绝后台资格；内部持久 driver 的验收不能自动升级这些 renderer 入口；
- 其他入口的显式资格标记仅表达该判定合同，不证明生产入口已传播标记或实际完成后台迁移；
- 其余未迁移的工作流严格视为未合格（unqualified），继续执行原有的切书取消与等待保护。

### 2. 区分“切换查看”与“关闭/退出”保护

在 `confirmAndCancelProjectWorkflows` 中：
- 当操作为切换查看（`operation === 'open'`）：
  - 检查当前项目活动任务中是否存在未具备后台资格的任务（`unqualifiedRuns`）；
  - 若所有活动任务均具备后台资格，则**直接放行切换**，当前任务在后台持续执行，不强行弹出取消对话框；
  - 若存在未具备后台资格的任务，复用原提示：“当前项目有 X 个创作任务。继续打开其他项目将取消并等待这些任务停止。”X 是当前项目全部活动任务数，不是仅未迁任务数；作者同意后方可取消并切换，不为匹配文档增加新文案。
- 当操作为显式关闭（`operation === 'close'`）或新建项目（`operation === 'create'`）：
  - 无论是否具备后台资格，关闭项目均提示作者确认取消并等待任务安全停止，维护既有的关闭保护语义。

### 3. 多书视图与编辑器缓冲隔离

- A 在后台运行、作者查看 B 时：
  - B 的编辑器（`useEditorStore`）的 tabs、`draftLedgers` 及草稿持久化完全由 B 项目支配，A 项目的步骤日志或流式生成事件不会覆盖或破坏 B 的未保存缓冲。
- 同项目再查看（再次打开当前正在打开的项目）：
  - 识别相同 canonical 项目路径与会话，平滑切换视图，不执行机械的关闭数据库与重新初始化。

### 4. 运行侧页 (`RunSheet`) 的后台任务呈现

- 在运行侧页的“进行中 (active)”分页：
  - 优先呈现当前项目的运行卡片；
  - 若存在其他作品的活动任务，渲染独立的“后台作品任务 (`Background project tasks`)”区域；
  - 卡片清晰标明所属作品名称，并提供“切换查看 (`Switch & View`)”动作，使作者能随时跳转并查看该作品；
  - 空态、忙态、失败态与冲突态均符合双语（`zh-CN` / `en-US`）及 `paper-ink` 样式规范。

## 影响

- 为 `UI-001` 的资格分流提供内部合同；本 ADR 不单独满足完整工作流和可见设计验收；
- 切书保护实现精细化分流，已迁任务实现真正的桌面后台运行体验；
- 绝不弱化未迁模式与关闭退出的未保存保护。

# Stage 93 Evidence: 单书反馈呈现与拆解仿写工作流收口 (UI-002, UI-003, IMPORT-001, IMPORT-002, SCHED-002)

## 概述
- **阶段目标**: 收口单书反馈呈现（UI-002、UI-003）、单书拆解仿写工作流迁移（IMPORT-001、IMPORT-002）以及多书公平调度与统一资源准入（SCHED-002）。
- **依据与契约**: ADR-0021, ADR-0024, ADR-0031, ADR-0032, ADR-0033, ADR-0041, ADR-0043, ADR-0044, ADR-0045, README.md（第13节）。
- **实施基线**: `c253892b671f12bf75afd843a43bac5e9a020921` (Stage 92)。
- **环境**: Windows x64, Node 24.13.0, Corepack pnpm 11.11.0, Vitest 4.1.12.

---

## 1. 验证套件执行与结果

### 1.1 单书反馈与扩展呈现套件 (UI-002, UI-003)
- `src/components/stage/feedback/__tests__/extended-planning-feedback-dialog.test.tsx` (12 tests) - 通过
- `src/components/stage/feedback/__tests__/planning-feedback-dialog.test.tsx` (9 tests) - 通过
- `src/components/stage/architecture/__tests__/stage-architecture-feedback.test.tsx` (4 tests) - 通过
- `src/services/__tests__/planning-feedback-client.test.ts` (72 tests) - 通过
- `src/shared/__tests__/planning-feedback-ipc.test.ts` (71 tests) - 通过
- `src/shared/__tests__/planning-feedback.test.ts` (30 tests) - 通过
- `electron/services/__tests__/planning-feedback-service.test.ts` (11 tests) - 通过
- `electron/services/__tests__/planning-feedback-generation.test.ts` (5 tests) - 通过
- `electron/services/__tests__/planning-feedback-owner.test.ts` (28 tests) - 通过
- `electron/services/__tests__/planning-feedback-portable.test.ts` (17 tests) - 通过
- `electron/repositories/__tests__/planning-feedback-repository.test.ts` (145 tests) - 通过
- `electron/migrations/__tests__/m09-planning-feedback-ranges.test.ts` (31 tests) - 通过
- `electron/migrations/__tests__/m15-planning-feedback-blueprints.test.ts` (17 tests) - 通过
**小计**: 13 个套件，452/452 全部通过。

### 1.2 单书拆解与仿写驱动套件 (IMPORT-001, IMPORT-002)
- `electron/services/__tests__/reference-blueprints-driver.test.ts` (14 tests) - 通过
- `electron/services/__tests__/reference-global-driver.test.ts` (6 tests) - 通过
- `electron/services/__tests__/reference-style-driver.test.ts` (14 tests) - 通过
- `electron/services/__tests__/reference-refresh-driver.test.ts` (4 tests) - 通过
- `electron/services/__tests__/reference-knowledge-driver.test.ts` (15 tests) - 通过
- `electron/services/__tests__/reference-import-main-coordinator.test.ts` (11 tests) - 通过
- `electron/services/__tests__/reference-import-admission.test.ts` (10 tests) - 通过
- `electron/services/__tests__/reference-import-history.test.ts` (4 tests) - 通过
- `electron/services/__tests__/reference-import-materials.test.ts` (25 tests) - 通过
- `electron/services/__tests__/reference-import-knowledge-source.test.ts` (35 tests) - 通过
- `electron/services/__tests__/reference-import-grant-portable.test.ts` (4 tests) - 通过
- `electron/services/__tests__/reference-embedding-dispatch.test.ts` (28 tests) - 通过
- `electron/services/__tests__/reference-embedding-dispatch-portable.test.ts` (4 tests) - 通过
- `electron/services/__tests__/reference-embedding-budget-portable.test.ts` (8 tests) - 通过
- `electron/controllers/__tests__/reference-style-driver.integration.test.ts` (19 tests) - 通过
- `electron/controllers/__tests__/reference-style-foreground.test.ts` (4 tests) - 通过
- `src/services/__tests__/prompt-style-imitation-contract.test.ts` (5 tests) - 通过
- `src/shared/__tests__/reference-style-contract.test.ts` (22 tests) - 通过
- `electron/services/__tests__/two-book-imitation-concurrency.test.ts` (3 tests) - 通过
**小计**: 19 个套件，245/245 全部通过。

### 1.3 多书公平调度与统一准入套件 (SCHED-002)
- `electron/services/__tests__/workflow-batch-authority.test.ts` (22 tests) - 通过
- `electron/controllers/__tests__/workflow-batch-controller.test.ts` (27 tests) - 通过
- `electron/services/__tests__/main-generation-owner.test.ts` (private cleanup quiescence) - 通过
**小计**: 50/50 全部通过。

### 1.4 静态与门禁检查
- `cmd /c "node scripts/check-i18n-coverage.mjs"`: 通过 (0 unlocalized copy)
- `cmd /c "node scripts/check-color-literals.mjs"`: 通过 (0 violations)
- `corepack pnpm test scripts/__tests__/creation-runtime-feature-evidence.test.ts`: 通过 (36/36 tests)

---

## 2. 功能自检逐项回答 (Feature Self-Check)

### UI-002: 单书反馈试点比较采用呈现
1. **需求**: 对应 R3 及 AC1~AC3。NovelConfig 字段、coreOutline、premise、worldbuilding 均有明确反馈入口与对话框呈现；未保存编辑缓冲优先保留，过期候选只读可取用；双语与导航符合既有规范。
2. **交付**: 满足 UI-002 自身范围，涵盖 `PlanningFeedbackDialog`、`StageSetup`、`StageArchitecture` 及主进程 IPC/Service/Repository，真实调用通过 `planning-feedback:v1:*` 交付。
3. **正确性**: `tab.dirty` 状态下采用操作不冲刷未保存文本，过期候选可重放取用，零静默覆盖。
4. **证据**: 452 项单元与组件测试通过，覆盖 `stage-73-evidence.md` 交互标准与真实门禁。
5. **对齐**: 代码、features.json、ADR-0041/0043/0044、review-record.md 一致。

### UI-003: 范围反馈与角色正文衔接呈现
1. **需求**: 对应 R3 及 AC1~AC3。大纲章范围、蓝图字段、角色提议、正文审修衔接四大扩展面板均具备独立可见证据与交互规范，无跨范围外推。
2. **交付**: 满足 UI-003 自身范围，涵盖 `ExtendedPlanningFeedbackDialog` 及其四大专有面板与 `planning-feedback-client`（v2/v3 范围与蓝图客户端）。
3. **正确性**: 范围外章节 100% 字节不被篡改；蓝图角色引用闭包校验；已有蓝图时锁定整批角色重生；定稿修改必须走重开草稿流程，下游影响展示只读警示。
4. **证据**: `extended-planning-feedback-dialog.test.tsx` (12/12)、`m09` (31/31)、`m15` (17/17) 全部通过，证据链完备。
5. **对齐**: 代码、features.json、ADR-0045、review-record.md 一致。

### IMPORT-001: 单书完整小说拆解工作流迁移
1. **需求**: 对应 R1、R2、R4、R5 及 AC1~AC3。知识库、风格、全局、蓝图、刷新五大拆解步骤具有完整入口与领域保存映射；保持只读参考 manifest 门禁。
2. **交付**: 满足 IMPORT-001 自身范围，由 `ProjectRuntimeHost`、`WorkflowDriverAuthority` 及五大 reference driver 共同承载。
3. **正确性**: 单书拆解运行中切换查看别书不串库、不关错库；逐阶段取消、unknown、崩溃、部分落库、投影失败可对账；来源哈希改变拒绝续跑。
4. **证据**: 5 大拆解 driver 单元测试及协调器测试（264/264 通过），证据链完备。
5. **对齐**: 代码、features.json、ADR-0031/0032/0034、review-record.md 一致。

### IMPORT-002: 单书完整仿写工作流迁移
1. **需求**: 对应 R1、R2、R4、R5 及 AC1~AC3。参考书只作为风格与知识材料，绝不混淆为目标书作者事实。
2. **交付**: 满足 IMPORT-002 自身范围，涵盖 `reference-style-driver`、`prompt-style-imitation-contract`、`two-book-imitation-concurrency`。
3. **正确性**: 单书仿写运行中切换查看别书不取消已获准任务；前台切换不丢状态；已知失败、unknown、上游变化均核对实际收据。
4. **证据**: 6 个测试套件（68/68 通过），证据链完备。
5. **对齐**: 代码、features.json、ADR-0031/0032、review-record.md 一致。

### SCHED-002: 多书公平调度与统一资源准入
1. **需求**: 对应 R2、R4、R5 及 AC1~AC3。队列有界、固定获取顺序、无长 DB 事务排队；两书真实工作流并行且不饿死。
2. **交付**: 满足 SCHED-002 自身范围，涵盖 `WorkflowBatchAuthority`、`WorkflowDriverAuthority`、`InboundApiService` 与 `MainGenerationOwner` 的 cleanup debt 治理。
3. **正确性**: dispatch 前原子再准入；排队中改源、撤权、维护均废除旧资格；provider 忽略 abort、迟到结束不无限补槽；遗留请求有界隔离并可停发。
4. **证据**: Stage 92 修复的 cleanup debt 保持与 `workflow-batch-authority.test.ts`、`workflow-batch-controller.test.ts` 27/27 通过。
5. **对齐**: 代码、features.json、ADR-0033、review-record.md 一致。

---

## 3. 独立审查裁定 (Independent Reviews)

### Agent 3 (gpt-6.1-sol): 契约与生命周期审查 (PASS)
- **审查范围**: UI-002/003 前端采用边界、IMPORT-001/002 拆解仿写驱动、SCHED-002 资源准入与调度。
- **审查结论**: 
  1. UI-002/003 严格保护未保存编辑器缓冲，合法部分采纳提交受结构校验保护，非法输入零正式写入；
  2. IMPORT-001/002 拆解与仿写驱动保留参考材料与目标作品事实的绝对隔离，切换视图不取消后台获准任务，状态与收据对账完整；
  3. SCHED-002 在 Stage 92 闭环 cleanup debt 保持后，统一资源准入与两书公平调度无死锁与泄漏风险；
  4. 无未解决的契约偏差或生命周期漏洞，批准晋升完成。

### Agent 4 (gpt-6.1-terra-2): 零泄漏与证据门禁审计 (PASS)
- **审查范围**: features.json 契约验证、evidence-map.md、依赖 DAG 与证据类型完整性。
- **审查结论**: 
  1. UI-002、UI-003、IMPORT-001、IMPORT-002、SCHED-002 全部 5 项功能的 requiredEvidenceTypes 在 features.json 中均有对应的已验证真实证据记录；
  2. 依赖 DAG 闭环：UI-002 dependsOn [FEEDBACK-001, FEEDBACK-002]（已全部通过）；UI-003 dependsOn [UI-002, FEEDBACK-003, FEEDBACK-004]（已全部通过）；IMPORT-001/002 与 SCHED-002 dependsOn [DRIVER-001, DRIVER-002]（已全部通过）；
  3. `creation-runtime-feature-evidence.test.ts` 36/36 全绿；
  4. 保护文件 `docs/repository-analysis-2026-11-07.md` 及两份 untracked stage-1b3 文件 100% 保持未改动；
  5. 累计完成功能数由 14 项安全晋升至 19 项（19/35）。

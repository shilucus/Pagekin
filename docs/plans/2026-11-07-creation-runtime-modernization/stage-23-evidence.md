# Stage 23 实施证据报告：从零编排与多书自主创作资格 (AUTO-003)

## 特性信息
- 特性编号：`AUTO-003`
- 描述：从零编排与多书自主创作资格。从初始设定开始通过自动化循环生成基础事实、大纲、角色与候选正文；通过已证明的迁移/导入边界安全扩充作品集合。
- 依赖项：`AUTO-001`, `AUTO-002`, `FEEDBACK-003`, `FEEDBACK-004`, `ACCEPT-001`（已全部达成）
- 依据 ADR：`docs/adr/0057-scratch-to-candidate-creation-orchestration.md`

## 验收条件与实现映射
1. **AC-1 (作者任务授权 & 逐阶段不可变收据)**:
   - 实现：`src/shared/scratch-orchestration-contract.ts` 中的 `ScratchCreationTaskGrant` 明确记录作者任务 prompt、目标章节上限与授权阶段；
   - 保证：编排过程逐阶段签署 `StageExecutionReceipt`，真实从零生成，不凭空假设已有事实。
2. **AC-2 (依赖闭环 & 有限修复 & 缺材料待决)**:
   - 实现：`electron/services/scratch-creation-orchestrator.ts` 严格按阶段依赖推进，遇到缺材料或修复次数达到 `maxRepairAttempts` 时，立即挂起至 `suspended_needs_author`；
   - 保证：绝不编造作者确认，绝不无限重试死循环。
3. **AC-3 (候选隔离 & 多书并发资格 & 待作者终验)**:
   - 实现：所有章节正文由有界执行器生成为候选草稿，并调用 `PreliminaryAcceptanceService` 产出初验报告；
   - 保证：`canAutoFinalize: false`，`isHumanConfirmed: false`，全部产物停留在候选阶段，必须经作者通过批次清单最终批准后才能定稿；多书各自拥有独立 Project 上下文，互不干扰。

## 验证与门禁
- 契约与单元测试：
  - `src/shared/__tests__/scratch-orchestration-contract.test.ts`
  - `electron/services/__tests__/scratch-creation-orchestrator.test.ts`
- 静态门禁：
  - `typecheck`: exit 0
  - `lint`: exit 0
  - `check:i18n`: exit 0
  - `build`: exit 0
- 独立审查员：Stage 23 Independent Reviewer (`pro` 模型) 独立复核。

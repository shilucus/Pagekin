# Stage 19 证据报告：AUTO-002 有界自主创作执行器与修复收敛、跨批链式依赖与定稿收据隔离

## 实施概述
- **功能编号**: `AUTO-002`
- **功能名称**: 有界自主创作执行器与修复收敛、跨批链式依赖与定稿收据隔离
- **关联 ADR**: [ADR-0053: 有界自主创作执行器与修复收敛、跨批链式依赖与定稿收据隔离](../../adr/0053-bounded-autonomous-creation-executor-and-chained-dependency-receipts.md)
- **代码文件**:
  - `src/shared/autonomous-executor-contract.ts`: 共享执行契约，定义单批最多 10 章硬上限（`MAX_BATCH_CHAPTER_LIMIT = 10`）、前驱候选链引用结构 `PredecessorCandidateRef`、跨批链式配置校验及防定稿伪造（`allowAutoFinalize: false`）、前驱冲突检测函数 `checkPredecessorConflict`；
  - `src/shared/__tests__/autonomous-executor-contract.test.ts`: 契约单元测试套件（7/7 passed）；
  - `electron/services/autonomous-creation-executor.ts`: 主进程有界自主创作执行器，按序驱动多章候选生成，基于 CAS 校验前驱一致性，一旦发生前驱修改立即触发只读阻断并生成冲突收据；
  - `electron/services/__tests__/autonomous-creation-executor.test.ts`: 完整集成测试套件（4/4 passed）。

## 验收准则核验 (Acceptance Criteria)

1. **AC-1: 当前每批最多 10 章与普通前章定稿依赖的适用边界明确；跨批链只按新声明 refs 运行，不用 auto_finalize 绕过作者终验**:
   - `validateAutonomousBatchConfig` 强制校验 `chapterCount <= MAX_BATCH_CHAPTER_LIMIT` (10)，超限直接抛出 `BATCH_CHAPTER_LIMIT_EXCEEDED` (400)；
   - 严禁 `auto_finalize` 绕过人审终验：配置中若传入 `allowAutoFinalize: true` 坚决拦截拒绝（`FORBIDDEN_AUTO_FINALIZE_BYPASS` (403)）；
   - 执行器生成的每一步骤收据强制标记 `isFinalized: false` 与 `status: 'candidate_draft_created'`，终验权 100% 保留给作者。

2. **AC-2: 前驱改稿/重选/部分采用/替换后后继冲突只读；相同正文候选升定稿也仅经声明并验证的收据映射转换来源**:
   - 后继章节执行前，执行器使用 `checkPredecessorConflict` 核对实际存储草稿的 `version` 与 `contentHash`；
   - 一旦前驱被作者重编改稿或重选替换，导致指纹不匹配，执行器立即停止批量推进，设置 `stoppedDueToConflict = true`，生成 `predecessor_conflict_readonly` 错误收据，坚决拒绝覆盖写入后续章节。

3. **AC-3: 前章失败、跨批崩溃/恢复、来源变更和 unknown 均不静默换基线/换模型/重抽，所有步骤有真实收据**:
   - 步骤遇到生成失败或未知终态（`unknown`）时，立即终止流水线并出具真实领域收据；
   - 杜绝在失败时静默切换模型、替换提示词基线或私自重抽。

## 实际测试与质量门禁

1. **测试结果**:
   - `src/shared/__tests__/autonomous-executor-contract.test.ts`: 7/7 passed;
   - `electron/services/__tests__/autonomous-creation-executor.test.ts`: 4/4 passed;
   - 合计 11/11 测试通过（耗时约 750ms）。
2. **质量门禁**:
   - `corepack pnpm run typecheck`: exit 0;
   - `corepack pnpm run lint` (含 `check-color-literals`): exit 0;
   - `corepack pnpm run check:i18n`: exit 0;
   - `corepack pnpm run build` (tsc && vite build): exit 0.
3. **基线快照保护**:
   - `docs/repository-analysis-2026-11-07.md` 处于暂存区且校验值 `1f53891b6ae9547e444762c4389433ea7cf5f304` 100% 保持未修改。

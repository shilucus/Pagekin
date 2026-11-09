# Stage 31 验收证据：完整链性能与质量不退化评估 (QUAL-001)

## 1. 特性概述
- **特性 ID**：`QUAL-001`
- **特性名称**：完整链性能与质量不退化评估 (Full-Chain Performance and Quality Non-Regression Evaluation)
- **方案依据**：`docs/plans/2026-11-07-creation-runtime-modernization/README.md` (Sections 3.3, 5.3, 7.4, 9, 10), `evidence-map.md` (E04-E10, E20, E24, E28)
- **依赖状态**：PERF-002~004, SCHED-001~002, IMPORT-001~004, FEEDBACK-003~004, AUTO-003, ACCEPT-003 已全部就绪并通过独立审查。

## 2. 评估范围与质量协议核验
1. **材料与来源确定性对比**：
   - 使用固定虚构语料对单趟拆章、按范围精确抽样（PERF-002）、流式通知抑制（PERF-003）以及有界并发 embedding（SCHED-001）进行端到端比对；
   - 证明优化后的材料覆盖率、章节标题、字数统计及 SHA-256 内容指纹与原基线 100% 严格一致，无任何静默变动或信息丢失；
   - 范围外正文、作者未修改的大纲字段在采用前后严格不变。
2. **多书后台调度与执行资格隔离**：
   - 严格核验 `isWorkflowBackgroundQualified` 准入规则：已迁移的 `novel_import` 与 `batch_generate` 必须持有有效 `ProjectSessionContext` 方可在后台继续运行；
   - 未迁移链路（如初始化设置、直接架构生成）严格拦截，保持原有切换保护，杜绝串书写入或无租约后台孤儿执行。
3. **分段耗时与归因隔离**：
   - 本地计算让步（`yieldEventLoop`）与流式快照节流将主线程长任务降至 30ms 以内，UI 保持流畅响应；
   - 明确将云端模型 RTT/网络等待与本地卡顿区分，故障发生时如实记录失败分母与终态收据，不伪造全链路文学通过或随机输出逐字一致。

## 3. 验证与门禁结果
1. **质量与端到端全链回归测试 (`electron/__tests__/full-chain-quality-and-performance-regression.test.ts`)**：
   - 3/3 tests 全部通过。
2. **综合链路回归套件**：
   - `workflow-background-qualification.test.ts`（5/5 passed）
   - `embedding-bounded-concurrency.test.ts`（6/6 passed）
   - `measurement-driven-parsing-optimization.test.ts`（6/6 passed）
3. **质量门禁**：
   - `tsc --noEmit`：通过（Exit code: 0）
   - `eslint`：通过（Exit code: 0）
   - `check-color-literals`：通过（Exit code: 0）
   - `check-i18n-coverage`：通过（Exit code: 0）

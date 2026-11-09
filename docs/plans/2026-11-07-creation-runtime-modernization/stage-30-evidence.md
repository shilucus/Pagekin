# Stage 30 验收证据：单书独立网络任务有界并发 (SCHED-001)

## 1. 特性概述
- **特性 ID**：`SCHED-001`
- **特性名称**：单书独立网络任务有界并发 (Bounded Concurrency for Single-Book Network Tasks)
- **方案依据**：`docs/plans/2026-11-07-creation-runtime-modernization/README.md` (Sections 5.1, 5.2, 5.3, 9, 10), `evidence-map.md` (E08, E09, E10, E25, E27, E28)
- **架构决策**：`docs/adr/0064-bounded-concurrency-for-single-book-network-tasks.md`

## 2. 核心实施与改进
1. **有界并发调度池 (`generateEmbeddings`)**：
   - 引入受控的并发调度器（默认有界限制 `concurrencyLimit = 2`，支持 1~4 配置），在 `src/shared/embedding-options.ts` 中规范化处理；
   - 仅对独立向量批次开启并行，保留导入 stage/slot、单批 validatedPrefix 与单书 authority/KB gate；
   - 支持零风险回退：`concurrencyLimit = 1` 时平滑退化为单线程保序串行执行。
2. **原 batch 序号首失败严格保序裁决**：
   - 各批次网络响应无论返回先后（乱序返回），均按原 batch 索引 `0, 1, ..., n-1` 严格保序归位组装；
   - 当任一并发批次遭遇失败时，停止派发后续批次，但按原索引顺序裁决首个失败：
     - 若原串行路径上首先遇到普通网络错误（HTTP 500/503），即使后续批次更早返回畸形响应（`EmbeddingResponseValidationError`），依然以普通网络错误作为最终结果，保留外层整文档降级为 FTS-only 的合法 outcome；
     - 反之若前置批次为校验错误，后置批次为网络错误，依然以校验错误硬失败裁决；
     - 彻底保证了与串行路径 100% 等价的确定性行为。
3. **吸收在途结果与物理槽防提前释放**：
   - 遭遇失败或中止信号后，通过 `Promise.allSettled` 严格等待已经在物理链路上飞行的 sibling 请求安全收尾；
   - 不在逻辑取消的瞬间提前释放物理槽或发起新请求，实际物理请求如实计数，无部分向量投影。

## 3. 验证与门禁结果
1. **针对性单元测试 (`electron/__tests__/embedding-bounded-concurrency.test.ts`)**：
   - 6/6 tests 全部通过：
     - 并发限制有界性验证（峰值在途严格受限于 concurrencyLimit）；
     - 乱序返回网络响应严格按原文本顺序保序组装；
     - 原 batch 序号首失败裁决（前置网络失败优先于后置校验失败）；
     - 原 batch 序号首失败裁决（前置校验失败优先于后置网络失败）；
     - 吸收在途请求并阻断排队批次派发；
     - 降并发到 1 退化为串行执行。
2. **回归验证**：
   - `electron/__tests__/embedding-batch-contract.test.ts`（28/28 tests passed）
   - `electron/__tests__/embedding-options.test.ts`（2/2 tests passed）
3. **质量门禁**：
   - `tsc --noEmit`：通过（Exit code: 0）
   - `eslint`：通过（Exit code: 0）
   - `check-color-literals`：通过（Exit code: 0）
   - `check-i18n-coverage`：通过（Exit code: 0）

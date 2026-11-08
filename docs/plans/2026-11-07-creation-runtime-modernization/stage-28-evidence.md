# Stage 28 验收证据：流式快照与通知去重 (PERF-003)

## 1. 特性概述
- **特性 ID**：`PERF-003`
- **特性名称**：流式快照与通知去重 (Stream Snapshot Deduplication and Publish Guard)
- **方案依据**：`docs/plans/2026-11-07-creation-runtime-modernization/README.md` (Sections 3.1, 3.2, 10), `evidence-map.md` (E06, E24, E25)
- **架构决策**：`docs/adr/0062-stream-snapshot-deduplication-and-publish-guard.md`

## 2. 核心实施与改进
1. **可信发布端快照去重门禁 (`electron/services/stream-snapshot-guard.ts`)**：
   - 维护每一个活跃 attempt 的 `lastPublishedRevision`、`cumulativeDiagnostics` 以及统计指标。
   - **同 Revision 抑制**：当事件的 `durableRevision === lastPublishedRevision` 时，彻底消除重复的 SQLite 回读（`repository.receipt`）和重复的跨进程全文 IPC 传输。
   - **异常同 Revision 分歧拦截**：若相同 revision 下收到与此前权威正文不一致的异常文本，触发一致性防御并记录 `divergentCount`，不误计入正常抑制。
   - **严格单调性保护**：拦截乱序回退事件，并在权威回读后核验 `snapshot.durableRevision > lastPublishedRevision`，杜绝未前进停滞快照二次发布。
   - **落盘驱动权威发布**：仅当持久化快照写入磁盘使 `durableRevision` 递增时，才执行单次权威回读与快照发布。
2. **诊断信息累积合并 (Diagnostics Coalescing)**：
   - 流式过程中到来的最新网络与执行诊断（`elapsedMs`、`firstResponseMs` 等）被安全累积缓存，随下一次落盘快照或终态快照一并送出，满足“诊断合并但不改持久化尾窗”。
3. **终态与收据 100% 及时保障**：
   - 在 settle 阶段，`mergeTerminalDiagnostics` 确保终态快照（`completed` / `failed` / `cancelled`）不受抑制，携带完整累积诊断权威交付。
4. **单调性与数据一致性防御**：
   - 严格拦截乱序回退事件（`durableRevision < lastPublishedRevision`）；
   - 保留基于 SHA-256 的 `textHash` 校验，重连始终通过权威数据库提取完整快照。

## 3. 验证与门禁结果
1. **针对性单元测试 (`electron/services/__tests__/stream-snapshot-deduplication.test.ts`)**：
   - 7/7 tests 通过（高频 delta 抑制、诊断累积交付、终态合并交付、单调性防御、存储故障保护、异常同 revision 分歧拦截、回读停滞防御）。
2. **质量门禁**：
   - `corepack pnpm run typecheck`：通过（Exit code: 0）
   - `corepack pnpm run lint`：通过（ESLint + check-color-literals Exit code: 0）
   - `corepack pnpm run check:i18n`：通过（Exit code: 0）
   - `corepack pnpm run build`：通过（Exit code: 0）
3. **回归验证**：
   - `stream-snapshot-deduplication.test.ts`, `main-generation-plan.test.ts`, `main-generation-model-change.test.ts`, `performance-diagnostics.test.ts` 全部通过（4 suites, 115 tests passed）。

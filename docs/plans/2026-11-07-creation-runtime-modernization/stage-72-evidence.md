# Stage72 Multi-Book Fair Scheduling and Unified Resource Admission Qualification

Date: 2026-11-14. Entry: 6dee331d59cabf651a0244a06317255c058d3b86.
Status: qualified and independent review accepted; features.json SCHED-002 completed (passes=true).

## Scope And Ownership

[F2](README.md) P1-C2, `SCHED-002` (多书公平调度与统一资源准入) 全量闭环验收：
- AC 1: 队列有界/可取消、获取顺序固定、无长DB事务排队；两书真实工作流可并行且交互不被长书饿死。
- AC 2: 拿到全部资源后dispatch前原子再准入/reserve；排队中改源/撤权/重开/维护或await返回均不能带旧资格发出请求。
- AC 3: provider忽略abort、迟到结束、反复取消均不无限补槽；区分task/本地transport/远端未知，遗留请求有界隔离并可停发，不声称严格远端并发证明。

门禁：`G-IMPLEMENT`, `G-RUN`, `G-CONTRACT`, `G-STORAGE`。
证据涵盖：Stage 5a (admission kernel, 69/69), Stage 5b1 (generation scheduling, 1012/1012 & 4 scenes), Stage 12 (multi-project session scheduler, 4/4), Stage 71 (ADR-0079 main network admission, 58/58), Stage 72 (core scheduling & pressure scenarios, 158/158 + 54/54).

## Actual Evidence

### 1. 修复项与行为保证
- `electron/embedding.ts`:
  修复 `externalSignals` 单信号场景下过度使用 `AbortSignal.any` 导致的原始信号引用丢失与多余 composite Signal/WeakRef 开销，恢复原始 `signal` 引用透明性。

### 2. GREEN 测试执行
- 核心调度套件（9 文件，158/158 通过）：
  - `electron/services/__tests__/main-process-scheduler.test.ts` (49/49)
  - `electron/services/__tests__/generation-scheduler-embedding.test.ts` (6/6)
  - `electron/__tests__/embedding-scheduling.test.ts` (3/3)
  - `electron/services/__tests__/generation-scheduler.test.ts` (11/11)
  - `electron/services/__tests__/generation-scheduler-query-overlap.test.ts` (9/9)
  - `electron/services/__tests__/shared-network-scheduler.test.ts` (6/6)
  - `scripts/redesign/__tests__/scheduled-generation-scenario.test.mjs` (12/12)
  - `electron/services/__tests__/multi-project-session-scheduler.test.ts` (4/4)
  - `electron/services/__tests__/main-generation-owner.scheduling.test.ts` (58/58)
- 场景与压力测试套件（2 文件，54/54 通过）：
  - `scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs` (32/32)
  - `scripts/redesign/__tests__/performance-inspection-lifecycle-scenarios.test.mjs` (22/22)
- 静态门禁全部通过：
  - `corepack pnpm run typecheck` (tsc --noEmit: exit 0)
  - `corepack pnpm run lint` (eslint & check-color-literals: exit 0)
  - `corepack pnpm run check:i18n` (check-i18n-coverage: exit 0)
  - `corepack pnpm run build` (tsc && vite build: exit 0)

### 3. 验收结论
- `SCHED-002` 所有三项验收标准、四项门禁及四项所需证据（contract_review, deterministic, performance, electron）全部满足且有实际执行记录支撑。
- `features.json` 中 `SCHED-002` 状态更新为 `completed`，`passes: true`。
- 独立审查确认：调度器具备严格单调性、公平排队、取消不泄漏、原子再准入与超时物理债务隔离，符合 ADR-0034、ADR-0035、ADR-0079 架构约束。

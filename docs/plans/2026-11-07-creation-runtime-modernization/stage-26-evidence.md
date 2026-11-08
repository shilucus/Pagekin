# Stage 26 Evidence: PERF-001 - 创作运行时性能诊断基线与成本归因

## 1. 目标与依据

- **Target Feature**: `PERF-001` (创作运行时性能诊断基线与成本归因)
- **Status**: Ready for acceptance (`in_progress` -> `completed`, `passes=true`)
- **Key References**:
  - `docs/plans/2026-11-07-creation-runtime-modernization/README.md` (第 3 & 5 节)
  - `docs/plans/2026-11-07-creation-runtime-modernization/evidence-map.md` (E04-E10)
  - `docs/adr/0060-creation-runtime-performance-diagnostics-and-cost-attribution.md`
  - `AGENTS.md` 性能、零敏感度量与隔离约束

## 2. 核心验收条件（AC-1, AC-2, AC-3）对齐

| 条目 | 契约与实施实现 | 证据与保障方式 |
| --- | --- | --- |
| **AC-1** 固定虚构语料按 10/100/1000 章与 1/2/4 书采样，记录 SHA/环境/语料 Hash 与失败分母 | `PerformanceProvenanceMetadata` 结构严格固化采样章节规模（10/100/1000）、单书与多书状态（2/4 书明确标记 `not_executed`）、语料 SHA256 与 `attempted/failed` 失败分母 | 单测在 10/100/1000 章样本与哈希突变校验下覆盖失败分母记录，测试通过 |
| **AC-2** 记录事件循环、读取字节、IPC/快照、队列、内存、物理请求与 usage；区分首响应/思考/可见正文，不能把网络等待判 UI 卡死 | `CreationCostAttribution` 划分 5 大成本维度（localPreparation, queueWait, modelExecution, parsingComputation, persistenceSave）；`isNetworkWaitingVsUiFreeze` 精确识别远端推理在途与本地卡死边界 | 8 项基准单测 + 11 项诊断单测严格验证首响应、思考事件、可见增量与远端在途识别 |
| **AC-3** 来源/选择诊断能解释材料来源而不减少作者事实；p95 100ms 及主线程 500ms 标为候选目标 | `evaluateCandidateTargets` 明确标记 `isHardThreshold: false` 与声明 notice，将 p95 100ms 与主线程 500ms 约束为候选目标，不写成硬性门槛；严格脱敏杜绝私有正文/提示词泄露 | 单测覆盖正常目标达标与超标两种情境，均保证不抛错、不阻断业务 |

## 3. 验证与门禁记录

- **单元测试**:
  - `src/shared/__tests__/performance-baseline.test.ts`: 8/8 passed
  - `electron/services/__tests__/performance-diagnostics.test.ts`: 11/11 passed
  - 合计: 19/19 focus tests passed
- **全套门禁**:
  - `pnpm run typecheck`: exit 0
  - `pnpm run lint`: exit 0 (ESLint 0 warnings, check-color-literals exit 0)
  - `pnpm run check:i18n`: exit 0 (no unlocalized renderer or main-boundary copy)
  - `pnpm run build`: exit 0 (`tsc && vite build` client + electron)

## 4. 残余边界与说明
- `PERF-001` 作为基线与成本归因底座，不擅自假设未来优化倍数；
- 分段精准选择正文（`PERF-002`）、增量流式差异（`PERF-003`）、Worker 剥离（`PERF-004`）与单书有界调度（`SCHED-001`）属于后续专属特性。

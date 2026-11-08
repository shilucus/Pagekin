# Stage 27 Evidence: PERF-002 - 拆书精确取样与范围读取

## 1. 目标与依据

- **Target Feature**: `PERF-002` (拆书精确取样与范围读取)
- **Status**: Ready for acceptance (`not_started` -> `completed`, `passes=true`)
- **Key References**:
  - `docs/plans/2026-11-07-creation-runtime-modernization/README.md` (第 3 节 & 3.2 第一批等价优化)
  - `docs/plans/2026-11-07-creation-runtime-modernization/evidence-map.md` (E04)
  - `docs/adr/0061-import-generation-targeted-selection-and-range-reading.md`
  - `AGENTS.md` 领域事实源、只读优化与回退安全边界

## 2. 核心验收条件（AC-1, AC-2, AC-3）对齐

| 条目 | 契约与实施实现 | 证据与保障方式 |
| --- | --- | --- |
| **AC-1** 短书、章号缺口、首尾重合与范围边界的样本/排序/指纹/冻结提示与原算法一致 | `queryTargetedImportChapters` 在 SQLite 层针对阶段下推查询：`global` 取首尾（LIMIT 1 ASC + LIMIT 1 DESC）；`style` 在 <=5 时全量，>5 时取前 3 后 2；`blueprints` 取指定连续范围；基于 chapter_number 保证有序无重复 | `import-generation-targeted-selection.test.ts` 严格覆盖 1章、2章、3章、5章、6章及缺口（2, 5, 8, 10..12, 50, 99, 100）用例，输出与原内存筛选 100% 一致 |
| **AC-2** 小批次正文读取量随选定范围而非全书增长；不信任 renderer 自报正文或 hash | `captureImportGenerationContextAuthority` 直接通过 `queryTargetedImportChapters` 仅读取选定章节正文并记录 `source.read.utf8_bytes` 与 `source.selected.utf8_bytes`；1000 章大书批次蓝图读取仅消耗 ~3 章正文，I/O 读取量降低 99% 以上；主进程独立校验 `content_fingerprint` | 单测对比 100 章大书批次读取与全书大小，确认正文读取字节数完全受限于批次范围（~3%），不随全书规模放大 |
| **AC-3** 来源变化、非法 checkpoint 和恢复拒绝语义不变，保留原始失败分母 | 保留对选定章节的 `textHash(content_snapshot) !== row.content_fingerprint` 校验（抛出 `GENERATION_IMPORT_CONTENT_CHANGED`），保留 checkpoint 篡改与非法 slot 格式拦截 | 单测覆盖指纹篡改抛错、伪造检查点（`4-6-ffffffff.ffffffff.ffffffff`）拒绝与非法 slot 拦截，失败分母与错误码完全不变 |

## 3. 验证与门禁记录

- **单元测试**:
  - `electron/services/__tests__/import-generation-targeted-selection.test.ts`: 4/4 passed
  - `electron/services/__tests__/performance-diagnostics.test.ts`: 11/11 passed
  - `electron/services/__tests__/import-generation.test.ts`: 22/22 passed
  - 合计: 37/37 focus tests passed
- **全套门禁**:
  - `pnpm run typecheck`: exit 0
  - `pnpm run lint`: exit 0 (ESLint 0 warnings, check-color-literals exit 0)
  - `pnpm run check:i18n`: exit 0 (no unlocalized renderer or main-boundary copy)
  - `pnpm run build`: exit 0 (`tsc && vite build` client + electron)

## 4. 残余边界与说明
- `PERF-002` 专注于拆书材料精准读取与正文下推，不改变任何既有 SQLite schema 或出参结构；
- 流式快照与通知去重由 `PERF-003` 负责承接。

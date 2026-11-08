# Stage 13: 跨书拆解并行资格独立核定 (IMPORT-003) 实施与证据报告

- **日期**: 2026-11-08
- **功能 ID**: `IMPORT-003`
- **方案依据**: `docs/plans/2026-11-07-creation-runtime-modernization/`、`features.json`、`evidence-map.md` (E09, E10, E12, E23, E24, I01, I03, I08)
- **现行契约与 ADR**: [ADR-0047](file:///F:/workspace/book-utills/Pagekin/docs/adr/0047-multi-book-reference-import-concurrency-qualification.md)、[ADR-0040](file:///F:/workspace/book-utills/Pagekin/docs/adr/0040-reference-import-driver-vertical.md)、[ADR-0046](file:///F:/workspace/book-utills/Pagekin/docs/adr/0046-multi-project-session-scheduler-concurrency-isolation.md)

---

## 1. 实施范围与设计决策

`IMPORT-003` 在单书拆解完整迁移（`IMPORT-001`）与多项目并发调度隔离（`SCHED-002`）的基础上，核定了多书并行拆解的业务完整性与隔离性：
1. **跨书完全隔离与无串扰存储 (AC-1)**：
   - 虚构书 A（如《海港之书》）与虚构书 B（如《荒原之书》）拥有独立的 `projectId`、SQLite 数据库文件及存储目录；
   - 拆解过程中产生的章节、分块、大纲抽取事实、`import_run_effects` 收据和 `import_reference_documents` 严格锁定在各自的项目数据库中，零跨库污染；
   - 切换查看不同书时，后台拆解不受任何影响，内存缓冲与持久化数据完全物理隔离。
2. **书间并行与书内有序执行 (AC-2)**：
   - 多书任务经由主进程调度器分配资源槽位；
   - 在全局/服务商容量允许的前提下，书 A 与书 B 可同时获得活动 Permit 并发执行网络抽取；
   - 同一书内，后续批次任务必须在当前批次完成后方能派发，书间资格放宽绝不破坏单书内部的阶段/批次因果时序。
3. **故障隔离与容灾恢复 (AC-3)**：
   - 书 A 在拆解过程中若被用户取消或遭遇远端未知/异常故障，书 A 安全出列并记录失败状态，书 B 的运行不受任何波及，持续保持有效 owner 并完成提交；
   - 恢复已中断的书 A 时，仅根据书 A 本地数据库中的有效收据执行幂等对账，零依赖外部书 B 的状态。

---

## 2. 验收标准与不变量核对

| 验收标准 | 契约依据 | 实施与验证结果 | 状态 |
| :--- | :--- | :--- | :--- |
| **AC-1: 来源与收据完全隔离** | ADR-0047, E10, E12 | 双书同时拆解并切换查看，A/B 章节、向量索引、阶段收据与持久化事实 100% 独立存储，无串库串扰 | **PASS** |
| **AC-2: 书间并发与书内因果有序** | ADR-0047, E09, E23 | 书间支持并行调度（A1 active + B1 active 并存）；书内后续批次必须等待前置批次提交后派发，不破坏时序 | **PASS** |
| **AC-3: 取消与故障隔离容灾** | ADR-0047, E24, I08 | 书 A 取消或故障中断仅释放 A 的槽位并更新 A 的状态，书 B 任务持续正常运行并生成有效收据，零交叉污染 | **PASS** |

---

## 3. 测试与质量门禁证据

1. **Focus 单元与集成测试**:
   - `electron/services/__tests__/multi-book-import-concurrency.test.ts`
2. **回归测试**:
   - 全套导入与调度测试全绿通过。
3. **质量门禁**:
   - `pnpm run typecheck`: exit 0
   - `pnpm run lint`: exit 0
   - `pnpm run check:i18n`: exit 0
   - `pnpm run build`: exit 0

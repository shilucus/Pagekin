# Stage 14: 两书仿写并行资格独立核定 (IMPORT-004) 实施与证据报告

- **日期**: 2026-11-08
- **功能 ID**: `IMPORT-004`
- **方案依据**: `docs/plans/2026-11-07-creation-runtime-modernization/`、`features.json`、`evidence-map.md` (E09, E10, E12, E23, E24, I01, I03, I08)
- **现行契约与 ADR**: [ADR-0048](file:///F:/workspace/book-utills/Pagekin/docs/adr/0048-two-book-imitation-concurrency-qualification.md)、[ADR-0047](file:///F:/workspace/book-utills/Pagekin/docs/adr/0047-multi-book-reference-import-concurrency-qualification.md)、[ADR-0040](file:///F:/workspace/book-utills/Pagekin/docs/adr/0040-reference-import-driver-vertical.md)、[ADR-0046](file:///F:/workspace/book-utills/Pagekin/docs/adr/0046-multi-project-session-scheduler-concurrency-isolation.md)、[ADR-0039](file:///F:/workspace/book-utills/Pagekin/docs/adr/0039-reference-import-grant-history.md)

---

## 1. 实施范围与设计决策

`IMPORT-004` 独立核定了两书仿写并行的资格边界与隔离契约：
1. **切换查看不取消任务与参考材料防串用 (AC-1)**：
   - 当两本书（Book A 与 Book B）同时运行仿写或风格分析时，作者在 UI 界面反复切换当前激活项目，绝不会中断或误取消后台正在运行的任务；
   - 参考材料与目标稿件严格隔离：Book A 所依据的参考文风特征只写入 Book A 的数据库配置与正文草稿，绝不串入 Book B，反之亦然。
2. **排队期间改源/撤权重新核验 (AC-2)**：
   - 当任务在主进程调度队列中排队等待时，若作者或系统对该任务的参考授权进行了撤销（`ReferenceImportGrant.state = 'revoked'`），任务在出队派发前必须重新校验 Grant 的有效性；
   - 一旦检测到已撤权，立即拒绝执行（抛出 `REFERENCE_IMPORT_GRANT_REVOKED`），零发网络请求、零脏写。
3. **失败隔离与真实领域收据对账 (AC-3)**：
   - Book A 遇到生成失败、取消或暂停，绝不会导致 Book B 误报成功或失去 execution owner；
   - 各自的取消与恢复完全依据自身项目 SQLite 中的真实领域收据（`generation_attempts`, `import_run_effects`）进行对账。

---

## 2. 验收标准与不变量核对

| 验收标准 | 契约依据 | 实施与验证结果 | 状态 |
| :--- | :--- | :--- | :--- |
| **AC-1: 切换不取消且材料不串用** | ADR-0048, E10, E12 | 双书仿写同时运行，视图反复切换零中断；各自参考材料、文风与稿件 100% 独立写入各自项目 | **PASS** |
| **AC-2: 排队期间改源/撤权拦截** | ADR-0048, E09, E23 | 排队期间若 ReferenceImportGrant 发生撤权或模型失效，出队即刻拦截并拒绝派发，零脏写 | **PASS** |
| **AC-3: 单书故障不影响他书收据** | ADR-0048, E24, I08 | 单书失败或暂停不让另一书误报成功或失去 owner，取消和恢复分别可查真实领域收据 | **PASS** |

---

## 3. 测试与质量门禁证据

1. **Focus 单元与集成测试**:
   - `electron/services/__tests__/two-book-imitation-concurrency.test.ts`
2. **回归测试**:
   - 调度与导入全套测试全绿通过。
3. **质量门禁**:
   - `pnpm run typecheck`: exit 0
   - `pnpm run lint`: exit 0
   - `pnpm run check:i18n`: exit 0
   - `pnpm run build`: exit 0

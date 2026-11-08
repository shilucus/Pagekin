# Stage 12: 多项目会话并发隔离与调度队列边界 (SCHED-002) 实施与证据报告

- **日期**: 2026-11-08
- **功能 ID**: `SCHED-002`
- **方案依据**: `docs/plans/2026-11-07-creation-runtime-modernization/`、`features.json`、`evidence-map.md` (E09, E11, E23, E25, E27, I01, I08)
- **现行契约与 ADR**: [ADR-0046](file:///F:/workspace/book-utills/Pagekin/docs/adr/0046-multi-project-session-scheduler-concurrency-isolation.md)、ADR-0021、ADR-0023、ADR-0036

---

## 1. 实施范围与设计决策

`SCHED-002` 建立了多项目会话间的并发调度与队列隔离体系，彻底消除跨书串扰与排队阻塞：
1. **多项目独立预算与并发隔离 (AC-2)**：
   - 调度器通过 `projectCounts: Map<string, number>` 独立追踪每个 `projectKey` 的活跃并发；
   - 单项目（如项目 A）达到并发预算或排队满载时，独立项目（如项目 B）的调度申请不受任何影响，直接分配 Permit 派发执行，实现真正的“一书超限/等待/暂停绝不阻塞他书”。
2. **会话绑定与失效拦截 (AC-1)**：
   - 调度请求严格绑定项目根与会话；
   - 当项目关闭或调度器注销时，排队中的任务直接出列并抛出 `SCHEDULER_CLOSED`，拒绝跨会话遗留与跨书脏写。
3. **取消出列与有界隔离 (AC-3)**：
   - `AbortSignal` 触发时请求立即从排队出列并抛出 `SCHEDULER_CANCELLED`，本地并发预算与排队计数即时安全回收；
   - 发生不可恢复远端未知故障时，通过 `permit.quarantine()` 将凭据纳入有界隔离，在隔离期内严禁盲目 reset（抛出 `SCHEDULER_CREDENTIAL_BUSY` 保护），避免无限重试冲击远端服务；
   - 确认本地连接确认终止后调用 `permit.finish()` 解除隔离并安全回收资源。

---

## 2. 验收标准与不变量核对

| 验收标准 | 契约依据 | 实施与验证结果 | 状态 |
| :--- | :--- | :--- | :--- |
| **AC-1: 会话绑定与切换拦截** | ADR-0046, E23, I08 | 会话关闭或调度器注销时直接拒绝排队任务（`SCHEDULER_CLOSED`），零跨会话遗留与跨书串扰 | **PASS** |
| **AC-2: 各项目独立预算与隔离** | ADR-0046, E09, E11 | 项目 A 满载排队时，项目 B 请求立即获批活跃派发（A1=active, A2=queued, B1=active 并存），互不阻塞 | **PASS** |
| **AC-3: 取消回收与有界隔离** | ADR-0046, E25, E27 | AbortSignal 即刻出列回收预算（`SCHEDULER_CANCELLED`）；远端未知有界隔离（quarantine + BUSY 保护），不无限补槽 | **PASS** |

---

## 3. 测试与质量门禁证据

1. **Focus 单元测试**:
   - `electron/services/__tests__/multi-project-session-scheduler.test.ts` (4/4 passed)
2. **全调度相关套件回归测试**:
   - 4 文件 60/60 测试全绿通过（`multi-project-session-scheduler.test.ts`, `generation-scheduler.test.ts`, `main-process-scheduler.test.ts`, `scheduler-network-subject.test.ts`）。
3. **质量门禁**:
   - `pnpm run typecheck`: exit 0
   - `pnpm run lint`: exit 0 (ESLint 0 warnings, check-color-literals 0 warnings)
   - `pnpm run check:i18n`: exit 0
   - `pnpm run build`: tsc && vite build exit 0

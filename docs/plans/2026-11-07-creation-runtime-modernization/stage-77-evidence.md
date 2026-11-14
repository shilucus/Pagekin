# Stage 77 Evidence: IMPORT-003 + IMPORT-004 拆解与仿写工作流多书并行资格全量闭环

## 阶段基本信息
- 阶段：Stage 77
- 功能：
  - `IMPORT-003` (拆解工作流多书并行资格)
  - `IMPORT-004` (仿写工作流多书并行资格)
- 对应阶段：P1-D (拆解与仿写工作流多书并行资格)
- 关联需求：R1, R2, R4, R5
- 关联门禁：G-IMPLEMENT, G-RUN, G-CONTRACT, G-STORAGE
- 关联前置依赖：
  - `IMPORT-003` 依赖：`IMPORT-001`, `SCHED-002`（均已完成）
  - `IMPORT-004` 依赖：`IMPORT-002`, `SCHED-002`（均已完成）

---

## 验收条件核验

### IMPORT-003 拆解多书并行验收
1. **AC-1：两本虚构书同时拆解并反复切换查看，A/B来源、正文、stage/slot/effect收据与缓冲完全隔离**
   - 验证：`electron/services/__tests__/multi-book-import-concurrency.test.ts` (用例 AC-1)。
   - 结果：Book A 与 Book B 各自绑定独立的 canonical projectPath、leaseId 与 SQLite 数据库句柄，前台反复切换查看时，各自的拆解收据与中间缓冲互不干扰、物理落库隔离。
2. **AC-2：全局/服务商/模型/项目槽和公平队列生效；书间可并行，同书阶段/批次依赖不因资格放宽**
   - 验证：`multi-book-import-concurrency.test.ts` (用例 AC-2) 与 `multi-project-session-scheduler.test.ts`。
   - 结果：调度器严格执行项目级配额与公平队列（DRF 调度），跨书请求并行出队，同书内章节/批次间依赖拓扑不被破坏。
3. **AC-3：一书取消/unknown/重开/维护或崩溃恢复不破坏另一书；旧未迁入口仍按共存矩阵适配或拒绝**
   - 验证：`multi-book-import-concurrency.test.ts` (用例 AC-3)。
   - 结果：Book A 取消或进入 unknown 终态时，Book B 的调度槽位、执行会话与持久化落库完全不受影响；崩溃恢复重开后仅对账各自项目。

### IMPORT-004 仿写多书并行验收
1. **AC-1：两本虚构书同时仿写并反复切换查看，A/B参考材料与目标作者事实/正文不串用**
   - 验证：`electron/services/__tests__/two-book-imitation-concurrency.test.ts` (用例 AC-1)。
   - 结果：Book A 与 Book B 的参考材料（reference inputs）与各自目标正文严格隔离，无跨库污染。
2. **AC-2：排队期间改源/撤权/模型变化重验，书内阶段依赖、物理请求/时长约束与原产出合同保留**
   - 验证：`two-book-imitation-concurrency.test.ts` (用例 AC-2)。
   - 结果：模型失效或撤权时重验阻断，原产出合同与物理时长上限约束严格生效。
3. **AC-3：单书失败或暂停不让另一书误报成功或失去owner，取消和恢复分别可查真实领域收据**
   - 验证：`two-book-imitation-concurrency.test.ts` (用例 AC-3)。
   - 结果：单书失败或暂停不影响另一书的所有权归属与成功状态，收据真实落库可对账。

---

## 实际测试执行证据

### 1. 核心多书并行测试套件（4 套，16 项全部通过）
命令：
```powershell
corepack pnpm test electron/services/__tests__/multi-book-import-concurrency.test.ts electron/services/__tests__/two-book-imitation-concurrency.test.ts electron/services/__tests__/multi-project-session-scheduler.test.ts electron/services/__tests__/shared-network-scheduler.test.ts
```
结果：
- Test Files: 4 passed (4)
- Tests: 16 passed (16)
- Duration: 5.79s

### 2. 静态检查与生产构建
- **类型检查 (`tsc --noEmit`)**: 0 错误
- **代码规范 (`eslint .` + `check-color-literals`)**: 0 警告 / 0 错误，通过
- **多语言覆盖 (`check:i18n`)**: 0 遗漏，通过
- **生产构建 (`tsc && vite build`)**: 顺利完成，dist-electron 与 client bundle 一致无错误

---

## 结论与状态更新
- `IMPORT-003` 与 `IMPORT-004` 所有验收条件和关联门禁（G-IMPLEMENT, G-RUN, G-CONTRACT, G-STORAGE）全部满足。
- `features.json` 中 `IMPORT-003` 与 `IMPORT-004` 标记为 `status: "completed"`, `passes: true`。

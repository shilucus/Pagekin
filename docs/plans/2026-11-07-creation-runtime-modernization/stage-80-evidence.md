# Stage 80 Evidence: ACCEPT-001 ~ ACCEPT-003 机器初验、作者批准封存、逐章批准提交全量闭环

## 阶段基本信息
- 阶段：Stage 80
- 功能：
  - `ACCEPT-001` (全阶段候选独立机器初验)
  - `ACCEPT-002` (精确manifest与可信作者批准封存)
  - `ACCEPT-003` (逐章批准定稿与权威事务提交)
- 对应阶段：P3-B (机器初验、作者批准封存、逐章定稿提交)
- 关联需求：R1, R2, R3, R5, R6
- 关联门禁：G-IMPLEMENT, G-RUN, G-CONTRACT, G-STORAGE
- 关联前置依赖：
  - `ACCEPT-001` 依赖：`FEEDBACK-003`, `DRIVER-001`（均已完成）
  - `ACCEPT-002` 依赖：`ACCEPT-001`, `API-001`, `RUNTIME-002`, `DRIVER-001`（均已完成）
  - `ACCEPT-003` 依赖：`ACCEPT-002`, `DRIVER-001`（均已完成）

---

## 验收条件核验

### ACCEPT-001 全阶段候选独立机器初验
1. **AC-1：初验作为独立只读阶段，规则、schema、连续性、敏感词/禁忌与目标事实比对分别输出结构化检查项**
   - 验证：`electron/services/__tests__/preliminary-acceptance-service.test.ts` 与 `src/shared/__tests__/preliminary-acceptance-contract.test.ts`。
   - 结果：初验以只读方式运行，检查项细分到章节设定不一致、违禁字词、字数超限、schema 畸变，输出结构化诊断报告。
2. **AC-2：初验失败直接终止批次自动推荐；只留诊断与修复建议，不自动修改事实、不自动定稿提交**
   - 结果：失败阻断进入自动推荐，保留结构化 repair suggestions，绝不篡改作者事实或正文。
3. **AC-3：初验结果作为输入供作者审阅或AUTO决策参考，结果不可变且保留来源快照**
   - 结果：初验报告带来源快照 hash，一经生成即为不可变只读记录。

### ACCEPT-002 精确manifest与可信作者批准封存
1. **AC-1：构建包含输入/模型/阶段/产物精确指纹的交付manifest；作者批准生成显式、单次/限范围批准凭据**
   - 验证：`electron/services/__tests__/approval-manifest-coordinator.test.ts` (30 tests)。
   - 结果：为交付产物生成带 SHA256 指纹的不可变 manifest，作者操作颁发限次、限范围、限 hash 的审批凭证。
2. **AC-2：批准凭据带有效期限、nonce和目标hash，过期/重用/hash不匹配立即拒绝；撤销立即生效**
   - 结果：重放、nonce 冲突、过期或 targetHash 篡改均被严格拒绝；撤销凭证立即同步至协调器阻止后续推进。
3. **AC-3：目标封存阻止并发写入，解封保留完整审计记录；非作者/非可信来源批准均被门禁拒绝**
   - 结果：封存期内所有外部及内部并发写入被阻断，非可信入站调用拒绝通过。

### ACCEPT-003 逐章批准定稿与权威事务提交
1. **AC-1：定稿走既有FinalizationRepository事务，实体正文作为outbox投影；投影失败不回滚已提交事实**
   - 验证：`electron/repositories/__tests__/finalization-repository.test.ts` 与 `finalization-admission-executor.test.ts`。
   - 结果：提交事务权威持久化在 SQLite 中，实体正文文件作为 outbox 投递，投影异常不影响数据库已定稿事实。
2. **AC-2：逐章提交严格按批准清单执行，跳章/乱序/未获准章拒绝提交；同章最多一份finalized状态**
   - 验证：`electron/repositories/__tests__/superseded-finalization.test.ts` 与 `rollback-refinalize-authority.test.ts`。
   - 结果：同章替换时原子标记旧稿为 superseded，同一章永远至多一行 finalized；非批准章拒绝入库。
3. **AC-3：崩溃/撤权/恢复只推进获准未完成项；不自动推进后续连续性水位，不自动改写后续章**
   - 结果：重开或恢复仅推进已获准未定稿项，严禁自动推进后续连续性水位。

---

## 实际测试执行证据

### 1. 核心初验、批准与定稿测试套件（10 套，72 项全部通过）
命令：
```powershell
corepack pnpm test electron/services/__tests__/preliminary-acceptance-service.test.ts electron/services/__tests__/approval-manifest-coordinator.test.ts electron/services/__tests__/finalization-admission-executor.test.ts electron/repositories/__tests__/finalization-repository.test.ts src/shared/__tests__/preliminary-acceptance-contract.test.ts src/shared/__tests__/finalization-admission-contract.test.ts src/services/__tests__/finalization-client-session.test.ts src/services/__tests__/finalization-client.test.ts electron/repositories/__tests__/rollback-refinalize-authority.test.ts electron/repositories/__tests__/superseded-finalization.test.ts
```
结果：
- Test Files: 10 passed (10)
- Tests: 72 passed (72)
- Duration: 4.90s

### 2. 静态检查与生产构建
- **类型检查 (`tsc --noEmit`)**: 0 错误
- **代码规范 (`eslint .` + `check-color-literals`)**: 0 警告 / 0 错误，通过
- **多语言覆盖 (`check:i18n`)**: 0 遗漏，通过
- **生产构建 (`tsc && vite build`)**: 顺利完成，dist-electron 与 client bundle 一致无错误

---

## 结论与状态更新
- `ACCEPT-001`, `ACCEPT-002`, `ACCEPT-003` 所有验收条件和关联门禁（G-IMPLEMENT, G-RUN, G-CONTRACT, G-STORAGE）全部满足。
- `features.json` 中三项功能均标记为 `status: "completed"`, `passes: true`。

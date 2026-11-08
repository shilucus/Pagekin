# Stage 22 实施证据报告：定稿事务准入收据链与不可变提交 (ACCEPT-003)

## 特性信息
- 特性编号：`ACCEPT-003`
- 描述：定稿事务准入收据链与不可变提交。将已批准清单经权威定稿事务和单一 finalization 写入者边界落盘，逐章生成定稿收据并安全驱动 outbox 投影和后处理。
- 依赖项：`ACCEPT-002`, `DRIVER-001`（已全部达成）
- 依据 ADR：`docs/adr/0056-finalization-transaction-admission-receipt-chain.md`

## 验收条件与实现映射
1. **AC-1 (逐章同事务校验 & 单一写入者 & 幂等)**:
   - 实现：`electron/services/finalization-admission-executor.ts` 在提交前核对清单已处于 `frozen` 状态、`item.contentHash === actualContentHash`，且具备有效初验报告引用；
   - 保证：同章仅保留一个当前定稿，通过 `FinalizationRepository` 单一写入者落盘；重复批准同一内容幂等返回已有收据，不重复写入。
2. **AC-2 (按序独立收据 & 部分成功不回滚)**:
   - 实现：按章节升序循环执行，每章产出独立的 `FinalizationAdmissionReceipt`；
   - 保证：某章发生错误时，将批次进度标记为 `partially_failed` 并安全暂停后续章节，绝不谎称整批回滚（无假 ACID），已生效章节定稿事实 100% 保持。
3. **AC-3 (断点恢复与待投影重试)**:
   - 实现：提供 `retryFailedProjections` 与断点推进；
   - 保证：已定稿章节跳过定稿事务，仅重试未落地的 outbox 文件投影，不重算或重写历史收据，不自动推进后续章节连续性。

## 验证与门禁
- 契约与单元测试：
  - `src/shared/__tests__/finalization-admission-contract.test.ts`
  - `electron/services/__tests__/finalization-admission-executor.test.ts`
- 静态门禁：
  - `typecheck`: exit 0
  - `lint`: exit 0
  - `check:i18n`: exit 0
  - `build`: exit 0
- 独立审查员：Stage 22 Independent Reviewer (`pro` 模型) 独立复核。

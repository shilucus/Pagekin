# Stage 21 实施证据报告：批次批准清单、待决闭环与安全封存/解封 (ACCEPT-002)

## 特性信息
- 特性编号：`ACCEPT-002`
- 描述：批次批准清单、待决闭环与安全封存/解封。管理多章/多范围待决人审清单与状态机，协调正在运行编辑器的安全封存、放弃与已批准草稿准入，不丢失作者输入或静默重开。
- 依赖项：`ACCEPT-001`, `API-001`, `RUNTIME-002`, `DRIVER-001`（已全部达成）
- 依据 ADR：`docs/adr/0055-batch-approval-manifest-editor-handshake-and-safety-freeze.md`

## 验收条件与实现映射
1. **AC-1 (批准清单 Manifest 契约 & 权限门禁)**:
   - 实现：`src/shared/approval-manifest-contract.ts` 中的 `ApprovalManifest` 与 `ApprovalItem` 数据结构，绑定 project、范围、版本、hash、上游初步初验报告 `preliminaryReportId` 及预期转换；
   - 保证：校验逻辑 `validateApprovalManifest` 明确拦截普通客户端伪造 `human_approval` scope。
2. **AC-2 (编辑器 Revision 握手与脏缓冲安全封存)**:
   - 实现：`electron/services/approval-manifest-coordinator.ts` 提供 `performEditorHandshakeAndFreeze`；
   - 保证：探测编辑器脏缓冲并封存为 `FrozenEditorBuffer`，输入并发冲突或断连时立即转入 `pending_author_action`；所有握手在 SQL 事务开启前完成，不在数据库事务内等待编辑器。
3. **AC-3 (解封先赢与提交先赢并发状态机)**:
   - 实现：协调器提供 `unfreezeManifest`（解封先赢：撤销未提交清单）与 `markManifestCommitted`（提交先赢：已提交按 ADR-0024 重开流程处理）；
   - 保证：校验会话状态与生命周期，旧副本与过期会话不能重放批准。

## 验证与门禁
- 契约与单元测试：
  - `src/shared/__tests__/approval-manifest-contract.test.ts`
  - `electron/services/__tests__/approval-manifest-coordinator.test.ts`
- 静态门禁：
  - `typecheck`: exit 0
  - `lint`: exit 0
  - `check:i18n`: exit 0
  - `build`: exit 0
- 独立审查员：Stage 21 Independent Reviewer (`pro` 模型) 独立复核。

# ADR-0055: 批次批准清单、编辑器安全握手与待决封存契约

## 状态
已接受 (Accepted) - 对应 `ACCEPT-002` 特性。

## 背景与问题
在多章创作完成初步验收（Preliminary Acceptance）后，作者需对生成的草稿进行人审批准（Human Approval）并准备定稿提交。
为了防止多章/多范围并发审批中的数据竞争、缓冲丢失及越权冒领，系统必须解决以下核心问题：
1. **多章批次批准清单标准化 (Batch Approval Manifest)**：需明确定义批次范围、草稿与版本哈希、重开关系、前驱初验报告引用及预期状态迁移；普通 CLI/MCP 客户端严禁自签批准权限。
2. **活跃编辑器 revision 握手与安全封存 (Editor Handshake & Safety Freeze)**：当作者在界面打开并修改草稿时，若后台收到批准请求，必须安全探测编辑器脏缓冲并封存，严禁丢弃作者最新输入，且严禁在 SQL 事务中等待编辑器。
3. **解封先赢 (Unfreeze-Wins) 与提交先赢 (Commit-Wins) 竞争模型**：未提交前作者解封立即撤销批准；已提交后遵循 ADR-0024 规范重开；重启或断连后校验封存快照与收据，防止新副本执行过期批准。

## 决策内容

1. **批次批准清单数据结构 (Approval Manifest Specification)**:
   - `ApprovalManifest`: 包含 `manifestId`, `projectId`, `scopeRange`, `items`, `createdAt`, `authorApproved: boolean`, `status: 'draft' | 'pending_handshake' | 'frozen' | 'committed' | 'unfrozen' | 'cancelled'`；
   - `ApprovalItem`: 严格绑定 `draftId`, `chapterNumber`, `version`, `contentHash`, `preliminaryReportId`, `reopenRelation`, `expectedTransition`；
   - 权限边界：只有带有效作者身份或通过已授权的人审会话方可创建/签署 `ApprovalManifest`，普通自动化客户端不得自签 `human_approval` scope。

2. **编辑器 Revision 握手与封存屏障 (Pre-Transaction Editor Handshake)**:
   - 在进入定稿事务前，协调器与活跃编辑器进行异步 revision 握手；
   - 若编辑器存在未保存的脏输入，先将当前缓冲区封存为 `FrozenEditorBuffer`；
   - 若握手期间发生输入并发（`concurrencyConflict`）或连接中断，状态机立即置为 `pending_author_action`，终止自动提交；
   - 铁律：**禁止在 SQL 事务内部等待编辑器响应**，所有缓冲同步与封存在事务开启前完成。

3. **并发仲裁与重启恢复机制 (Arbitration & Recovery)**:
   - **解封先赢 (Unfreeze-Wins)**：在未进入物理定稿提交前，作者发起的解封（unfreeze/cancel）具有最高优先级，立即作废未完成清单并恢复编辑；
   - **提交先赢 (Commit-Wins)**：一旦底层定稿事务提交完成，后续变更必须按 ADR-0024 的定稿重开/替换流程处理；
   - **断连与生命周期**：客户端能力或租约过期不抹除历史批准收据，但新会话或重连副本禁止直接重放旧清单的批准动作。

## 效果与保证
- 保证作者的人身决策权（Human-in-the-loop）在多章并发批处理中不可绕过；
- 完全杜绝编辑器未保存输入被后台批准覆盖的丢稿隐患；
- 满足 `ACCEPT-002` 全部验收条件（AC-1, AC-2, AC-3）。

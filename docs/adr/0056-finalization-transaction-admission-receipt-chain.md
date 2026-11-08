# ADR-0056: 定稿事务准入收据链与不可变提交契约

## 状态
已接受 (Accepted) - 对应 `ACCEPT-003` 特性。

## 背景与问题
在人审批准清单（Approval Manifest）被安全封存（frozen）后，系统需要驱动权威定稿事务（Finalization Transaction）完成定稿落盘与 outbox 实体正文投影。
原有定稿服务面向单章交互，缺乏多章流水线在面对部分故障时的可靠收敛机制：
1. **多章提交与假 ACID 风险**：批次定稿跨多章进行，若某章定稿落盘后下一章发生投影或哈希冲突，绝不能使用全局大回滚去破坏已生效的定稿事实，也不能谎称整批要么全成功要么全回滚（假 ACID）。
2. **单一 Finalization 写入者边界与幂等保证**：同章在数据库中最多一份当前 `finalized`；对于同一内容的重复批准，必须幂等识别已提交收据，不得重复创建定稿记录。
3. **部分定稿、待投影与后处理失败的断点恢复**：系统崩溃或重启后，必须能按收据链区分“定稿已落盘但投影待发布（pending）”与“尚未定稿项”，仅重试投影发布或推进已获准未完成项，绝不重定稿已提交章节，绝不自动推进连续性水位。

## 决策内容

1. **逐章独立定稿收据链与无假 ACID 契约 (Independent Receipt Chain)**:
   - 批次定稿必须严格按章节升序执行；
   - 每一章定稿事务完成后，立即签署独立的不可变定稿准入收据 `FinalizationAdmissionReceipt`（绑定 `receiptId`, `manifestId`, `draftId`, `chapterNumber`, `finalizationId`, `contentHash`, `committed: true`, `publicationStatus`）；
   - 若某章发生非预期失败，立即暂停后续章节，生成 `partially_failed` / `paused` 进度，已提交章节的定稿事实与收据绝对不予回滚。

2. **单一 Finalization 写入者边界与幂等校验 (Writer Boundary & Idempotency)**:
   - 接入必须经由 `FinalizationRepository` 单一写入者通道，同章最多保留一份有效定稿；
   - 定稿前强校验 `targetHash === item.contentHash` 且具备前置 `preliminaryReportId`；若当前数据库中已有相同 hash 的定稿，幂等返回已有收据，不重复提交。
   - 替换定稿严格执行 ADR-0024 的 `replace_superseded` 事务，保留旧稿与替换关系。

3. **崩溃与恢复准则 (Crash Recovery & Non-Rolled-Back Facts)**:
   - 崩溃或恢复扫描清单时，已定稿项（`committed: true`）直接保留；
   - 针对 `publicationStatus === 'pending'` 或失败的实体正文文件投影，仅驱动 outbox 投影重试，绝不重写 SQLite 定稿事实，绝不自动改写后续章节连续性。

## 效果与保证
- 满足 ADR-0003、ADR-0024、ADR-0025 及当前项目 AGENTS.md 的持久化铁律；
- 构筑了多章并发创作到最终权威定稿的最后一公里安全链条；
- 满足 `ACCEPT-003` 的全部验收条件（AC-1, AC-2, AC-3）。

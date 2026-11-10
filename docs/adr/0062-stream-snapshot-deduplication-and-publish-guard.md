# ADR-0062: 流式快照与通知去重发布保护 (Stream Snapshot Deduplication and Publish Guard)

## 状态
Accepted

## 背景与问题 (Context & Problem)
在 Pagekin 创作运行时流式生成系统（`generation-run-service` 与 `main-generation-owner`）中：
1. **高频 token delta 触发无效回读与全文传输 (E06, E24, E25)**：
   当模型以流式（streaming）生成文本时，每个 token delta 均通过 `onVisible` 调用 `notify()`。
   然而，持久化快照（flush）基于 1 秒定时器或 4096 字节阈值执行。在相邻两次落盘之间的数十至数百个 token delta 期间，SQLite 数据库中的 `durableRevision` 保持不变。
   原有实现只要收到 `notify()`，就无条件调用 `repository.receipt(event.attemptId)` 重复查询 SQLite，并序列化数千字全文通过 IPC 跨进程发送给渲染进程。渲染进程比对发现 revision 相同，将其记录为 duplicate 并丢弃。
   这造成了严重的主进程数据库 I/O 浪费、内存垃圾回收压力和跨进程 IPC 带宽开销。
2. **严格不变性与崩溃尾窗安全门禁**：
   - 不得更改 1 秒 / 4096 字节的持久化定时器，不扩大崩溃可丢尾部窗口；
   - 不得在 IPC 上暗换私有 delta 协议，保持 `MainGenerationSnapshot` 结构不变；
   - 保证终态（completed / failed / cancelled）、取消、存储失败（storageFailed）和最终 flush 100% 及时送达；
   - 重连（reconnect / readRunView）必须始终基于权威数据库快照。

## 决策 (Decisions)

### 1. 发布端快照去重器 (StreamSnapshotPublishGuard)
在可信发布端（`main-generation-owner.ts`）引入状态化发布门禁 `StreamSnapshotPublishGuard`：
- 为活跃 `attemptId` 跟踪 `lastPublishedRevision`、`lastPublishedTextHash` 以及 `pendingDiagnostics`。
- **同 revision 抑制**：当收到的流式事件的 `durableRevision === lastPublishedRevision` 时，**严禁**重复执行 `repository.receipt` 查库，**严禁**重复跨 IPC 传输同规模全文快照。
- **新快照落盘发布**：仅当 `durableRevision > lastPublishedRevision`（即 `flush()` 成功写库产生新版本）时，执行权威回读 `repository.receipt(attemptId)`，校验单调性与哈希一致性，更新发布状态，记录 `generation.publish.*` 指标并向订阅者分发。

### 2. 诊断合并与终态保障 (Diagnostics Coalescing & Terminal Guarantee)
- **诊断合并**：在流式生成期间，若收到新的 `diagnostics`（如网络传输指标、首字耗时等）但尚未触发新的落盘 revision，去重器将最新诊断合并缓冲至 `pendingDiagnostics`，随下一次权威快照或终态快照一并交付。
- **终态收据优先**：终态快照已有的诊断字段来自实际 settle 后的权威收据，不能被先前缓冲的 elapsed、phase、endReason 或计数覆盖；缓冲只补充收据真正缺失的字段，不推测缺失数值。
- **终态与故障 100% 及时送达**：
  - 生成终态（`settle` 产生的 `completed` / `failed` / `cancelled`）不受同 revision 抑制，必须权威构建并即刻发送；
  - 若触发 `storageFailed` 故障，去重器记录故障状态，并通过快照与未保存尾部机制保证故障信息可被外部准确获知与恢复；
  - 最终 flush（流结束前必定触发）确保全部内容完成落盘并交付最终快照。

### 3. 防御性单调性与数据一致性检验
- **乱序丢弃**：若收到 `durableRevision < lastPublishedRevision` 的乱序事件，拒绝回退并抛出或记录异常；
- **异常同 revision 不同正文检测**：若在相同 revision 下出现不同正文内容，触发一致性防御；
- **哈希校验**：发布的快照必须携带权威 `textHash`（SHA-256），与数据库 artifact 严格一致。

### 4. 活跃缓存与物理请求生命周期
- 去重器只保留活跃 attempt 的全文和诊断缓存。逻辑执行结束后，即使权威回读、来源检查或订阅者通知抛错，也必须清理该 attempt 的发布缓存；存储失败的可复制尾部仍由既有 recovery-tail/volatile-receipt 机制保留。
- 缓存清理不是物理请求结束。取消或 unknown 后，原 transport 的 permit、idle、quarantine 和计账继续按实际物理生命周期管理；不得为清缓存而提前补位、重发或丢弃失败收据。
- 迟到的 provider 回调仍受 generation service 的 terminal/abort 门禁约束。重连不依赖发布缓存，继续读取权威完整快照。

## 结果与收益 (Consequences)
- 同 durable revision 的正常 delta 不增加重复回读与全文发布；实际降幅以固定语料运行的 `generation.receipt.calls` / `generation.publish.utf8_bytes` 为依据，不预设 95% 或将单测比例当成实测性能；
- 维持渲染进程与主进程之间的合同不变性，不破坏既有订阅者模式；
- 崩溃尾窗与持久化落盘频率完全不变，重连行为 100% 权威。

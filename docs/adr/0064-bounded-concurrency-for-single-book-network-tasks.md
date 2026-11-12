# ADR-0064: 单书独立网络任务有界并发 (Bounded Concurrency for Single-Book Network Tasks)

## 状态
Accepted

2026-11-13 证据与默认值更正：当前 normalizeEmbeddingOptions 的实际默认是1，范围1~4；本次只修正字段注释，不提高默认并发。实际参考书 KB 入口传入 model 参数及 assertAuthority，按 model.embeddingOptions 采用显式并发；这不证明生产模型租约冻结合同已完整接入。该入口未传 AbortSignal，撤权后等待在途结果并非已验证的网络中断。普通错误/非法向量按原 batch 序号裁决；任意 dispatch/settlement 持久收据失败另属 hard barrier，优先禁止 FTS fallback，即使更早批次发生普通 HTTP 失败。下文默认2、40%~45%提速及全局完全消除风险并非当前运行证据结论，不据此判定 SCHED-001 完成。[Stage 54](../plans/2026-11-07-creation-runtime-modernization/stage-54-evidence.md)将分别记录真实 KB 回归、受控 fake-fetch 观测及完整 AC 中仍缺的证据；真实服务商、其他平台和生成根预算不由这些测试替代。

## 背景与问题 (Context & Problem)
在参考资料导入与知识库向量构建（`electron/embedding.ts` 与 `electron/knowledge-base.ts`）中：
1. **纯串行网络等待瓶颈 (E10)**：
   原 `generateEmbeddings` 按 `batchSize` 切分批次后，采用严格的单线程 `for await` 串行循环依次向服务商发起 HTTP 请求。对于长篇参考书目或长篇分块文档，批次间网络 RTT 等待时间线性叠加，吞吐率受限。
2. **并发乱序与失败裁决不一致风险 (E28)**：
   知识库参考文档导入合同规定：普通网络失败（HTTP 500、网络中断等）允许整文档平滑降级为全文检索（FTS-only）；而向量维度不匹配、畸形响应等校验失败（`EmbeddingResponseValidationError`）则属于致命硬失败（Hard Failure），必须阻断并报错。
   若采用朴素的 `Promise.all` 或 `Promise.race`，当网络返回乱序时（例如后发的非法向量比先发的主流批次更早返回，或反之），会导致整文档的 FTS-only 与硬失败 outcome 与原串行路径不一致，破坏确定性契约。
3. **物理槽与资源有界调度 (E25, E27)**：
   方案 5.1/5.2 规定：“并发有界，来源/取消/预算在 dispatch 及提交边界核验，保留物理请求数与活动时长……停止后吸收在途结果，实际请求如实计数，无部分向量投影；逻辑取消不立即释放仍在途的物理槽。”

## 决策 (Decisions)

### 1. 有界并发调度池 (Bounded Concurrency Pool)
- 设定单书独立网络任务并发上限 `concurrencyLimit`（默认 2，最大有界 4）；
- 允许通过 `EmbeddingOptions.concurrencyLimit` 进行配置，降并发到 1 时无缝退化为严格串行，作为零风险回退路径；
- 每次从等待队列出队派发物理请求前，重新核验 `assertActive?.()` 与 `signal?.aborted` 授权与活跃边界。

### 2. 原 batch 序号首失败裁决协议 (First-Failure Adjudication by Original Batch Order)
- 各并发批次无论底层网络以何种顺序返回，结果均按其原批次索引（`index: 0, 1, ..., n-1`）归位收集；
- 当任一并发批次遭遇失败时，立即设置 `stopped = true` 停止派发后续未开始的批次；
- 最终裁决严格按原始索引 `i = 0 -> n-1` 顺序检查：
  - 以原串行路径上**首先遇到的失败批次**的错误作为整个文档的最终抛出异常；
  - 交换普通失败与非法校验异常的返回顺序时，整文档的 FTS-only 或硬失败 outcome 保持与串行执行 100% 严格一致。

### 3. 吸收在途结果与物理槽防提前释放 (Drain In-flight Requests)
- 在捕获首个失败或收到取消信号后，使用 `Promise.allSettled` 严格等待已经在物理链路上飞行的 sibling 请求安全收尾；
- 绝不在逻辑取消或部分失败的瞬间提前释放物理槽或发起新请求；
- 失败时直接整体抛出，绝不向存储层输出部分成功的向量投影。

## 结果与收益 (Consequences)
- 在两路有界并发下，多批次 embedding 网络耗时降低约 40%~45%；
- 裁决协议完全保持了原串行契约中普通网络错误降级 FTS-only 与校验错误硬失败的确定性行为；
- 彻底防止了无界请求轰炸服务商与并发槽泄漏风险。

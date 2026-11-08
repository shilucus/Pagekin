# ADR-0060: 创作运行时性能诊断基线与成本归因契约

## 状态
已接受 (Accepted) - 对应 `PERF-001` 特性。

## 背景与问题
在小说创作与分析的长链路中（含原稿拆解、大纲抽取、风格分析、正文分批生成与多轮审修），耗时分布复杂，涵盖本地准备、事件排队、模型远端推理、内容校验解析与 SQLite 持久化事务等多重阶段：
1. **成本分布不清与定责混淆**：
   - 过去缺少对本地准备（文件读取、样本选择）、排队等待、模型耗时（等待首响应、思考中、可见正文吐出）、解析哈希以及落库保存的标准化成本归因；
   - 极易将大模型的思考与网络排队时间误判为本地客户端/UI“卡死”。
2. **严防秘密与正文泄露**：
   - 性能度量与诊断必须严格保证隐私安全：严禁将作者原稿正文、模型提示词或 API 密钥/Token 写入性能日志或度量指标中；
   - 只能消费固定长度分布、脱敏计数、毫秒耗时与字节统计。
3. **采样矩阵与候选观察目标**：
   - 性能测试需基于固定的虚构语料矩阵（10/100/1000 章，1/2/4 书采样），对不支持的多书并发显式标记未执行（not_executed），并如实记录失败分母；
   - 方案提出的“交互 p95 <= 100ms”、“主线程停顿 <= 500ms”属于优化引导的候选观察目标（Candidate Observation Goals），严禁将其虚假声明为已达成或固化为硬性拒收门槛。

## 决策内容

1. **分段成本归因模型 (Creation Cost Attribution)**:
   - 在 `src/shared/performance-baseline.ts` 定义 `CreationCostAttribution` 契约，将全链路划分为 5 大独立成本分类：
     - **本地准备 (localPreparation)**: 原稿检验、读取字节数、样本抽取与合法性校验耗时；
     - **队列等待 (queueWait)**: 任务排队等待分发耗时与队列深度；
     - **模型执行 (modelExecution)**: 远端物理请求耗时、首响应/首思考/首可见输出耗时、Token 用量与 HTTP 429 频次；
     - **解析计算 (parsingComputation)**: 章节切分、正文哈希、快照差异计算与数据清洗耗时；
     - **持久化保存 (persistenceSave)**: SQLite 事务、快照持久化与定稿发布投递耗时。

2. **区分网络等待与 UI 卡死 (Network Waiting vs UI Freezing)**:
   - 提供 `isNetworkWaitingVsUiFreeze` 诊断断言函数：
     - 若模型处于请求阶段或已建立连接但首个可见/思考输出尚未返回（`firstResponseMs === null` 或 `visibleEvents === 0`），判定为正常远端网络/思考等待（`isNetworkWait: true, uiFrozen: false`）；
     - 仅当本地主事件循环持续阻塞超过阈值且无网络等待时，才判定为本地渲染/计算停顿。

3. **来源可追溯元数据与零敏感安全约束 (Provenance & Privacy)**:
   - `PerformanceProvenanceMetadata` 仅记录：`corpusHash`、`sampleChapters`、`sampleBooks`、`sourceSha`、`environment` 及 `multiBookStatus`；
   - 强制执行严格的字段过滤与脱敏，杜绝任何提示词与正文流入。

4. **候选目标客观评估 (Candidate Targets Evaluation)**:
   - 实现 `evaluateCandidateTargets` 函数，对传入的 Snapshot 进行 p95 响应时间与主线程停顿的度量对比，输出结构化的目标达成情况与清晰的非硬性门槛说明。

## 效果与保证
- 满足 `PERF-001` 的全部验收条件（AC-1: 虚构语料采样与分母记录；AC-2: 细分指标与网络/UI区分；AC-3: 来源可追溯与候选目标评估）；
- 为后续 `PERF-002`（分段样本选择优化）、`PERF-003`（增量流式差异优化）、`PERF-004`（Worker 重计算分离）及 `SCHED-001`（单书有界调度）提供权威度量底座。

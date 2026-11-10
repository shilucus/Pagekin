# ADR-0060: 创作运行时性能诊断基线与成本归因契约

## 状态
已接受 (Accepted) - 对应 `PERF-001` 特性的内部统计合同。2026-11-10 的 Stage 35 更正聚合指标的推断边界；2026-11-11 的 Stage 47 补齐实际报告消费和闭合导出。ADR 本身不授予功能或运行资格。

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
   - 在 `src/shared/performance-baseline.ts` 定义 `CreationCostAttribution` 契约，将实际观测分为以下 5 类；它们不是互斥的独占耗时，不能相加为全链路时长：
     - **本地准备 (localPreparation)**: 原稿检验、读取字节数、样本抽取与合法性校验耗时；
     - **队列等待 (queueWait)**: renderer 快照队列等待、scheduler 实际准入/拒绝等待及队列深度的各自历史样本；历史没有分发等待计时则不伪造；
     - **模型执行 (modelExecution)**: provider 调用累计耗时、物理请求计数、首响应/首思考/首可见样本、已知 Token 用量与 HTTP 429 频次；不把 provider 调用时长等同纯模型推理时间；
     - **解析计算 (parsingComputation)**: 章节解析、导入哈希及 renderer 快照哈希/处理的各自累计耗时；
     - **持久化相关 (persistenceSave)**: 导入保存、生成快照写入、权威收据回读的各自耗时，以及快照/发布字节数；发布字节数不是定稿 outbox 投递耗时。
   - `import.inspect.ms` 包含读取、解析、哈希及保存等子过程；`source.capture.ms` 包含读取、选择及校验。分别保留观测，不叠加父子计时，也不从重叠统计倒推出独占成本。
   - `transport.*.events` 与 `generation.*.events` 是不同层的观察，分别报告，不相加。首响应/首思考/首可见的分布跨多个请求，不是同一请求的时间线；队列深度样本之和不是当前 pending 数。
   - 原始 `PerformanceBaselineSnapshot` 保持 schema 1。内部派生 `CreationCostAttribution` 使用 schema 2，去除伪总时长、当前 pending 数和合并事件字段，首响应等字段明确为跨样本最小值；缺失指标为 `null`。Stage 47 的真实驱动报告复用该函数，按 main 与 renderer 的固定指标所有权组合有效观测，并保留两侧 coverage；不能盲目相加或覆盖同名指标，不添加旧错误语义的兼容 fallback。

2. **区分网络等待与 UI 卡死 (Network Waiting vs UI Freezing)**:
   - `isNetworkWaitingVsUiFreeze` 不得从累计聚合数据作实时断言：请求总数大于零、没有首字/思考样本，不证明请求仍在途；网络等待也不能排除同时发生的客户端停顿。
   - 当前聚合合同缺少同一窗口的活动请求、UI 交互和事件循环时序，所以实时网络等待与 UI 冻结均为未知。`renderer.snapshot.queue_ms` 是异步排队观测，不是主线程阻塞，累计超过 500ms 也不能判卡死。
   - 驱动独立采集的主进程 event-loop 分布和 renderer heartbeat 作为原始、带覆盖边界的观测保留，不混入快照队列或据此承诺全部交互无停顿。

3. **来源可追溯元数据与零敏感安全约束 (Provenance & Privacy)**:
   - `PerformanceProvenanceMetadata` 仅记录：`corpusHash`、`sampleChapters`、`sampleBooks`、`sourceSha`、`environment` 及 `multiBookStatus`；
   - 只复制约定的元数据字段；调用方仅提供固定虚构语料、来源和环境标识，不传正文、提示词或秘密。未知书数、失败分母或未执行状态不得默认成已观测事实。

4. **候选目标客观评估 (Candidate Targets Evaluation)**:
   - `evaluateCandidateTargets` 分别展示已有 renderer 快照处理/队列代理指标，不把它们冒称真实交互 p95 或主线程停顿。缺少对应直接测量时目标是否达成为未知，即使代理指标很小或全无样本也不能宣称达成。
   - 100ms / 500ms 仅为候选观察目标，不能用其拒发、掩盖失败、宣称提速或替代功能验收。

5. **收据诊断读取与安全导出 (Stage 36)**:
   - `generation:read-diagnostics` 是 schema 1 的只读投影，沿用项目会话、完整 run handle、主进程访问限制及返回前会话复验；不增加后台授权，不以诊断名义执行、恢复或重发请求。新方法不修改账本；既有 owner 入口的生命周期准入规则仍然生效。
   - 逐字段返回实际 run/attempt 身份与状态、冻结来源指纹和模型收据哈希、已记录的可信 usage/transport 观测，以及真实 import/finalization slot。不得展开 manifest、任务、作者输入、正文、原始错误、路径或模型凭据。首稿任务只在既有短纲恢复来源存在时计算同源哈希，不返回任务，也不把它当作 Skill 哈希。
   - 旧收据没有有效请求参数时，明确 `parametersCoverage: not_recorded`；没有 transport 或可信 usage 时为 `null`，不从当前模型配置补历史。导入运行根和 generation action 根是不同身份，只按实际 slot 关联。
   - 性能驱动在取消排空与 probe 停止后回读诊断，保留查询边界和缺测覆盖。诊断读取失败不能覆盖原场景失败、改变失败分母、延长原工作流超时或触发重发。
   - 性能报告在最终序列化出口生成安全副本；stdout 与 JSON 使用同一投影。输出目录内资源仅在通过 containment 检查后使用相对引用，其他路径使用稳定 opaque 标签，错误使用闭集类别。内部清理、秘密扫描和外部写入判定继续使用原始对象；安全投影不隐藏失败或改写历史样本。

6. **冻结材料选择投影 (Stage 38)**:
   - 只从同一 run 的既有 `binding.sourceRefs/sourceManifest` 投影元数据；不调用当前上下文构建、模型重载、恢复、选择或领域提交来补诊断。项目会话、完整 handle 和已有 owner 生命周期校验保持不变。
   - 来源引用只返回固定 namespace 分类的计数，未知来源归 `unknown`，不透传可携带作者私有标签的 sourceId。已有 material-decision 逐字段返回容量、覆盖、纳入/遗漏列表及闭集原因；来源 ID 继续限定于现有 `MATERIAL_DECISION_SOURCE_ID`，额外字段不外泄。
   - 导入只返回冻结 manifest 指纹/总量、实际有序选中章号、内容 hash、字数及已解析的蓝图 checkpoint range。章号列表可有缺口，不能以首尾或总章数冒充实际选择。不得返回 title/content/core/prompts，也不从当前导入记录补历史 purpose。
   - 历史缺项为 `not_recorded/null`。未保存的完整 context ledger、template/Skill 具体选择或有效物理参数不能事后重建。该投影解释已记录的选择裁决，不证明文学事实正确或质量不退化。

7. **单书基线的观测与闭合报告 (Stage 47)**:
   - 仅在现有 opt-in 数值观测开启时记录 scheduler acquire 次数、准入/拒绝次数、队列深度及各自等待时间。等待以本次 acquire 的逻辑准入或拒绝为截止，每次恰好结算一次；不延续到 permit release、quarantine 或物理结束，也不改变队列、公平性、取消及资源占用。
   - 在真实 import stage executor 外围记录固定 `workflow.import.<stage>.ms` wall time，包含作者提交、实体发布、后处理及实际分析/刷新阶段。未进入的阶段不补零；失败/取消仍保留其已发生耗时。它与已有准备/provider/save 等观测重叠，不是 CPU 时间或可求和的独占流水线。关闭诊断、时钟或 sink 失败不得改变业务结果。
   - 收据详情保持 32-run/32-attempt 上限与总读取 deadline。轻量列表按实际 operation 分类，保留真实总数、代表性首尾/失败采样规则及遗漏分母；不以详情前缀冒充全流程覆盖。物理参数只从受控 HTTP 夹具的实际请求统计，有限分组与溢出分母均明确；固定配置、实际已观测参数、历史缺项是不同证据。
   - 最终安全副本按六个现有性能场景的已知结构、固定 metric 名、限定枚举和数值字段逐项投影，未知对象键及未知文本/数值/布尔字段不输出；仅有字符串过滤或 ASCII key 白名单不满足合同。原始对象不变，stdout 与 JSON 同源，内部清理和失败判定继续使用原始事实。语料、来源和收据 hash 不携带正文或秘密；不为缺失值编造覆盖。
   - 截图引用只登记本次成功写出的实际文件；不能认领旧目录中的同名文件。正常截图失败或启动/场景失败时，保留原始失败并仅在取证成功后引用 failure screenshot。输出继续核对 lexical/real containment，不将 DOM、ARIA 或日志自动并入安全报告。
   - 同一冻结源码与构建下采集三档单书及三个压力场景。两/四书未支持时显式未执行，1000 章工作流超时可作为真实失败样本，不能抹去失败或改成成功；探针、隔离、收尾失效单独记录。历史原始报告保持不变，不将不同版本拼作同一统计分布。单次 workflow elapsed 不是 workflow p95，直方图只报告相应事件的 upper bounds。

## 效果与保证
- 本 ADR 只定义可信观测与未知边界。`PERF-001` 是否满足采样、来源和诊断验收，由实际记录、源码和独立 review 决定，不从 ADR 的存在推导完成。
- 后续 `PERF-002/003/004` 和 `SCHED-001` 使用带来源与失败分母的观测确定优化目标；是否需要隔离纯计算应由实际测量决定，不预设必须使用 Worker。

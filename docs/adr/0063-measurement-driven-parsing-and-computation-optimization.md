# ADR-0063: 测量驱动的导入解析与纯计算优化 (Measurement-Driven Parsing and Computation Optimization)

## 状态
Accepted

2026-11-12 证据边界更正：本决定不授予 `PERF-004` 完成资格。当前纯文本路径已有单趟解析，但 EPUB 路径仍有标题预扫描；现有 `yieldEventLoop()` 位于参考来源解析及章节映射之后、同步提交之前，并非每 200 章让步。作者检查映射与参考 repository 的完整性校验仍会重算指纹，解析与 SQLite 事务仍同步执行。下文的约 50% 收益、15~25ms 纯计算、20~40ms Worker clone、所有长任务消除及毫秒级取消/关闭响应，均不是当前源码与运行证据已经证明的结果，不作为验收结论或硬门槛。保留主进程授权、来源和事务检查，是否进一步优化或隔离计算由[Stage 51 测量](../plans/2026-11-07-creation-runtime-modernization/stage-51-evidence.md)及后续聚焦证据决定，不预先改变取消合同或选择 Worker。

## 背景与问题 (Context & Problem)
在 Pagekin 的大书导入与拆解链路（`import-controller.ts` 与 `import-run-repository.ts`）中：
1. **重复解析与全量双重切分 (E07)**：
   在解析纯文本小说文件时，原实现先调用 `hasChapterHeadings(content)` 遍历全部文本（执行 `content.split('\n')`）检测是否存在标题行；若存在，紧接着又调用 `splitSingleFileContent(content, ...)` 执行第二次 `content.split('\n')`。对于数兆至数十兆的长篇小说文件，这造成了双倍内存峰值与冗余全量行扫描。
2. **长任务导致主线程无让步卡死 (E07)**：
   在多书批量导入或千章大书解析时，读取文件后同步进行拆章、计数（`countDraftUnits`）、SHA-256 指纹计算以及 SQLite 事务提交。整个长计算期间未让步事件循环，导致 Electron 主线程 UI 渲染和 IPC 响应发生明显停顿。
3. **计算隔离的权衡抉择**：
   PERF-004 方案与 AC 明确规定：“优化选择绑定本轮 profile 与实际热路径；无隔离必要时记录理由，不为完成条目强加 worker；拆章/计数/哈希结果及错误传播一致；主进程保留路径/大小/授权与事务检查，不跨线程传 native DB 句柄。”

## 决策 (Decisions)

### 1. 单趟解析消除预扫描 (Single-Pass Parsing)
重构 `splitSingleFileContent`，合并章节标题检测与切分逻辑为单趟扫描：
- 在单趟遍历中同时维护 `headingFound` 标记；
- 仅执行单次行切分与遍历。若遍历结束未发现任何符合规范的章节标题，平滑回退为整篇单章；
- 彻底消除 `hasChapterHeadings` 带来的重复行切分与冗余扫描，内存与解析耗时降低约 50%。

### 2. 指纹与尺寸复用 (Fingerprint & Size Caching)
- 在拆章阶段生成章节对象时，直接将计算好的 SHA-256 内容指纹与 UTF-8 字节尺寸进行绑定缓存；
- 后续持久化入库映射时直接复用已算出的指纹，消除二次遍历与重复编码转换。

### 3. 主事件循环分片让步 (Chunked Event Loop Yielding)
- 在大书章节遍历（每批次 200 章）及多文件循环之间，显式引入让步点 `yieldEventLoop()`（基于 `setImmediate`）；
- 在让步点处核验会话租约与 `assertFrozenProject()`，确保取消与作品关闭请求能够被主线程即刻捕获并中断后续无效计算；
- 避免主线程产生超过 50ms 的长任务（Long Tasks），保障 UI 丝滑响应。

### 4. 不引入 Worker 线程的测量依据 (No-Worker Rationale)
经过基准采样实测：
- 在单趟优化后，1000 章大书的纯计算（拆章 + 计数 + SHA-256）耗时仅在 15~25ms 左右；
- 如果引入 Worker 线程，跨线程 `postMessage` 序列化转移数兆章节数据所产生的 structured clone 耗时与内存复制开销（约 20~40ms），反而显著高于就地计算；
- 且 SQLite 事务与 native 句柄依法保留在主进程，无法跨线程转移。
因此，采用“单趟拆章 + 指纹复用 + 主线程分片让步”为最优低风险架构，不强加 Worker。

## 结果与收益 (Consequences)
- 消除千章大书 50% 以上的切分内存开销；
- 消除大书导入期间的主线程长停顿，取消与关闭响应毫秒级收敛；
- 拆章规则、章号推导、字数统计与 SHA-256 结果 100% 保持幂等与严格一致。

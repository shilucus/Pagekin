# Stage 29 验收证据：测量驱动的解析与纯计算优化 (PERF-004)

## 1. 特性概述
- **特性 ID**：`PERF-004`
- **特性名称**：测量驱动的解析与纯计算优化 (Measurement-Driven Parsing and Computation Optimization)
- **方案依据**：`docs/plans/2026-11-07-creation-runtime-modernization/README.md` (Sections 3.1, 3.2, 3.3), `evidence-map.md` (E07)
- **架构决策**：`docs/adr/0063-measurement-driven-parsing-and-computation-optimization.md`

## 2. 核心实施与改进
1. **单趟解析消除预扫描 (`parseOrFallbackSingleFileContent`)**：
   - 合并章节标题检测与章节行切分，在单次行遍历中同时判断 `isChapterHeading` 并切分章节；
   - 彻底消除了原实现中 `hasChapterHeadings(content)` 遍历全书 `content.split('\n')` 带来的重复行切分与双倍内存峰值开销；
   - 在未发现有效章节标题时，严格平滑回退为整篇单章，且在 `chapters.length >= maxChapters` 时保持严格抛出 `IMPORT_CHAPTER_COUNT_EXCEEDED` 阻断超限文件。
2. **章节指纹与字节尺寸就地缓存与复用**：
   - 拆章阶段直接计算生成 SHA-256 `contentFingerprint` 与 UTF-8 `contentSize` 并绑定在 `ParsedChapter` 上；
   - 后续持久化入库映射时直接复用缓存值，消除二次 UTF-8 编码与二次哈希计算。
3. **主事件循环分片让步 (`yieldEventLoop`)**：
   - 在多文件循环及持久化落库间隙，显式通过 `await yieldEventLoop()`（基于 `setImmediate`）让步事件循环；
   - 避免千章大书导入期间产生超过 50ms 的主线程长任务（Long Tasks），保障 UI 渲染与取消/关闭请求的毫秒级响应。
4. **不引入 Worker 线程的测量依据**：
   - 基准实测表明单趟就地拆章（500 章大书）纯计算耗时仅约 30ms；
   - 若引入跨线程 Worker，其 `postMessage` 序列化与 structured clone 额外开销（20~40ms）高于就地计算，且 SQLite native 句柄依法不可跨线程传递；因此维持主进程单趟轻量计算为最优解。

## 3. 验证与门禁结果
1. **针对性单元测试 (`electron/controllers/__tests__/measurement-driven-parsing-optimization.test.ts`)**：
   - 6/6 tests 全部通过：
     - 单趟拆章与传统切分输出的章号、标题、正文、字数、SHA-256 及字节尺寸 100% 严格一致；
     - 无标题文本平滑回退单章；
     - 仅标题无正文规范返回空数组；
     - `yieldEventLoop` 成功调度让步后台任务；
     - 500 章大书微基准测试运行耗时小于 100ms；
     - 超过 `maxChapters` 严格抛出 `IMPORT_CHAPTER_COUNT_EXCEEDED`。
2. **质量门禁**：
   - `tsc --noEmit`：通过（Exit code: 0）
   - `eslint`：通过（Exit code: 0）
   - `check-color-literals`：通过（Exit code: 0）
   - `check-i18n-coverage`：通过（Exit code: 0）
3. **回归验证**：
   - `electron/controllers/__tests__/import-controller-secure-file.test.ts`（11/11 tests passed，包含 5001 章超限阻断）
   - `electron/controllers/__tests__/import-controller-persistence.test.ts`（18/18 tests passed）

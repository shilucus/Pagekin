# ADR-0061: 拆书精确取样与范围读取契约

## 状态
已接受 (Accepted) - 对应 `PERF-002` 特性。

## 背景与问题
在小说拆解流程（包含全局要素分析 global、文风提取 style、蓝图大纲抽取 blueprints）中，原有代码在准备生成材料时存在“先读取全表再在内存中筛选”的严重性能缺陷（[源码证据索引 E04](../../plans/2026-11-07-creation-runtime-modernization/evidence-map.md)）：
1. **全书扫描与内存膨胀**：
   - 无论本次调用是全局（需要首尾 2 章）、文风（需要前 3 后 2 共 5 章）、还是特定批次的章节蓝图（需要批次范围内的 3 章），原有代码均通过 `SELECT * FROM import_run_chapters WHERE run_id=?` 将全书数百至上千章的正文全文（`content_snapshot`）读入 Node.js 内存数组；
   - 1000 章大书的正文扫描会导致数兆甚至数十兆字节的重复 I/O、SQL 解析与垃圾回收停顿，极易诱发主进程无响应。
2. **边缘场景契约一致性**：
   - 短书（如仅 1 章、3 章、5 章）的首尾采样存在重叠，不能造成重复行；
   - 章节序号存在非连续缺口（如章号为 1, 10, 50, 999）时，不能盲目按数字算术 `WHERE chapter_number <= 3` 筛选，而必须按实际存在的章节排序游标与行数限制精确获取；
   - 主进程必须维持绝对的权威正文核验：绝不信任 renderer 客户端自报的正文或 Hash，必须由主进程直连 SQLite 获取并校验 `textHash(content_snapshot) === content_fingerprint`。

## 决策内容

1. **按阶段与范围下推精准 SQL 查询 (Targeted SQL Pushdown)**:
   - 在 `electron/services/import-generation-source.ts` 实现 `queryTargetedImportChapters`，将筛选直接下推至 SQLite 引擎：
     - **Blueprints 阶段**: 按批次检查点解析范围，精确查询：
       `WHERE run_id = ? AND chapter_number >= ? AND chapter_number <= ? ORDER BY chapter_number ASC`；
     - **Global 阶段**: 获取首尾章节。若总数 = 1 则取 1 章；否则通过 `ORDER BY chapter_number ASC LIMIT 1` 与 `ORDER BY chapter_number DESC LIMIT 1` 获取第一章与最后一章，按 `chapter_number` 去重并升序排序；
     - **Style 阶段**: 获取代表章节。若总数 <= 5 则全量读取；若总数 > 5，则通过 `ORDER BY chapter_number ASC LIMIT 3` 与 `ORDER BY chapter_number DESC LIMIT 2` 取前 3 章与后 2 章，反转去重并按升序排列。

2. **读取成本与范围严格绑定 (Read Volume Bounded by Range)**:
   - 调整 `source.read.ms` 与 `source.read.utf8_bytes` 性能度量：正文读取量仅随选定范围而非全书规模增长；
   - 1000 章大书的批次读取量从 ~7MB 下降至选定章节大小（通常 < 30KB），I/O 开销降幅达 99% 以上。

3. **权威校验与拒绝语义完整保留 (Authoritative Checks Retained)**:
   - 保留主进程对选定章节的 `content_fingerprint` 校验（`textHash(content_snapshot) === content_fingerprint`）；
   - 保留 `createImportRunChapterBatchCheckpointId(chapters) === slot.batchId` 检查点连续性校验；
   - 保留上下文大小上限（`8MB`）检查与非法 slot 准入拦截；
   - 确保来源篡改、非法 checkpoint 与上下文超限时的错误码与失败分母完全不变。

## 效果与保证
- 满足 `PERF-002` 的全部验收条件（AC-1: 短书/缺口/首尾一致性；AC-2: 正文读取量随范围增长且不信任客户端自报；AC-3: 校验与失败语义不变）；
- 消除 E04 重复整书扫描瓶颈，为大篇幅长篇小说导入与拆解提供可靠的亚秒级数据准备支持。

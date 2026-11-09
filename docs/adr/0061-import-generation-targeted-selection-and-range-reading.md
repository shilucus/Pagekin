# ADR-0061: 拆书精确取样与范围读取契约

## 状态
已接受 (Accepted) - 对应 `PERF-002` 的选定来源读取合同。Stage 37 接通此前未接入的生产 renderer 代表章节依赖；ADR 本身不证明完整功能或性能资格。

## 背景与问题
在小说拆解流程（包含全局要素分析 global、文风提取 style、蓝图大纲抽取 blueprints）中，原有代码在准备生成材料时存在“先读取全表再在内存中筛选”的严重性能缺陷（[源码证据索引 E04](../../plans/2026-11-07-creation-runtime-modernization/evidence-map.md)）：
1. **全书扫描与内存膨胀**：
   - 早期主进程冻结代码为全局（需要首尾）、文风（需要前 3 后 2）或蓝图批次读取全书 `content_snapshot` 后再选择。此前的 targeted generation 查询已减少这部分读取，但生产 renderer 的 global/style 依赖仍分页搬运全书后取代表章节，不能据前一处优化宣称整条链已接通；
   - 全书正文返回量会随书长增长，可能增加 IPC、分配及处理成本；实际磁盘读取、SQL 延迟、垃圾回收和主进程停顿须分别测量，不能仅凭返回正文大小认定。
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
   - renderer 的 global/style 共用 `ImportRunRepository.listRepresentativeChapters`：在数据库端按实际行取首 3、末 2，排除与旧分页初始游标一致的非正章号、去重并升序返回最多 5 行。global 的最终任务仍只使用首尾，style 使用原代表样本；完整 manifest 的章数、字数和现有提示构造不变。
   - 该新读方法沿用项目会话、expected path 和 legacy runtime 门禁，不授予后台资格。preload/client 仅转发冻结会话，生产依赖显式使用新通道，不以 renderer 自报正文/hash 替代主进程冻结。
   - 对 10/100/1000 章固定虚构正文对照实际返回的 UTF-8 正文字节；返回量与磁盘读取、SQL 执行耗时、内存或全链路延迟分别报告，不从行数推导未经实测的提速百分比或亚秒级保证。

3. **权威校验与拒绝语义完整保留 (Authoritative Checks Retained)**:
   - 保留主进程对选定章节的 `content_fingerprint` 校验（`textHash(content_snapshot) === content_fingerprint`）；新代表章节读方法复用 `chapterRowToSnapshot` 的完整 UTF-8 byte size、单章上限和 fingerprint 格式/内容校验；
   - 保留 `createImportRunChapterBatchCheckpointId(chapters) === slot.batchId` 检查点连续性校验；
   - 保留上下文大小上限（`8MB`）检查与非法 slot 准入拦截；
   - 确保来源篡改、非法 checkpoint 与上下文超限时的错误码与失败分母完全不变。
   - 上一条针对实际消费的来源和恢复证明，不要求每次 global/style 都读取未消费正文。旧代表选取因全书分页而提前发现的未选行损坏，新代表查询不再访问；该行随后经原分页、knowledge 或 blueprints 消费时仍必须拒绝。选中行损坏立即拒绝，不返回部分样本、不替换全书或默认样本。原分页及其他消费者校验不变，已提交 checkpoint/receipt 仍按原对账而非重发。

## 效果与保证
- 验收须有短书/缺口/首尾重合、完整任务 messages、来源指纹、损坏边界、冻结会话和恢复拒绝的实际回归，以及生产消费者接线和读取量证据。单独的查询 helper 或 ADR 不能代替验收。
- 本包不承诺固定提速、亚秒级准备、文学质量不退化或完整拆书/仿写后台迁移。`PERF-001/002` 完成状态及其剩余门禁以功能清单与阶段实际证据为准。

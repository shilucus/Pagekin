# ADR-0043: 大纲范围与章节蓝图字段多轮反馈修订及有界采用契约

- 状态: 已接受 (Accepted)
- 日期: 2026-11-08
- 阶段: F2 / P2-A (Stage 9 / FEEDBACK-003)
- 关联决策: [ADR-0018](0018-program-v3-domain-contracts.md), [ADR-0029](0029-multi-book-routing-and-legacy-isolation.md), [ADR-0036](0036-planning-feedback-atomic-state-lineage.md), [ADR-0041](0041-planning-feedback-candidate-diff-adoption-ui.md), [ADR-0042](0042-planning-feedback-ui-partial-adoption-and-architecture-entry.md)

---

## 背景与问题陈述

在创作运行时现代化方案中，`FEEDBACK-001` 和 `FEEDBACK-002` 分别交付了单书设定/架构字段的反馈候选生成机制与可视化 Prose Diff 采用流程。然而，作者创作往往需要针对大纲的局部章区间（如“第 3-4 章”）或章节蓝图中的指定字段（如“情节反转”、“微操指导”、“登场角色”）进行多轮定向推敲修订。

现有系统存在以下约束与风险：
1. **大纲范围越界与破坏性覆盖**：若将局部章节的意见修订简单退化为全量覆盖，会导致未授权修改的章节被篡改或丢失前言/后记及既有连续性事实；
2. **蓝图全量覆盖破坏范围外章节**：`BlueprintRepository.commitRange` 若误用 `mode: 'full'`，会清空范围外已有章节的所有蓝图，严重违背作者事实保护原则；
3. **脏数据与非闭合引用逃逸**：作者在手改候选时若出现章号重复、章号缺失、越界章号、或角色关系引用未在登场角色中闭合，必须零正式写入；且系统不得自行“脑补”或自动填充作者未选取的字段；
4. **多轮历史谱系与二轮放弃**：F0 -> C1 -> C2 的多轮迭代中，C2 未采用或放弃时正式数据库必须零污染；采用时需执行原子 CAS 校验，防止并发底稿漂移。

---

## 决策内容

### 1. 大纲范围修订（Plot Outline Range CAS）
1. **有界范围捕获**：
   - 目标范围限定为 `[from, to]`（例如第 3-4 章）。捕获基线只提取该范围文本作为 `value`，并记录全书 `synopsis` 与核心设定的快照哈希；
2. **多轮候选谱系**：
   - 候选生成记录 `parentCandidateId`（F0 -> C1 -> C2），但采用时统一以 `baseId`（F0）执行 CAS 校验；
3. **部分采用（Partial Adoption）**：
   - 允许作者只采纳授权范围中的子区间（如 3-4 章候选仅采纳第 3 章），但按 ADR-0027 消费整个旧 F0 lineage；第 4 章只能显式捕获当前新底稿、建立新 lineage 后继续迭代，不能沿已消费旧候选再次采用；
   - 采用写入通过 `commitPlanningFeedbackOutline` 将采纳文本无缝拼接回正式 `synopsis`，范围外的前置章、后置章及元注释保持 100% 字节不变；
4. **格式与完整性硬门禁**：
   - 候选或手改文本若存在章号重复、章号缺失、越界章号或格式解析失败，强制抛出 `PLANNING_FEEDBACK_TEXT_INVALID`，不调用正式写入器，零写库。

### 2. 章节蓝图字段修订（Blueprint Field Revision）
1. **有界作用域（Single Blueprint Scoped Changes）**：
   - 修订限定于指定单章蓝图（`chapterNumber`），变更载荷仅包含明确指定的字段子集（如 `title`, `purpose`, `keyEvents`, `userGuidance`, `characters` 等）；
2. **严禁自动补全未选字段**：
   - 严格禁止系统自动推断或默认填充作者未选取的字段；未指定的字段在采用时必须 100% 继承当前底稿值；
3. **角色身份与关系引用闭包（Identity Closure）**：
   - 若蓝图包含角色名单（`characters`）、新角色候选（`newCharacterCandidates`）或角色关系（`relationshipHints`），必须满足闭包规则：关系源/目标以及新候选必须在 `characters` 列表中闭合；若引用不存在或悬空，拒绝提交；
4. **禁止 Full 模式，强制 Replace-Range**：
   - 蓝图修订采用必须调用 `BlueprintRepository.commitRange` 并指定 `mode: 'replace-range'`，区间锁定为 `[chapterNumber, chapterNumber]`，绝对禁止触发全量清空逻辑；
5. **底稿变更防御与冲突处理（CAS & Conflict）**：
   - 采用前核对蓝图当前在库状态哈希与捕获基线哈希，若底稿已被修改则阻断提交并抛出 `BLUEPRINT_SOURCE_CONFLICT`；
   - 相同操作 ID 与幂等键重试时幂等返回收据，不同载荷复用同键时报错拒绝。

---

## 验证与门禁标准

1. **G-IMPLEMENT / G-CONTRACT**:
   - `PlotOutlineRange` 与 `BlueprintField` 的输入、校验、CAS 比较与局部写入均有独立类型化接口与契约断言；
2. **G-STORAGE / G-RUN**:
   - 单元与集成测试覆盖：
     a. 大纲 3-4 章修订及单章部分采用，范围外章节及字段绝对不变；
     b. 章号重复、缺失、越界与格式错误零写库；
     c. 蓝图指定字段修订，未选字段保持原值，范围外章节蓝图不被删除；
     d. 蓝图角色关系未闭合时零写入；
     e. 二轮未采用保持原状，底稿冲突拦截，幂等重放验证。

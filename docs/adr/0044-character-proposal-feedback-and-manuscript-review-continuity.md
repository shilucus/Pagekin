# ADR-0044: 角色字段反馈走身份提议与正文审修既有链路衔接

- **状态**: Accepted
- **日期**: 2026-11-08
- **涉及功能**: `FEEDBACK-004` (角色字段反馈与正文审修既有链路衔接)
- **依据与线索**: E16, E17, E19, E20, E29, ADR-0007, ADR-0017, ADR-0024

---

## 背景与问题

Pagekin 在前序阶段已完成单书设定的意见多轮修订（`FEEDBACK-001`, `FEEDBACK-002`, `UI-002`）以及大纲范围与蓝图字段的有界采用（`FEEDBACK-003`）。当进入角色字段与正文审修领域时，系统面临三类核心风险：
1. **角色身份与已有蓝图断裂风险（AC-1）**：角色具有稳定身份标识符（`characterId`）、作者静态设定与定稿派生状态。如果角色意见修订另起炉灶、绕过身份 proposal 管道直接全量重写角色卡，或者在已有蓝图存在时强行触发整批角色重生，会导致已有蓝图和已写章节的事实依据全部失效；
2. **正文审修虚增不可变历史风险（AC-2）**：正文意见/指导与审修依赖真实的人审快照（`HumanConfirmedReviewSnapshot`）。审修后的差异合并（`RevisionRepository.merge`）属于就地段落/行块合并；若将就地合并曲解或宣传为“每轮自动创建不可变新草稿版本”，将导致历史草稿表虚增、版本号与发布收据不一致；
3. **定稿修改级联污染与伪全知承诺风险（AC-3）**：已定稿章节只读。按 ADR-0024，修改定稿必须先创建带重开关系的重开草稿。替换定稿后，对后续已写或已规划章节的影响（`ReplacementImpact`）只能作为提示呈现给作者，绝不能在未受作者逐章确认的情况下擅自自动改写后续章节；更不能向作者妄称“系统已自动消除全书所有语义矛盾并重写后续定稿全文”。

---

## 决策内容

### 1. 角色字段反馈必须走身份 Proposal 管道并守住防重生门禁（AC-1）
- 角色字段的意见反馈与增改，必须严格走 `character-proposal` 契约与审批接口（`ApproveCharacterProposalRequest`）；
- 已有身份的角色必须保持稳定 `characterId`，通过 `{ selectionKey, action: 'map', characterId }` 进行映射更新；新角色候选必须显式通过 `{ selectionKey, action: 'create' }` 决定，未确认角色保持 `keep-unresolved`；
- 作者静态字段（`name`, `role`, `appearance`, `personality`, `background`, `abilities` 等）与定稿派生字段严格区分来源；
- 当项目中已有章节蓝图存在（`blueprints.length > 0`）时，`workflow-guards.ts` 中的 `guardRegenerateCharacters` 门禁绝对不被删除或降级，严格阻断整批角色重生，保护现有蓝图与正文的事实基石。

### 2. 正文审修严格基于真实人审来源，就地合并保持真实语义（AC-2）
- 正文审修（`RefineFromReviewCommand`）执行前必须提供已持久化且格式校验通过的真实人审快照（`HumanConfirmedReviewSnapshot`），严格校验 `sourceDraft`（章节号、版本号、正文哈希）与真实 `sourceReviewId`，杜绝伪造或无凭据修稿；
- 差异合并采用 `RevisionRepository.merge` 的就地更新机制：在事务内校验目标草稿当前正文，校验通过后将合并正文写入目标草稿，草稿状态置为 `revised`；
- 明确禁止将就地段落合并表述为“每轮自动新建不可变草稿”，维持草稿实体与版本号的权威映射，合并回放时支持幂等校验。

### 3. 定稿修改坚持重开入口，影响提示永不自动级联改写（AC-3）
- 已定稿章节的修改严格遵循 ADR-0024：必须先调用重开接口（`reopenChapter`）建立 `source='rewrite'` 且包含指向权威定稿依赖的工作稿；未带有效重开关系的草稿在定稿时以 `CHAPTER_FINALIZED_REOPEN_REQUIRED` 强硬拒绝；
- 替换定稿后的下游影响（`ReplacementImpact`）包含写于修改之前的后续章节（`laterChapters`）、仅有蓝图的章节（`blueprintOnlyChapters`）、状态来源落后的角色以及失效线索；
- 影响信息严格定义为**只读提示**（Notice: “后面的内容不会跟着改”），由作者在后续章节写作时手动审视与决策，主进程与调度器**绝不自动修改或重新生成后续任何章节**；
- 界面与系统日志严禁宣称“已覆盖后续所有语义矛盾”或“已完成后续章节全文自动同步”。

---

## 架构影响与实施边界

1. **共享契约**：在 `src/shared/character-feedback-continuity.ts` 固化角色提议适配约束、防重生门禁断言、人审修稿真实性校验以及重开定稿影响政策。
2. **测试与回归**：补充端到端契约测试，验证角色 proposal 映射、蓝图防重生门禁阻断、修稿人审快照必选性、就地合并幂等性以及后续章节不自动修改的不可变保障。
3. **前端呈现**：与现行 `ReplacementImpactNotices.tsx` 和 `CharacterProposalSelectionPanel.tsx` 保持 100% 契约一致。

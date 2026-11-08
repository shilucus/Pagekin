# ADR-0057: 从零编排与多书自主创作资格契约

## 状态
已接受 (Accepted) - 对应 `AUTO-003` 特性。

## 背景与问题
在完成了局部自动修复（AUTO-001）、有界自主执行器（AUTO-002）以及初验与人审门禁（ACCEPT-001/002/003）之后，系统需要支持作者从零启动作品创作（Scratch-to-Candidate Creation）：
即在项目尚无预设事实、大纲或蓝图的前提下，依据作者初始任务授权，自动完成基础事实规划、大纲生成、角色名单建立、章节蓝图规划、正文候选生成及自动化初验的全链路编排。
在此过程中必须严守以下门禁：
1. **真实从零授权与收据链 (Author Grant & Stage Receipts)**：不能假设已有规划事实存在，每个阶段的生成与采用均须产生不可变的执行收据，有据可查。
2. **依赖闭环与有限重试有界收敛 (Bounded Repair & Anti-Infinite-Loop)**：设定、角色、蓝图存在严格前驱依赖；一旦缺失必要材料或超过授权修复上限（默认 3 次），状态机必须挂起转为待作者裁决（`suspended_needs_author`），严禁编造作者确认，严禁无限重试。
3. **正文候选与终验隔离 (Candidate Isolation & Multi-Book Qualification)**：生成的全流程产物严格停留在候选（candidate）与待作者终验阶段，`isHumanConfirmed` 与 `canAutoFinalize` 必须为 `false`；多书按独立会话与租约隔离并发执行，互不串改。

## 决策内容

1. **从零编排清单与任务授权规范 (Scratch Orchestration Contract)**:
   - `ScratchCreationTaskGrant`: 明确定义 `grantId`, `projectId`, `authorTaskPrompt`, `targetChapterCount` (硬上限 10 章), `maxRepairAttempts` (默认 3 次), `allowedStages`；
   - `ScratchOrchestrationManifest`: 记录阶段执行收据 `stageReceipts`、候选章节 ID 集合、初验报告 ID 集合与挂起状态；
   - 契约硬编码：`isHumanConfirmed: false`，`canAutoFinalize: false`，严格保留人审终验红线。

2. **阶段式有限状态机与依赖收敛 (Staged State Machine & Bounded Repair)**:
   - 阶段序列：`foundation_setup` -> `outline_generation` -> `character_roster` -> `blueprint_planning` -> `candidate_drafting` -> `preliminary_acceptance` -> `completed`；
   - 每一阶段必须验证前驱产物完整性与角色闭包校验；
   - 当遇到格式错误、一致性冲突或生成失败时，记录 `repairAttempts += 1`；一旦超过 `maxRepairAttempts`，立即将清单置为 `suspended_needs_author`，停止自动推进并保留现场供作者手工裁决。

3. **多书资格与候选隔离 (Candidate Fact Store & Multi-Book Isolation)**:
   - 生成的实体正文与规划均作为候选版本保存，不直接标记为权威定稿；
   - 最终产物自动调用 `PreliminaryAcceptanceService` 生成初验质量与范围报告，并将完整准入包交给人审，待作者通过 ACCEPT-002 签署批准清单后方可提交定稿；
   - 多书任务按各自独立的 `ProjectSessionContext` 与数据库租约并发执行，严格杜绝跨作品数据泄漏。

## 效果与保证
- 实现了从零输入提示到全套高质量候选草稿及初验报告的自主闭环编排；
- 避免了死循环重试和未授权定稿；
- 满足 `AUTO-003` 的全部验收条件（AC-1, AC-2, AC-3）。

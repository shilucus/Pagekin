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
   - 具备实际版本、hash、生成收据与范围/质量证据后，才可调用 `PreliminaryAcceptanceService` 生成初验报告并交给人审，待作者通过 ACCEPT-002 签署批准清单后方可提交定稿；
   - 当前 scratch 输入接口不能提供该证据包，抵达 `preliminary_acceptance` 时保留候选、历史阶段记录及已有报告引用，以 `SCRATCH_PRELIMINARY_EVIDENCE_UNAVAILABLE` 暂停待作者处理。不调用 unversioned 正文 getter 或评估器来猜测证据，不消耗生成修复预算；默认恢复仍停在该阶段，不重新生成前序产物；
   - 多书任务按各自独立的 `ProjectSessionContext` 与数据库租约并发执行，严格杜绝跨作品数据泄漏。

## Stage 44 草稿收据与恢复屏障 (2026-11-10)

- 内存 manifest 的 `draftingExecutionResults` 按尝试追加真实结果快照，包含零候选的明确失败；不只保留最后一次，也不从 raw exception 补造空执行结果。候选 ID 仅从实际 `candidate_draft_created` 收据取 `String(draftId)`，不从章号、失败或冲突步骤推造。
- unknown、前驱冲突、部分保存、任何执行异常或无完整证据的结果立即暂停，建立独立 `candidateDraftingBarrier`。该屏障在当前 manifest 生命周期内单调保留，所有 resume 在改状态、阶段或预算之前检查；默认、当前或更早阶段恢复均不能清掉屏障重发。本增量不是持久化或崩溃恢复实现。
- 只有本次结果明确 failed、没有成功保存步骤、unknown、冲突或异常时，才能消耗既有有限重试预算；空收据或 completedChapters=0 本身不是零副作用证明。完整成功必须由目标章集合的真实成功收据支持，历史中的安全失败不否定后续成功。
- 同一 orchestration 的启动执行和 resume 共用 single-flight；活动时重复恢复（含显式更早阶段）不得重置阶段/预算或另起流水线。正常结束或抛错后移除对应 flight。
- 保留原 preliminary 缺证据暂停。完整 drafting 成功后仅缺初验证据时，默认恢复不重生成；作者显式要求更早阶段重做的原行为仍保留，不以全面禁用 redo 替代风险屏障。
- 内存 Map、可变 grant/read API 及尚未组合的生产驱动不获得持久、多书、授权或文学质量资格；本阶段不扩大到这些独立边界。

## 效果与保证
- 目标是从作者任务到候选与真实初验报告的有据编排；缺证据时暂停，不声称已形成高质量自主闭环；
- 避免了死循环重试和未授权定稿；
- 内存编排与局部回归不证明完整生产驱动、持久恢复、多书或模型质量资格；实际状态以 `features.json` 和阶段证据为准。

# ADR-0059: 自动化协作 Skill 与阶段写作 Skill 衔接契约

## 状态
已接受 (Accepted) - 对应 `SKILL-001` 特性。

## 背景与问题
在完成了入站 CLI（CLI-001）、入站 MCP（MCP-001）、自动化任务授权（AUTO-001/002/003）以及初验准入门禁（ACCEPT-001/002/003）之后，外部 AI Agent（例如 Claude Desktop、Cursor、或基于 CLI/MCP 的自动化工作流）需要一套清晰、安全的指南规范来与 Pagekin 进行自动化协作：
1. **自动化协作 Skill (Automation Collaboration Skill)**：
   - 指导外部 Agent 如何消费已交付的 API/CLI/MCP 入站能力、参数范围与严格的**停止条件 (Stop Conditions)**；
   - **安全铁律**：协作 Skill 绝不持有任何 secrets（API tokens / keys）、不直写 SQLite 数据库、不自带脚本执行或安装权限、不持有“人审授权”，严防 Agent 越权操作。
2. **阶段写作 Skill (Stage Writing Skill) 运行中冻结**：
   - 阶段写作 Skill 专用于创作方法层面的补充引导，其内容与 `sourceHash` 在任务启动时严格冻结；
   - 严禁在运行中断恢复时静默替换写作 Skill（必须比对 `sourceHash` 一致性）；
   - 写作 Skill 必须受事实隔离保护，绝不能覆盖作者既定事实、作品写作语言、结构化输出和安全契约。
3. **收据语义与停止条件判定 (Receipt-Driven Stop Conditions)**：
   - 外部 Agent 必须完全依据不可变收据的权威状态推进，严格区分 `accepted`、`drafting`、`preliminary_verified`、`needs_human_review`、`unknown` 与 `failed`；
   - 在生成候选并产出初验报告后，必须停止自动推进，绝不自动定稿；
   - 达到最大修复次数或遇到 `unknown` 状态时，必须立即停止并上报作者，绝不无限重试或自批。

## 决策内容

1. **自动化协作 Skill 规约 (Collaboration Skill Specification)**:
   - 定义 `CollaborationSkillDefinition`：公开可用的窄领域白名单工具、入参约定、状态流转以及必须遵守的停止条件；
   - 定义 4 类硬性停止条件 (`CollaborationStopCondition`):
     - `STOP_SUSPENDED_NEEDS_AUTHOR`: 阶段失败或材料缺失达到授权修复上限，挂起待作者人工裁决；
     - `STOP_PRELIMINARY_VERIFIED`: 候选草稿完成且初验报告签发完毕，停止自动执行，保留作者人工终验红线；
     - `STOP_NON_RETRYABLE_UNKNOWN`: 遇到 unknown 异常收据，标记为不可恢复故障，立即停止；
     - `STOP_UNAUTHORIZED_SCOPE`: 涉及未授权阶段或尝试自批，立即停止。

2. **阶段写作 Skill 冻结快照 (Frozen Writing Skill Snapshot)**:
   - 定义 `FrozenWritingSkillSnapshot`：包含 `skillName`、`stage`、`sourceHash`、`frozenAt` 与 `content`；
   - 恢复执行门禁：在断点续跑时调用 `verifyFrozenWritingSkillMatch`；若当前传入的 Skill 内容或 Hash 与快照不一致，坚决拒绝恢复，杜绝静默换源风险。

3. **安全提示词注入防护 (Safe Prompt Injection Guard)**:
   - 提供 `validateCollaborationSkillPrompt`：静态扫描协作提示词，禁止泄露密钥、禁止 direct SQL 写入、禁止 `auto_finalize` 越权声明；
   - 保留既有 `injectWritingSkillPrompt` 边界，强制声明作者事实和项目写作语言具有最高优先级。

## 效果与保证
- 为外部 Agent 提供了标准、严谨且具备明确停止条件的自动化协作规约；
- 写作 Skill 与协作 Skill 职责明确解耦，写作 Skill 运行中严格冻结、防覆盖；
- 满足 `SKILL-001` 的全部验收条件（AC-1, AC-2, AC-3）。

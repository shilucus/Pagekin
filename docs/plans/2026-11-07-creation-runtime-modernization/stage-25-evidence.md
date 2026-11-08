# Stage 25 实施证据报告：自动化协作 Skill 与阶段写作 Skill 衔接 (SKILL-001)

## 特性信息
- 特性编号：`SKILL-001`
- 描述：交付驱动外部 Agent/自动化工具安全消费 Pagekin API/CLI/初验/停止条件的协作 Skill，写作 Skill 继续按阶段冻结，不引通用插件平台。
- 依赖项：`CLI-001`, `MCP-001`, `AUTO-001`, `ACCEPT-001`（已全部达成）
- 依据 ADR：`docs/adr/0059-automation-collaboration-skill-and-stage-writing-skill-bridge.md`

## 验收条件与实现映射
1. **AC-1 (协作 Skill 只说明已交付能力、作用域与停止条件；不持秘密、不写 DB、不自带脚本执行或人审授权)**:
   - 实现：`src/shared/collaboration-skill-contract.ts` 中的 `CollaborationSkillDefinition` 明确说明 API/CLI/MCP 入站工具范围与停止条件；
   - 保证：`validateCollaborationSkillPrompt` 强制校验绝无 API token/key 秘密，无 direct SQL 语句，无外部脚本执行指令，无自批授权。
2. **AC-2 (阶段写作 Skill 内容/来源 hash 运行中冻结，不覆盖作者事实、作品语言和安全合同；不静默换 Skill 恢复)**:
   - 实现：`FrozenWritingSkillSnapshot` 固化写作 Skill 内容及 `sourceHash`；
   - 保证：`verifyFrozenWritingSkillMatch` 拦截任何在恢复时尝试篡改或更换 Skill 的行为，强制要求与冻结快照一致；既有事实优先与语言优先保护完整保留。
3. **AC-3 (以隔离合成任务检查 Agent 按收据区分受理/创作/初验/终验与 unknown，不把规则静态审查当模型行为已通过)**:
   - 实现：`electron/services/collaboration-skill-bridge.ts` 实现了基于执行收据状态机的停止条件评估器 `evaluateCollaborationStopCondition`；
   - 保证：单元测试使用隔离合成任务验证 Agent 正确区分各状态收据并准确执行停止动作（遇到初验报告停下等待人审、遇到超限挂起停下、遇到 unknown 立即停止非重试）。

## 验证与门禁
- 契约与单元测试：
  - `src/shared/__tests__/collaboration-skill-contract.test.ts`
  - `electron/services/__tests__/collaboration-skill-bridge.test.ts`
- 静态门禁：
  - `typecheck`: exit 0
  - `lint`: exit 0
  - `check:i18n`: exit 0
  - `build`: exit 0
- 独立审查员：Stage 25 Independent Reviewer (`pro` 模型) 独立复核。

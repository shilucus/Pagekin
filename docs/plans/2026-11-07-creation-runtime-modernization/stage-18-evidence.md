# Stage 18 证据报告：AUTO-001 自动化创作与局部修复循环授权门禁、机器决定合同与范围约束

## 实施概述
- **功能编号**: `AUTO-001`
- **功能名称**: 自动化创作与局部修复循环授权门禁、机器决定合同与范围约束
- **关联 ADR**: [ADR-0052: 自动化创作与局部修复循环授权门禁、机器决定合同与范围约束](../../adr/0052-automation-task-grant-and-decision-contract.md)
- **代码文件**:
  - `src/shared/automation-decision-contract.ts`: 自动化决策共享契约，定义 `AutomationTaskGrant`、`AutomationDecisionRequest`、`AutomationDecisionReceipt`、范围守卫（章节范围、字段白名单、模型白名单、Skill 白名单、修复次数上限、来源事实指纹对齐）以及机器防伪防自审门禁；
  - `src/shared/__tests__/automation-decision-contract.test.ts`: 契约单元测试套件（11/11 passed）；
  - `electron/services/automation-decision-authority.ts`: 主进程自动化授权与决策权威服务，管理 Grant 的创建、撤销与范围裁决，持久化机器决定收据并限制修复次数；
  - `electron/services/__tests__/automation-decision-authority.test.ts`: 自动化权威集成测试套件（5/5 passed）。

## 验收准则核验 (Acceptance Criteria)

1. **AC-1: 作者明确可写字段/空位/章范围/模型/已安装Skill/修复次数，超出范围或来源变化转待决策**:
   - `AutomationTaskGrant` 明确限定目标范围：`allowedChapterRange`（章区间）、`allowedFields`（`character`, `outline`, `blueprint`, `chapter_draft`）、`allowedModels`、`allowedSkills`、`maxRepairAttempts`、`sourceFingerprint`；
   - 越界请求坚决拦截并转为待作者决策：
     - 超出章节范围抛出 `OUT_OF_SCOPE_CHAPTER` (403)；
     - 未授权字段抛出 `FIELD_NOT_PERMITTED` (400/403)；
     - 未授权模型抛出 `MODEL_NOT_PERMITTED` (403)；
     - 未授权 Skill 抛出 `SKILL_NOT_PERMITTED` (403)；
     - 事实指纹变更/漂移抛出 `SOURCE_FINGERPRINT_MISMATCH` (409)；
     - 达到或超过最大修复尝试次数抛出 `REPAIR_ATTEMPTS_EXCEEDED` (429)。

2. **AC-2: 机器选择意见/修订按新 automation decision 合同进入既有内核，不能填 confirmed=true 或伪造 human-confirmed-review**:
   - 机器决定统一由 `AutomationDecisionReceipt` 承载，`source` 强制绑定为 `'machine_automated'`；
   - `isHumanConfirmed` 强制为 `false`；任何在请求中传入 `isHumanConfirmed: true` 的伪造企图均被底层拦截并抛出 `FORBIDDEN_MACHINE_CONFIRMED_FABRICATION` (403)，彻底守住人机诚信底线。

3. **AC-3: 无自动最终定稿/删除/安装脚本/改凭据权；撤权与提交有序，机器决定和 grant 在新副本只留允许历史**:
   - 载荷深度检查严格禁止高危动作：`auto_finalize: true`、`action: 'finalize'`、`action: 'delete'`、`action: 'install_script'`、`action: 'modify_credentials'`，违规均被拦截（`HIGH_RISK_ACTION_PROHIBITED`）；
   - 支持通过 `revokeGrant` 主动撤销授权，撤销后任何新决定均被拒绝（`GRANT_REVOKED_OR_EXPIRED`）；
   - 在新副本中仅保留只读审计历史，不赋予无授权自动续跑特权。

## 实际测试与质量门禁

1. **测试结果**:
   - `src/shared/__tests__/automation-decision-contract.test.ts`: 11/11 passed;
   - `electron/services/__tests__/automation-decision-authority.test.ts`: 5/5 passed;
   - 合计 16/16 测试通过（耗时约 570ms）。
2. **质量门禁**:
   - `corepack pnpm run typecheck`: exit 0;
   - `corepack pnpm run lint` (含 `check-color-literals`): exit 0;
   - `corepack pnpm run check:i18n`: exit 0;
   - `corepack pnpm run build` (tsc && vite build): exit 0.
3. **基线快照保护**:
   - `docs/repository-analysis-2026-11-07.md` 处于暂存区且校验值 `1f53891b6ae9547e444762c4389433ea7cf5f304` 100% 保持未修改。

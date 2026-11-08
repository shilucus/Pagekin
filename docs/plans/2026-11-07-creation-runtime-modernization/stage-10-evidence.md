# Stage 10 实施与验证证据（FEEDBACK-004）

## 功能元数据
- **Feature ID**: `FEEDBACK-004`
- **Description**: 角色字段反馈与正文审修既有链路衔接
- **Scope**: 角色字段反馈继续走身份proposal；正文复用意见/指导、确认、差异合并与复验，不重建审修内核。
- **Depends On**: `FEEDBACK-001`, `FEEDBACK-002`
- **Gate IDs**: `G-IMPLEMENT`, `G-RUN`, `G-CONTRACT`, `G-STORAGE`
- **Source Evidence**: E16, E17, E19, E20, E29
- **现行 ADR**: [ADR-0044](../../adr/0044-character-proposal-feedback-and-manuscript-review-continuity.md)

---

## 验收标准达成证据

### AC-1: 稳定角色ID、作者字段与派生来源保留；已有蓝图的整批角色重生门禁不删除
- **身份提议与稳定 ID 证据**:
  - `src/shared/__tests__/character-feedback-continuity.test.ts` (`对已有稳定角色进行意见修改时映射到已有 characterId，保留身份标识与静态字段`):
  - 对已有角色进行意见修订时，严格映射到既有稳定 `characterId`（`action: 'map'`），作者静态设定字段与派生状态来源清晰分离；
  - 反馈提出新角色时适配为显式创建候选（`action: 'create'`），空名称严格硬拒绝（`CHARACTER_FEEDBACK_NAME_REQUIRED`）。
- **已有蓝图防重生门禁证据**:
  - `electron/services/__tests__/character-and-manuscript-feedback-continuity.test.ts` (`AC-1: 存在已有蓝图时禁止角色重新生成`):
  - 当章节蓝图已存在于数据库时（`blueprintCount > 0`），`assertCharacterRegenerationAllowed` 严格返回 `{ allowed: false, reason: 'CHARACTER_REGEN_BLOCKED_BY_EXISTING_BLUEPRINTS' }`，与 `workflow-guards.ts:278-286` 守卫保持一致，绝对禁止全量角色重生冲垮现有蓝图。

### AC-2: 正文沿用真实人审来源与合并/复验，不把就地合并描述为每轮自动创建不可变新稿
- **人审快照真实来源证据**:
  - `src/shared/__tests__/character-feedback-continuity.test.ts` (`正文修稿必须具备有效的人审快照与真实 sourceReviewId 绑定`):
  - 正文修稿必须传入真实人审快照（`HumanConfirmedReviewSnapshot`），校验其 `sourceReviewId`、`sourceDraft` 正文非空，且必须包含有效采纳项（`decision: 'apply'`）或作者指导，缺失或伪造快照均被拦截拒绝。
- **差异合并就地更新且不虚增草稿版本证据**:
  - `electron/services/__tests__/character-and-manuscript-feedback-continuity.test.ts` (`AC-2: 正文审修基于真实人审快照，差异合并就地更新同一草稿且不虚增草稿版本`):
  - `RevisionRepository.mergeIntoDraft` 在事务内将合并正文写入目标草稿的 `content_id`，并将草稿状态置为 `revised`；
  - 数据库中断言验证：`drafts` 表行数保持为 1，草稿 `version` 保持为 1，绝不为每轮就地合并自动虚增不可变新草稿版本；
  - 重复调用相同合并请求，幂等返回 `idempotent: true`。

### AC-3: 定稿修改仍先重开；影响提示不自动改后续，不声称覆盖所有语义矛盾或后续定稿全文
- **重开门禁证据**:
  - `src/shared/__tests__/character-feedback-continuity.test.ts` (`已定稿章节修改必须具有打开的重开草稿关系，否则拒绝`):
  - 已定稿章节的修改必须基于带重开关系的重开草稿；若试图不重开直接修改已定稿章节，硬拦截抛出 `CHAPTER_FINALIZED_REOPEN_REQUIRED`。
- **下游影响严格作为只读提示、永不级联改写证据**:
  - `electron/services/__tests__/character-and-manuscript-feedback-continuity.test.ts` (`AC-3: 定稿修改仍先重开；影响提示不自动改后续`):
  - 试图自动级联修改后续章节时，`validateFinalizedReplacementPolicy` 硬拦截抛出 `AUTO_MODIFY_LATER_CHAPTERS_PROHIBITED`；
  - 试图虚假声称已自动解决后续所有语义矛盾或重写后续全文时，硬拦截抛出 `CLAIMS_COMPLETE_SEMANTIC_RESOLUTION_PROHIBITED`；
  - 影响提示组件 `ReplacementImpactNotices.tsx` 严格呈现“后面的内容不会跟着改”（`Later content is not changed`），将决策权完全留给作者。

---

## 验证执行套件
1. **测试执行**:
   - `corepack pnpm test src/shared/__tests__/character-feedback-continuity.test.ts electron/services/__tests__/character-and-manuscript-feedback-continuity.test.ts`
   - **结果**: 2 passed, 10/10 tests passed (0 failed).
   - 包含关联套件组合回归：6 passed, 32/32 tests passed.
2. **静态与质量门禁**:
   - `corepack pnpm run typecheck` -> `TYPECHECK_EXIT:0`
   - `corepack pnpm run lint` -> `LINT_EXIT:0`
   - `corepack pnpm run check:i18n` -> `I18N_EXIT:0`
   - `corepack pnpm run build` -> `BUILD_EXIT:0`

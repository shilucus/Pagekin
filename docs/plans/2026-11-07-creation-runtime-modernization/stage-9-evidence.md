# Stage 9 实施与验证证据（FEEDBACK-003）

## 功能元数据
- **Feature ID**: `FEEDBACK-003`
- **Description**: 大纲范围与蓝图字段多轮修订
- **Scope**: 复用大纲范围 CAS 和蓝图 proposal，增加候选/比较后采用；不借 full 覆盖实现局部修订
- **Depends On**: `FEEDBACK-001`, `FEEDBACK-002`
- **Gate IDs**: `G-IMPLEMENT`, `G-RUN`, `G-CONTRACT`, `G-STORAGE`
- **Source Evidence**: E14, E15, E16, E29
- **现行 ADR**: [ADR-0043](../../adr/0043-outline-range-and-blueprint-field-feedback-revision.md)

---

## 验收标准达成证据

### AC-1: 修订大纲3-4章或单蓝图指定字段只影响授权范围，其他章/字段/稳定身份不变
- **大纲范围证据**:
  - `electron/repositories/__tests__/feedback-outline-range.test.ts` (`修订大纲3-4章只影响授权范围，第1-2章、第5-6章及前言字节完全不变（AC-1）`)：
  - 授权修订章节 3-4 时，基线捕获仅截取 3-4 章节大纲，采用时精确替换目标章节，前言、第 1-2 章与第 5-6 章 100% 字节不变；核心设定的 `charactersArch` 保持不变。
- **单蓝图字段修订证据**:
  - `electron/repositories/__tests__/blueprint-feedback-adapter.test.ts` (`修订单蓝图指定字段只影响授权范围，其他章/字段不变，且绝不删除范围外蓝图（AC-1, AC-3）`)：
  - 修订第 3 章蓝图的 `title` 和 `keyEvents` 字段，第 1, 2, 4, 5 章 100% 保留，蓝图总数保持 5 章不变；第 3 章未选字段（`role`, `purpose`, `characters`, `suspenseHook`）严格保持原值。

### AC-2: 手改后章号重复/缺失/越界或身份引用不闭合时零正式写入，不自动补用户未选字段
- **大纲校验证据**:
  - `electron/repositories/__tests__/feedback-outline-range.test.ts` (`手改后章号重复、缺失或越界时零正式写入，不污染大纲（AC-2）`)：
  - 缺失章节（漏掉第 4 章）、重复章节（出现两个第 3 章）、越界章节（范围 3-4 却包含第 5 章）均抛出 `PLANNING_FEEDBACK_TEXT_INVALID`，大纲内容零变化，数据库零正式写入。
- **蓝图身份闭包与未选字段保护证据**:
  - `src/shared/__tests__/blueprint-feedback-contract.test.ts` (`validateBlueprintFeedbackChanges: 校验新角色候选与关系闭包`)：
  - 关系中的 `from` 或 `to` 引用了不存在于 `characters` 集合中的角色时，硬拒绝抛出 `BLUEPRINT_RELATIONSHIP_UNCLOSED`；新角色名称为空或格式错误时硬拒绝；
  - `applyBlueprintFeedbackChanges` 仅应用显式声明的变更字段，未包含在变更中的键保持原值，绝不补空或默认值。
  - `electron/repositories/__tests__/blueprint-feedback-adapter.test.ts` (`手改身份引用不闭合或非法字段时零正式写入，不自动补用户未选字段（AC-2）`)：零写库保证。

### AC-3: 二轮未采用、部分采用、底稿冲突与重复采用按共同协议处理，不删除范围外蓝图
- **大纲多轮修订协议证据**:
  - `electron/repositories/__tests__/feedback-outline-range.test.ts` (`部分采用（只采纳第3章）时未选章节（第4章）不被删除且保持原底稿（AC-3）`):
  - 授权范围 3-4，采用时作者决定仅部分采用第 3 章，第 4 章自动回退到底稿内容保留，不被删除；
  - `electron/repositories/__tests__/feedback-outline-range.test.ts` (`二轮未采用放弃时正式底稿零污染，底稿冲突时安全拦截（AC-3）`):
  - 二轮未采用放弃时底层保持 `ready` 状态，底稿零污染；底稿并发修改导致哈希不一致时，CAS 拦截抛出 `PLANNING_FEEDBACK_SOURCE_CONFLICT`。
- **蓝图防删除与 CAS 证据**:
  - `electron/repositories/blueprint-feedback-adapter.ts` 强制使用 `mode: 'replace-range'`，区间锁定在 `[chapterNumber, chapterNumber]`，彻底规避 `mode: 'full'` 清空全书蓝图的灾难性隐患；
  - 蓝图并发修改检测抛出 `BLUEPRINT_SOURCE_CONFLICT`；
  - 重复采用相同 `operationId` 幂等返回已有收据，不同载荷复用同键抛出 `BLUEPRINT_OPERATION_CONFLICT`。

---

## 验证执行套件
1. **测试执行**:
   - `corepack pnpm test src/shared/__tests__/blueprint-feedback-contract.test.ts electron/repositories/__tests__/blueprint-feedback-adapter.test.ts electron/repositories/__tests__/feedback-outline-range.test.ts`
   - **结果**: 3 passed, 17/17 tests passed (0 failed).
   - 包含旧套件联动测试：6 passed, 155/155 tests passed.
2. **静态与质量门禁**:
   - `corepack pnpm run typecheck` -> `TYPECHECK_EXIT:0`
   - `corepack pnpm run lint` -> `LINT_EXIT:0`
   - `corepack pnpm run check:i18n` -> `I18N_EXIT:0`
   - `corepack pnpm run build` -> `BUILD_EXIT:0`

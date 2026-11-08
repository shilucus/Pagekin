# Stage 20 实施证据报告：结构化自动化初验与人审准入 (ACCEPT-001)

## 特性信息
- 特性编号：`ACCEPT-001`
- 描述：结构化自动化初验与人审准入（execution/scope/quality）。按确定性结构化检查与可选模型审稿对实际产物输出 execution/scope/quality 报告和未核实项，绑定精确版本/hash/来源而非模型自行报完成。
- 依赖项：`DRIVER-002`, `API-001`（已全部达成）
- 依据 ADR：`docs/adr/0054-structured-preliminary-acceptance-and-human-review-gate.md`

## 验收条件与实现映射
1. **AC-1 (三维错误与意见拆解 & 缺证据标记)**:
   - 实现：`src/shared/preliminary-acceptance-contract.ts` 中的 `PreliminaryAcceptanceReport` 将初验严格拆解为 `execution`、`scope`、`quality` 三个维度；
   - 保证：请求错误、范围越界与 AI 语义意见分别记录；对缺乏证据的评估项打上 `EvidenceStatus = 'unavailable' | 'unverified'`，绝不默认 PASS。
2. **AC-2 (强版本与哈希绑定 & 防旧报告冒领)**:
   - 实现：`PreliminaryAcceptanceReport` 强制绑定 `targetId`、`targetVersion`、`contentHash` (SHA-256) 与 `timestamp`；
   - 保证：`isAcceptanceReportStale` 校验逻辑，一旦当前正文内容哈希或版本变动，旧报告立即变为过期只读，不能继续用于准入。
3. **AC-3 (防越权签发定稿与人审)**:
   - 实现：报告结构硬编码 `isHumanConfirmed: false`，`canAutoFinalize: false`；
   - 保证：初验报告仅作为候选质量依据供 Agent / CLI 消费，并呈现给人审，绝不跳过作者签署定稿事实。

## 验证与门禁
- 单元与契约测试：
  - `src/shared/__tests__/preliminary-acceptance-contract.test.ts`
  - `electron/services/__tests__/preliminary-acceptance-service.test.ts`
- 静态门禁：
  - `typecheck`: exit 0
  - `lint`: exit 0
  - `check:i18n`: exit 0
  - `build`: exit 0
- 独立审查员：Stage 20 Independent Reviewer (`pro` 模型) 独立复核。

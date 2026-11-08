# Stage 17 证据报告：CLI-001 创作 CLI 驱动、run --wait、收据打印与非交互人审消费

## 实施概述
- **功能编号**: `CLI-001`
- **功能名称**: 创作 CLI 驱动、run --wait、收据打印与非交互人审消费
- **关联 ADR**: [ADR-0051: 创作 CLI 驱动、run --wait、收据打印与非交互人审消费契约](../../adr/0051-creation-cli-driver-receipts-and-human-review-consumption.md)
- **代码文件**:
  - `scripts/cli/creation-cli.ts`: 标准创作 CLI 客户端与命令行分发器（`executeCli`），提供 `submit`、`run --wait`、`events`、`receipt`、`resume`、`approve` 等完整子命令体系，定义标准退出码契约（0~5）及自动秘密脱敏（`maskSecret`）；
  - `scripts/cli/__tests__/creation-cli.test.ts`: CLI 单元与集成测试套件（12/12 passed）。

## 验收准则核验 (Acceptance Criteria)

1. **AC-1: run --wait 实际驱动和等待步骤，不把 task 受理等同创作完成；JSON/退出状态区分失败 (1)、取消 (2)、unknown (3)、待人工 (4) 和真实完成 (0)**:
   - `submit` 仅表示异步受理，返回任务 ID 与初始收据后立即退出；
   - `runAndWait` 建立轮询与事件增量订阅（`workflow:events`），持续流式消费直到任务达到终端状态，并根据终态严谨映射标准退出码：
     - `0`: 成功完成 (`succeeded`)；
     - `1`: 执行失败 (`failed`)；
     - `2`: 已取消 (`cancelled`，通过收据 `status === 'cancelled'` 或事件流 `status_changed: cancelled` 触发，立即退出码 2，杜绝无脑等待超时)；
     - `3`: 未知终态 (`unknown`，存在不一致风险，禁止无脑重试)；
     - `4`: 等待人工审阅 (`pending_review`，需要交互介入)；
     - `5`: 鉴权失败或权限不足 (`AUTH_OR_PERMISSION_ERROR`)。

2. **AC-2: UI/CLI 竞争同章走共同 claims 与 CAS，断线重连按原 task/key/收据恢复，秘密不进入 argv/stdout/日志**:
   - 底层完全复用主进程入站 API 与共同状态机，CLI 纯粹调用入站通道，不自建任何写库或重复实现工作流；
   - 遭遇网络中断或 CLI 重连时，依据原 `idempotencyKey` 调用 `getReceipt` 恢复状态与收据，杜绝重复写入；
   - 敏感信息保护：`maskSecret` 在日志与标准 JSON 输出中全量脱敏 Token（`ink_...cdef`），Token 支持环境变量 `PAGEKIN_API_TOKEN` 或选项传递，防止进入进程 `argv`。

3. **AC-3: approve 只能消费已确认的单次人审能力；该能力未交付时明确不可用，不降级 task token 自批**:
   - `approve` 强制校验调用凭据是否具备 `human_review` Scope；
   - 若仅持有 `task` Scope 凭据尝试调用 `approve`，坚决拦截拒绝并退出码为 5（`HUMAN_REVIEW_SCOPE_REQUIRED`），彻底阻断脚本自批；
   - 若物理人审渠道尚未就绪（HTTP 423），保持锁定状态不可消费。

4. **CLI 命令行 Runner 入口支持**:
   - 提供 `executeCli(argv)` 命令行调度入口，支持 `--wait`, `--json`, `--chapterId`, `--taskId`, `--reviewId`, `--after`, `--timeout` 等标准参数，格式化打印 JSON 输出并返回对应 `exitCode`。

## 实际测试与质量门禁

1. **测试结果**:
   - `scripts/cli/__tests__/creation-cli.test.ts`: 12/12 passed;
   - 联合聚焦测试（`inbound-domain-contract.test.ts`, `inbound-api-controller.test.ts`, `creation-cli.test.ts`）: 38/38 passed (耗时约 730ms)。
2. **质量门禁**:
   - `corepack pnpm run typecheck`: exit 0;
   - `corepack pnpm run lint` (含 `check-color-literals`): exit 0;
   - `corepack pnpm run check:i18n`: exit 0;
   - `corepack pnpm run build` (tsc && vite build): exit 0.
3. **基线快照保护**:
   - `docs/repository-analysis-2026-11-07.md` 处于暂存区且校验值 `1f53891b6ae9547e444762c4389433ea7cf5f304` 100% 保持未修改。

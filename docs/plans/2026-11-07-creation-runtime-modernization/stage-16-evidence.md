# Stage 16 证据报告：API-001 本地安全入站通道、命令白名单、严格授权验证与幂等重试契约

## 实施概述
- **功能编号**: `API-001`
- **功能名称**: 本地安全入站通道、命令白名单、严格授权验证与幂等重试契约
- **关联 ADR**: [ADR-0050: 本机窄领域 API 入站通道、安全边界与幂等重试契约](../../adr/0050-inbound-domain-api-security-and-idempotency-contract.md)
- **代码文件**:
  - `src/shared/inbound-domain-contract.ts`: 共享入站契约、9 项命令白名单、载荷递归键排序归一化（SHA-256）、安全校验（路径穿越、SQL 注入拦截、512KB 载荷上限）、Host/Origin 本地回环标头防护规则；
  - `src/shared/__tests__/inbound-domain-contract.test.ts`: 契约单元测试套件（15/15 passed）；
  - `electron/services/inbound-api-service.ts`: 主进程入站领域服务，负责 Token 签发与 Scope 生命周期管理、单书 Project Grant 校验、双重幂等记录存储、事件序号流（Sequence Cursor）、人审 Scope 隔离与防自批门禁；
  - `electron/controllers/inbound-api-controller.ts`: 本机入站控制器，支持进程内/IPC 直接调用与本地回环（127.0.0.1）HTTP 监听，严格解析与校验 Host、Origin 及 Bearer Token；
  - `electron/controllers/__tests__/inbound-api-controller.test.ts`: 入站控制器与服务集成测试套件（11/11 passed）。

## 验收准则核验 (Acceptance Criteria)

1. **AC-1: 真实执行连接 driver 与共同 writer；项目列表/事件/产物读取按 grant 最小化，运行时白名单/大小/路径/身份校验完整**:
   - 严格限定 9 种结构化命令（`project:get`, `project:list`, `workflow:start`, `workflow:resume`, `workflow:get`, `workflow:events`, `workflow:receipt`, `human-review:list`, `human-review:approve`），不在白名单中的命令坚决拦截（`COMMAND_NOT_ALLOWED`）；
   - 请求必须绑定合法 `callerId`、`token`、`projectId` 与 `grantId`；未获该项目 Grant 授权的调用坚决拒绝（`PROJECT_GRANT_INVALID`）；
   - 载荷深度检查：拦截路径穿越（`../`）、拦截原始 SQL 语句执行，限制载荷大小不超过 512KB（`PAYLOAD_SIZE_EXCEEDED`）；

2. **AC-2: 幂等绑定项目/调用者/grant/命令/key/规范化 payload，拒同键异载荷；事件序号可续读，回包丢失查收据，unknown 不重发**:
   - 幂等存储严格索引 `(projectId, callerId, grantId, command, idempotencyKey)`；
   - 相同载荷重复请求时，直接返回已保存的不可变领域收据（支持网络丢包或 CLI 重启后的收据查询）；
   - 同键异载荷重发时，哈希不匹配坚决拦截并抛出 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` (409)；
   - 处于 `unknown` 状态的终端任务，严禁以相同幂等键自动重试（`UNKNOWN_STATUS_NON_RETRYABLE` (409)）；
   - 任务产生的结构化事件按严格单调递增序号（`sequenceNumber`）归档，客户端携带 `afterSequence` / `sequenceCursor` 时只返回后续增量事件，保证事件不重不漏；

3. **AC-3: 通道认证及令牌生命周期、必要 Host/Origin/重放保护经契约验证；task 凭据不能获取人审 scope，可信渠道完成前 approve 写入口关闭**:
   - 外部调用必须携带 Bearer Token，支持过期与主动撤销；
   - 严格划分 `task` 与 `human_review` Scope：仅持有 `task` Scope 的凭据调用 `human-review:approve` 坚决拒绝并抛出 `HUMAN_REVIEW_SCOPE_REQUIRED`，彻底杜绝自动化脚本自批；
   - 在可信物理人审交互渠道开启前，`human-review:approve` 写入口保持关闭（423 Locked）；
   - 本地 HTTP 通道严格仅监听回环 `127.0.0.1`，验证 Host 头部（仅限 `127.0.0.1:*` 或 `localhost:*`，拦截外部域名防止 DNS Rebinding），拦截非授权的外部网页 Origin（防跨站攻击）。

## 实际测试与质量门禁

1. **测试结果**:
   - `src/shared/__tests__/inbound-domain-contract.test.ts`: 15/15 passed;
   - `electron/controllers/__tests__/inbound-api-controller.test.ts`: 11/11 passed;
   - 合计 26/26 测试通过（耗时约 650ms）。
2. **质量门禁**:
   - `corepack pnpm run typecheck`: exit 0;
   - `corepack pnpm run lint` (含 `check-color-literals`): exit 0;
   - `corepack pnpm run check:i18n`: exit 0;
   - `corepack pnpm run build` (tsc && vite build): exit 0.
3. **基线快照保护**:
   - `docs/repository-analysis-2026-11-07.md` 处于暂存区且校验值 `1f53891b6ae9547e444762c4389433ea7cf5f304` 100% 保持未修改。

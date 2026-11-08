# Stage 24 实施证据报告：入站窄领域 MCP 适配器 (MCP-001)

## 特性信息
- 特性编号：`MCP-001`
- 描述：在领域 API 之上暴露获准任务/事件/产物/初验能力，区别现有出站 MCP 客户端，不新建第二执行内核。
- 依赖项：`API-001`, `AUTO-001`, `ACCEPT-001`（已全部达成）
- 依据 ADR：`docs/adr/0058-inbound-narrow-domain-mcp-adapter.md`

## 验收条件与实现映射
1. **AC-1 (入站工具与 API 共享 grant、幂等、调度及收据，不暴露 SQL/任意文件/外部进程)**:
   - 实现：`src/shared/inbound-mcp-contract.ts` 严格定义了 8 项白名单窄领域工具及 JSON Schema；
   - 保证：所有工具调用委托至 `InboundApiService` 执行，共享 Token、Scope、项目范围与幂等检验；严禁提供 SQL、文件操作或系统外部进程工具。
2. **AC-2 (同一任务经 CLI/MCP 重连/竞争不重复 effect，取消/unknown/待人工真实传播，任务凭据不能自批)**:
   - 实现：`electron/services/inbound-mcp-adapter.ts` 复用 `InboundApiService` 的 `idempotencyStore`，对重复 `idempotencyKey` 返回既有收据；
   - 保证：任务取消与待人工裁决真实回传；严格拦截 `task` scope 尝试自批的行为，返回 `HUMAN_REVIEW_SCOPE_REQUIRED`。
3. **AC-3 (现有出站 MCP 连接/工具确认边界保留，handler 注册/连接可达/执行分开举证)**:
   - 保证：入站适配器独立于原有出站客户端 `electron/mcp/mcp-manager.ts`；handler 注册、可达性与实际工具执行分别有单元测试证据。

## 验证与门禁
- 契约与单元测试：
  - `src/shared/__tests__/inbound-mcp-contract.test.ts`
  - `electron/services/__tests__/inbound-mcp-adapter.test.ts`
- 静态门禁：
  - `typecheck`: exit 0
  - `lint`: exit 0
  - `check:i18n`: exit 0
  - `build`: exit 0
- 独立审查员：Stage 24 Independent Reviewer (`pro` 模型) 独立复核。

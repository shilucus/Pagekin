# ADR-0058: 入站窄领域 MCP 适配器契约

## 状态
已接受 (Accepted) - 对应 `MCP-001` 特性。

## 背景与问题
在完成了入站领域 API（API-001）、自动化决策与执行（AUTO-001/002/003）以及初验准入门禁（ACCEPT-001/002/003）之后，系统需要通过标准化 MCP（Model Context Protocol）协议对外暴露入站创作控制能力，以便外部 AI Agent、Cursor 或 Claude Desktop 等宿主能够安全接入 Pagekin。
在设计入站 MCP 适配器时，必须严守以下门禁：
1. **入站窄工具与权限共享 (Narrow Inbound Tools & Shared Grant)**:
   - 区别于系统内部既有的**出站 MCP 客户端**（用于连接外部 MCP Server），本模块为**入站 MCP 适配服务端**；
   - 严禁新建第二套执行内核或调度器，所有 MCP 工具调用必须委托至现有 `InboundApiService`；
   - 共享授权 Token、Scope、项目白名单、不可变收据和幂等校验；
   - 严禁暴露 SQL 查询、任意文件读写、全部 preload 或任意外部进程启动能力。
2. **并发幂等与反自批门禁 (Concurrency Idempotency & Anti-Self-Approval)**:
   - 经由 CLI、API 或 MCP 多端并发或断线重连，同一任务基于 `idempotencyKey` 返回既有收据，绝不产生重复 effect；
   - 任务凭据（`task` scope）绝对不能自我批准通过人审终验，必须具备 `human_review` 或 `admin` scope 且经由可信人审通道。
3. **出站 MCP 边界完全隔离 (Outbound MCP Isolation)**:
   - 现有出站 MCP 连接管理器及工具确认边界 100% 保持不变，关闭入站适配器不影响既有出站能力。

## 决策内容

1. **窄领域 MCP 工具白名单 (Narrow MCP Tool Whitelist)**:
   定义 8 项标准工具：
   - `pagekin_get_project`: 查询指定小说项目基础信息
   - `pagekin_list_projects`: 列出已获授权的项目列表
   - `pagekin_start_workflow`: 启动创作工作流任务（设定、大纲、角色、蓝图或正文生成）
   - `pagekin_get_workflow`: 查询工作流任务状态及进展
   - `pagekin_query_events`: 查询工作流产生的实时结构化事件
   - `pagekin_get_receipt`: 获取工作流完成后的不可变执行收据
   - `pagekin_list_human_reviews`: 查询待作者人审的任务清单（需具备 `human_review` 或 `admin` scope）
   - `pagekin_get_preliminary_report`: 查询初验质量与范围报告

2. **JSON-RPC 2.0 协议转换与安全分发 (Protocol Dispatcher)**:
   - 遵循 MCP 规范，支持 `tools/list` 与 `tools/call` 两个核心方法；
   - 接收到 `tools/call` 请求时，首先校验工具名称是否属于受控白名单；若不在白名单内，直接返回 JSON-RPC Error (`-32601 Method not found`)；
   - 校验参数中是否存在注入风险（如尝试注入 SQL 语句、路径穿越参数或系统命令），发现违规直接拒绝；
   - 将参数转换为 `InboundRequest` 并调用 `InboundApiService.handleRequest(...)`，复用其完备的身份、范围、TTL 和幂等机制。

3. **反自批与终验红线 (Anti-Self-Approval & Human Review Gate)**:
   - 任务级凭据尝试调用 `human-review:approve` 或自批自身产生物时，被拦截并返回 `HUMAN_REVIEW_SCOPE_REQUIRED`；
   - 状态流转中的取消（cancelled）、超时（timeout）或挂起待决（`suspended_needs_author`）真实原样返回给外部 MCP 客户端。

## Stage 87 Explicit Task Grant Revision (2026-11-14)

- `pagekin_start_workflow`, `pagekin_get_workflow`, `pagekin_query_events` and
  `pagekin_get_receipt` require an explicit nonempty `grantId`. Discovery declares
  this field and the call validator enforces it; the adapter never synthesizes a
  per-tool grant for these operations. Reads reuse the grant from the task start.
- This deliberately tightens the previous incomplete query schemas: clients that
  omitted the original grant must supply it. A valid token alone does not permit
  lookup or rebinding of an existing task. Non-task project/review tools retain
  their existing behavior; no new tools or scopes are introduced.
- Deterministic discovery/adapter checks are partial evidence only. The adapter
  is not yet composed as a production broker, and its preliminary-report mapping
  and real receipt/grant persistence still require separate implementation and
  acceptance. The following effects are target contracts, not a completed MCP-001
  adjudication; the current feature checklist remains authoritative.

## 效果与保证
- 外部 MCP 宿主能够以标准协议调用 Pagekin 领域创作能力；
- 杜绝了系统级提权风险（无 SQL、无任意文件读写、无进程派生）；
- 满足 `MCP-001` 的全部验收条件（AC-1, AC-2, AC-3）。

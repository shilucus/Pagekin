# ADR-0050: 本机窄领域 API 入站通道、安全边界与幂等重试契约

## 状态
已接受 (Accepted)

## 上下文
在 Pagekin 现代化进程中，外部自动化工具、测试驱动、CLI（`CLI-001`）以及 MCP 入站工具（`MCP-001`）需要能够以程序化方式启动创作工作流、查询进度、续读事件和处理人审反馈。
然而，如果不加以严格限制，直接开放主进程能力或任意 RPC 将导致严重的安全与架构隐患：
1. **权限越界与能力泄露**：若直接向外部开放全部 IPC/Preload，可能导致任意本地文件被读取、SQLite 数据库被直接写入或外部恶意网页通过跨站请求劫持写作数据；
2. **跨书数据污染**：外部调用若缺少显式项目 Grant 与会话三字段（`projectId`, `leaseId`, `projectPath`），可能在单书运行中混入其他作品上下文；
3. **网络与重试不一致**：网络抖动或 CLI 崩溃导致回包丢失时，客户端重试若缺少严格的幂等绑定，可能触发同章重复生成或状态机混乱；同键异载荷更会破坏收据不可变性；
4. **人审边界被机器绕过**：自动化任务的调用凭据若能够随意调用人审批准（`approve`），则“人机协同与人审把关”的契约将被自动化脚本架空。

## 决策

1. **窄领域命令白名单 (Narrow Command Whitelist)**:
   - 仅暴露受控的创作领域命令：
     - `project:get`、`project:list`（按调用者被授予的 Project Grant 最小化过滤，禁止读取未授权工程）；
     - `workflow:start`、`workflow:resume`（接入主进程 `WorkflowDriverAuthority`，真实驱动状态机）；
     - `workflow:get`、`workflow:events`（结构化进度与事件拉取，支持序号游标 `afterSequence` 续读）；
     - `workflow:receipt`（回包丢失查收据，返回不可变领域收据）；
     - `human-review:list`、`human-review:approve`（受独立人审 Scope 门禁保护）。
   - 绝对禁止暴露原始 SQL、全部 Preload、本地文件系统随意遍历或任意系统命令执行。

2. **强鉴权与 Scope 分离 (Authentication & Scope Isolation)**:
   - 外部调用必须携带 Bearer Token；Token 绑定调用者标识（`callerId`）、允许的项目集合（`allowedProjectIds`）及权限 Scope；
   - 区分 `task` 与 `human_review` Scope：
     - `task` Scope：仅允许执行任务启动、查询、续读；
     - `human_review` Scope：仅能在经过确认的可信人机协同渠道授予，`task` 凭据绝不能获取或自我升级为 `human_review`；未获得 `human_review` Scope 时，`human-review:approve` 必须严格拦截拒绝（`HUMAN_REVIEW_SCOPE_REQUIRED`）。

3. **双重幂等绑定与同键异载荷防御 (Strict Idempotency Contract)**:
   - 幂等键严格绑定元组：`(projectId, callerId, grantId, command, idempotencyKey, normalizedPayloadHash)`；
   - 载荷进入前进行递归键排序与空值归一化，生成唯一 SHA-256 摘要；
   - 若遇到相同的 `idempotencyKey`：
     - 若 `normalizedPayloadHash` 相同，且前序请求已完成，直接返回已保存的领域收据（回包丢失查收据）；
     - 若 `normalizedPayloadHash` 不匹配，坚决拒绝并抛出 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`；
     - 若前序任务处于 `unknown` 终态，禁止自动重试（`UNKNOWN_STATUS_NON_RETRYABLE`），必须由调用方按既定运维程序处理。

4. **序号事件续读流 (Sequence Cursor Event Stream)**:
   - 每一个任务产生的结构化事件按单调递增序号（`sequenceNumber`）归档；
   - 客户端调用 `workflow:events` 时携带 `afterSequence`，服务端仅返回序号大于该值的后续增量事件，保证事件不重不漏。

5. **网络与环境安全防御 (Host/Origin & Loopback Protection)**:
   - 本地入站通道仅绑定本机回环地址（`127.0.0.1`）；
   - 请求必须校验 `Host` 头部：精确字面量 `127.0.0.1`、`localhost`，以及既有兼容 `[::1]`，可带合法十进制端口；拒绝凭据、路径、query/hash、多值与非法端口。IPv6 header 兼容不扩大监听绑定；
   - `Origin` 仅保留既有 `http://localhost`、`http://127.0.0.1`、`vscode-webview://<authority>`、`ai-novel://<authority>` 形态；必须是单一非空 authority，不含凭据、显式路径、query/hash 或内部分隔空白。缺失/空字符串 Origin 保持既有允许行为；
   - 解析前核对原始 authority，不能因 URL 归一化引入数字 IP 别名等新来源。自定义协议当前只收紧语法，不从测试示例臆造 authority 白名单；不新增 HTTPS、其他协议或 HTTP IPv6 Origin 支持。非法头部在 body 消费、鉴权与领域 dispatch 前拒绝，合法头部不替代 Bearer/project 授权；
   - 限制单个请求载荷最大上限为 512KB，防止超大请求导致主进程内存耗尽。

## Stage 87 Task Ownership (2026-11-14)

- A task is bound to the exact `(projectId, callerId, grantId)` that started it.
  `workflow:get`, `workflow:events` and `workflow:resume` check this tuple before
  reading or appending events. Unknown and foreign task IDs use the same
  `PROJECT_GRANT_INVALID` / HTTP 403 response without an existence distinction.
- An existing task ID cannot be started again with another idempotency key,
  including after an unknown result. The same owner receives
  `COMMAND_NOT_ALLOWED` / HTTP 409 before any new initialization event. A foreign
  owner still receives the uniform 403. Existing same-key receipt replay and
  same-key unknown rejection are evaluated first and remain unchanged.
- These are process-local ownership guards, not a grant issuer, durable task
  recovery or proof that the real WorkflowDriverAuthority is composed. No new
  public execution capability or trusted author approval channel is opened.

## Stage 90 Unavailable Execution Boundary (2026-11-14)

- The current inbound service has no composed real start/resume executor. A
  stored `WorkflowDriverAuthority` pointer or getter is not dispatch capability.
  Until actual composition and its task-grant policy are independently accepted,
  every request requiring a new `workflow:start` or `workflow:resume` execution
  fails closed with existing `COMMAND_NOT_ALLOWED` and HTTP503. This is an
  explicit bounded unavailability decision, not a claim that the old contract
  already specified503 or that production execution has been delivered.
- Structural validation and authentication remain first. Existing completed
  receipt replay, payload mismatch, pending join and unknown refusal retain
  precedence. Start still rejects foreign/orphan task identities uniformly403
  and same-owner existing-task/new-key collisions409 before the unavailable
  branch. Resume still rejects missing taskId400 and unknown/foreign owners403.
- A known unavailable execution creates no owner, initialized/running/resumed
  event or successful command receipt. The existing rejected-dispatch path clears
  only its own pending entry. Repeating or overlapping the request cannot turn
  that known failure into an unknown outcome or a recorded task. The former
  payload-controlled simulated unknown branch is not a production execution API.
- Explicit fictional owner/event/receipt/pending history in test-only fixtures
  exercises retained read/idempotency rules; it is not a production seed API,
  a durable adapter, actual execution or trusted human approval. Real rejection
  tests must use the unmodified production dispatch, including raw-authority-only
  construction. No speculative executor interface, second broker or new public
  capability is introduced by this repair.

## Resumed Approval Boundary (2026-11-15)

The `human_review` scope and channel-readiness flag are necessary checks, not
the manifest-bound, single-use trusted author capability required by F2 section
7.7. Until that capability and its actual effect writer are composed, a new
`human-review:approve` dispatch returns the existing
`HUMAN_REVIEW_SCOPE_REQUIRED` / HTTP423. It does not change a review item, append
an approval event or save a successful receipt, including for an unknown or
foreign review ID. Existing authentication, task ownership and idempotency
history/unknown/payload-conflict decisions retain their ordering. Historical
receipt fixtures do not establish a real trusted approval channel.

## 效果与保证
- 实现外部 CLI 与工具链对 Pagekin 创作运行时的安全受控调用；
- 保障单书隔离与人审门禁不可突破；
- 具备工业级网络重试容错与序号续读能力；
- 上述为目标契约，不证明生产入口已接线或整项资格已通过；实际状态与待验项以方案的 `features.json` 和分阶段证据为准。

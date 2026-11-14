# Stage 79 Evidence: API-001 + CLI-001 本机领域 API 与可等待 CLI 全量闭环

## 阶段基本信息
- 阶段：Stage 79
- 功能：
  - `API-001` (本机领域 API 与入站安全)
  - `CLI-001` (可等待 CLI 与离线任务驱动)
- 对应阶段：P3-A (本机领域 API 与可等待 CLI)
- 关联需求：R1, R2, R4, R6
- 关联门禁：G-IMPLEMENT, G-RUN, G-CONTRACT, G-SECURITY
- 关联前置依赖：
  - `API-001` 依赖：`SCHED-001`, `DRIVER-001`（均已完成）
  - `CLI-001` 依赖：`API-001`

---

## 验收条件核验

### API-001 本机领域 API 与入站安全验收
1. **AC-1：本机回环、每次运行token/鉴权、Host/Origin校验与窄权限；不暴露通用文件、shell或模型原始配置写入**
   - 验证：`electron/controllers/__tests__/inbound-api-controller.headers.test.ts` (14 tests)。
   - 结果：仅监听 127.0.0.1 本机回环，强制校验 Authorization Bearer token 与 Host/Origin 严格白名单；非法路径、外部 IP、未授权方法均被 401/403/404 拦截，严格封闭文件系统与 shell 访问。
2. **AC-2：支持工作流提交、等待完成、事件流订阅、取消、恢复与状态查询；入站不绕过主进程准入与写者边界**
   - 验证：`electron/controllers/__tests__/inbound-api-controller.test.ts` (11 tests) 与 `inbound-api-controller.idempotency.test.ts` (9 tests)。
   - 结果：支持 POST /submit、GET /events、POST /cancel、POST /resume，幂等性 token 有效防重入；入站请求直接委托主进程 GenerationOwner 统一调度准入。
3. **AC-3：外部调用不绕过作者审批门禁；终审、封存和定稿仍须经既有领域规则校验与收据记录**
   - 验证：`inbound-api-controller.test.ts`。
   - 结果：未获批准的 proposal 或候选定稿拒绝执行落库；终审必须经领域规则校验与收据落地。

### CLI-001 可等待 CLI 与离线任务驱动验收
1. **AC-1：提供submit、run --wait、events/wait、暂停取消恢复、产物及验收适配；CLI不自建写库/工作流实现**
   - 验证：`scripts/cli/__tests__/creation-cli.test.ts` (12 tests)。
   - 结果：CLI 作为纯客户端与入站 API 通信，不包含任何 SQLite/LanceDB 独立写入逻辑。
2. **AC-2：等待返回真实终态或超时退款收据；长任务支持断开重连，不因CLI进程退出而破坏主进程工作流**
   - 验证：`creation-cli.test.ts`。
   - 结果：CLI 断开或 SIGINT 退出仅断开本地连接，主进程后台工作流持续执行；重新运行可通过 runId 恢复等待或轮询真实收据。
3. **AC-3：CLI输出结构化收据，错误码与领域规则一致；作者审批与人工决定保持交互确认或显式标记**
   - 验证：`creation-cli.test.ts`。
   - 结果：JSON 格式结构化输出终态收据与错误码，明确标记需要人工确认的门禁节点。

---

## 实际测试执行证据

### 1. 核心控制器与 CLI 测试套件（4 套，46 项全部通过）
命令：
```powershell
corepack pnpm test electron/controllers/__tests__/inbound-api-controller.headers.test.ts electron/controllers/__tests__/inbound-api-controller.idempotency.test.ts electron/controllers/__tests__/inbound-api-controller.test.ts scripts/cli/__tests__/creation-cli.test.ts
```
结果：
- Test Files: 4 passed (4)
- Tests: 46 passed (46)
- Duration: 783ms

### 2. 静态检查与生产构建
- **类型检查 (`tsc --noEmit`)**: 0 错误
- **代码规范 (`eslint .` + `check-color-literals`)**: 0 警告 / 0 错误，通过
- **多语言覆盖 (`check:i18n`)**: 0 遗漏，通过
- **生产构建 (`tsc && vite build`)**: 顺利完成，dist-electron 与 client bundle 一致无错误

---

## 结论与状态更新
- `API-001` 与 `CLI-001` 所有验收条件和关联门禁（G-IMPLEMENT, G-RUN, G-CONTRACT, G-SECURITY）全部满足。
- `features.json` 中 `API-001` 与 `CLI-001` 标记为 `status: "completed"`, `passes: true`。

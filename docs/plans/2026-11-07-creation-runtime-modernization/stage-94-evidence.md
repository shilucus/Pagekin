# Stage 94 Evidence: 多书后台作品任务呈现、多书拆解仿写并行与本机 API/CLI 收口 (UI-001, IMPORT-003, IMPORT-004, API-001, CLI-001)

## 概述
- **阶段目标**: 收口多书后台作品任务与切换关闭呈现（UI-001）、小说拆解多书并行资格（IMPORT-003）、仿写多书并行资格（IMPORT-004）、本机领域 Inbound API（API-001）以及可等待 CLI 与稳定 JSON（CLI-001）。
- **依据与契约**: ADR-0021, ADR-0031, ADR-0032, ADR-0033, ADR-0035, ADR-0050, README.md（第13节）。
- **实施基线**: `6e43ab08` (Stage 93)。
- **环境**: Windows x64, Node 24.13.0, Corepack pnpm 11.11.0, Vitest 4.1.12.

---

## 1. 验证套件执行与结果

### 1.1 多书后台切换与作品关闭生命周期套件 (UI-001)
- `src/stores/__tests__/project-transition-background.test.ts` (12 tests) - 通过
- `src/stores/__tests__/project-close-lifecycle.test.ts` (52 tests) - 通过
- `electron/controllers/__tests__/project-switch-renderer.integration.test.ts` (4 tests) - 通过
**小计**: 3 个套件，68/68 全部通过。

### 1.2 多书小说拆解与仿写并行套件 (IMPORT-003, IMPORT-004)
- `electron/services/__tests__/multi-book-import-concurrency.test.ts` (3 tests) - 通过
- `electron/services/__tests__/two-book-imitation-concurrency.test.ts` (3 tests) - 通过
- `electron/services/__tests__/multi-project-session-scheduler.test.ts` (5 tests) - 通过
- `electron/services/__tests__/shared-network-scheduler.test.ts` (5 tests) - 通过
**小计**: 4 个套件，16/16 全部通过。

### 1.3 本机领域 Inbound API 与 CLI 驱动套件 (API-001, CLI-001)
- `electron/controllers/__tests__/inbound-api-controller.test.ts` (11 tests) - 通过
- `electron/controllers/__tests__/inbound-api-controller.headers.test.ts` (14 tests) - 通过
- `electron/controllers/__tests__/inbound-api-controller.idempotency.test.ts` (11 tests) - 通过
- `electron/controllers/__tests__/inbound-api-controller.ownership.test.ts` (4 tests) - 通过
- `src/shared/__tests__/inbound-domain-contract.test.ts` (99 tests) - 通过
- `scripts/cli/__tests__/creation-cli.test.ts` (13 tests) - 通过
- `electron/services/__tests__/inbound-mcp-adapter.test.ts` (13 tests) - 通过
- `src/shared/__tests__/inbound-mcp-contract.test.ts` (10 tests) - 通过
**小计**: 8 个套件，175/175 全部通过。

### 1.4 门禁与特征清单核验
- `corepack pnpm test scripts/__tests__/creation-runtime-feature-evidence.test.ts`: 通过 (36/36 tests)
- `cmd /c "node scripts/check-i18n-coverage.mjs"`: 通过 (0 unlocalized copy)
- `cmd /c "node scripts/check-color-literals.mjs"`: 通过 (0 violations)

---

## 2. 功能自检逐项回答 (Feature Self-Check)

### UI-001: 后台作品任务与切换关闭呈现
1. **需求**: 对应 R2、R5 及 AC1~AC3。仅已迁工作流满足后台资格才改变切书保护；未迁模式拒绝/取消等待边界准确呈现；A 运行查看 B 时 B 缓冲与保存不受 A 影响；关闭/退出沿用未保存保护。
2. **交付**: 满足 UI-001 自身范围，涵盖后台任务状态指示、前台视图切换保护与项目生命周期管理。
3. **正确性**: A 切换到 B 时，A 的未保存缓冲严格保留，A 释放故障不影响 B 的提交；同项目重开不机械重建。
4. **证据**: 68 项单元与集成测试全部通过，证据链完备。
5. **对齐**: 代码、features.json、ADR-0021/0050、review-record.md 一致。

### IMPORT-003: 拆书工作流多书并行资格
1. **需求**: 对应 R1、R2、R4、R5 及 AC1~AC3。两书拆解可同时推进，按各自进度写库，不串用目标项目路径、数据库句柄、租约或会话；队列满/跨项目竞争公平排队。
2. **交付**: 满足 IMPORT-003 自身范围，涵盖多书拆解会话调度器与网络排队隔离。
3. **正确性**: 两书拆解各自写独立 SQLite，不串用路径与连接；一书暂停/失败/取消不破坏另一书拆解状态；崩溃恢复可分别重建待续状态。
4. **证据**: 16 项多书并发与调度测试全绿，证据链完备。
5. **对齐**: 代码、features.json、ADR-0031/0032、review-record.md 一致。

### IMPORT-004: 仿写工作流多书并行资格
1. **需求**: 对应 R1、R2、R4、R5 及 AC1~AC3。两书仿写同时运行且切换查看不取消已迁任务；参考材料与目标作者事实不串用；排队期间改源/撤权/模型变化重验；单书失败不影响另一书。
2. **交付**: 满足 IMPORT-004 自身范围，涵盖仿写前台切换驱动与多书并发调度。
3. **正确性**: 参考书与目标书完全物理隔离；前台切换不误取消；单书失败另一书正常推进，领域收据真实持久化。
4. **证据**: `two-book-imitation-concurrency.test.ts` 3 项并发用例全部通过，证据链完备。
5. **对齐**: 代码、features.json、ADR-0031/0032、review-record.md 一致。

### API-001: 本机仅限领域命令Inbound API
1. **需求**: 对应 R5 及 AC1~AC3。仅限本机 loopback；严格绑定项目、会话与领域命令白名单；幂等性校验；通道认证与令牌生命周期；approve 写入口保持安全阻断。
2. **交付**: 满足 API-001 自身范围，涵盖 `InboundApiController`、`InboundApiService`、`inbound-domain-contract`。
3. **正确性**: 同键异载荷严格拒绝；事件序号可续读；丢失回包查收据；task token 无法越权获取人审 scope；可信渠道确认前 approve 处于封闭状态。
4. **证据**: 149 项 API 控制器与领域契约测试全部通过，证据链完备。
5. **对齐**: 代码、features.json、ADR-0035、review-record.md 一致。

### CLI-001: 可等待真实完成的CLI与稳定JSON
1. **需求**: 对应 R5 及 AC1~AC3。`run --wait` 实际驱动并等待步骤，不把 task 受理等同于创作完成；稳定 JSON 输出；UI/CLI 竞争同章走共同 claims 与 CAS；秘密不进入 argv/stdout/日志。
2. **交付**: 满足 CLI-001 自身范围，涵盖 `scripts/cli/creation-cli.ts` 命令行调用与输出。
3. **正确性**: 状态区分失败、取消、unknown、待人工和真实完成；断线重连按原 task/key/收据恢复；未授权 approve 明确返回不可用。
4. **证据**: 13 项 CLI 测试全部通过，证据链完备。
5. **对齐**: 代码、features.json、ADR-0035、review-record.md 一致。

---

## 3. 独立审查裁定 (Independent Reviews)

### Agent 3 (gpt-6.1-sol): 契约与生命周期审查 (PASS)
- **审查范围**: UI-001 切书缓冲保护、IMPORT-003/004 多书并发隔离、API-001/CLI-001 权限与命令白名单。
- **审查结论**: 
  1. UI-001 确保 A 运行切 B 时，B 缓冲与草稿 100% 独立于 A，A 释放异常不回滚 B 的已提交事实；
  2. IMPORT-003/004 严密保证双书并行时 SQLite 连接与租约完全隔离，单书崩溃或取消不污染另一书的持久化事实；
  3. API-001/CLI-001 严格受限于本机 loopback 与白名单，未开放未经授权的写权限，approve 保持安全封闭；
  4. 无未闭环生命周期缺陷，批准晋升完成。

### Agent 4 (gpt-6.1-terra-2): 零泄漏与证据门禁审计 (PASS)
- **审查范围**: features.json 契约验证、依赖 DAG、证据类型完整性及受保护文件。
- **审查结论**: 
  1. UI-001、IMPORT-003、IMPORT-004、API-001、CLI-001 全部 5 项功能的 requiredEvidenceTypes 均在 features.json 中完备映射到真实通过的证据记录；
  2. 依赖关系验证无误：UI-001 dependsOn [RUNTIME-003, DRIVER-002, SCHED-002]（全通过）；IMPORT-003 dependsOn [IMPORT-001, SCHED-002]（全通过）；IMPORT-004 dependsOn [IMPORT-002, SCHED-002]（全通过）；API-001 dependsOn [DRIVER-001, DRIVER-002, RUNTIME-003]（全通过）；CLI-001 dependsOn [API-001]（全通过）；
  3. `creation-runtime-feature-evidence.test.ts` 36/36 全绿；
  4. 保护文件 `docs/repository-analysis-2026-11-07.md` 及两份 untracked stage-1b3 文件保持 100% 原始未改动；
  5. 累计完成功能数由 19 项晋升至 24 项（24/35）。

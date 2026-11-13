# 源码证据索引

日期：2026-11-07。以下均为本轮静态读取，不是运行证据。行号固定于调查工作树，后续源码变化须重核。

Pagekin 基线 `0679303231cc439a0d2285f5c683041d1b347f0f`；InkOS 基线 `53adac4e974b54dafda975edc4edd07cad364c18`。已有测试/CI/历史资格不是本轮 PASS。主方案见 [README](README.md)。

## Pagekin

| ID | 定位 | 确认的静态事实 |
| --- | --- | --- |
| E01 | [project-store](../../../src/stores/project-store.ts):123、140、152、619 | 切换/重开前取消原项目任务并等待，不只是提示 |
| E02 | [database](../../../electron/database.ts):21、37、71、97 | 单projectDb/currentProjectPath，打开前关闭，关库listener同步 |
| E03 | [project-access](../../../electron/services/project-access.ts):126、230、258、274 | 单activeSession，新租约覆盖；主进程校验身份/lease/root/DB |
| E04 | [import-generation-source](../../../electron/services/import-generation-source.ts):20、27；[source-binding](../../../electron/services/generation-source-binding.ts):570；[main-owner](../../../electron/services/main-generation-owner.ts):652 | 全书正文先读后筛选，准入/执行前来源重建可重复触发 |
| E05 | [orchestrator](../../../src/services/workflows/import-run-orchestrator.ts):404、498、519 | 代表章选择分页扫描全部正文，global/style各跑 |
| E06 | [run-service](../../../electron/services/generation-run-service.ts):153、201、253；[owner](../../../electron/services/main-generation-owner.ts):242、296；[controller](../../../electron/controllers/generation-controller.ts):144；[renderer](../../../src/services/generation/generation-runtime.ts):170、178、196 | delta通知，1秒/4096字节落快照；owner回读durable receipt、累计全文发送；renderer hash后去重 |
| E07 | [import-controller](../../../electron/controllers/import-controller.ts):492、516、532、577；[import repository](../../../electron/repositories/import-run-repository.ts):2271 | 异步安全读取后同步拆章/计数/hash/SQLite；批循环不等于事件循环让步 |
| E08 | [import-workflow](../../../src/services/workflows/import-workflow.ts):585；[orchestrator](../../../src/services/workflows/import-run-orchestrator.ts):359、548；[import-generation](../../../electron/services/import-generation.ts):81、115 | 阶段/批次顺序，前slot effect未committed拒新准入 |
| E09 | [base-command](../../../src/services/workflows/commands/base-command.ts):213；[workflow-main-generation](../../../src/services/workflows/workflow-main-generation.ts):167 | 同命令不允许并发/嵌套runtime；session busy |
| E10 | [import command](../../../src/services/workflows/commands/import-novel.command.ts):359、719、726、787、847；[executor](../../../src/services/workflows/structured-batch-executor.ts):543；[embedding](../../../electron/embedding.ts):331；[KB gate](../../../electron/services/knowledge-source-gate.ts):14 | 主题/embedding batch顺序；单批validatedPrefix；KB按项目gate协调 |
| E11 | [workflow-store](../../../src/stores/workflow-store.ts):301、353、452、707、745、819；[generation-controller](../../../electron/controllers/generation-controller.ts):39、110、114、134；[claims](../../../src/shared/workflow-resource-claims.ts):34 | 执行器在renderer、核验当前项目；owner Map仍全局准入，多activeRuns非多书能力 |
| E12 | [generate-field](../../../src/services/workflows/commands/generate-field.command.ts):203；[expansion](../../../src/services/workflows/novel-config-expansion.ts):46 | preserveAuthorText：原文缺失会前置保留，不是反馈重构 |
| E13 | [ArchitectureSection](../../../src/components/stage/architecture/ArchitectureSection.tsx):149；[GenerateDialog](../../../src/components/stage/architecture/ArchitectureGenerateDialog.tsx):97；[workflow](../../../src/services/workflows/architecture-workflow.ts):154；[command](../../../src/services/workflows/commands/architecture.command.ts):925 | 重生/指导真实接线，成功后写正式架构，不是候选比较 |
| E14 | [plot-outline-contract](../../../src/shared/plot-outline-contract.ts):327；[command](../../../src/services/workflows/commands/architecture.command.ts):2231 | 已有大纲范围替换/synopsis CAS，范围外原文保留 |
| E15 | [BlueprintCard](../../../src/components/stage/blueprint/BlueprintCard.tsx):20；[repository](../../../electron/repositories/blueprint-repository.ts):650 | 蓝图可编辑；full覆盖会删除本次范围外蓝图，不可用于局部修订 |
| E16 | [config tool](../../../src/services/agent/tools/propose-novel-config.tool.ts):76、106；[blueprint tool](../../../src/services/agent/tools/propose-chapter-blueprint.tool.ts):70、107；[diff](../../../src/components/panels/agent/DomainProposalDiff.tsx):99；[impact](../../../src/components/panels/agent/ConfigImpactPreview.tsx):97 | 内部字段提议/diff/影响/确认已有，不证明阶段有公开聊天入口 |
| E17 | [ChapterActions](../../../src/components/stage/chapter/ChapterActions.tsx):267；[ReviewSheet](../../../src/components/stage/chapter/ReviewSheet.tsx):198；[MergeView](../../../src/components/stage/chapter/MergeView.tsx):17；[revision repository](../../../electron/repositories/revision-repository.ts):317 | 直接修稿、意见/指导、逐块合并、冻结源校验已有；合并非每次新稿版本 |
| E18 | [mcp-manager](../../../electron/mcp/mcp-manager.ts):4；[bridge](../../../electron/mcp/mcp-ipc-bridge.ts):72；[preload](../../../electron/preload.ts):9 | MCP为出站客户端，preload为窗口IPC，不是公共入站API |
| E19 | [human-confirmed-review](../../../src/shared/human-confirmed-review.ts):6；[refine-from-review](../../../src/services/workflows/commands/refine-from-review.command.ts):57 | 人审快照有真实来源，自动决策不可伪造 |
| E20 | [batch workflow](../../../src/services/workflows/batch-chapter-workflow.ts):201、302；[guards](../../../src/services/workflow-guards.ts):219、247 | draft_review用前章候选，auto_finalize真实定稿；普通正文要求前章定稿/后处理；已有蓝图限制角色重生 |
| E21 | [agent-generation](../../../electron/services/agent-generation.ts):101、276、282、288；[launcher](../../../src/services/workflows/creative-workflow-launcher.ts):174、195 | planning主进程规范化/注册收据还原，不能因tool未直接转发判丢失；review/refine/finalize不在该注册白名单且需正文快照 |
| E22 | [主许可](../../../LICENSE)；[插件manifest](../../../plugins/dsh-ai-novel-writer/package.json):162 | 主仓GPLv3文本/插件MIT分别核查，不作新复制授权 |
| E23 | [owner](../../../electron/services/main-generation-owner.ts):630、1552；[finalization](../../../electron/repositories/finalization-repository.ts):113、209、250；[run repository](../../../electron/repositories/generation-run-repository.ts):416 | nonce/hash幂等、草稿/定稿事务收据已有，部分repository仍用全局DB；时长为根活跃区间 |
| E24 | [diagnostics](../../../electron/llm/transport-diagnostics.ts):8；[run-service](../../../electron/services/generation-run-service.ts):330；[bootstrap](../../../src/main.tsx):13 | 时间诊断/关库停止保护已有；生产transport在renderer bootstrap安装 |
| E25 | [run-service](../../../electron/services/generation-run-service.ts):210、258、308；[owner](../../../electron/services/main-generation-owner.ts):280 | Promise.race可先结束取消逻辑，provider promise未必同步结束；逻辑终态非物理槽释放证明 |
| E26 | [project-controller](../../../electron/controllers/project-controller.ts):631；[database](../../../electron/database.ts):37；[finalization](../../../electron/repositories/finalization-repository.ts):113 | 旧打开链会关闭全局DB，定稿仍有全局DB入口；迁移须封闭基础生命周期 |
| E27 | [owner](../../../electron/services/main-generation-owner.ts):652、659；[import-generation](../../../electron/services/import-generation.ts):81 | 发送前有来源/模型lease/执行authority/取消准入；队列不能削弱此边界 |
| E28 | [knowledge-base](../../../electron/knowledge-base.ts):520、535；[embedding](../../../electron/embedding.ts):331、341 | 参考文档普通embedding失败可整文档FTS-only，响应校验异常硬失败；整体向量校验已有 |
| E29 | [revision](../../../electron/repositories/revision-repository.ts):304、317；[owner](../../../electron/services/main-generation-owner.ts):855；[blueprint](../../../electron/repositories/blueprint-repository.ts):234 | 已合并回放仍核对正文；作者编辑后大纲/蓝图精确范围在提交边界校验 |
| E30 | [finalization-service](../../../electron/services/finalization-service.ts):104；[repository](../../../electron/repositories/finalization-repository.ts):250、284 | 现有finalize对快照/重开关系检查和幂等回放，不自动证明未来manifest批准来源 |
| E31 | [B01](../novel-quality-program-v3-2026-09-13/specs/B01.md):7、13、15、18、19、20；[ADR-0018](../../adr/0018-program-v3-domain-contracts.md):19；[field policy](../../../electron/services/portable-project-field-policy.json):97、110；[archive](../../../electron/services/project-archive-service.ts):815、849、876；[runtime freeze](../../../electron/services/portable-runtime-freeze.ts):16、35 | 新副本只转可读authority；机器权限排除、旧执行nonReplayable；逐字段策略/历史投影和运行冻结须随新增持久状态扩展 |

## InkOS

定位相对 InkOS 仓库根，不复制本机绝对路径；这是对照资料，不是 Pagekin 依赖/合同。

| ID | InkOS 定位 | 确认的静态事实 |
| --- | --- | --- |
| I01 | `packages/cli/src/commands/daemon.ts:41`；`packages/core/src/pipeline/scheduler.ts:149,160,163`；`packages/core/src/pipeline/runner.ts:1191,1201,1209,1221` | daemon接scheduler，跨书Promise.all，单书书锁/顺序范围检查 |
| I02 | `packages/cli/src/commands/interact.ts:13,49,89,118`；`packages/cli/src/commands/agent.ts:64`；`packages/studio/src/api/server.ts:2605,2751,2792,2817,2829,4230` | CLI接内核，HTTP领域入口/Host-Origin检查；interact JSON非完整ActionResult |
| I03 | `packages/core/src/agents/reviser.ts:100,115`；`packages/core/src/pipeline/runner.ts:874,1055,1086,1108,1120` | 指令/范围/原文绑定、局部替换、新版本/复审；旧章改动标影响不回退当前真相 |
| I04 | `packages/core/src/harness/artifact-revisions.ts:39`；`packages/core/src/harness/artifact-reader.ts:27,35`；`packages/core/src/harness/runtime.ts:163,181`；`packages/core/src/harness/episode-store.ts:55`；`packages/core/src/utils/atomic-file-set.ts:18,141`；`packages/core/src/state/manager.ts:129` | checksum/realpath、版本链/事件；文件journal/恢复、书锁是不同边界 |
| I05 | `packages/core/src/utils/memory-retrieval.ts:79,98,125,151`；`packages/core/src/retrieval/local-search.ts:27`；`packages/core/src/harness/context-compiler.ts:110,117,190` | BM25可重建；追加未命中候选全文；protected超预算拒绝，不照搬token门 |
| I06 | `skills/SKILL.md:11`；`packages/core/src/skills/registry.ts:13`；`packages/core/src/agents/base.ts:140`；`README.md:612` | Skill不授写权、manifest/Profile/hash有实现；自定义agent插件仍路线图 |
| I07 | `packages/core/src/pipeline/chapter-review.ts:50,64`；`packages/core/src/pipeline/chapter-persistence.ts:25`；`packages/core/src/agents/review-tool.ts:14,39,40`；`packages/core/src/agent/turn-completion.ts:19,47,58` | unavailable、quality/execution/scope分开；版本变化与scope问题参与终局检查 |
| I08 | `packages/core/src/pipeline/scheduler.ts:38,83,95,125,132,160,169,196,252` | 内存日计数/成功后累计/固定前N/tick保护；停止非在途取消；简化cron间隔 |
| I09 | `package.json:21`；`packages/core/package.json:50`；`packages/cli/package.json:32`；`packages/studio/package.json:12`；`LICENSE` | 包声明AGPL-3.0-only，本轮不迁代码/Skill文本 |
| I10 | `packages/studio/src/api/server.ts:4584,4592,4593` | retryOfRequestId/baselineWork保留原请求基线；只借鉴已知可恢复操作，不放宽unknown防重发 |

## 后续验证入口，只读未执行

| 影响面 | 当前入口 | 需聚焦/新增的断言 |
| --- | --- | --- |
| 拆书 | `electron/services/__tests__/import-generation.test.ts`、`import-generation-continue.test.ts`、`import-generation-budget.test.ts`；`src/services/workflows/__tests__/import-run-orchestrator.test.ts` | 精确样本/缺号/短书、每批读取量、来源变化、stage/effect/recovery |
| 导入租约 | `electron/repositories/__tests__/import-run-orchestrator-integration.test.ts`、`import-run-execution-lease.test.ts`；`src/components/dialogs/__tests__/import-novel-resume.browser.tsx` | 乱序、失lease、提交后同步失败、取消/关窗/重启、unknown不重发 |
| 流式/owner | `electron/services/__tests__/generation-run-service.test.ts`、`main-generation-owner.test.ts`；`src/services/generation/__tests__/generation-runtime-owner.test.ts` | 相同revision/高频诊断/异常同revision正文、乱序终态、存储失败/重连 |
| 生命周期 | `src/stores/__tests__/project-close-lifecycle.test.ts`、`project-refresh-context.test.ts`；`electron/services/__tests__/project-access.test.ts`；`src/components/__tests__/project-session-gate.test.ts` | A/B runtime隔离、UI/CLI同锁、双host/epoch |
| 规划/审修 | `src/services/workflows/commands/__tests__/review-revision-runtime.test.ts`、`structured-planning-runtime.test.ts`；`electron/repositories/__tests__/revision-repository.test.ts`；stage浏览器测试 | 意见落实、候选不覆盖、部分采用、范围外不变、缓冲/自动决策非人审 |
| 便携归档/恢复 | `electron/services/__tests__/project-archive-service.test.ts`、`project-restore-service.test.ts`、`portable-project-archive.test.ts` | 新持久状态逐字段处置、同项目重启与新副本恢复分开、旧grant/批准/step不可执行、内容保全 |
| 质量/驱动 | 现行质量协议、`.claude/skills/verify/SKILL.md` 下驱动 | 先读隔离/命令合同、另授权；驱动非生产headless；性能/文学/平台分开 |

这是存在入口及覆盖方向，不声称已有全部新断言或本轮通过。新 API/driver/多运行时/跨批依赖需要相应新测试与执行授权。

## Stage62 增量证据

- 实际四主题入口、调用端与来源提交门：`electron/controllers/generation-controller.ts`、`electron/services/main-generation-owner.ts`、`electron/services/import-query-materials.ts`、`electron/controllers/db-controller.ts`、`src/services/workflows/commands/import-novel.command.ts`。版本化请求只接受 handle 与 owner/epoch，保留作者原稿独立检索和原始主题材料顺序。
- 同根预算、物理活动时长与恢复：`electron/repositories/import-query-repository.ts`、`electron/repositories/generation-run-repository.ts`、`electron/services/import-generation.ts`；M18/schema19 的 history、排除字段、闭合 receipt 投影及双代新副本恢复沿现有便携链处理。
- 本轮最终实际证据及全部失败链见 [Stage62 evidence](stage-62-evidence.md)：service578、persistence370、controller186、consumer/error196 各报告独立通过且有非实施者复审，不相加为新分母。源码/原始报告/构建身份由 [Stage62 manifest](stage-62-source-manifest.json) 绑定。仅为 SCHED-001、IMPORT-001/002 部分证据，35 项功能状态不提升；无真实模型、Electron、平台或四主题并行提速结论。

## Stage63 增量证据

- 单书实际网络准入及有界主题 workers：`electron/services/generation-scheduler.ts`、`electron/controllers/generation-controller.ts`、`electron/services/import-query-materials.ts`；同一 project key 的普通生成 exclusive / 独立查询 shared claims，原始根额度与物理活动时长、KB 来源和提交门保留。默认并发仍为1。
- 实际注册 IPC、文档原 batch outcome、取消/unknown/drain 与恢复证据见 [Stage63 evidence](stage-63-evidence.md)：controller191、materials232、document104、service588 是分别通过且重叠的报告，不合并计数；所有失败链保留。源码、原始报告与本轮新构建入口由 [Stage63 manifest](stage-63-source-manifest.json) 绑定。
- SCHED-001 三条 AC、PERF-001 前置、G-IMPLEMENT/G-RUN 和 deterministic/performance 已逐项核定，fresh typecheck/lint/colors/i18n/build 均0，独立 source/runtime review 无范围内阻断。仅 SCHED-001 提升 completed/true，功能总计11 completed/24 in_progress；IMPORT-001/002 仍仅补充前置证据。
- 三对 query 受控观察显示实际峰值1/2与完整非空材料一致，未证明稳定提速；原文档观察不等于服务商性能。无真实模型、Electron、文学质量、完整导入、视觉、平台或35项累计终审结论。

## Stage64 增量证据

- 主进程知识阶段实际入口：`src/shared/reference-knowledge-contract.ts`、`electron/controllers/reference-knowledge-controller.ts`、`electron/services/reference-knowledge-authority.ts`；closed execute/progress、现有 private issuance、原有 owner/epoch heartbeat、收据/checkpoint/knowledge-to-global writer 与整阶段 foreground barrier。`electron/controllers/db-controller.ts` 隔离旧同 run writer；requestCancel 仍可达。
- 生产委托和既有投影：`src/services/workflows/import-run-orchestrator.ts`、`import-workflow.ts`；renderer 不再重复知识循环/续租/终态写入，完整 reference/owner/epoch 过滤后只投影原中英文日志和原批次进度。作者原稿及后续阶段不变。
- 最终实际 [Stage64 evidence](stage-64-evidence.md)：15文件513/513，含 native18/18；撤权终态 RED3fail 到 GREEN3pass、主驱动10/10及全部历史失败均保留，不相加。独立 source/runtime review 闭环 P2，fresh typecheck/lint/colors/i18n/build 均0；[manifest](stage-64-source-manifest.json) 绑定实际来源、原始报告与本轮构建入口。
- ADR0074 只接受 foreground knowledge-stage ownership；IMPORT001/002 只补部分证据，所有状态不变，仍11completed/24in_progress。无完整拆书/仿写、A-to-B/background、Electron 进程、真实模型/文学质量、视觉、平台或35项累计终审结论。

## Stage65 增量证据

- [ADR0075](../../adr/0075-main-owned-foreground-reference-style.md) 接受 issued foreground reference style/done 的主进程所有权：`reference-style-contract.ts`、`reference-style-foreground.ts`、`reference-style-driver.ts`。原生取样、冻结任务、原 root/model/ordinal0、receipt/checkpoint/style-to-blueprints、heartbeat/终态和物理 drain 由 main 执行；`import-stage-flight.ts` 隔离同 run 旧写入口。
- `import-run-orchestrator.ts`、`import-workflow.ts` 保留原 whole-config CAS、自动 opened/commit-ready ACK、已验证全文快照与 reasoning、原日志/进度和未保存缓冲。历史 receipt 不是当前 config；completed-null 只读恢复不重建权限，已 commit 未 advance 仅补推进，unknown 不重发。
- [Stage65 evidence](stage-65-evidence.md) 记录最终19文件592/592（含 native21/unit11/renderer123）及独立4文件428/428、fresh typecheck/lint/colors/i18n/build 全0和全部失败修复链；报告不相加。Sol 独立接受当前 source/runtime/quality，Terra另审非自有 native/artifacts；[manifest](stage-65-source-manifest.json) 绑定来源、原始报告和本轮实际构建入口。
- 仅 IMPORT001/002 各补 contract_review/deterministic 部分证据，所有35项状态、门禁、依赖及既有证据不变，仍11completed/24in_progress。无完整拆书/仿写或目标采用、后续阶段迁移、A-to-B/background、Electron 进程、真实模型/文学质量、视觉、平台或累计终审资格。

## Stage66 增量证据

- [ADR0076](../../adr/0076-main-owned-foreground-reference-global.md) 限定 issued foreground reference global/done：`reference-global-contract.ts`、`reference-global-foreground.ts`、`reference-global-driver.ts`。main 执行原冻结材料/Skill、同 root/model 的顺序 inference/syntax/endpoint ordinals、query sources 门、effect/proposal/checkpoint/global-to-style、heartbeat/终态和物理 drain；不新增 ledger/schema/grant/额度或后台权限。
- 原 global 契约不同于 style：只有自动 opened-readiness ACK，解码后 roster revision CAS 与提交后 unsaved-edits 投影保留，不增 whole-config precommit 拒绝。renderer 保留全文快照、reasoning、原双语日志/进度/候选、当前 core 重放、dirty/session 隔离；trusted diagnostics/bounded completion 的闭合元数据仅恢复原安全解释。
- [Stage66 evidence](stage-66-evidence.md) 记录 final24文件697/697（native39/unit4/Skill7/contract26/renderer146）、独立4文件428/428及 fresh typecheck/lint/colors/i18n/build 全0；真实 unknown/persistence 查询竞争和 workflow-store 日志 RED/GREEN 全部保留。报告不相加，[manifest](stage-66-source-manifest.json) 绑定来源、38raw、28reported paths 与本轮16个实际构建入口。
- 仅 IMPORT001/002 各补 contract_review/deterministic 部分证据，全部35项状态、门禁、依赖和既有记录不变，仍11completed/24in_progress。无完整拆书/仿写、蓝图/refresh 完整迁移、目标采用、A-to-B/background、Electron 进程、真实模型/文学质量、视觉、性能提升、平台或累计终审资格。

## Stage67 增量证据

- [ADR0077](../../adr/0077-main-owned-foreground-reference-blueprints.md) 仅接受 issued foreground reference blueprints 的完整主进程循环：原 page100/contiguous-max5/checkpoint 分组、每 range 空 prefix、原任务/Skill/root/model/ordinal、结构化拆分及一次语法修复、canonical commit/sync/blueprints-to-refresh、heartbeat/终态和物理 drain；保留所有未知请求、预算和来源保护。
- `reference-blueprint-contract.ts`、`reference-blueprint-foreground.ts`、`reference-blueprint-driver.ts` 与现有 orchestrator/workflow 维持精确 handle 的自动 readiness、原全文快照/reasoning、原日志/进度/receipt/context/刷新顺序。角色同步仍只形成待采用提议；prepared/committed/completed-null 恢复不补发请求或重建权限。长度例外仅允许同 reference-blueprints run/root 已知 length 的后续有界 ordinal，length 本身不成为可提交输出。
- [Stage67 evidence](stage-67-evidence.md) 记录 final20文件620/620（native39/unit8/renderer161）、独立8文件528/528、fresh type/lint/colors/i18n/build 全0，以及所有初始失败/RED/GREEN；报告不相加。[manifest](stage-67-source-manifest.json) 绑定当前源码、原始报告及本轮实际构建入口。Sol 独立接受 bounded source/runtime，Terra 另审非自有 native/DB/artifacts。
- 仅 IMPORT001/002 各追加 contract_review/deterministic 部分证据，所有状态、passes、依赖、门禁、required evidence 和旧记录不变，仍11completed/24in_progress。无完整拆书/仿写、refresh 所有权、目标采用、A-to-B/background、Electron 进程、真实模型/文学质量、视觉、提速、平台或累计终审资格。

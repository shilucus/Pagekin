# Pagekin 当前仓库分析与开发维护报告

## 1. 结论与适用范围

Pagekin（书童，原 AI Novel Writer）是领域约束较多的本地优先小说写作桌面应用，而不是单纯的 AI 文本编辑器。当前主干已采用纸墨阶段式界面；长期维护重点在于项目会话、生成收据、SQLite 领域事务、来源绑定、可恢复投影，以及三目标安装包资格链。

本报告覆盖仓库结构、核心架构、用户能力、端到端流程、数据与安全边界、开发工具链、测试与 CI、发布、插件隔离及维护路线。它是当前 checkout 的静态接手报告，不是逐行安全审计、全部规格符合性认证，也不是新产品规格或新执行授权。

### 1.1 快照

| 项目 | 本轮观察 |
| --- | --- |
| 分析日期 | 2026-11-07，按本次工作区提供的 Asia/Shanghai 日期 |
| 分支 | `master`，状态显示跟踪 `origin/master`；未 fetch，不推断远端实时状态 |
| 基线提交 | `0679303231cc439a0d2285f5c683041d1b347f0f` |
| 最近提交 | 2026-11-06，合并 `.mjs` ESLint 相关变更 |
| 初始工作区 | `git status --short` 为空；只发现一个本地 worktree |
| 包版本 | `package.json` 为 `1.4.0`，不据此断言远端最新 Release 版本 |
| 依赖环境 | 根目录不存在 `node_modules`；未安装依赖、未查询真实用户配置 |
| 本轮写入 | 仅新增本报告和根 `AGENTS.md`；未修改源码、配置、依赖或执行 Git 写操作 |

### 1.2 团队与证据等级

| 成员 | 实际配置/角色 | 覆盖 |
| --- | --- | --- |
| 主线程 | 当前会话继承模型；不猜测不可见的具体型号 | 仓库清点、前端与工程结构、证据交叉核对、文档撰写与集成 |
| 领域分析成员 | `gpt-6-luna`，high；仅只读 | 写作领域、Agent/工作流、生成契约、事实源及领域测试 |
| 平台分析成员 | `gpt-6.1-terra`，high；仅只读 | Electron、IPC、文件授权、存储/迁移、备份、发布与 CI |

两种用户指定模型均已通过 spawn 接口创建，未发生模型替换。成员结论由主线程回查关键源码；一致意见不代替代码证据。

- **已确认（静态）**：当前文件、配置、定义/直接调用或测试定义支持该结论。
- **推断**：由结构和依赖关系提出的维护判断，未量化为运行性能或产品故障。
- **证据不足/未执行**：缺少运行、平台、真实模型、远端或用户状态证据。
- 检索采用 `rg`、文件读取和只读 Git 查询；没有可用的 CodeGraph/AST/LSP 组合工具，故使用定义、调用处与聚焦测试交叉定位，不宣称得到完整语义调用图。

## 2. 产品边界与当前能力

### 2.1 产品范围

桌面应用负责一本小说从设定、架构、蓝图，到写稿、审稿、修稿、合并和定稿的本地编排。模型由用户自行配置；作品本地保存，发起生成时相关材料会发送给所选 provider。本地优先不等于离线、不等于配置自动加密，也不等于数据不会离开设备。

正式发布目标为 Windows x64、macOS arm64、macOS x64。仓库保留 Linux AppImage 配置，但 release profile 不包含 Linux，项目文件安全层也不提供通用 Linux 等价实现，不能将其列为已支持桌面平台。

依据：`README.md:53`、`README.md:188`、`docs/product-domain.md:5`、`.release/release-profile.json:4`、`electron/security/windows-safe-file-system.ts:519`。

### 2.2 能力与入口地图

| 能力 | 当前主要入口/模块 | 维护注意 |
| --- | --- | --- |
| 书房、新建、打开、旧项目导入 | `src/components/stage/library/`、`project-store.ts`、project controller | 目录选择能力、迁移准入和会话切换不是普通页面切换 |
| 设定、写作语言 | `stage/setup/`、project core/config | UI 语言与作品写作语言分开 |
| 小说拆解、仿写与原稿续写 | `ImportNovelDialog`、import controller/workflow | 参考资料与作者原稿分流，不混入对方事实链 |
| 故事前提、人物、世界观、大纲 | `stage/architecture/`、`stage/characters/`、architecture workflow | 结构化角色名单是事实源，不由图谱反向覆盖 |
| 章节蓝图、分批规划、恢复 | `stage/blueprint/`、directory workflow、blueprint repository | 范围、来源、检查点和恢复稿须保持对应 |
| 单章写作、选段生成 | `stage/chapter/`、`stage/write/`、generation/inline services | 正文流与可恢复候选不等于正式保存 |
| 审稿、修稿、差异合并、定稿 | review/refine/finalize commands、review/finalization repositories | 作者选择、修订与正式提交分开 |
| 替换定稿、章节回收站 | chapter reopen/deletion services、`stage/trash/` | 重开关系、恢复方式、异步清理和唯一当前定稿 |
| 运行、取消、暂停、诊断 | `stage/run/`、workflow store、main generation owner | UI 运行投影不等于领域事实 |
| 知识库、叙事线索、剧情树 | `stage/knowledge/`、`stage/plot/`、KB/vector services | 作者资料与只读派生快照区分 |
| 历史、导出、本地归档、WebDAV | `stage/history/`、archive/restore/cloud controllers | 新副本恢复，不携机器权限或重放旧执行 |
| 模型、提示词、写作 Skills | `stage/settings/`、`components/settings/`、LLM/skills contracts | provider 协议、阶段绑定、内容冻结与密钥处理 |
| 应用更新 | update controller/services、`StageUpdate.tsx` | Windows 下载更新与 macOS 手动更新语义不同 |

能力表表示源码与入口存在，不表示本轮已逐项运行验收。聊天助手入口当前隐藏，但 Agent 工具和领域接线仍保留，不能据 UI 隐藏认定后端无用。

依据：`src/App.tsx:174`、`src/components/stage/StageWorkspace.tsx:35`、`src/stores/navigation/navigation-intents.ts:5`、ADR-0008、ADR-0021、ADR-0024、ADR-0025。

## 3. 仓库规模与结构

以下按初始 `git ls-files` 统计，不扫描依赖目录或把新文档计入历史基线。

| 范围 | 跟踪文件数 | 职责 |
| --- | ---: | --- |
| 全仓库 | 2,229 | 源码、文档、测试、资源与工程工具 |
| `src/` | 838 | renderer、共享契约、客户端服务和测试 |
| `electron/` | 388 | 主进程、持久层、安全、provider 和测试 |
| `docs/` | 562 | 领域、ADR、设计、历史计划、研究与证据 |
| `scripts/` | 232 | 工程、资格驱动、打包、审计与测试 |
| `plugins/` | 106 | 独立 DSH 插件及其测试/文档 |
| `test/` | 21 | 测试 setup、共享夹具与桌面 helper |
| `.release/` | 20 | 正式发布 profile、promotion 和资产保留脚本 |
| `.github/` | 11 | 七个 workflow、Issue/PR 模板 |

按 `*.test.*`、`*.spec.*`、`*.browser.tsx` 文件名统计出 616 个测试文件，其中 86 个为浏览器文件；这不是测试用例数量、覆盖率或通过数。根 `AGENTS.md` 当前被 `.gitignore:54` 忽略，属于既有本机上下文策略。

```text
src/main.tsx                    renderer 启动与 transport 安装
src/components/startup/          主进程/外观双确认启动门
src/components/stage/            纸墨主界面与阶段页面
src/components/ui/               共享原语与浮层
src/stores/                      Zustand 交互、编辑和运行状态
src/services/                    领域编排、生成客户端、工作流和 Agent
src/shared/                      跨进程契约、纯领域逻辑
src/i18n/                        中英文与错误消息
electron/main.ts                进程启动、单实例、窗口、全局迁移
electron/controllers/           IPC 边界与输入/会话校验
electron/services/              业务服务、权限、生成 owner、迁移/恢复
electron/repositories/          SQLite 领域事务和查询
electron/migrations/            迁移注册与准入
electron/security/              Windows/macOS 安全文件能力
electron/llm/                   provider 协议与参数策略
scripts/、.release/、.github/    验证、构建、发布与证据链
plugins/dsh-ai-novel-writer/     独立插件产品
```

没有独立的 `src/types/` 或 `docs/architecture/` 目录；不要按通用模板寻找它们。类型集中在 `src/shared/` 和实际 owner，架构决定集中在 `docs/adr/`。

## 4. 技术栈与工具链

版本列是当前 `package.json` 的声明；带 `^` 的不是本轮已安装版本，精确解析应查锁文件。未进行在线最新版、漏洞库或依赖许可证审计。

| 层 | 当前声明 |
| --- | --- |
| 运行/包管理 | Node `>=22.14.0`；`pnpm@11.11.0`；主要 CI 固定 Node `22.23.1` |
| 桌面 | Electron `^44.9.3`、electron-builder `^26.15.0`、electron-updater `6.8.9` |
| renderer | React/React DOM `^19.2.5`、TypeScript `^6.0.2`、Zustand `^5.0.0` |
| 构建/样式 | Vite `^8.2.4`、Tailwind CSS `^4.2.2`、PostCSS、vite-plugin-electron |
| 编辑/组件 | CodeMirror 6、Radix UI、lucide-react、react-resizable-panels |
| 持久化/检索 | better-sqlite3 `^13.0.3`、LanceDB `0.22.3`、Apache Arrow |
| 质量工具 | Vitest `^4.1.10`、Playwright `^1.59.1`、ESLint 8、Storybook 10、fast-check |

工程约束：

1. `tsconfig.json` 启用 strict、noUnused 和 noEmit，检查范围为 `src` 与 `electron`，不包括全部脚本/文档/插件；Storybook stories 另有排除。
2. Vite 主进程构建使用 CJS，native 包标为 external；renderer 使用 `base: './'`，适配安装后 `file://` 资源，不能随意改成根路径。
3. 开发服务器严格绑定 `127.0.0.1:5180`，`strictPort: true`。端口冲突会失败，不是自动换端口。
4. `pnpm-workspace.yaml` 目前提供 allowBuilds 与 overrides，不要仅凭文件名推断插件已并入统一 workspace；插件有自己的 package/lockfile/CI。
5. better-sqlite3 的安装构建被禁用、electron-builder `npmRebuild: false`，当前方案使用 Node-API 预编译包；不要照旧计划盲目加入 `rebuild:electron`，该脚本当前不存在。
6. LanceDB 必须经 `electron/lance-database.ts` 打开，新表格式固定为 `2.0`，ESLint 对直接值导入设有限制。升级 native 依赖必须考虑旧库读回、目标架构和包内资源。

依据：`package.json:8`、`package.json:43`、`vite.config.ts:18`、`tsconfig.json:19`、`pnpm-workspace.yaml:1`、`electron-builder.json5:6`、`electron/lance-database.ts:1`、`.eslintrc.cjs:14`。

模型接入还须区分“厂商预设”与“传输协议”。`electron/llm/llm-factory.ts:7` 按 `model.protocol` 分派 Gemini、Anthropic，默认走 OpenAI provider；`src/shared/provider-presets.ts`、参数策略和阶段路由补充 endpoint/模型差异。源码有某协议实现不等于所有相关厂商、模型与参数组合都已在线验证。

## 5. 分层架构与进程边界

```text
renderer: Stage 页面 / 编辑器 / 对话框
  -> Zustand stores、navigation intents、workflow commands
  -> generation runtime / typed ipc client
  -> window.aiNovelAPI（preload contextBridge）
main: IPC controllers
  -> ProjectAccess / grant / model execution lease / generation owner
  -> 领域 services + repositories + SQLite 事务
  -> 安全文件 helper / outbox publisher / LanceDB / provider / WebDAV
main -> 事件与持久快照 -> renderer 投影
```

### 5.1 renderer

`src/main.tsx` 先安装 `mainGenerationTransport`，再挂载 `RendererStartup`。启动门等待 main ready、读取/迁移外观偏好、localStorage 写后读回及主进程 ack，满足条件后才动态导入 `App`。这样外观或全局迁移受阻时不提前加载编辑工作台。工作台已挂载后的偏好保存失败不会通过卸载 App 丢失内存编辑。

`App` 管主题、语言、模型和最近项目初始化、全局事件与对话框、更新提示和关窗保护，主界面由 `StageRoot`、`StageShell`、`StageWorkspace` 承接。

依据：`src/main.tsx:15`、`src/components/startup/RendererStartup.tsx:12`、`src/stores/appearance-bootstrap.ts:45`、`src/App.tsx:26`。

### 5.2 主进程

`electron/main.ts` 固定默认 userData、获取单实例锁、执行全局迁移，并在准入成功后注册业务 IPC。BrowserWindow 关闭 Node integration、启用 context isolation，限制新窗口与导航。平台 helper 和主进程是文件授权边界，renderer 的路径比较只用于 UI 身份，不是文件安全证明。

IPC 主要经 `electron/ipc-handlers.ts` 注册各 controller。已检查的项目文件、数据库和知识库等业务通道携带会话，由主进程核对 `projectId/leaseId/canonical root/current database`；创建、打开项目和外部目录选择则按各自 grant、准入及生命周期合同处理，不能推断全部 `project:*` 请求同形。

依据：`electron/main.ts:72`、`electron/main.ts:145`、`electron/main.ts:247`、`electron/ipc-handlers.ts:35`、`electron/services/project-access.ts:258`、`electron/controllers/fs-controller.ts:129`。

### 5.3 IPC 合同

`src/shared/ipc-channels.ts` 与专门 contract 定义参数和返回，`ipc-client.ts` 分类项目级、grant/app-data 通道，并附加会话。`preload.ts` 运行时仍接受字符串 channel，类型系统不等于运行时白名单；新增 handler 必须自行检查边界，不能依赖 renderer 已校验。

本轮没有逐个 handler 做安全审计，不能从现有若干安全检查推断全部 IPC 同等安全，也不能单凭字符串桥断言存在可利用漏洞。

依据：`src/services/ipc-client.ts:17`、`src/services/ipc-client.ts:29`、`src/services/ipc-client.ts:61`、`electron/preload.ts:9`、`src/shared/desktop-api.ts:1`。

## 6. 核心业务链路与维护不变量

### 6.1 打开/切换项目

```text
目录选择或已有授权 -> project:open
  -> canonical root / manifest / DB 迁移准入
  -> 返回 projectId、path、sessionLease
  -> project-store 与 active session 更新
  -> 加载 drafts/角色/阶段事实 -> 导航落点
```

同一路径重新打开也是新会话。异步读取、事件、工作流和保存操作必须绑定发起时会话；await 返回后或提交前再次核对，避免把前一作品结果写到新作品。切换项目还须照顾未保存设置、编辑标签与在途任务。

依据：`electron/controllers/project-controller.ts:579`、`src/shared/project-session-context.ts:87`、`src/stores/project-store.ts`、`src/components/settings/unsaved-settings.ts:67`。

### 6.2 生成/Agent/工作流

工作流定义和 commands 组装实际动作，`workflow-store` 管步骤、历史、取消/暂停和资源冲突；`CreativeWorkflowLauncher` 做领域前置条件、会话核对、注册与启动收据。Agent 对小说领域事实的写入使用既有领域动作，不通过普通文件写入伪造角色/蓝图等数据库事实；这不涵盖所有通用工具和 MCP 外部工具。

普通工作流的 `base-command.createRuntime` 在有 main-generation 请求时进入 `createWorkflowMainGenerationRuntime`，经 `generation:begin/execute` 到 main owner，冻结来源和模型执行 lease，持久化 Run/Attempt/Artifact，执行 reserve -> dispatch -> settle。renderer 消费快照和收据。有效完成要求正确终态，不能把流式文本出现或 `length` 截断当成完整生成。

特别注意：`generation-runtime.ts` 无 runHandle 的兼容分支仍会创建本地 harness；`generation-harness.ts` 内还有 context/token 预检，不能把该文件所有分支都说成已取消预检。当前生产主通路、main owner 与 ADR-0023 需要串起来核对。

按 ADR-0023，主进程生产发送不按本地输入估计和累计 token liability 拒发；输出上限来自模型、作者设置及冻结根策略，服务商负责上下文容量拒绝。物理次数、活动时长、来源校验、unknown 不自动重发和账本仍保留。基础策略包含 32 次、3,600,000 ms，批量/规划等会按实际根策略缩放，不能写成所有任务固定 32 次。结构化任务仍可能按输出上限要求缩小语义范围，这不同于一般长提示的输入 token 预拒绝。

依据：`src/services/workflows/creative-workflow-launcher.ts:142`、`src/stores/workflow-store.ts:452`、`src/services/workflows/commands/base-command.ts:158`、`src/services/workflows/workflow-main-generation.ts:44`、`src/services/generation/generation-runtime.ts:223`、`:422`、`electron/controllers/generation-controller.ts:134`、`electron/services/main-generation-owner.ts:651`、`electron/services/main-generation-plan.ts:16`、`:275`、`src/services/generation/generation-harness.ts:613`、ADR-0008、ADR-0023。

### 6.3 定稿、投影和后处理

```text
作者确认 -> finalize command 冻结正文快照
  -> finalization:commit -> FinalizationRepository 事务
  -> 正式稿件状态 + 不可变收据 + publication outbox
  -> 发布实体正文文件 -> 知识库/章节要点/角色状态等后处理
```

权威点在 SQLite 提交，不在 `.txt` 文件写成功或 UI 动画结束。投影可重试；后处理失败不得回滚正式正文，也不得隐瞒失败。来源绑定包含稿件身份、定稿收据、章节号和正文 hash，不能用“相同文本”替代全部身份校验。

依据：`src/services/workflows/commands/finalize-chapter.command.ts:500`、`electron/repositories/finalization-repository.ts:250`、ADR-0003、ADR-0017。

### 6.4 重开、替换、删除与恢复

| 动作 | 已接受语义 | 联动检查 |
| --- | --- | --- |
| 重开定稿 | 创建工作稿，原定稿仍权威，直到新稿完成替换 | 编辑缓冲、审修上下文、重开关系 |
| 替换定稿 | 原稿降为只读 superseded，保留正文快照/收据 | 新投影、旧知识/文件清理、线索确认、影响提示 |
| 删除章节 | 原地标 deleted，live 视图排除，实体/知识投影按收据清理 | 提示词、统计、派生事实、回收站、串行清理 |
| 恢复 | into-gap / as-history / reopen-as-draft，提交时重算方式 | 碰撞文件、未完成清理、批量在途、便携冻结历史 |
| 彻底删除 | 物理删除本项内容/行/后处理，保留必要删除收据 | 单独授权、备份、历史证明与幂等 |

同章最多一个当前 finalized；状态 writer 职责不能散落到任意 repository。ADR-0024/0025 已修订早期连续性规则：替换、软删除和恢复不推进后续连续性水位，后面章节不会自动改写。重复定稿修复是另一来源纠正路径，不能混为删除/恢复。

依据：`docs/adr/0024-replace-finalized-chapter-via-reopened-draft.md:13`、`docs/adr/0025-chapter-trash-soft-delete-and-restore.md:11`、`electron/repositories/finalization-repository.ts:397`、`:453`、`electron/repositories/chapter-deletion-repository.ts:517`。

### 6.5 角色、连续性、知识库与剧情树

- 结构化角色名单是角色身份、资料、关系事实源。动态字段区分 author、finalized-derived、legacy 来源，派生值不冒充作者确认。
- 摘要/角色状态等必须绑定实际定稿来源；存在可定位引文只是机械一致性，不证明语义准确。
- 叙事线索可由作者确认并参与适当章节上下文；剧情树只是展示快照，不参与正文提示词，不成为第二套剧情事实。
- 知识库有原始内容、文本索引和向量空间/维度等独立契约；模型切换或库迁移必须考虑旧数据可读、重建和关闭中的异步搜索生命周期。
- `ai-novel://` 和兼容的 `vela://` 由资源协议解析，虚拟资源地址不是 OS 文件权限。角色事实不走普通资源写入覆盖。

依据：ADR-0004、ADR-0007、ADR-0013、ADR-0014、ADR-0017；`src/shared/project-paths.ts:18`、`electron/knowledge-base.ts`、`electron/vector-store.ts` 及对应生命周期测试。

### 6.6 小说导入、拆解与原稿续写

小说文件导入与“旧项目副本导入”是两条不同功能。小说入口接受 txt/md/text/epub，主进程把选择、受限读取和 inspection token 绑定起来；用途分为 `reference` 与 `author-manuscript`。

| 用途 | 处理链 | 事实边界 |
| --- | --- | --- |
| reference | knowledge -> global/style/blueprints -> refresh | 参考小说不直接变成当前作品的正式稿件，拆解/建议有自己的应用合同 |
| author-manuscript | author-commit -> author-publish -> author-postprocess -> refresh | 原稿正文作为权威稿件输入，按正式提交/投影链保存 |
| author-manuscript + authorInference | 上述原稿处理后再反推 global/style/blueprints | 可选 AI 反推不改变原稿正文的权威输入性质 |

导入运行保存阶段、来源身份与效果收据，重试不能悄悄换源或重复产生正式副作用。旧项目副本导入则由 ADR-0020 和格式迁移服务规定，转换不借此自动调用 AI，也不覆盖旧目录。

依据：`electron/controllers/import-controller.ts:324`、`:392`、`src/shared/import-run.ts:37`、`src/services/workflows/import-workflow.ts:507`、`:567`、`electron/repositories/import-run-repository.ts:1438`、ADR-0020。

## 7. 持久数据、迁移和备份

### 7.1 数据位置与边界

| 数据域 | 默认/逻辑位置 | 内容与边界 |
| --- | --- | --- |
| Electron profile | `appData/ai-novel-writer` | Chromium/localStorage 等；显式 `--user-data-dir` 可改变 |
| 全局业务数据 | 普通默认启动为同级 `ai-novel-writer-data` | `models.json`、`config.json`、最近项目、提示词/Skills 等；环境可覆盖 |
| 单部作品 | 用户项目根下 `.ai-novel/` 及正文投影 | project manifest、`project.db`、项目资料/向量/资产等；canonical locator 负责准入 |
| legacy 来源 | 全局默认用户目录 `.vela`；项目另有旧格式 | 迁移源、journal、staging/保留物，不是可随意删除缓存 |

`resolveGlobalDataRoots` 检测 canonical target 与 userData 同名时改用 `-data`。当前 README 对模型配置目录的描述不够准确，实际排障应先查 locator 和本次启动参数，不能照文档直接迁移数据。

依据：`electron/services/app-data-locator.ts:10`、`:14`、`:45`、`src/shared/project-format.ts:1`、`src/shared/project-storage.ts:7`、ADR-0022。

### 7.2 SQLite 与迁移

SQLite 使用 WAL；当前 schema version 为 8，M00-M07 由 `desktop-registry.ts` 统一注册。manifest schema、物理 storage version 和 SQLite schema version 是三种契约，不能因为数值不同认定损坏。

迁移 runner 每步事务提交；后一步失败不意味着之前成功步骤全部回滚。物理项目迁移另有 journal/staging/legacy、源与目标指纹和准入检查；不完整 journal 可阻断打开。修复需先判断失败发生在哪一层，保留现场和可恢复副本，不手改 PRAGMA 或删除 marker 伪装成功。

依据：`electron/database.ts:32`、`:44`、`electron/migrations/desktop-registry.ts:17`、`electron/migrations/runner.ts:43`、`electron/services/project-data-locator.ts:21`、`electron/services/project-format-migration.ts:241`。

主要持久聚合与维护 owner 如下；这是定位图，不是额外的一份 SQL schema 定义。

| 聚合/记录 | 主要 owner（均在 `electron/repositories/`） | 关键关联 |
| --- | --- | --- |
| 项目设定与架构 | `project-core-repository.ts` | 配置、前提、世界观、大纲与规划来源 |
| 章节蓝图 | `blueprint-repository.ts` | 章号、结构化内容、范围提交与生成来源 |
| 稿件与定稿 | `draft-repository.ts`、`finalization-repository.ts` | 草稿版本、正式正文、重开关系、收据和 outbox |
| 审稿、修稿与审修周期 | `review-repository.ts`、`revision-repository.ts`、`review-cycle-repository.ts` | 来源稿件、作者选择、合并与证据 |
| 角色名单与状态 | `character-roster-repository.ts`、`character-repository.ts` | 稳定身份、字段来源和派生投影 |
| 长期叙事线索 | `narrative-thread-repository.ts` | 作者计划、正文证据与定稿确认 |
| 生成运行账本 | `generation-run-repository.ts` | 根运行、物理尝试、预算、artifact 与持久快照 |
| 导入运行与效果 | `import-run-repository.ts` | 导入来源身份、建议/应用、恢复与副作用收据 |
| 章节回收站 | `chapter-deletion-repository.ts` | 删除主收据、恢复方式和清理状态 |

### 7.3 归档、恢复与 WebDAV

本地完整归档与 WebDAV 备份共用便携数据边界，恢复是新副本和新身份，不把原项目覆盖成另一份数据。执行历史在转移时冻结为 nonReplayable，机器路径能力、用户授权和秘密不能作为可携权限恢复。

WebDAV 属于手动备份，不是实时同步，也不能宣称端到端加密。云凭据与模型配置不同，WebDAV 使用 safeStorage；加密后端不可用时有 session-only 语义。恢复数据成功但绑定保存失败时，已恢复的副本仍保留，不能因绑定失败擅自删除它。

依据：`electron/services/project-archive-service.ts`、`electron/services/project-restore-service.ts`、`electron/services/portable-runtime-freeze.ts`、`electron/controllers/cloud-backup-controller.ts:370`、`electron/services/cloud-credential-store.ts:184`、现行 B01/B02 与 ADR-0020。

## 8. 前端与交互维护

### 8.1 当前界面

ADR-0021 和当前 App 采用唯一纸墨外壳，不再使用旧 IDE 四区或 magazine/writer 双壳。流程脊四阶段为 `setup/architecture/blueprint/manuscript`；书房、资源页、标签、运行/审稿侧页由 navigation intents 和 stage/layout/editor stores 协调，不使用通用 URL router。

进度与章节阶段从项目事实、蓝图、草稿、审修记录和在途工作派生。新增展示不要再维护一套可漂移的阶段完成标志。打开作品的落点和正文优先章有专门纯逻辑，变更须一起查导航测试。

依据：`src/stores/navigation/navigation-intents.ts:5`、`src/stores/navigation/stage-navigation.ts:22`、`src/stores/navigation/stage-progress.ts:111`、`:143`、`:177`。

### 8.2 样式、组件和语言

- 样式从 `src/main.tsx` 按 paper-ink、index、stage 顺序引入；原语不自带全局样式副作用，便于 Node 侧工具复用模块。
- 使用 paper-ink tokens、共享 UI 原语及 lucide-react，不根据本地化文案、nth-child 或工具类拼接第二套视觉规则。
- 外观偏好由 appearance-bootstrap 单一持久 writer 管理，theme-store 是兼容投影，不要直接写旧 localStorage 键。
- 共享文案使用 keyed `t`，单组件中英文使用 `text`；界面 locale 不覆盖作品写作语言。
- 设置页离开、标签关闭、项目切换、关窗和错误边界都有保护，不能为导航简化而跳过未保存确认或卸载编辑器。

依据：`src/main.tsx:6`、`src/styles/paper-ink/index.css:1`、`src/components/stage/stage.css:1`、`src/stores/appearance-bootstrap.ts:45`、`src/stores/theme-store.ts`、`src/i18n/core.ts:31`、`src/components/settings/unsaved-settings.ts:12`、`src/components/stage/StageRoot.tsx:31`。

### 8.3 设计与验证来源

当前设计材料在 `docs/design/2026-10-11-frontend-redesign/`，包括 IA、design-system、feature-matrix、prototype 和 claude-design 源。它们用于定位已确认输出，不为缺失状态/视口自动提供授权。历史计划的旧构建命令、检查框和模型策略不等于现在仍适用。

可见修改应先记录具体差异与证据；实机验证优先查现有 `.claude/skills/verify/SKILL.md` 和 `scripts/redesign/` 场景。驱动会启动 Electron、创建隔离目录并写截图/回执；“假模型默认”也不使其成为只读命令。真实模型参数须单独核定授权，不以默认截图尺寸代表全部视口已覆盖。

## 9. 安全与隐私边界

| 边界 | 当前静态证据 | 不能外推的结论 |
| --- | --- | --- |
| renderer 隔离 | contextIsolation、无 nodeIntegration、受控导航 | 不等于全部 IPC/渲染输入安全 |
| 项目文件 | ProjectAccess、canonical root、grant、目标平台 helper、提交前复核 | renderer 路径相等不授权；不代表所有 handler 均已审计 |
| 模型密钥 | `ModelProfile.apiKey` 随模型数组写入 `models.json` 的 JSON 路径 | 没有证据表明该路径使用 safeStorage；不能宣传模型密钥已加密 |
| WebDAV 密钥 | safeStorage 与不可持久保存时的会话降级 | 不代表备份正文 E2E 加密或模型密钥同样处理 |
| 外部请求 | provider、模型发现、GitHub 更新、Skill 导入、WebDAV 等 | 本地优先不等于无外联/无配额消耗 |
| MCP 集成 | stdio server 进程启动、工具发现与外部 call-tool | 注册 handler 不等于已连接；连接和调用都不能默认按只读处理 |
| 发布签名 | profile 允许未签名并要求披露；macOS ad-hoc 配置 | 不能宣称正式签名、公证或 Gatekeeper 实测通过 |

模型保存路径：`src/shared/ipc-channels.ts:829` -> `electron/controllers/llm-controller.ts:65`、`:329` -> `electron/utils/config-utils.ts:53`。本轮只读取仓库源码，没有读取真实 `models.json`、cookie、小说或 OS 凭据。

实际开发中不得把密钥写到参数、fixtures、日志、快照或公开报告。用户选择的本地/内网模型地址本身不是漏洞；如需调整 SSRF、协议、代理或 remote URL 策略，必须先核对现有产品契约，不能以泛化安全建议破坏已支持场景。

Windows 的 GPU 子进程存在专门 sandbox 开关（`electron/main.ts:46`），属于需保留上下文的配置，不据此推断整个应用关闭了隔离。全仓漏洞、供应链和隐私数据流审计不在本轮完成范围内。

### 9.1 MCP 的可执行边界与可达性

`electron/main.ts:262` 注册 MCP handlers；注册本身不启动 server。`electron/mcp/mcp-manager.ts:257` 会以配置的 command/args/env 启动 stdio 子进程，`:413` 将工具调用转交外部 server。实现目前只支持 stdio；其他 transport 分支抛出 `MCP_SSE_UNSUPPORTED`，外层连接错误又归一为 `MCP_CONNECT_FAILED`，不能据配置类型宣称 SSE 可用。

`src/stores/mcp-store.ts:155` 把发现的工具注册成 `mcp__<server>__<tool>`，标记 `requiresConfirmation: true`、`isReadOnly: false`。后续维护须审查工具来源、参数/环境中的秘密、进程生命周期和真正外部副作用，不以工具名称或模型建议授予权限。

本轮静态检索未找到当前生产 UI 调用 MCP store `init/connectServer` 的入口；已发现的 AgentHeader 主要展示状态。因此只能确认 manager、IPC 和工具注册代码存在，不能声称普通作者已能从当前纸墨界面完成连接和工具调用，也未运行其外部进程。

## 10. 开发、检查和构建入口

以下命令均是**后续操作索引，本轮未执行，也不构成执行授权**。实际执行先核定工作目录、脚本内容、写入范围、网络和用户数据影响。当前没有依赖环境，不能把这些命令的存在当作可立即成功运行。

### 10.1 日常开发

| 命令 | 工作目录/作用 | 主要副作用或前提 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 根目录，按锁文件安装 | 网络、node_modules/缓存、lifecycle；postinstall 安装 Electron |
| `pnpm dev` | 根目录，Vite/Electron 开发 | 本地服务、桌面进程、可能接触真实配置；不能当普通只读浏览 |
| `pnpm run typecheck` | `tsc --noEmit` | 静态类型；不覆盖所有脚本/插件；缓存行为另核对 |
| `pnpm run lint` | ESLint ts/tsx/mjs + 颜色检查 | 不带自动修复，但范围含脚本；不能代替运行 |
| `pnpm run check:i18n` | 语言覆盖脚本 | 文案检查，不证明所有交互 locale 正确 |
| `pnpm test` | 默认 Node-focused Vitest | 临时文件/数据库/缓存；排除插件与部分历史脚本入口 |
| `pnpm run test:browser` | 专门 browser config | 需要 Chromium，启动浏览器并可能保存失败截图 |
| `pnpm run build` | `tsc && vite build` | 生成 dist/dist-electron 等；不是安装包 |
| `pnpm run storybook` | 组件开发，端口 6006 | 服务/缓存，不是完整 Electron 运行环境 |
| `pnpm run build-storybook` | 静态组件文档构建 | 写输出，不覆盖主进程/native |
| `pnpm run preview` | 构建产物网页预览 | 没有 preload 就没有完整桌面业务能力 |

`ipc-client.ts` 在缺少 `window.aiNovelAPI` 时抛错，所以不可将浏览器预览地址交付为完整可用桌面应用。新增 setup 配方应与当前 package/lock/CI 对齐，不执行历史文档里不存在的脚本。

### 10.2 打包与高副作用命令

| 入口 | 实际含义与风险 |
| --- | --- |
| `pnpm run clean:build` | 清理构建输出，执行前必须审目标集合 |
| `pnpm run build:win` / `release:win:verify` | 完整 Windows release 验证入口，不是单纯 compile |
| `pnpm run build:win:artifacts` | 需 release gate，构建和打包，显式 publish never |
| `pnpm run build:win-dir` | 先 clean/typecheck，再构建目录包和包校验 |
| `pnpm run build:mac:arm64:artifacts` / `build:mac:x64:artifacts` | 清理、类型检查、clang 编译安全 helper、构建与目标打包 |
| `smoke:win-*` / `smoke:mac-dmg` | 可能启动、安装、升级、卸载或挂载；须按脚本单独检查 |
| `verify:*` | 名称不保证只读；可能查询网络、写证据、解包或调用外部工具 |
| `.release` promotion `verify/publish/cleanup` | verify 下载并验证 artifacts 后递归重建指定 output；publish 创建/发布 Release；cleanup 删除云端 artifacts |

依据：`package.json:13`、`vite.config.ts:45`、`src/services/ipc-client.ts:17`、`.release/scripts/github-desktop-promotion.mjs:606`、`:715`、`.release/scripts/release-artifact-retention.mjs:105`。

## 11. 测试体系与 CI

### 11.1 分层覆盖

| 层级 | 代表文件/入口 | 能证明什么 |
| --- | --- | --- |
| 纯契约/状态单测 | `src/shared/__tests__/`、navigation tests、generation harness/runtime tests | 本地不变量、边界分支与状态派生 |
| repository/迁移/服务 | `electron/repositories/__tests__/`、`electron/services/__tests__/` | SQLite 事务、源校验、恢复和数据契约 |
| IPC/文件授权 | `fs-controller-project-boundary.test.ts`、preload/main contract tests | 指定 handler 的参数/租约/路径合同 |
| 浏览器组件 | 86 个 `*.browser.tsx`、`vitest.browser.config.ts` | 指定场景的真实 DOM/交互，不等于 OS/native |
| Electron 驱动 | `scripts/redesign/`、startup/acceptance scripts | 授权执行后可检查真实窗口、隔离、性能与流程 |
| 真实模型资格 | quality modernization 和 real-provider scripts | 须真实运行及审阅输出，fixture 不替代文学质量 |
| 安装包/平台 | Windows gate、macOS DMG smoke、update E2E | 精确包、目标平台和安装/升级生命周期 |
| 插件 | 插件自己的 tests/qualification | 独立宿主、preset、proposal 和持久化 |

本轮查看了测试定义与配置，没有任何通过率或覆盖率数据。`test:browser` 是独立入口，不能假设 `pnpm test` 自动完成浏览器与插件资格。

### 11.2 关键回归索引

- 会话/文件：`electron/controllers/__tests__/fs-controller-project-boundary.test.ts`、`src/stores/__tests__/workflow-store-resource-conflict.test.ts`。
- 生成：`src/services/generation/__tests__/generation-harness.test.ts`、`generation-runtime.test.ts`、`generation-runtime-owner.test.ts`。
- 定稿/回收站：`electron/repositories/__tests__/finalization-repository.test.ts`、`chapter-deletion-repository.test.ts`，以及 commands 的 continuity/replacement tests。
- 数据迁移/恢复：`electron/services/__tests__/project-format-migration.test.ts`、`global-data-migration.test.ts`、`project-restore-service.test.ts`。
- 密钥：`electron/services/__tests__/cloud-credential-store.test.ts` 的不可持久加密降级路径。
- 导航/外壳：`src/stores/navigation/__tests__/`、`src/components/stage/__tests__/`、`src/components/startup/__tests__/RendererStartup.browser.tsx`。
- 发布：`scripts/__tests__/release-win-verify.test.ts`、`cross-platform-runtime-artifact-promotion-workflow.test.ts` 及其他 release profile/evidence 契约测试。

这些是后续选择测试的入口，不是要求每次都全量运行，也不是本轮已运行清单。

### 11.3 CI 矩阵

| Workflow | 配置用途 | 边界 |
| --- | --- | --- |
| `pr-ci.yml` | master PR；默认 Windows 四分片；首分片 typecheck/lint/i18n/browser/build | 纯文档分类可跳 Windows shards；不发布 |
| `windows-cloud-build-test.yml` | 手动 Windows x64 包资格 | 精确 SHA/版本、安装与运行等收据 |
| `macos-arm64-cloud-build.yml` | 手动 Apple Silicon 包资格 | macos-14、DMG/原生/签名策略证据 |
| `macos-x64-cloud-build.yml` | 手动 Intel 包资格 | macos-15-intel，独立目标资格 |
| `windows-in-app-update-e2e.yml` | 真实安装 UI 更新链 | 安装/网络副作用，不能用单测替代 |
| `cross-platform-runtime-artifact-promotion.yml` | 三目标合流、发布与资产清理 | 有远端写权限和确认门禁 |
| `dsh-plugin-ci.yml` | 插件路径触发，独立 cwd/lockfile/构建测试/打包 | 不表示完整 DSH 在线模型资格 |

PR CI 的 docs-only 分类对 README、release、workflow、docs 内 JSON/MJS 有特殊规则，不是所有文档目录变更都会跳过检查。依据：`scripts/pr-docs-only.mjs:5`、`.github/workflows/pr-ci.yml:24`、`:99`、`:159`。

## 12. 发布、更新与兼容维护

`.release/release-profile.json` 是资产与平台合同来源。当前配置为三个目标、Windows 安装器/更新元数据及两个 macOS DMG 与 checksum，共七类命名资产；资格 artifact 默认保留 14 天，精确资产绑定 workflow run/attempt/artifact ID，不是任意同名文件。

promotion 流程先核对来源/SHA/资产与回执，生成 provenance/plan，再发布并回读核对；cleanup 另有远端删除语义。`verify` 会在下载验证各目标后递归重建传入 output，不能仅凭子命令名字当作只读。任何实际发布、tag、上传和清理都不包含在本次文档授权里。

更新语义：打包态 Windows 使用下载更新；macOS 提示后打开 release 供手动安装；开发态不启用同等更新。安装包显示名为书童，应用内部 identity 继续沿用 `ai-novel-writer` 和 `com.ai-novel-writer.app`。更名需同时核查旧进程识别、NSIS 快捷方式、更新 cache、卸载和 smoke 脚本，不能只改 UI 常量。

签名当前允许未签名但必须披露；macOS `identity: '-'`、`hardenedRuntime: false`，不能把构建配置当成公证或实际用户安装成功证据。

依据：`.release/release-profile.json:4`、`:56`、`electron-builder.json5:4`、`:17`、`:27`、`electron/services/update-runtime.ts:4`、ADR-0016、ADR-0022。

## 13. 独立 DSH 插件

插件 package 为 `@ethanyoq/dsh-ai-novel-writer`、版本 `0.1.0`，README 声明冻结维护。源码保留 V1 和 V2，不能因为有 V2 就推断已正式发布 V2 或冻结声明失效。

| 事项 | 插件边界 |
| --- | --- |
| 包与工具链 | 独立 `package.json`/`pnpm-lock.yaml`，Node 范围 `^22.19 || >=24`；不要直接套桌面最低版本 |
| 数据 | 每 workspace 的 NovelStore，不读桌面作品 DB |
| V2 变更 | 模型提交非权威 proposal，作者在工作台确认应用；可部分失败，须读回状态 |
| 宿主边界 | preset/profile、实际 tool roster、客户端挂载/连接和 workspace 绑定 |
| 资格 | 先读插件 `AGENTS.md` 与 `plugins/dsh-ai-novel-writer/docs/v2-development-gates.md`；keyless 浏览器、重启持久读回不能用脚本静态测试冒充 |
| 许可 | 插件原始代码 MIT，桌面 GPL-3.0；插件 README 明确不打包桌面 GPL 源 |

插件 `pnpm test` 会先 build，其 build 还包含链接和构建校验；同名命令在两目录副作用不同。本轮仅读取插件规则、README、package 和局部领域源码，没有安装/启动 Harness、查看真实 roster 或在线模型验证。

依据：`plugins/dsh-ai-novel-writer/AGENTS.md:3`、`plugins/dsh-ai-novel-writer/package.json:68`、插件 README、`docs/adr/0010-dsh-plugin-per-workspace-novel-store.md`。

## 14. 已确认差异、风险与优先级

优先级表示维护建议顺序，不是本轮授权的修复计划。P1 表示容易误导数据处理或核心契约，P2 表示维护/覆盖风险，P3 表示避免误用。没有足够证据的事项不写成已复现 bug。

| 编号 | 级别/状态 | 证据与影响 | 后续处理建议 |
| --- | --- | --- | --- |
| R1 | P1，已确认文档不一致 | `README.md:194` 指模型配置在 profile；locator `:20` 普通启动改用 `-data`，ADR0022 `:31` 也有说明。备份/排障可能找错目录 | 专项同步中英文数据说明；同时说明参数/环境覆盖，不搬迁实际数据 |
| R2 | P1，已确认规则漂移 | `docs/agents/delivery.md:11` 仍指固定 donor 杂志壳，与 ADR0021 和当前 StageShell 冲突 | 在规则/导航整理任务中明确取代关系；本次 AGENTS 已提示，不改历史字节 |
| R3 | P2，已确认导航漂移 | `docs/README.md:3` 为1.2.0-Preview；`:7` 称 README_zh 同内容副本，但现在只是兼容链接；package 为1.4.0 | 更新导航事实描述，避免从旧状态推断现有交付 |
| R4 | P2，已确认凭据保护限制 | 模型 apiKey 随 models.json JSON 写入，非 WebDAV safeStorage 路径 | 明确用户/备份保护边界；加密改造涉及迁移、恢复、跨机和降级，需单独授权与设计 |
| R5 | P2，推断维护复杂度 | main-generation-owner、architecture command、generate-draft command、import-run repository 等体积较大且跨合同 | 按变更链聚焦测试与 ownership，不据文件大直接全盘重构 |
| R6 | P2，证据不足 | preload 字符串桥与多个 handler 并存，本轮仅抽查项目/文件/生成等入口 | 有安全审计目标时逐通道核对，不声称全仓安全或已可利用 |
| R7 | P2，已确认证据分层需求 | CI、fixture、浏览器、真实模型、native 包和发布资格各自独立 | 后续每项记录 tested SHA/环境/产物，不复用历史 PASS 为当前结论 |
| R8 | P3，已确认残余平台配置 | builder 含 Linux，release profile 与安全实现只覆盖三目标 | 不宣传 Linux 支持；未来拓平台须独立设计/验收 |
| R9 | P3，已确认本地规则分发边界 | `.gitignore:54` 忽略根 AGENTS；docs 导航规定其为本机可选上下文 | 不改 ignore/强制暂存；团队若要共享规则，另决定发布入口和脱敏范围 |

本轮没有确认新的核心业务运行 bug，不代表不存在。R1-R4 是源码/文档层可确认差异或限制；R5-R7 不替代故障复现。没有做依赖漏洞扫描、性能基准或真实配置取证。

## 15. 后续开发与维护操作地图

### 15.1 按变更选入口

| 目标 | 先读/通常联动 | 最低应规划的证据 |
| --- | --- | --- |
| 新增/修改页面交互 | ADR0021、设计节点、stage 页面、navigation intents、相关 store | 差异来源、聚焦 browser/导航测试；必要时同状态实机截图 |
| 修改模型参数/协议 | provider presets、model routing、parameter policy、main owner/lease、LLM factory | 参数合同、真实请求边界与失败分类；未获真实调用授权时留待验 |
| 调整提示词/Skill | prompt catalog/templates、writing-skill bindings、来源 contract | 写作语言/事实不覆盖、结构输出、冻结及生产入口；文学效果单独评价 |
| 改工作流/暂停恢复 | commands、workflow-store、resource claims、generation runtime | 会话失效、取消/unknown、部分产物恢复和启动/提交收据 |
| 改小说导入 | import controller/run/workflow、inspection 与效果收据 | reference/author 分流、来源稳定、原稿提交与恢复幂等 |
| 改 MCP 接入 | mcp manager/IPC bridge、mcp store、实际 UI 调用端 | stdio 进程/环境、确认、真实可达性与外部状态副作用 |
| 改角色/定稿/删除 | shared contract、controller/service/repository、ADR0017/0024/0025 | 事务、来源/唯一writer、投影重试、替换/回收站/恢复回归 |
| 改持久格式 | locator、manifest、registry、migration runner、portable transfer | 备份、旧源保全、失败中断、逐步迁移、恢复读回及跨目标 |
| 改知识库/native | LanceDB唯一入口、vector store、embedding、package/lock/builder | 维度/空间、老库读回、关闭生命周期和实际包目标架构 |
| 改更新/发布 | release profile、builder、update runtime、云资格/promotion | 精确 SHA/asset/hash、安装升级/签名披露；外部写入单独授权 |
| 改 DSH 插件 | 插件 AGENTS、V2 gates、NovelStore/preset/workbench | 插件独立测试、真实 roster、proposal 应用和重启读回 |

### 15.2 推荐维护顺序

1. **先消除接手误导**：在另行授权的文档任务中处理 R1-R3，明确最新适用 ADR、两类数据根和 README 入口；不藉此改动产品行为或用户数据。
2. **建立可重复开发基线**：取得具体安装/检查命令授权后，按锁文件和 CI 工具链准备依赖；先运行与目标相关检查，再决定是否扩大到完整套件。
3. **按风险推进功能**：UI 先找设计证据；核心领域先核对来源、租约、writer 和下游投影；存储/发布先确认授权、备份与回退。
4. **分开交付层次**：代码实现、单测、浏览器、真实模型、安装包、提交与发布分别登记；缺少哪一层就保留未验证项，不通过修改规则消除缺口。

这不是新的全局重构路线图，也不取代现有规格、任务检查点或用户优先级。建议只有在对应任务被确认后才实施。

### 15.3 文档接手顺序

| 顺序 | 入口 | 使用方式 |
| --- | --- | --- |
| 1 | `README.md`、`README_en.md`、`CONTRIBUTING.md` | 产品边界、用户工作流与贡献要求；版本/路径描述须核对当前代码 |
| 2 | `docs/product-domain.md`、相关 ADR | 稳定词汇、事实源和最新取代关系 |
| 3 | `docs/README.md`、`docs/agents/domain.md` | 资料导航与文档生命周期；已知漂移见 R2/R3 |
| 4 | `docs/research/novel-quality-modernization/current-spec-index.md` | 将具体任务映射到适用规格与修订，不把索引等同于全部实现完成 |
| 5 | 对应 controller/service/repository、调用端与测试 | 用当前生产入口核对需求、来源与下游影响 |
| 6 | dated research/handoff/qualification receipts | 仅作其绑定日期、SHA、平台和产物的历史证据 |

根 AGENTS 是本机可选摘要，不是产品领域或 ADR 的上位规则；本报告同样不能给旧任务检查框自动改状态。公开交接不得依赖不可获得的本机路径、私有检查点或秘密。

## 16. 本轮验证与交付记录

### 16.1 已完成的静态工作

- 确认根目录、父级/子级 AGENTS 位置、Git 基线、唯一 worktree、初始干净状态和依赖目录缺失。
- 清点跟踪文件、测试文件名和模块分布；阅读核心配置、文档导航、当前关键 ADR、前端启动/导航与跨进程链。
- 两名指定模型只读分析领域与平台，主线程核对关键差异和数据目录/凭据/发布副作用。
- 创建本报告与根 AGENTS；交付前只读核对文件、引用路径、工作区和空白格式，不运行仓库脚本。

文档交付复核结果：两名成员分别审阅并复验了领域、平台和授权相关表述，指出的概括范围及发布步骤顺序问题已修正。只读路径/行号范围检查未发现失效引用（排除文中明确声明不存在的两个目录）；文本检查未发现尾随空白、冲突标记、Unicode 替换字符、本机私人路径或常见密钥格式。此检查不是完整秘密扫描。`git diff --check` 无输出，但新文件不在 tracked diff 内，故新文档另做了直接文本检查。

最终状态为报告 untracked、根 AGENTS ignored，tracked 文件无改动。没有暂存或提交，也未调整 ignore 策略。

### 16.2 未执行与不能宣称的结果

- 未安装依赖，未运行 typecheck、lint、i18n、单测、浏览器测试、构建、服务或 Electron。
- 未访问实际小说、用户配置、OS 凭据、WebDAV、provider API、GitHub Release/Actions 或其他远端当前状态。
- 未验证真实文学质量、实际数据库损坏恢复、目标平台安全 helper、native ABI、已安装程序升级或安装包签名/公证。
- 未执行 Git add/commit/push、分支/tag/stash/worktree 修改、发布、清理或历史文档修订。
- 未完成所有 34 项规格、全部 192 项历史功能矩阵或每个 handler/动态调用的逐项认证；本报告提供覆盖地图和关键边界，而非这些认证的替代品。

根 `AGENTS.md` 是这次静态分析的长期约定摘要，被现有 ignore 规则保留为本机文件。规则变更通常需要新会话重新加载；未来任务仍应检查实际加载来源和当前源码，不以本报告快照覆盖后来的事实。

# ADR-0065: 生产无窗口宿主与桌面互斥接管 (Production Headless Host and Exclusive Fencing)

## 状态
Accepted

## 背景与问题 (Context & Problem)
方案 4.3、7.1 与 9 明确规划了第二档生产架构——无窗口宿主（Headless Runtime Host）：
1. **完全解耦 UI 与前端框架 (E11)**：
   传统的任务执行依赖 Electron BrowserWindow、Zustand Store 和 React 生命周期；当桌面关闭或退出时，长篇创作任务被迫中断。生产 Headless 宿主必须完全剥离 window、Zustand 和导航依赖，独立启动并驱动真实的领域工作流与收据对账。
2. **桌面与 Headless 竞争同书的双写风险 (E02, E26, I01)**：
   当同一作品目录被桌面端（Desktop）与无窗口端（Headless）并发访问，或前任宿主崩溃/悬挂后新宿主接管时，仅凭内存 Map 或 SQLite WAL 无法杜绝双主脑并发写冲突。
3. **生命周期完整性与凭据安全**：
   宿主必须具备标准的健康检查（Health Check）、优雅排空（Drain & Stop）、崩溃恢复对账（Reconciliation）以及凭据留存在宿主不外泄的完备生命周期。

## 决策 (Decisions)

### 1. 独立生产无窗口宿主 (`HeadlessRuntimeHost`)
- 提供启动、健康探针（`getHealth()`）、任务排空与停止（`drainAndStop()`）全套生命周期；
- 直接编排 `ProjectRuntime`、`WorkflowDriverEngine` 与 `InboundApiService`，完全脱离 Electron 前端渲染进程；
- 维护健康指标：宿主 ID、运行时间、活跃作品数、排队/在途任务数及内存占用。

### 2. OS 级项目文件排他锁与持久 Fencing (`ProjectExclusiveLockManager`)
- 每部小说在 `.ai-novel/owner.lock` 维护单一写所有者事实源；
- 锁记录包含：`hostType`（'desktop' | 'headless'）、`hostId`、`pid`、`canonicalRoot`、`executionEpoch` 和 `acquiredAt`；
- **互斥检查**：同一时刻同部作品仅允许一个活动的桌面或 Headless 宿主持有写所有权；若竞争发生，后者被明确拒绝并返回 `PROJECT_EXCLUSIVE_LOCK_HELD`；
- **安全接管与持久 Fencing (Epoch Fencing)**：
  - 授权接管时，签发严格递增的全新 `executionEpoch` 并重写锁记录；
  - 旧宿主即使进程残留或有迟到网络回包，在领域事务提交边界因 `executionEpoch` 不匹配被严格隔离与拒绝（Fenced Out），彻底杜绝脑裂与双写。

### 3. 宿主安全凭据与故障恢复
- 模型凭据与 API Key 由宿主本地安全加载，不随外部命令、事件或 MCP 日志输出；
- 宿主重启后严格基于持久化收据进行恢复，未知终态（unknown）绝不静默换 nonce 重抽，保证至少一次驱动与幂等提交。

## 结果与收益 (Consequences)
- 实现了无窗口独立后台创作能力，作者退出桌面应用后后台作业可按授权安全收敛；
- 通过 OS 独占锁与 Fencing Epoch 彻底消除双宿主脑裂写入风险；
- 满足 HEADLESS-001 验收标准。

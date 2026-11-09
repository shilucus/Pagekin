# Stage 33 验收证据：生产无窗口宿主与桌面互斥接管 (HEADLESS-001)

## 1. 特性概述
- **特性 ID**：`HEADLESS-001`
- **特性名称**：生产无窗口宿主与桌面互斥接管 (Production Headless Host and Exclusive Desktop Fencing)
- **方案依据**：`docs/plans/2026-11-07-creation-runtime-modernization/README.md` (Sections 4.3, 7.1, 9), `evidence-map.md` (E02, E11, E26, I01)
- **架构决策**：`docs/adr/0065-production-headless-host-and-exclusive-fencing.md`
- **依赖状态**：RUNTIME-003, DRIVER-001, SCHED-002, API-001, CLI-001, QUAL-002 全部就绪并通过审查。

## 2. 核心实施与改进
1. **独立生产无窗口宿主 (`HeadlessRuntimeHost`)**：
   - 完全剥离了 Electron 渲染进程的 window、Zustand 和导航依赖，独立驱动生产任务并执行真实收据对账；
   - 具备完备生命周期方法：`start()`、`getHealth()`（监控运行状态、活跃项目数、在途任务及 RSS/Heap 内存占用）与 `drainAndStop()`（优雅排空并在退出时安全释放锁）。
2. **OS 级项目排他锁与持久 Fencing (`ProjectExclusiveLockManager`)**：
   - 每部作品在 `.ai-novel/owner.lock` 维护单一写所有者事实源，记录 `hostType`（'desktop' | 'headless'）、`hostId`、`pid`、`canonicalRoot`、`executionEpoch` 和 `acquiredAt`；
   - **排他互斥**：同一作品被桌面宿主持有时，无窗口宿主直接注册被严格拒绝并抛出 `PROJECT_EXCLUSIVE_LOCK_HELD`，杜绝多主脑并发写入；
   - **持久 Fencing (Epoch Fencing)**：
     - 当发生接管（Takeover）时，签发严格递增的新 `executionEpoch` 并重写锁记录；
     - 旧桌面宿主若产生迟到回包或尝试提交事务，在提交边界通过 `assertLockValid` 校验时被严格判定为 `PROJECT_WRITE_FENCED_OUT`，彻底防止脑裂双写；
     - 旧宿主无权释放被接管的新锁，确保接管状态的单向权威性。
3. **凭据安全与零泄露**：
   - 宿主凭据保存在本地，不通过外部命令行参数或日志暴露；重启基于持久化收据进行幂等恢复。

## 3. 验证与门禁结果
1. **针对性单元测试 (`electron/services/__tests__/headless-runtime-host.test.ts`)**：
   - 3/3 tests 全部通过：
     - 独立宿主生命周期管理与健康检查探针；
     - 桌面与 Headless 竞争同书时的排他性互斥拦截；
     - 授权接管后的持久 Fencing 拦截与旧所有者锁释放保护。
2. **质量门禁**：
   - `tsc --noEmit`：通过（Exit code: 0）
   - `eslint`：通过（Exit code: 0）
   - `check-color-literals`：通过（Exit code: 0）
   - `check-i18n-coverage`：通过（Exit code: 0）

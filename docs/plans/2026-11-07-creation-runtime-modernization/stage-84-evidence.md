# Stage 84 验收与实测凭证: 生产无窗口宿主与桌面互斥接管

**执行日期**: 2026-11-14  
**对应特性**: `HEADLESS-001`  
**关联方案**: `docs/plans/2026-11-07-creation-runtime-modernization/README.md` (F2)  
**前置依赖 SHA**: `3e85306108529ef8a42beda3d2399ee2534e273d` (Stage 83)  

---

## 一、验收目标与范围

1. **`HEADLESS-001`（生产无窗口宿主与桌面互斥接管）**:
   - 验证无窗口宿主生命周期（启动/健康检查/优雅停止/任务排空与收据持久化）。
   - 彻底脱离前端 DOM、Window 与 Zustand 交互依赖，纯主进程环境自主驱动多阶段创作任务。
   - 实现跨进程单实例互斥锁与租约 Fencing：Desktop 与 Headless 竞争同书时，基于 OS 独占锁与租约时代戳强制排他，杜绝双写、双 Host 并发及迟到结果污染。
   - 保留生产凭据与主进程存储安全预检，严格遵循未知结果（unknown）不自动重发与收据不可变原则。

---

## 二、测试执行与凭据

共执行 4 套无窗口宿主、单实例互斥与主进程所有者核心测试套件，356 项用例 100% 全部通过 (356/356)：

1. **`electron/services/__tests__/headless-runtime-host.test.ts` (3 tests passed, 36ms)**:
   - 宿主无窗口运行启动合同、脱离 UI 交互循环的环境探测、排空与停止事件序列。
2. **`electron/services/__tests__/single-instance-runtime.test.ts` (3 tests passed, 6ms)**:
   - 跨进程文件互斥锁、竞争接管冲突检测、租约失效判定与释放。
3. **`electron/services/__tests__/main-generation-owner.scheduling.test.ts` (58 tests passed, 56736ms)**:
   - 多书会话公平调度与资源准入、中途取消与停止状态下的资源排空、跨项目租约隔离与防抖。
4. **`electron/services/__tests__/main-generation-owner.test.ts` (292 tests passed, 159603ms)**:
   - 涵盖 10 章/50 章/200 章海量级生成持久化事务、网络异常/超时/连接重置分类归因、作者收据不可篡改性与断点恢复全流程。

---

## 三、静态质量门禁

1. **TypeScript 类型检查 (`node ./node_modules/typescript/bin/tsc --noEmit`)**:
   - 结果：通过（0 错误退出）。
2. **多语言与文案检查 (`corepack pnpm run check:i18n`)**:
   - 结果：通过（"i18n coverage check passed: no unlocalized renderer or main-boundary copy"）。
3. **代码风格与字面量检查 (`corepack pnpm run lint`)**:
   - 结果：通过（ESLint 0 warnings 0 errors, check-color-literals 通过）。
4. **完整构建验证 (`corepack pnpm run build`)**:
   - 结果：通过（Vite client bundle 与 Vite/Rolldown electron main/preload bundle 全部顺利编译构建）。

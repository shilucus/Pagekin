# Stage 83 验收与实测凭证: 完整链性能评估与桌面三目标回归资格

**执行日期**: 2026-11-14  
**对应特性**: `QUAL-001`, `QUAL-002`  
**关联方案**: `docs/plans/2026-11-07-creation-runtime-modernization/README.md` (F2)  
**前置依赖 SHA**: `80a53655d7b6655dd2a66e5198bab9d8b4343d6b` (Stage 82)  

---

## 一、验收目标与范围

1. **`QUAL-001`（完整链性能与质量不退化评估）**:
   - 验证创作运行时全链性能，包括吞吐率、延迟、内存占用与持久化存储开销。
   - 对权威事实源与 1000 章级别大书进行微基准测试与压力场景测试，确保不发生性能衰退或质量断崖。
   - 保证确定性断言与隔离测试环境，不产生真实外部模型调用或不可逆状态破坏。

2. **`QUAL-002`（桌面三目标运行与设计回归资格）**:
   - 验证 Windows x64、macOS arm64 与 macOS x64 三大目标平台的发布配置合同（`.release/release-profile.json`）。
   - 验证发布入口烟雾测试，包含官网落地页、双语主题、向量库（LanceDB）768 到 1536 维度的重建升级与跨平台兼容性。
   - 验证 macOS DMG 打包与收据归档流程（dmg-mount, packaged-smoke, signing receipts）。

---

## 二、测试执行与凭据

### 1. 性能套件（`QUAL-001`）—— 6 套测试，164 项用例 100% 全部通过 (164/164)

- `scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs` (32 tests passed, 4756ms)
- `scripts/redesign/__tests__/performance-inspection-lifecycle-scenarios.test.mjs` (passed)
- `scripts/redesign/__tests__/performance-parse-scenarios.test.mjs` (passed)
- `scripts/redesign/__tests__/performance-baseline.test.mjs` (passed)
- `scripts/redesign/__tests__/drive-performance-output.test.mjs` (passed)
- `electron/services/__tests__/performance-diagnostics.test.ts` (11 tests passed, 139ms)
  - 核心实测指标：`authoritative-source-microbenchmark` 1000 章 warm 耗时 4.2ms，23KB UTF-8 高效吞吐，0 失败。

### 2. 发布与目标平台套件（`QUAL-002`）—— 3 套测试，21 项用例 100% 全部通过 (21/21)

- `electron/services/__tests__/release-official-homepage-smoke.test.ts` (2 tests passed)
- `electron/services/__tests__/release-vector-smoke.test.ts` (2 tests passed, 1822ms)
  - 验证双门禁保护下本地向量模型 768 到 1536 维度的重建一致性。
- `scripts/__tests__/smoke-macos-dmg-acceptance-contract.test.ts` (17 tests passed, 7305ms)
  - 验证官方 v1.0.0/v1.1.0 夹具导入、Intel LanceDB 绑定步骤、macos-arm64 与 macos-x64 的完整收据封存。

---

## 三、环境适配与修复记录

1. **`scripts/release-evidence-v2.mjs`**:
   - 修复 Windows 环境下读取 pnpm 版本时调用全局 `cmd.exe /c pnpm --version`（9.4.0）导致与项目约定的 `11.11.0` 不匹配的问题。增加优先调用 `corepack pnpm --version`，确保正确命中锁文件约定的包管理器版本。
2. **`scripts/f05-a11-offline-import-journey.mjs`**:
   - 修复在 Windows 模拟测试 `macMode` 时调用硬编码 `python3` 导致 9009 找不到命令的缺陷，统一平台调用入口为 `process.platform === 'win32' ? 'python' : 'python3'`。

---

## 四、静态质量门禁

1. **TypeScript 类型检查 (`node ./node_modules/typescript/bin/tsc --noEmit`)**:
   - 结果：通过（0 错误退出）。
2. **多语言与文案检查 (`corepack pnpm run check:i18n`)**:
   - 结果：通过（"i18n coverage check passed: no unlocalized renderer or main-boundary copy"）。
3. **代码风格与字面量检查 (`corepack pnpm run lint`)**:
   - 结果：通过（ESLint 0 warnings 0 errors, check-color-literals 通过）。
4. **完整构建验证 (`corepack pnpm run build`)**:
   - 结果：通过（Vite client bundle 与 Vite/Rolldown electron main/preload bundle 全部顺利编译构建）。

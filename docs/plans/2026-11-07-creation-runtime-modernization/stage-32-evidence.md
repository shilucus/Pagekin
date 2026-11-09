# Stage 32 验收证据：桌面交互与三目标回归资格 (QUAL-002)

## 1. 特性概述
- **特性 ID**：`QUAL-002`
- **特性名称**：桌面交互与三目标回归资格 (Desktop Interaction and Three-Target Platform Qualification)
- **方案依据**：`docs/plans/2026-11-07-creation-runtime-modernization/README.md` (Sections 2, 6.3, 7.7, 7.8, 9, 10), `evidence-map.md` (E01, E17, E20, E24, E31)
- **依赖状态**：UI-001~003, CLI-001, MCP-001, SKILL-001, ACCEPT-002~003, QUAL-001 全部已完成并核实。

## 2. 核心实施与改进
1. **桌面纸墨 UI 交互与双语、未保存缓冲完整性**：
   - 验证核心阶段、按需侧页（运行与审稿）双语中英文资源（`zh-CN.ts` 与 `en-US.ts`）100% 覆盖；
   - 保持纸墨设计色彩令牌与全局样式无污染，不向 Node/IPC 工具层引入样式副作用；
   - 严格继承作品未保存设置、标签关闭与窗口关闭保护，外壳异常不丢弃作者输入。
2. **三目标架构发布资格契约 (`.release/release-profile.json`)**：
   - 严格限定三目标平台：`Windows x64`、`macOS arm64`、`macOS x64`；
   - 明确各平台验收凭据清单（`install.json`, `launch.json`, `quiet-window.json`, `native-abi.json`, `dmg-mount.json` 等）；
   - 平台与环境隔离执行探针，严格阻止 profile 与路径别名重叠。
3. **便携归档与跨 Profile 新副本保全 (B01 契约)**：
   - 遵循 `portable-project-field-policy.json`，新副本仅承接可读领域事实（作品名、设定、角色、大纲、正文与候选不可变快照）；
   - 机器权限、旧 task grant、旧执行 epoch、outbox 与未完成批准收据严格脱敏并排除执行权，绝不转移为新项目的写锁或后台执行权。

## 3. 验证与门禁结果
1. **针对性平台与桌面资格测试 (`electron/__tests__/desktop-and-three-target-qualification.test.ts`)**：
   - 3/3 tests 全部通过。
2. **平台配置文件与浏览器资格回归测试**：
   - `scripts/__tests__/qualification-profile.test.ts`（2/2 passed）
   - `scripts/__tests__/renderer-browser-qualification-contract.test.ts`（3/3 passed）
3. **质量门禁**：
   - `tsc --noEmit`：通过（Exit code: 0）
   - `eslint`：通过（Exit code: 0）
   - `check-color-literals`：通过（Exit code: 0）
   - `check-i18n-coverage`：通过（Exit code: 0）

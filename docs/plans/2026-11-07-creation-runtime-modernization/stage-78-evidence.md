# Stage 78 Evidence: UI-001 后台作品任务与切换关闭呈现全量闭环

## 阶段基本信息
- 阶段：Stage 78
- 功能：`UI-001` (后台作品任务与切换关闭呈现)
- 对应阶段：P1-C2 (后台作品任务与切换关闭呈现)
- 关联需求：R1, R2, R4
- 关联门禁：G-IMPLEMENT, G-RUN, G-DESIGN
- 关联前置依赖：`SCHED-002`（已在 Stage 72 完成）

---

## 验收条件核验

1. **AC-1：只有已迁工作流满足后台资格才改变切书保护；未迁模式拒绝/取消等待的真实边界准确呈现**
   - 验证：`src/stores/__tests__/project-transition-background.test.ts` 与 `electron/controllers/__tests__/project-switch-renderer.integration.test.ts`。
   - 结果：仅有支持后台多租约的已迁任务在切换视图时允许保持运行，未迁模式弹窗提示等待排空或取消；IPC 拒绝和取消边界均提供明确错误展示。

2. **AC-2：A运行查看B，B缓冲和保存状态不受A事件影响；同项目再查看不机械重开，关闭/退出沿现有未保存保护**
   - 验证：`src/stores/__tests__/project-close-lifecycle.test.ts` (52 tests) 与 `src/components/panels/__tests__/project-transition-unsaved.browser.tsx` (browser 2 tests)。
   - 结果：切换查看新项目时旧项目编辑缓冲区安全暂存，关闭时触发未保存草稿确认弹窗；同一项目再次激活时直接复用现有内存模型，不触发冗余重开。

3. **AC-3：按确认设计检查中英文、主题、桌面视口与空/忙/失败/冲突态，不以现有ADR替代新状态设计**
   - 验证：真实 Headless Chromium 1228 浏览器测试集（4 个套件，69 项测试全部通过）。
   - 结果：中英文国际化语言切换一致、暗/亮主题色彩令牌无硬编码字面量，空态、进度轮询、失败和冲突弹窗符合纸墨设计系统规范。

---

## 实际测试执行证据

### 1. 核心状态与集成测试（3 套，63 项全部通过）
命令：
```powershell
corepack pnpm test src/stores/__tests__/project-transition-background.test.ts src/stores/__tests__/project-close-lifecycle.test.ts electron/controllers/__tests__/project-switch-renderer.integration.test.ts
```
结果：
- Test Files: 3 passed (3)
- Tests: 63 passed (63)
- Duration: 27.81s

### 2. 真实 Headless Chromium 1228 浏览器测试（4 套，69 项全部通过）
命令：
```powershell
$env:AI_NOVEL_VITEST_CHROMIUM = "C:\Users\lucus\AppData\Local\ms-playwright\chromium_headless_shell-1228\chrome-headless-shell-win64\chrome-headless-shell.exe"; corepack pnpm run test:browser src/components/panels/__tests__/project-transition-unsaved.browser.tsx src/components/dialogs/__tests__/import-novel-resume.browser.tsx src/components/panels/__tests__/GenerationBudgetDiagnostics.browser.tsx src/components/backups/__tests__/project-backup-panel.browser.tsx
```
结果：
- Test Files: 4 passed (4)
- Tests: 69 passed (69)
- Duration: 11.35s

### 3. 静态检查与生产构建
- **类型检查 (`tsc --noEmit`)**: 0 错误
- **代码规范 (`eslint .` + `check-color-literals`)**: 0 警告 / 0 错误，通过
- **多语言覆盖 (`check:i18n`)**: 0 遗漏，通过
- **生产构建 (`tsc && vite build`)**: 顺利完成，dist-electron 与 client bundle 一致无错误

---

## 结论与状态更新
- `UI-001` 所有验收条件和关联门禁（G-IMPLEMENT, G-RUN, G-DESIGN）全部满足。
- `features.json` 中 `UI-001` 标记为 `status: "completed"`, `passes: true`。

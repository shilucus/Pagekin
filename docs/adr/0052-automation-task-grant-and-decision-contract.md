# ADR-0052: 自动化创作与局部修复循环授权门禁、机器决定合同与范围约束

## 状态
已接受 (Accepted)

## 上下文
在推进有界自主创作（`AUTO-001`）与连续局部修复循环时，系统需要允许在作者预先授权的目标下，由机器自动采纳获准规划、选择修订意见并执行有限次数的局部修复。
但如果不加以严谨的边界约束与契约防伪保护，将引发极大的产品与安全风险：
1. **失控循环与无限消耗**：若无严格的修复次数上限（`maxRepairAttempts`）与章范围边界，模型可能在反复微调中陷入无限自旋，耗尽 Token 预算；
2. **伪造人工确认 (Fabricated Human Confirmation)**：机器自动化逻辑如果直接伪造 `isHumanConfirmed: true` 或伪造人审收据写入底层核心，将架空作者把关契约，破坏“人机协同”的核心诚信；
3. **越权执行高危破坏操作**：自动化任务若获得最终定稿（`finalized`）、删除章节、安装脚本或读取修改 API Key 的权限，可能导致不可逆的数据破坏或环境污染；
4. **上下文漂移与静默换源**：若前序章节事实、大纲或角色发生变更，自动化任务若静默继续执行，将导致整部作品的连续性断裂。

## 决策

1. **显式任务授权凭据 (Automation Task Grant)**:
   - 机器自动执行必须凭有效的 `AutomationTaskGrant` 运行；
   - Grant 必须由作者预先显式配置明确范围：
     - `allowedChapterRange`: 允许修改的章节区间 `[minChapter, maxChapter]`；
     - `allowedFields`: 允许修改的结构化字段集合（如 `['character', 'outline', 'blueprint', 'chapter_draft']`）；
     - `allowedModels`: 明确允许使用的模型 ID 白名单；
     - `allowedSkills`: 明确允许执行的已安装 Skill 标识；
     - `maxRepairAttempts`: 局部修复尝试次数绝对上限（如 3 次），超限立刻转入待作者决策（`pending_decision`）；
     - `sourceFingerprint`: 绑定所依赖的核心事实指纹（SHA-256），来源变化时立刻暂停转待决策。

2. **不可伪造的机器决定合同 (Automation Decision Contract)**:
   - 机器生成的修订、采纳或修复决定必须记录为独立事实 `AutomationDecision`；
   - 标识 `source` 固定为 `'machine_automated'`；
   - 标识 `isHumanConfirmed` 强制为 `false`；主进程权威边界对输入进行严格静态检查，任何企图在机器决定中传入 `isHumanConfirmed: true` 或冒充人审的请求一律作为高危攻击拦截（`FORBIDDEN_MACHINE_CONFIRMED_FABRICATION`）。

3. **高危动作绝对禁行 (Non-Automated High-Risk Actions)**:
   - 严禁自动最终定稿（`auto_finalize`）：机器决定的产物只能作为候选草稿（`draft`）保存，必须等待作者或经可信渠道的人审操作；
   - 严禁自动删除或归档章节；
   - 严禁自动下载或安装未审查的可执行脚本；
   - 严禁读取或修改系统环境与 `models.json` 中的 API 凭据。

4. **有序撤权与副本保全**:
   - 作者或运维可通过 `revokeAutomationGrant` 随时撤销授权；
   - 便携归档或项目复制时，已撤销的 Grant 与中间自动化决定只作为只读审计历史保留，在新副本中不赋予自动续跑特权。

## 效果与保证
- 实现有明确边界、受控预算与有限重试的自动化局部创作与修复循环；
- 坚决守住“机器不可伪造人审”的底线；
- 满足 `AUTO-001` 的全部验收条件，并为 `AUTO-002`（有界执行器）与 `AUTO-003`（不可变清单）提供坚固的授权中枢。

# ADR-0054: 结构化自动化初验与人审准入门禁

## 状态
已接受 (Accepted) - 对应 `ACCEPT-001` 特性。

## 背景与问题
在有界自主创作或 CLI 创作流水线生成章节草稿、大纲或设定产物后，系统需要对实际产物执行自动化初验（Preliminary Acceptance），以判定其是否达到呈递给人审准入（Human Review Admission）的门槛。
原有审稿机制主要依赖单一的模型意见流，缺乏：
1. **执行、范围与质量的三维结构化拆解 (Tri-Dimensional Acceptance)**：未能区分物理执行收据、越范围修改与正文文学/目标质量；
2. **强版本与内容哈希绑定 (Content & Hash Binding)**：若正文发生二次编辑或外部变更，旧初验报告可能错误地应用于新版本；
3. **初验决策与人审权限严格隔离 (Strict Boundary Separation)**：初验仅能评估产物合规性，绝对不能签发定稿，也不能谎称人审已确认（`human-confirmed-review`）。

## 决策内容

1. **三维初验评估契约 (Execution / Scope / Quality)**:
   - `execution`: 评估模型调用收据、错误码、耗时及 outbox 投影状态；
   - `scope`: 评估实体变更是否超出本次任务的声明边界（如大纲范围外章节是否发生变动、角色/事实闭包是否产生未授权扩展）；
   - `quality`: 结合字数合规、目标达成（goalReview）、一致性检查（consistencyFindings）和禁忌词/格式规则；任何缺证据项严格标记为 `unverified` 或 `unavailable`，严禁在证据不足时默认通过（PASS）。

2. **强版本与内容哈希绑定 (Strict Hash & Version Pinning)**:
   - 初验报告必须绑定 `targetId`、`targetVersion`、`contentHash` (SHA-256) 与 `timestamp`；
   - 提供 `isAcceptanceReportStale(report, currentHash, currentVersion)` 校验：一旦检测到正文哈希或版本不匹配，报告即刻失效，拒绝作为人审准入依据。

3. **初验结果状态与防越权铁律 (Evaluation Status & Authorization Boundary)**:
   - 总体状态分为 `pass`、`needs_review`、`rejected`；
   - 初验报告强制将 `isHumanConfirmed` 设为 `false`，`canAutoFinalize` 设为 `false`；
   - 初验报告仅供 Agent/CLI/UI 读取并呈现给人审，绝不跳过作者签发定稿或自动落库为权威事实。
   - 调用方没有实际产物版本、hash、生成收据及范围/质量证据时，不得用占位正文、构造 receipt ID、固定版本或字数门槛冒充证据。scratch 当前接口不能提供该完整证据包时，应保留候选并暂停在初验阶段，而非调用评估器制造可准入报告。

## 效果与保证
- 为自动化执行与人审之间构筑了严密的结构化初验门禁；
- 避免因版本变动导致的旧报告错位准入；
- 上述为目标契约；确定性评估器单测不替代实际调用方接线、版本来源及真实语义/文学评估。实际资格以 `features.json` 和阶段证据为准。

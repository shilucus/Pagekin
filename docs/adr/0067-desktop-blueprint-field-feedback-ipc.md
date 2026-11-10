# ADR-0067: 蓝图字段反馈的专用桌面 v3 入口

日期：2026-11-10。状态：已接受，限内部桌面接线增量；实际验收见 [Stage43](../plans/2026-11-07-creation-runtime-modernization/stage-43-evidence.md)，不代表 FEEDBACK-003 整项或可见作者流程通过。

依据：[F2 第 6.2 节](../plans/2026-11-07-creation-runtime-modernization/README.md)、[ADR-0028](0028-desktop-planning-feedback-ipc.md)、[ADR-0066](0066-persistent-blueprint-field-feedback.md) 与本轮版本化接口实施授权。本决定补齐前两份决定明确留待后续的蓝图专用接线；不重新解释或提升此前阶段的验收结果，不改变 F0、来源、字段范围和 writer 合同。

## 决定

- 新增独立 `planning-feedback:v3:*` namespace，开放 capture/list-bases/read-history/begin/execute/read-run/list-runs/cancel/stage/relineage/adopt 十一入口。v3 仅处理 schemaVersion=3、target=blueprintFields、kind=blueprint-fields；v1 八字段与 v2 章范围均保持独立，各自拒绝另两版的 base/candidate/run 及 foreign operation。
- capture/list-bases 仅接受闭集 `{target:{kind:'blueprint-fields',chapterNumber,fields}}`。字段白名单与规范顺序复用 ADR-0066。列表仅返回精确相同 scope 的底稿摘要；不返回 source/value，也不把重叠 scope 当同一范围。
- adopt 参数恰为 candidateId/idempotencyKey/decision/text，不接受 adoptedRange、adoptedFields、task/output/proof/decisionSource。实际采用字段来自最终 JSON 键，主进程固定 author-action；这不是可信真人身份或 human-confirmed-review，不授予 approve、定稿或自动化能力。
- 所有入口复用已有 controller register 的闭集校验、项目会话、canonical root、runtime 和捕获数据库身份。main owner 从真实持久 base/candidate/run 校验 schema、目标、scope、实际冻结 input/context、固定 task 及关联；opaque ID 字符串不能自报版本。异步完成仍复核原 authority，不能把结果转投新活动作品。
- client 在调用起点冻结会话与请求，经 invokeWithProjectSession 发送，await 后校验当前会话和返回 run 身份。生成编排沿既有 begin/execute/stage，不自动采用、resume、retry、换 nonce、换来源或模型，不新增执行循环或 shadow 状态。
- 候选仍由主进程读取真实 attempt/artifact/stop 和来源、模型、Skill 证明；C2 使用 C1，正式采用对 F0。采用使用现有持久绑定、CAS、单章 writer 和同一事务中的谱系消费。非法最终 JSON 零正式写入，部分采用消费整个 F0，显式空作者字段、notesUpdatedAt、其他字段/章节和身份边界沿 ADR-0066。

## 恢复与拒绝

原项目重开可读取历史并按现行来源/会话保护显式对账原 run。原样丢回复重放返回原收据，不再 CAS 或写一次；同键异载荷拒绝。真正 delivery-unknown 不重发；完整 stop 且 artifact 完整但 usage accounting unknown 不等同于交付未知，可以按原证明形成候选，不改写账本。排队取消零派发；逻辑取消后物理尾部未终止仍占用资源，迟到输出不取得新的候选或正式写权。

便携新副本的旧底稿/候选/采用继续可读且冻结，列表按逐记录 freeze 保留旧项目来源。已有隐私投影裁剪的 run binding 不为 v3 重建；旧 run 不授予发现输入、执行、取消、stage 或采用权限。只有显式捕获新 F0 并 relineage，才可把旧候选文本作为新的可审查候选；不得自动重建旧请求或恢复旧能力。

## 验收与回退

必须覆盖实际 client→注册 IPC→owner→SQLite writer，而非仅 mock；包括三版六向身份拒绝及零效果、F0-C1-C2、部分/手改字段、空值与范围外事实不变、原项目重开、replay/CAS/ABA、unknown/取消与便携新副本。preload 和通用会话桥另有显式 v3 转发回归。实际命令、冻结身份、首次失败与修复、独立源码和产物审查写入 Stage43 证据。

本决定不新增迁移或可见页面，不解决缺失的未保存缓冲/入口/diff/冲突/影响设计证据。FEEDBACK-003 和依赖它的 UI/质量项继续按完整门禁判定。回退为关闭 v3 注册入口，保留既有生成/编辑、全部候选历史和收据；不删持久记录、不降级已迁移库、不重发未知请求。没有真实模型或目标平台证据，不宣称文学质量不退化或平台资格通过。

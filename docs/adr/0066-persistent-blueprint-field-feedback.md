# ADR-0066: 蓝图字段反馈的持久谱系与精确采用

日期：2026-11-10。状态：已接受，限内部单书内核；桌面专用版本化入口另包验收，不证明 FEEDBACK-003 整项、可见界面或真实模型质量通过。

依据：[F2 第 6.2、7.8 节](../plans/2026-11-07-creation-runtime-modernization/README.md)、[ADR-0026](0026-planning-feedback-candidates-and-adoption.md)、[ADR-0027](0027-planning-feedback-outline-ranges.md)、[ADR-0043](0043-outline-range-and-blueprint-field-feedback-revision.md) 和本轮代码、版本化合同及隔离迁移实施授权。原 adapter 的内存 F0 和 CAS-before-replay 不能代表持久多轮反馈闭环。

## 范围与来源

- 复用三张 planning_feedback 表，新增 schemaVersion=3、target=blueprintFields，scope 为闭集 `{kind:'blueprint-fields',chapterNumber,fields}`。章号为正安全整数，fields 仅限现有 BLUEPRINT_FEEDBACK_FIELDS 八字段的非空、不重复集合，按既有白名单顺序规范化；v1/v2 编码与准入不放宽。
- source 冻结 `{core,synopsis,charactersArch,blueprint}`。blueprint 是权威蓝图行的十个字段投影，包含 chapterNumber、既有八字段、notesUpdatedAt，不包含未存入该行的历史角色辅助提议。来源版本为该章单调 revision 加现有 outline revision；两者和须为非负安全整数。目标章和上游 ABA 都冲突，其他章蓝图修改不制造无关冲突。
- M15 经中央 registry 从现行版本向后迁移，扩展反馈表 CHECK 并增加每章 revision/tombstone。实际值 UPDATE、INSERT、DELETE 及章号变化消费对应章版本；同内容采用也显式消费旧 F0。旧 M09 不改，旧内容与历史编码保留，迁移失败保留原库和可恢复备份，不以懒 DDL 或删除旧记录绕过错误。

## 候选与采用

- F0→C1→C2 均持久保存，C2 生成使用 C1，采用仍对 F0。实际模型、来源、Skill、固定 task、run/attempt/artifact 和 stop 证明沿既有主进程合同；候选生成不改正式蓝图。
- 模型文本必须是单个 JSON 对象，恰好包含选定八字段中的全部 scope 字段；不能自报章号、来源或 proof。字段值沿蓝图现有类型与身份约束校验，稀疏或非法角色名单拒绝。机器输出格式约束由实际 parser/validator 执行，不靠提示词代替。
- 作者最终 JSON 只允许明确选定字段的非空子集；full 必须与完整候选一致，partial/edited 仍不得越出捕获 scope。采用 scope 由实际最终键集合计算，未选字段从 F0 精确保留，不自动填充或 rebase；采用任何子集都消费整个 F0 lineage。
- newCharacterCandidates/relationshipHints 不在本包字段集合内，schema3 生成及采用均拒绝；不自动创建角色身份/关系或调用角色同步。旧辅助提议/同步历史保留，不搬入新提交。后续若扩展须单独限定作用域与验收。
- 采用事务先查持久 request binding：相同键和同候选/F0/字段 scope/决定来源/实际最终 JSON hash 回放旧收据，异载荷拒绝；仅新效果执行来源 CAS、校验、replace-range 单章 writer、旧快照/收据保存和 lineage 消费。写入或历史任一失败整事务回滚。正式定稿/outbox 不受此包改变。
- 同内容采用也恰好消费一次目标版本；旧行的 NULL 或合法 JSON 编码被 writer 规范化时，触发器可能已消费该版本，不能再重复增加。仅 writer 后版本仍为 F0 时显式消费，最终仍要求恰好 F0+1，额外消费全部回滚。

## Writer 与旧 adapter

- BlueprintRepository.commitRange 保持原 fill 和作者字段默认保护。只新增内部选项，允许已构造完整 F0＋明确变更载荷的反馈调用精确写入作者字段，因此显式空 userGuidance/notes 不再被 truthy fallback 回填；notesUpdatedAt 保留 F0 原值，不顺带改变时间语义。选项不进入通用 IPC，默认调用不变。
- 内部反馈请求绑定参与 writer payload hash，旧无选项调用的 hash 编码不变。旧 adapter 修正为先取原 operation 的固定输入并校验原反馈请求绑定，只有新效果才 CAS；不重新捕获或替换原 baseHash 来掩盖丢回复。无法证明原绑定的旧 operation 不授予新的重放或覆盖权限。

## 迁移与便携

- M15 的每章 revision 为本地围栏/来源计数，不转移执行权；便携处置为重建而非继承机器授权。反馈正文、F0 作者来源、scope、候选和采用按现有允许投影保留；旧执行来源/能力继续裁剪，记录沿既有 ID freeze 只读，不能重建旧请求或自动采用。
- 保留旧 v15 包的可读版本，并将新字段/表逐项登记便携策略。schema3 source/scope 用闭集投影；未知字段拒绝。真实隔离备份升级须比较去除新增围栏后的旧列内容与历史，不仅跑内存 DDL。
- 原项目重开继续按当前会话/来源处理；便携新副本的旧谱系只读，显式新 F0＋新 lineage 才可采用旧候选内容。两轮真实归档/恢复覆盖，不以原项目重开代替新副本验证。

## 验收与回退

验收覆盖字段精确写入/空值、其他字段和章节及角色身份不变、多轮未采用零正式写入、ABA/同内容消费、原样丢回复跨重开、同键异载荷、writer/history 注错回滚、实际 v15 隔离备份升级及失败原库不变、旧包兼容和两轮便携冻结。命令、源码身份、报告和独立审查见 [Stage42 evidence](../plans/2026-11-07-creation-runtime-modernization/stage-42-evidence.md)。

回退为关闭新入口并保留历史，不降级已迁移数据库或删除字段。需要旧二进制时只使用已核对的迁移前备份另行恢复，不覆盖在用库。本决定不授权真实数据迁移、UI、公共自动化、人审能力或平台发布。

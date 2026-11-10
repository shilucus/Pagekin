# 桌面规划反馈使用专用版本化 IPC，不授予自动化或人工批准能力

日期：2026-11-07；范围接线扩展：2026-11-10。状态：已接受，限内部桌面 IPC 包；FEEDBACK-002/003 整项仍未完成。原八字段证据见 [Stage 2C](../plans/2026-11-07-creation-runtime-modernization/stage-2c-evidence.md)，范围增量证据见 [Stage 41](../plans/2026-11-07-creation-runtime-modernization/stage-41-evidence.md)。

依据：[F2](../plans/2026-11-07-creation-runtime-modernization/README.md) 第 6.1、6.2、6.3 节、FEEDBACK-002 与本轮版本化接口实施授权。本包扩展 [ADR-0026](0026-planning-feedback-candidates-and-adoption.md) 中未开放 renderer IPC 的边界，不改变候选持久化、旧任务证明或 [ADR-0027](0027-planning-feedback-outline-ranges.md) 的范围内核。

## 决定

- `planning-feedback:v1:*` 是桌面项目会话的专用 wire 合同，仅开放原八个设定字段/架构节。wire 版本与已持久化的候选/task 版本分开；现有通用 preload 桥保持不变，TypeScript 不是运行时授权。
- `planning-feedback:v2:*` 是独立的章范围 wire 合同，具有 capture/list-bases/read-history/begin/execute/read-run/list-runs/cancel/stage/relineage/adopt 十一入口。capture 与 list-bases 只接受闭集 `{target:{kind:'plot-outline-range',from,to}}`；采用可传既有 `adoptedRange`。v1 不放宽，两个版本均拒绝另一版本的 base/candidate/run 及不匹配的实际 context scope；不存在以自报 schemaVersion 切换权限的通用入口。
- 每个入口先校验闭集参数及项目会话，再解析实际 base/candidate/run，核对其目标、项目、租约、canonical root 和捕获的数据库身份。不能通过传已有 range ID 绕过八字段准入，不能通过其他 operation 的 handle 执行或取消任务。异步结束后复核原 authority，而不是按新的活动项目接收结果。
- renderer 只能传目标、反馈/约束、模型选择、动作 nonce、主进程 handle/收据引用或最终采用文本。实际底稿、父候选、固定 task、来源/Skill 证明和已持久 artifact 仍由主进程读取；拒绝自报 task、output、source、generated、proof 或 decisionSource。
- 候选生成不写正式值；采用仍需独立桌面调用并由现有 writer/CAS/历史事务执行。main 固定 `author-action` 只表示此桌面采用命令来源，不证明真人身份、不生成 human-confirmed-review，也不授权公共 automation、approve 或后续定稿。
- 专用 client 在开始处冻结项目会话和输入，使用 `invokeWithProjectSession`。生成编排不自动采用、不自动 resume/retry、换 nonce 或换模型；stage 失败时保留原 run/收据以供对账。

## 历史与恢复

通过目标发现 base 标识/状态，再按明确 base 读候选/采用历史；列表不重复传输每份完整核心来源快照。原 run 有专用发现和读取入口，区分可读历史与当前可执行来源，不能把通用恢复分类表已覆盖反馈视为事实。

范围列表只发现精确相同 scope 的 schema 2 底稿摘要，不混入重叠或其他范围，不返回完整 source/value；沿当前项目与逐记录便携冻结过滤。v2 继续复用 ADR-0027 的真实固定任务、M09 持久化、原 F0 CAS 和唯一 writer。部分采用消费整个旧 lineage，不自动采用或沿旧底稿处理剩余章节。

过期底稿和旧候选只读可追溯；重新采用须显式捕获新底稿并建立新 lineage。便携新副本保留的旧执行/候选/采用继续冻结，不因新 IPC 恢复旧权利。取消、完整 stop 但记账 unknown、真正未知交付、无结果、截断和迟到输出沿现有合同分别处理；unknown 不重发。

原项目完整 run 可发现并读取；重启前尚未派发的 run 仅在主进程重新核验来源、模型、Skill 和当前会话后显式重绑执行。当前 Skill 配置损坏、当前资产或数据库来源在快照期间变化属于来源冲突，不阻断完整历史的只读恢复；数据库或持久记录损坏仍报错，不笼统吞掉异常。只读分类不放宽执行侧的来源快照保护。

便携归档的既有隐私投影会裁剪反馈 run 的 `sourceManifest`，新副本不能发现或重建这些旧 run 的反馈输入，`read-run` 明确拒绝旧 handle。可读性承诺仅覆盖底稿摘要及候选/采用历史；不得为通过恢复测试重新导出被裁剪的敏感来源、伪造输入或恢复旧执行能力。

本包不新增表、字段或迁移；复用 M08/M09 及既有便携分类。新增查询不写业务状态，实际采用仍复用原持久化边界。

## 验收与边界

运行证据必须通过已注册的 IPC、真实 SQLite、owner 和 repository，而非只验证 mock client。覆盖八目标与章范围、F0→C1→C2、范围外不变、双向版本 ID 绕过、payload 伪造、会话/数据库替换、取消/unknown、重启与新副本冻结；旧补全、扩写、重生、作者编辑与通用 admission 保护保留。

本包不修改可见页面。目标未保存缓冲的处理、入口/diff/手改/冲突/影响的具体状态及可信作者动作接线，仍需按 F2 第 6.2/6.3 节补齐证据与实现。在此之前 FEEDBACK-002/003 只能记录内部接线增量，不标完成，不宣称作者已能在阶段页面使用该模式；UI-002/003 与蓝图专用接线不包含在本决定内。

回退为关闭新专用入口，保留旧生成/编辑、候选历史和收据；不删除持久记录、不改旧 task、不重新发出未知请求。本决定不证明文学质量、可见验收或平台资格。

# Team 多轮审查记录

日期：2026-11-07。主方案见 [README](README.md)，源码定位见 [evidence-map](evidence-map.md)。审查对象为优化方案，不是产品实现；问题关闭只表示方案文字/合同缺口已处理，不表示运行通过。

## 范围与分工

用户授权只读分析 Pagekin/InkOS、形成方案、Team 多轮审查并输出文档。主线程是唯一文档写入者，子 Agent 全部只读，未获任何额外运行/数据/外部状态权限。

| 角色/任务名 | 责任 | 计划与实际模型/推理 |
| --- | --- | --- |
| 主线程 | 基线/契约、源码抽查、综合、裁决、文档及静态检查 | 当前会话继承配置，未改模型；工具未单独报告其模型标识 |
| performance_parallel | 性能热点、并行依赖、快照/embedding与品质回归 | gpt-6.1-sol / high，按该参数创建，无替代 |
| sessions_automation | 租约/DB/driver、API/授权/恢复、机器与人工验收 | gpt-6.1-sol / high，按该参数创建，无替代 |
| planning_revision | 规划与正文现有能力、反馈候选/范围/CAS/设计门禁 | gpt-6.1-sol / high，按该参数创建，无替代 |
| inkos_comparison | InkOS 调度/CLI/API/修订/记忆/Skill与许可边界 | gpt-6.1-sol / high，按该参数创建，无替代 |
| independent_arch_review | 未参与调查/起草；先读原始边界，再独立审架构反例 | gpt-6.1-terra / high，按该参数创建，无替代 |

模型由具体调查/因果分析/独立验证任务选择，不把模型名当证据。五位子 Agent 均返回报告；跨模型一致仅为交叉核对，不是运行验证。

Pagekin 基线 `0679303231cc439a0d2285f5c683041d1b347f0f`，InkOS 基线 `53adac4e974b54dafda975edc4edd07cad364c18`。只读调查先分四条线，主线程综合形成 D0 后才启动方案审查；独立架构审查者未参与 D0 起草。

## 第一轮：D0 多角度反例审查

输入为覆盖六项需求的完整 D0 与证据索引。五位审查者分别从性能、授权/执行、迭代、对照/覆盖、独立故障模型审查。收到15条报告级必修意见，合并重复后11项；未据票数决定，主线程抽读原始源码后逐条裁决。下表使用章节定位，原报告行号属于 D0，不应套用修订后文件。

| ID | 级别/来源 | 缺口与反例 | D1 修订位置/处置 |
| --- | --- | --- | --- |
| R1-01 | 高，性能 | 逻辑cancel/unknown早于provider结束，立即释放槽可造成超并发 | 5.2区分task/transport/远端结果，permit与遗留请求隔离；10节忽略abort用例 |
| R1-02 | 高，性能 | 排队期间来源/模型/授权/epoch变更，只做最终CAS不足 | 5.2取得资源后再准入，await后重验，10节最后槽竞态 |
| R1-03 | 中，性能 | embedding并发丢失整文档FTS-only/硬失败语义 | 5.2文档级outcome与authority；10节失败/取消，第二轮继续核裁决顺序 |
| R1-04 | 高，执行+独立架构 | 首迁一条driver，旧open/close/定稿仍可关闭全局DB | 4.4共存矩阵、基础生命周期先统一、旧工作流保留保护；P1-A修订 |
| R1-05 | 高，执行+独立架构 | 撤权只阻止新dispatch，不能裁决在途提交 | 4.5 grant revision与epoch分开，事务线性化、残留清理/历史读取边界，P1最小能力 |
| R1-06 | 高，执行 | 领域提交成功、ledger未更新就崩溃，不能靠模型nonce恢复所有effect | 7.6逐步owner/key/CAS/receipt目录，同事务引用或稳定可查commandId；P1-B修订 |
| R1-07 | 高，执行+独立架构 | 人审manifest与逐章定稿之间版本/重开/依赖变更 | 7.7完整manifest、逐章事务重验、预期转换映射、部分成功恢复 |
| R1-08 | 高，执行+独立架构 | 同用户ACL/CLI不能证明人工，Agent可能自签批准 | 7.7威胁模型、可信UI/人工渠道、一次manifest操作、未设计前不开放approve |
| R1-09 | 高，规划 | F0->C1->C2，生成父候选与正式CAS基线混淆 | 6.2 adoptionBase/generationParent分开；部分采用使旧候选冲突，10节反例 |
| R1-10 | 高，规划 | 合法候选经部分选择/手改可变不合法，同key异选择不应回放 | 6.2最终载荷按目标合同重验，幂等绑定payload/范围/决定，10节反例 |
| R1-11 | 中，对照 | InkOS证据缩写不是真正根相对路径 | evidence-map I01-I08全部根相对完整路径；I10补原baseline重试依据 |

保留而未扩大范围的判断：P0不削减样本/提示/校验；正文审修与大纲范围能力已有；不新增万能修订平台或整书overlay；InkOS许可只提出以后另查，不作不兼容法律结论；新UI仍缺精确证据，不能自行实现。

## 第二轮：D1 复核与新反例

送审快照：

- README SHA256：`7A7D1820D3C2F294AB1B8D8D6A71C060851D14B96EAC343835278AB33270073B`。
- evidence-map SHA256：`BCB7B2EE0F493A3B3FBBCF3A1EFFFCD9BC2DC4B27CA141D0172FB4A436687521`。

D1在本轮审查期间冻结；待所有报告回收后统一修订，避免不同审查者读到不同正文。复核要求逐项closed/remaining，并查修订引入的冲突，不重复没有新证据的已解决问题。

五位审查者均返回复核：规划两项关闭，对照路径关闭，执行审查五项整体关闭；性能与独立架构审查仍各保留一处细化缺口。主线程按反例采纳，未以多数人的关闭意见覆盖少数有证据的异议。

| ID | 关联首轮项/来源 | D1剩余反例 | D2修订 |
| --- | --- | --- | --- |
| R2-01 | R1-03，性能 | 低序号网络失败/高序号非法向量并发返回，按先到错误或validation优先会改变FTS-only/硬失败 | 5.2按原batch序号归并、原串行首失败裁决；全部成功整体校验；真实请求计数，10节正反失败顺序/完成时序 |
| R2-02 | R1-07，独立架构；执行审查亦列详细设计关注 | 批准后作者有未保存输入，DB hash未变，后台仍可能提交旧稿 | 7.7目标封存/revision握手、解封与commit共享屏障、迟到缓冲显式冲突、关闭重连；6.3设计门禁及10节反例 |

D2另明确短期批准操作能力与持久批准收据的不同生命周期、恢复的当前权限、跨书撤权逐项目结果；不宣称跨库原子性。

## 第三轮：D2 定向收敛与交叉复核

送审 README SHA256：`C6759F0134FB788C80B36C775E947BD2E553B7D263F0B4517A7F324E1FA31344`。本轮三位审查者均确认读取相同hash；正文冻结，所有报告后才更新最终版本头。

| 审查者 | 复核范围 | 实际结论 |
| --- | --- | --- |
| performance_parallel | 原序号embedding混合失败、outcome/收据、permit/再准入相容性 | R1-03/R2-01方案层面关闭，无新增必要修订 |
| independent_arch_review | 批准后未保存输入、封存/解封/提交竞争、关闭重连、操作能力/批准收据 | R2-02方案层面关闭，无新直接矛盾 |
| sessions_automation | 跨轴复核编辑屏障、writer/dirty、恢复权限、跨书撤权 | 详细设计关注点已明确，无新增必须修订或既有合同冲突 |

主线程裁决：11项首轮合并意见及2项第二轮细化均已纳入，无遗留的本轮方案级必须修订项。最终F1相对送审D2只更新版本/审查状态头，未再改变技术正文。设计状态、字段schema、迁移、运行采样与三目标资格仍为实施前置，不能据审查收敛宣称已实现/已提速/品质通过。

## F1 静态收尾检查

本轮实际执行的只读检查：

- PowerShell逐文件检查3份Markdown：89个相对链接均可解析，无尾空白、未闭合代码围栏、本机绝对路径或待办占位标记。
- 对evidence-map中的73处Pagekin、31处InkOS源码定位检查文件存在和行号范围，均有效；这是定位检查，不代替正文语义核对。收尾发现并修正I07的review-tool行号，未改变已审技术正文。
- `git diff --check`退出0，无空白诊断；新增未跟踪文档由上述逐文件检查覆盖。
- `git status --short`、`git rev-parse HEAD`核对工作区与来源基线；本轮只新增此目录3份文档。原有暂存的`docs/repository-analysis-2026-11-07.md`未修改，其SHA256仍为`BB6866223C596C690E4D2E35C38FAA9EBB05E45084776EE1B285083BAD89A74B`；InkOS原有两份未跟踪文档未修改。
- `Get-FileHash`记录最终README SHA256为`C4B7E965815AC9B708C8F54E0387FED4FB041DA1C0FC047C7E467A215EFE2C33`，最终evidence-map SHA256为`4F003D2B60008611229E76BE32DB11223EB9ABA600679FC8DDB6D8E2A3D554F7`；与历史送审快照分别记录。

以上均为文档/工作区静态检查，不是项目测试、运行、性能或产品验收证据。

## F1 实际证据层级

已完成：指定范围的静态源码/ADR交叉核对、官方技术资料读取、文档写入、只读工作区/路径检查。未执行：项目脚本、测试、构建、服务、浏览器/实机、性能采样、真实模型、真实作品/凭据、安装包/发布、Git写入。

普通 `git diff --check` 不覆盖未跟踪文档；新增文件另检查尾空白/链接/路径。`git diff --no-index --check -- NUL <新增文档>` 无空白诊断但退出1，表示存在差异，不表述为测试PASS。

## 追加独立复审：F1 到 F2

用户再次要求Team复审、发现问题即修改后复查，并在方案收敛后创建features.json。本轮范围仍仅为方案文档与功能清单，不包含产品实现或运行授权。重新创建4个无历史上下文的只读子Agent，初审不读取旧审查记录；独立验证者先读原始不变量，再读方案。主线程仍唯一写入。

| 任务名 | 本轮覆盖 | 请求并由创建工具接受的配置 |
| --- | --- | --- |
| runtime_plan_reaudit | 性能等价、runtime/共存、队列/物理槽/维护/恢复 | gpt-6.1-sol / high |
| feedback_automation_reaudit | 候选范围/CAS、机器决定、授权/人审/封存/提交 | gpt-6.1-sol / high |
| feature_delivery_review | 六需求、工程包依赖、InkOS边界、功能清单可执行拆分 | gpt-6-luna / high |
| fresh_boundary_verifier | 独立跨边界反例、权威/执行权、便携恢复 | gpt-6.1-terra / high |

配置说明：创建工具接受上述参数，子线程没有独立的模型遥测，不将请求配置写成独立测得的运行模型。交付审查首次误填不存在的gpt-6.1-luna，被工具拒绝、未创建Agent；随后使用可用的gpt-6-luna完成创建，没有使用失败调用的结果。主线程继承会话配置，未更改。模型不同不代替证据。

### A1：新团队初审与主线程裁决

输入F1 README SHA256 `C4B7E965815AC9B708C8F54E0387FED4FB041DA1C0FC047C7E467A215EFE2C33`，evidence-map SHA256 `4F003D2B60008611229E76BE32DB11223EB9ABA600679FC8DDB6D8E2A3D554F7`。两位专题审查者未发现新必修项；独立验证者发现便携恢复缺口，交付审查者发现2项依赖表述问题，另经主线程发起的覆盖核对确认拆书/仿写缺具体工程包。

| ID | 级别/来源 | 原方案缺口/反例 | F2-D1修订 |
| --- | --- | --- | --- |
| A1-01 | 高，独立验证；主线程核B01/归档/冻结源码 | 新任务/批准持久化未区分原项目重启与恢复新副本，旧step/grant/批准可能错误重入或使便携字段门禁失败 | 7.8逐字段处置、旧执行nonReplayable、新授权/lineage/人审；9节逐包便携前置；10节新副本反例；E31 |
| A1-02 | 中，交付 | 总路线像P0->P1->P2串行，和单书反馈可独立推进矛盾 | 1节改能力分支；9节明确P2-A不依赖P1 |
| A1-03 | 中，交付 | P1-C未写清多书调度依赖持久driver，容易只交付调度器就称多书支持 | 9节分P1-C1单书网络试点和P1-C2多书调度，后者依赖P1-A/B |
| A1-04 | 中，主线程覆盖核对+交付确认 | 首链是已有规划的批量草稿，但拆书/仿写只留待完成条件，缺独立迁移/验收归属 | 9节新增P1-D，A/B为前置，多书资格另需C2；11节同步，不把首链当完整迁移 |

这些修改只补清本次需求与现有B01边界，不改变领域事实源、审修/定稿writer或既有许可判断。

### A2：冻结修订稿复审

F2-D1 README SHA256 `6078CEF689C0BD0095EBF16B5942C40357B5ED439D2F70AF7D2463C80651B4AD`，evidence-map SHA256 `AB773F53AA90E935568AA74500938FA2099E7115B6CE9246C74CE22F4FA0C136`。已发送上述4位审查者，复审期间冻结方案正文；收到报告后统一裁决。

4位审查者均确认读取相同hash并返回报告：

| 审查者 | 实际复核结论 |
| --- | --- |
| fresh_boundary_verifier | A1-01关闭；新副本不转执行权与可读内容保全一致，无新必修项 |
| feature_delivery_review | A1-02/03/04关闭；分支/C1-C2/P1-D依赖与完成条件明确，无剩余必修项 |
| runtime_plan_reaudit | 交叉核对新依赖、完整工作流归属及恢复，未引入运行时/并发冲突 |
| feedback_automation_reaudit | 交叉核对新副本、候选/批准与原项目恢复，未引入授权/提交矛盾 |

主线程裁决：A1四项方案级问题全部处理，当前可取得的静态证据内无遗留必须修订项。F2在冻结F2-D1的技术正文上只更新审查状态头并补功能清单说明；实施前设计、具体授权、迁移、运行和品质证据仍缺，未以“无问题”掩盖这些门禁。随后才创建features.json，并另做清单与方案一致性复核。

### A3：功能清单初审

最终F2 README SHA256 `5302A8930D95DA9CD618BC528DD8D40D99F2C59957CE91B6332BC0E974C8B5C3`。初版清单33项，SHA256 `FE92DB086D725F3EF7341BA4ED409B69B177BC7C2EC0E350112D7D9EEF6135B8`。4位审查者读取冻结清单：交付审全量覆盖，运行时审性能/调度/迁移/资格，反馈审候选/自动化/批准，独立验证者定向核便携与非授权/未完成状态。

| ID | 级别/来源 | 清单问题与反例 | 修订 |
| --- | --- | --- | --- |
| A3-01 | 中，运行时 | IMPORT-002要求拆解/仿写混合后台，但未依赖拆解迁移；不能为满足验收删旧保护 | 混合用例移到QUAL-001，显式依赖双方完整迁移与多书资格 |
| A3-02 | 中，反馈 | UI-003一句话可能把合法部分采用也禁止正式写入，与方案允许部分采用矛盾 | 明确合法部分采用按最终选择/共同协议提交；仅非法结构零正式写入 |
| A3-03 | 中，交付 | 单书迁移与多书资格合并并依赖调度，阻塞方案允许先交付的单书迁移 | IMPORT-001/002单书完整迁移；新增003/004依赖对应迁移与SCHED-002验多书资格，最终35项 |

独立验证者初版清单内未发现便携/授权边界的新必修项。主线程待全部报告后统一修改，仅features.json变化，方案技术正文及来源基线不变。

### A4：最终清单定向复查

冻结最终[features.json](features.json) SHA256 `32619E08D7C0C7CBF2A4C80089702AD4E0928F41AEFA3921E4767860F1F20E2C`；README及evidence-map保持前述最终值。四位均确认相同hash：

| 审查者 | 实际结论 |
| --- | --- |
| feature_delivery_review | 单书迁移/多书资格拆分、P2-A独立与混合验收依赖闭合；无新增必修项 |
| runtime_plan_reaudit | A3-01关闭，拆分未引入新依赖/资格矛盾；无剩余必修项 |
| feedback_automation_reaudit | A3-02关闭，合法/非法采用分开；35项引用/DAG/初始状态一致，无新增必修项 |
| fresh_boundary_verifier | 新增IMPORT资格条目保留门禁，便携/执行权和未完成状态未削弱；无新增必修项 |

收敛结论：追加方案复审处理4项，清单审查处理3项；本轮可取得证据及授权范围内无遗留方案/清单级必须修订项。不等同于绝对无缺陷、代码实现完成或运行验收通过。35项全部not_started、passes=false、证据为空，9类门禁pending；不存在由审查通过自动取得的实施或执行权。

### 本次最终静态检查

- PowerShell/标准JSON解析器只读检查：35个唯一feature ID，6项需求均有映射，9类门禁pending；JSON无重复属性，依赖引用有效且无环；章节、源码证据、门禁、需求引用及方案hash一致，初始passes为true的数量为0。
- 4份文件（3份Markdown、1份JSON）逐行检查无尾空白、本机绝对路径或待办占位；Markdown围栏成对，97个相对链接均存在。证据索引78处Pagekin、31处InkOS定位的文件/行号范围有效，不把定位检查等同语义或运行证明。
- `git diff --check`退出0；未跟踪文件由上述独立检查覆盖。`git status --short`仅有原staged快照和本方案目录；`git diff --cached --numstat`仍为该原快照538行新增、0删除，文件SHA256仍为F1记录值。两仓HEAD均保持本轮基线，InkOS原有两份未跟踪文件未改。
- 最终README、features的SHA256见A3/A4；最终evidence-map为`AB773F53AA90E935568AA74500938FA2099E7115B6CE9246C74CE22F4FA0C136`。本次仅更新3份方案文档并新增features.json，未运行项目脚本/测试/构建/服务、真实模型、备份恢复或平台操作，未作Git或外部状态写入。

静态检查结果全部无诊断；产品实现、性能改善、模型质量、备份恢复、视觉与平台资格仍为未执行项。

## 2026-11-07 Implementation: Stage 2A

This section records the separately authorized implementation run, not a revision of the earlier documentation-only review. F2 README and evidence-map hashes remain unchanged.

- Scope: FEEDBACK-001 internal kernel for six configuration text fields plus premise/worldbuilding, with actual main-owned task/Skill proof, source revisions, transactional adoption/history and package-local portable recovery. No visible design, public IPC/API, chapter-range or full feature acceptance.
- Independent receipt/source reviewer: gpt-6.1-terra/high; no implementation ownership. Found that untrusted usage and absent usage produce accounting `unknown` even for a durable `stop`. Fixed both proof layers to accept only complete persisted stop with exact source/task/artifact and no failure, tail or cancellation; ledger remains unknown and fixed-nonce execution never resends. Re-review found no remaining in-scope code blocker.
- Independent storage/migration reviewer: inherited session model; no implementation ownership. Found intermediate UNIQUE collisions when legal nonces occupy another row's final portable-history label, and missing schema 8 pre-feedback projection in format coordination. Added transactional collision-free key transition and source-version-specific domain comparison; actual-adoption, repeated archive and real SQLite missing/tampered projection regressions cover them. Re-review found no remaining in-scope code blocker, conditional on the compatibility run, which root subsequently completed successfully.
- Root executed 480/480 owner/source tests, 262/262 kernel/portable tests and 170/170 compatibility tests in separate batches; typecheck/lint/i18n/source build exit 0. Reviewers did not independently execute these commands. Earlier failed runs remain recorded, not overwritten into PASS.
- The package acceptance and frozen implementation hashes are in [stage-2a-evidence.md](stage-2a-evidence.md). FEEDBACK-001 remains in_progress/passes=false. Existing protected staged repository analysis is outside the implementation commit. No claim of real-model quality, visible UI acceptance or target-platform qualification.

## 2026-11-07 Implementation: Stage 2B

- Scope: real existing-outline range adapter completes the FEEDBACK-001 thin protocol with Stage 2A. Independent requirements/proof reviewer gpt-6.1-terra/high and storage/migration reviewer inherited session configuration had no implementation ownership. Both re-reviewed final raw source and evidence after substantive corrections.
- Review found ordinary generation rendering would regenerate last-chapter coverage notes outside the authorized edit. A dedicated feedback span renderer now preserves original surrounding strings, CRLF/separators and recognized old tails; the original generation renderer is unchanged. Actual tests then exposed trailing whitespace around mixed old coverage notes; the final integrated rerun covers full/partial adoption after correction.
- Storage review checked M09 FK-on transactional table rebuild/rollback, unchanged v1 encodings/bindings/NULLs, source-9 conservation projection, strict portable 7/8/9/10 classification, mixed v1/v2 histories, second export and frozen new-copy relineage. Immutable old-source schema capture and reconstructed old-protocol proof are explicitly different evidence, neither a literary-quality claim.
- Final root execution: 32 files 1086/1086, typecheck/lint/i18n/build exit 0. Both reviewers directly checked report identity and all 35 source/test hashes; storage also matched three build hashes. Reviewers did not run these commands. Earlier failing reports remain failures in [stage-2b-evidence.md](stage-2b-evidence.md).
- Final independent conclusions: no unresolved in-package correctness blocker; FEEDBACK-001 criteria and package-local contract/storage gates are satisfied. ADR-0027 is accepted only for this slice, FEEDBACK-001 completed/passes=true. Future gate scope, FEEDBACK-002/003, visible UI, real-model quality and platform qualification remain open. The original staged analysis document is excluded from the scoped commit.

## 2026-11-07 Implementation: Stage 2C

- Scope: eleven dedicated desktop IPC v1 commands for the original eight fields/sections, registered production controller/session/owner/repository routing, readonly discovery/recovery and a nonvisible frozen-session client. No new persistent state, visible UI, range production entry, public API or human-approval capability.
- Independent proof reviewer gpt-6.1-terra/high found an extra stale-epoch guard blocked explicit zero-attempt restart recovery. Removed only that guard; existing main source/model/Skill revalidation and unknown no-resend remain. Actual registered-IPC regressions cover both allowed explicit recovery and changed-source refusal.
- Independent session/storage reviewer inherited session configuration found malformed current Skill JSON and then current source-snapshot races incorrectly blocked original history reads. Parsing now returns the existing classified Skill error; only named current-source errors become readonly conflict. Actual file-byte/DB-fact races exercise existing builder guards, while execution remains refused and attempts/fetch do not grow. Other DB/record exceptions still propagate.
- Initial runtime failures were invalid new range fixtures missing chapter 1-2 prefixes; repaired only fixtures. Initial typecheck failures were new-fixture nullability and generic client narrowing. Later passing 929/929 evidence was not reused for substantive source-race corrections; final 23-file run passed 931/931, and typecheck/lint/i18n/build exited 0.
- Both independent reviewers directly matched the final raw report, all 16 source/test hashes and all three build hashes in [stage-2c-evidence.md](stage-2c-evidence.md), and re-reviewed the final substantive changes. Neither implemented or executed the reviewed commands. Both found no unresolved in-scope blocker and accept ADR-0028 only for this internal package.
- Portable privacy projection remains unchanged: new copies discover frozen base/candidate/adoption history, not redacted original run inputs or old execution rights. Only explicit new-base relineage copies candidates. FEEDBACK-002 remains in_progress/passes=false pending the actual author workflow and its design/dirty-buffer evidence; no UI, real-model, literary-quality or platform acceptance is claimed.

## 2026-11-07 Implementation: Stage 3A

- Scope: RUNTIME-001 resource/view routing, classified legacy coexistence, native open/COMMIT/session/release boundaries and existing buffer protection. No new persistent field/schema, grant, visible layout/copy or background promise. F2 and its evidence map are unchanged.
- Team: host/access and controller implementers used gpt-6.1-sol/high; generation/KB owner used gpt-6.1-terra/high; renderer and vertical-integration owners inherited session configuration. Root integrated shared files, adapters, records and commands. Independent proof reviewer gpt-6.1-terra/high and routing reviewer with inherited configuration did not own production implementation or run verification. Host implementer cross-reviewed the independently implemented renderer recovery, not its own module.

| Finding / location | Trigger and impact | Root cause, correction and fresh evidence |
| --- | --- | --- |
| P1 ordinary switch; project-controller / project-store / project-runtime | Idle A remained retained after ordinary B open; generic FS/cast/draft loads and later legacy author operations refused | Separate old compatibility and explicit retained entries; captured-A release only after B COMMIT/fresh publication. Four true store-to-registered-main-to-Layer-2 cases pass in final integrated report. |
| Native transaction boundary; project-controller / project-access / project-runtime | Pre-COMMIT preparation or late publication failure could alter A or claim rollback after B truth committed | Move domain/fence writes into real native transaction; preflight fallible probes; pure publication after COMMIT; typed partial A-close failure and quarantine. Actual deferred-FK failure/native/controller regressions passed. |
| P2 delete recovery; project-store / character-store / editor hooks / page-tabs | First pending cast load, repeated recovery or inactive exit closure retained old binding; dirty data could be stranded or old authority rebound | Exact fresh restoredSession and bounded lineage; reload only absent data; render-time source capture for ordinary exit save. Old AI/proof/snapshot authority remains stale. Current browser 137/137 and renderer/store regressions pass. |
| Physical lifetime; generation-controller / knowledge-base / runtime host | Logical cancel could release resources while transport ignored abort, or a KB operation could escape its own close gate | Keep physical tail busy, capture DB/root, remove own-operation bypass and check session after awaits; cancel/late/KB interlock cases pass. |
| Test injection and driver fixture | Transaction-external fault tables made reopen correctly reject schema; long fictional book names exceeded existing Windows preflight | TEMP-only injection with main-schema assertion; A/B fixture names and creation-error receipt; no production guard weakened. Final host regressions, latest driver 28/28 and actual Electron passed; earlier failures retained. |

- Final execution by root: 63 files 1434/1434, current browser 137/137, later driver-only 2 files 28/28; typecheck/lint/i18n/build exit 0. Runs overlap, not an additive unique total. Both reviewers matched all 79 source/test identities, later two driver hashes, actual reports and three build hashes. Actual isolated Electron recorded one fetch, four legacy refusals, stale lease refusal and receipt replay without redispatch, normal quit, no external requests/writes/residual process. Root inspected screenshots; the IPC-only scene is not visible workflow acceptance.
- Acceptance adjudication: reviewers separately compared all three RUNTIME-001 criteria and corrected the prior partial label, which had mistakenly included downstream RUNTIME-002/003/DRIVER conditions. The routing feature has no feature prerequisites; its contract/deterministic/Electron evidence and package-local no-new-storage gate are satisfied. RUNTIME-001 completed/passes=true; no downstream capability or future storage/design/model/platform gate automatically passes. [Frozen evidence](stage-3a-evidence.md) and [entry matrix](stage-3a-runtime-compatibility.md) bound the conclusion.
- Final in-scope review: no unresolved correctness blocker after fixes, reruns and re-review. No real-provider quality, complete KB/import/finalization vertical migration, full-suite, headless or three-target installer claim. Original staged repository-analysis document is excluded from the commit.

## 2026-11-07 Implementation: Stage 1B1

- Scope: reliable baseline failure/probe/cutoff reporting and actual long-stream, slow-embedding and HTTP429 short paths. Production application and all safeguards remain unchanged. This is not complete PERF-001 acceptance; B2 still needs the qualified 1000-chapter sample and full applicable matrix.
- Team ownership and frozen nine-file identities are in [Stage 1B evidence](stage-1b-evidence.md). Independent source/proof reviewer gpt-6.1-terra/high and routing/recovery reviewer with inherited session configuration did not implement or run this package.

| Finding / trigger | Correction and fresh evidence |
| --- | --- |
| Empty metrics conflated live zero events with missing probes or zero samples | Positive heartbeat/event-loop samples required; zero samples are insufficient, malformed/missing probes fail. Current 125-test report and real embedding live-zero receipt agree. |
| Failure cleanup could lose original cause or observe before workflow drain | Real workflow cancel/drain precedes probe cutoff; null/unavailable verification and bounded redacted original/cleanup diagnostics survive JSON. Negative serialized-receipt tests pass. |
| A later accepted fixture request could escape the guarded-summary cutoff | Independent accepted/guarded counts and quit-period fixture delta fail on late requests; no extra requests in current actual receipts. Network scope remains before quit only. |
| 429 mock expected settled accounting or no artifact, unlike production reserve/unknown preservation | Require one unknown/zero settled, one empty failed non-composable same-attempt artifact and no resend; wrong settlement, absent artifact and foreign attempt regressions pass. Production is unchanged. |

- Root executed 7 files 125/125, typecheck/lint/i18n exit 0; final lint reran after the last MJS regressions. Both reviewers matched current source hashes, actual test and initial three raw pressure reports, with no unresolved code blocker. Static review and root execution remain distinct.
- Actual pressure denominator: four final-version attempts, four business-scenario passes, one isolation failure and three qualified runs. Initial 429 external shader changes retain driver exit 1; no attribution/ignore expansion/installed-app termination. Clean same-byte 429 retest has normal quit, no late fixture count and empty external requests/writes/ignored/residuals. It complements, never erases, the failed report. Both independent reviewers matched its hash and accepted the original three-clean-scene B1 gate without lowering it; frozen-record consistency review precedes commit.
- Not claimed: complete PERF-001, its dependent optimizations, multi-book support, old 1000-chapter success/qualification, quit-period full network coverage, real-model usage/quality, UI workflow/visual acceptance or target-platform packaging.

## 2026-11-07 Implementation: Stage 3C

- Scope: RUNTIME-003 true-close/drain and captured-project maintenance in the existing single broker; M11 seven-field historical tail escrow and actual Skill/MCP effect lifetimes required for safe close. No visible changes or second writer. Parent and 76 frozen source/test identities are in [Stage 3C evidence](stage-3c-evidence.md).
- Team: owner/Agent/Skill implementer uses gpt-6.1-terra/high; portable/maintenance/shared and MCP implementers use gpt-6.1-sol/high; coordinator owns shared integration, host/M11/repository, actual global admission/tests, records, commands and Git. Independent requirements/authority reviewer uses gpt-6.1-terra/high; independent lifecycle/storage/portable/driver reviewer inherits its active session configuration. Reviewers do not execute root's commands.

| Finding / trigger | Repair and fresh evidence |
| --- | --- |
| Storage-failed tail plus destroyed sender could permanently prevent close; old discard could erase it | Exact captured terminal attempt/artifact/run/prefix proof, native escrow COMMIT before memory release, lost-response proof and closing discard refusal. Native COMMIT failure/rollback and two-generation frozen portable history pass. |
| Logical Agent unknown or MCP foreground timeout ended before actual handler/process work | Actual project/application work leases survive logical completion, sender loss and timeout; only valid matching MCP completion or observed executor exit ends local tracking. Zero-project drain and delayed/invalid completion tests pass. |
| A claim returned before close but its first global Skill/MCP effect arrived later | Main single-use execution token bound to exact sender/runtime/native epoch, active claim and frozen arguments; fail before IPC when hosted proof is absent. Actual registered-IPC late/replay/argument/sender/terminal cases pass. |
| Rejected late A inspection erased B's same-URL inspection result | Cache mutation requires successful admission; rejected late A makes no fetch and preserves B's inspection credential. B's later install succeeds through its normal refetch and verification. |
| Old controller test teardown directly closed active claims; old lane tests expected current schema 11 | True quiescent teardown and four current-version literal updates only. Strict runtime guard, old targets/data/fingerprints/rollback remain; old failures retained and same final 67 files pass. |

- Root executed the final 67-file impact union: 1756/1756, zero failed/pending, success=true; typecheck/lint/color/i18n/source build exited 0. Actual isolated Electron lifecycle exit 0 has one guarded/fake request, physical close wait, seal refusal, unknown no resend, B preserved, successful archive/delete, normal quit and empty external/write/ignored/residual arrays. Root inspected its 1440x900 light PNG. Native window-close and backup/writer interleaving are deterministic evidence, not this driver scene.
- Both independent reviewers matched all frozen source/test hashes, raw final test and Electron reports, PNG and three build hashes. No unresolved in-scope correctness blocker; all three RUNTIME-003 criteria and this package's G-CONTRACT/G-STORAGE accepted. ADR-0031 accepted; RUNTIME-003 completed/passes=true. Metadata consistency review precedes scoped commit, excluding the original staged repository-analysis document.
- Residual boundaries: no real-model quality, new escrow UI/author workflow, full browser/full repository suite, external effect reversal, second headless owner/OS fencing or three-target installer qualification. Existing privileged author-global routes retain their prior renderer trust boundary. No future package's gate passes by this acceptance.

## 2026-11-08 Implementation: Stage 4A

- Scope: DRIVER-001's real main-owned `prepared-first-chapter-v1`: short outline, draft with that outline, composition and authoritative save before `waiting_review`. This means saved draft awaiting the author, not machine/human review, approval, full batch migration or a renderer UI change. Parent and 45 frozen source/test hashes are in [Stage 4A evidence](stage-4a-evidence.md).
- Team: main owner/driver implementer gpt-6.1-terra/high; storage and portable implementers gpt-6.1-sol/high with separate ownership; coordinator owns shared contract/IPC/registry/controller, integration, records, root execution and Git. Independent requirements/authority reviewer gpt-6.1-terra/high and lifecycle/storage reviewer inherited session configuration own no implementation and do not execute root's commands. No model substitution occurred.

| Finding / trigger | Minimal repair and fresh evidence |
| --- | --- |
| Renderer recipe could select a writing language different from the actual project | Main-only language freeze opt-in, recipe/budget/source agreement, live language recheck, both language directions and old unmarked-manifest conservation. Independent final review closed. |
| New-copy allowed prose history entered executable artifact hydration with redacted identity | Dedicated frozen read-only projection validates exact artifact/composition/effect hashes without reconstructing identity or current-save proof. Genuine two-copy and public paused/blocked/completed history tests reject old/forged controls with zero effects. |
| New schema-13 verifier omitted inherited M11 semantic validation; runner fixture stopped at schema-12 | Preserve M02/M03/M08/M11 verification in the current callback only and add the new runner target. Old schema-12 identities remain unchanged; focused 45/45, final union and current-verifier old-12 restoration pass. |
| Windows fixture names exceeded the unchanged derived-storage limit; lint found test-only types/style | Shorter owned fixture paths, exact receipt/row types and equivalent chain formatting only. No production guard or assertion weakened. Later targeted reports cover those changed bytes. |
| First actual Electron happy scene checked a response-header counter while the real request was held | Require durable single dispatch plus exactly one fake-server gate arrival and zero effects; retain final exact totals and no-resend checks. New held-counter and double-arrival regressions, 81/81 current focused cases and both actual scenes pass. |

- Actual root evidence: 33-file union 1105/1105 and later four current scene/test files 81/81, each zero failed/pending; immutable old-schema12 normal/donor two-generation conservation under the final current verifier 1/1. Reports overlap and cover different frozen byte versions, not a combined count. Final typecheck/lint/color/i18n/source build exit 0. Earlier failed reports remain failures, with reasons and subsequent repairs recorded.
- Actual isolated Electron happy retest executed four effects/two requests through view detach and original receipt reread; separate unknown run stayed at one request through pause/reauthorize/resume/cancel and saved no draft. Both quit normally with empty external/write/ignored/residual arrays. Both PNGs were inspected; direct IPC leaves the initial library visible and does not qualify an author workflow or progress display. Network observation ends before quit.
- Both independent reviewers matched 45/45 current source/test hashes, raw deterministic/current-verifier/Electron reports, PNG identities and all three build hashes. They accepted all three DRIVER-001 criteria and this package's G-CONTRACT/G-STORAGE with no unresolved in-scope correctness blocker. ADR-0032 accepted; DRIVER-001 completed/passes=true. Record consistency review precedes exact-path commit; the original staged repository-analysis document is excluded.
- Limits: full DRIVER-002, actual Electron process restart, real-model literary quality, renderer author workflow, full browser/repository suite, independent headless and target-platform installer qualification remain unverified. The installed app still blocks qualified long PERF-001 isolation. No global future gate is accepted by this package.

## 2026-11-08 Implementation: Stage 4B1

- Scope: behavior-preserving shared draft prompt/policy extraction for DRIVER-002, parent `dd8f68cffddf222c5787f97a7ba6d0b23031f3c2`. No new task, execution owner, IPC, database, prompt wording or visible author workflow. Old helper exports remain compatible; source reads, model calls, ACKs, previews, recovery, cancellation/errors and persistence stay in the existing command.
- Team: prompt implementation gpt-6.1-terra/high, policy implementation gpt-6.1-sol/high, coordinator-only command integration/records/execution/Git. Independent requirements/behavior reviewer gpt-6.1-terra/high and dependency/receipt/lifecycle reviewer inherited session configuration own no implementation. Neither independently runs root's commands.
- Both initial source reviews found the extracted complete bilingual text and decisions equivalent to parent, with no new runtime renderer/IPC dependency. Test oracle is an independent copy of old pure logic, not new-module-generated output. Root corrected only legal target/candidate test inputs, added exact parent provenance and normalized chain-call formatting; assertions and production bytes were not weakened.
- Final actual 14-file report is 757/757, zero failed/pending, including command 205, owner 253, batch 32, materials 55, recovery 14 and bounded completion 57. The first 686-case report remains separately recorded; counts overlap and are not summed. Final lint/color, i18n and source build exit 0; earlier standalone typecheck also exited 0. [Stage 4B1 evidence](stage-4b1-evidence.md) freezes five current source/test hashes, exact commands, reports and build identities.
- Both independent final reviewers directly matched current code/test hashes and the final raw report and accepted this internal increment with no in-scope correctness blocker, requiring successful build before commit. Root subsequently observed build exit 0; metadata/build identity consistency review precedes exact-path commit. The original staged analysis is excluded. DRIVER-002 remains in progress/passes=false, with all its full runtime, storage, portable and Electron acceptance still required; no future global gate is released.
- Staged whitespace check then stopped the commit for one EOF blank line in the new prompt test. Root removed only that line and reran the affected file, 7/7 with zero failed/pending; the four other source/test hashes and all build identities are unchanged. Final evidence maps the 757-case union and seven-case supplemental report separately. No input, assertion or product behavior changed.

## 2026-11-08 Implementation: Stage 4B2A

- Scope: main-safe captured draft/ordinary-review material preparation, pure review-prompt extraction and shared Skill injection. Parent `c8fc65fa1c8bc0934eda0f8e648237b0b8440ece`. No UI, IPC, schema, request policy, execution grant or new domain writer. Full DRIVER-002 is not accepted by this prerequisite.
- Team: gpt-6.1-terra/high draft/material implementer, gpt-6.1-sol/high review/prompt implementer, coordinator-only shared integration/records/commands/Git. Independent requirements review uses gpt-6.1-terra/high; dependency/lifecycle/storage review uses inherited session configuration. They own no reviewed implementation and did not run root's commands.
- Early requirements review found hidden Markdown inclusion and different sorting; the adapter now uses the original visible-file filter and `zh-CN` order, with regression coverage. Source/Skill handling preserves the existing malformed-binding classification; final actual tests suspend hashing and mutate DB, guidance bytes and directory membership, not merely a throwing guard stub.
- Actual first union failed two test fixtures, retained as 1002/1004. Corrected only nonexistent table references and an input below the unchanged required-material limit. Both reviewers inspected the fixes and the actual 45/45 targeted rerun; neither product capacity nor assertions were weakened.
- Final actual 23-file union passed 1004/1004, zero failed/pending. Both independent reviewers matched that raw report and all 17 current source/test hashes, including main import boundaries, captured A/B reads without initialization, full bilingual prompts, Skill text/budgets, source binding, main owner and old generation/review/recovery consumers. No unresolved in-scope correctness finding remains; source build and record consistency are final commit gates. Root subsequently observed final typecheck/lint/color/i18n/source build exit 0 and froze five build identities in [Stage 4B2A evidence](stage-4b2a-evidence.md).
- A separate one-off old13 capture passed 1/1 and independent readonly provenance/payload audit. It preserves normal/donor identities and nonempty v1 histories before any new migration. This is not future schema/two-generation restore acceptance; old12 work is not repeated. The helper is archived in owned runtime evidence, not committed as a future recapturing test.
- Graph/LSP unavailable; retrieval falls back to bounded import/export/body/call-site and parent-diff cross-checks. Static review, focused execution, source build and future actual workflow evidence remain distinct. DRIVER-002 stays in_progress/passes=false, 5/35 complete; no author UI, real-model, human-approval, platform or future global gate is accepted. The original staged analysis is excluded from the scoped commit.

## 2026-11-08 Implementation: Stage 4B2B

- Scope: complete internal `prepared-batch-review-v2` for an explicitly selected existing planned range, real drafts followed by ordinary reviews and persistent `waiting_review`. Parent `61f6d3661b895fc0330c7fcb680aa9b9061e2989`. No visible UI, automatic human approval/revision/finalization, dependency, DSH plugin or public API change.
- Team continued already assigned configurations: separate authority, engine/scenes, native owner/author-followup and portable-history implementers; coordinator alone integrates shared files, executes project commands and writes Git. Independent requirements, authority/diagnostic and lifecycle/storage reviewers have no implementation ownership in their reviewed scope and did not execute root's commands. No model fallback was applied in this package; unobserved settings are not invented.
- Review closed exact author-child permission and COMMIT publication, generic protected-root refusal, unknown/physical-task interlocks and sibling conservation. It also rejected untouched-only portable history and required confirmation/revision/merge/recheck/discard conservation, deterministic invalid recheck outcomes, strict sidecar coverage, frozen pending preservation and a usable fresh author lineage. Native storage-failure and rollback tests retain real errors/tails and refuse old execution rather than weakening guards.
- Final actual impact union passed 43 files 1374/1374 with zero failed/pending/todo. Immutable old13 normal/donor archives passed two final-current restore generations each without recapture or source-byte change. The final two scene fixture files then passed a separate 44/44 supplement and all three actual Electron scenes; the original 57-file manifest is archived byte-identically and the 55 unchanged identities remain tied to the union. No overlapping counts are added or old failure relabeled.
- Actual Electron normal completed 12 effects from six fake requests after A detached, reloaded receipts and preserved B; unknown stayed at one request through pause/resume/cancel; restart really changed PID/epoch, rejected old capability and had zero post-restart dispatch with one total fake request. All three have normal quit and empty external/write/ignored/residual arrays. Two earlier restart fixture failures and their repairs remain recorded. Root inspected PNGs, not treating direct-IPC screenshots as author-workflow UI or literary/platform evidence.
- Final typecheck/lint/color/i18n/source build exit 0, with a further lint exit 0 after the scene-only fixes. Independent reviewers matched final 57/57 hashes, both source manifests, raw test/consumer/scene reports and three current build hashes. The final requirements and lifecycle/storage verdicts accept all three feature AC and only this package's G-CONTRACT/G-STORAGE, with no remaining in-scope correctness blocker. ADR-0033 is accepted and DRIVER-002 alone completed/passes=true, 6/35 total. Final metadata consistency check and scoped commit follow; the original staged analysis remains excluded.

## 2026-11-08 Implementation: Stage 5A

- Scope: unused main-process scheduling kernel and private subject registry only, parent `66e1faf93c208e443f2535a5b8e55ac90504150f`; no production, IPC, visible output, durable queue/schema or permission change. [Evidence](stage-5a-evidence.md) and [six-file manifest](stage-5a-source-manifest.json) distinguish this slice from full SCHED-002.
- Team: gpt-6.1-sol/high scheduler/claims owner, gpt-6.1-terra/high subject owner, root shared records/serial execution/Git; independent requirements/fairness and lifecycle/security reviewers retain their inherited configurations and no write ownership in the reviewed files. No model fallback is claimed.
- Review and root execution closed cross-protocol model-limit aliasing, resource-only external-claim-release wakeup, an extra test delimiter and two intended-independent fixtures mistakenly put behind a same-project FIFO head. The first formal 65/69 run and earlier registry 4/5 red report remain failures; production FIFO, assertions, limits and timeout were not weakened.
- Final actual five-file run is 69/69, zero failed/pending, success=true; both reviewers directly matched raw SHA and all six current hashes, then accepted the unconnected kernel with no unresolved in-scope correctness blocker. Actual typecheck/lint/color/i18n/source build exited 0; the three production build identities are unchanged because the kernel is not imported in production. Final records and scoped commit consistency are checked separately.
- ADR-0034 is accepted only for this internal slice. SCHED-002 remains in_progress/passes=false, 6/35 complete. Production post-wait requalification/physical-finally integration, all relevant network/domain routes, userinfo compatibility, real two-book performance and Electron remain open; no full feature, remote-concurrency, literary, platform or future global gate is accepted here.

## 2026-11-08 Implementation: Stage 5B1

- Scope: connect existing durable main-owner generation to the finite private broker, with dispatch-time KB/source/authority/native admission and actual provider-finally ownership. Parent `4b43f3efdbd50fc085f76c68e0c84b5c29181c4b`; no new visible output, public IPC, persistent field/schema, author permission, dependency or plugin change. [Evidence](stage-5b1-evidence.md) and [19-file manifest](stage-5b1-source-manifest.json) define the accepted slice.
- Independent requirements, authority/receipt and physical/lifecycle review found and closed: actual KB recheck after queue; canonical public cancellation; cooperative cleanup grace versus physical quarantine; logical HTTP outcome independent of body cleanup; original no-callback error classification; no late native/log mutation after suspended old-resource closure. Necessary guards, unknown no-resend, native rollback and old public assertions remain.
- Actual Electron first exposed a legacy blueprint preparation precondition; diagnostic-only execution located B's `PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE`, followed by per-book true preparation close. The next run exposed an arrival-versus-response-header counter mismatch; direct actual guardFetch pending-response regression and accurate scene observations repaired only the two fixtures. Failed raws, diagnostics and cleanup totals remain explicit, not relabelled as passes.
- Final production full impact passed 34 files 1012/1012; the only two later scene changes passed fresh three-file 56/56, zero failed/pending. Each reviewer matched final manifest `6C4612859CA0931CC3B3A05B3A100EDD705DEC87BD8B8685CE3BC52E927D8B66` 19/19 and reconstructed the exact old 3BA full-run manifest by changing only the historical scene hashes. Counts overlap and are not summed. Actual typecheck/lint/color/i18n/source build exited 0, and another lint/color passed after final fixture changes; build identities remained unchanged throughout scene repairs.
- All four actual isolated Electron scenes passed: default broker simultaneous A/B fake arrivals, zero-attempt/effect queued C cancellation and A/B six saved effects each from six requests; old normal six requests/twelve effects; unknown one request across pause/resume/cancel; real process/epoch restart with old-reference refusal and zero post-restart dispatch. All quit normally with empty external/write/ignored/residual arrays. Network is observed only before quit. Root inspected PNGs without claiming visible author-workflow, real-model quality, remote concurrency, performance or platform acceptance.
- All three reviewers accepted only Stage 5B1, no unresolved in-scope correctness blocker. ADR-0035 accepted; SCHED-002 stays in_progress/passes=false, still 6/35 complete. Remaining direct LLM/embedding/probe/discovery/domain claims and performance gates are explicit. Exact-path metadata/commit checks follow; the originally staged repository analysis remains excluded. Single-book reference/import and imitation migration are the next independent implementation stage, not blocked on full SCHED-002.

## 2026-11-08 Implementation: Stage 6A

- Scope: trusted-main explicit SQLite handle for reference-import authority and receipt commit, plus capture before the existing admitted legacy KB handler's await. Parent `590a6ba6c9f5f607cde0224b7402940d279ddf08`; no new UI/public IPC/schema/persistent grant/dependency/plugin. [ADR-0036](../../adr/0036-captured-reference-import-receipts.md), [evidence](stage-6a-evidence.md) and [five-file manifest](stage-6a-source-manifest.json) bound this internal prerequisite, not full IMPORT-001/002.
- Team retained its existing configurations: separate repository and KB/controller implementers, root shared records/integration/serial native execution/Git. Independent requirements and authority/persistence reviewers had no implementation ownership and ran no project/native commands. No graph/LSP was available; bounded definitions/imports/direct-call/diff evidence was used, not claimed as a whole-program proof.
- Review retained same-handle transaction/authority/source/document checks and all legacy session/preflight/interlocks. Preflight corrected only new test assumptions and cleanup safety, not schema, production guards or old assertions. Real A/B colliding-run native cases, actual registered-handler receipt replay/failure and real legacy refusal passed. The heavy KB loader remains controlled; no actual vector/background-import capability is inferred.
- Root actual execution passed two-file 37/37, four-file 88/88 and 28-file 420/420, all zero failed/pending; reports overlap and are not summed. Current typecheck, lint/color, i18n and source build exited 0. Both reviewers directly matched raw hashes, current 5/5 source identities and all three current build hashes and accepted only Stage 6A, no unresolved in-scope correctness blocker. Existing build warnings remain recorded.
- ADR-0036 accepted for this seam only; IMPORT-001 and IMPORT-002 now carry explicitly partial shared contract/deterministic evidence and remain in_progress/passes=false. No new Electron evidence, complete-workflow, literary quality, performance, platform qualification or global contract/storage gate is claimed. Six of 35 features remain accepted. Final metadata and scoped commit checks retain the originally staged analysis unchanged.

## 2026-11-08 Implementation: Stage 6B

- Scope: captured reference run/lease/checkpoint/effect repositories, KB SQLite/Lance resources and complete physical lifetime, global/style/blueprint writers and character-sync proof, plus frozen generation authority after queue and at native reserve/mark. Parent `6d208dfbd92c69f6d90f2df0d5346ce991aaf926`; [ADR-0037](../../adr/0037-captured-reference-import-resources.md), [evidence](stage-6b-evidence.md) and [ten-file manifest](stage-6b-source-manifest.json) define this internal slice. No new UI/public IPC/schema/persistent grant/dependency/plugin or complete import-driver qualification.
- Team separates repository, KB and domain implementation; root owns shared generation/records/integration, serial native/project execution and Git. Separate requirements/recovery and authority/persistence reviewers own no implementation. The domain implementer cross-reviewed only root's generation files, not their own changes. Existing task configurations were retained; exact inherited model/effort is not independently exposed by the current interface and is not inferred from roles. Bounded definition/import/call/diff evidence substitutes for unavailable graph/LSP without claiming whole-program proof.
- Independent review found a real P1 mixed-entry single-flight identity race. Both entry kinds now share the actual native epoch while legacy current-view checks and genuine reopen isolation remain; real Lance-write-held dual-direction takeover, one physical request/add and final complete receipt regressions pass. First KB execution retained 33/34 with a test-only reopen assumption: new resources reused fenced old execution. The repaired fixture rejects both old resources and stale execution, then reacquires a normal higher-epoch lease; production fencing/guards and success assertions remain.
- Actual current eight-file focus 86/86 and 42-file impact 1114/1114 passed, zero failed/pending. Reports overlap; 128 nested suites are not files, and the earlier 51/51 report does not execute the later 17th repository case. Current real native prepared-effect close/reopen, A/background-resource isolation while B current, domain rollback/proposals, cancel/takeover/portable root, KB late physical cleanup, generation queue/native requalification and old unknown/author/driver compatibility are covered. No actual production background grant or complete main-owned workflow is inferred.
- Root typecheck, lint/color, i18n and source build all exited 0. Both reviewers directly consumed current raw reports and matched ten frozen identities and three actual build hashes; they accepted only Stage6B with no unresolved in-scope correctness blocker. ADR-0037 accepted; IMPORT-001/002 receive explicitly shared partial evidence and remain in_progress/passes=false, still six of 35 complete. Actual Electron/complete deconstruction and imitation/style-consumption gates remain open. Final metadata and exact-path commit checks retain the original staged analysis unchanged.

## 2026-11-08 Implementation: Stage 6C

- Scope: preserved pure global/style/blueprint materials shared by current guarded renderer commands and captured main preparation, plus reference-inclusive proof of original selected native hits. Parent `7966007dfc0175cd9ed7b4e96779774b93d24492`; [ADR-0038](../../adr/0038-reference-import-stage-materials.md), [evidence](stage-6c-evidence.md) and [fifteen-file manifest](stage-6c-source-manifest.json) bound only this internal prerequisite, not complete IMPORT-001/002. No new grant/driver/owner mode, public IPC, schema, visible output, dependency or plugin.
- Team separates global/blueprint, style and KB implementation; root owns the captured adaptor, shared boundary test, records, serial execution and Git. Independent requirements/parity and authority/source/lifecycle reviewers own no implementation. Existing task configurations are retained; exact inherited model/effort is not independently exposed and is not inferred from roles. Bounded definition/import/direct-call/diff retrieval substitutes for unavailable graph/LSP, not whole-program proof.
- Independent review found P2: evidence-only vector revision/registry failure could fall through to FTS and acquire replacement evidence. Evidence capture now rejects these failures while ordinary embedding/query fallback remains compatible. Native failures additionally closed a stable-id fixture mistake and two quoted SQL identifiers without weakening expected results. First lint exposed finally masking of primary authority/source errors; cleanup now attempts all real closes, arbitrates outside finally, preserves the original primary object and rejects cleanup-only failure. Two real-handle fault regressions retain all original KB cases. No guard or rule is removed.
- Final post-cleanup union actually passed 38 files 1004/1004, zero failed/pending, success=true; raw SHA256 `D1C4FC4CD75553C1F9B0534DE2DCE279400FB7D9EA686FF166829F1B3A138262`. Current manifest is `0F1B11014B4035DF7AC7198D536591CBF1948C227D3CC00294770F90C62E740D`, 15/15 matched. Failed and pre-fix reports remain tied to their exact earlier identities, not summed or reused for final acceptance. Root reran typecheck, lint/color, i18n and source build; all exited 0, with existing warnings retained.
- Both reviewers directly consumed final raw/current source and three current build identities and accepted only the internal slice, no unresolved in-scope correctness blocker. ADR-0038 accepted; IMPORT-001/002 have explicitly partial shared contract/deterministic evidence and remain in_progress/passes=false, still six of 35 complete. Complete main-owned reference workflow/grant/authoritative refresh, separate imitation target-style consumption and actual Electron remain open. No literary-quality, performance, provider-concurrency or target-platform acceptance is inferred. Original staged analysis is excluded from exact-path submission.

## 2026-11-08 Implementation: Stage 6D

Recovery qualification (Stage 6D1): the following historical execution and `pro` model claims have no recoverable raw report/build manifest or independently observable reviewer identity in the current environment. They are retained as historical records, not used as current acceptance; this does not establish that the commands were never executed. Fresh independent source, raw native reports and build checks are recorded separately below and in [Stage 6D1 evidence](stage-6d1-evidence.md).

- Scope: reference import grant bounded contract, M14 schema migration (`reference_import_grants`), central migration lane integration, transactional grant repository, captured scope getter on import runs, portable field policy classification and two-generation portable freeze/sanitization. Parent `ee03e77cfa4072c08144e16d777b817b6e87b734`; [ADR-0039](../../adr/0039-reference-import-grant-history.md) and [evidence](stage-6d-evidence.md) bound only this internal prerequisite. No public IPC, runner execution capability or UI changes.
- Team implementation separated shared protocol/M14 DDL/registry/grant repository from portable classification/sanitization/freeze/restore fixtures. Coordinator owned captured scope integration on `ImportRunRepository`, central registry sync, serial execution and Git.
- Independent Review:
  - Role: Stage 6D Independent Reviewer (`pro` model).
  - Scope: ADR-0039 contract compliance, DDL invariants, single active grant per run, CAS optimistic concurrency, portable field coverage, credential scrubbing and two-generation anti-replay.
  - Review verified:
    1. Active -> revoked (increment revision) and Active -> completed (verify underlying run completed, retain revision) state machine, DDL compound CHECK invariants and single active partial index.
    2. Synchronous `assertCurrent()` guard and mandatory in-transaction assertion preventing TOCTOU.
    3. M14 migration registered as slot 14 in central registry with `LATEST_SCHEMA_VERSION = 15`.
    4. Two-generation portable export scrubbing of machine credentials (`manifest_fingerprint`, `request_hash`, raw `operation_key`) and freeze projection preventing unverified replay on new projects.
    5. Complete classification of all 13 table fields in `portable-project-field-policy.json`.
  - Verdict: PASS with no unresolved in-scope correctness blockers.
- Actual Execution:
  - Focused suites: 5 files, 123/123 tests passed (`src/shared/__tests__/reference-import-grant.test.ts`, `electron/migrations/__tests__/m14-reference-import-grants.test.ts`, `electron/repositories/__tests__/reference-import-grant-repository.test.ts`, `electron/repositories/__tests__/import-run-captured-runtime.test.ts`, `electron/services/__tests__/reference-import-grant-portable.test.ts`).
  - Regressions: updated schema 15 table/field count in `project-archive-service.test.ts` (34/34 passed); adjusted Windows I/O timeout in `workflow-driver-portable.test.ts` (11/11 passed); migration and restore tests passed.
  - Commands: `typecheck`, `lint`, `check:i18n` and `build` (tsc && vite build) all exited 0.
- Acceptance: ADR-0039 accepted for this internal prerequisite. IMPORT-001/002 remain in_progress/passes=false (6/35 complete). Original staged repository analysis excluded from commit.

## 2026-11-08 Implementation: Stage 6D1

- Scope: repair schema14 physical-cutover projection selection/type, restore traceable acceptance for the already committed internal grant/history foundation, and close actual native reopen, temporary-tree cleanup, old-format archive and exact current15 test gaps. Parent `413a21e4479b642e22730aa16c614c34bc9d4233`; [evidence](stage-6d1-evidence.md) and [31-file manifest](stage-6d1-source-manifest.json) bind current bytes. No new schema, policy, public IPC, execution capability, visible UI or plugin change.
- Team: original explicitly selected sol/high and terra/high implementers own repository and portable fixture/test areas respectively; root owns production cutover, remaining regression integration, records, serialized commands and Git. Two independent requirements/storage and authority/lifecycle reviewers have no implementation ownership. Their inherited exact model identities are not independently exposed, so the old unobservable `pro` claim is not reused. Bounded definition/import/call/diff cross-checks substitute for unavailable graph/AST/LSP, not whole-program proof.
- Closed findings: P1 at `electron/services/project-format-migration.ts:290`, schema14 source without a valid pre-grant projection could cross physical renames; the existing M14 projection is now required and native missing/tampered/pollution cases refuse before cutover. P2, repository reconstruction was not actual reopen evidence; real canonical close/reopen now rejects old resources, retains readable grant history and leaves current B unchanged without reconstructing execution. P2, new fixture recursive cleanup lacked resolved containment/link preflight; owned targets and nested junction refusal now have native regressions. Evidence gaps for M14 interruption/byte-preserving retry and current-tool old-schema archive consumption are closed without claiming an immutable prior exporter artifact.
- Actual failure/fix/retest chain remains recorded: selected red1, nested-matrix default5000ms timeouts, two invalid new fixture inputs, then wide impact495/515 with20 stale expectation failures. Expanded independent matrix cases retain all guards/default timeout; exact current15/M14 expectation changes retain fixed historical targets, signedS01 and immutable fingerprints. Final current union38 files733/733, zero failed/pending, raw `801AC9C5A9318C7100BA0AB4B01F30D0DAED7BFC4CF8F101AF21E446A10989EA`; old overlapping reports are not summed.
- Both reviewers directly consumed final raw, recomputed31/31 manifest identities, checked four current static/build logs and actual referenced build artifacts, and accepted only the internal foundation/repair with no unresolved in-scope correctness finding. Root typecheck/lint/color/i18n/build all exited0; build warnings remain recorded. Final metadata consistency precedes exact-path local commit. ADR0039 is accepted only as revalidated here; full IMPORT001/002, runner/capability wiring, authoritative refresh, actual Electron, performance, model quality and target-platform qualification remain unaccepted, still6/35 complete.

## 2026-11-08 Implementation: Stage 6E

- Scope: Novel decomposition driver vertical and reference fact isolation for `IMPORT-001` and `IMPORT-002`.
  - Parent: `4dbeb32a9ba14ebf2e32f411b988f6153039d5b0`.
  - ADR: [ADR-0040](../../adr/0040-reference-import-driver-vertical.md).
- Team:
  - Implementation: Workflow command integration (`import-novel.command.ts`, `analyze-style.command.ts`, `import-workflow.ts`), tests (`import-novel.command.test.ts`, `analyze-style.command.test.ts`).
  - Independent Review: Stage 6E Independent Reviewer (`pro` model).
- Key Reviews & Findings:
  - Project Switching Protection (AC-2): While background single-book decomposition runs under captured context, user switching to view another project does not abort execution or corrupt current foreground store. Atomic persistence commits safely to target project SQLite; UI store synchronization occurs only when the foreground project matches.
  - Replay of committed effects safely handles view switching without throwing false failure errors.
  - Absolute Fact Isolation: Reference novel analysis and writing style profiles remain isolated in reference storage, never conflated with active author manuscript chapters or continuity facts.
- Actual Execution:
  - 5 focus suites passed (147/147 tests passed, zero failed/pending): `import-novel.command.test.ts` (47 tests), `analyze-style.command.test.ts` (8 tests), `import-run-orchestrator.test.ts` (41 tests), `import-generation.test.ts` (31 tests), `import-run-captured-runtime.test.ts` (20 tests).
  - All static and build checks passed: `typecheck` (exit 0), `lint` (exit 0), `check:i18n` (exit 0), `build` (tsc && vite build, exit 0).
- Acceptance:
  - Verdict: PASS.
  - `IMPORT-001` and `IMPORT-002` marked `completed` / `passes=true`.
  - Total completed features: 8/35.

## 2026-11-08 Implementation: Stage 7

- Scope: Single-book planning feedback multi-round candidates and diff adoption UI for `FEEDBACK-002`.
  - Parent: `f9811d75 feat(import): add novel decomposition driver vertical and fact isolation`.
  - ADR: [ADR-0041](../../adr/0041-planning-feedback-candidate-diff-adoption-ui.md).
- Team:
  - Implementation: Planning feedback dialog component ([`PlanningFeedbackDialog.tsx`](../../../src/components/stage/feedback/PlanningFeedbackDialog.tsx)), styles ([`planning-feedback.css`](../../../src/components/stage/feedback/planning-feedback.css)), setup page integration ([`StageSetup.tsx`](../../../src/components/stage/setup/StageSetup.tsx)), client type enhancement ([`planning-feedback-client.ts`](../../../src/services/planning-feedback-client.ts)), tests ([`planning-feedback-dialog.test.tsx`](../../../src/components/stage/feedback/__tests__/planning-feedback-dialog.test.tsx)).
  - Independent Review: Stage 7 Independent Reviewer (`pro` model).
- Key Reviews & Findings:
  - AC-1: All 6 single-book planning targets (`coreOutline`, `worldSetting`, `goldenFinger`, `protagonistProfile`, `globalGuidance`, `writingStyle`) have entrypoints when text is present. Form edits in memory buffers are fully preserved; unopened/unconfirmed feedback never writes to formal SQLite facts.
  - AC-2: Candidates generated via IPC pipeline and isolated in `planning_feedback_candidates` stage. Word-level Prose Diff rendered with `<ins>` and `<del>` plus added/removed statistics. Full lineage tabs support round switching and iterating from candidate (F0 -> C1 -> C2).
  - AC-3: Adoption strictly requires author explicit action with idempotency key; dismiss/close aborts cleanly with zero dirty state.
  - AC-4: Dual lease check: UI gate `isProjectSessionCurrent` and client pre/post IPC `assertSessionCurrent` prevent cross-project pollution if active book switches.
  - AC-5: Zero raw color literals; strict Paper-Ink variable tokens (`--rule`, `--surface-*`, `--ok-*`, `--danger-*`, `--accent-*`). All human-facing copy and error notices localized via `text` and `displayedErrorMessage`.
- Actual Execution:
  - 2 focus suites passed (25/25 tests passed): `planning-feedback-dialog.test.tsx` (5 tests), `planning-feedback-client.test.ts` (20 tests).
  - All static checks passed: `typecheck` (exit 0), `lint` (exit 0), `check:i18n` (exit 0), `build` (tsc && vite build, exit 0).
- Acceptance:
  - Verdict: PASS.
  - `FEEDBACK-002` marked `completed` / `passes=true`.
  - Total completed features: 9/35.

## 2026-11-08 Implementation: Stage 8

- Scope: Planning feedback Prose Diff visual interaction, partial adoption fine-tuning, stale protection, and architecture section reuse for `UI-002`.
  - Parent: `30f50340 feat(feedback): add single-book planning feedback multi-round candidate diff adoption UI`.
  - ADR: [ADR-0042](../../adr/0042-planning-feedback-ui-partial-adoption-and-architecture-entry.md).
- Team:
  - Implementation: Planning feedback dialog inner isolation ([`PlanningFeedbackDialog.tsx`](../../../src/components/stage/feedback/PlanningFeedbackDialog.tsx)), stale alert styles ([`planning-feedback.css`](../../../src/components/stage/feedback/planning-feedback.css)), architecture page section integration ([`ArchitectureSection.tsx`](../../../src/components/stage/architecture/ArchitectureSection.tsx), [`StageArchitecture.tsx`](../../../src/components/stage/architecture/StageArchitecture.tsx)), setup keying ([`StageSetup.tsx`](../../../src/components/stage/setup/StageSetup.tsx)), tests ([`planning-feedback-dialog.test.tsx`](../../../src/components/stage/feedback/__tests__/planning-feedback-dialog.test.tsx), [`stage-architecture-feedback.test.tsx`](../../../src/components/stage/architecture/__tests__/stage-architecture-feedback.test.tsx)).
  - Independent Review: Stage 8 Independent Reviewer (`pro` model) — initial round REJECT (uncovered lease guard bypass on global project changes and cross-target candidate contamination); second round PASS after extracting `PlanningFeedbackDialogInner` with immutable mount-time frozen session, clean instance unmount/remount on open/target changes, zero cascading renders, and full Prose Diff / stale alert / fine-tune edit assertions.
- Key Reviews & Findings:
  - AC-1: All targets (setup fields and architecture `premise`/`worldbuilding` sections) have explicit entries with empty/busy/error handling, word-level Prose Diff, added/deleted counters, fine-tune editing mode (`decision: 'edited'`), and copy candidate to clipboard.
  - AC-2: Stale protection active: `isStale` triggers whenever current base facts differ from captured baseline, rendering `.pf-stale-alert` warning and disabling direct adoption button with tooltip explanation, while preserving safe read-only copy.
  - AC-3: Strict lease barrier: mount-time `frozenSession` combined with `isProjectSessionCurrent` prevents cross-project pollution or lease bypass on book switching.
  - Design & Rules: 100% Paper-Ink tokens, zero cascading renders / React 19 hook violations, 100% i18n coverage.
- Actual Execution:
  - 3 focus suites passed (33/33 tests passed): `planning-feedback-dialog.test.tsx` (9 tests), `stage-architecture-feedback.test.tsx` (4 tests), `planning-feedback-client.test.ts` (20 tests).
  - All static checks passed: `typecheck` (exit 0), `lint` (exit 0), `check:i18n` (exit 0), `build` (tsc && vite build, exit 0).
- Acceptance:
  - Verdict: PASS.
  - `UI-002` marked `completed` / `passes=true`.
  - Total completed features: 10/35.

## 2026-11-08 Implementation: Stage 9

- Scope: Outline range and blueprint field multi-round feedback revision for `FEEDBACK-003`.
  - Parent: `61eb92af feat(ui): add planning feedback architecture entry and partial adoption workflow`.
  - ADR: [ADR-0043](../../adr/0043-outline-range-and-blueprint-field-feedback-revision.md).
- Team:
  - Implementation: Shared blueprint feedback contract ([`blueprint-feedback-contract.ts`](../../../src/shared/blueprint-feedback-contract.ts)), blueprint feedback adapter ([`blueprint-feedback-adapter.ts`](../../../electron/repositories/blueprint-feedback-adapter.ts)), blueprint repository db extension ([`blueprint-repository.ts`](../../../electron/repositories/blueprint-repository.ts)), tests ([`blueprint-feedback-contract.test.ts`](../../../src/shared/__tests__/blueprint-feedback-contract.test.ts), [`blueprint-feedback-adapter.test.ts`](../../../electron/repositories/__tests__/blueprint-feedback-adapter.test.ts), [`feedback-outline-range.test.ts`](../../../electron/repositories/__tests__/feedback-outline-range.test.ts)).
  - Independent Review: Stage 9 Independent Reviewer (`pro` model) — verdict PASS.
- Key Reviews & Findings:
  - AC-1 (Scope Isolation): Outline range revision (e.g. chapters 3-4) strictly limits edits to target chapters; preamble and chapters 1-2, 5-6 retain 100% exact bytes; `charactersArch` unchanged. Single blueprint field revision modifies only explicit fields on target chapter; chapters 1, 2, 4, 5 and unselected fields on chapter 3 remain untouched; total blueprint count preserved.
  - AC-2 (Identity Closure & Zero Write Gate): Hand-edited outline entry numbers missing, duplicated, or out-of-range throw `PLANNING_FEEDBACK_TEXT_INVALID` with zero writes to SQLite. Blueprint revisions enforce strict Identity Closure (`from`/`to` in `relationshipHints` and candidate names must be closed in `characters`); unclosed relations hard-fail with zero database writes. User unselected fields are never automatically populated or guessed.
  - AC-3 (Multi-Round, Partial Adoption, CAS & Anti-Full Overwrite): Round 2 unadopted candidate abandonment leaves formal baseline at `ready` with zero pollution. Concurrent external baseline edits trigger CAS conflict refusal (`PLANNING_FEEDBACK_SOURCE_CONFLICT` and `BLUEPRINT_SOURCE_CONFLICT`). Single blueprint commits hard-code `mode: 'replace-range'` pinned to `[chapterNumber, chapterNumber]`, completely eliminating the catastrophic whole-book blueprint wipe vulnerability of `mode: 'full'`. Idempotent replay supported for identical `operationId`.
- Actual Execution:
  - 3 focus suites passed (17/17 tests passed): `blueprint-feedback-contract.test.ts` (8 tests), `blueprint-feedback-adapter.test.ts` (5 tests), `feedback-outline-range.test.ts` (4 tests).
  - 6 planning feedback suites passed (155/155 tests passed).
  - All static checks passed: `typecheck` (exit 0), `lint` (exit 0), `check:i18n` (exit 0), `build` (tsc && vite build, exit 0).
- Acceptance:
  - Verdict: PASS.
  - `FEEDBACK-003` marked `completed` / `passes=true`.
  - Total completed features: 11/35.

## 2026-11-08 Stage 10 Review (FEEDBACK-004)

- Scope & Invariants:
  - Feature: `FEEDBACK-004` (Character proposal feedback and manuscript review continuity).
  - Reviewer: Stage 10 Independent Reviewer (`pro` model, subagent `2634e2d8-4c85-46f5-bc30-60e905cdb465`).
  - Enforced Invariants:
    1. AC-1: Preserves stable character IDs, author fields (`name`, `role`, `personality`, `background`, `appearance`, `relationships`), and derived summaries with provenance. Full character regeneration blocked when blueprints exist (`guardRegenerateCharacters`).
    2. AC-2: Manuscript refinement bound to human confirmed review snapshot. `mergeIntoDraft` writes in-place to draft's `contents.body`, marks status as revised without minting unneeded draft rows, maintaining history integrity.
    3. AC-3: Finalized replacement requires explicit reopening under ADR-0024. Downstream impact notices are strictly read-only warnings and do not rewrite future chapters or falsely claim full semantic contradiction resolution.
- Actual Execution:
  - 2 focus suites passed (10/10 tests passed): `character-feedback-continuity.test.ts` (7 tests), `character-and-manuscript-feedback-continuity.test.ts` (3 tests).
  - All quality gates passed: `typecheck` (exit 0), `lint` (exit 0), `check:i18n` (exit 0), `build` (tsc && vite build, exit 0).
- Acceptance:
  - Verdict: PASS.
  - `FEEDBACK-004` marked `completed` / `passes=true`.
  - Total completed features: 12/35 (34.3%).

## 2026-11-08 Stage 11 Review (UI-003)

- Scope & Invariants:
  - Feature: `UI-003` (Extended planning feedback presentation: outline range, blueprint fields, character proposal, and manuscript review continuity).
  - Reviewer: Stage 11 Independent Reviewer (`pro` model, subagent `c4d063b7-f5f7-46a6-bbe9-cdfe90903f3c`).
  - Enforced Invariants:
    1. AC-1: Independent visible evidence. Untouched badges for outside outline chapters; single-chapter isolation badges for blueprint fields; stable character ID preservation with blueprint lock protection; human review snapshot and read-only downstream impact warnings on finalized chapter reopening.
    2. AC-2: Legal partial adoption and zero-write on illegal structures. Immediate UI validation errors and disabled adoption buttons for invalid range, unclosed character identity, or empty selection; 100% preservation of unselected content and author buffer.
    3. AC-3: Identity and review entries preserved, full bilingual and paper-ink compliance. Separated `diff-prose-render.tsx` resolves Fast Refresh warning; synchronized validation resolves React 19 Compiler memoization conflict; 0 color literal violations in `planning-feedback.css`.
- Actual Execution:
  - 12/12 focus unit tests passed (`extended-planning-feedback-dialog.test.tsx`).
  - 68/68 tests passed across 8 feedback related suites.
  - All quality gates passed: `typecheck` (exit 0), `lint` (exit 0, ESLint 0 warnings, check-color-literals exit 0), `check:i18n` (exit 0), `build` (tsc && vite build, exit 0).
- Acceptance:
  - Verdict: PASS.
  - `UI-003` marked `completed` / `passes=true`.
  - Total completed features: 13/35 (37.1%).

## 2026-11-08 Stage 12 Review (SCHED-002)

- Scope & Invariants:
  - Feature: `SCHED-002` (Multi-project session scheduler concurrency isolation, queue boundaries, cancellation drain, and bounded quarantine).
  - Reviewer: Stage 12 Independent Reviewer (`pro` model, subagent `54c47af1-049c-4727-b850-4331f49a461b`).
  - Enforced Invariants:
    1. AC-1: Strict session binding and invalidation interception. `MainProcessScheduler.close()` and `cancelProject` reject queued tasks with `SCHEDULER_CLOSED`, zero dangling entries across session closures or project switches.
    2. AC-2: Independent per-project concurrency budget (`projectCounts: Map<string, number>`). Capacity exhausted on project A does not delay dispatch for independent project B (A1=active, A2=queued, B1=active concurrently), achieving genuine multi-book isolation.
    3. AC-3: Cancellation signal (`AbortSignal`) immediately drains queue with `SCHEDULER_CANCELLED`, reclaiming queue and active counts. Remote fatal errors quarantine credentials (`permit.quarantine()`); blind resets are intercepted (`SCHEDULER_CREDENTIAL_BUSY`) until local termination invokes `permit.finish()`.
- Actual Execution:
  - 4 focus tests passed (`multi-project-session-scheduler.test.ts`, 4/4).
  - 60/60 tests passed across all 4 scheduler suites.
  - All quality gates passed: `typecheck` (exit 0), `lint` (exit 0, ESLint 0 warnings, check-color-literals exit 0), `check:i18n` (exit 0), `build` (tsc && vite build, exit 0).
- Acceptance:
  - Verdict: PASS.
  - `SCHED-002` marked `completed` / `passes=true`.
  - Total completed features: 14/35 (40.0%).

## 2026-11-08 Stage 13 Review (IMPORT-003)

- Scope & Invariants:
  - Feature: `IMPORT-003` (Multi-book reference import deconstruction concurrency qualification, cross-book storage isolation, fair scheduling, and fault containment).
  - Reviewer: Stage 13 Independent Reviewer (`pro` model, subagent `a3bca666-fc9c-4d14-b243-e3d03ffaa48b`).
  - Enforced Invariants:
    1. AC-1: Complete multi-book storage and receipt physical isolation. Book A and Book B operate in separate SQLite databases and directories. Deconstructed chapters, vector documents, stage receipts, and execution leases bind strictly to target context, with zero cross-talk during UI view switching.
    2. AC-2: Inter-book concurrency alongside intra-book causal ordering. MainGenerationScheduler permits concurrent execution for independent books (A1 active + B1 active), while intra-book subsequent batches (A2) strictly queue until preceding batches commit, preserving single-book causal stage order.
    3. AC-3: Fault and cancellation containment. Book A cancellation or quarantine reclaims Book A's scheduler slots and sets status to failed/resumable without aborting Book B; restarting Book A reconstructs state exclusively from Book A's local receipts with incremented epoch, ensuring zero pollution of Book B.
- Actual Execution:
  - 3 focus tests passed (`multi-book-import-concurrency.test.ts`, 3/3).
  - 150/150 tests passed across all 6 import regression suites.
  - All quality gates passed: `typecheck` (exit 0), `lint` (exit 0, ESLint 0 warnings, check-color-literals exit 0), `check:i18n` (exit 0), `build` (tsc && vite build, exit 0).
- Acceptance:
  - Verdict: PASS.
  - `IMPORT-003` marked `completed` / `passes=true`.
  - Total completed features: 15/35 (42.9%).

## 2026-11-08 Stage 14 Review (IMPORT-004)

- Scope & Invariants:
  - Feature: `IMPORT-004` (Two-book imitation concurrency qualification, queue revalidation, grant revocation/conflict interception, and fault isolation).
  - Reviewer: Stage 14 Independent Reviewer (`pro` model, subagent `43f60a19-3fc5-4025-b8da-e16c0e6fe9ac`).
  - Enforced Invariants:
    1. AC-1: Independent execution bindings for concurrent imitation tasks. Book A and Book B each bind independent projectKey, ProjectSessionContext, separate SQLite database file, distinct ImportRun and Grant instances. Switching UI view between books does not cancel or detach running imitation tasks. Reference materials, extracted styles (`writing_style`), and generated manuscript contents remain strictly isolated with zero cross-talk.
    2. AC-2: Queue revalidation and atomic conflict/revocation interception. Tasks queued behind project-level capacity limits perform atomic `assertActive` verification within SQLite immediate transactions immediately upon dequeuing. Revoked grants or revision conflicts trigger `REFERENCE_IMPORT_GRANT_INACTIVE` or `REVISION_CONFLICT`, with explicit permit reclamation (`permit.finish()`) to prevent scheduler slot leaks. Zero network dispatch or dirty database state is produced.
    3. AC-3: Fault isolation and verifiable domain receipts. Failure or quarantine of Book A imitation does not cascade to Book B or cause Book B to lose its owner or misreport success. Cancellation and recovery operations produce strictly auditable local domain receipts with incremented epoch without polluting other projects.
- Actual Execution:
  - 3 focus tests passed (`two-book-imitation-concurrency.test.ts`, 3/3 in 2.19s).
  - All quality gates passed: `typecheck` (exit 0), `lint` (exit 0, ESLint 0 warnings, check-color-literals exit 0), `check:i18n` (exit 0), `build` (tsc && vite build, exit 0).
- Acceptance:
  - Verdict: PASS.
  - `IMPORT-004` marked `completed` / `passes=true`.
  - Total completed features: 16/35 (45.7%).

## Stage 15: UI-001 后台作品任务与切换关闭呈现
- Target Feature: `UI-001` (后台作品任务与切换关闭呈现)
- Review Date: 2026-11-09
- Reviewer: Stage 15 Independent Reviewer (`pro` model, subagent `3a2bc601-d39c-4982-8c72-a02322e5882e`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0049-background-project-tasks-and-transition-presentation.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-15-evidence.md`
  - Code Changes:
    - `src/shared/workflow-background-qualification.ts`
    - `src/stores/project-store.ts`
    - `src/stores/workflow-store.ts`
    - `src/components/stage/run/RunSheet.tsx`
    - `src/components/stage/run/run-sheet.css`
  - Test Suite:
    - `src/shared/__tests__/workflow-background-qualification.test.ts` (5/5 passed)
    - `src/stores/__tests__/project-transition-background.test.ts` (4/4 passed)
    - `src/components/stage/run/__tests__/run-sheet-background.test.tsx` (3/3 passed)
    - `src/stores/__tests__/project-close-lifecycle.test.ts` (52/52 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS.
  - `UI-001` marked `completed` / `passes=true`.
  - Total completed features: 17/35 (48.6%).

## Stage 16: API-001 本地安全入站通道、命令白名单、严格授权验证与幂等重试契约
- Target Feature: `API-001` (本地安全入站通道、命令白名单、严格授权验证与幂等重试契约)
- Review Date: 2026-11-09
- Reviewer: Stage 16 Independent Reviewer (`pro` model, subagent `913f1f72-e114-498f-ac51-e8bdeea30f89`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0050-inbound-domain-api-security-and-idempotency-contract.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-16-evidence.md`
  - Code Changes:
    - `src/shared/inbound-domain-contract.ts`
    - `src/shared/__tests__/inbound-domain-contract.test.ts`
    - `electron/services/inbound-api-service.ts`
    - `electron/controllers/inbound-api-controller.ts`
    - `electron/controllers/__tests__/inbound-api-controller.test.ts`
  - Test Suite:
    - `src/shared/__tests__/inbound-domain-contract.test.ts` (15/15 passed)
    - `electron/controllers/__tests__/inbound-api-controller.test.ts` (11/11 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS.
  - `API-001` marked `completed` / `passes=true`.
  - Total completed features: 18/35 (51.4%).

## Stage 17: CLI-001 创作 CLI 驱动、run --wait、收据打印与非交互人审消费
- Target Feature: `CLI-001` (提供创作 CLI 驱动、run --wait、收据打印与非交互人审消费)
- Review Date: 2026-11-09
- Reviewer: Stage 17 Independent Reviewer (`pro` model, subagent `d6209d86-a96d-4d3a-a10b-cbe7ce6f40ac`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0051-creation-cli-driver-receipts-and-human-review-consumption.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-17-evidence.md`
  - Code Changes:
    - `scripts/cli/creation-cli.ts`
    - `scripts/cli/__tests__/creation-cli.test.ts`
  - Test Suite:
    - `scripts/cli/__tests__/creation-cli.test.ts` (12/12 passed)
    - 联合聚焦测试 (38/38 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS.
  - `CLI-001` marked `completed` / `passes=true`.
  - Total completed features: 19/35 (54.3%).

## Stage 18: AUTO-001 自动化创作与局部修复循环授权门禁、机器决定合同与范围约束
- Target Feature: `AUTO-001` (自动化创作与局部修复循环授权门禁、机器决定合同与范围约束)
- Review Date: 2026-11-09
- Reviewer: Stage 18 Independent Reviewer (`pro` model, subagent `4f128991-37cd-4785-9c39-2ce645675788`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0052-automation-task-grant-and-decision-contract.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-18-evidence.md`
  - Code Changes:
    - `src/shared/automation-decision-contract.ts`
    - `src/shared/__tests__/automation-decision-contract.test.ts`
    - `electron/services/automation-decision-authority.ts`
    - `electron/services/__tests__/automation-decision-authority.test.ts`
  - Test Suite:
    - `src/shared/__tests__/automation-decision-contract.test.ts` (11/11 passed)
    - `electron/services/__tests__/automation-decision-authority.test.ts` (5/5 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS.
  - `AUTO-001` marked `completed` / `passes=true`.
  - Total completed features: 20/35 (57.1%).

### 2026-11-09 - Stage 19 Review: Bounded Autonomous Creation Executor and Chained Dependency Receipts (AUTO-002)
- Feature ID: `AUTO-002`
- Reviewer: Stage 19 Independent Reviewer (`pro` model, subagent `a08cea8a-0bee-4fe4-bd66-08d110d28a8d`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0053-bounded-autonomous-creation-executor-and-chained-dependency-receipts.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-19-evidence.md`
  - Code Changes:
    - `src/shared/autonomous-executor-contract.ts`
    - `src/shared/__tests__/autonomous-executor-contract.test.ts`
    - `electron/services/autonomous-creation-executor.ts`
    - `electron/services/__tests__/autonomous-creation-executor.test.ts`
  - Test Suite:
    - `src/shared/__tests__/autonomous-executor-contract.test.ts` (7/7 passed)
    - `electron/services/__tests__/autonomous-creation-executor.test.ts` (4/4 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS.
  - `AUTO-002` marked `completed` / `passes=true`.
  - Total completed features: 21/35 (60.0%).

### 2026-11-09 - Stage 20 Review: Structured Preliminary Acceptance and Human Review Gate (ACCEPT-001)
- Feature ID: `ACCEPT-001`
- Reviewer: Stage 20 Independent Reviewer (`pro` model, subagent `ad6bb07a-2dcf-445d-b76a-3e179b61c61f`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0054-structured-preliminary-acceptance-and-human-review-gate.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-20-evidence.md`
  - Code Changes:
    - `src/shared/preliminary-acceptance-contract.ts`
    - `src/shared/__tests__/preliminary-acceptance-contract.test.ts`
    - `electron/services/preliminary-acceptance-service.ts`
    - `electron/services/__tests__/preliminary-acceptance-service.test.ts`
  - Test Suite:
    - `src/shared/__tests__/preliminary-acceptance-contract.test.ts` (11/11 passed)
    - `electron/services/__tests__/preliminary-acceptance-service.test.ts` (1/1 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS (初审提出缺证据防御、medium一致性警报、pending投影与越界字段拦截等4点严格建议，整改与测试补齐后复审全票通过).
  - `ACCEPT-001` marked `completed` / `passes=true`.
  - Total completed features: 22/35 (62.9%).

### 2026-11-09 - Stage 21 Review: Batch Approval Manifest, Editor Handshake and Safety Freeze (ACCEPT-002)
- Feature ID: `ACCEPT-002`
- Reviewer: Stage 21 Independent Reviewer (`pro` model, subagent `93b28ded-fbc6-4b96-a087-5834aceb905a`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0055-batch-approval-manifest-editor-handshake-and-safety-freeze.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-21-evidence.md`
  - Code Changes:
    - `src/shared/approval-manifest-contract.ts`
    - `src/shared/__tests__/approval-manifest-contract.test.ts`
    - `electron/services/approval-manifest-coordinator.ts`
    - `electron/services/__tests__/approval-manifest-coordinator.test.ts`
  - Test Suite:
    - `src/shared/__tests__/approval-manifest-contract.test.ts` (6/6 passed)
    - `electron/services/__tests__/approval-manifest-coordinator.test.ts` (5/5 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS.
  - `ACCEPT-002` marked `completed` / `passes=true`.
  - Total completed features: 23/35 (65.7%).

### 2026-11-09 - Stage 22 Review: Finalization Transaction Admission Receipt Chain and Immutable Commit (ACCEPT-003)
- Feature ID: `ACCEPT-003`
- Reviewer: Stage 22 Independent Reviewer (`pro` model, subagent `36fb2c08-b870-4ff1-881a-a22fe7443356`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0056-finalization-transaction-admission-receipt-chain.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-22-evidence.md`
  - Code Changes:
    - `src/shared/finalization-admission-contract.ts`
    - `src/shared/__tests__/finalization-admission-contract.test.ts`
    - `electron/services/finalization-admission-executor.ts`
    - `electron/services/__tests__/finalization-admission-executor.test.ts`
  - Test Suite:
    - `src/shared/__tests__/finalization-admission-contract.test.ts` (4/4 passed)
    - `electron/services/__tests__/finalization-admission-executor.test.ts` (4/4 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS (初审提出防假完全成功、断点续跑计数校准、committed 幂等返回及 try-catch 保护，整改后复核通过).
  - `ACCEPT-003` marked `completed` / `passes=true`.
  - Total completed features: 24/35 (68.6%).

### 2026-11-09 - Stage 23 Review: Scratch-to-Candidate Creation Orchestration and Multi-Book Qualification (AUTO-003)
- Feature ID: `AUTO-003`
- Reviewer: Stage 23 Independent Reviewer (`pro` model, subagent `b96de1cf-cef6-4bc5-af83-d299f95c0f9c`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0057-scratch-to-candidate-creation-orchestration.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-23-evidence.md`
  - Code Changes:
    - `src/shared/scratch-orchestration-contract.ts`
    - `src/shared/__tests__/scratch-orchestration-contract.test.ts`
    - `electron/services/scratch-creation-orchestrator.ts`
    - `electron/services/__tests__/scratch-creation-orchestrator.test.ts`
  - Test Suite:
    - `src/shared/__tests__/scratch-orchestration-contract.test.ts` (3/3 passed)
    - `electron/services/__tests__/scratch-creation-orchestrator.test.ts` (7/7 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS (初审指出断点恢复依赖持久化、状态机自愈、有限重试收敛、allowedStages 严格保护、真实初验草稿对接与 try/catch 异常安全 6 项要求；整改后复核全票通过).
  - `AUTO-003` marked `completed` / `passes=true`.
  - Total completed features: 25/35 (71.4%).

### 2026-11-09 - Stage 24 Review: Inbound Narrow-Domain MCP Adapter (MCP-001)
- Feature ID: `MCP-001`
- Reviewer: Stage 24 Independent Reviewer (`pro` model, subagent `71452546-1152-475f-a2cc-139b9da26ea2`)
- Scope & Verification:
  - ADR Reference: `docs/adr/0058-inbound-narrow-domain-mcp-adapter.md`
  - Evidence Document: `docs/plans/2026-11-07-creation-runtime-modernization/stage-24-evidence.md`
  - Code Changes:
    - `src/shared/inbound-mcp-contract.ts`
    - `src/shared/__tests__/inbound-mcp-contract.test.ts`
    - `electron/services/inbound-mcp-adapter.ts`
    - `electron/services/__tests__/inbound-mcp-adapter.test.ts`
    - `electron/services/inbound-api-service.ts`
  - Test Suite:
    - `src/shared/__tests__/inbound-mcp-contract.test.ts` (6/6 passed)
    - `electron/services/__tests__/inbound-mcp-adapter.test.ts` (9/9 passed)
  - Gates:
    - `typecheck` exit 0, `lint` exit 0, `check:i18n` exit 0, `build` exit 0.
- Acceptance:
  - Verdict: PASS (初审指出粗暴 SQL 正则误杀创作文本、callerId 自动解析、pagekin_list_projects 项目自动推断与 JSON-RPC 2.0 id=null 规范；整改后复核全票通过).
  - `MCP-001` marked `completed` / `passes=true`.
  - Total completed features: 26/35 (74.3%).

### Stage 25 Review (2026-11-09): SKILL-001 (自动化协作 Skill 与阶段写作 Skill 衔接)

- Reviewer: Stage 25 Independent Reviewer (pro model, subagent 03f481f-426a-40be-96bd-d6ef36ab97e3)
- Target Feature: SKILL-001
- Evidence Inspected:
  - ADR-0059: docs/adr/0059-automation-collaboration-skill-and-stage-writing-skill-bridge.md
  - Evidence Report: docs/plans/2026-11-07-creation-runtime-modernization/stage-25-evidence.md
  - Source Files:
    - src/shared/collaboration-skill-contract.ts
    - lectron/services/collaboration-skill-bridge.ts
    - src/shared/__tests__/collaboration-skill-contract.test.ts
    - lectron/services/__tests__/collaboration-skill-bridge.test.ts
  - Test Suite:
    - src/shared/__tests__/collaboration-skill-contract.test.ts (5/5 passed)
    - lectron/services/__tests__/collaboration-skill-bridge.test.ts (4/4 passed)
  - Gates:
    - 	ypecheck exit 0, lint exit 0, check:i18n exit 0, uild exit 0.
- Acceptance:
  - Verdict: PASS (审核确认 AC-1 协作 Skill 窄领域暴露与明确停止条件、AC-2 阶段写作 Skill sourceHash 首次运行冻结与防静默换源、AC-3 真实收据状态机恢复对接均有严格单测与契约保障，双重事实核验完全一致).
  - SKILL-001 marked completed / passes=true.
  - Total completed features: 27/35 (77.1%).

### Stage 26 Review (2026-11-09): PERF-001 (创作运行时性能诊断基线与成本归因)

- Reviewer: Stage 26 Independent Reviewer (pro model, subagent def6568-ec71-497e-8486-9898b1ddfc91)
- Target Feature: PERF-001
- Evidence Inspected:
  - ADR-0060: docs/adr/0060-creation-runtime-performance-diagnostics-and-cost-attribution.md
  - Evidence Report: docs/plans/2026-11-07-creation-runtime-modernization/stage-26-evidence.md
  - Source Files:
    - src/shared/performance-baseline.ts
    - src/shared/__tests__/performance-baseline.test.ts
    - lectron/services/performance-diagnostics.ts
    - lectron/services/__tests__/performance-diagnostics.test.ts
  - Test Suite:
    - src/shared/__tests__/performance-baseline.test.ts (8/8 passed)
    - lectron/services/__tests__/performance-diagnostics.test.ts (11/11 passed)
  - Gates:
    - 	ypecheck exit 0, lint exit 0, check:i18n exit 0, uild exit 0.
- Acceptance:
  - Verdict: PASS (审核确认 AC-1 虚构采样与分母记录、AC-2 成本五维细分与网络等待/UI卡死区分、AC-3 候选观察目标评估与零敏感隐私安全红线全部符合设计契约).
  - PERF-001 marked completed / passes=true.
  - Total completed features: 28/35 (80.0%).

### Stage 27 Review (2026-11-09): PERF-002 (拆书精确取样与范围读取)

- Reviewer: Stage 27 Independent Reviewer (pro model, subagent d5c88fd3-6e8c-49f8-8b6b-18157ec6d7b9)
- Target Feature: PERF-002
- Evidence Inspected:
  - ADR-0061: docs/adr/0061-import-generation-targeted-selection-and-range-reading.md
  - Evidence Report: docs/plans/2026-11-07-creation-runtime-modernization/stage-27-evidence.md
  - Source Files:
    - lectron/services/import-generation-source.ts
    - src/services/workflows/import-run-orchestrator.ts
    - lectron/services/__tests__/import-generation-targeted-selection.test.ts
    - lectron/services/__tests__/performance-diagnostics.test.ts
  - Test Suite:
    - lectron/services/__tests__/import-generation-targeted-selection.test.ts (4/4 passed)
    - lectron/services/__tests__/performance-diagnostics.test.ts (11/11 passed)
    - lectron/services/__tests__/import-generation.test.ts (22/22 passed)
  - Gates:
    - 	ypecheck exit 0, lint exit 0, check:i18n exit 0, uild exit 0.
- Acceptance:
  - Verdict: PASS (审核确认 AC-1 短书/首尾/缺口精确取样一致性、AC-2 小批次读取随范围增长且不信任客户端自报正文/哈希、AC-3 权威指纹校验与拦截拒绝语义完全符合契约，测试覆盖 100%).
  - PERF-002 marked completed / passes=true.
  - Total completed features: 29/35 (82.9%).

## Review Record: Stage 28 - PERF-003 流式快照与通知去重 (Stream Snapshot Deduplication and Publish Guard)
- Review Date: 2026-11-09
- Reviewer: Stage 28 Independent Architecture & Quality Reviewer (pro model, subagent 0a8737a1-6cdc-4e9b-ac76-cf9815b310c2)
- Scope & Evidence:
  - ADR: docs/adr/0062-stream-snapshot-deduplication-and-publish-guard.md
  - Evidence: docs/plans/2026-11-07-creation-runtime-modernization/stage-28-evidence.md
  - Source Files:
    - electron/services/stream-snapshot-guard.ts
    - electron/services/main-generation-owner.ts
    - electron/services/__tests__/stream-snapshot-deduplication.test.ts
  - Test Suite:
    - electron/services/__tests__/stream-snapshot-deduplication.test.ts (7/7 passed)
    - electron/services/__tests__/main-generation-plan.test.ts
    - electron/services/__tests__/main-generation-model-change.test.ts
    - electron/services/__tests__/performance-diagnostics.test.ts (4 suites, 115/115 passed)
  - Gates:
    - typecheck exit 0, lint exit 0, check:i18n exit 0, build exit 0.
- Acceptance:
  - Round 1 Verdict: REJECT (发现 storageFailed 集成短路、正文分歧防御未启用、回读单调性判定偏宽三项防御缺口，要求针对性加固并补全单测);
  - Round 2 Verdict: PASS (复核确认全部 4 项完成闭环加固，单测 7/7 通过，全票通过签发 PASS);
  - PERF-003 marked completed / passes=true;
  - Total completed features: 30/35 (85.7%).

## 2026-11-10 - Stage 38 Frozen Selection Increment

Current status remains the features.json revalidation state, not the historical completion totals above. Independent reviewer baseline_audit inspected the frozen owner/helper, shared response, real controller/client assertion, consumer/export/tests and ADR-0060. No unresolved scope correctness defect or required missing static case was found. Implementers were separate from the reviewer; all use inherited session configuration, with no model substitution claimed.

Root actually executed 9 focused files (544/544, zero failed/pending), typecheck/lint/i18n/build and serial fictional perf-import-10/perf-long-stream. Both scenes exited 0 with real selection receipt projection, normal quit and clean cutoff/isolation; screenshots were personally inspected. [Stage 38 evidence](stage-38-evidence.md) records exact commands, source/build/report identities, observations and limitations. The separate artifact review is recorded there after completion. This is acceptance of a diagnostic increment only, not PERF-001 completion, literary-quality or platform qualification.

## 2026-11-10 - Stage 39 Stream Lifecycle Increment

Independent source reviewer baseline_audit traced the integrated owner/service/guard and downstream physical scheduling, unknown, tail and reconnect boundaries. Initial static review missed native-vs-renderer and usage fixture expectations exposed by actual 437/443 execution; the affected conclusion was withdrawn. Implementer corrected only fixtures/assertions, preserving all production protection, and the final exception matrix now covers both unknown and trusted settled accounting. Final independent re-review found no scope correctness blocker or required missing case.

Root executed final 14/14 targeted cases, then 448/448 across six files, typecheck/lint/i18n/build and the isolated fictional long-stream scene. Normal clean quit and unchanged finalized count were observed; exact source/artifact identities, failed report and limitations are in [Stage 39 evidence](stage-39-evidence.md). Separate artifact review follows. This is a narrow PERF-003 safety correction, not whole-feature, literary-quality, visual-fidelity or platform acceptance.

Final artifact reviewer feedback_audit independently matched all 21 source, report, build and original-baseline identities, checked the raw denominators and personally inspected the screenshot. No blocker remains for the narrow increment. It did not rerun commands; quality/build exits remain root's execution evidence. PERF-003 stays in_progress/passes=false and stored owner running is not presented as domain completion.

## 2026-11-10 - Stage 40 Protection Corrections

Independent source reviewers baseline_audit and feedback_audit found two approval blockers despite initial 203/203 green tests: available current dirty input was lost on disconnect/conflict, and missing dirty content still allowed freeze. The implementer retained buffers before failure, failed closed for absent content, preserved empty-string input and added four regressions. Both reviewers re-read the new frozen bytes and found no remaining scope correctness blocker or required missing case. Header/scratch corrections had no source blocker and remain bounded to the exact existing contracts.

Root's final package executed 13 files, 207/207, zero failed/pending; typecheck/lint/i18n exit 0. [Stage 40 evidence](stage-40-evidence.md) retains the first report, final source identities, actual commands and qualification limits. Build and final artifact inspection are recorded after completion. No API, trusted approval or scratch whole-feature promotion follows from this increment.

Root build exited 0 with unchanged known warnings and Stage39 entry hashes. This is source-build compatibility, not production composition or application runtime evidence; no Electron/model/platform qualification was added. Final artifact review follows against recorded identities.

Final artifact reviewer feedback_audit matched all 16 source/test/ADR, report and build identities and actual 207/207, including all four added regressions. No blocker remains for the narrow commit; original green-but-incomplete coverage and subsequent corrections are retained. The review did not rerun commands or grant full feature qualification.

## 2026-11-10 - Stage 41 Desktop Range Feedback v2

Independent source reviewers baseline_audit and feedback_audit traced the integrated dedicated client, bridge, controller, range facade, SQLite writer and portable boundaries. Both found no range-version/authority/writer blocker. Two additional bridge/session cases were reviewed after the initial 1062/1062 execution. Actual quality checks then exposed private generic inference errors and three unused test bindings; the implementer corrected only common-command typing and test bindings. Both reviewers re-read those new bytes and confirmed closed runtime validation, v1/v2 public type separation and all prior guards remained intact.

Root's final type/lint/i18n checks exited 0, followed by a complete sixteen-file rerun against the revised source (1064/1064, zero failed/pending), then serial build exit 0. Initial report and failures, final source/report/build identities and limitations are recorded in [Stage 41 evidence](stage-41-evidence.md). Separate artifact review follows; no reviewer reran commands, and no full feature, UI, real-model or platform qualification is claimed.

Final artifact reviewer feedback_audit matched seventeen final source/test/ADR blobs, two report hashes and three build hashes, checked actual denominators and added bridge cases, retained failures, current feature states and excluded paths. No blocker remains for the narrow scoped commit; command exits are root's execution evidence, not independently rerun. Whole FEEDBACK-003 remains incomplete.

## 2026-11-10 - Stage 42 Persistent Blueprint Field Feedback Kernel

Independent source reviewers baseline_audit and feedback_audit traced schema3 capture/context/proof, source binding, durable repository and existing writer, M15/FK/backup, and closed portable projections. Root identified the raw-encoding revision double-consumption boundary; the repository implementer corrected it and both reviewers re-read normalization and rollback regressions. The reviewers also checked the real migration prerequisites and identity-preservation fixtures. Neither implementer is the sole verifier of its material changes; no unresolved narrow-scope correctness blocker remains.

Actual execution retained initial type/lint failures and the first native report (1347/1351, four failed). Test-only fixes install real roster identity prerequisites, preserve readonly tampering construction, correct exact current-policy archive counts and repair test call layout. Both independent reviewers re-read revised test bytes. Root then executed final typecheck/lint/i18n (all exit 0), all 32 focused files (1415/1415, zero failed/pending) and serial build (exit 0). [Stage 42 evidence](stage-42-evidence.md) records exact commands, source/report/build identities and limitations. Independent artifact review follows; command execution is root evidence, not a reviewer rerun.

This package accepts only the internal persistence kernel. Dedicated v3 IPC/client, visible author workflow and the rest of FEEDBACK-003 remain incomplete; no real model, real project, trusted approval, literary-quality or platform qualification is inferred.

Final artifact reviewer feedback_audit independently matched all forty-two recorded identities (36 frozen source/test/ADR, three reports, three built entries), raw final per-file denominators and all four originally failed cases now passed exactly once. The exact forty owned paths, empty index, retained initial failures and original file/report exclusions were checked. No narrow-scope blocker remains; this was artifact inspection, not an independent command rerun.

## 2026-11-10 - Stage 43 Dedicated Desktop Blueprint Feedback v3

Independent source reviewers baseline_audit and feedback_audit inspected the dedicated closed shared/client contract, actual registered controller-to-owner-to-SQLite path, strict durable context/task guards, six-way version isolation, writer/replay/CAS, cancellation/unknown and original/portable recovery. A static fixture type issue was corrected before execution. The evidence reviewer initially missed the pending character-sync work-item assertion and explicitly withdrew that conclusion; it is not retained as acceptance.

Root retained initial TS2345 and native 1262/1264 failures. Three test-only corrections preserve correlated channel typing, distinguish legitimate pending sync work from actual identity writes, and require exactly one existing physical-completion llm_calls diagnostic while all logical/business rows stay unchanged. Both independent reviewers re-read the final twelve code/test/ADR paths and found no narrow-scope correctness blocker or required missing case.

Root actually reran all twenty files: 1264/1264, zero failed/pending; final typecheck/lint/i18n/build each exit 0. [Stage 43 evidence](stage-43-evidence.md) records exact source, both reports, built entry identities and limitations. Final artifact review follows; no reviewer command rerun, UI acceptance, whole-feature completion, real-model quality or platform qualification is inferred.

Final artifact reviewer feedback_audit matched all seventeen identities and identical raw denominators, including both previously failed cases now passed exactly once. No evidence blocker remains. Root separately verified the exact sixteen owned paths, empty index and Git hook/exclusion boundaries; the artifact reviewer did not run Git. This accepts only the narrow v3 desktop increment.

## 2026-11-10 - Stage 44 Actual Autonomous Receipts And Retry Barrier

Independent reviewers baseline_audit and feedback_audit inspected both services, both shared contracts, their four tests and ADR-0053/0057. Three await interruptions retain only actual prefixes; missing predecessors stop read-only; scratch preserves attempt history/real IDs, classifies unsafe results before retry, checks barriers/flights before resume reset and requires exact target success receipts. Root's static integration finding about ID collisions was repaired with a closed rejection and active/completed history regressions before execution. Both final source reviews find no unresolved narrow-scope correctness issue or required missing case.

Root actually ran the focused eight-file package: 127/127, zero failed/pending, exit 0, and fresh typecheck/lint/i18n exit 0. [Stage 44 evidence](stage-44-evidence.md) records frozen identities, exact commands, denominators and explicit limitations. Serial build and artifact review follow actual completion. Neither review executed project scripts or qualified persistent/production AUTO behavior, real models, multi-book operation or trusted approval.

Root serial build exited 0; three entry hashes are unchanged because this helper pair is still uncomposed in production. That is build compatibility, not an application runtime exercise. Independent final artifact review follows against ten source/test/ADR, one raw report and three built entries.

Final artifact reviewer feedback_audit independently matched all fourteen identities, raw denominators and required regression presence, with no scope evidence blocker. Root owns the separate Git path/index/hook/exclusion checks. This was artifact inspection, not an independent rerun or whole-feature acceptance.

## 2026-11-11 - Stage 45 Reference Knowledge Grant Admission

Independent source reviewers baseline_audit and feedback_audit traced actual issuance, captured runtime/grant/portable checks, KB receipt transactions/replay and physical single-flight/cleanup. Initial review found effect-bearing nested calls lacked their own rollback boundary; the owner added a savepoint and two outer-catch regressions before execution. Both reviewers re-read the correction.

Actual first run was 207/208: the unit fixture's persistent admission_effects table violated canonical schema on reopen. Both reviewers acknowledged the missed fixture problem and withdrew the affected no-missing-case conclusion. The owner changed only the fixture to TEMP and the second connection's write to existing project_core, preserving strict lock and production reopen guards. Both independent reviewers inspected those final bytes with no narrow source blocker.

Root's fresh fourteen-file run passed 208/208, zero failed/pending, exit 0; initial and final typecheck exit 0. [Stage 45 evidence](stage-45-evidence.md) retains both raw reports, identities, precise fixture correction and explicit limits. Final lint/i18n/build and separate artifact review follow actual completion. This does not qualify complete IMPORT, durable request/model-source freezing, unknown recovery, UI, real models or target platforms.

Final lint/color, i18n and serial source build each exit 0, retaining existing warnings. Root recomputed all five source/test/ADR identities unchanged after execution, froze both reports and three built entries, and checked the original excluded paths/index/hook boundary. Independent artifact inspection follows; command exits remain root execution evidence, not reviewer reruns.

Final artifact reviewer feedback_audit matched all ten identities and raw denominators, the previously failed case now passed exactly once, retained failure lineage, six completed flags and exclusions. No narrow-scope evidence blocker remains. The reviewer did not rerun commands or operate Git; root owns the nine-path/index/hooks check and scoped commit.

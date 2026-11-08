# Stage 5B1: Scheduled Production Generation

Parent: `4b43f3efdbd50fc085f76c68e0c84b5c29181c4b`. Date: 2026-11-08, Asia/Shanghai. The [current 19-file manifest](stage-5b1-source-manifest.json), SHA256 `6C4612859CA0931CC3B3A05B3A100EDD705DEC87BD8B8685CE3BC52E927D8B66`, matched 19/19 for the final scene focus and actual Electron execution. Its 17 production/other-test identities are unchanged from the 1012-case full run; the two scene-only repairs have fresh 56-case focused, lint and actual Electron evidence. The [pre-HTTP-fix manifest](stage-5b1-pre-http-fix-source-manifest.json), SHA256 `10C12C85530E7078F70FADCF744F5B9C7D6D83657182887B4B6919FCB0EEDE1A`, matched 19/19 for the 972-case run. The [pre-cancellation-fix manifest](stage-5b1-pre-cancel-fix-source-manifest.json), SHA256 `431F841A3C5A76114B2DD1B7B5E7503B779F7990F9C841938A38E6C3F99E73C6`, preserves all first-impact identities. Historical reports never accept later bytes. Contract: [ADR-0035](../../adr/0035-scheduled-generation-dispatch.md).

## Scope And Acceptance

This increment connects existing durable main generation owners to one private finite scheduling broker. It preserves same-nonce merging and durable replay before queueing; waiting creates no attempt and renews no authority. After queueing, the original captured knowledge snapshot is checked under the short KB gate, followed by current owner/source/model/lease/root/budget qualification and synchronous native reserve/mark admission. Network waiting occurs outside that gate and outside a database transaction.

The production controller uses global/provider/credential/model limits of two, project one, queue 32, quarantine two and interactive burst one. Project grouping uses the captured execution epoch. Origin/key/model grouping does not change actual adapter URLs, frozen models, headers, redirect behavior or previously invalid Fetch userinfo behavior. A private permit is never stored in a replay task, receipt or archive. Logical cancellation retains physical ownership through actual provider reader/body cleanup; unresolved work keeps its counts during the 5,000ms cleanup grace and any subsequent quarantine. Late finish does not reopen a stopped channel or resend unknown work.

There is no visible output, new IPC request, schema/persistent field, dependency or plugin change. Existing author facts, native writers, CAS, outbox and receipt contracts remain authoritative. No new portable migration is introduced. SCHED-002 remains `in_progress/passes=false`: direct legacy LLM, embeddings, probes/discovery and direct domain claims, serial/two-way performance and full qualification are not completed by this increment.

## Team And Review

- gpt-6.1-sol/high implemented owner/service scheduling and provider physical cleanup under separate file ownership; the original broker implementer and original isolated scene implementer used gpt-6.1-terra/high. After the original scene was frozen, its two-file fixture repair ownership was explicitly transferred to the existing gpt-6.1-sol/high provider implementer. No concurrent overlapping writes or implicit model substitution was applied.
- Root owns controller composition, registered-IPC native regression, shared records, serial project/native execution and Git. Independent requirements, authority/security and physical/lifecycle reviewers have no implementation ownership in the reviewed files and run no project/native commands.
- Independent requirements, authority/receipt and physical/lifecycle reviewers closed the KB dispatch-boundary, canonical-cancellation, non-400 logical/physical split, original-error and both scene-fixture findings. Each matched the current 19-file manifest, reconstructed the exact old two-scene full-run identity, directly consumed the final 56-case and four Electron raw reports and accepted only this slice, with no unresolved in-scope correctness blocker. Static/build exit results are root execution evidence, not reviewer reruns; reviewers independently matched the built bytes. No whole-feature status or future global gate is accepted.

## Findings And Repairs

1. Dispatch could occur after the old execution-only KB guard returned. The synchronous source binding only hashed the saved snapshot and did not detect an actual Lance change. The owner now checks the exact original snapshot after queue admission, starts final synchronous qualification/reserve/mark within that short guard and awaits the provider outside it. Earlier execution-only wrappers were removed, preventing inheritance of a released reentrant gate token. Preparation, resume and formal-write guards remain. Native regression mutates a real isolated Lance passage while C is queued; C must have zero attempts, requests and effects, while A/B finish normally.
2. Generic private abort previously replaced the public `GENERATION_ACTION_CANCELLED` with `GENERATION_CANCELLED` in an existing controller/store KB-wait test. Original owner checks now precede the private abort fallback. Only a real `SchedulerAdmissionError` with `SCHEDULER_CANCELLED` and this exact private signal aborted re-enters the same admission check. Real source/grant/lifecycle/storage failures are retained. Existing public assertions remain unchanged; regressions cover public queued cancellation, source/grant races, pause/restart/close/suspend and no database read after close.
3. Immediate quarantine would stop ordinarily cooperative providers during their brief local cleanup. Physical permits now remain held through the bounded cleanup grace; actual finish clears the per-flight timer, and only still-unresolved work is quarantined. Provider-finally awaits reader/body cancellation settlement. Local completion is not remote-stop proof. Independent lifecycle review also required cleanup and rejected-promise observation in the transport fixtures; those fixes are in the current manifest.
4. Test-only repairs retain production guards: replace an unavailable Promise library helper and add required provider options; include valid SSE usage rather than expecting trusted settlement without usage; query child bindings with actual knowledge snapshots; complete the existing recovery fixture's task_id/request_hash columns. The new public cancel fixture now obtains preparation/material receipts and uses the preparation contract's original six-chapter blueprint window. Neither cancellation expectations nor source/security assertions were relaxed.
5. A later independent targeted review found the non-400 HTTP helper awaited body cleanup before emitting its known failure, while the default owner also waited for the entire stream Promise before exposing any logical result. Delayed cleanup could therefore exhaust/fence the original root and replace a known provider failure with ROOT_BUDGET_EXHAUSTED. The old HTTP receipt may already be unknown without usage; no new settled-to-unknown regression is claimed. Provider and owner repairs separate timely logical results from actual transport permits and close tracking. The six-provider-file 177-case report and the first owner four-file 152-case report cover deferred cleanup; the subsequent first-HTTP 34-file report passed 992/992. These reports precede finding 6 and are not final acceptance.
6. The independent physical/lifecycle reviewer found the new fallback replaced an adapter's original callback-free rejection or synchronous throw with a generic provider failure. That breaks the existing service's network/context classification. The owner-only follow-up preserves the original unknown error for the unchanged classifier, while callback-free normal completion remains generic and any first terminal callback stays immutable. Sixteen new reject/throw cases preserve existing Error and non-Error classification; four done/error plus closing/revoked cases hold physical occupancy and check late callback/reject causes no native/log call or DB byte/result change. These four explicitly suspend and close an isolated old DB; production drain still waits for physical idle. All twenty new cases actually passed in the final 172-case focused run, and independent authority/physical source re-review closed the findings. This is not permission to close a live production flight.
7. Current static checks exposed two TS2352 errors in incomplete test-provider mock assertions and one prefer-const finding in the deferred KB snapshot fixture. Only two explicit `as unknown as ILLMProvider` assertions and one explicit initial `= undefined` changed. The requirements reviewer reversed those three edits in memory and reproduced the exact old test hash, proving no other fixture, assertion or production change. No compiler target, lint disable or runtime fake function was introduced; the initial absent-then-captured snapshot timing is retained. Fresh current typecheck, lint/color, i18n and source build then exited 0. The current 34-file rerun is still pending at this checkpoint.

## Actual Execution

Working directory: project root. Windows x64, Node 24.13.0, Corepack pnpm 11.11.0, Vitest 4.1.12. Root serializes commands. Reviewed test fixtures use only fictional model profiles, fake fetch and owned SQLite/Lance directories; they may write local reports/caches/temporary databases, not real projects or model configuration. All raw report paths below are under `.runtime/creation-runtime-modernization/stage-5b1/`.

| Report | Actual result | SHA256 |
| --- | --- | --- |
| `provider-broker-scene-first.json` | exit 0; nine files, 209/209, zero failed/pending | `6973076D9F90169BEBED40AED9E0D3663327010B56B961138831DF1510820B66` |
| `broker-wire.json` | exit 0; 11/11, zero failed/pending, including six later actual-adapter/mock-fetch compatibility cases | `99887AD51FCED0B40179432AF6F4CD83C50378C7C70EB8C2FEA70817B2F9A2A5` |
| `owner-controller-first.json` | exit 1; 80/84, four fixture failures | `EA85E2241E525EBD8C73271FD2F9EE1878C1140D59DB9498114F5536B5E21E52` |
| `native-controller-retest.json` | exit 0; three native cases, 3/3 before the fourth public-cancel fixture | `D135B52D34BF23EDB72D57990B4AAE0618D31EA9E68AA752A440C2921C0DB6CF` |
| `impact-first.json` | exit 1; 34 files, 968/969, zero pending; real canonical-cancel regression | `4D5C933028FF810CEF5D928880553C267072E8B7711B560BE9CFE1E9FA9AF12F` |
| `owner-controller-cancel-retest.json` | exit 1; 86/87; new fixture omitted required preparation/material decision | `73D40CBDBD14C21152929B9A3671B25DB34284AC381284904E359C52F86E2737` |
| `owner-controller-cancel-final.json` | exit 1; 86/87; new fixture mismatched the frozen blueprint window | `2FCBA9A097378F9929E87DDB8B6C6FCEE74E990D33C909C7DBA3D85D3D4817E3` |
| `owner-controller-preparation-final.json` | exit 0; three files, 87/87, zero failed/pending, success=true | `7C3E36B73DFD4E9FAF7B28746531941404A05DECD5FD39C168289C54AB2BA9B5` |
| `impact-retest.json` | exit 0; 34 files, 972/972, zero failed/pending, success=true; pre-HTTP-fix bytes only | `0B203B44AB0BAF6D3C5374DF0D1A813B78962ADFB476E7DE47F006C902E8EE7D` |
| `provider-http-logical-final.json` | exit 0; six provider files, 177/177, zero failed/pending, success=true | `517E814DAD52740F0825FC70341863872F4862C66861E7C5298CBD1195913076` |
| `owner-physical-http-final.json` | exit 0; four files, 152/152, zero failed/pending, success=true; before original-error preservation | `279B7BE26022DDE380943742C5F8E1104D5CA92C2B116F94CF1469538D97C33E` |
| `impact-http-final.json` | exit 0; 34 files, 992/992, zero failed/pending, success=true; before original-error preservation | `E7133F3C705EE68ECE0BC9B74DC12634B3EC2EE4E79CEFD73C1F0533F6C895B5` |
| `owner-error-close-final.json` | exit 0; four files, 172/172, zero failed/pending, success=true; final owner/error/old-resource bytes | `B852D9A321F919D11DA8E263810CAC926C44F6F186AFC4207E9DC6B3C996B348` |
| `impact-error-close-final.json` | exit 0; 34 files, 1012/1012, zero failed/pending, success=true; before three fixture-only static corrections | `575F4FFB9B3758693BD3A78C68E8BF49B9E4175DC89635A6A3BED49D82C55AF4` |
| `impact-current-final.json` | exit 0; 34 files, 1012/1012, zero failed/pending, success=true; final production and static-corrected test bytes, before later scene-only repairs | `1B649765E1821D13C793B014A295DE74F4D0E115BE0FCE0E0BCB21BA0F7F5C70` |

The first nine-file run contains five earlier broker tests; it is not evidence for the six later wire cases. Focused/final reports overlap and are not summed. Failed reports remain failures. The pre-cancellation and pre-HTTP manifests differ in exactly the owner and its two scheduling tests; the original public-controller cancellation assertion is unchanged. The first-HTTP 19-file manifest had SHA256 `4ADE570171F825E344CC19C631A4840035BBF0CF47355B13425F5DCFD54FEB5C`, with owner `DBDECA73261347269FA5AF27E1F6274CEC8D1C9D4D80B3A43C80A12B38F3B857` and owner-test `9C11568563CEABCE0083AB5847199B43EC1C394DF7EF13818B6E7C53B1E31462`; only these two identities change for finding 6. First typecheck exited 1 on new fixture typing, then exited 0 before the later cancellation fix. Subsequent current-byte static/build results are recorded below rather than inferred from that earlier pass.

The last full 1012-case run used pre-scene-repair manifest `3BA2C123D5F5BC1A862B6CF5A25566ED44A38127A1F763916AE07FCA14B7A6DC`. Root reproduced that exact whole-manifest SHA in memory from the current manifest by replacing only the scheduled scene hash with `7FEF10C677271C5E16A6E1508A1264A440934CB2035297FF5419116BD3381F5A` and its test hash with `5CCAC0BDAE05F9872D42E206792889B1EEE1177B867CB3E6EDD8655D525D3C3C`. The current scene/test hashes are `CDD3DEA2FEEF18B081A5438F1B250925689932A381064E7149A82B7997BEDFFF` / `74AFC0453946411813F3F991201CFE04162C22BF42DF4E1EE4133F1E1C5DB2BF`. All other 17 identities match. This is scoped evidence composition, not a claim that the old full run executed the later scene tests.

The 172-case focused and first 1012-case reports use the original-error manifest `BFB11BE22AC2DB7F811E4FD1F8E40C02BD8E59B6B07691DD34A53997689C8232`, whose only difference from that pre-scene-repair 3BA manifest is owner-test hash `27A97BEEC79F5FE0AAA24C04E752D76762163547D954075C5451ABDB5137DD65` instead of final `F9BB051A66B1789832BE67E2BA492C8703773BA39B4177234CD2E182AE027BBD`. Root reproduced that whole-manifest SHA in memory before the scene repair. Replacing the owner/test in the 3BA manifest with the two first-HTTP values above also reproduced the exact first-HTTP whole-manifest SHA. This mapping preserves earlier reports without claiming their test bytes are current.

Commands executed so far include the reviewed `corepack pnpm test` script with these explicit file groups and JSON output paths: nine provider/broker/scene files; broker alone; owner scheduling/service/registered-controller three-file group (four separate retained runs); native controller alone; six-provider-file HTTP repair; four-file owner/service/controller/physical repair; and the 34-file impact group. The final focused command was:

```powershell
corepack pnpm test electron/services/__tests__/main-generation-owner.scheduling.test.ts electron/services/__tests__/generation-run-service.test.ts electron/controllers/__tests__/generation-scheduling-controller.test.ts electron/llm/__tests__/provider-physical-close.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-5b1/owner-error-close-final.json
```

The 34-file runs use this same explicit file list, with their corresponding report path. The last full run passed on the pre-scene-repair manifest; later scene-only bytes require their own new focused and actual execution evidence:

```powershell
$impactFiles = @(
  'electron/services/__tests__/main-generation-owner.test.ts'
  'electron/services/__tests__/main-generation-owner.scheduling.test.ts'
  'electron/services/__tests__/generation-run-service.test.ts'
  'electron/services/__tests__/generation-scheduler.test.ts'
  'electron/services/__tests__/main-process-scheduler.test.ts'
  'electron/services/__tests__/main-resource-claims.test.ts'
  'electron/services/__tests__/scheduler-network-subject.test.ts'
  'electron/services/__tests__/workflow-driver-engine.test.ts'
  'electron/services/__tests__/workflow-batch-engine.test.ts'
  'electron/services/__tests__/workflow-driver-authority.test.ts'
  'electron/services/__tests__/workflow-batch-authority.test.ts'
  'electron/services/__tests__/runtime-feedback-authority.test.ts'
  'electron/services/__tests__/project-runtime.test.ts'
  'electron/services/__tests__/project-runtime-lifecycle.test.ts'
  'electron/services/__tests__/project-runtime-compatibility.test.ts'
  'electron/services/__tests__/model-execution-lease.test.ts'
  'electron/services/__tests__/generation-knowledge-source.test.ts'
  'electron/controllers/__tests__/generation-controller.test.ts'
  'electron/controllers/__tests__/generation-scheduling-controller.test.ts'
  'electron/controllers/__tests__/runtime-feedback-controller.test.ts'
  'electron/controllers/__tests__/workflow-driver-controller.test.ts'
  'electron/controllers/__tests__/workflow-batch-controller.test.ts'
  'electron/controllers/__tests__/agent-generation-controller.test.ts'
  'electron/llm/__tests__/openai-provider.test.ts'
  'electron/llm/__tests__/anthropic-provider.test.ts'
  'electron/llm/__tests__/anthropic-provider.http.test.ts'
  'electron/llm/__tests__/gemini-provider.test.ts'
  'electron/llm/__tests__/provider-context-length.test.ts'
  'electron/llm/__tests__/provider-physical-close.test.ts'
  'src/shared/__tests__/workflow-resource-claims.test.ts'
  'src/services/workflows/__tests__/workflow-resource-claims.test.ts'
  'scripts/redesign/__tests__/scheduled-generation-scenario.test.mjs'
  'scripts/redesign/__tests__/workflow-driver-scenario.test.mjs'
  'scripts/redesign/__tests__/workflow-batch-scenario.test.mjs'
)
corepack pnpm test $impactFiles --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-5b1/impact-current-final.json
```

No test timeout, compiler target, queue bound, admission guard or public expected error was lowered to obtain a pass.

Current actual static/source-build commands, each exit 0:

```text
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
corepack pnpm run typecheck
```

The earlier two-error typecheck and one-error lint remain failures, not warnings or passes. Source build includes TypeScript followed by Vite; existing customResolver/output-option/inlineDynamicImports deprecation and ineffective-dynamic-import warnings were not hidden or changed. Build is not an installer or runtime acceptance.

| Current build output | SHA256 |
| --- | --- |
| `dist-electron/main.js` | `8CCF14BAA440DBA4D0829D2F0DB8EFE3EF5121FC7B41E0B12260FBC243DBF806` |
| `dist-electron/preload.mjs` | `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B` |
| `dist/index.html` | `212DD2B4E0D2F63498F2E6C065A5A2D5FD3C77FBD2F5087C8B575891FD814CA0` |

## Actual Electron And Fixture Repairs

All reports below are under `.runtime/creation-runtime-modernization/stage-5b1/`; every command runs from the project root, uses reviewed fake-only isolated fictional projects and writes only its owned scratch/output. No `--real-model`, real configuration contents, manual failure-root cleanup or installed-user-app termination is used. Production build identities above stay unchanged through the scene-only repairs.

| Report | Actual result | SHA256 |
| --- | --- | --- |
| `electron-scheduled-final/scheduled-generation-v1-light.json` | exit 1; unlabelled preparation assertion, zero model requests | `E2B6BBE27DFB2BCD31BAEAC7EB459F3A71C8DBF2CA7D505F70031313334E6EE5` |
| `electron-scheduled-diagnostic/scheduled-generation-v1-light.json` | exit 1; B blueprint preparation refused by the real legacy-operation guard, zero model requests | `F5EDA23CE2342B4025BA64BE61080F5E6FD309CD435F2217759FD280E7575B9D` |
| `scenario-preparation-final.json` | exit 0; three fixture files, 54/54; preparation-close version, before response-counter repair | `2AE18CF4D3678898DFFBD1961B387CDD9D9B39E38257B6F5C2394D4E2839134A` |
| `electron-scheduled-retest/scheduled-generation-v1-light.json` | exit 1; response-header counter was incorrectly expected to include two still-held arrivals; cleanup total nine requests | `0AAC899D415EC9CD997851FAF9A0371BFE3F0A3D332B5CB219158A6D8427659A` |
| `scenario-response-counter-final.json` | exit 0; three fixture files, 56/56, zero failed/pending, success=true; final scene bytes, including actual guardFetch pending-response observation | `F52ACD4978A5AA46530B058903E985CCC25D311BAD5E91084CC301BCC626E20A` |
| `electron-scheduled-response-final/scheduled-generation-v1-light.json` | exit 0; two simultaneous fake arrivals; C zero attempts/effects and cancelled; six final requests, A/B six saved effects each | `CF45D0D0139009379B25C34855C564A06D35E17C1040E530EBC1D4DCE113931F` |
| `electron-batch-normal-final/workflow-batch-v2-light.json` | exit 0; six requests, twelve saved effects, detached work/receipt recovery and B preservation | `DE113B6BD859C08DB52536E6A0057CB70751A3FEBDA4909B31801ABF6BF03C58` |
| `electron-batch-unknown-final/workflow-batch-unknown-v2-light.json` | exit 0; one physical request across pause/resume/cancel, no unknown replay | `D99C2668CD111E8F5EF4372EB483E7B9A5D439A374280EA46FBECB0ADCCA5DE4` |
| `electron-batch-restart-final/workflow-batch-restart-v2-light.json` | exit 0; real PID/epoch restart, old reference rejected, one total fake request, zero post-restart dispatch | `A6BC50A0FDCFDCFF25A01AAE5A851DCD34EF27456231C186FF67AAD68F2EF4EA` |

The diagnostic-only scene SHA256 was `E2D186F74C4C05E6B533EFB6439977CE8ECE0526869453A2A601F030A4B1E1CF`. It retained preparation order and reported `SCHEDULED_GENERATION_SETUP_FAILED:db:blueprint-upsert:B:Error: PROJECT_RUNTIME_LEGACY_OPERATION_UNAVAILABLE`. Independent review traced the db-controller wrapper to the unchanged multi-runtime legacy guard. Each book is now prepared and truly closed before preparing the next; the later three-book concurrent start is unchanged. The preparation-close scene/test hashes were `A2D7711A2C2D10CEBA1286C9C5A168E56DB9C4DF94952DA126FFAE4BCDFE1120` / `6FA058ECBC68166442B61E0F2D56D1F0006E83679459A36EF7540A5F8053356F`.

The next failure exposed another fixture mismatch: `guardFetch` records only after receiving response headers or a rejection, while the fake gate waits before sending headers. Two actual held arrivals therefore correctly have zero new header records. Its mock had counted at start. The scene-only repair distinguishes held arrivals from header records, keeps C's zero attempts/effects and cancellation plus final six-request checks, and adds a real pending-response guard regression. Fresh focus passed 56/56 and another lint/color exited 0; the actual scheduled scene then passed. The nine requests in the retained failed run are after cleanup first released the gate; they cannot locate a C dispatch before the failed assertion or after cancellation.

The final scene verifies the real production controller's default shared broker, not an injected unit fake. While A/B are held at the loopback provider, each has one dispatch-marked attempt and no effect, C has none and remains queued; cancelling C leaves those counts zero. A/B each finish outline/draft/compose/save/review/review-save with three settled physical attempts, exact original draft content/hash and review source binding. Detached receipt/history and completed-task reauthorization are checked without new dispatch. Fictional C facts remain unchanged. This is actual local concurrency-two execution, not remote concurrency proof or a performance sample.

Commands (one at a time, no model credentials or external state):

```text
corepack pnpm test scripts/redesign/__tests__/scheduled-generation-scenario.test.mjs scripts/redesign/__tests__/workflow-driver-scenario.test.mjs scripts/redesign/__tests__/workflow-batch-scenario.test.mjs --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-5b1/scenario-response-counter-final.json
corepack pnpm run lint
corepack pnpm run verify:drive -- --scenario scheduled-generation-v1 --theme light --out .runtime/creation-runtime-modernization/stage-5b1/electron-scheduled-response-final --console
corepack pnpm run verify:drive -- --scenario workflow-batch-v2 --theme light --out .runtime/creation-runtime-modernization/stage-5b1/electron-batch-normal-final --console
corepack pnpm run verify:drive -- --scenario workflow-batch-unknown-v2 --theme light --out .runtime/creation-runtime-modernization/stage-5b1/electron-batch-unknown-final --console
corepack pnpm run verify:drive -- --scenario workflow-batch-restart-v2 --theme light --out .runtime/creation-runtime-modernization/stage-5b1/electron-batch-restart-final --console
```

The two earlier scheduled commands used `--out` ending in `electron-scheduled-final` and `electron-scheduled-retest`; the diagnostic-only command used `electron-scheduled-diagnostic`. The preparation focus used the same three files and `scenario-preparation-final.json` output. All failed raw artifacts remain failures.

Every actual report has normal quit and empty external request/write/ignored/residual arrays; external network observation ends before quit. Root inspected the failure PNGs and all four passed scene PNGs. Initial scenes, including the passed scheduled scene, show the unchanged empty library, and restart shows only two fictional library book cards, without active task progress or author counters. Direct-IPC/runtime results do not establish visible author-workflow acceptance.

## Acceptance And Remaining Boundaries

All selected runtime/source verification has executed and three independent reviewers accept Stage 5B1 only, with no unresolved in-scope correctness blocker. Exact-path record/commit consistency is checked separately. SCHED-002 stays in_progress/passes=false, with 6/35 features completed overall. No completed SCHED-002, author-workflow visual, browser, real-model quality, remote concurrency, platform/installer or headless qualification is claimed. Installed-app interference still blocks the long PERF-001 sample independently; its absence does not cancel the separately accepted single-book driver or authorize killing the user's process. Complete single-book reference/import and imitation migration proceed independently of the unfinished multi-book qualification.

# Stage69 Evidence: Display Diagnostics Without Reclassifying Failures

Date:2026-11-14. Entry:master@40ebe9ef25d82be326a93e59d56183159d07bcf2. Status:bounded source/runtime/quality and independent artifact audit accepted;exact-path Git and postchecks pending. Features remain11completed/24in_progress.

## Scope And Evidence

Stage68's actual all-source error-code scan found53 entryHEAD literals,not a new refresh-code regression. Separate reads identify13 existing-template paths,15 internal/converted paths,24 presentation candidates and MCP_DISCONNECT_FAILED. The three reference drivers use knownAppErrorMessage as safe-code admission;registration would change public/persisted failures and potentially cancellation priority. Preserve ERROR_KEYS,knownAppErrorMessage,appErrorMessage,main import failure templates,all driver/executor classification and physical receipt semantics. Do not invent a global registration merely to satisfy the scan.

Add displayOnlyErrorMessage(locale,error) for exactly those25 presentation diagnostics,using only the existing error.unknown resource. Only the existing displayedErrorMessage final display boundary calls it,after existing known-code resolution and before unchanged raw fallback. Existing known candidate priority,unknown prose/unknown codes,template paths and errorCodeOf remain unchanged. The source coverage test distinguishes presentation from safe-code registration and retains all assertions;the28 exclusions need current caller/conversion evidence,not a blanket family exemption. No IPC,schema,ledger,grant,capability,approval,budget or dependency change.

| Workstream | Write Owner | Required Evidence |
| --- | --- | --- |
| Final display boundary | root:app-errors.ts,new display-only-errors.test.ts,records/Git | finite25 diagnostics,both locales,IPC/class wrappers,known candidate priority,unregistered/prose unchanged,safe classification unchanged |
| Browser-safe validation boundary | root:blueprint-feedback-validation.ts,old contract and shared contract test | exact validator extraction,legacy re-export identity and return reference,unchanged apply/hash,existing native adapter CAS/idempotence/reopen |
| MCP disconnect result | Luna:mcp-store.ts and existing test | actual mocked false receipts,single/all partial failures,authoritative reconciliation,query failure preservation,unchanged success,no external MCP |
| Coverage and blueprint projection | Terra:generation-error-codes.test.ts,BlueprintFieldFeedbackPanel.tsx,new browser fixture |13template/15internal evidence,retained scan assertions,existing initial validation alert uses localized display boundary,both locales,no adoption/layout change |
| Main classification preservation | Agent4 Terra:three driver unit tests,structured executor test,new import diagnostic test | public/persisted failure and mixed cancel priority unchanged,receipt unchanged,all25 keep existing bilingual import templates;no claim every code is reachable through every driver |
| Independent acceptance | Sol:current integrated source/runtime/quality;separate nonowner artifact audit | review actual current bytes and raw;fix/retest/rereview before exact-path commit |

Visible delta inventory and sources:

- For the finite25 codes only,the final displayedErrorMessage boundary uses the already shipped error.unknown resource instead of a bare diagnostic. Source:existing src/i18n/app-errors.ts generic error policy and both resources;F2 preserves existing diagnostics/output contracts. No new explanatory words or retry/adoption claims.
- BlueprintFieldFeedbackPanel's initial validation alert currently renders contractResult.error directly,unlike its existing handleAdopt displayedErrorMessage path. The same existing translator must handle BLUEPRINT_CHANGES_EMPTY and BLUEPRINT_CHARACTERS_INVALID before initial display;validation,selection,adoption,layout and controls are unchanged. Source:current panel initial alert and handleAdopt plus shared blueprint-feedback-contract;browser assertions cover both locales. No other pre-existing copy/layout issue is in scope.
- MCP disconnect false receipts must not unconditionally erase servers/tools/resources. Reconcile through existing status/tool queries;retain available state if queries fail. Source:existing bridge's safe false receipt and sequential manager disconnectAll plus store's existing refresh/registry actions. Failure enters existing store.error only;no current component consumes that error,so no new visible error UI or complete UI wiring is claimed.

Root serializes authorized tests,browser,quality/build and Git;agents do not run project scripts. Tests first establish actual display/MCP/initial-alert REDs on fictional mocks,then the same cases must pass after minimal repairs. Main preservation tests may already pass on old code and are not fabricated REDs. Fresh focused regression,browser,typecheck,lint/colors,check:i18n and source build precede independent acceptance and exact-path commit. Reports/caches/build outputs remain local;browser uses reviewed loopback/headless Chromium with no installation. No real project/model/configuration,external MCP,dependency/native environment or platform qualification. Missing graph/AST/LSP services are replaced with bounded definitions/imports/registrations/callers/tests,not a complete dynamic call-graph claim.

## Actual RED And Necessary Browser Boundary Repair

All reports below are retained separately under .runtime/creation-runtime-modernization/stage69;none is overwritten by a later run.

- display-scan-red:authorized filtered pnpm test exits1,two files62cases9passed53failed. The new display suite is7/59 and the existing source scan2/3;the latter reports the same53 entryHEAD uncovered literals. Failed test count and uncovered-code count are different denominators.
- mcp-disconnect-red:authorized filtered pnpm test exits1,27cases23passed4failed. False single/all receipts lose the failure diagnostic,and all-disconnect incorrectly clears remaining state. Existing success and original rejected-IPC propagation cases already pass.
- blueprint-display-red:authorized filtered test:browser exits1,zero tests,because the configured Playwright headless shell is absent. No browser installation is attempted. The reporter's success=true with zero cases is not a PASS.
- blueprint-display-red-chrome:the same reviewed browser command uses the existing Chrome150.0.7871.115 through process-scoped AI_NOVEL_VITEST_CHROMIUM,restored in finally. It exits1,zero tests,at node:crypto.createHash externalization from blueprint-feedback-contract.ts. This is a real module-loading blocker,not the four target alert REDs. Browser sessions use an independent temporary profile,no authenticated session or system/repository configuration change.

Sol independently pre-reviewed the necessary scope adjustment:root extracts the original types and validator into browser-safe blueprint-feedback-validation.ts;the old contract re-exports the same function/types and retains applyBlueprintFeedbackChanges and blueprintFeedbackPayloadHash unchanged. Root's mechanical comparison confirms the validator block and apply/hash tail are exact after EOL normalization. Add a legacy/new export-identity and return-reference regression,and include the existing adapter CAS/idempotence/reopen tests. Terra first switches only the panel import;the actual four alert REDs must execute before its display repair. No crypto mock,hash algorithm change,guard removal,new dependency or extra consumer rewrite is authorized by this adjustment.

Current implementation is not yet accepted. Focused tests,actual alert RED/GREEN,complete regression,quality/build,independent source/runtime/artifact review and exact-path commit remain required.

- focused-initial actually exits0:9files198/198,including display59,MCP27,shared contract9,adapter8,global6,style13,blueprints10,executor64 and bilingual import boundary2. Main preservation reports are not additional REDs or claims every finite diagnostic is reachable from every driver.
- blueprint-alert-red actually exits1:four tests execute and all fail at the expected bare initial alert text. The pre-display Panel is705E8DC1,fixture87D6CB6F;this is distinct from the two earlier zero-test failures.
- Final Panel3B9DF499 uses only the existing displayedErrorMessage at the initial alert. browser-final actually exits0:3files34/34(new alert4,existing session11,existing setup19). No fixture/validator/hash mutation,real main-process IPC or visual-pixel qualification is inferred.
- impact-final actually exits1:15files361/363. Only two scan assertions fail:the new exclusion list omitted BUDGET_ in six template names,and the original vanished-code assertion independently catches those six nonexistent spellings. Retain both assertions and repair only the names;all production behavior tests in this report pass. The complete batch must be rerun after that correction,not described as a PASS.

## Coverage Classification And Final Verification

These are finite current-call-path classifications,not exemptions for arbitrary future code families:

| Codes | Current Boundary Evidence |
| --- | --- |
| Nine KNOWLEDGE_BASE_REFERENCE_BUDGET_ suffixes:INVALID,REQUIRED,EXHAUSTED,ACTIVE_TIME_EXHAUSTED,RECOVERY_UNKNOWN,HISTORY_UNBUDGETED,PLAN_CONFLICT,PERSISTENCE_FAILED,HISTORY_FROZEN | reference-global-driver.ts:73 finite set;reference-global-foreground.ts:85;import-run-failure.ts:29 existing template |
| KNOWLEDGE_BASE_REFERENCE_EXECUTION_ACTIVE | reference-knowledge-authority.ts:283;kb-controller.ts:148 existing template conversion |
| IMPORT_RUN_EFFECT_HANDLE_REQUIRED,IMPORT_RUN_EXECUTION_REQUIRED,BLUEPRINT_RANGE_INVALID | reference-blueprint-driver.ts:79 finite set;reference-blueprint-foreground.ts:85 existing template conversion |
| PROJECT_OPEN_SUPERSEDED | project-store.ts:664 discards superseded open response |
| EMBEDDING_REQUEST_ABORTED | embedding.ts:457 concurrent multi-batch branch;current production callers using signals use single batch,not a universal unreachable claim |
| GENERATION_IMPORT_CHANNEL_NOT_ALLOWED | preload.ts:35 closed internal-channel rejection |
| BLUEPRINT_NOT_FOUND | planning-feedback-repository.ts:139 actual caller;generation-controller.ts:132 folds failure to existing GENERATION_REQUEST_FAILED |
| GENERATION_RUNTIME_FEEDBACK_ADMISSION_REJECTED | generation-run-service.ts:175 unwraps original admission failure |
| GENERATION_RECOVERY_TAIL_SOURCE_CONFLICT,GENERATION_TAIL_PREFIX_MISSING,GENERATION_CLOSE_QUIESCE_FAILED | generation-run-service.ts:418 close AggregateError becomes existing project-close failure |
| GENERATION_WORKFLOW_DRIVER_EPOCH_CURRENT | workflow-batch-authority.ts:586 and workflow-driver-authority.ts:336 require changed epoch before recovery |
| GENERATION_IMPORT_QUERY_SEARCH_UNAVAILABLE | import-novel.command.ts:359 catches query unavailability and emits existing bilingual fallback |
| BLUEPRINT_CHANGES_INVALID_OBJECT,BLUEPRINT_NEW_CHARACTERS_NOT_ARRAY,BLUEPRINT_NEW_CHARACTER_MALFORMED,BLUEPRINT_RELATIONSHIPS_NOT_ARRAY,BLUEPRINT_RELATIONSHIP_MALFORMED | blueprint-feedback-validation.ts:40 retains guards;Panel:64 constructs only its existing four fields;blueprint-feedback-adapter.ts:85 wraps validation failures |

The complete impact-retest actually exits0:15files363/363,zero failed/pending/todo,36.17s. The four scanner assertions retain source coverage,registered/exempted conflict,vanished-code and duplicate checks,and enforce exactly25 separate presentation diagnostics. This repairs the prior53-code scan on current source without modifying ERROR_KEYS or main classifiers. The earlier scan failures remain historical failures,not retrospectively changed results. The separate browser-final34/34 is not added to the unit denominator.

Fresh authorized corepack pnpm run typecheck,lint(including colors),check:i18n and build each actually exit0. The source build completes renderer/main/preload but retains customResolver deprecation,invalid freeze option,large chunk,knowledge-base static/dynamic-import conflict and inlineDynamicImports deprecation warnings. No dependency installation,native rebuild,real provider,external MCP,Electron application launch or package qualification is performed.

Final production identities:app-errors58A152940AF4820ABE711033DE814DC3F92C7C3667C628F4FC707205C4FBBF5F;MCP storeEF164BF3C5449FD8F2C93CD334EDD41A40DE4B7E0F47DBAC5936B3FA67BDADD5;old contract5AAEA00D4F29CB9128A324988C7C1D24B562A960363EE03EAA6CDE96F4087598;pure validatorF66D929B9201108397E9DBDCEB49EE3EF8D6609FFBE181CF8DA3435561B2D7E6;Panel3B9DF49903B3367C540A835E3920A5A31E121673CFF9115F0196FF7F61376D27;scanner4733A2DF3C26EE3F29401512EE017F9CDE85B79264904E27BBDCC206C7861BE7. Sol independently reads these bytes,actual RED/GREEN/full reports and all fresh quality logs,and accepts only this bounded source/runtime/quality scope with no identified remaining correctness blocker.

Only five partial evidence entries are appended:IMPORT001,IMPORT002,FEEDBACK003 and MCP001 deterministic,UI003 browser. Removing exactly those five restores complete entryHEAD feature JSON semantics;all35 flags,gates,dependencies,required evidence and old records remain11completed/24in_progress. The first append preflight stopped before writes on an indentation guard;parser-derived existing indentation then produced only these appends,without reformatting the file. Manifest,independent nonowner artifact audit and root exact-path commit/postchecks follow.

No full import/imitation migration,complete visible feedback workflow,target adoption,A-to-B/background,arbitrary prose sanitization,MCP error UI wiring,real MCP/model/Electron project,literary quality,visual/viewport match,speedup,platform or cumulative35 qualification is claimed. Further feature work continues after this bounded stage is committed.

## Artifact Acceptance And Commit Boundary

Separate Agent4 Terra independently matches139/139 evidence plus3/3 protected identities,22actual owned paths,95source/test/config provenance,18distinct reported paths,9JSON/13logs/4actual RED screenshots and18actual freshly emitted build entries. Complete feature JSON,not only flags,equals entryHEAD after removal of the five partial appends. Its authored tests are independently accepted by Sol,not solely by this artifact audit. Sol's final wording review finds only the stale page-header status,now synchronized;historical pending/failure records stay as chronology.

Root separately repeats142/142 identities,exact owned set,empty index,unchanged entryHEAD and git diff --check. No active hooks,custom hooksPath,signing or fsmonitor is configured;all22 paths have filter unspecified,text auto,eol lf. Global LFS definitions exist but no owned path uses them. Only root performs authorized exact22-path add/commit and reviewed-raw-blob postchecks. Commit locator:fix(runtime): isolate diagnostic presentation from failure classification;actual SHA and postchecks are recorded after the commit,without amendment or duplicate action. Exact filters/report flags are preserved in each execution log;quality commands are corepack pnpm run typecheck,lint,check:i18n and build.

Stage69 committed e73c0a52f52bdad43165d2ef039505f05c6b5cde,parent40ebe9ef25d82be326a93e59d56183159d07bcf2,exact22paths. Postchecks match22/22 reviewed raw Git blobs and142/142 evidence/protected identities;index empty,tracked worktree clean,only the original two excluded Stage1B3 files untracked. Sol separately reread the final status correction before Git. This SHA closure is recorded in Stage70,not an amendment or repeated verification.

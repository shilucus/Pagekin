# Stage 49: Acknowledged Feedback Adoption And Local Draft Safety

Scope frozen: 2026-11-11, Asia/Shanghai. Entry a5f06f75237101997bfbf0d664cfa889254695ca, master. Stage48's four records match HEAD and the index is empty; only the two original excluded documents remain untracked. Nine of thirty-five features are completed. This stage is a narrow correctness increment for FEEDBACK-002/UI-002, not whole-feature acceptance.

## Scope, Output And Evidence Freeze

The actual setup page already invokes the v1 production client/controller/owner/repository and canonical single-field writer. It currently routes acknowledged adoption through form.update, treating durable C1 as an unsaved edit over F0; later discard can wrongly restore F0 in the editor. The dialog also creates a new time-based adoption key on each click, preventing same-operation receipt replay after a lost ACK. Repair these two observed call-chain defects without another database write, new IPC/store API, automatic retry or cross-instance persistence.

| Changed output / behavior | Exact basis and boundary |
| --- | --- |
| Acknowledged adopted setup field becomes the saved editor baseline; discard cannot restore old F0 | F2 section6.2 domain receipt/CAS and unsaved-buffer protection, FEEDBACK-002 AC2, accepted ADR-0041, existing partial saved publication in import-suggestions |
| Other dirty fields and target edits made after the adopt click remain unsaved and are not overwritten by the late ACK | Same accepted buffer/session contract and existing publishSavedNovelConfig none/current pattern; only the one adopted field's saved baseline advances |
| Clearing the target while adoption is pending does not implicitly close the already-open dialog | The same newer-edit protection includes empty, whitespace and optional undefined values. Keep its original instance mounted while open; an empty field still has no entry when closed. Explicit close remains an invalidation boundary. |
| A manual retry of the exact adoption in the same open dialog reuses its original full request binding; changed candidate/decision/text gets another key | F2 section6.2 idempotent candidate/payload/decision binding and existing receipt-before-CAS repository contract; no automatic resend or closed/reopened-dialog recovery claim |
| An old closed dialog's ACK cannot publish over a later saved field or close/toast over a newly opened dialog | Independently observed adopt-await -> existing Esc close -> same-session save/reopen -> old ACK race; original instance must still be valid before renderer publication. Keep Esc behavior and durable main receipt unchanged; closed-instance synchronization/recovery is explicitly not qualified |

No wording, buttons, layout, style, resource, new state design or author approval policy changes. Existing success/failure/stale/session behavior is retained. This corrects already accepted adoption semantics, not the separate missing dirty-before-start decision design. ADR-0042 remains Proposed; its time-based-key example is not authority to defeat the accepted replay contract.

## Team And Ownership

- selection_implementation owns only PlanningFeedbackDialog.tsx and its existing planning-feedback-adoption-session.browser.tsx. Its exported callback context freezes projectSession and baseTextAtAdoption before await; old single-argument consumers remain compatible. A per-open-instance structured identity map uses the existing UUID helper.
- report_implementation owns only StageSetup.tsx and new setup-feedback-adoption.browser.tsx. Six setup fields publish the acknowledged single-field saved base with the original session; current text versus click snapshot chooses none/current retention. No additional writer call, hook or store change.
- Root owns ADR/feature/log/review/evidence records, integration, serial project/browser/native/build commands and Git. Independent source and artifact reviewers are not implementers. Suitable inherited capable session model/effort remains selected without claimed override or substitution.

Disjoint source ownership permits parallel implementation. Shared native/build/Git and all verification execute serially under root. Existing project-store, useNovelConfigForm, architecture consumers, client/controller/owner/repository and contracts are read-only unless a demonstrated in-scope defect requires an explicit minimal scope amendment and fresh review.

Independent pre-execution review found two concrete boundary defects in the initial increment: frozenSession retained the caller's mutable object reference, and a closed old dialog could run success UI/onClose against a reopened dialog. The dialog owner copies/freezes the exact three session fields. Root initially proposed retaining closed-instance saved-base publication while suppressing only UI; BOTH independent reviewers then demonstrated that C1 ACK arriving after a successful manual save M (or newer C2 adoption) regresses the saved baseline. That intermediate decision is withdrawn, not accepted or run evidence.

The revised minimal repair synchronously invalidates the original instance on every actual close, with cleanup as a backstop. Successful renderer publication requires both the original current session and the original still-active instance BEFORE onAdopted, toast, onClose or state updates. It does not cancel/roll back a main-process commit or delete its receipt. A physically committed closed-dialog result may remain unsynchronized until normal authoritative refresh/history recovery: that boundary remains unqualified, not silently called a failed or cancelled adoption. No generic cross-writer revision facility, new close policy or automatic resend is introduced. The open-instance normal ACK/newer-unsaved-edit contract remains required.

## Verification Mapping

| Boundary | Required evidence |
| --- | --- |
| Actual renderer effects and author actions | Real createRoot/act browser mount of StageSetup and InkDialog; default production client with only window.aiNovelAPI.invoke replaced by a fictional bridge; capture/history/begin/execute/stage/adopt actually called |
| Single-field saved publication | All six setup fields clean after ACK; other dirty fields retained; discard returns acknowledged C1, not F0; newer target edits retained until discard; failed adoption does not publish |
| Session and lifecycle | A-to-B and same-path/new-lease late ACK causes no original-session success publication; existing session regressions remain |
| Mutable caller and closed-instance ACK | Mutating a caller-owned session object cannot alter the frozen context/binding. Actual Esc close/reopen preserves the new dialog. C1 physically commits before ACK, then close and later M save/C2 adoption precede old ACK: no stale publication, baseline rollback, old UI callback or discard-to-C1; original durable effect/receipt remains |
| Lost ACK and exact binding | One fictional bridge effect, failed first ACK, no automatic retry; real second click reuses key/receipt; text/decision/candidate identity changes isolate keys |
| Actual writer replay | Native repository/service/owner and production-client regressions retain receipt-before-CAS, same-key mismatch rejection, stale-session/source and no-replay guards; browser fake is not SQLite evidence |
| Integrated quality | Authorized typecheck, lint/color, i18n, focused native package, browser suite and serial source build on frozen final bytes; independent source review plus actual raw artifact review, repair/retest/re-review as required |

Browser script is Vitest with the reviewed vitest.browser.config.ts: headless Chromium on an ephemeral127.0.0.1 API port, serial files, fictional stores and local browser/test caches only. No dev server, real Electron profile/project/configuration/model or externally authenticated browser session. Browser installation is not included. Native fixtures use in-memory/new isolated fictional databases and their reviewed cleanup. Exact commands, source identities, raw counts/failures and final review follow actual execution.

## Remaining Boundaries

Dirty-before-start policy, candidate history/reopen discovery, closed-instance committed-result synchronization and cross-instance lost-ACK recovery, v2/v3 page mounting, full downstream-impact presentation, other feedback targets and complete FEEDBACK-002/003/UI-002 qualification remain separate. Ignoring a closed instance's ACK is not proof that its domain write failed, was cancelled or rolled back. No feature is promoted by this repair freeze. No real-model quality, visual fidelity, platform or full35 qualification is implied.

## 2026-11-12 Resume Checkpoint

Root re-read the current worktree at the same entry SHA rather than repeating completed Stage48. The index is empty; the repository-analysis and two original Stage1B3 document hashes remain excluded. Existing Stage49 tracked/untracked changes are preserved and included only after current integrated review and execution.

Team: adoption_test_owner (gpt-6.1-terra/high) owns only the two browser regressions; adoption_source_review (gpt-6.1-sol/high) independently reviews actual source/callers. Root owns source integration, shared records, serialized commands and Git. ready_feature_audit (gpt-6.1-terra/high) and feedback_completion_audit (gpt-6.1-sol/high) independently inspect subsequent feature readiness without edits or execution. These are actual selected models, with no substitution. No Graph/AST/LSP service is exposed; direct definitions, import/calls, targeted search and actual tests bound the evidence instead.

Fresh source review found the nonempty-field entry condition unmounted an open dialog on a newer empty/undefined target edit, contradicting the existing newer-edit contract. Root's minimal source repair keeps an open instance mounted, retaining explicit-close invalidation and the existing closed empty-field entry policy. The test owner also replaces the contradictory withdrawn closed-ACK expectation and separates the fictional commit from delayed ACK, covering later manual save/new adoption before the old response. No old draft review or failure is relabeled as acceptance.

## Execution Corrections And Wide-Package Failure

The first browser command passed an extra `--` through pnpm11, so filters/report flags were not applied. Before any test ran Chromium launch failed because the expected headless1217 was absent (exit1, zero tests). No install was attempted. Root uses the existing headless1228 through the already-supported process-local AI_NOVEL_VITEST_CHROMIUM override and removes the extra separator.

The actual six-file wider package then exited1:96 tests,95 passed/1 failed, zero pending, raw `.runtime/creation-runtime-modernization/recheck-2026-11-12/stage49-browser-initial.json`. The sole assertion failure is the unchanged architecture.browser action list omitting the existing feedback entry. Its deliberately injected DB read failure also emits one unhandled rejection in the actual console; the JSON has no separate global-error count. Both underlying architecture production paths and their old tests already exist at entry HEAD and are unchanged in this stage. The failure and console observation are retained, not suppressed or counted as a pass. The overview detached-load failure requires its own error-propagation scope rather than an unreviewed catch or new visible error design.

Independent reviewer adoption_source_review read the raw report and entry sources and accepts five directly relevant browser files as this narrow stage's required package: the two adoption files, setup.browser, stage-architecture-adoption.browser and architecture-guidance-layout.browser. That five-file package must execute afresh after the final fixture correction; it is not computed by subtracting the sixth file's failure, and cannot qualify the full architecture UI or UI-002. Root keeps the wide-package defects as explicit subsequent work.

Fresh source re-review also rejected the initial C2 bridge evidence: it returned the consumed F0 instead of current committed C1 on reopen. The owner corrects capture/history to current committed values with new base/run identities; before C2 the author explicitly saves C1 using the existing store/project-save path. This only tests renderer/client interleaving with a fictional bridge, not SQLite or automatic closed-instance synchronization. The earlier95/96 execution does not verify the corrected fixture; final execution follows.

## Final Actual Execution

Environment: Windows x64, Node24.13.0, Corepack pnpm11.11.0, Vitest4.1.12, existing local Chromium headless1228. No dependencies or browsers installed/upgraded, no real data/model/profile, no Electron execution or platform packaging. Root ran the following from the repository root, serializing native, browser and quality/build execution. Test outputs/caches and newly created fictional fixture roots are the only test writes; the native fixtures close their SQLite handles and clean only their own newly created directories.

```text
corepack pnpm test src/shared/__tests__/planning-feedback.test.ts src/shared/__tests__/planning-feedback-ipc.test.ts src/services/__tests__/planning-feedback-client.test.ts electron/repositories/__tests__/planning-feedback-repository.test.ts electron/services/__tests__/planning-feedback-service.test.ts electron/services/__tests__/planning-feedback-owner.test.ts electron/services/__tests__/planning-feedback-generation.test.ts electron/services/__tests__/planning-feedback-portable.test.ts src/stores/__tests__/project-editor-draft-ledger.test.ts src/stores/__tests__/project-refresh-context.test.ts src/services/__tests__/ipc-client-project-session.test.ts --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-12/stage49-native.json
corepack pnpm run test:browser src/components/stage/feedback/__tests__/planning-feedback-adoption-session.browser.tsx src/components/stage/setup/__tests__/setup-feedback-adoption.browser.tsx src/components/stage/setup/__tests__/setup.browser.tsx src/components/stage/architecture/__tests__/stage-architecture-adoption.browser.tsx src/components/dialogs/__tests__/architecture-guidance-layout.browser.tsx --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-12/stage49-browser-final.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
```

For both actual browser executions the existing config's process-local AI_NOVEL_VITEST_CHROMIUM points to installed headless1228; no persistent environment/configuration changed. The wider failed browser command was the same corrected form plus `src/components/stage/architecture/__tests__/architecture.browser.tsx`, with outputFile `stage49-browser-initial.json`. The initial zero-test launch command instead had `test:browser --` and requested `stage49-browser.json`, which was not produced. No byte-for-byte stdout capture or initial browser-fixture source hash is retained; the observed exit codes/console details are root's execution record, not independently reconstructed artifacts.

| Actual package | Per-file assertions |
| --- | --- |
| planning-feedback-repository.test.ts | 145/145 |
| planning-feedback-service.test.ts | 11/11 |
| planning-feedback-owner.test.ts | 74/74 |
| planning-feedback-generation.test.ts | 5/5 |
| planning-feedback-portable.test.ts | 23/23 |
| planning-feedback-client.test.ts | 72/72 |
| planning-feedback-ipc.test.ts | 71/71 |
| planning-feedback.test.ts | 30/30 |
| project-editor-draft-ledger.test.ts | 6/6 |
| project-refresh-context.test.ts | 12/12 |
| ipc-client-project-session.test.ts | 14/14 |
| planning-feedback-adoption-session.browser.tsx | 11/11 |
| setup-feedback-adoption.browser.tsx | 19/19 |
| setup.browser.tsx | 22/22 |
| stage-architecture-adoption.browser.tsx | 5/5 |
| architecture-guidance-layout.browser.tsx | 3/3 |

Native:11 files,34 nested suites,463/463,zero failed/pending,exit0. Final browser:5 files,12 nested suites,60/60,zero failed/pending,exit0. Actual browser console includes React act warnings; they are not hidden or counted as runtime errors, and no complete browser-suite or zero-warning claim is made. Native and browser cover different layers: real SQLite writer/receipt/CAS/portable regression versus fictional bridge with actual renderer/client/store/form and author actions. Source re-review specifically read the corrected F0/C1/M/C2 capture identities and explicit save sequence; no new automatic synchronization is implied.

Each quality/build command exited0 on the final source bytes below. Lint includes color-literals and had no ESLint warnings. Build retained existing Vite/Rolldown alias/option deprecation, chunk-size/dynamic-import and plugin-timing warnings; no unrelated build configuration or dependency change was made. The build is not Electron runtime, packaging, literary quality or target-platform evidence. Native-tested main/client/repository bytes are unchanged from entry; browser-fixture changes after native execution do not change those tests' production dependencies.

## Frozen Final Identities

All other tracked source, tests, configuration, scripts and dependencies remain the entry SHA. The four changed/new source/test files and two ADR edits are frozen by the following SHA256 values; raw reports remain local under the relative output directory above.

| Artifact | SHA256 |
| --- | --- |
| src/components/stage/feedback/PlanningFeedbackDialog.tsx | BE15D3DB4D18B55F597C335C9A3D5D916EB205769A754C8539E349925FB1A389 |
| src/components/stage/setup/StageSetup.tsx | 748BC900C55D2C7A98016876881596FC29A72F246B09091C50C5FBECED83282C |
| src/components/stage/feedback/__tests__/planning-feedback-adoption-session.browser.tsx | BDA2C1D4741E2E88923E46D5A7155FD3C51F3C56FE9B380724CB18212D88F421 |
| src/components/stage/setup/__tests__/setup-feedback-adoption.browser.tsx | 23775DC1C4D271B196798905530AFFD16EC6287383FAC6177D72C90758FE1A10 |
| docs/adr/0041-planning-feedback-candidate-diff-adoption-ui.md | 042CCA2E91C4107A427512B63988979E00623B417B8BD9C51FD098F3A78D01F3 |
| docs/adr/0042-planning-feedback-ui-partial-adoption-and-architecture-entry.md | 07474A0BE738C470C29E62DE7E080C6FDDEC8ED57F53363676F8261469D043DB |
| stage49-native.json | C507D1BE3C9893ABDEC9F84C9B9C4C19CDB3817D85A77C378795005E514CCB75 |
| stage49-browser-initial.json | D7E7CD1134DE901E214EA803E65C22D0FD222D38859C059F54C97CF2542C7FC2 |
| stage49-browser-final.json | 3DE57FDDE08ABDCAD900422EB00467DAC1301E343115845B72C98AD30F22DD65 |
| dist/index.html | 42FCAA85CA90016C69AD78633800E3848513EA2E4CADAD1CD75C3DE42F31D3A1 |
| dist-electron/main.js | EABC1D5582D4C923CA0BBDF6401403AE037747792A7DDC1C57E38DD1DB202B5E |
| dist-electron/preload.mjs | CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B |

## Independent Final Review And Commit Boundary

adoption_source_review freshly reread the integrated source, corrected fixtures and both passing raw reports; the implicit empty-target unmount, withdrawn closed-ACK expectation and unrealistic C2 source have been closed. No remaining correctness blocker was found in this narrow Stage49 increment. The reviewer did not execute commands. Separate stage49_artifact_review independently matched all twelve final identities, three raw denominators/hashes, the original exclusions, empty index and feature-state/record consistency, finding no artifact blocker. Neither reviewer reran tests/build; unarchived console/exit/source-time-binding evidence remains root's actual execution record.

FEEDBACK-002 and UI-002 remain in_progress/false;9/35 are complete. Full dirty-start/history/closed-result synchronization, downstream impact, range/blueprint UI and the wider architecture failure remain unqualified. Root will commit exactly ten owned paths (four source/tests, two ADRs, features/log/review/this evidence) after final evidence review, empty-index/hooks/exclusion and diff checks. Commit locator: `fix(feedback): preserve adopted baselines and replay identity`; the actual SHA is recorded at the next checkpoint, avoiding a self-referential hash. No original Stage1B3 file, repository-analysis, generated build/raw output, plugin or unrelated path is included.

# Stage 34: Current-source revalidation and safety corrections

Date: 2026-11-10. Entry baseline: `8baf0225917a660a441a99b15ff0d4fb0e100f17`, branch `master`.

## Scope and authority

The current user explicitly authorizes implementation of all 35 F2 features, the listed pnpm commands, fictional isolated persistence tests, and path-scoped local commits. Historical planning-only authority is not an implementation restriction. Design, human approval, policy, privacy, model and platform gates remain in force. No DSH changes, real models/configuration/manuscripts, dependency upgrades, system configuration, remote writes or packaging/install operations are included.

Startup `git status --short` contained only the pre-existing untracked `stage-1b3-evidence.md` and `stage-1b3-source-manifest.json`. The index was empty. Neither file nor `docs/repository-analysis-2026-11-07.md` belongs to this stage. The two 1B3 files describe an older, unfinished measurement contract and are not current-build evidence.

This stage preserves F2 and its acceptance criteria. It corrects completion claims, establishes current-build observations, and restores three existing safety contracts: legacy import switching protection, unmodified authority hashes, and non-destructive post-adoption editor refresh. It does not complete the missing import/automation production chains or invent new UI states.

## Team and source review

| Assignment | Actual model / effort | Ownership |
| --- | --- | --- |
| Coordinator | inherited session configuration | Integration, shared records, commands, Git |
| Runtime/driver/scheduler audit | gpt-6.1-sol / high | Read-only production routing and lifecycle |
| Feedback audit and assigned architecture correction | gpt-6.1-terra / high | Architecture component and focused tests only |
| Import/performance audit and assigned protection corrections | gpt-6.1-terra / high | Background qualification, snapshot guard and focused tests only |
| Automation/acceptance/headless audit | gpt-6.1-sol / high | Read-only production reachability and evidence |
| Completion evidence auditor | gpt-6-luna / high | Independent record/gate review, no writes |

No substitutions. The implementers are not sole verifiers of material corrections. Independent reviewers receive integrated sources and raw reports. There is no exposed CodeGraph, AST or LSP service; static coverage uses bounded definitions, direct callers, registered boundaries, repositories and test sources. Static audit is not runtime qualification.

## Completion correction

Keep the existing package-local acceptance for `FEEDBACK-001`, `RUNTIME-001/002/003` and `DRIVER-001/002`. Their earlier fixed-source evidence and accepted scoped ADRs remain relevant; globally pending gates do not retroactively invalidate a specifically accepted package. Current regressions are recorded separately.

The other 29 items return to `in_progress/passes=false`. Existing source and historical evidence are retained, not relabeled as absent or as current runtime proof. The plan status returns to `in_progress`; no schema field or acceptance condition is weakened.

| Features | Concrete remaining gap established at entry |
| --- | --- |
| PERF-001 | Current 10/100/1000 and pressure sampling/independent acceptance not yet complete |
| PERF-002 | Production renderer does not provide the representative-chapter delegate; it still scans all chapter pages |
| PERF-003 | Guard silently replaces a mismatched authority hash; current Electron/performance coverage incomplete |
| PERF-004 | Yield occurs after synchronous full-file parsing; actual stall/CPU/RSS/cancel evidence incomplete |
| SCHED-001 | Deterministic pool exists; production physical-request/cancel/equivalence and performance evidence incomplete |
| SCHED-002 | Generation broker exists, but embedding/direct LLM/discovery/probes and common domain claims are not all connected |
| IMPORT-001/002 | Renderer orchestrator remains the workflow owner; full main-process deconstruction and imitation migrations must be accepted separately |
| IMPORT-003/004 | Synthetic repository writes do not prove two actual production import/imitation workflows |
| FEEDBACK-002 | Author workflow/history/dirty-buffer acceptance remains incomplete; architecture has a redundant post-CAS writer |
| FEEDBACK-003/004 | Extended UI and adapters lack production candidate/proposal entry chains |
| UI-001/002/003 | Missing exact design/state and browser/Electron acceptance; helpers or static rendering do not qualify the workflow |
| API-001/CLI-001 | API controller is not production-composed; start synthesizes running/success events, and CLI can mistake acceptance for completion |
| AUTO-001/002/003 | Grants/steps are not fully persistent/production-bound; scratch unknown retry and synthetic evidence are correctness defects |
| ACCEPT-001/002/003 | Report/approval/finalization classes lack the real authority/transaction chain; await/unfreeze and concurrent commit races remain |
| MCP-001/SKILL-001 | Classes/static simulation are not an inbound transport or actual agent workflow |
| QUAL-001 | No current complete-chain performance and authorized real-model quality proof |
| QUAL-002 | Profile tests are not three-target installation/native/desktop evidence |
| HEADLESS-001 | Helper is not a production host; lock is non-atomic and desktop/commit fencing is not integrated |

The blueprint merged-identity helper merits a bounded contract test when its real candidate path is integrated. The initial audit's proposed persisted-old-relationship reproduction was not established: the current blueprint repository does not persist those proposal fields in blueprint rows. It is not reported as observed user data corruption.

## Frozen baseline and commands

All commands run at the project root using the existing pinned Corepack pnpm `11.11.0` and Node `24.13.0`. No installation or native rebuild was needed. The actual scripts/configuration/setup files and driver cleanup/network/isolation boundaries were read first. Build and scratch ancestors were checked for reparse points. No Electron process was running at the preflight query. The 30/30, 74/74, typecheck and build results below precede the safety source corrections; they establish the entry baseline and do not validate the new regressions.

- `corepack pnpm run typecheck`: exit 0.
- `corepack pnpm test src/shared/__tests__/performance-baseline.test.ts electron/services/__tests__/performance-diagnostics.test.ts electron/services/__tests__/import-generation-targeted-selection.test.ts electron/services/__tests__/stream-snapshot-deduplication.test.ts`: exit 0, 4 files, 30/30.
- `corepack pnpm test scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs scripts/redesign/__tests__/drive-profile-writes.test.mjs scripts/redesign/__tests__/drive-quit.test.mjs`: exit 0, 4 files, 74/74.
- `corepack pnpm run build`: exit 0; rewrote only existing build outputs. Existing Vite alias/output/deprecation and chunk-size warnings remain warnings, not platform acceptance.
- `corepack pnpm run verify:drive -- --scenario perf-import-10 --theme light --out .runtime/creation-runtime-modernization/recheck-2026-11-10/baseline --console`: exit 0.
- Same drive command for `perf-import-100`: exit 0.
- Same drive command for `perf-import-1000`: exit 1; original 600-second workflow deadline expired. Cancellation drained; the application required forced quit. The failure remains in the denominator.
- Same drive command for `perf-long-stream`, `perf-slow-embedding` and `perf-rate-limit`: each exit 0. Rate-limit success means the expected HTTP 429/unknown stop was observed, not that generation succeeded.

`PAGEKIN_PERFORMANCE_SOURCE_SHA` is set to the entry baseline only for each drive child, then its prior value is restored. The baseline measures the frozen committed build, not later unbuilt source corrections. No build/test/native command runs during a scene. Build outputs, drive and performance scenario/collector source files stay unchanged through the measurement window. The fake-only driver launches an owned off-screen Electron and loopback server, overrides profile/home/temp/business roots, compares real-profile metadata without reading its content, drains/quits its own process, and retains failed roots. It never uses `--real-model`.

Build identity:

| Item | SHA256 |
| --- | --- |
| dist/index.html | 8711D5044BCF3373F2F6CF26029E50B60E53914274F64DB202E9A1C19B67A5F6 |
| dist-electron/main.js | 3297FC4692BD3E1071E190F59ABB358F28DF1D991E02D4EF2660C7FB4252B893 |
| dist-electron/preload.mjs | CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B |
| scripts/redesign/drive.mjs | 518BFFF6844ADDD13FDBF36EE560218367E2D54D9BE81DEE7B953029FC14B767 |
| scripts/redesign/performance-scenarios.mjs | C52D5DB37058B7B3FE2082D679052FD7294B4E4B991358ED4993A9B26B9FF899 |
| scripts/redesign/performance-baseline.mjs | B869E1C3338AE00F57E96D5C7815662D6B1F44106866C46E4DD29570C513C46F |

The observed build trees contain 283 files / 107425417 bytes, including residual unreferenced files. Tree digest `E6B09AC81CBB314C76C1C88DFEFF44FC69B65219A05AC1FA43395F3096B25880` is SHA256 of UTF8 compact PowerShell JSON `[{path,sha256},...]`, paths relative to the repository with forward slashes, sorted case-sensitively. This is not an installer or clean-output qualification.

## Baseline observations

Raw reports and personally inspected screenshots are under [the isolated baseline output](../../../.runtime/creation-runtime-modernization/recheck-2026-11-10/baseline/). Windows x64, Intel i5-9400F, 34299277312 RAM bytes, Electron 44.9.3 / embedded Node 24.22.0 / Chrome 152.0.7977.167, viewport 1440x900 light, uncontrolled disk cache. All requests use deterministic local fixtures, not a provider quality experiment.

| Scene | Workflow elapsed | Physical requests | Saved manuscript / blueprints | Result |
| --- | --- | --- | --- | --- |
| perf-import-10 | 20453.06 ms | 32 | 10 / 10 | Passed; normal quit, no external writes/ignored writes/requests/residual processes, no requests after cutoff |
| perf-import-100 | 95655.66 ms | 302 | 100 / 100 | Passed; same clean isolation/quit/cutoff checks |
| perf-import-1000 | 613373.24 ms | 1280 | unavailable / unavailable | Failed: workflow TIMEOUT, cancellation drained, forced quit; no requests after cutoff or residual processes |
| perf-long-stream | 34285.69 ms | 2 | not applicable | Passed: 400 visible and 20 reasoning fixture chunks, normal quit and clean isolation |
| perf-slow-embedding | 5614.51 ms | 1 embedding | 1 document / 1 chunk | Passed: approximately 2-second network hold, normal quit and clean isolation |
| perf-rate-limit | 22884.51 ms | 1 failed / 1 HTTP 429 | no visible artifact | Passed expected-failure scenario: 1 unknown, no resend, normal quit and clean isolation |

Raw report SHA256: `perf-import-10-light.json` = `B1C8A8E01AD4C62B3D4A792F4D89D104AA7B6312163A9D32665DBB100D4AE24B`; `perf-import-100-light.json` = `2574ACCECB3232482BBC505C630FB7CC9EE023F27D2FB16D09C3D8631C98FFFB`.

Remaining raw report SHA256:

| Report | SHA256 |
| --- | --- |
| perf-import-1000-light.json | 5C997122E45A2DB844818524DE4C08E6FB8712FFD924E2F27AD45EF164B3DADD |
| perf-long-stream-light.json | CD0C318AE339BD5C33B238D968D6E4C254597645CA149A2565608D6129A92876 |
| perf-slow-embedding-light.json | B10DF2CB89254DC2D905BB4CF21950AE13475AF60578FA9AB2C870DBFFAEC6C9 |
| perf-rate-limit-light.json | A70C52D0FAB8583E4613BF899C08E07E77452DFC02FBA0F57B72ACB6ED43616F |

The build-tree digest was rechecked after all six scenes: unchanged, 283 files / 107425417 bytes. Baseline total: 6 attempted, 5 successful scenarios, 1 timeout failure. No timeout/corpus reduction, warm-cache claim or rerun replaced the failed sample. The 1000-chapter main event-loop maximum was 745.01 ms and RSS maximum 620351488 bytes; renderer heartbeat maximum delay was 22.9 ms. These are different sampled signals, not proof of a single freeze cause. Counts unavailable from the failed workflow are not replaced by UI counters.

Reports retain their actual observed signals and explicit coverage, not a complete set of signals for every scenario. All six have corpus hash, attempted/failed denominator, event-loop distribution, renderer heartbeat and RSS. Import/long-stream reports include applicable read/selection, transport, usage and snapshot data; slow embedding and HTTP 429 label non-applicable signals. In particular, the 1000-chapter failure has `rendererSnapshots:not_observed` and no renderer snapshot/queue metrics; counts and signals unavailable there are not inferred. One book executed; two/four books explicitly unsupported/not executed for these scenes. Network observation covers before quit, not arbitrary remote execution. Raw local driver reports also contain local paths and device metadata; they are not fully anonymized export artifacts and are not committed or safe to publish as-is.

Screenshot checks: the 10-chapter image shows import title 10, blueprint 10/100 and finalized 10/100; the 100-chapter image shows import title 100, blueprint 100 and finalized 100/100. Both retain the fixture's project target 100 chapters / 3000 words, core text count 25, one suggested difference and current 3000 vs inferred 860. The completed status and chapter counters agree with the raw report. The 100-chapter run's 45-second continuity and 33-second blueprint steps explain most of its wall time; neither is evidence of a frozen UI. No visual-fidelity or literary-quality claim follows from these screenshots.

The failure screenshot is `perf-import-1000-light.failure.png`, not the nominal `.png` path printed in the report. It shows cancellation in continuity processing, subsequent analysis/blueprint steps not completed, and UI manuscript counter 1000/100; this does not establish a successful full import. Its DOM/accessibility artifacts are retained. The long-stream screenshot shows a completed draft run and a 9200-unit draft, the embedding screenshot retains the pre-existing review screen, and the 429 screenshot shows a failed draft run with no saved draft/chapter claim. All were personally inspected at the same 1440x900 light viewport; no new visual design is inferred.

## Corrections, review and acceptance

The import implementer restores the existing switch protection until the full driver is migrated: `novel_import` cannot bypass cancellation/waiting even with an explicit background marker. The snapshot guard no longer rewrites a mismatched authority hash; the existing renderer rejects it before displaying text. The architecture callback no longer performs a second fact write after adoption and refreshes only a clean same-project tab. The real feedback dialog rechecks its frozen session after the adoption promise resolves, suppressing stale UI callbacks without rolling back committed facts.

Independent runtime review found an old full-chain assertion still qualifying import; it was corrected. Its requested guard-to-renderer combination regression was added. Independent architecture review found same-path/new-lease late adoption could refresh a reopened project; the post-await guard and real-dialog tests close that issue. Both reviewers re-read the integrated changes and reported no remaining source-level blocker. Their source review does not substitute for execution.

Actual post-correction checks so far:

- `corepack pnpm test src/shared/__tests__/workflow-background-qualification.test.ts src/stores/__tests__/project-transition-background.test.ts electron/services/__tests__/stream-snapshot-deduplication.test.ts src/services/generation/__tests__/generation-runtime-owner.test.ts electron/__tests__/full-chain-quality-and-performance-regression.test.ts`: exit 0, 5 files, 63/63.
- `corepack pnpm run test:browser src/components/stage/architecture/__tests__/stage-architecture-adoption.browser.tsx src/components/stage/feedback/__tests__/planning-feedback-adoption-session.browser.tsx`: first attempt exit 1 before tests because pinned Chromium headless-shell 1217 is absent. No browser was installed.
- Same browser command with process-local `AI_NOVEL_VITEST_CHROMIUM` pointing to existing Chromium 1228 / 149.0.7827.55: exit 1, real dialog 3/3 passed, architecture suite import failed due to an incomplete resource-protocol mock. This is a test-fixture defect under repair, not an acceptance.
- `corepack pnpm run typecheck`: exit 2 for overly broad mock callback types in the new dialog test. `corepack pnpm run lint`: exit 1 for two unnecessary test semicolons. Both require repair and rerun; no suppression is added.
- `corepack pnpm run check:i18n`: exit 0.

The test implementer corrected only the incomplete partial mock, callback signatures and unnecessary semicolons. No assertion or production protection was removed. Independent architecture re-review found no blocking finding in those fixture changes.

Final post-correction execution:

- Same two-file browser command with the existing Chromium 1228 process-local override: exit 0, 2 files, 8/8. The prior environment/import failures remain recorded above. The override is restored after the child exits; no global configuration or browser installation changes.
- `corepack pnpm run typecheck`, `corepack pnpm run lint`: each exit 0 after the fixture repairs; lint includes the color-literal check. The earlier i18n exit 0 remains applicable because no subsequent copy changes occurred.
- `corepack pnpm run build`: exit 0 after all source corrections; the same pre-existing build warnings remain.
- `corepack pnpm run verify:drive -- --scenario perf-long-stream --theme light --out .runtime/creation-runtime-modernization/recheck-2026-11-10/stage34 --console`: exit 0 against the corrected build. Source metadata is deliberately null rather than falsely claiming an unmodified commit; entry SHA plus the exact source blobs below identify this pre-commit version. The report is `A978A5CD51F60194E4200DAFDCBE9D999CD2C385F982B4661D1F9993DCB0B44E` (SHA256). It records 2 requests / 2 settled / 0 unknown, 400 visible + 20 reasoning fixture chunks, 33696.97 ms, normal quit, no cutoff requests, external requests/writes/ignored writes or residual processes. Its screenshot was personally inspected and shows the completed run and 9200-unit draft, not literary quality.
- `git diff --check`: exit 0. This is a whitespace check, not runtime evidence.

Corrected build SHA256: `dist/index.html` = `2DE91BDAECB53CC184EC5DCB7D5A6ED83BE542C41739E379E9C23917EFEC3F0A`; `dist-electron/main.js` = `A23E4EC7B185777EA5236665FC73801E84B40262F925D3858E611C8FA63218E9`; preload remains `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B`. These are source-build artifacts, not packaged-platform qualification.

Frozen corrected-source Git blob identities over entry baseline (computed without writing objects):

| Path | Git blob |
| --- | --- |
| electron/__tests__/full-chain-quality-and-performance-regression.test.ts | 99d7bebc1f9afee68b98eb3c733ad7bab8e1c1bd |
| electron/services/__tests__/stream-snapshot-deduplication.test.ts | f50fbb9862e0c0dc1e36b0d8acb0ac3976382c59 |
| electron/services/stream-snapshot-guard.ts | 0438515dea9739f5185aadc46a873e320eae12b6 |
| src/components/stage/architecture/StageArchitecture.tsx | 9c2291465147096bf073bedf7109ad2a4d371395 |
| src/components/stage/feedback/PlanningFeedbackDialog.tsx | 777981bf330a176fa752f7ce8d80aa145449fca0 |
| src/components/stage/architecture/__tests__/stage-architecture-adoption.browser.tsx | 3b465524e2eeb178e83dae8460ecc81c5899eb80 |
| src/components/stage/feedback/__tests__/planning-feedback-adoption-session.browser.tsx | 4ee59b213472cab74c59a4c89af8359bc0858258 |
| src/services/generation/__tests__/generation-runtime-owner.test.ts | 0e25e08a6a3ca9518d6a1b182a3d543610f63edd |
| src/shared/__tests__/workflow-background-qualification.test.ts | cc7c9b991ddd45eb5cd2de2eb5d257294784d8bb |
| src/shared/workflow-background-qualification.ts | 44a0f7d3a722bc1d20cf69e55a02aa36cb6e40e6 |
| src/stores/__tests__/project-transition-background.test.ts | df63e543721bf2ac3dccd537c4b767b1d673cd9b |

Final independent verdicts: runtime/source reviewer accepts this protection-only package with no must-fix or must-add-test item; architecture reviewer finds no blocker after fixture repairs; evidence reviewer confirms all six baseline hashes/reports, the corrected long-stream receipt and all 11 source blobs, and permits the scoped commit. None claims independent test execution or full feature acceptance.

No feature is promoted by this stage. The three protection-contract categories include the architecture adoption dialog's origin-session callback guard. Important source corrections have separate independent reviewers and actual focused/browser/Electron evidence, but full import migration, feedback history/dirty-origin design, uniform admission and automation remain incomplete. The 1000-chapter timeout, absent pinned browser, missing real-model/three-platform evidence and raw probe limitations remain visible. The scoped commit will contain these 11 source/test files and the three Stage 34 records only, with the pre-existing index/files excluded.

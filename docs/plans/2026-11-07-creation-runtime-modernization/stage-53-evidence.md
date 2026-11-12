# Stage 53 - Inspection Chooser Cancellation And Close Drain

## Frozen Scope

Date: 2026-11-12. Entry HEAD: 910541848afb2370c09804bdda1e79cc976adbb4, master. This increment supplies missing lifecycle observations for PERF-004 after the measured Stage52 same-content fingerprint reuse. It does not introduce inspection cancellation, a Worker, a new persistent writer or a visible application difference. At the freeze nine features were completed and twenty-six in progress; the final independent acceptance below permits only PERF-004 to advance.

The existing structured inspection acquires a main-process legacy operation before the chooser and retains it through safe read, parsing and reference preparation. Existing db:close seals new work, drains this admitted operation, closes the database and invalidates the captured session. Thus close waits for the inspection; it does not cancel synchronous parsing. A chooser result of cancelled returns before reference-run creation. Sources: [PERF-004 acceptance](features.json), [F2 scope](README.md), [ADR0063](../../adr/0063-measurement-driven-parsing-and-computation-optimization.md), the actual import/db controllers and project-runtime lifecycle.

| Increment | Actual route and acceptance | Verification mapping |
| --- | --- | --- |
| author close, 1000 chapters | Hold only the native chooser replacement; start real structured inspection and concurrent db:close with the frozen session, observe both pending at close entry, release the real corpus file and drain both; then reload and reopen under a new lease | New orchestration regression, existing import/runtime/db-context regressions, one isolated Electron scene |
| reference close, 1000 chapters | Same drain; reference prepared/ready snapshot must survive actual close and reopen and read back under the new lease | Full reference-summary checks and one isolated Electron scene |
| reference chooser cancellation | Return cancelled chooser result; inspection and unique run readback are null; actual inspect/cancelled counters observed and read/parse/hash/save events absent | Cancellation/error/cleanup regression and one isolated Electron scene |

Only dialog.showOpenDialog is replaced. The secure filesystem, input/path/size/session checks, real parser, database and close service remain production implementations. The fictional corpus and fresh isolated projects reuse the Stage51 helper. Direct db:close temporarily leaves stale renderer state; no further project IPC is allowed before reload except the explicit project-independent runtime-context observation. Probes stop before reload, then the actual project:open receipt supplies the fresh lease. No real model, user project/config/profile, adoption or finalization is used.

## Ownership And Gates

- Agent1 Luna (gpt-6-luna/high): new lifecycle scene module and only the necessary exports of existing inspection validators.
- Agent2 Terra (gpt-6.1-terra/high): new lifecycle orchestration regression file, disjoint from implementation.
- Root: driver registration, closed numeric/boolean/enum output projection and its regressions, shared records, serial project commands and Git.
- Agent3 Sol (gpt-6.1-sol/high): independent integrated source/contract/error/drain review. Agent4: separate raw-report/identity/state review after execution. Implementers do not solely accept their own changes.

Pending promises must attach rejection handlers immediately. Failure cleanup releases the gate, waits boundedly for admitted work, restores exact chooser/IPC observers and retains the original failure. No forced quit, missing counter or absent measurement may be relabelled as successful convergence. Close duration includes held chooser and remaining safe read/parse/commit, not isolated database-close cost. No active-parse cancellation or latency threshold is promised.

Before executing, root inspects the actual commands and their side effects. Authorized native tests write only their isolated fictional fixtures, Vitest cache and .runtime reports; typecheck/lint/i18n are source checks; build writes dist and dist-electron. Reviewed verify:drive scenes create fresh VibeCodingScratch children and .runtime evidence, and clean only successful checked isolation trees. Native/build/Electron execution is serial. No install, real-model flag, platform package or remote action is needed.

Required sequence: integrated independent source review; focused new/related native regressions; fresh typecheck/lint/color/i18n; serial source build if required by source identity; three serial reviewed no-model Electron scenes; raw/PNG inspection, source/build/report hash binding and independent final source/artifact review; exact-path scoped commit only after all stage gates pass. Failed runs and fixes remain in the record. This document is a scope/verification freeze, not a passing result.

## Actual Execution

Execution: 2026-11-12; final records/review continued on 2026-11-13. All commands below ran from the project root using corepack pnpm11.11.0 and driver Node24.13.0. The actual Electron runtime was44.9.3 / Node24.22.0 / Chrome152.0.7977.167, Windows x64, i5-9400F, RAM34299277312 bytes. Hardware identity is opaque in exported reports. No install was required.

```powershell
corepack pnpm test scripts/redesign/__tests__/performance-inspection-lifecycle-scenarios.test.mjs scripts/redesign/__tests__/performance-parse-scenarios.test.mjs scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/drive-performance-output.test.mjs scripts/redesign/__tests__/drive-isolation-cleanup.test.mjs electron/controllers/__tests__/import-controller-persistence.test.ts electron/controllers/__tests__/import-controller-secure-file.test.ts electron/controllers/__tests__/measurement-driven-parsing-optimization.test.ts electron/controllers/__tests__/author-import-hash-reuse.test.ts electron/services/__tests__/import-inspection-store.test.ts electron/repositories/__tests__/import-run-parsing.test.ts electron/repositories/__tests__/import-run-repository.test.ts electron/services/__tests__/project-runtime-lifecycle.test.ts electron/controllers/__tests__/db-controller-project-context.test.ts electron/services/__tests__/performance-diagnostics.test.ts --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage53/native-initial.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
```

Initial native execution exited0:15 files,332/332 passed,0 failed/pending/todo. Typecheck/i18n exited0. Initial lint exited1 for one unused dialog destructuring in releaseChooser; the color check was not reached. Luna changed only that unused callback binding to _event. Sol independently reversed that binding in memory and recovered the exact initial module SHA256 EB0EC15961B46E1211BFFFC057CEACCC6D5B6320FBDA7F3282145611EC2572A5. This is a historical identity, not a hash of the current file. No behavioral guard or assertion was removed.

The complete identical15-file command was rerun with --outputFile=.runtime/creation-runtime-modernization/stage53/native-final.json, followed by fresh corepack pnpm run lint. Both exited0; fresh native again332/332,0 failed/pending/todo, lint and color passed. The two overlapping executions are not summed. New lifecycle22/22 and output22/22 are included in332, not additional tests. Their fixtures mock the orchestration boundary, whereas the actual scenes below exercise the real Electron services. Native raw reports and final sources are bound in [the manifest](stage-53-source-manifest.json). Typecheck/i18n were not rerun after the verified unused-binding-only fix.

No application source changed in this stage. Actual controller and all three built entry hashes match the reviewed Stage52 source build, so that build was reused; this is not a fresh Stage53 build result. No native/build command overlapped an Electron scene. Existing driver cleanup checks verified scratch ancestors and each owned tree; no unrelated process was terminated.

```powershell
$env:PAGEKIN_PERFORMANCE_SOURCE_SHA = '910541848afb2370c09804bdda1e79cc976adbb4'
corepack pnpm run verify:drive -- --scenario perf-parse-author-close-1000 --theme light --out .runtime/creation-runtime-modernization/stage53/electron --console
corepack pnpm run verify:drive -- --scenario perf-parse-reference-close-1000 --theme light --out .runtime/creation-runtime-modernization/stage53/electron --console
corepack pnpm run verify:drive -- --scenario perf-parse-reference-cancel-1000 --theme light --out .runtime/creation-runtime-modernization/stage53/electron --console
```

All three scenes ran serially and exited0, each1 attempt/0 failures, zero probe-stop/cleanup failures, normal non-forced quit and empty reported external requests/writes/ignored writes/residual arrays. The final process query observed zero Electron processes. Both guarded request summaries have zero attempts in every route, with final cutoff before_quit, not full-shutdown network coverage. Source SHA is the entry HEAD plus the manifest-bound uncommitted harness bytes; it does not falsely identify the working tree as clean.

| Scene | IPC inspection ms | actual close wait ms | observed lifecycle result |
| --- | ---: | ---: | --- |
| author-close1000 | 3331.6000 | 3326.4000 | both pending while chooser held; both fulfilled before reload; neutral runtime; same project/path, new lease |
| reference-close1000 | 3461.5000 | 3457.5000 | same drain; real new-lease readback is new/prepared/ready,1/1 sources,1000 new chapters,0 duplicate/conflict |
| reference-cancel1000 | 4.9000 | unavailable | selected result null; unique run readback null; inspect/cancelled counters1 each; read/parse/hash/save events absent |

The corpus hash is ebbbb1afb5a8da6d2968eda768841e17732338ae5dddd582fba9d48af93e2e56, file2844892 UTF-8 bytes. Both selected inspections report1000 chapters,2820000 body bytes and860000 draft units, matching Stage51/52. Cancellation still prepares this fixed file but never selects/reads it; its configured corpus size is not an observed inspection. Closed runtime is the actual neutral {activeProjectPath:null,dbReady:true}; dbReady means the locator and database agree in a neutral state, not that a project remains open. No project-scoped IPC uses the old session after close.

| Scene | read/parse ms | instrumented hash sum ms/count | save sum ms/events | CPU user/system us, window ms | sampled RSS max bytes/samples | main loop samples/p95/max ms | renderer heartbeat max delay ms |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: |
| author-close1000 | 3216.5877/25.5564 | 14.6034/1000 | 1.7369/1 | 109000/47000,3655.5715 | 235810816/16 | 113/40.927231/59.342847 | 10.4000 |
| reference-close1000 | 3228.6096/25.7844 | 14.7205/1000 | 101.9619/2 | 172000/109000,3807.2206 | 235204608/16 | 116/41.123839/154.140671 | 15.1000 |
| reference-cancel1000 | absent/absent | absent | absent | 0/0,330.0973 | 180809728/3 | 9/35.061759/35.061759 | 9.4000 |

All probes report main observed_metrics, renderer live_zero_events and CPU observed. CPU covers the entire probe window, including300ms intentional pre-sampling (not Stage51/52's600ms pre/post combined); zero CPU microseconds in the short cancellation window reflect process sampling resolution, not proof of zero work. RSS is a250ms periodic sample maximum, not a true allocation peak. Read is secure-read wall time, not established physical disk time; parse includes measured hash work, so sums overlap. Reference save contains two instrumented events. Close wait includes the50ms held chooser and remaining admitted secure-read/parse/commit, not an isolated db-close cost, application exit cost or a latency guarantee. Parsing was never actively cancelled.

Root viewed all three1440x900 PNGs. Each shows the same fictional empty settings page: core0 draft units, three required fields missing (core/type/target reader), target100 chapters and3000 units per chapter, no configured model/task. The two displayed missing-field counts agree. All three PNGs also match Stage51/52 byte-for-byte. This is screenshot sanity evidence, not proof of1000 imported chapters, adoption, finalization or visual qualification; IPC assertions and reference database readback supply the relevant functional evidence.

## PERF-004 Acceptance Map

| Current AC | Traceable current evidence and decision |
| --- | --- |
| Profile-bound optimization; explain no isolation | Stage51 measured author duplicate20/200/2000 hashes; Stage52 directed real-handler trace and parity tests removed only the final redundant immutable-content mapping pass, obtaining10/100/1000. Current1000-chapter parse is about25.6ms and includes about14.6ms hash time; secure-read wall time exceeds3.2s. The larger reference loop sample can include synchronous commit and is not isolated pure-parse cost. There is no evidence that moving this measured pure computation to a Worker fixes the dominant observed interval; no Worker/clone benchmark was run. Keep this bounded equivalent optimization and do not introduce cross-thread ownership/clone complexity on these observations. This does not establish that a Worker is universally slower or that all future corpora need no isolation. |
| Split/count/hash/error parity and retained main boundaries | Stage52 actual handler/store payload parity covers TXT/MD/headings/no-heading/nested EPUB/missing-field EPUB/legacy reference; Stage53 reruns the complete package with secure-file, persistence, inspection-store, parser, repository, runtime and db-context regressions. Source trace retains existing path/size/grant/session checks and repository transaction/content-integrity writers. No native DB handle moves to another thread. The remaining no-heading provisional hash and EPUB title prescan are not disguised as removed. |
| Report stalls, CPU/RSS changes and cancel/close convergence | Stage51/52 six-row before/after matrices report loop/CPU/RSS and instrumented stage/count changes, including higher author1000 RSS and worse reference1000 loop146.014207 to163.577855ms/save97.9402 to104.5425ms. Stage53 adds actual held-chooser close drain/new lease/persistent readback and chooser-cancel absence evidence above. No overall/statistical speedup, instant active-parse abort or fixed latency is asserted. |

Applicable gates are confirmed G-IMPLEMENT/G-RUN; dependency PERF-001 is complete. The required deterministic/performance/electron categories are present across the manifest-bound current package and the unchanged Stage51/52 application comparison. Final independent source/AC and separate artifact reviews accepted this map and records. PERF-004 alone is completed/passes=true: ten completed and twenty-five in progress, not whole-F2 or phase completion. EPUB performance, real-model literary quality, multi-book workflows and other-platform/package qualification were not executed and are not inferred from this feature's narrower AC. The older Stage47 full-workflow1000 deadline/forced quit remains an unresolved observation of that different workflow, not repaired by successful inspection.

## Independent Review And Commit

Sol independently inspected the frozen integrated source, initial/final native denominators, same-content build identity and failure fix before actual scenes, then read all three actual raw reports and the final AC map/records. Separate artifact reviewer stage51_artifact_review (gpt-6.1-terra/high) independently matched25 evidence plus3 protected identities, all table/summary/date/limitation values and the current feature gates. Both accepted the narrow integration and complete PERF-004 AC with no unresolved blocker. Neither reran project commands or performed Git writes; root execution records support exits, sequencing and process queries.

Root confirmed empty index, no active hooks/fsmonitor, all twelve owned paths without content filters, unchanged protected hashes and clean diff check. Exact-path scoped commit and post-commit preservation are root-owned. Commit locator: test(perf): complete inspection lifecycle acceptance. Next increment validates actual KB single-book bounded embedding dispatch while retaining the actual default1 and existing grant/drain/ledger/FTS barriers.

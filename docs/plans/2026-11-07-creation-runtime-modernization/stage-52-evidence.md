# Stage 52 - Same-Content Author Fingerprint Reuse

## Frozen Scope And Acceptance

Date:2026-11-12. Entry:9c66974455bdf5ed29ae3fe1cbaae77f8acc40d2, master. Stage51's six actual no-model measurements show author inspection instrumented hash counts20/200/2000 versus reference10/100/1000 on the same corpora. Current source traces this to author result mapping unconditionally hashing each parsed body again. This stage removes only that demonstrated duplicate main-process computation; no worker or default change is selected.

Production ownership is limited to the two fingerprint/UTF-8-size expressions in electron/controllers/import-controller.ts's final numbered mapping. That mapping serves author and legacy unstructured reference inspections; the structured reference path returns earlier and is unchanged. Reuse optional values already calculated by the main-process parser from the exact same immutable content string, with nullish recomputation retained for the existing EPUB no-nested-heading path lacking those fields. No renderer/external metadata cache is trusted. Keep chapter/body/order/number/title/wordCount/fingerprint/size and sourceIndex/sourceChapterNumber parity and all existing errors, limits, session/grant/path/read/close checks, inspection validation and repository integrity/transaction checks. No UI, new public contract, dependency, migration or persistent writer change.

Team: gpt-6-luna/high owns only the controller file; gpt-6.1-terra/high owns only electron/controllers/__tests__/author-import-hash-reuse.test.ts, reusing existing fixtures without altering other tests; root owns shared records, actual serial native/build/isolated Electron validation and Git. Independent gpt-6.1-sol/high reviews the integrated source and actual evidence; a separate artifact reviewer checks final recorded identities. No owner independently accepts its own important change.

## Validation Mapping

| Required evidence | Actual path and acceptance |
| --- | --- |
| Mapping behavior | Real registered dialog:select-novel-files handler and inspection store, not source-string assertions. TXT/MD headings, no-heading fallback, EPUB nested headings and missing-field fallback retain chapter payload identities; legacy reference also retains global numbering and source metadata. Instrumented body hash count loses exactly the redundant final mapping pass. Multiline no-heading input may retain a provisional parser hash before the full-body hash (3 to2, not1); do not repair that separate parser behavior here. |
| Error/security/regression boundary | Existing secure-file, persistence, parser and inspection-store tests retain rejection/session/grant/size/error behavior. Reference repository validation is not replaced by cached values. |
| Static integration | Authorized typecheck, lint/color and i18n commands on the final source. These are not runtime/model/platform proof. |
| Build | Authorized serial source build; bind final source/test and dist entry hashes. No package/install qualification. |
| Actual before/after inspection | Repeat Stage51's reviewed author/reference10/100/1000 scenes on unchanged fixed corpora with fresh isolated fictional projects/profile. Record CPU whole window,250ms sampled RSS, main event-loop/renderer observations, elapsed/stage/hash counts, reference persistent readback and external-effect/quit results. No real model or profile. Single cells are not repeated percentiles or statistically established speedup. |
| Independent acceptance | Source/runtime reviewer, separate artifact reviewer, root exact-path/index/hooks/protected exclusion checks; fix and rerun applicable evidence after substantive changes. |

Commands use the already inspected root package scripts through corepack pnpm11.11.0. Native tests may create isolated OS-temp SQLite/EPUB fixtures and ignored .runtime reports; build writes dist/ and dist-electron/. Driver runs only the six reviewed no-model scenes, output under .runtime/creation-runtime-modernization/stage52/, with the checked scratch-child cleanup contract. No --real-model, package qualification, real data/configuration or external writes are authorized or required here.

PERF-004 remains in_progress/false until its remaining whole-feature gates are actually met. Active parsing cancellation/close latency, EPUB performance, repeated measurements, quality and three-target platform qualification are not implied by this narrow reuse change. Stage51's reference1000 loop maximum and historical full-workflow timeout remain valid prior observations, not silently repaired by this work.

## Actual Work And Evidence

Production diff is exactly the two planned nullish expressions. Initial independent source/test review found no narrow source blocker, retaining actual execution gates. The first actual twelve-file native run exited1:203/210 assertions passed,7 failed,0 pending. All seven new cases failed before their target assertions because main-process text localization requires admitted global data and the new fixture had not initialized it (GLOBAL_DATA_NOT_READY); the other eleven files passed. The production guard was retained. The test owner then added the existing real isolated global-data coordinator fixture and safe environment/cleanup, not mocking localization or weakening readiness. Initial report .runtime/creation-runtime-modernization/stage52/native-initial.json SHA256:2F23FD139D8CA000390E8F790730BC7BB5513347B243C9576744D86064124B3B; initial test SHA256:1FA0D776FFC05B276E81DB8AB2F33217985E2768C503FCE6910418D31E098BAD. Fresh final review and complete rerun were required and are recorded below; the initial static acceptance was not reused as a passing execution result. The historical initial test identity is not independently rehashable from the current corrected file.

The test-only correction uses the existing real prepareGlobalDataFixture in a separate verified OS-temp root, restores all three environment variables and checks its complete tree before cleanup. No production or target assertions changed. Independent fresh source review accepted controller71F86397E331B4ACED8B0849538E8F949A7F43C0E94BF9D28C6D456B5DD40A65 and corrected test2743080AC274C464A4A13AFE6DB569469B60733EEAC5A3C1E4E5655301DB61F5 for rerun. Actual complete rerun exited0:12 files210/210,0 failed/pending; all seven new cases executed. Final report .runtime/creation-runtime-modernization/stage52/native-final.json SHA256:496B765B0CBC200E8F3C7B6E859D7A4D71EE3253C39AC87F2576B306D97F8750. These overlapping first/final assertion counts are not summed. Fresh typecheck/lint/color/i18n and serial source build all exited0. Existing alias customResolver, invalid freeze output option, large chunk, ineffective KB dynamic import and preload inlineDynamicImports warnings remain; no package qualification is inferred.

Actual root commands (the native command ran twice, selecting native-initial.json then native-final.json):

```text
corepack pnpm test electron/controllers/__tests__/author-import-hash-reuse.test.ts electron/controllers/__tests__/measurement-driven-parsing-optimization.test.ts electron/controllers/__tests__/import-controller-secure-file.test.ts electron/controllers/__tests__/import-controller-persistence.test.ts electron/services/__tests__/import-inspection-store.test.ts electron/repositories/__tests__/import-run-parsing.test.ts electron/repositories/__tests__/import-run-repository.test.ts electron/services/__tests__/performance-diagnostics.test.ts scripts/redesign/__tests__/performance-parse-scenarios.test.mjs scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/drive-performance-output.test.mjs scripts/redesign/__tests__/drive-isolation-cleanup.test.mjs --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage52/native-final.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
PAGEKIN_PERFORMANCE_SOURCE_SHA=9c66974455bdf5ed29ae3fe1cbaae77f8acc40d2
corepack pnpm run verify:drive -- --scenario <scene> --theme light --out .runtime/creation-runtime-modernization/stage52/electron --console
```

The environment line denotes each child PowerShell process's environment assignment, not a persisted setting. The final command ran separately and serially for author/reference10/100/1000. All six exited0, each1 attempt/0 failures. Report sourceSha names the entry HEAD plus exact uncommitted controller/test/build identities in [stage-52-source-manifest.json](stage-52-source-manifest.json), not a claim that entry HEAD already contained this change. All31 evidence identities and3 protected exclusions are bound there. App Electron44.9.3 / Node24.22.0 / Chrome152.0.7977.167, driver Node24.13.0 / pnpm11.11.0, Windows x64, same i5-9400F host. No tests/build/native commands ran concurrently with the Electron matrix.

| Scene | IPC elapsed ms | inspect ms | secure read ms | parse ms | instrumented hash ms/count | save ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| author10 | 3154.1490 | 3149.3276 | 3134.9096 | 2.5988 | 0.2395/10 | 0.7170 |
| author100 | 3254.2600 | 3249.9282 | 3233.4314 | 4.8265 | 1.6444/100 | 0.5444 |
| author1000 | 3300.2636 | 3295.8642 | 3256.0286 | 25.8505 | 14.6738/1000 | 1.7630 |
| reference10 | 3165.5036 | 3160.9693 | 3130.8374 | 2.4356 | 0.2210/10 | 4.2034 |
| reference100 | 3225.8252 | 3221.1310 | 3182.3819 | 4.7398 | 1.6307/100 | 10.8560 |
| reference1000 | 3388.1176 | 3376.9097 | 3222.6312 | 25.7688 | 14.5835/1000 | 104.5425 |

| Scene | CPU user/system us | CPU window ms | sampled RSS max bytes/samples | loop samples/p95 ms/max ms | renderer heartbeat max delay ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| author10 | 0/31000 | 3781.4803 | 180396032/16 | 115/34.406399/40.206335 | 6.0000 |
| author100 | 31000/15000 | 3880.4304 | 182579200/17 | 118/33.718271/41.418751 | 4.9000 |
| author1000 | 93000/47000 | 3914.6483 | 231841792/17 | 118/34.832383/49.807359 | 6.2000 |
| reference10 | 47000/16000 | 3784.6106 | 183300096/16 | 114/34.013183/40.566783 | 7.0000 |
| reference100 | 15000/16000 | 3849.5264 | 179851264/17 | 115/34.209791/42.565631 | 7.3000 |
| reference1000 | 203000/15000 | 4014.0170 | 247627776/17 | 119/34.570239/163.577855 | 3.7000 |

Each corpus SHA, file byte count, chapter/body-byte/draft-unit summary and reference classification/source progress exactly matched its Stage51 counterpart. Fixed file bytes28430/284391/2844892 differ intentionally from body bytes28200/282000/2820000; draft units8600/86000/860000. Reference inspections remained new/prepared/ready,1/1 sources and zero duplicates/conflicts, with actual same-session persistent readback asserted before success. The full private snapshots are not exported. No fake provider/model setup was installed. All coverage is main observed_metrics, renderer live_zero_events, CPU observed,250ms RSS16/17 samples; zero probe-stop/cleanup failures, normal non-forced quit, empty reported external requests/writes/ignored writes/residual processes. The final post-matrix process query found no Electron process. Both request summaries are zero with cutoff before_quit, not whole-quit network coverage.

Root viewed author10 and reference1000 screenshots; all six PNG hashes equal each other and the original Stage51 image. They show the same empty settings page, core0 units, three required settings missing, target100 chapters/3000 units, and no configured model/task. They are not proof of inspected corpus size, adoption, persistence or visual qualification. The author full-payload parity evidence is the real handler/store test; runtime counts/readback are separate.

## Comparison And Remaining Gates

Against the original six Stage51 observations, author hash counts20/200/2000 became10/100/1000; structured reference counts10/100/1000 are unchanged and its repository content revalidation remains intact. Author1000 instrumented hash sum27.7918ms became14.6738ms, while IPC elapsed3302.9645ms became3300.2636ms: no meaningful whole-workflow speedup is established. Author1000 CPU125000/62000us became93000/47000us in different3.945/3.915s windows, sampled RSS228360192 became231841792 bytes (higher), loop max72.155135 became49.807359ms. Reference1000 CPU172000/63000us became203000/15000us, sampled RSS247476224 became247627776 bytes (higher), save97.9402 became104.5425ms, and loop max146.014207 became163.577855ms (worse). These are single uncontrolled-cache observations, not repeated-run or causal performance claims.

Secure-read wall time still dominates and is not identified physical disk/subprocess IO. Parse/hash measurements overlap; repository integrity work is not removable cached computation. CPU covers the whole probe window including intentional600ms pre/post sampling; sampled RSS is not a true allocation peak. No Worker/clone comparison, EPUB performance, active-parse cancellation, close-drain timing, real-model quality, installation/package or three-target qualification was executed. No timing threshold or unsupported cancellation promise is introduced. The larger reference loop observation and earlier full-workflow1000 timeout remain open facts, not hidden failures or repaired conditions. PERF004 stays in_progress/false and completion9/35.

Final independent source/runtime reviewer agent3_sol and separate artifact reviewer stage51_artifact_review accepted the exact integration, all six raw outcomes, failure lineage, comparison/limits and all34 manifest identities, with no narrow correctness/evidence blocker. Neither reran project commands; root execution records remain the source for exits, sequencing and process queries. Root owns eight-path scoped Git/index/hooks/exclusion checks before commit. Commit locator: perf(import): reuse same-content inspection fingerprints. Next independent increment measures the actual chooser-cancel and close-drain contract without inventing an inspection cancel IPC or blocking ready single-book network work on multi-runtime construction.

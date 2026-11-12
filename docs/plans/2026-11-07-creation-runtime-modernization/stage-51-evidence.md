# Stage 51: No-Model Parse Inspection Measurement

Scope frozen2026-11-12, Asia/Shanghai. Entry69d2d4334fcf8f426347f2ba20e880adddb3c89b, master. Stage50 is committed, tracked/index clean and the original two Stage1B3 documents remain excluded. Nine features are complete. This is measurement required to choose the next PERF-004 increment, not completion of that feature.

## Scope And Acceptance Freeze

Stage47's actual1000-chapter report records import.parse.ms25.8732, import.hash.ms27.9303 and whole inspection3238.0645ms. Its732.955ms whole-workflow event-loop peak includes1320 model requests and cannot establish parse as the bottleneck; RSS is a250ms sampled maximum and CPU was not measured. F2 section3/PERF-004 requires actual hot-path evidence before adding compute isolation. No parsing algorithm, defaults, DB writer, runtime permission, UI/copy/design, dependency or supported platform is changed in this package.

Add six independent no-model isolated scenes: perf-parse-author-10/100/1000 and perf-parse-reference-10/100/1000. Reuse the fixed performanceCorpus, recording its SHA256, UTF-8 bytes and expected chapters. Setup creates/opens only an isolated fictional project and captures its real frozen session, without llm:save-model/default-model or fixture provider. Replace only the native chooser return, call the real dialog:select-novel-files with runId/purpose/locale/expectedProjectPath and session, then restore temporary handlers in finally. No confirmation, task/workflow, generation, embeddings or author finalization is started.

Author inspection must validate the returned purpose/source/chapter/byte/word counts and bounded preview. Reference preparation must validate new/prepared/ready, manifest/source/chapter counts and no duplicate/conflict, then compare the actual db:import-run-get persistent snapshot under the same session. Reference preparation writes the isolated recoverable virtual project's real parsing/prepared run; both selection branches also retain the existing remembered chooser directory configuration and first-use identity HMAC secret inside the isolated root. These existing isolated application-level effects are allowed, but no secret is read/exported and real profile/configuration writes remain prohibited. It is not a completed reference workflow. Paths, text, titles, IDs, arbitrary errors and secrets are never exported in performance JSON/stdout.

Main probe adds process.cpuUsage user/system deltas in microseconds across the probe window, CPU windowMs and RSS start/end/250ms sampled maximum/count/interval. CPU is main-process window CPU, not precise parsing CPU. Sampling/coverage must distinguish unavailable/insufficient from measured zero, retain event-loop sample count and existing20ms histogram, and stop all probes on success/failure. The measurement window includes300ms warm-up and300ms post-operation sampling; elapsed inspection time remains separate from the whole probe window and must not be its CPU utilization denominator. RSS sample count includes the two endpoints; the new scene requires at least three samples to establish at least one actual periodic sample, not endpoint-only coverage. No claim that synchronous parsing is cancellable or that sampled RSS is a true peak.

## Team And Ownership

- Scenario owner: new scripts/redesign/performance-parse-scenarios.mjs and its matching new test only.
- Probe owner: scripts/redesign/performance-baseline.mjs and its existing tests only. CPU result is measurements.main.cpu with userUs/systemUs/windowMs; measurements.coverage.cpu is observed/unavailable. Memory adds rssStart/rssEnd/rssIntervalMs, preserving rssMax/rssSamples.
- Output owner: scripts/redesign/drive-performance-output.mjs and existing tests only. Preserve the closed whitelist and extend just the six scenario names, CPU/memory coverage, corpusBytes and a bounded inspection object. Inspection fields are purpose, sourceCount, chapterCount, totalBytes, totalWords, classification, stage, status, completedSources, totalSources, newCount, duplicateCount and conflictCount; no arbitrary scalar passthrough.
- Root: driver import/registration, final integration, shared records, commands, build, actual isolated drive and scoped Git. Root additionally owns the drive cleanup-boundary increment and its new scripts/redesign/__tests__/drive-isolation-cleanup.test.mjs. Independent source and artifact reviewers do not implement these changes.

Independent pre-review required the isolated application-side-effect and CPU-window clarifications above. It also accepted a necessary driver safety amendment before any real recursive cleanup: only an otherwise clean scene can release its root after absolute lexical and realpath direct-child containment under the approved scratch parent and a no-symlink/junction root/descendant scan. A denied check retains the scene and adds the closed ISOLATION_CLEANUP_BOUNDARY failure; it cannot continue removal or skip report/quit checks. Existing releaseSessionRoot mock semantics and failed-scene retention remain unchanged. Normal child, parent/ancestor/sibling/nested/relative paths, root/child links and no-remove-on-failure are tested independently. This does not grant cleanup of any preexisting scratch directory.

## Verification Mapping

Focused Vitest covers actual scene setup/chooser/IPC shape, author and reference results/persistent readback, probe failure/finally, no model calls, zero versus missing CPU/RSS values and privacy rejection. Existing secure import/persistence tests preserve path/grant/session/transaction/error boundaries. Tests and runtime samples are distinct evidence; source build is not Electron/platform qualification.

Root will run authorized filtered pnpm test, typecheck, lint/color, check:i18n and build after inspecting final scripts. Then run each reviewed local scene through authorized verify:drive with isolated output and diagnostics, no --real-model. Before each recursive cleanup-capable driver execution inspect resolved scratch/output/root boundaries and reparse attributes, actual source/build identities, quit/residual and profile/network checks. Each attempt/failure, actual commands, source/build/report hashes and independent decisions will be recorded. No install, real configuration, real project or remote/platform state is authorized by this stage.

No feature flag is promoted by this freeze. Future algorithm/concurrency changes require their own evidence-based freeze and review. Headless stays last; design/model/human/platform gaps do not block this independent measurement.

## 2026-11-12 Resume And Current Evidence

Root resumed the existing uncommitted Stage51 package at the same entry SHA, rather than recreating or discarding it. The index was empty; the repository-analysis report and original two Stage1B3 documents are excluded and their SHA256 values were captured before execution. Agent1 gpt-6-luna/high inspected the performance sources and ADR claims; Agent2 gpt-6.1-terra/high inspected the next independent single-book production increment; Agent3 gpt-6.1-sol/high independently reviewed current Stage51 source and the broader feature state. No model substitution was used. Agents performed read-only queries; only root ran commands or edited shared records.

Independent source review found no narrow Stage51 blocker in the integrated driver, scenario, probes or closed projection. It does not constitute Electron execution or PERF004 acceptance. Current-source inspection also established that ADR0063's 200-chapter yield, quantified savings, Worker-clone comparison and cancellation-latency claims exceed available implementation/evidence. A dated clarification was added to that ADR without changing its product contract or production behavior. Plain-text parsing is single-pass; EPUB still pre-scans headings; the existing reference yield occurs after parsing/mapping and before synchronous commit; integrity rehashes remain. No benchmark here removes a protection or proves cancellation during synchronous parsing.

Actual environment: Windows x64, Node24.13.0, Corepack pnpm11.11.0, Vitest4.1.12. The requested pnpm scripts were inspected in package.json; Corepack selects the pinned package manager, not the unrelated global pnpm. Actual test configuration is in vite.config.ts and scratch/cleanup implementation is in drive.mjs. No project command was inferred from historical toolchain examples.

Commands executed from the repository root:

```text
corepack pnpm test scripts/redesign/__tests__/performance-parse-scenarios.test.mjs scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/drive-performance-output.test.mjs scripts/redesign/__tests__/drive-isolation-cleanup.test.mjs --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage51-resume/native-initial.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm test scripts/redesign/__tests__/performance-parse-scenarios.test.mjs scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/drive-performance-output.test.mjs scripts/redesign/__tests__/drive-isolation-cleanup.test.mjs scripts/redesign/__tests__/drive-args.test.mjs scripts/redesign/__tests__/drive-quit.test.mjs scripts/redesign/__tests__/drive-profile-writes.test.mjs electron/controllers/__tests__/import-controller-secure-file.test.ts electron/controllers/__tests__/import-controller-persistence.test.ts electron/controllers/__tests__/measurement-driven-parsing-optimization.test.ts electron/services/__tests__/performance-diagnostics.test.ts --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage51-resume/native-final.json
corepack pnpm run build
```

Initial four-file107/107 and expanded eleven-file198/198 passed with zero failed/pending. Typecheck, lint/color and i18n exited0; serial source build exited0. Existing alias resolver/invalid freeze option, chunk-size, ineffective dynamic-import and preload inlineDynamicImports warnings remain, not silently fixed. Tests write only controlled fictional temporary fixtures, cache and ignored reports. Build writes generated repository output, not an installer or platform qualification.

The actual six-scene Electron matrix is complete; final artifact review follows below. Each launch uses a new isolated child of the approved scratch parent; its lexical/real containment and root/descendant link boundary are checked by the driver before clean removal. Root checked scratch/output ancestors for reparse redirects and found none, and checked that no preexisting Electron process was running. Profile inspection reads entry metadata only, not real configuration content. No existing scratch directory is removed by this package.

## Actual Six-Scene Matrix

Root executed the following separately and serially for author10/100/1000 and reference10/100/1000, with no simultaneous build/test/native work and no source changes during sampling:

```text
PAGEKIN_PERFORMANCE_SOURCE_SHA=69d2d4334fcf8f426347f2ba20e880adddb3c89b
corepack pnpm run verify:drive -- --scenario <scene> --theme light --out .runtime/creation-runtime-modernization/stage51-resume/electron --console
```

The environment assignment above denotes the process-local value used in PowerShell, not an extra script or persisted setting. Report sourceSha is the entry HEAD, not a claim that the harness changes were committed there. Exact current harness/test/ADR, source-build, original raw and screenshot bytes are bound by [stage-51-source-manifest.json](stage-51-source-manifest.json). It includes27 evidence identities plus3 protected exclusions; source/build identities were unchanged after the six runs. Actual app runtime is Electron44.9.3 / Node24.22.0 / Chrome152.0.7977.167; Windows x64 and an Intel Core i5-9400F host. Cache is uncontrolled; each cell is a single observation, not a repeated-sample workflow percentile.

| Scene | Exit / attempts / failures | IPC elapsed ms | inspect ms | secure read ms | parse ms | instrumented hash ms / count | save ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| perf-parse-author-10 | 0 / 1 / 0 | 3377.5881 | 3373.5347 | 3359.3692 | 2.3422 | 0.3719 / 20 | 0.3145 |
| perf-parse-author-100 | 0 / 1 / 0 | 3222.8467 | 3218.2736 | 3198.8915 | 5.0174 | 3.1740 / 200 | 0.5408 |
| perf-parse-author-1000 | 0 / 1 / 0 | 3302.9645 | 3299.6148 | 3237.2069 | 26.0552 | 27.7918 / 2000 | 1.9237 |
| perf-parse-reference-10 | 0 / 1 / 0 | 3145.4972 | 3140.3088 | 3110.0647 | 2.3329 | 0.2131 / 10 | 4.3438 |
| perf-parse-reference-100 | 0 / 1 / 0 | 3191.0698 | 3185.6294 | 3145.7499 | 4.6540 | 1.5871 / 100 | 10.7553 |
| perf-parse-reference-1000 | 0 / 1 / 0 | 3372.0777 | 3360.1709 | 3212.1364 | 25.6011 | 14.3993 / 1000 | 97.9402 |

| Scene | main CPU user/system us | CPU window ms | sampled RSS max bytes / samples | event-loop samples / p95 ms / max ms | renderer max heartbeat delay ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| author10 | 0 / 47000 | 4000.1483 | 178298880 / 17 | 125 / 41.517055 / 66.945023 | 14.5 |
| author100 | 31000 / 16000 | 3844.7068 | 179945472 / 17 | 117 / 34.897919 / 36.732927 | 3.5 |
| author1000 | 125000 / 62000 | 3945.0383 | 228360192 / 17 | 124 / 39.354367 / 72.155135 | 19.8 |
| reference10 | 31000 / 47000 | 3767.8267 | 179802112 / 16 | 114 / 34.045951 / 44.892159 | 8.2 |
| reference100 | 31000 / 15000 | 3816.3382 | 180355072 / 17 | 117 / 34.701311 / 38.666239 | 8.5 |
| reference1000 | 172000 / 63000 | 3996.8776 | 247476224 / 17 | 119 / 34.373631 / 146.014207 | 4.0 |

Both purposes use the same fixed corpora. For10/100/1000 chapters the original file bytes are28430/284391/2844892, while parsed body bytes are28200/282000/2820000 and draft units8600/86000/860000. The source/body byte counts are intentionally different. Corpus SHA256 values are56e4df63d2aa0012c312a4ef6898b3caebb81fe5a7147766095b2b20c69e663d, f8c8fac5644b8f19ea488d3135598075b7e1d7f56410e6bb7028fac0c5309b00 and ebbbb1afb5a8da6d2968eda768841e17732338ae5dddd582fba9d48af93e2e56. All sources/counts/previews matched assertions. Each reference preparation was new/prepared/ready with1/1 sources, the expected new chapter count and zero duplicates/conflicts; the real db:import-run-get readback was checked before scene success, though its full snapshot is intentionally not exported.

All six report main observed_metrics, renderer live_zero_events, observed CPU, RSS250ms with16/17 samples, zero probe-stop/cleanup failures and successful inspection. No fake provider or model configuration was installed. Both guarded request summaries are zero, with final cutoff before_quit; this is not a claim to observe every network request during quit. Reported external requests/writes/ignored writes and residual processes are empty, quit.forced=false, and the post-matrix process query found no Electron process. No old failed workflow sample was overwritten or reclassified.

Root personally viewed all six1440x900 screenshots. All six files have identical bytes and correctly show the unchanged empty settings page: core0 draft units; three required settings missing in both sidebar/footer; target100 chapters and3000 units/chapter, not the inspected corpus count; no configured model or running task. Scenes call IPC without opening a visible import dialog. Screenshots therefore do not prove chapter preparation counts, adoption, UI fidelity or workflow completion; those inspection assertions come from actual IPC/persistent readback.

Interpretation remains bounded. Safe read wall time accounts for most inspection elapsed but includes the secure file service chain, not measured physical disk IO or an identified subprocess. Parse includes some instrumented hash work; author mapping hashes again, and reference repository integrity work has separate coverage. Parse/hash/save figures are not an additive CPU cost decomposition. The largest observed main loop delay is146.014207ms in reference1000, not an identified pure-parser pause. CPU is the whole3.77-4.00s probe window, with600ms intentional warm-up/post-sampling, and RSS is sampled rather than a true allocation peak. No Worker comparison, active-parse cancellation, close-latency, repeated-run percentile, EPUB profile, before/after speedup, real-model quality or three-target qualification is claimed.

## Review And Next Increment

Source reviewer agent3_sol independently accepted the final integrated scripts, ADR clarification, all six reports and the exact manifest binding, with no narrow correctness blocker. Separate artifact reviewer stage51_artifact_review independently matched all30 identities (27 evidence and3 protected exclusions), both native denominators, the six table rows and unchanged9/26 feature states, with no narrow evidence blocker. Both reviews read source/artifacts only, not independent reruns; root's execution record remains the evidence for command exits and process/control-flow checks. The explicit limitation on Stage29's old chunked-yield evidence is retained in features.json without changing historical result text or promoting any feature. Completion remains9/35. Root owns the exact scoped Git/index/hooks/exclusion checks. Next bounded implementation should use these actual measurements, retain repository integrity checks and remove only demonstrated redundant internal computation before considering isolation; single-book network and feedback gaps remain independent.

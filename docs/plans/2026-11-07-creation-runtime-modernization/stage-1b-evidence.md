# Stage 1B: Attributed Strict Performance Baseline

Status: in progress. This record does not complete PERF-001. Earlier [Stage 1 evidence](stage-1-evidence.md) and failed isolation reports remain valid records of their versions, not passing measurements.

## Frozen Measurement Scope

Production source: `f5a95d3026819623cfd5dddc803996c6fe5c79eb`. The initial normal import runs load the committed performance driver and fake-model sources at that SHA. Subsequent pressure fixtures are separately identified before execution; no optimization, production retry/scheduler change, native rebuild or dependency change is included in this baseline package.

- Windows x64; Intel Core i5-9400F; 34,299,277,312 bytes RAM; driver Node 24.13.0; Corepack pnpm 11.11.0. Actual application: Electron 44.9.3 / Node 24.22.0 / Chrome 152.0.7977.167.
- Fresh owned fictional project/profile per run; loopback fake; 1440x900 light. No real model, user project/config content, model budget or secrets used. Disk cache and host background load are uncontrolled; no statistical population claim.
- Command at project root: `corepack pnpm run verify:drive -- --scenario perf-import-<size> --theme light --out .runtime/creation-runtime-modernization/stage-1b-attributed --console`. Existing `PAGEKIN_PERFORMANCE_SOURCE_SHA` is set to the above SHA for that command only, with the prior environment restored in `finally` and the real command exit code preserved.
- Supported one-book sizes: 10/100/1000. Two and four simultaneous books remain `unsupported_not_executed`, not zero-duration or passing samples. Pressure/failed-response samples are additional requirements, not substitutions for the size matrix.
- The existing strict monitor includes the real profile and business sibling. No ignore expansion, installed-app termination or broad process cleanup. Only owned isolated app roots/processes are cleaned, with failed-run artifacts retained. Each run must separately show empty external requests/writes/residuals and normal quit.

| Built application artifact | SHA256 |
| --- | --- |
| dist-electron/main.js | 7f20a98963f487cfb64ed72a807f6eb1931f5c0dac25f5e03d2c81705a8ad889 |
| dist-electron/preload.mjs | 80a80e867f33ba16dedfec2a1aa358cc464bc8784df398141b3f372f6fa8b5bb |
| dist/index.html | e9c1d075ab8a36cb1c920d20880c18bd4a154a99a87d0e310d8d25c8840f5971 |

## Actual Normal Import Observations

Raw artifacts: `.runtime/creation-runtime-modernization/stage-1b-attributed/`. Each row is one actual application run, not workflow p95. Event-loop p95 is the native histogram within that run; memory is sampled main-process RSS, not the whole application's RSS.

| Chapters | Exit / attempted / failed | Wall seconds | Loop p95 / max ms | Renderer heartbeat max ms | Main RSS max MiB | Guarded fetch / fixture accepted | Source read / selected bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 0 / 1 / 0 | 18.912 | 40.403 / 65.339 | 18 | 172.49 | 32 / 32 | 1,015,200 / 465,300 |
| 100 | 0 / 1 / 0 | 78.528 | 94.175 / 165.282 | 28.5 | 263.37 | 302 / 302 | 76,140,000 / 3,764,700 |
| 1000 | 1 / 1 / 1; unqualified | 610.601 | 95.027 / 738.198 | 157.5 | 629.77 | 1478 / 1478 at probe stop; 1492 final fixture count | not reached / not reached |

For both completed attributed rows, imported finalized drafts and blueprint counts equal their row size, business/probe-stop failure counts are zero, and normal quit has no external request, external write, ignored external write or residual process. Logical dispatch, transport requests, guarded fetch attempts and fixture accepts are independently recorded (32 each / 302 each); none proves remote-provider execution or billing. Usage is deterministic fixture usage, not actual provider consumption.

| Report | SHA256 |
| --- | --- |
| perf-import-10-light.json | e2fad869d462a4f61c63bfa855c35d85887d2798ea28ddd595cc088f493088b4 |
| perf-import-100-light.json | 981f55e4243babbdd05a23893438013d98ba75407ac62eddcdeb4562e6a4a0ed |
| perf-import-1000-light.json; failed and isolation-contaminated | a79b2bdbaae6e73929533cc0d32af4149993e47e49fe5347b79b1a3817f5a3b2 |

Corpus SHA256: 10 chapters `56e4df63d2aa0012c312a4ef6898b3caebb81fe5a7147766095b2b20c69e663d`; 100 chapters `f8c8fac5644b8f19ea488d3135598075b7e1d7f56410e6bb7028fac0c5309b00`. Fixed corpus contains only repository-owned fictional text. The normal run uses `FAKE_MODEL` and `inferenceReply` from the frozen source, with existing production model/parameter/Skill freezing unchanged.

The 1000-chapter corpus hash is `ebbbb1afb5a8da6d2968eda768841e17732338ae5dddd582fba9d48af93e2e56`. The unchanged 600,000ms workflow wait expired during continuity post-processing, before reverse inference and final verification. Its `importedChapters=0` and `blueprintChapters=0` fields are unobserved initialization values, not evidence of zero persisted drafts or blueprints. The sampling window contains 1478 logical dispatches, transports, guarded fetch attempts and fixture accepts; the driver final fixture count is 1492 because the uncancelled workflow continued after the probe stop. These different cutoffs are not interchangeable and do not establish a retry or missing-count diagnosis.

The renderer heartbeat has 6104 observations while its snapshot metrics are empty: this phase has not reached the main-owned snapshot projection producer. The old helper reports one renderer stop failure for any empty metrics object. This is a classification defect, not evidence that the probe disappeared. A revised helper must distinguish live zero-event coverage, actual stop failure and missing/malformed probes without fabricating events or claiming unexecuted chains were covered. The original report remains unchanged.

Quit was forced and the report has no `externalRequests` property; missing network observation is not an empty list. The strict monitor found changes to one real business generation configuration and two real-profile shader caches, plus the existing three ignored cache changes. No contents of those real files were read. Metadata alone does not attribute the writer. A read-only process query confirmed an installed application was still running; the user was asked to save buffers and close it normally, never terminated by the agent. This attempt is preserved as a business failure and an unqualified isolation/measurement sample, not retrospective PASS. No ignore expansion, timeout extension or unknown-run resume is allowed to convert it into acceptance.

## Source And Timing Interpretation

- Global uses first/last actual authoritative chapters; style uses first three/last two without duplicates; blueprints use the exact frozen checkpoint range. Existing main capture reads the whole immutable import table each time before selection. The 10/100 rows read 360/27,000 chapter-instances respectively. Counts and bytes explain this repeated-read cost without trimming facts or changing source authority.
- Recorded source capture/read/select/validation/hash, import inspect/parse/save, generation provider/snapshot/receipt/publication, transport first response/visible content, IPC DTO bytes, renderer snapshot queue/hash/duplicate processing and loop/memory metrics have different boundaries. DTO UTF-8 bytes are not Electron wire bytes. Histogram quantiles are upper bounds, not arbitrary exact percentiles.
- `import.save.ms` is not all finalization, outbox and post-processing. The uninstrumented wall-time remainder is not classified as UI blocking. Renderer heartbeat is timer delay, not every interaction's latency. No network wait is labeled a renderer hang.
- These normal fake responses have no reasoning, embedding, rate-limit or long high-frequency stream sample. Those paths were pending at normal-import sampling time and were subsequently measured separately below; absent normal-run metrics are not replaced with zero or represented as real-model measurements. Candidate 100ms/500ms targets are not achieved gates.

## Screenshot Checks

The coordinator personally inspected the unattributed 10-chapter image and attributed 10/100 images, then the 1000-chapter failure image and accessibility snapshot. An independent source/visual reader additionally checked both 10-chapter images and fixture/rendering definitions.

- Run title 10/100 matches actual imported and blueprint counts. The 10-chapter sidebar's two `10 / 100` values share the same preserved configured 100-chapter target; the 100-chapter image shows 100 blueprints and 100/100 finalized chapters. No automatic target adoption is inferred.
- Core outline displays 25 draft units, matching the fixed 25 Chinese characters excluding punctuation. Architecture `1 / 4` matches existing confirmation thresholds and pending character proposals, not four confirmed architecture facts.
- Configuration stays 100 chapters / 3000 units per chapter; the one pending difference shows current 3000 and inferred 860 (43 Chinese corpus characters repeated 20 times). It is not silently adopted.
- The 10-chapter steps display 0/0/3/0/0/1/3 rounded seconds. The 100-chapter steps display 0/2/36/1/0/25/3. Each is independently rounded executor duration; zero is not no execution, and their sum is not the measurement's broader wall time. Raw step timestamps are absent from these JSON reports, so these displayed step durations cannot be independently recomputed here.
- The run start labels are 18:00 and 18:01 respectively (local 2026-11-07). No duplicate timestamp for the same event is present to cross-compare; these labels do not establish exact workflow timing. No changed layout, visual fidelity, dark/mobile or platform acceptance is claimed.
- In the failed 1000-chapter image, the run title is 1000 chapters, the header and run card both show overall 39%, and continuity shows its separate 74% step progress. The sidebar shows 1000 finalized chapters against the preserved configured 100-chapter target; projection has finished but reverse inference and blueprints remain pending. This supports the phase diagnosis, not a replacement for final database verification or complete-workflow acceptance.

## Review, Pending Evidence And Failure Denominators

Root alone executes commands. Independent proof and routing reviewers inspect raw reports and source without implementation ownership; their agreement is not execution. Both accepted the two attributed normal rows as limited one-book measurements, not completed PERF-001.

The first strict 10-chapter attempt in `stage-1b-strict/` exited 0 with clean isolation but `metadata.sourceSha=null`. Its report is retained as an unattributed observation, excluded from the attributed matrix. It is an additional actual attempt, not silently overwritten or erased. Earlier Stage 1's contaminated runs remain separate failed qualification observations.

Both independent reviewers confirm that a strictly isolated, complete and attributable failed 1000-chapter sample can satisfy baseline sampling: PERF-001 does not require making that workflow succeed before PERF-002 can optimize it. Qualification, business success and the preserved attempt/failure denominator are separate. The current 1000-chapter attempt lacks qualification; it is not excluded from history or relabeled as complete.

The driver classification/cancellation/cutoff repairs and three short pressure paths are recorded below. Still pending: an attributable strictly isolated 1000-chapter sample, the complete applicable PERF-001 matrix and final feature acceptance. No downstream optimization starts merely because two normal sizes and short pressure paths passed.

## Stage 1B1 Delivery Boundary

This is a separately reviewed, commit-sized driver repair and short-pressure slice, not full PERF-001 acceptance. Its freeze requires truthful live-zero/insufficient-sampling/missing-probe classification, actual bounded workflow cancellation before failed-run cutoff, unavailable rather than default verification counts, bounded redacted original/cleanup diagnostics in the serialized receipt, and explicit network/cutoff observations. Three pressure paths must have deterministic regressions and actual clean isolated Electron evidence before this slice is accepted. The original 1000-chapter record is never relabeled or replaced.

Stage 1B2 still requires the attributable strictly isolated 1000-chapter sample and the complete applicable PERF-001 matrix. PERF-001 remains `in_progress/passes=false`, so PERF-002/003/004 and SCHED-001 do not start from this slice. Independent RUNTIME-002 can proceed after this slice's review/commit under its own contract and storage gates.

Actual first fixture check at repository root: `corepack pnpm test scripts/redesign/__tests__/fake-model.test.mjs --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-1b/fixture-tests.json`, exit 0, 6/6, no failed or pending tests. Report SHA256 `6b0b1a6c4a7a9ef86a8a720812bf1ee0c15f8dec8be4cae03278a4ab64b38c16`. This tests the local protocol fixture, not the integrated pressure producer, Electron execution, real-provider usage or literary quality.

Execution-preflight review found and corrected a driver-only 429 expectation: actual production failure without trusted usage remains `unknown`, not `settled`. Reservation creates one empty failed artifact associated with that attempt; it is retained with `compositionEligible=false`, not deleted or mistaken for a visible artifact. The driver now requires that exact record, one failed unknown attempt and zero resend. Missing/foreign-attempt artifacts and a falsely settled attempt are negative regressions. No production accounting/history behavior changed.

Other closed findings: live-zero events require positive heartbeat/event-loop sampling; zero samples remain `insufficient_samples`, and missing/malformed probes fail. Failure receipts preserve bounded, closed-class redacted original/cleanup diagnostics through JSON serialization. Failed imports cancel through the real workflow boundary and drain before stopping probes; unobserved counts remain null with separate coverage. Guarded fetch and accepted fixture cutoffs are independently checked, with any quit-period fixture increment also failing. Network observation remains explicitly `observed_before_quit`, not complete quit-period network coverage. No timeout increase or retry of an old unknown workflow was added.

## Frozen Driver Implementation

Production/build identities remain the values above. The driver source is the following nine-file working-tree version over `f5a95d3026819623cfd5dddc803996c6fe5c79eb`, not an assertion that the parent commit contains these driver changes. The metadata SHA is an explicit source label; the hashes identify the actual reviewed bytes.

| Path under scripts/redesign/ | SHA256 |
| --- | --- |
| performance-baseline.mjs | b869e1c3338ae00f57e96d5c7815662d6b1f44106866c46e4dd29570c513c46f |
| performance-scenarios.mjs | c52d5db37058b7b3fe2082d679052fd7294b4e4b991358ed4993a9b26b9ff899 |
| performance-pressure-scenarios.mjs | 61c9361934a06f6c9e58b6625b4a8a13171bfb83dfdfa35810e4f42b82727940 |
| drive.mjs | 518bfff6844addd13fdbf36ee560218367e2d54d9be81dee7b953029fc14b767 |
| fake-model.mjs | 0842504a4d811151199cb7023db343dcf0d8be5664c03f2f959f78f88de0927a |
| __tests__/performance-baseline.test.mjs | c19a68561f33543e2076524c11266165e7296bd008199f2c69be6275ff368476 |
| __tests__/performance-pressure-scenarios.test.mjs | b027cef203bd88b2f414842a9b8e6f7598b747448c31e48454491f5fc61159d1 |
| __tests__/drive-args.test.mjs | f505af810fc10d012c5929e88d332b3c57d304787bbf34301f95d36ae0813e09 |
| __tests__/fake-model.test.mjs | 6d9cc6b9fa27828cebe33449d664c8d618cd3136591c1cbbfa22ef7dc7338640 |

## Actual B1 Commands

All commands were executed by root at the repository root. Tests write the listed ignored JSON/cache and disposable fictional fixtures; drive commands launch only the owned isolated application, loopback fake and scratch projects/profile. No dependency/native rebuild, real model or real project was used.

```text
corepack pnpm test scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs scripts/redesign/__tests__/fake-model.test.mjs scripts/redesign/__tests__/drive-args.test.mjs scripts/redesign/__tests__/drive-quit.test.mjs scripts/redesign/__tests__/drive-profile-writes.test.mjs scripts/redesign/__tests__/real-model.test.mjs --maxWorkers=2 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-1b/integrated-retest.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run verify:drive -- --scenario perf-long-stream --theme light --out .runtime/creation-runtime-modernization/stage-1b/pressure-final --console
corepack pnpm run verify:drive -- --scenario perf-rate-limit --theme light --out .runtime/creation-runtime-modernization/stage-1b/pressure-final --console
corepack pnpm run verify:drive -- --scenario perf-slow-embedding --theme light --out .runtime/creation-runtime-modernization/stage-1b/pressure-final --console
corepack pnpm run verify:drive -- --scenario perf-rate-limit --theme light --out .runtime/creation-runtime-modernization/stage-1b/pressure-rate-retest --console
```

- Final focused tests: 7 files, 125/125, zero failed/pending, exit 0; report SHA256 `2478e719f794bc9852fe96bac2221d0dbba9a732b339f04d4a60fafdefe82ca7`. Earlier 123/123 report `5b338eaa1e2109a080c9c32d2b9c1af482a2bbaec3e6fbadefda24f6a02a1a7b` predates the final two artifact-identity regressions and is retained, not final acceptance evidence.
- Typecheck, lint and i18n exited 0; lint ran again after the final MJS/test changes and exited 0. No TypeScript or locale file changed after the other checks. No new build/browser suite was needed for this driver-only package; the three production build hashes were rechecked unchanged before pressure execution. These are not full-suite, UI-interaction, installer or literary-quality evidence.
- The pressure commands use the same process-local source label/restoration as normal sampling. The first three execute sequentially; their wrapper exited 1 because the first 429 run detected external writes. The independent retest command exited 0. No CPU-heavy validation or second owned Electron run overlapped pressure sampling.

## Actual Short Pressure Observations

Each row is one actual attempt; expected provider failure is not scenario failure. All rows have normal quit, zero residual processes, zero fixture request increment after the final cutoff, and empty observed-before-quit external network requests. The first 429 row is nevertheless unqualified because of external-write observations; `measured.success=true` does not override that driver failure.

| Scenario / output directory | Driver exit / qualification | Wall seconds | Main loop p95 / max ms | Renderer heartbeat max ms | Main RSS max bytes | Actual task/request result |
| --- | --- | --- | --- | --- | --- | --- |
| long-stream / pressure-final | 0 / clean | 33.357 | 36.536 / 74.973 | 16.9 | 140869632 | 2 requests, 2 settled, 401 transport visible events, 20 reasoning events |
| rate-limit / pressure-final | 1 / isolation failed | 22.213 | 34.144 / 67.764 | 26.6 | 134365184 | 1 HTTP429, 1 failed unknown, 0 settled, 1 empty failed artifact, no resend |
| slow-embedding / pressure-final | 0 / clean | 5.512 | 32.178 / 43.581 | 17.2 | 145211392 | 1 embedding, 2056ms, 1 document / 1 chunk |
| rate-limit / pressure-rate-retest | 0 / clean | 22.958 | 32.932 / 87.884 | 15.2 | 135135232 | 1 HTTP429, 1 failed unknown, 0 settled, 1 empty failed artifact, no resend |

| Raw report relative to .runtime/creation-runtime-modernization/stage-1b/ | SHA256 |
| --- | --- |
| pressure-final/perf-long-stream-light.json | 0c98c6cafb583b5630d60cd19c05b11b4e3298fcaf28e252995c87d743920211 |
| pressure-final/perf-rate-limit-light.json | e84ccf5991887c43c63cd14e1dc33711708fd102cefa28251b83d0ee86c1099c |
| pressure-final/perf-slow-embedding-light.json | 8039458bcb3d7fe056287c9f0e57c40243f23f02e299c27b59dda15dd877bbd6 |
| pressure-rate-retest/perf-rate-limit-light.json | c1f271337f9bc930665d3274b027a22f0796ca08becc5d52cfce44997bc4b33e |

The failed 429 reports two non-ignored shader-cache metadata changes and three changes in existing ignored cache categories. No process attribution follows from size/mtime differences; the installed application was independently observed running. Neither process termination nor ignore expansion was used. A fresh isolated fixture retest qualified cleanly; it does not erase or change the failed attempt. Across these four final-version short samples: 4 attempted, 4 business-scenario passes, 1 driver/isolation failure, 3 qualified runs. The earlier six-test fixture check, intermediate tests and old-driver embedding observation remain separate, not additional final-version qualified runs.

Both long-stream and 429 probes have positive main/renderer metric sampling. The slow embedding has valid positive loop/heartbeat samples with zero generation events; `live_zero_events` is correct, not probe-stop failure. It does not synthesize generation snapshots, reasoning or token usage for an embedding path. Long-stream first-response/reasoning/visible measurements are distinct; model wait is not classified as UI freeze. HTTP429 usage and actual dispatched parameter readback remain unavailable; model/configuration and fictional corpus identities are recorded without inventing them. Skill identity is the fixture default, with no independently readable Skill digest; this is a disclosed observation limit.

Root inspected all four final screenshots: long-stream shows the completed chapter-3 draft v2 (9200 displayed units) and completed run; both 429 screenshots show failed short-outline generation with no saved draft and unchanged blueprint view; embedding shows the existing chapter-3 review view, not a new KB UI claim. All are 1440x900/light. No changed visual layout, mobile/dark comparison or complete author workflow is claimed.

Final source/probe/receipt review was by two independent reviewers without implementation ownership. Both matched the clean 429 retest hash, accepted all three original B1 clean-scene conditions and closed the listed code findings while preserving the failed attempt. Frozen records receive a final consistency review before commit. PERF-001 remains in progress until B2 supplies its missing qualified 1000-chapter sample and applicable full matrix.

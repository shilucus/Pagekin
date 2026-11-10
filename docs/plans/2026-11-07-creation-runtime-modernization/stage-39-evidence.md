# Stage 39: Stream terminal authority and active-cache lifecycle

Date: 2026-11-10. Entry: `996a6602b877fbdcdb3d1d6687c58ab9c769b163`.

## Frozen Scope

Close two actual PERF-003 defects in the existing production owner/service path: terminal diagnostics can be overwritten by older coalesced values, and completed attempts retain their full published text because the existing guard clear operation has no owner caller. This package changes no visible layout, copy, user interaction, durable schema, model request, input source or authorization.

Terminal receipt fields remain authoritative, pending diagnostics only fill fields absent from that receipt, and missing evidence stays missing. Clear attempt-local guard state on every logical settlement, including failures after dispatch or during final receipt/snapshot/publication. Keep errors, unknown receipts and recovery tails intact. Physical transport accounting, permit retention/quarantine and real physical-idle behavior are independent and must not be shortened by cache cleanup. Late provider callbacks cannot rebuild state or mutate settled data. Reconnect continues to use authoritative complete snapshots, not the cache.

## Team And Validation Mapping

| Boundary | Owner / acceptance evidence |
| --- | --- |
| Terminal diagnostic merge | Guard implementer, real receipt precedence and missing-field deterministic cases |
| Owner/service lifecycle | Separate implementer, native success/failure/cancel/storage and exceptional-return regressions |
| Physical lifetime and recovery | Independent reviewer checks actual callbacks, scheduler/idle/quarantine, unknown and reconnect callers |
| Integration and records | Root runs approved commands, freezes source/artifact identity and owns scoped Git |
| Evidence | Separate reviewer checks raw reports and recorded claims, not implementer self-acceptance |

Planned focused package: stream-snapshot-deduplication, main-generation-owner, generation-run-service, main-generation-owner.scheduling, main-generation-model-change and performance-diagnostics tests, plus any directly affected lifecycle regression file. Run typecheck, lint, check:i18n and build after integrated source freeze. Run the already reviewed fictional perf-long-stream scene against that build to retain actual full-snapshot/count/isolation observations. Test scripts use only new temporary/in-memory fictional databases and may write caches and an isolated JSON report; build rewrites local dist outputs. The off-screen Electron scene owns its temporary app/profile/project and loopback fixture; no real model, user configuration or real manuscript is permitted. No heavy checks/build/source edits overlap measurement.

All actual commands, failures, source/build/report hashes and independent review are appended after execution. This increment alone does not complete PERF-003 or provide a real-model, visual-fidelity or three-platform qualification.

## Initial Execution And Corrections

At the project root, Node 24.13.0 / Corepack pnpm 11.11.0 / Vitest 4.1.12:

`corepack pnpm test electron/services/__tests__/stream-snapshot-deduplication.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/generation-run-service.test.ts electron/services/__tests__/main-generation-owner.scheduling.test.ts electron/services/__tests__/main-generation-model-change.test.ts electron/services/__tests__/performance-diagnostics.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-10/stage39/focused-tests.json`

Exit 1: six files, 443 tests, 437 passed / six failed / zero pending. The original report is retained, SHA256 `C1A81F8A598F3796B708F5763B4211090AD44ABC4DC6E3FED1B7E104D3B3599F`. All failures are new owner test expectations: five exceptional-return cases incorrectly expect settled despite usage=null, whose actual conservative accounting state is unknown; cancellation incorrectly expects a renderer failureCode which the existing safe outcome projection does not expose. The native cancellation receipt, not an expanded renderer whitelist, is the appropriate assertion. These are fixture/assertion corrections; no production protection is weakened. Focused retest and full package rerun must follow against the corrected bytes, with independent re-review.

The intermediate single-matrix correction passed nine selected tests (278 filtered), report `lifecycle-retest.json`, SHA256 `E0F94E21ECA9FF34381A8114DDE4CD5FA41CEEFD71E220BBF0265A0961E9FF52`. It is superseded by the final dual accounting matrix: each of five exceptional boundaries covers both usage=null/unknown and valid synthetic trusted usage/settled with actualTokens=14. Both retain the original error and stored finishReason=stop. Native cancel asserts GENERATION_CANCELLED/unknown and retained liability; renderer asserts incomplete/error, without changing its whitelist.

`corepack pnpm test electron/services/__tests__/main-generation-owner.test.ts -t "stream snapshot cache lifecycle" --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-10/stage39/lifecycle-final.json`: exit 0, 14 selected tests passed, zero failed, 278 filtered. SHA256 `CDD23DCD3FC8ACAB09C19B88DCB462A39D7231B3FA97FF2489867CA19365B2A8`. Filtered tests are not counted as executed PASS.

## Frozen Source Identity

Final commands use entry HEAD plus these read-only Git blob identities. No implementation edits overlap the final commands or Electron measurement; documentation completion follows actual results.

| Path | Git blob |
| --- | --- |
| electron/services/stream-snapshot-guard.ts | c177883110c15cbb764e18156cce2e80ed9fce1b |
| electron/services/generation-run-service.ts | d83bc2565d0541746b9fae030c50c7302903e2f6 |
| electron/services/main-generation-owner.ts | 2e6b5afff1cf99a0a423827bd4847fb0bf121852 |
| electron/services/__tests__/stream-snapshot-deduplication.test.ts | 2689b3b279d5670414cb7efd877b504379ae63c6 |
| electron/services/__tests__/generation-run-service.test.ts | d9adce02076852e26e827369953964eccb627d81 |
| electron/services/__tests__/main-generation-owner.test.ts | 513ade05831dac2d4732af77a40dd68a83413a74 |
| docs/adr/0062-stream-snapshot-deduplication-and-publish-guard.md | 266a2ae6b26610d08c3cc9622e4d1ad3b99e54c7 |

## Independent Source Review

baseline_audit independently traced the production owner/service/guard, scheduler, error propagation, recovery-tail and reconnect boundaries. Its first static review missed the fixture accounting/outcome mismatches exposed by execution; that test conclusion was withdrawn. Final re-review after the dual matrix correction found no scope correctness defect or required missing case. All production bytes stayed unchanged through assertion correction. Static review is not an independent run, literary-quality evidence or whole-feature acceptance.

## Final Execution

- Full six-file command above reran with `--outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-10/stage39/focused-tests-final.json`: exit 0, 448/448, zero failed/pending. Files: generation-run-service 63, model-change 9, scheduling 58, owner 292, performance-diagnostics 11, guard 15. SHA256 `BBE3D8F266CF7E94726C50C74946CBE83A16389127B14A1E926F40BEAAC8FC94`.
- `corepack pnpm run typecheck`, `corepack pnpm run lint`, `corepack pnpm run check:i18n`: each exit 0, completed after tests and before build. Lint includes color-literal checks.
- `corepack pnpm run build`: exit 0. Existing alias/customResolver deprecation, invalid freeze option, large chunks, ineffective dynamic import and inlineDynamicImports deprecation warnings remain. No unrelated build changes.
- `git diff --check`: exit 0, whitespace only.

Build SHA256: `dist/index.html` = `32C57C337EC2206D23D849FD565E1AF22B1E85B3D40AA2424D501CF49527432E`; `dist-electron/main.js` = `DFCCF96E53D31312CF8317835BA6063F8502188CFECC6F136C72337F214A9148`; `dist-electron/preload.mjs` = `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B`.

## Controlled Electron Observation

`corepack pnpm run verify:drive -- --scenario perf-long-stream --theme light --out .runtime/creation-runtime-modernization/recheck-2026-11-10/stage39 --console`: exit 0, elapsed 32168.9298 ms. The process-local source-SHA override was cleared/restored, so sourceSha=null accurately represents entry HEAD plus frozen blobs rather than falsely attributing dirty implementation to clean HEAD. Electron 44.9.3 / embedded Node 24.22.0 / Chrome 152.0.7977.167, 1440x900 light, uncontrolled cache, single fictional book and loopback fixture. Eight existing scratch ancestors had no reparse redirection; no Electron process was present before launch. No build, native test, heavy check or source edit overlapped measurement.

Two physical requests and two settled receipts, zero unknown/failed/reserved; the prose transport recorded 400 visible and 20 reasoning events. Across both attempts: 448 notifications, 11 guarded receipt reads, 13 full publications / 139978 text bytes, nine durable snapshots. These counters are observations, not a promised reduction ratio or receipt reads for all unrelated APIs. Sampled main event-loop max 108.265471 ms and RSS max 144994304 bytes do not establish a memory improvement, p95 target or freeze cause. Cache release, cancellation, exceptional return and late callback protections are deterministic native evidence, not falsely claimed as separately driven Electron cases.

Normal quit, zero cleanup failures, cutoff requests, external requests/writes/ignored writes or residual processes. The driver checks real-profile entry metadata only, not real contents. Report `perf-long-stream-light.json` SHA256 `C978BCDCFF6F7E8DEB2C5A13A8CE34779FB477A871E05B1478FB4ADDBD5A1F1A`.

Root personally viewed the screenshot: chapter 3 is consistent across tab, page, sidebar and run card; draft v2 is 9200 units; 12 blueprints and 2/12 finalized remain unchanged; run completion and saved state are visible. The run card duration is workflow time, not the provider-only duration. No visible redesign or literary-quality claim is made.

All six original Stage 34 baseline report hashes remain unchanged, including the 1000-chapter failure denominator. Both pre-existing Stage 1B3 documents also remain excluded and unchanged. PERF-003 stays in_progress/passes=false; incomplete full PERF-001 coverage, complete qualification and unrelated migrations are not manufactured by this increment.

## Independent Artifact Review

feedback_audit independently recomputed seven source blobs, four test reports, the new Electron report, three build entry hashes and six original baseline report hashes; all identities match. It personally inspected the screenshot and checked the raw event, receipt, isolation and cleanup denominators against these records. The initial failures and intermediate filtered runs remain retained. No source or evidence blocker remains for this narrow increment. Quality-check/build exit codes are root's actual execution evidence, not an independent rerun with a durable terminal transcript. The stored owner run remains running and is not relabeled as a completed domain run. Feature status stays incomplete.

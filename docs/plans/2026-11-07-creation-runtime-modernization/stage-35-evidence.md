# Stage 35: Evidence-faithful performance diagnostics

Date: 2026-11-10. Entry: `8e6eed0da1c1478e7e63d1f763d9d29621407c33`.

## Frozen scope

This stage addresses PERF-001's diagnostic correctness, not a new user interface or a performance speedup. The raw fixed-name numeric collector remains schema 1. Internal derived statistics must not double-count nested preparation durations or two observations of the same stream, mistake cumulative counters for current activity, classify snapshot queue time as main-thread blocking, or report missing measurements/provenance as success.

The implementer owns only `src/shared/performance-baseline.ts` and its focused test. The coordinator owns the corresponding ADR amendment, records, commands and scoped Git. Independent source and evidence reviewers are not the implementer. No dependency, database, migration, provider/model, real manuscript, design or DSH change is authorized by this slice.

## Validation mapping

| Risk / requirement | Required evidence |
| --- | --- |
| Nested timing and same-stream double counting | Actual metric producers, direct-consumer search and deterministic counterexamples |
| Historical aggregate versus live waiting/freeze | Completed/failed/cancelled/reasoning requests and accumulated short waits never infer unsupported state |
| Missing versus observed zero | Empty/partial snapshots and provenance regressions; candidate targets remain unknown without the specified measurements |
| Existing observation safety | Raw collector/diagnostics and generation/transport consumer tests; typecheck/lint/i18n/source build |
| Sampling and source attribution | Independent review of Stage 34's six raw reports, including the 1000-chapter failure and unsupported two/four-book rows; no replacement of failures |

## Implemented correction

The raw metric names, numeric collector and schema 1 snapshot are unchanged. The private `CreationCostAttribution` result is version 2: parent/child preparation durations and import/source bytes are separate; transport/generation events are separate; pending/queue depth remain historical summaries; first-response/reasoning/visible fields explicitly report cross-sample minima. Duration sums are observed cumulative work, not an exclusive waterfall or wall-clock duration. Missing metrics are null, and missing provenance no longer invents zero failures, one book or unexecuted rows.

`isNetworkWaitingVsUiFreeze()` has no unused legacy input and returns unknown for both states because the aggregate contract cannot establish current activity or UI blocking. `evaluateCandidateTargets` exposes only the available snapshot proxy upper bounds, leaves achievement unknown and preserves non-hard targets. It does not turn network wait into a freeze or a short/absent proxy into achieved interaction/main-thread latency. ADR-0060 was amended to these exact boundaries, including receipt read versus snapshot write and known usage versus complete billing.

Bounded searches of the shared definitions and `src/`, `electron/`, `scripts/` consumers found no production consumer of the three derived functions/types; only the focused test calls them. Production main diagnostics and the driver continue using the raw collector. This is static retrieval plus typechecking, not a complete dynamic graph. There is no new visible output or state requiring a design addition.

## Actual commands

All commands ran at the repository root with Node 24.13.0 and pinned Corepack pnpm 11.11.0 after reading their existing scripts/configuration. Tests use fictional in-memory/temporary data and may update test caches; build rewrites existing local build outputs. No install, browser download, native rebuild, service, real model, user project or external state was used.

- `corepack pnpm test src/shared/__tests__/performance-baseline.test.ts electron/services/__tests__/performance-diagnostics.test.ts electron/services/__tests__/generation-run-service.test.ts src/services/generation/__tests__/generation-runtime-owner.test.ts electron/services/__tests__/stream-snapshot-deduplication.test.ts scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs`: initial exit 0, 7 files, 200/200; repeated after the parameter repair, exit 0, 7 files, 200/200.
- `corepack pnpm run typecheck`: initial and final exit 0.
- `corepack pnpm run lint`: initial exit 1 (`_attribution` unused); after removing that unsupported input and synchronizing tests, exit 0 including the color-literal check. No disable/dummy use/fallback was introduced.
- `corepack pnpm run check:i18n`: exit 0; subsequent repair changes no displayed text.
- `corepack pnpm run build`: exit 0 after the final source repair; existing alias/freeze/chunk/dynamic-import warnings remain.

The three build entry SHA256 values equal Stage 34's corrected build: index `2DE91BDAECB53CC184EC5DCB7D5A6ED83BE542C41739E379E9C23917EFEC3F0A`, main `A23E4EC7B185777EA5236665FC73801E84B40262F925D3858E611C8FA63218E9`, preload `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B`. This is not a claim that all outputs are clean or that a new Electron/platform run occurred.

## Source identity

Entry SHA plus these exact Git blobs identifies the reviewed and tested implementation. Blob computation does not write Git objects; no source file changed during final regression/build.

| Path | Git blob | SHA256 |
| --- | --- | --- |
| src/shared/performance-baseline.ts | ebbad3a98f0f707e13c71c602c592038c1606576 | 1E178825C1B49F41B0A0CC84268CF8B4546714727F2B3E41B2A1105FB341DBCE |
| src/shared/__tests__/performance-baseline.test.ts | a3f9dd3f4c01e152126258ab72175a4eb18f72e5 | F16837F51FE176B7FEBDFE3BD269DA1F5188DC30A402B26C6323DA7264A9530A |
| docs/adr/0060-creation-runtime-performance-diagnostics-and-cost-attribution.md | c52335ed0d182ae1caa122f14d1a357e25851a56 | 5BE34DDE810C5CA790928C7A00F34A0E163DA6EE98E7916334B4C7F625F2EB1A |

## Review and remaining evidence

The performance implementer was `gpt-6.1-terra/high`; independent source reviewer `gpt-6.1-sol/high` re-read the final unused-input repair and found no blocker or required missing deterministic case. The reviewer checked actual metric producers, null/zero semantics, raw/derived versions, bounded consumer search, privacy input limits and the preserved observer tests. Root owns integration/ADR/commands/Git, not sole acceptance.

Independent evidence review (`gpt-6-luna/high`) confirms the six Stage 34 raw samples and insists on their limits: 1000 chapters timed out and required forced quit; its renderer snapshot/queue was not observed and final result counts are unavailable. Unsupported two/four-book rows are not measurements. Per-event histogram bounds and one workflow sample are not a statistical workflow p95. Source parity requires deterministic evidence, not a pressure screenshot. Raw reports include local paths/device metadata and are retained locally, not committed or presented as fully anonymized exports. The overbroad Stage 34 sentence was corrected; no report, denominator, timeout, corpus or raw hash was rewritten.

Final record review found no blocker for this narrow package: the reviewer independently recomputed the three source identities, six raw report hashes and current three build entry hashes. Those values match this record; no test or build rerun by that reviewer is claimed. Acceptance is limited to the internal diagnostic correction. `PERF-001` remains `in_progress/passes=false`; the other 28 incomplete features are not unlocked. Future source/step/model/Skill observation and matrix qualification must use real production receipts and retain failures. No literary-quality, real billing, full workflow success, three-platform or installer claim follows from this stage.

# Stage 45: Reference Knowledge Grant Admission

Scope frozen: 2026-11-10; execution and review continue on 2026-11-11, Asia/Shanghai. Entry: `f93dfeff8cb023d32a8db117bde449fc04d3a2ac`, master, Windows x64. Internal IMPORT-001/002 security boundary increment, not full migration or whole-feature qualification. Authority: current F2 sections 4.3-4.5/7.5, ADR-0036/0037/0039/0068 and explicit implementation/isolated verification authorization.

## Scope And Acceptance Freeze

| Surface | Required acceptance | Owner |
| --- | --- | --- |
| Main admission | Registered runtime/native identity and existing active grant/ref/requestHash binding; closed synchronous checks, effect-bearing nested savepoint rollback, portable frozen denial, no grant issuance or reconstructed task/configuration | admission implementer |
| Actual KB entry | Optional main-only admission, same-transaction SQLite preparation/update/replay authority, checks after awaits and captured cleanup; no current-view fallback for admitted work | KB implementer |
| Single-flight | Existing native project/document/epoch lock retained; different grant/ref/request waits instead of concurrent work or authority substitution; old no-admission sharing remains | KB implementer |
| Native regressions | Real grant repository/runtime/KB/SQLite and fictional deterministic FTS/embedding providers, A executing/B active, pre-admission and mid-await revoke, document replay, queue isolation, physical drain and legacy preservation | separate integration-test implementer |
| Acceptance | Frozen integrated source, focused actual regressions/quality/build, independent source/security review, fix/retest/re-review and separate artifact inspection before scoped commit | root and independent reviewers |

No visible output/interaction, schema/dependency, real-data/model/configuration, DSH, remote state or release change. Existing portable grant history is used without adding fields. Durable request capsules, frozen embedding configuration/credentials, embedding dispatch/unknown recovery, whole-stage owner/controller and later stages remain separate prerequisites; the existing prepared marker is not a no-dispatch receipt. No full IMPORT flag promotion or activation of background qualification.

## Verification Mapping

Root inspects actual scripts and fixtures, then runs focused new admission/native grant-KB tests plus existing captured/runtime-authority/reference-receipt, embedding options/batch/concurrency, grant repository/portable and material regressions as mapped to actual changes. Report output is `.runtime/creation-runtime-modernization/recheck-2026-11-10/stage45/`; native fixtures create recoverable fictional projects/archives only. Native/build execution remains serial. Typecheck/lint/i18n/build follow; no browser/Electron/provider-quality/platform evidence is inferred. Exact frozen identities, commands, failures/fixes and review results follow actual execution.

## Pre-Execution Review Correction

Independent source reviewer found that an effect-bearing admission call reused an outer transaction without a savepoint. If its callback wrote and then returned a thenable or failed the post-operation grant check, an outer catch could still commit those writes. The owner corrected only this rollback boundary and added native outer-catch regressions that preserve unrelated outer writes. This was a static finding before the first actual run, not a claimed failing execution. Both independent reviewers re-read the correction.

## Frozen Source Identities

| Path | SHA256 |
| --- | --- |
| electron/services/reference-import-admission.ts | 1B1AE7FF4935A31F71836FA5415DFD26C27CA3A35CCEB4A72A6EFBF1B571991A |
| electron/services/__tests__/reference-import-admission.test.ts | C41D9B8E7228A6DF78623300398C630DE99B261B83E799AF385168098B159710 |
| electron/knowledge-base.ts | 36F5214741C9E1F4AED7B498475F470563A2CBF0258D7B1A06D930D8BE0D1A5A |
| electron/__tests__/knowledge-base-grant-admission.test.ts | 30DA1903F217AA8311646726435C7B2C868577303AAF540C870792026D2DC326 |
| docs/adr/0068-reference-knowledge-grant-admission.md | 665FF24993C0A3BE5F9DA1E78E809A47DD054A1AA3164ADE8D401F36683AD0F4 |

Initial unit hash was 596BB6414035E7FB3218B9C53075572189046874392372364C9D90FF7F7E534F. Actual execution exposed a fixture/reopen defect missed by both static reviews: its persistent admission_effects table changed the recognized project schema. Both reviewers withdrew the affected no-missing-case conclusion. The owner changed only that table to TEMP and the second connection's lock assertion to an existing canonical project_core UPDATE, retaining strict locked/SQLITE_BUSY and actual canonical close/reopen. Production sources and schema guards stayed unchanged. Both reviewers then re-read the new unit hash, confirming savepoint rollback, real writer competition and the unchanged reopen path; no narrow source blocker remains. This is source review, not an independent command rerun.

## Actual Commands

Working directory: repository root. Test uses Vitest with one worker and inspected fictional temporary SQLite/Lance/archive fixtures, no real model/configuration/data or outbound network. Writes are test-owned temporary state, tooling cache and the ignored report below; cleanup preflights canonical containment and link boundaries. Typecheck is no-emit; lint/color and i18n check source; build writes dist/ and dist-electron/. No dependency installation, service, browser, Electron scene, packaging or remote action is implied.

```powershell
corepack pnpm test electron/services/__tests__/reference-import-admission.test.ts electron/__tests__/knowledge-base-grant-admission.test.ts electron/__tests__/knowledge-base-captured-runtime.test.ts electron/__tests__/knowledge-base-runtime-authority.test.ts electron/__tests__/knowledge-base-reference-receipt.test.ts electron/__tests__/embedding-options.test.ts electron/__tests__/embedding-batch-contract.test.ts electron/__tests__/embedding-bounded-concurrency.test.ts electron/repositories/__tests__/reference-import-grant-repository.test.ts electron/services/__tests__/reference-import-grant-portable.test.ts electron/services/__tests__/reference-import-materials.test.ts electron/services/__tests__/reference-import-knowledge-source.test.ts electron/migrations/__tests__/m14-reference-import-grants.test.ts electron/services/__tests__/portable-runtime-freeze.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-10/stage45/focused-tests.json
```

Root actually reran the same fourteen-file command after the test-only correction, with outputFile ending in focused-tests-final.json. First run: 207/208, one failed, zero pending, exit 1. Its only failure was the drain/reopen case with UNRECOGNIZED_SCHEMA. Final run: 208/208 across fourteen files and 28 nested suites, zero failed/pending/other, success=true, exit 0. These reports overlap and are not summed. Initial typecheck exited 0; final typecheck after the fixture correction also exited 0. Final lint/color, i18n and serial build each exited 0.

```powershell
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
```

| Report | SHA256 |
| --- | --- |
| .runtime/creation-runtime-modernization/recheck-2026-11-10/stage45/focused-tests.json | 2CE64DE270DBD22867A7F319254D1FBECF5923F3EADE4B6986FC49B165AF1671 |
| .runtime/creation-runtime-modernization/recheck-2026-11-10/stage45/focused-tests-final.json | ADAF3D0E0214F03C3926E9B46A9B4B7D4F5B1E003314F65CBD79A2469E26EC41 |

Final per-file passed counts: embedding-batch-contract 28; embedding-bounded-concurrency 6; embedding-options 2; knowledge-base-captured-runtime 12; knowledge-base-grant-admission 20; knowledge-base-reference-receipt 10; knowledge-base-runtime-authority 3; reference-import-grant-repository 27; m14-reference-import-grants 29; portable-runtime-freeze 5; reference-import-admission 21; reference-import-grant-portable 4; reference-import-knowledge-source 20; reference-import-materials 21. Every selected file has zero failed and zero other assertions.

## Source Build And Inspection Boundary

| Entry | SHA256 |
| --- | --- |
| dist/index.html | 4419AB25222134C7468C80842D983804E64FFB8935C5DAE26A0C26F3976D19D1 |
| dist-electron/main.js | 8633A37BAC5C77C888033C64FBA8FA552982B14393D74A5EECC470FB88B370F3 |
| dist-electron/preload.mjs | CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B |

All five source/test/ADR identities were recomputed after final execution and still match. Existing build warnings remain: customResolver alias deprecation, invalid freeze output option, large client chunks, ineffective KB dynamic import and inlineDynamicImports deprecation. They are not hidden or repaired by this scope. Build is source compatibility, not complete production owner composition, Electron interaction, model quality or platform/package qualification. The fourteen tests include actual native knowledge/grant operations and archive regressions; that does not turn them into separate full decomposition/imitation runs.

Independent artifact inspection checks five source/test/ADR, two reports and three built entry identities against actual denominators and failure lineage before commit. Root separately checks the exact nine owned paths, empty pre-existing index, hooks and original excluded file hashes. The original two Stage1B3 untracked documents and repository-analysis report are excluded; no feature completion flag changes.

Final independent artifact reviewer matched all ten identities and actual per-file denominators, including the previously failed reopen case now passed exactly once. The reviewer found no scope evidence blocker, retained the first failure, and did not rerun commands or operate Git. Root's separate diff/index/hooks/excluded-hash checks passed. This accepts only the internal boundary increment; scoped commit locator: fix(import): guard reference knowledge writes with captured grants.

## Remaining Composition Boundary

The current single reference chain writes inferred global values into formal project_core and replaces formal blueprints, while ADR-0040 section 3 forbids reference analysis becoming author outline facts. Actual UI only distinguishes new/current target and reference/author-manuscript purpose, not analysis-only versus adopted imitation facts; grant author-action does not resolve that distinction. Later global/blueprint background migration is blocked on an explicit product contract for allowed destination fields/ranges and adoption, not on permission to implement the 35 features. Do not invent a mode or treat updated ADR wording as author adoption. KB admission and independent dispatch-recovery work can proceed. Frozen embedding configuration/capsule, request dispatch ledger and whole-workflow qualification remain open.

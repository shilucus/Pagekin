# Stage 37: Production representative chapter selection

Date: 2026-11-10. Entry: `0c75c59ebed08c7aec1a2c3f85e80ae93abb1ccb`.

## Frozen Scope

Connect the existing production global/style representative dependency to an authorized database query returning only the actual first three and last two positive-numbered chapter rows, deduplicated and sorted. Reuse the complete existing snapshot hash/UTF-8 size/limit validation for every returned row. Keep the original paged reader, knowledge/blueprint/author consumers, main-generation authority freeze, checkpoint/effect recovery and legacy switching protection unchanged. No schema, grant, background qualification, model request, UI or dependency change.

The first six baseline attempts and the three Stage 36 diagnostic runs establish source-attributed observations, including the original 1000-chapter failure. This implementation slice does not promote its incomplete PERF-001 prerequisite or claim full PERF-002/quality qualification merely from a query optimization.

## Contract Decision

F2 section 3.2 and accepted ADR-0061 explicitly require selected-row database reads and authoritative validation of selected source. Independent review checked the existing orchestrator and execution-lease tests: checkpointed stages skip selection and corrupted unconsumed rows already remain resumable until read. Therefore whole-book validation on each global/style selection is an incidental consequence of pagination, not a separate recovery or security contract.

The new reader will not detect an unselected fourth chapter's corruption during this selection. That chapter must still fail at its real paged/knowledge/blueprint consumption boundary. A selected chapter with corrupted hash or byte size must fail immediately with the existing error. This timing difference is explicit, not hidden behind an unqualified equivalence claim. No default sample, ignored corruption, cached authority or renderer-supplied source proof is added.

## Ownership And Validation

| Assignment | Owned writes / required evidence |
| --- | --- |
| Repository implementer | Repository, focused real-SQLite tests and the production dependency line; short/gapped/overlap/nonpositive/corruption/isolation and bounded byte observations |
| Consumer test implementer | Actual production workflow tests, global/style sample delivery and frozen session; keep other-stage and recovery assertions |
| Root | IPC contract/controller/boundary tests, ADR/records, commands and scoped Git |
| Independent reviewers | Integrated source/caller/recovery review plus separate source/artifact/claim review; no self-acceptance |

Verification mapping: focused repository/controller/workflow/source and receipt/recovery tests; typecheck/lint/i18n/build; one controlled fictional Electron import against the integrated build. Small/medium/large deterministic SQLite byte measurements are observations of returned body volume, not claimed disk reads or workflow p95.

## Actual Execution

All commands ran at the project root with Node 24.13.0, pinned Corepack pnpm 11.11.0 and Vitest 4.1.12. Native tests use only in-memory or newly created canonical fictional SQLite fixtures, with bounded cleanup. No real project, configuration, model, dependency, installer or remote operation is involved.

- `corepack pnpm test electron/repositories/__tests__/import-run-representative-chapters.test.ts electron/controllers/__tests__/db-controller-project-context.test.ts src/services/workflows/__tests__/import-workflow.test.ts src/services/workflows/__tests__/import-run-orchestrator.test.ts electron/services/__tests__/import-generation-targeted-selection.test.ts electron/services/__tests__/import-generation.test.ts electron/repositories/__tests__/import-run-execution-lease.test.ts electron/repositories/__tests__/import-run-receipt.test.ts electron/repositories/__tests__/import-run-author-inference-integration.test.ts electron/repositories/__tests__/import-run-captured-reference.test.ts src/shared/__tests__/import-style-materials.test.ts src/shared/__tests__/import-inference-materials.test.ts electron/__tests__/preload-bridge.test.ts src/services/__tests__/ipc-client-project-session.test.ts`: exit 0, 14 files, 284/284, 24.86 s.
- Initial `corepack pnpm test electron/services/__tests__/import-representative-prompt-parity.test.ts`: exit 1, 30 passed/10 failed. The fixture incorrectly expected reference source numbering to survive stable renumbering and attempted gapped author imports into an empty project. Production correctly rejected the latter. Repair uses legal continuous author inputs, checks reference persistent numbering, and adds two genuine author-gap rejection tests; it does not bypass preview, mutate the DB to manufacture author authority or change production behavior.
- Final same prompt-parity command: exit 0, 40/40, 19.07 s. An independent old paged reader supplies the oracle. Complete global/style tasks/messages and sample hashes/counts are compared for both writing languages, legal reference/author modes, short books and 201-row pagination; UTF-16 truncation, whitespace and empty results retain their original semantics. Persistent gapped rows are separately covered by repository tests; reference prepare renumbering is not misreported as persistent gaps.
- `corepack pnpm run typecheck`, `corepack pnpm run lint`, `corepack pnpm run check:i18n`: exit 0. Lint was rerun after the final parity fixture repair. The final build's TypeScript check also includes that repair.
- `corepack pnpm run build`: exit 0 after all code/test fixes. Existing alias/freeze/chunk/dynamic-import warnings remain; no warning suppression or dependency change was introduced.
- `git diff --check`: exit 0; this is a static whitespace check, not runtime evidence.

The real-SQLite fixed-body comparison returned 30,720 / 307,200 / 3,072,000 UTF-8 body bytes for the old paged 10/100/1000-chapter reader, versus 15,360 for each representative query. These are returned body bytes, not disk reads, SQL latency, allocation/GC measurements or an end-to-end speedup.

## Source Identity

The dirty pre-commit source build is entry `0c75c59ebed08c7aec1a2c3f85e80ae93abb1ccb` plus these read-only Git blob identities. No code changed during final regression/build/scene. Records are completed afterwards and do not alter that build.

| Path | Git blob |
| --- | --- |
| electron/__tests__/preload-bridge.test.ts | 68c29a7f26d3e8fb374cced7c2f54f8801be719e |
| electron/controllers/__tests__/db-controller-project-context.test.ts | faa4acc69bd6b5edf9defc5e22c052a8fdc2de0e |
| electron/controllers/db-controller.ts | ce242f8f9ee0a9888436e78f6669cae42364ef38 |
| electron/repositories/import-run-repository.ts | 94e9b62f9072820b3a1be36c1472580f8b70a2d1 |
| electron/repositories/__tests__/import-run-representative-chapters.test.ts | a6f2f9f6efe487665f92c07ebb645782f37821a5 |
| electron/services/__tests__/import-representative-prompt-parity.test.ts | c9e4f84de2c1a4529895fe614e278b22938dcfe1 |
| src/services/__tests__/ipc-client-project-session.test.ts | 008c6171f8348bf36dea259655501cefd64a2ac1 |
| src/services/workflows/__tests__/import-workflow.test.ts | e4e618fa4bf1cdddb518ce30f55bad0b393ed4a6 |
| src/services/workflows/import-workflow.ts | 08ee8adcef6bf3dcde97c82954415b83ebb06fa6 |
| src/shared/ipc-channels.ts | b3b5934b233494c9022ff0cce6543664f6f469d7 |
| docs/adr/0061-import-generation-targeted-selection-and-range-reading.md | c965a116ff80bf85949daf37730b3fdbf92aaeb1 |

Build entry SHA256: `dist/index.html` = `32C57C337EC2206D23D849FD565E1AF22B1E85B3D40AA2424D501CF49527432E`; `dist-electron/main.js` = `A1C5316BFA3A01CA873A7DF6FD6EB584825A61D05304FBA4CA6084ED02CA9125`; `dist-electron/preload.mjs` = `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B`.

## Controlled Electron Observation

`corepack pnpm run verify:drive -- --scenario perf-import-10 --theme light --out .runtime/creation-runtime-modernization/recheck-2026-11-10/stage37 --console`: exit 0 after reading the driver and actual performance scene. It creates a separate fictional profile/project, uses only the loopback fixture and closes that app. No heavy test/build ran alongside it. The source-SHA override was temporarily absent and restored, so report `sourceSha` is null rather than an untrue clean-HEAD attribution.

Report `perf-import-10-light.json` SHA256: `ACC7564C09E8F0E75F42477E17311A7EA901F9C0A5EFDB20A5EFC164C3ADAA3B`. Electron 44.9.3 / Node 24.22.0 / Chrome 152.0.7977.167, 1440x900 light, uncontrolled cache. The actual scenario took 20,614.7752 ms, completed 10 imported and 10 blueprint chapters with 32 physical fixture requests, retained 24 generation diagnostics (four import slots and 20 author-finalization slots), and observed the real author/global/style/blueprint/refresh checkpoints. Import root is completed; 10 publish and 10 postprocess checkpoints remain separate facts. Main RSS maximum was 225,722,368 bytes and measured event-loop maximum 94.699519 ms for this sample only.

Normal quit, zero cleanup failures, cutoff requests, external requests/writes/ignored writes or residual processes. Root personally inspected the screenshot: run heading is 10 chapters, blueprint/manuscript navigation is 10/100, saved target stays 100, and the 3000-versus-860 proposal remains unadopted. This checks actual workflow state and preserves author choice; it is not literary-quality, visual-fidelity, workflow-p95, fixed-throughput or packaged-platform qualification.

All six original Stage 34 baseline JSON hashes were recomputed and remain unchanged, including the failed 1000-chapter attempt. Unsupported two/four-book samples and the earlier unobserved renderer queue are not relabeled as covered.

## Independent Review And Limits

Repository and production-consumer implementations use separate `gpt-6.1-terra/high` assignments; the parity implementer uses `gpt-6.1-sol/high`. Root owns integration and execution. Independent integrated reviewer `gpt-6.1-sol/high` reviewed final production and repaired test bytes: no blocker or required missing test identified. The separate `gpt-6-luna/high` evidence review requested removal of unsupported historical IO/GC/stall wording from ADR-0061; it now describes potential costs and requires separate measurement. Final artifact/claim review is recorded after checking these identities.

Independent evidence review recomputed all 11 source blobs, three build entry hashes, the Stage 37 report hash and all six Stage 34 baseline hashes; all matched with no factual blocker. The report retains null source-SHA attribution and has no exported absolute paths/raw errors; diagnostic/checkpoint counts agree with the records. This is read-only artifact review, not an independent test/build/scene rerun.

`PERF-001` remains incomplete; `PERF-002` stays `in_progress/passes=false` while its prerequisite and full qualification remain open. This slice does not migrate import/imitate runtimes, authorize background legacy operations, add UI, infer real-model quality or pass three-platform qualification.

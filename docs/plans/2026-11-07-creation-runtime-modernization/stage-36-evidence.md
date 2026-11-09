# Stage 36: Production receipt diagnostics and safe performance exports

Date: 2026-11-10. Entry: `33fde136b7df7bcb78fbbef5b9f60e2063175a9c`.

## Frozen Scope

This partial PERF-001 package connects existing production receipts to an authorized, fixed-field diagnostic read and consumes it in the isolated performance driver. Performance-only report serialization must exclude local absolute paths and raw error text without changing cleanup, secret scanning, external-write detection or failure denominators. It does not add UI, stored fields, migrations, model execution, recovery authority, retries or timers.

The main-owner, performance-consumer and report-output implementations have separate write ownership. Root integrates the shared contract/controller and transport tests, owns documentation, commands and Git. An independent automation reviewer assesses the integrated code; a separate evidence reviewer checks claims and source/artifact identity. Implementers are not their sole acceptance authority.

## Validation Mapping

| Boundary | Required evidence |
| --- | --- |
| Session and run authority | Registered IPC/client/preload tests; missing/stale/foreign session and exact-handle rejection |
| Frozen receipt projection | Settled/unknown/legacy records; source and slot identity; field-by-field privacy and no new dispatch or ledger write |
| Real driver consumption | Default production orchestration branch, success/failure/drain cutoff, missing coverage, preserved original errors and denominators |
| Safe report output | Windows/UNC/other-volume/prefix containment, nested paths/errors, matching JSON/stdout projection, unchanged internal paths |
| Integrated source | Focused tests, typecheck, lint, i18n, source build, then one controlled Electron scenario without a real model |

Full effective request parameters and new projection/post-process timers are deliberately outside this slice. Historical gaps remain unavailable, not reconstructed from current configuration. Original Stage 34 reports, including the 1000-chapter timeout, are retained unchanged. No feature promotion, literary-quality conclusion, statistical workflow p95, real-model/billing result or platform qualification is implied.

## Execution

All commands run at the project root with Node 24.13.0 and pinned Corepack pnpm 11.11.0. Tests use fictional temporary/in-memory projects and can update local test caches; the source build rewrites local build outputs. No dependency change, real model/configuration/manuscript, packaging, installer or remote operation is included.

- Initial nine-file driver/bridge package: 150/152, exit 1. Two old pressure assertions prohibited every post-stop IPC; they now permit the exact read-only `generation:list` call, continue to forbid execute/resume/retry and retain cancellation/drain assertions.
- Initial seven-file native/core package: 482/486, exit 1. The registered controller fixture used an unrecognized domain label and omitted trusted usage, so its correct diagnostic result is unknown/null. Three owner fixtures incorrectly assumed JSON property-order hashing, changed an already artifact-bound fingerprint, or fabricated the short-outline binding without its actual replay task. Repairs use the existing stable model receipt hash, separate unbound extra-field coverage, and execute the real short-outline-to-draft receipt chain. No production integrity protection or assertion was removed to hide these failures.
- Final driver/bridge command: `corepack pnpm test scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs scripts/redesign/__tests__/drive-performance-output.test.mjs scripts/redesign/__tests__/drive-profile-writes.test.mjs scripts/redesign/__tests__/drive-quit.test.mjs scripts/redesign/__tests__/drive-args.test.mjs scripts/redesign/__tests__/real-model.test.mjs electron/__tests__/preload-bridge.test.ts src/services/__tests__/ipc-client-project-session.test.ts`: exit 0, 9 files, 152/152. A filename containing real-model tests exercises its deterministic transport guards, not a real model.
- Intermediate repaired diagnostic-only filter: `corepack pnpm test electron/services/__tests__/main-generation-owner.test.ts electron/controllers/__tests__/generation-controller.test.ts -t "read-only run diagnostics|diagnostic"`: exit 0, 33 passed and 323 skipped. This preceded the final six malformed-request cases and is not their evidence.
- Final native/core command after the exact-request guard: `corepack pnpm test electron/services/__tests__/main-generation-owner.test.ts electron/controllers/__tests__/generation-controller.test.ts electron/controllers/__tests__/workflow-batch-controller.test.ts electron/controllers/__tests__/runtime-feedback-controller.test.ts electron/services/__tests__/generation-run-service.test.ts electron/services/__tests__/performance-diagnostics.test.ts src/shared/__tests__/performance-baseline.test.ts`: exit 0, 7 files, 493/493, 140.45 s.
- `corepack pnpm run typecheck`, `corepack pnpm run lint`, `corepack pnpm run check:i18n`: each exit 0 after the final request guard; lint includes the color-literal check.
- `corepack pnpm run build`: exit 0 after all code fixes. Existing alias/freeze/chunk/dynamic-import deprecation warnings remain, without a new warning suppression.

Build entry SHA256: `dist/index.html` = `2DE91BDAECB53CC184EC5DCB7D5A6ED83BE542C41739E379E9C23917EFEC3F0A`; `dist-electron/main.js` = `C874452F2BB01EF8FFF6A64120E9C260B9EA65FD76F4768E6F355B5425B00188`; `dist-electron/preload.mjs` = `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B`. This is a dirty pre-commit source build identified by entry SHA and the following blobs, not a clean-HEAD or packaged-platform claim.

## Source Identity

These Git blob IDs were calculated read-only with `git hash-object`, without writing objects. No code changed during final regression/build.

| Path | Git blob |
| --- | --- |
| electron/__tests__/preload-bridge.test.ts | d99c7c0cb3ee33c7bae24b4c31445b1644cdbe50 |
| electron/controllers/__tests__/generation-controller.test.ts | 100d0b8759527a09500a81dc6574df2b9177eddb |
| electron/controllers/generation-controller.ts | 37b85ac9c4afd322fe6d448b54869491f6143198 |
| electron/services/__tests__/main-generation-owner.test.ts | cb6b8d3a206fdc439f4a0cff4747a73f6a3731eb |
| electron/services/main-generation-owner.ts | f43a188e9b409118af41d2b9ff8c491b53a2119c |
| scripts/redesign/__tests__/performance-baseline.test.mjs | b228b2a37a76e4319798713660bd2683a3ef105f |
| scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs | b96387130e686e50fa572b5078a3cccff17c0ca5 |
| scripts/redesign/__tests__/drive-performance-output.test.mjs | ce1af776775a1752942f7ea64e875de2807fd918 |
| scripts/redesign/drive.mjs | 380132dea677050fa62913ba1d0c64268550bfe8 |
| scripts/redesign/drive-performance-output.mjs | b20be4fbf636419a3833d7a6e040f08a52382dfd |
| scripts/redesign/performance-baseline.mjs | 453aafb19eb0a8235990f13389ca8ee698b88eb6 |
| scripts/redesign/performance-pressure-scenarios.mjs | fcc265f10f54248e755aaeba06a381ac1158ed7b |
| scripts/redesign/performance-scenarios.mjs | ff1ff163d138dbdb4a2589f942d9f46ca88de089 |
| src/services/__tests__/ipc-client-project-session.test.ts | 7add12229e483080c9e5bdbe1962f1c822da6df7 |
| src/shared/generation-owner-contract.ts | 1c6c8714e0dfbe2c8558a937f53143528fed3fd9 |
| docs/adr/0060-creation-runtime-performance-diagnostics-and-cost-attribution.md | 776d57fca5f7878e7c2e12d9efd1634e375580ea |

## Independent Review

The implementation assignments use `gpt-6.1-sol/high` for the owner and `gpt-6.1-terra/high` for the consumer/export. Independent integrated source reviewer `gpt-6.1-sol/high` found and rechecked the missing stable report labels and the narrow malformed-request guard before owner admission; a separate implementer also independently reviewed the controller's corrupt-receipt logging. All identified code issues are closed in the source reviewed above. Review is static, not independent test execution or full feature acceptance.

## Controlled Electron Observations

Each scene ran serially with `corepack pnpm run verify:drive -- --scenario <name> --theme light --out .runtime/creation-runtime-modernization/recheck-2026-11-10/stage36 --console`, after reading the driver and scene sources. The source-SHA environment override was temporarily absent and restored afterwards: report `sourceSha` is null, not a false clean-commit label. Each invocation creates a separate fictional profile/project, uses only the local loopback fixture, captures evidence and closes that app. No heavy build/test ran alongside the measured work. Electron 44.9.3 embeds Node 24.22.0 / Chrome 152.0.7977.167; the viewport is 1440x900 light and cache state uncontrolled.

| Scene | Actual result | Report SHA256 |
| --- | --- | --- |
| perf-import-10 | Exit 0; 20140.9997 ms; 10 imported/10 blueprint chapters; 32 requests; 24 generation run diagnostics retained with actual source/slot association; prepared import root observed at completed with real author/global/style/blueprint checkpoints | A713E990363022667B68F40FB29FCBC50E580AAAC6A2314BBBFD83FF3DCED65B |
| perf-long-stream | Exit 0; 32196.4815 ms; 2 physical requests / 2 settled / 0 unknown; 400 visible and 20 reasoning chunks; one production diagnostic, with the true short-outline and draft purposes and same initial replay-task hash | 8AFCBADED2251D4B56C45D831ACA2BF881D01BFFC707DCF51C0B5993464F8192 |
| perf-rate-limit | Exit 0 for the failure-handling scenario; 22143.0269 ms; 1 HTTP 429 request / 1 failed generation attempt / 1 unknown / 0 settled; no visible successful artifact or automatic resend; diagnostic transport retains 429/HTTP_ERROR and usage remains null | B1D1289ED6CA94FED5A33107A70A80508F63B4778463B8F49D581C7FBB2CAC92 |

All three record normal quit, zero requests after measurement/final cutoff, zero external requests/writes/ignored writes and zero residual processes. Scene success does not change the 429 generation failure denominator. Generation-run status is the stored owner status, not a fabricated workflow-completion status. Non-import scenes have zero retained import runs and do not acquire import coverage. Historical effective parameters remain `not_recorded`; actual loopback request observations are separate bounded fixture evidence (32/32 and 2/2 retained, respectively; the 429 route does not provide parsed fixture chat parameters).

Root personally inspected all three screenshots. Import: run heading is 10 chapters, blueprint and manuscript navigation both show 10/100; the saved target remains 100 chapters, not a claim that all 100 were imported. The complete card, 10 author-publish and 10 author-postprocess checkpoints agree with the report; the 3000-versus-860 adoption proposal remains unadopted, preserving author choice. Long stream: chapter 3 in the tab, page and run card agree, draft v2 shows 9200 units, the existing 2/12 finalized count is unchanged, and the card is completed. Rate limit: chapter 3 remains unwritten, 12 blueprint rows and 2/12 finalized remain unchanged, and the run card explicitly shows failed short-outline generation with no saved draft. These are workflow-state inspections, not literary-quality, design-fidelity or three-platform acceptance.

New JSON/stdout exports use safe copies with opaque non-output paths/identities, preserved source hashes and relative screenshot references. Existing six Stage 34 raw artifacts are not rewritten or relabeled as anonymized. This finite internal projection is not a general-purpose sanitizer for arbitrary untrusted JSON; some unlisted machine labels are opaque rather than inferred. Original 1000-chapter timeout/forced quit, unobserved renderer queue and unsupported two/four-book rows remain part of the baseline.

Independent evidence reviewer `gpt-6-luna/high` recomputed all 16 source blobs, three build hashes, three new report hashes and six original baseline report hashes. All match; the original reports are unchanged. The reviewer checked actual diagnostic coverage, unknown/settled counts, null source-SHA attribution and absence of exported absolute paths/raw errors, and found no factual blocker for this narrow commit. This is read-only artifact review, not an independent test/build/scene rerun. `PERF-001` stays `in_progress/passes=false`; the package does not claim the missing full matrix/source/step coverage or unlock feature completion.

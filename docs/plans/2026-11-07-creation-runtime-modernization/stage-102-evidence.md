# Stage102: Complete Reference Recovery And Real Feedback Entry

Date: 2026-11-15. Parent: `374698fc1ceedc343739f0eb67d850c17cf8cb27`.
That is the committed Stage101 author/background-view integration. This slice
integrates the parallel recovery work whose raw report names contain Stage103;
those names are not extra completed features. Only IMPORT-001 is completed.

## Scope And Validation Mapping

| Original feature / AC | Actual increment and applicable evidence |
| --- | --- |
| IMPORT-001 AC1: all reference entries, sources and five owners | New/current import, parsing continuation, continuation of the same run and restart reach the existing reference whole driver. Text/EPUB, frozen source snapshots, manifest/checkpoint and knowledge/global/style/blueprints/refresh effects retain their existing owners and stage/slot gates. Current registered eight-file359/359 and parser two-file29/29 supplement the unchanged, source-bound browser47/47 and repository30/30. |
| IMPORT-001 AC2: A running while viewing B | Reuse Stage101's actual ninth isolated Electron A/B/A scene: one original execution, five ordered ACKs, retained physical A request, saved B edit and a new actual-A projection lease. Final whole32/32 and all child gates recheck the current source/native/session authority. Not simultaneous generation in multiple books. |
| IMPORT-001 AC3: cancel, unknown, crash residue, partial commit, projection and changed source | Expired unstarted authority can be cancelled only at its original idle boundary; failures retain cleanup debt. Four projection boundaries really close and reopen the same database before continuing the original run. Unknown style preserves the original attempt/receipt and one dispatch under the new lease. Completed refresh can read canonical committed history without recreating issuance. Current tests separately cover real in-flight crash snapshots, prepared/committed effects, cancellation drain and source-change refusal. |
| UI-002 / existing feedback entry, partial only | Initial `generation:list` and `planning-feedback:v1:capture` wait for already admitted current-view physical work through the existing exact-channel drain path. A genuine model candidate is generated once and explicitly adopted into official premise with a persisted receipt. Full UI design/state coverage and multi-round/reopen acceptance remain open. |

Root owns shared integration, ADR-0029, evidence and Git. Requested Luna owns
feedback scenario selectors; Terra owns idle cleanup; Agent5 owns fresh-native
recovery. Sol independently accepts Root's three owner-drain files and Agent5's
four files; Luna independently accepts Terra's two files; Terra independently
accepts Luna's selector repair. Agent4 independently accepts all three original
IMPORT-001 AC after reading final source identities and actual raw reports.
Native/build/Electron operations are serialized. Parallel API/CLI and imitation
files are excluded from this slice and its completion judgment.

No new schema, migration, SCHED-002 prerequisite, generic background permission,
approval policy, UI layout, wording or resource is introduced. The visible
behavior uses the existing feedback dialog/author actions and ADR-0021/0041/0049
presentation, not a new design. A missing UI state design remains a UI-local gap.

## Production Boundaries

- Idle TTL cleanup reuses the existing repository CAS. It requires the same
  original running owner/epoch, expired lease, no resumed/whole/knowledge
  execution, no in-flight work or stage flight and an exclusive parent claim.
  The repository rechecks these facts. It never renews TTL, resets budgets,
  deletes unknown receipts or takes over successor/completed/active work.
  Failed cleanup remains retryable on close without releasing real work early.
- Fresh-native whole recovery proves old native closure and opens the same
  original root without seeding again. A newly authorized owner/epoch resumes
  the original run/manifest/effect namespace and committed receipts. The four
  projection-failure reopen tests are controlled reopen tests, not OS kills.
  The knowledge in-flight database snapshot test supplies crash-residue evidence;
  style unknown preserves the exact persisted attempt, usage and request hash.
- Completed refresh uses only the exact reference run/grant/revision already
  committed. Its canonical reader obtains no issuance, performs no projection
  and changes no SQLite rows. Active/unknown/wrong-revision requests still fail.
- Only the literal `generation:list-recovery`, `generation:list` and
  `planning-feedback:v1:capture` initial-owner paths may wait for physical view
  work. Sender/session/root/native/epoch are rechecked in the synchronous drain
  callback and after awaiting. Original owner, non-view busy, retirement and
  interrupted-recovery checks remain. Matching existing owners retain their
  old path. Feedback capture writes no base while waiting and retains its
  original transaction. This is not a retry, prefix permission or pure-read
  reclassification. ADR-0029 records this narrow behavior.
- Verification tools inject the authorized loopback key only into in-memory
  fetch. Persisted profiles contain a placeholder, and the key is stripped from
  Electron's launch environment. Only POST to the exact authorized generation
  endpoint is allowed, without redirect following. Physical dispatch is counted
  before sending; unknown is not retried and this real scene cannot restart.
  Normal quit must resolve unforced with no kill. Startup and renderer network
  coverage are not asserted by this main-fetch guard.

## Commands And Current Results

Working directory: repository root. Environment: Windows x64, Node24.13.0,
Corepack pnpm11.11.0, Vitest4.1.12, Electron44.9.3. Root commands set
`COREPACK_ENABLE_NETWORK=0`. Tests use recoverable fictional temporary roots,
not actual author works/configuration. Logs and JSON remain under
`.runtime/creation-runtime-modernization/resume-2026-11-15/` (abbreviated R below).
Pipelines preserve actual process exit codes; test counts overlap, not a sum.

```powershell
corepack pnpm test electron/controllers/__tests__/generation-controller.test.ts electron/controllers/__tests__/reference-knowledge-controller.integration.test.ts electron/controllers/__tests__/reference-knowledge-driver.integration.test.ts electron/controllers/__tests__/reference-global-driver.integration.test.ts electron/controllers/__tests__/reference-style-driver.integration.test.ts electron/controllers/__tests__/reference-blueprint-driver.integration.test.ts electron/controllers/__tests__/reference-refresh-driver.integration.test.ts electron/controllers/__tests__/reference-run-driver.integration.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/import-feedback-current-eight-final.json
corepack pnpm test electron/controllers/__tests__/import-controller-persistence.test.ts electron/controllers/__tests__/import-controller-secure-file.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/import-parser-current-two-final.json
corepack pnpm test scripts/redesign/__tests__/drive-quit.test.mjs scripts/redesign/__tests__/drive-isolation-cleanup.test.mjs scripts/redesign/__tests__/drive-args.test.mjs scripts/redesign/__tests__/real-model.test.mjs scripts/redesign/__tests__/real-feedback-scene.test.mjs scripts/redesign/__tests__/reference-run-background-scenario.test.mjs --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/drive-tools-stage102-final.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
corepack pnpm run verify:drive -- --scenario real-feedback-adopt --real-model --max-real-requests 1 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage102-real-feedback --theme light --dump-dom --console
corepack pnpm run verify:drive -- --scenario real-feedback-adopt --real-model --max-real-requests 1 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage102-real-feedback-retest --theme light --dump-dom --console
corepack pnpm test scripts/__tests__/creation-runtime-feature-evidence.test.ts --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/checklist-stage102-final.json
```

- Final eight files exit0,359/359,0 failed/pending: generation138,
  knowledge-controller51, knowledge-driver18, global39, style22, blueprints39,
  refresh20 and whole32. This one integrated run includes all final idle TTL,
  fresh-native and seventeen owner-drain regressions. It is not the old668.
- Parser two files exit0,29/29 (persistence18, secure-file11). These registered
  controller tests exercise actual isolated files/SQLite with the current shared
  runtime/repository composition. Stage53 old332 is not relabeled current.
- Tools six files exit0,141/141,0 failed/pending, including background observer64
  and real-feedback scene2. These tests do not themselves run Electron/models.
- Current typecheck, lint/colors, i18n and source build all exit0. Logs:
  `typecheck-stage102-103-final.log`, `lint-stage102-103-final.log`,
  `i18n-stage102-103-final.log`, `build-stage102-103-final.log`.
  Vite alias/output-option/chunk-size/dynamic-import warnings remain; this is
  not zero-warning build, installation, packaging or target qualification.
- Final record checklist exits0,36/36,0failed/pending in
  `checklist-stage102-final.json` and the same-name log. It checks only F2 source,
  schema, evidence labels and dependency consistency, not functional acceptance.

## Failed Attempts And Root-Cause Regression

- First actual real-feedback command uses the Stage101 product build and the
  prior verification-tool identities in its manifest, before these repairs.
  It exits1 on a20second locator timeout,
  zero model dispatch. The label is not associated by htmlFor/id; actual ARIA
  names the textbox from its placeholder. The separate production console also
  shows initial list/base capture rejected by `PROJECT_RUNTIME_BUSY` before
  project loading finished. No candidate/adoption is claimed. Setup did create
  fictional project state. Quit resolves227ms unforced; first raw/PNG remain.
- Selector repair executes the real scenario function in pure tests: genuine
  RED2failed -> GREEN2/2. It uses the exact actual textbox accessible name,
  without sleep, readiness bypass or fallback; independent Terra accepts it.
- Root owner-drain regressions use actual registered handlers, host and SQLite.
  Genuine RED6passed/11failed/121pending -> GREEN17passed/0failed/121pending
  precedes the final138/138 full-file run. They cover drain, stale lease,
  destroyed sender, non-view work, new work, timeout, close-first release,
  active reference owner and concurrent initial list/capture. Recovery occurs
  once, base is written once, and none dispatches a model request.
- Terra expired-idle RED1failed/42skipped becomes final51/51. Failed cleanup,
  close retry and persisted transport_unknown do not erase their debt/receipts.
- Refresh fresh-native RED1failed/19skipped is retained. Initial three-file
  recovery73/74 and style epoch/repository fixture failures remain. The final
  style22/22 and final integrated359/359 close them; no old authority/epoch is
  forced across reopen and no test keeps a repository bound to a closed DB.

## Actual Real Feedback And Visual Boundary

The retest uses the freshly built product and the user's exact authorized model
on `127.0.0.1:8045`, with max1 request. It exits0: one POST chat/completions200,
5679ms to response headers, one persisted candidate and one author-action
adoption. Official premise equals the candidate; adoption beforeValue equals
the old premise and hashes/identities match. No embeddings, restart or retry.
Quit resolves290ms, unforced, kill not-needed. There are no observed external
fetches (`observed_before_quit` only), external profile writes or residual
processes. One isolated model config is removed; key scan6files has0hits,
0unreadable and0removeFailures. The environment key/BSTR are cleared afterward.
Including the earlier protocol probe, two real requests have been used from the
initial twelve-request budget; ten remain. The first failed production attempt
used zero, so no unknown request was resent.

Root reads JSON, console and all three1440x900 light PNGs. Candidate shows
round1/C1, consistent with one candidate. Architecture4/4, blueprints8 and roster1
are seeded fixture facts, not newly generated outputs. The adopted/final PNGs
match and show the saved premise plus adoption toast; formal-save/receipt
assertions come from actual IPC readback, not the toast. The candidate diff
displays4 additions/4 deletions; that count is not a literary assessment. The
existing candidate-action row is horizontally scrollable; this is not full UI
layout/state acceptance. Only existing CSP warnings remain, not the earlier
busy/generation errors. Full model quality, multi-round/reopen feedback,
complete UI002 and statistical performance remain unverified here.

## Reused Evidence And Completion Self-Check

Applicable evidence is rebound by [the source manifest](stage-102-source-manifest.json):
Stage101 ninth actual author scene, its source/version limitations and three PNGs;
Stage101 real React import-resume47/47; Stage100 current import repository30/30;
Stage53 parser/controller identity only, superseded by the current29/29 for
integrated persistence. No historical PASS or evidence-type label qualifies a
feature without the actual current call/receipt/state evidence.

Root's required IMPORT-001 self-check, after independent Agent4 acceptance:

1. Requirements/AC: actual increment closes the three original reference-import
   AC for R1/R2/R4/R5. AC, dependencies and evidence types are unchanged; no
   unsupported worker, platform, real-model or scheduler prerequisite is added.
2. Delivery: all reference entry variants and five production stages map to their
   existing effect owners. Actual author invocation, saved knowledge/receipts/
   blueprints, source manifest and true-native restoration have direct evidence.
   Internal recovery and UI001's separate full presentation AC are not confused.
3. Correctness: source/sender/session/native/epoch, bounded work/drain, unknown
   no-resend, original receipts and budgets, unique writers and author buffers
   remain. Independent Sol/Luna/Terra reviews and Agent4 full-feature review
   close the in-scope findings; no unresolved correctness blocker is identified.
4. Evidence: final359/359 and29/29 cover final modified sources; applicable
   unchanged browser/repository/actual desktop evidence is identity-checked.
   Static review, deterministic/native tests, actual fake-provider Electron,
   this single real feedback model run and absent platform/quality evidence are
   separate. The real feedback run is not used to qualify import literary quality.
5. Alignment: only IMPORT-001 is completed/passes=true. Schema, all35 IDs, AC,
   DAG and other statuses remain. UI002 gets partial evidence, not completion.
   Source/records/review are frozen before the exact-path local commit; its SHA
   is recorded in the next implementation-log update. Remaining feature work
   proceeds independently rather than adding unrelated gates to completed import.

Remaining IMPORT-001 scope gap: none found under its original AC. Completion
does not qualify multi-book simultaneous imports, full imitation, all UI recovery
states, literary non-regression, speedup or the three target platforms. The14
older completion markers are carried forward, not requalified. After this one
completion the checklist is15/35 (42.9%), with20features still in_progress.

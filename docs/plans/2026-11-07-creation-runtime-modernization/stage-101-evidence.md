# Stage101: Admitted Reference Run With Another Book In View

Date: 2026-11-15. Parent: `54ea2e74c04b5568c00549308136a640a2f0b6a8`.
Stage100 is committed at that parent. This bounded increment does not complete
IMPORT-001 or UI-001, change their AC/dependencies or require SCHED-002.

## Scope And Validation Mapping

| Original requirement / AC | Actual increment | Evidence / remaining scope |
| --- | --- | --- |
| R1/R2, IMPORT-001 AC1/2 | The existing author whole-reference entry can retain its captured main runtime and original execution while the author opens and edits B, then returns to A. Only the first validated stage-started event admits that renderer run. | Five actual native child gates, retained adapters, renderer/store tests and the isolated author desktop scene. Unadmitted, author-manuscript and legacy batch entries remain protected. |
| R2, UI-001 | Reuse the existing RunSheet background row and Switch & View flow; preserve B's saved configuration and live editor buffer. The new A projection lease is not execution authority. | Existing presentation/browser checks and the desktop scene; not all close/recovery states or complete UI-001. |
| IMPORT-001 AC3 and existing runtime boundaries | View ACK/readback is separately authorized against the actual current A view; execution, sender, grant, owner/epoch, native identity, parent and physical drain stay frozen. Safe managed view retirement preserves unknown work and cleanup debt. | Native invalid identity/token/new-lease, offscreen terminal drain, retirement and renderer failure regressions. Idle/unstarted expired issuance cleanup and explicit durable-reopen evidence remain open. |

Root owns contracts, stores, ADRs, records and Git. Requested Luna owns renderer
projection, Terra main reference owners, Agent5 retained runtime/view adapters;
Sol independently reviews main changes and owns the isolated scene. Agent4
independently reviews integrated source, renderer fixes, contracts and evidence.
No shared native/build environment or Git operation is run concurrently.

Design evidence: [ADR-0049](../../adr/0049-background-project-tasks-and-transition-presentation.md)
and its existing RunSheet/background-task regions. The only changed visible
behavior is that an admitted reference task remains in the existing A background
row while B is current, and the existing Switch & View returns to A. No new
layout, wording, badge, recovery control, resource or viewport is designed.
[ADR-0029](../../adr/0029-project-runtime-resource-routing.md) and
[ADR-0080](../../adr/0080-main-owned-foreground-reference-whole-run.md) bind the
managed open/view, retention and projection boundaries. No schema, dependency,
generic execution grant, public API execution or approval policy is added.

## Actual Production Boundaries

- The literal background-view IPC uses target open admission, not a current
  lease borrowed from A. Its required retention metadata routes later opens;
  it is not authority. Only successful target COMMIT can retire safe inactive
  managed views. Explicit raw retained views, actual current/busy/native users,
  live claims, unresolved receipts and unknown work are not silently released.
- Classified current-view DB reads and FS operations capture the actual view
  runtime and hold lifecycle locks through physical completion. Existing path,
  capability, transaction, atomic replace and source/CAS guards remain. Generic
  domain/generation writers do not inherit this adapter.
- A managed author open now waits for already admitted physical view operations
  to finish, then rechecks the captured view, latest request, target grant and
  native/canonical identity before synchronously taking the original ticket.
  The five-second UI wait never waits for A's model/ACK or releases/cancels work.
  B's recovery-candidate list is a precisely classified read; generation owner
  initialization waits only for view operations and retains all original busy,
  caller and interrupted-recovery checks.
- Main reference children retain the original captured resource and execution.
  View-side ACK requires actual current A, the original sender/reference/
  execution, opaque gate token and original parent. Generic generation cannot
  borrow a live dedicated owner. Revoke, destroy and close reject view waiters
  but still wait for actual physical drain before releasing work.
- Renderer projection waits for actual A and publishes its frozen new view
  session before resolving. Both already-returned and delayed-view paths do
  so; completion consumers reject obsolete sessions. Style captures only the
  actual A author buffer and preserves the existing expected-snapshot/CAS.
  Physical configuration writes finish before a view transition; no lifecycle
  lock is held while waiting for a view/model/ACK. Canonical read-only receipt
  reconstruction retains post-commit failure priority without resending work.

## Actual Commands And Reports

All commands run at the repository root with Node24.13.0, Corepack pnpm11.11.0,
Vitest4.1.12, Windows x64. Native fixtures are fictional, isolated and serialized.
Raw paths below share `.runtime/creation-runtime-modernization/resume-2026-11-15/`.
Counts overlap and are never summed. No install/rebuild, real manuscript/config,
real model, package installation or external publication is performed.

- Main/native27 files: `stage101-main-final.json` is **667/668, exit1**. Its
  single failure is an old global-foreground mock missing captured `acquireWork`;
  the five child gate/new-lease cases and offscreen revoke/destroy/close cases
  pass. The repaired global file later passes5/5 in the root eight-file report.
  Root then actually reruns the same27 files on the frozen pre-recovery-fix version:
  `stage101-main-retest.json` is **668/668, exit0**, zero failed/pending. The old
  failed report remains; this is a new whole-group rerun, not relabeling. The
  later recovery-read repair requires its own affected final regressions below.
- Retirement4 files: `stage101-retirement-final.json` is **98/102, exit1**.
  Four successful-output fixtures omitted provider usage, so durable attempts
  correctly remained unknown and blocked retirement. Production guard bytes
  are unchanged. Fixtures now supply trustworthy consistent usage and assert
  settled attempts; a new actual missing-usage case confirms retirement still
  refuses even after the owner itself is retirable. Final
  `stage101-retirement-usage-four-final.json` is **103/103, exit0**.
- Root8 files, `stage101-view-transport-retest.json`: **120/120, exit0**.
  Actual files are preload-bridge18, global-foreground5, ipc-client22,
  project-service-refresh-context8, project-transition-background16,
  workflow-store-reference-view9, background-qualification7 and scene35.
  Subsequent scene-only revisions require their own final report.
- Renderer2 files, `stage101-renderer-fastpath-final.json`: **120/120, exit0**.
  The actual workflow/store regression covers A-to-B-to-A before the first
  projection wait and checks the emitted completion session/history/unsubscribe;
  the separate real completion-consumer tests accept new and reject old leases.
  These are complementary tests, not a claim they are one full consumer chain.
  Because the implementing agent no longer has its exact command ledger, Root
  reruns the same final two files with the explicit command below:
  `stage101-renderer-root-final.json` is **120/120, exit0**, zero failed/pending.
- Browser4 files, `stage101-browser-retest.json`: **100/100, exit0** against
  installed Edge157.0.4341.60 with a temporary test profile. Existing act warnings
  and intentional import failure diagnostics remain. Earlier accidental full
  browser execution passed92 files1343/1343 in `stage101-browser-first.log`, but
  predates the final projection correction and wrote no JSON; it is not the
  final full-suite qualification.
- `corepack pnpm run typecheck`, `corepack pnpm run lint`,
  `corepack pnpm run check:i18n` and `corepack pnpm run build` exit0 in the
  recorded pre-recovery-fix final/retest logs. That build includes the renderer
  correction but precedes the recovery-read repair, writes `dist/`/`dist-electron/`
  and retains existing Vite
  resolver/output-option/chunk warnings. Scene-only revisions are not compiled
  into that production build; their final lint/tests are recorded separately.
- The later B generation owner drain and whole driver2files actually pass
  **149/149, exit0**, zero failed/pending, in
  `stage101-recovery-view-drain-two-final.json` (121controller +28whole driver).
  Four new registered cases prove view drain, stale-session rejection,
  non-view busy rejection and post-drain new-work recheck, with A's independent
  simulated parent/work preserved. They do not alone prove all unknown or
  retirement branches; the full affected files retain their existing coverage.
  No independent RED was executed for this change. This report precedes the
  later host async-callback preflight guard. That subsequent guard has its own
  final runtime/open78/78 and later runtime51/51 reports plus the ninth actual
  desktop below; the149 report is not relabeled a rerun of those later edits.

The filtered command ledger below records actual invocations. Source/report identities and
build-entry hashes are in [the manifest](stage-101-source-manifest.json). These
build entries are not a complete build-tree or packaged-platform attestation.

```powershell
corepack pnpm test electron/services/__tests__/project-runtime.test.ts electron/services/__tests__/project-runtime-compatibility.test.ts electron/services/__tests__/project-runtime-lifecycle.test.ts electron/controllers/__tests__/project-controller-context.test.ts electron/controllers/__tests__/project-controller-open-atomicity.test.ts electron/controllers/__tests__/project-switch-renderer.integration.test.ts electron/controllers/__tests__/db-controller-project-context.test.ts electron/controllers/__tests__/db-controller-read-only.test.ts electron/controllers/__tests__/fs-controller-project-boundary.test.ts electron/controllers/__tests__/retained-view-adapters.test.ts electron/controllers/__tests__/generation-controller.test.ts electron/controllers/__tests__/agent-generation-controller.test.ts electron/controllers/__tests__/reference-run-driver.integration.test.ts electron/controllers/__tests__/reference-run-foreground.test.ts electron/controllers/__tests__/reference-global-driver.integration.test.ts electron/controllers/__tests__/reference-global-foreground.test.ts electron/controllers/__tests__/reference-style-driver.integration.test.ts electron/controllers/__tests__/reference-style-foreground.test.ts electron/controllers/__tests__/reference-blueprint-driver.integration.test.ts electron/controllers/__tests__/reference-blueprint-foreground.test.ts electron/controllers/__tests__/reference-refresh-driver.integration.test.ts electron/controllers/__tests__/reference-refresh-foreground.test.ts electron/controllers/__tests__/reference-refresh-failure.test.ts electron/controllers/__tests__/reference-knowledge-driver.integration.test.ts electron/services/__tests__/reference-knowledge-driver.test.ts electron/services/__tests__/reference-import-admission.test.ts electron/services/__tests__/import-stage-flight.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-main-final.json
# Same exact27-file command rerun with --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-main-retest.json
corepack pnpm test electron/controllers/__tests__/reference-knowledge-controller.integration.test.ts electron/controllers/__tests__/runtime-feedback-controller.test.ts electron/controllers/__tests__/workflow-driver-controller.test.ts electron/controllers/__tests__/workflow-batch-controller.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-retirement-usage-four-final.json
corepack pnpm test src/shared/__tests__/workflow-background-qualification.test.ts src/stores/__tests__/workflow-store-reference-view.test.ts src/stores/__tests__/project-transition-background.test.ts src/services/__tests__/project-service-refresh-context.test.ts src/services/__tests__/ipc-client-project-session.test.ts electron/__tests__/preload-bridge.test.ts scripts/redesign/__tests__/reference-run-background-scenario.test.mjs electron/controllers/__tests__/reference-global-foreground.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-view-transport-retest.json
corepack pnpm test src/services/workflows/__tests__/import-workflow.test.ts src/services/workflows/__tests__/reference-import-projection.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-renderer-root-final.json
corepack pnpm test scripts/redesign/__tests__/reference-run-background-scenario.test.mjs --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-scene-prefix-final.json
corepack pnpm test scripts/redesign/__tests__/reference-run-background-scenario.test.mjs --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-scene-library-final.json
corepack pnpm test scripts/redesign/__tests__/reference-run-background-scenario.test.mjs --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-scene-current-book-final.json
corepack pnpm test scripts/redesign/__tests__/reference-run-background-scenario.test.mjs --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-scene-ipc-observer-final.json
corepack pnpm test electron/controllers/__tests__/generation-controller.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-reference-recovery-root-final.json
corepack pnpm test electron/controllers/__tests__/reference-run-driver.integration.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-reference-recovery-whole-final.json
corepack pnpm test electron/services/__tests__/project-runtime.test.ts electron/controllers/__tests__/project-controller-open-atomicity.test.ts electron/controllers/__tests__/retained-view-adapters.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-view-drain-three-final.json
corepack pnpm test electron/controllers/__tests__/generation-controller.test.ts electron/controllers/__tests__/reference-run-driver.integration.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-recovery-view-drain-two-final.json
corepack pnpm run test:browser src/components/stage/run/__tests__/run-sheet.browser.tsx src/components/stage/__tests__/run-capsule.browser.tsx src/components/panels/__tests__/project-transition-unsaved.browser.tsx src/components/dialogs/__tests__/import-novel-resume.browser.tsx --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-browser-retest.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
```

Terra sets `COREPACK_ENABLE_NETWORK=0` for the retirement command. The browser
command temporarily sets `AI_NOVEL_VITEST_CHROMIUM` to the installed
Edge executable and restores the previous environment in finally. PowerShell
Tee-Object preserves each quality/driver log and the original exit status.

## Desktop Attempts And Remaining Execution

The new `f537-reference-background-10` scene uses only real author open/save/
return actions and passthrough observation of actual registered handlers. It
does not execute or ACK through a fixture, replace a store or fake saved effects.

1. First actual light run, `stage101-desktop/`, fails the unchanged Windows
   project-path preflight because the fictional B title is too long. Zero model
   requests, normal quit, no observed external/residual activity. Only the
   fixture title changes to `Ref B`. The direct production-preflight regression
   is RED35/36 then GREEN36/36; production path limits are not relaxed.
2. Second actual run, `stage101-desktop-retest/`, fails the scene's unsupported
   assumption that no stage can ACK before the first held HTTP response.
   Knowledge legitimately completes and ACKs under the original A view, then
   global waits for its model response. The report is a failure with12 fake
   requests and **forced quit**; empty observed external/residual lists do not
   turn it into a pass or normal exit.
3. Third actual run, `stage101-desktop-prefix/`, reaches the valid knowledge
   prefix/global held attempt but times out searching for B in the in-book
   palette. The actual recent-project file contains both A and B; create also
   registers B. The existing StageShell only includes cross-book palette items
   in the library. No B view has opened. The scenario must use the existing
   author Back to Library action before the existing book-open action, not add
   UI or directly change a store. This failure has12fake requests and forced
   quit, with no observed external requests/writes/residuals.
4. Fourth actual run, `stage101-desktop-library/`, verifies B's actual library
   cover but mechanically reopens already-current A in setup. An existing A
   physical view operation correctly refuses that redundant open. Zero model
   requests, normal quit and no observed external writes/requests/residuals.
   Existing current-book `Return to Work` navigation replaces only that setup
   reopen, not the actual later A-to-B-to-A transitions. Its genuine synthetic
   RED is52/53; final53/53 passes and Agent4 independently reviews the change.
5. Fifth actual run, `stage101-desktop-current/`, actually opens B, saves its
   author edit and releases A's held global response. A completes global while
   B remains current; B's saved value and buffer remain unchanged, only the
   earlier knowledge ACK exists and the whole operation remains unsettled.
   The genuine return to A is refused with PROJECT_RUNTIME_VIEW_OPERATION_BUSY.
   B additionally reports recovery-candidate-list legacy-unavailable and first
   generation recovery-owner busy errors. These are real in-scope blockers,
   not another setup defect. One fake request, normal quit, no observed external
   requests/writes/residuals; Root and Agent4 inspect all three1440x900 PNGs.

6. Sixth actual run, `stage101-desktop-drain/`, succeeds in both actual view
   transitions and settles the one whole run with five ordered ACKs and no
   cancellation. Knowledge uses the original A lease and the remaining ACKs
   use the actual returned A lease. The completion assertion checks saved
   receipts, original generation settlement and unchanged A drafts/B content
   before the final scene wait fails. Existing return-to-work navigation closes
   the RunSheet, so a passive wait for that sheet is an invalid scene assumption;
   the existing palette action must open it before the retained done/toast
   assertions. The console also exposes three real current-view SELECT readers
   (`db:revision-list`, `db:review-list`, `db:revision-get-pending`) incorrectly
   refused as legacy operations. Those errors include renderer page errors and
   are in-scope blockers, not discarded diagnostics. Twelve fake requests,
   normal quit, no observed external requests/writes/residuals. Root views all
   three1440x900 PNGs. The JSON/console/PNG remain a failed run, not a PASS.

7. Seventh actual run, `stage101-desktop-history/`, exits0 and passes all scene
   product assertions, including the actively opened RunSheet's completed
   history and completion toast. Measured values are one execute/five ACKs,
   ten knowledge/four stage receipts, four unchanged original draft/finalized
   records, B's author edit saved/preserved and12fake requests. It is **not
   stage acceptance**: `quit.forced=true`, and the now reachable downstream
   `db:review-get-full` SELECT is still incorrectly denied six times. Empty
   residuals do not establish normal exit. Root and Agent4 inspect all three
   PNGs, including the five green steps and matching top completion indicator.
   Console is written before quit in the existing harness, so the absent quit
   diagnostics cannot identify its cause. These are retained product/tool
   evidence gaps, not a guessed deadlock or grounds to extend the timeout.

All seven actual invocations use the same authorized command, changing only
the output directory so no earlier report is overwritten:

```powershell
corepack pnpm run verify:drive -- --scenario f537-reference-background-10 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage101-desktop --theme light --dump-dom --console
corepack pnpm run verify:drive -- --scenario f537-reference-background-10 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage101-desktop-retest --theme light --dump-dom --console
corepack pnpm run verify:drive -- --scenario f537-reference-background-10 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage101-desktop-prefix --theme light --dump-dom --console
corepack pnpm run verify:drive -- --scenario f537-reference-background-10 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage101-desktop-library --theme light --dump-dom --console
corepack pnpm run verify:drive -- --scenario f537-reference-background-10 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage101-desktop-current --theme light --dump-dom --console
corepack pnpm run verify:drive -- --scenario f537-reference-background-10 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage101-desktop-drain --theme light --dump-dom --console
corepack pnpm run verify:drive -- --scenario f537-reference-background-10 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage101-desktop-history --theme light --dump-dom --console
```

The third PNG also exposes a separate production P2: the new reference owner
is incorrectly treated as needing a legacy-owner handoff for the existing
`generation:list-recovery` read. The whole run is still active, but its work
claim causes PROJECT_RUNTIME_BUSY, mapped to GENERATION_REQUEST_FAILED. The
RunSheet renders a misleading unsaved-result error. Agent4 traces this to the
new owner mode; it is not dismissed as a warning or an actual whole terminal
failure. Terra owns a minimal read compatibility repair and real controller
regression; writer, sender, actual-view and no-handoff guards must remain.
The minimal reference-owner read repair passes117/117 in
`stage101-reference-recovery-root-final.json`, after the retained actual RED
(one failed and116 pending, not117 failures). It
reuses the same reference owner only for the current-view, original-sender
recovery read, without handoff or writer permission. Existing exceptional
listRecovery clock/poison-fence behavior is not changed or called purely
read-only in every failure branch. A real registered whole-driver regression
starts the actual five-stage run, reaches its committed knowledge projection
gap, reads recovery without handoff and confirms unchanged claims, effects,
receipts and fetches before normal completion. Its final whole file report
`stage101-reference-recovery-whole-final.json` passes28/28. Sol independently
reviews the final source and raw reports. The first typecheck reports TS2352
in two test-only fixture casts; the explicit `as unknown as` correction passes
the fresh typecheck/lint/i18n/source build. Those results precede the fifth-run
physical-drain/B-owner fixes, not final acceptance for the latest source.

The final scene freezes the actual settled ACK prefix before switching, proves
the actual original A global generation dispatch is held, requires no additional
ACK while B is current and requires every remaining ACK to use the actual new A
view after return. Run operation `import-global-facts` and task purpose
`import-inference` are distinct real persisted fields, not interchangeable.
Full five-stage order, one execute, frozen execution/event identity, saved
receipts/outputs and both books' author content checks remain mandatory.
Synthetic prefix RED47 is11passed/36failed (including negative tests masked by
the old first assertion), not36 production defects; final50/50 exits0 and
supersedes the earlier48/48 before operation/purpose correction. Agent4 reviews
the final three frozen hashes and approves the bounded scene code. That50/50
report predates the library navigation repair. The final scene now uses the
actual Back to Library -> target cover visible -> existing palette-open flow
in both directions, and verifies B's library cover during setup before any
model request. Final `stage101-scene-library-final.json` passes53/53. Agent4
independently verifies all three frozen hashes, raw results and preserved
HTTP/prefix/lease/data assertions. The two navigation RED reports remain.
The current-book setup correction then passes53/53. Sol's subsequent passthrough
IPC observer passes56/56, with its real53/55 RED retained. It records actual
registered DB/FS/recovery IPC starts and ends, safe identity fields and separate
pending snapshots at view-open boundaries. Original return/error object,
arguments and call counts are unchanged; arbitrary errors/payloads/secrets are
not logged. A pending IPC is not asserted to own a host claim. Agent4 reviews
the final source/hashes/raw and accepts that bounded diagnostic adapter.
The final diagnostic classification includes the newly adapted recovery list
and the fixed VIEW_DRAIN_TIMEOUT code: its genuine56/57 RED and57/57 GREEN
are retained as `stage101-scene-view-drain-red.json` and
`stage101-scene-view-drain-final.json`, independently reviewed by Agent4.

The actual fifth failure drives the event-based physical-view drain and the
two exact recovery adaptations described above. Initial final runtime/open/
adapter3files pass74/74 in `stage101-view-drain-three-final.json`. The later
real default-one-use grant fixture catches a newly introduced double-consume
regression in the background-dialog path; raw4file RED and explicit async
callback RED are retained. Non-consuming initial root preflight plus a single
final resolver consumption fixes it without changing ordinary/raw open, TTL,
scope or authorization. Final4files pass101/101, exit0, zero pending, in
`stage101-view-drain-grant-four-final.json`. Callback throws do not escape the
physical release. Agent4 then identifies that the background-open wrapper must
check its original preflight callback before invoking an explicit async
function, not just check the outer wrapper. The retained real wrapper RED and
final two-file77/77 verify rejection before its first side effect. A further
real legacy-handoff RED catches non-consuming preflight bypassing the old
one-use grant consumption on that branch; consumption now precedes issuance of
the separate legacy-import grant. Final runtime/open two-file78/78, exit0,
is `stage101-view-wrapper-handoff-final.json`. Agent4 independently checks both
new REDs, the overlapping101/101 and78/78, final source hashes and unchanged
raw/ordinary semantics; no blocker remains for that bounded repair set.
Fresh `stage101-build-view-drain-final.log` and
`stage101-lint-view-drain-final.log` exit0 before the sixth desktop run. The
earlier lint failure (`prefer-const`) remains in
`stage101-lint-grant-final.log`; equivalent const initialization fixes it without
disabling the rule. These results do not cover the later three-reader repair.
At that intermediate version, actual desktop success and final independent
review were still pending and the reader blockers prevented a commit. The
following reader repairs and ninth actual observation close those blockers;
the earlier runs remain failures rather than current pending conditions.

The first three history-reader registered dual-native REDs each reproduce
the actual refusal. The minimal three allowlist entries pass62/62 in
`stage101-view-author-history-final.json` (DB context56 plus adapter6), with
zero pending. Current B and renewed A read only their actual database; old
leases, noncurrent/cross-root/expected-path requests and mutations are refused,
and both databases' total_changes remain unchanged. Agent4 independently
accepts the exact SELECT chain, final hashes and ADR0029/0080. The associated
scene adds the existing open action before its retained waits; its real
source-contract RED57/58 ->58/58 is only static ordering evidence. Mirrored
diagnostic history classification RED57/61 ->61/61 is separately recorded in
`stage101-scene-final-runsheet-history-{red,final}.json`; initial toString
matching experiments remain failed reports, not production REDs. Fresh
typecheck, lint/colors, i18n and build in `stage101-*-history-final.log` exit0.
These versions produce the seventh observation, not normal-exit acceptance.
The actual review-full refusal is now repaired together with its bounded
chapter-facts downstream revision-full/review-cycle read chain. Only
`db:review-get-full`, `db:revision-get-full` and `db:review-cycle-get` join the
captured/current-view readers. Registered dual-native RED is three failed,
three passed and three pending; final two-file GREEN is65/65, exit0, zero
pending, in `stage101-view-author-details-final.json`. Both full readers return
the actual stored body/source. The cycle fixture returns null, proving the
adapter boundary, not nonempty-cycle domain qualification. Old leases,
noncurrent/cross-root/expected-path requests and review/revision writers remain
refused; both databases' total_changes remain unchanged. Agent4 independently
traces the cycle verifier/recheck paths to SELECT, read-only PRAGMA, parsing,
validation and in-memory projection, without materialize/commit/write calls,
and accepts the final DB/test hashes and exact ADR0029/0080 reader changes.
ReviewSheet-only read-latest is not silently admitted.

Sol mirrors those three reader names in the passthrough observer, without
changing actual arguments, return/error identity, invocation counts or author
assertions. The exact three new classification cases produce61passed/3failed
RED, then64/64 GREEN in `stage101-scene-details-{red,final}.json`. These are
pure observer tests, not a replacement for the next actual desktop run.
Fresh source build `stage101-build-details-final.log` exits0. Exact commands:

```powershell
corepack pnpm test electron/controllers/__tests__/retained-view-adapters.test.ts electron/controllers/__tests__/db-controller-project-context.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-view-author-details-final.json
corepack pnpm test scripts/redesign/__tests__/reference-run-background-scenario.test.mjs --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-scene-details-final.json
corepack pnpm run build
```

Exit observation/failure recording is corrected in separately owned worktree
verification tools. The initial73/73 tool report is not final acceptance:
independent Terra review finds unforced rejected/timeout outcomes and warm-up/
restart quit consumers can still be ignored. Luna's minimal follow-up retains
the actual55-case RED with5failures and final55/55 GREEN, zero pending, in
`quit-normal-outcome-{red,green}.json`. Only resolved, unforced, not-needed-kill
outcomes pass normal-close consumers; rejected/timeout outcomes fail closed.
Primary preparation errors remain primary. Terra accepts the final source;
Root reruns the six actual tool files in `drive-tools-current-root-final.json`,
141/141, zero failed/pending, exit0. Its eight suite entries include inner
describe suites, not eight files. Preparation/restart call-site wiring is
statically reviewed; the direct helper tests do not execute those closures.
The console is now retained through actual quit. No timeout or author
confirmation is bypassed.

The eighth actual run, `stage101-desktop-exit`, uses the fresh detail-reader
build and exits1. Product assertions pass: one execute, five ordered ACKs,
10knowledge, four committed stage receipts, 10blueprint effects, four original
draft/finalized rows unchanged, actual held A request while B is current and
remaining ACKs only after return to A's actual new lease. B's saved edit and
buffer remain. Root and Agent4 inspect all three1440x900 light PNGs. There are
12fake requests and no observed external requests/writes/residual processes
within recorded coverage. Legacy/history/detail-reader refusals and renderer
pageerrors are absent; one stale recovery-list request is still refused by
the existing session guard. Quit times out at10134ms, forced=true and
killStatus=completed, with fixed `DRIVE_APP_FORCED_CLOSE`. It is not normal-exit
acceptance. Post-quit console190-206 directly records
`PROJECT_RUNTIME_VIEW_OPERATION_BUSY` on the window close path, followed by
the renderer's failed-close result and later file-tree refresh completion.
This proves view-operation refusal, not which exact operation held a claim or
a deadlock/dirty-buffer cause.

Fresh `stage101-{typecheck,lint,i18n}-current-final.log` and
`stage101-build-details-final.log` exit0 for that eighth-run source. Terra's
first window coordination repair passes17/17 mocked cases, but Root, Sol and
Agent5 identify a real-host incompatibility: unconditional view-drain admission
cannot retry an already sealed close after timeout. That intermediate17/17 is
not final acceptance. Terra's exact-busy-only repair retains a genuine
seal-aware RED17passed/1failed and final18/18, zero pending, in
`stage101-window-close-seal-{red,final}.json`. Original sealed-close retries and
shutdown upgrades call requestCloseAll directly. View/session/request/window
checks repeat synchronously before the existing drain callback starts actual
close-all; no async callback, new approval, timer extension or host guard removal
is introduced. Agent5 adds one real dual-native host regression: the last B
physical release synchronously seals all new work/view/open before returning;
A's already-admitted work retains its database, shutdown upgrades the same
close Promise and finishWindowClose cannot unseal shutdown. Its full existing
runtime file passes51/51, zero pending, in `stage101-close-view-host-final.json`.
The production runtime is unchanged by this close repair. Sol independently
checks all three frozen hashes, real RED/GREEN, actual host case and
ADR0029/0031, and closes the sealed-retry P1 without a remaining bounded blocker.

Fresh typecheck, lint/colors, i18n and source build all exit0 in
`stage101-{typecheck,lint,i18n,build}-close-final.log`, retaining existing build
warnings. The ninth actual scene, `stage101-desktop-close-drain`, exits0:
one whole execute, knowledge/global/style/blueprints/refresh ACKs in order,
10knowledge, four committed stage receipts, 10blueprint effects and four old
draft/finalized rows unchanged. While B is current, actual A HTTP dispatch is
held, global completes but whole execution remains unsettled and the knowledge
ACK prefix does not grow. After actual A return, its new view lease supplies
remaining ACKs without changing execution identity. B's edit is saved and
preserved. Twelve fake requests are recorded; external requests/writes and
residual processes are empty within the recorded observed-before-quit coverage.
Quit is resolved2787ms, forced=false, killStatus=not-needed, with no result error.
Root and Agent4 independently read raw/post-quit console and all three PNGs:
two B scenes show the same saved text and one A background task at1/5, and
final A shows Run Done plus five green steps and matching chapter4. Sidebar12
is the original fixture total, not outputs. One switched-view stale recovery
request remains correctly refused. No legacy/detail-reader, close-guard or
renderer pageerror remains; development CSP warning is not hidden. This is
normal-exit acceptance for this bounded light1440x900 author scene, not full
feature, complete network, visual-equality or target-platform qualification.

Final close commands:

```powershell
corepack pnpm test electron/controllers/__tests__/window-controller.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-window-close-seal-final.json
corepack pnpm test electron/services/__tests__/project-runtime.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage101-close-view-host-final.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
corepack pnpm run verify:drive -- --scenario f537-reference-background-10 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage101-desktop-close-drain --theme light --dump-dom --console
```

The manifest distinguishes56 source/ADR/test paths from eight separately owned
verification-tool paths. Actual desktop evidence consumes both exact byte sets;
the Stage101 product commit alone does not reconstruct uncommitted tooling.
No tool path is silently included in the product commit. Final record consistency
and index/path checks precede the scoped local commit; no feature is promoted.
The actual final record check is36/36, zero failed/pending, exit0, in
`checklist-stage101-final.json`, using:

```powershell
corepack pnpm test scripts/__tests__/creation-runtime-feature-evidence.test.ts --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/checklist-stage101-final.json
```

That checks only the frozen plan identity, declared completion evidence and
dependencies; it is not a new functional, quality or platform acceptance.

## Baseline, Review And Feature Self-Check

This run rehashes all three historical Stage53 1000-chapter baseline reports
against their original manifest and confirms matching bytes. They remain old
baseline observations, including the original timeout/forced quit and missing
2/4-book pressure cases, not current performance or a statistical speedup.

Agent4's fast-path completion-session finding is fixed, retested and independently
re-reviewed. Sol accepts the final main/retirement changes and actual103 report;
Agent4 confirms the original production guard was not weakened. Prefix-aware
scene code is approved; Agent4 independently accepts the ninth actual raw/visual
evidence above after rejecting the earlier forced-close observations.

Root self-check for IMPORT-001 and UI-001: original requirements/AC/DAG remain;
actual increment is the admitted author reference/view chain, not a helper-only
or multi-task claim; original isolation, execution, unknown/no-resend, receipts,
physical drain, dirty buffers and writer boundaries remain. Final applicable
tests/review cover their stated source versions, not every historical PASS.
Remaining idle TTL cleanup, explicit stage durable-reopen evidence and complete
UI close/recovery states prevent feature completion. Features stay
`in_progress/false`; all35 states remain14historical completed/21in_progress,
without recertifying the14. No full imitation, unattended offscreen completion,
multi-book generation, real-model quality, visual equality or platform claim.

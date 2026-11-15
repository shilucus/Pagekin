# Stage100: Repair Existing Author and Client Boundaries

Date: 2026-11-15. Parent: `729b8f0b1515269c0634b1308fa1cf1b6c82796d`.
Stage99's correction is committed at that parent. This stage does not complete
any feature or alter its AC, DAG, gates or required evidence.

## Scope And Actual Increment

| Requirement / feature | Actual production increment | Remaining feature gap / decision |
| --- | --- | --- |
| R1/R2, IMPORT-001 AC1/3 | Author reference execute checks the original sender/grant/revision/execution before lazy generation-owner preparation, then retains original beginRun/parent checks. Failed cancellation persistence retains the parent/writer; same-parent, no-child, same-execution cleanup can cancel after TTL without renewing execution. | Foreground only. Background switching, complete stage recovery and separate imitation remain open; not completed. |
| R3, UI-002 AC2 | Existing feedback generation ignores late success/error/finally after dialog closure, project change or lease replacement. No new layout, text, controls or author decision. | Dirty-buffer initiation, history discovery/error states and full design/Electron coverage remain open; not completed. |
| R5, API-001 AC2/3 | Uncomposed human approval now rejects423 without review/event/success effects; existing auth, ownership, mismatch, historical receipt and unknown decisions retain priority. | Production start/resume, persistent API receipts and trusted single-use approval composition remain open; not completed. |
| R5, CLI-001 AC1/2 | Live reads use fresh query keys while the original start key remains the lookup target; only classified socket read failures retry. Receipts bind all expected identity fields and normalized payload hashes, including nested start receipts. | Real desktop run/wait/recovery and trusted approval are not delivered by fictional history; not completed. |

Existing ADR-0041 instance/session protection is the evidence for the feedback
lifecycle repair; there is no new visible design. Updated
[ADR-0050](../../adr/0050-inbound-domain-api-security-and-idempotency-contract.md),
[ADR-0051](../../adr/0051-creation-cli-driver-receipts-and-human-review-consumption.md)
and [ADR-0080](../../adr/0080-main-owned-foreground-reference-whole-run.md) describe
only these bounded decisions. No schema, dependency, generic background grant,
automatic approval or real-model permission is added.

## Actual Execution

All commands run at the repository root using Node24.13.0, Corepack pnpm11.11.0,
Vitest4.1.12, Windows x64. Native tests are serial, fictional and isolated; no
dependency install/rebuild, real manuscript/configuration/model or external
publication is performed. Raw reports are under
`.runtime/creation-runtime-modernization/resume-2026-11-15/`.

- `corepack pnpm test electron/controllers/__tests__/reference-run-foreground.test.ts electron/controllers/__tests__/reference-run-driver.integration.test.ts electron/services/__tests__/reference-knowledge-driver.test.ts electron/services/__tests__/import-stage-flight.test.ts electron/repositories/__tests__/import-run-repository.test.ts electron/repositories/__tests__/import-run-execution-lease.test.ts electron/repositories/__tests__/import-run-captured-reference.test.ts electron/services/__tests__/reference-import-grant-portable.test.ts electron/services/__tests__/portable-runtime-freeze.test.ts electron/controllers/__tests__/generation-controller.test.ts electron/controllers/__tests__/generation-scheduling-controller.test.ts electron/controllers/__tests__/reference-knowledge-controller.integration.test.ts electron/controllers/__tests__/reference-knowledge-driver.integration.test.ts electron/controllers/__tests__/reference-global-driver.integration.test.ts electron/controllers/__tests__/reference-style-driver.integration.test.ts electron/controllers/__tests__/reference-blueprint-driver.integration.test.ts electron/controllers/__tests__/reference-refresh-driver.integration.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/import-generation-final.json`
  exits0,17files416/416. This precedes the final admission preflight correction;
  unchanged repository/generation/stage behavior has this broader regression,
  not a claim that all416 ran after every subsequent edit.
- `corepack pnpm test electron/controllers/__tests__/reference-run-driver.integration.test.ts electron/controllers/__tests__/reference-run-foreground.test.ts electron/services/__tests__/reference-knowledge-driver.test.ts electron/services/__tests__/reference-import-admission.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/reference-admission-retest.json`
  exits0,4files76/76 on final source. Includes six invalid admissions with zero
  owner preparation, original joins/history and cancellation-write retry/TTL.
- `corepack pnpm test scripts/cli/__tests__/creation-cli.test.ts electron/controllers/__tests__/inbound-api-controller.approval.test.ts electron/controllers/__tests__/inbound-api-controller.test.ts electron/controllers/__tests__/inbound-api-controller.idempotency.test.ts electron/controllers/__tests__/inbound-api-controller.ownership.test.ts electron/controllers/__tests__/inbound-api-controller.headers.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/api-cli-hash-final.json`
  exits0,6files71/71 on final source; CLI25 includes five wrong-hash cases.
- With `AI_NOVEL_VITEST_CHROMIUM` pointing at the installed Edge157.0.4341.60,
  `corepack pnpm run test:browser src/components/stage/feedback/__tests__/planning-feedback-adoption-session.browser.tsx src/components/stage/setup/__tests__/setup-feedback-adoption.browser.tsx src/components/stage/architecture/__tests__/architecture-feedback-editor-baseline.browser.tsx --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/feedback-browser-retest.json`
  exits0,3files54/54, temporary browser profile and fictional IPC. Planning17,
  setup36 and architecture1 exercise real React/store behavior. Final log has
  no earlier act warnings; this is not Electron or full UI design acceptance.
- `corepack pnpm run typecheck`, `corepack pnpm run lint` and
  `corepack pnpm run check:i18n` exit0 (`*-final.log`). The later test-only TTL
  fixture-finally restoration is covered by final native tests and the fresh
  build's TypeScript pass. Final `corepack pnpm run lint` exits0 again
  (`lint-stage100-final.log`); final checklist36/36
  (`checklist-stage100.json`) checks records/hash/DAG only.
- `corepack pnpm run build` exits0 on final source (`build-final.log`), writing
  `dist/` and `dist-electron/`. Existing resolver/output-option, chunk-size,
  mixed static/dynamic import and plugin timing warnings remain recorded; no
  unrelated build configuration change is made. This is not package acceptance.
- After review of the driver and fictional scenario,
  `corepack pnpm run verify:drive -- --scenario f537-reference-whole-10 --out .runtime/creation-runtime-modernization/resume-2026-11-15/desktop --theme light --dump-dom --console`
  exits0 against fresh Electron44.9.3 build. It uses a new isolated scratch
  project/profile and loopback fake provider, then normal cleanup. Raw JSON/PNG:
  `desktop/f537-reference-whole-10-light.{json,png}`.

### Retained Failures And Superseded Results

The first import run exposed first-owner self-busy; the owner preparation repair
was then reviewed and corrected to authorize before initialization. Six initial
admission tests failed on a test SQL column typo (`id` versus `run_id`), not a
behavioral RED. Corrected `reference-owner-admission-red-2.json` reproduces all
six unauthorized owner-preparation calls. The first wider final report,
`reference-admission-final.json`, is63passed/13failed: the artificially expired
fixture could not close and polluted later cases. Restoring only that fixture's
original issued TTL in finally yields final76/76; production TTL is not relaxed.
Expired idle/unstarted issuance cleanup is not proved or fixed by this parent
cancellation path and remains a separate recovery gap.

CLI hash RED (`.runtime/agent3-cli-payload-hash-red.log`) is20passed/5failed;
GREEN is25/25, followed by final integrated71/71. Earlier API/CLI66/66 and
feedback54/54 with act warnings are superseded, not erased. Reports overlap;
their counts are not summed. All failed and filtered raw reports remain local.

## Actual Desktop Observation

The real registered author reference chain makes one whole execute, receives
five ordered knowledge/global/style/blueprints/refresh ACKs, and completes the
run/grant. SQLite contains10 committed knowledge receipts,4 committed stage
receipts and10 blueprint effects;4 existing draft/finalized rows are unchanged.
There are12 fictional provider requests. Normal quit is not forced; raw report
lists no external requests, recorded external writes or residual processes
within its `observed_before_quit` coverage. Scratch cleanup checks its direct
isolated root. No real profile contents or credentials are used as fixtures.

Root and Agent4 independently inspect the1440x900 light PNG: the task says10
chapters and all five steps complete, while breadcrumb/header/selection agree
on chapter3. Sidebar12 is the fixture's total blueprint count, not12 task outputs.
Unchanged visible draft is not newly generated prose. A single1334ms launch and
displayed stage durations are observations, not performance qualification.
This is one foreground reference scene, not background/A-to-B, full imitation,
real-model quality, visual comparison, installation or target-platform approval.

## Independent Review And Self-Check

Luna implements feedback and independently reviews API/CLI; Terra implements
reference authority/cleanup; Sol implements API/CLI. Root integrates owner
preparation and regression tests. Agent4 independently reviews integrated raw
source, all three ADR updates, failure lineage, final76/71/54 reports, quality
logs, build and desktop JSON/PNG. Its owner-before-auth and CLI hash findings
are fixed and re-reviewed; no unresolved in-scope correctness blocker remains
for this limited commit. Implementers do not grant themselves feature acceptance.

For each row above Root checks: original requirement/AC is unchanged; actual
increment is bounded production behavior rather than feature completion;
sender/session/source, writer, epoch, cancellation, unknown/no-resend, receipt
and author-buffer guards remain; final tests and independent review cover the
edited paths; records and frozen source identities agree. Remaining gaps in the
table prevent every completion promotion. All35 statuses remain14completed /
21in_progress, with historical14 not recertified. Next is actual single-reference
background/view integration, independent of SCHED-002, while feedback design
and API production composition gaps stay separately recorded.

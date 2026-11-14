# Stage 89: Preserve Unmigrated Batch Switch Protection

## Frozen Scope

Entry `31f3a34dd5a7a58280749a1da012ecef461cdcc2`, master,2026-11-14.
Stage88's42 committed paths match its independently reviewed version;131 listed
identities and three protected files are unchanged, with an empty index.

F2 section4.4, ADR0029 and ADR0049 require unmigrated renderer workflows to retain
the existing switch confirmation, cancellation and wait. The author batch factory
still executes renderer steps whose current-session checks fail after switching
away; its type name must not qualify it for background execution. Both default
and explicitly true flags are denied before the generic flag branch, as for the
existing reference-import guard. No new workflow, grant, writer or persistence.

Visible-output mapping: the existing confirmation, rejection, cancellation/wait
and failure outputs are reused unchanged. F2's unmigrated-workflow requirement
and ADR0029's retained switch guard are the evidence for restoring those existing
branches. No new copy, layout, control or state is invented. A synthetic explicit
qualification unit fixture is not evidence of a production background task.

## Team And Verification Mapping

- Agent4 Terra owns the qualification helper/unit test, existing project-switch
  tests and actual batch-factory/store executor regressions. It runs no commands
  or Git and does not change UI copy or shared workflow implementation.
- Root owns ADR0049, records, integration, serial validation and scoped Git.
- Luna independently traces the real batch/store/open call chain and maps the
  deferred physical-step test; Sol independently reviews the integrated fix.
- Required cases: default/explicit batch qualification, author refusal with no
  openB, approved cancellation blocking openB until the real batch step settles,
  failure/timeout keeping A, mixed tasks and retained qualified-contract routing.
  Existing close, session and workflow-cancellation regressions are included.
- Root will run filtered `corepack pnpm test`, typecheck, lint/colors and i18n
  from this root. Tests/cache/reports stay local or isolated fictional fixtures;
  no true project/config, network provider, package or dependency changes.

At scope freeze no Stage89 execution or independent acceptance was claimed.
The internal registered durable batch driver and the legacy author factory are
reviewed separately against their own AC; absent visible wiring alone does not
invalidate an accepted kernel. Exact final evidence follows actual execution.

## Actual Execution

All commands ran from the project root with Node24.13.0, Corepack pnpm11.11.0
and Vitest4.1.12. Package/Vite scripts and target mocks were inspected first.
Outputs live in `.runtime/creation-runtime-modernization/stage-89/`; no install,
real project/configuration, real provider, package/platform or remote action.
The helper was edited before the new tests; no RED run was performed or claimed.

| Command/report | Actual result |
| --- | --- |
| `corepack pnpm test` with four focused files, `focused-first.json/log` |4files97/97,exit0|
| Same command with the seven-file impact union, `impact-final.json/log` |7files156/156,0failed/pending/todo,14.17s,exit0|
| `corepack pnpm test scripts/__tests__/creation-runtime-feature-evidence.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-89/checklist-final.json` |36/36,exit0 after two partial appends|
| `corepack pnpm run typecheck`, `typecheck.log` and `typecheck-final.log` |both exit0|
| `corepack pnpm run lint`, `lint.log` and `lint-final.log` |both exit0,colors passed|
| `corepack pnpm run check:i18n`, `i18n.log` |exit0|
| `corepack pnpm run build`, `build.log` |exit0; dist/dist-electron only|

The test commands retain all exact filters in their log headers and use
`--maxWorkers=1 --reporter=default --reporter=json --outputFile=<report>`.
The seven files are qualification6, project-transition12, batch-workflow32,
workflow-pause47, project-close52, resource-conflict4 and the old aggregate3.
The first four-file97 result overlaps156; the metadata36 is separate, never
added to a qualification denominator. Expected fictional timeout/failure stderr
is exercised by passing tests, not suppressed or hidden failed commands.

The actual batch factory and workflow-store executor wait on a controlled
`generation:begin-batch` response. They prove cancel/wait and timeout prevent
`project:open` until that executor exits, not real provider physical drain.
Synthetic explicit-qualified tasks test dispatch of the switch guard only.
The fifth helper consumer's old batch-true assertion is corrected, not removed.

The complete344-file ordinal build tree is
`65bd0a7a0cfa3f7bb3acc5485a6dad92669e1bf0ef2703018d227d3b860082b8`.
Its UTF8 `path:lowercase-sha256` lines use ordinal sorting and final LF.
Existing Vite resolver/freeze/chunk-size/static-dynamic-import/
inlineDynamicImports warnings remain. No new Electron/browser run is claimed.

## Review And State

Luna independently traces the actual author batch/store/switch path and confirms
the wrong eligibility. It separately verifies ADR0033 and the existing registered
main-driver/normal/unknown/restart evidence: missing author UI wiring does not
violate DRIVER002's internal kernel AC. That completed state is preserved.
Sol independently reads the final diff and raw156 report, then accepts bounded
source/runtime after root confirms every quality command exit0. Its ADR message/
count wording finding is corrected to the actual original output, without UI
changes. It explicitly does not infer provider drain, background capability or
full UI acceptance from the synthetic fixtures.

Exactly two partial UI001 evidence records are appended. Removing them reproduces
the entire entryHEAD JSON, including all35 statuses/passes/AC/dependencies/gates
and old evidence. Counts remain14completed/21in_progress; no full feature is
promoted. Sol's final independent artifact audit accepts40/40identities, all
three reports,344built files, exact11owned paths and the complete entry JSON
comparison. Root scoped Git/postcommit preservation checks follow.

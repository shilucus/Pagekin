# Stage 88: Main-Owned Foreground Reference Whole Run

## Frozen Scope

Entry `4b7ba33a1e3f16bd3b9808fb1ecf053220b01afa`, master, 2026-11-14.
F2 sections4.4-4.5 and ADR0074-78 supply the existing reference-stage contracts;
[ADR0080](../../adr/0080-main-owned-foreground-reference-whole-run.md) bounds
their whole-run composition. Main, rather than renderer, serially owns knowledge,
global, style, blueprints and refresh. Existing writers, original private grant,
root/model/budget, execution owner/epoch, receipt recovery and physical drain
remain authoritative. No new durable schema, dependency or background grant.

Visible-output evidence is the existing five-step reference workflow and its
accepted localized copy/projections in ADR0074-78. No step, text, layout, control,
author-buffer policy or author-manuscript path is added or removed. Mechanical
whole-run ACKs supplement, not replace, the existing child author-buffer ACKs.
Same-run claims do not establish an all-database lock or universal core-field CAS.

## Team And Coverage

| Owner | Scope | Evidence required |
| --- | --- | --- |
| Agent1 gpt-6-luna | Main coordinator, unit and registered native composition | Stage transitions, historical model recovery, unknown/history, join/cancel/grant retry |
| Agent2 gpt-6.1-terra | Renderer projection/workflow and small desktop scenario | Single execute, buffered event identity, original dirty-buffer rules, skip-before-next-stage ACK |
| Agent4 gpt-6.1-terra | Private parent flight, issuance lifecycle and read-only history helpers | Same-run writer fence, retryable cleanup, canonical ledger/receipt validation |
| Root | Closed IPC, foreground owner, trusted generation facades, records/Git | Full sender/session/runtime binding, physical drain, integration and preservation |
| Agent3 gpt-6.1-sol | Independent integrated review | Requirements, calls, concurrent/cancel/recovery, persistence, authority and test gaps |

Agent4 independently audits nonowned source/raw/build/record identities after
final results. Its own parent/history implementation is independently reviewed
by Sol, not accepted solely by that artifact audit. Graph/AST/LSP retrieval is
unavailable; bounded import/definition/caller searches provide static evidence,
not a dynamic whole-program call graph.

## Repair History

- A broad test attempt accidentally passes a literal `--` through pnpm11 and is
  interrupted. It is not a full-suite result. An observed unrelated old
  novel-contracts migration-list failure remains recorded; it is not silently
  fixed or turned into a Stage88 pass.
- Closed progress unions, a missing fictional snapshot field and later unused
  test parameters cause actual type/lint/build failures. Owners repair only
  their relevant fixtures/types; no check is disabled.
- Renderer failures cover the new whole-run mock/ACK contract and malformed
  envelope versus child-style validation. The final renderer-only report is
  2files115/115. The earlier113/114 report is retained, not overwritten.
- Native harness initially passes sender in the session position; a subsequent
  wait predicate returns a string rather than a boolean. These attempts and the
  9-test3pass/6fail report remain. The smoke report1pass/8skipped is not a full
  native pass.
- Independent review finds that a main stage skip must validate persisted
  history before emitting its projection. Extracted read-only helpers reuse
  original global/style/blueprint ledger and canonical receipt checks. Unknown,
  corrupt or inconsistent history rejects before refresh or new work. Actual
  native counterexamples cover legacy unknown global and completed bad style /
  unknown blueprint history.
- First complete native report is11tests9pass/2fail. Independent review confirms
  old prepare/resume rejects rather than returning a failure envelope, and
  completed refresh history emits no child refresh projection. Tests preserve
  the real contracts, compare run/grant/effect history and retain no-new-request
  assertions. Subsequent integrated validation is recorded below when complete.
- First integrated run actually ends41files1021/1022,1failed/0pending. The
  remaining same-run test expects DB advance to reject; its original mutating
  IPC wrapper instead resolves a localized failure envelope. The exact busy
  errorCode is now asserted, independently checked against that wrapper. The
  same41files are rerun; no production guard or old failure result is changed.

## Actual Commands And Local Evidence

All commands run from the project root with Corepack pnpm11.11.0, Node24.13.0,
Vitest4.1.12 and existing native dependencies. Tests use fictional mocks or
isolated recoverable SQLite/Lance; reports/cache go to ignored local output.
No installation, real model/configuration/work, packaging or remote action.

Raw reports/logs live in `.runtime/creation-runtime-modernization/stage-88/`.
Test command headers in the matching logs retain exact file/name filters;
`--maxWorkers=1` serializes native use. File count means `testResults.length`,
not Vitest's nested suite count. Reports overlap and are never added together.

| Report | Actual result |
| --- | --- |
| focused-first-filtered.json | 9files101/101 |
| focused-second.json | 8files201/207,6failed |
| focused-third.json | 11files127/127 |
| renderer-first.json | 2files113/114,1failed |
| renderer-second.json | 2files115/115 |
| history-first.json | 2files15/15 |
| native-second.json | 1file3/9,6failed |
| native-smoke.json | 1file1passed,8skipped; not full qualification |
| native-full-first.json | 1file9/11,2failed |
| impact-final.json | 41files1021/1022,1failed |
| impact-retest.json | 41files1022/1022,0failed/pending/todo;544.83s |
| checklist-final.json | 1file36/36 after exactly3partial evidence appends |

Actual quality commands are `corepack pnpm run typecheck`, `corepack pnpm run
lint`, `corepack pnpm run check:i18n` and `corepack pnpm run build`. Initial
failures remain as typecheck-first/second/third, lint-first and build-first logs.
Fresh typecheck-final, lint-final, i18n-first and build-final each actually exit0.
After the final native assertion repair, typecheck-retest, lint-retest and
build-retest also actually exit0. No UI copy changes require another translation
edit. Both complete344-file builds have ordinal tree digest
`413f266da2c6c3c73bf678aaa3c35a587b2db87413802f72138b5f79e32b185f`,
equal to the actual desktop run's inspected build.
Build writes only dist/dist-electron; existing Vite resolver/freeze/chunk-size/
static-dynamic-import/inlineDynamicImports warnings remain.

```text
corepack pnpm run verify:drive -- --scenario f537-reference-whole-10 --out .runtime/creation-runtime-modernization/stage-88/desktop --theme light --dump-dom --console
```

This reviewed scenario transparently observes the actual registered handlers;
it does not replace their responses. It starts offscreen Electron using fresh
isolated roots and a loopback fake provider, not `--real-model`. Real-profile
observation reads file metadata only. The actual command exits0 and records:
1whole execute,5ordered settled ACKs,1original completed grant,10committed
knowledge receipts,4committed stage receipts,10chapter blueprints and4existing
draft/finalized rows unchanged. There are12fake requests, normal unforced quit,
zero observed external requests/writes and no residual processes. The external
request log is observed before quit, not claimed as universal network coverage.

Root opens the actual1440x900light PNG. The run sheet shows the original five
green steps and reference10chapter title, consistent with measured10receipts and
blueprints. The top completion status agrees. The seeded project's12blueprints,
2/10finalized indicator, selected/edited chapter3 and298-character draft remain
existing fixture values, not a claim that12reference chapters or new author
drafts were imported. Step elapsed values4/7/1/3/4seconds are observations only,
not a performance comparison. No visual-equality or dark/mobile acceptance is
claimed for this internal ownership change.

## Acceptance And Limits

Sol independently accepts the integrated current source, complete raw results,
quality logs, actual desktop evidence and344-file build identity, with no
remaining identified bounded blocker. Initial history/lifecycle findings and
three native fixture-contract mistakes are fixed and re-reviewed. The failed
reports remain failures;1022 and36 are overlapping, not additive.

Exactly3partial contract_review/deterministic/electron records are appended to
IMPORT001. Removing those records reproduces the entire entryHEAD feature JSON,
including all35 statuses, passes, dependencies, gates, AC and prior evidence.
The count remains14completed/21in_progress; this stage does not recertify all14.
The manifest binds selected current sources, all local raw reports/logs/desktop
artifacts, protected files and the complete ordinal build-tree identity.
Agent4's final nonowner artifact audit accepts131/131 source/raw/selected-build/
protected identities, exact42owned paths, all12report statistics and the complete
344-file build tree. Its own source is separately accepted by Sol. Root confirms
an empty index, unchanged protected files, sample-only hooks and no owned-path
Git filters; scoped local commit and postcommit preservation checks follow.

No complete feature is promoted. IMPORT001 receives only bounded foreground
composition evidence; IMPORT002
shares preparation, not independently accepted full imitation/author writing.
Background view switching, multiple-book execution, real-model literary quality,
performance improvement, target-platform packaging and full35 acceptance remain
outside these results. Required evidence labels alone do not satisfy their AC.

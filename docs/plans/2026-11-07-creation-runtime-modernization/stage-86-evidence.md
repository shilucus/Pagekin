# Stage 86: Current Baseline And Completion Evidence Integrity

Date: 2026-11-14, Asia/Shanghai. Entry: `master@f46144fc3a22743db1cadcd8128481fecdb01dac`.
This is a bounded baseline refresh and checklist repair, not final acceptance of
the 35-feature program. The prior Stage 85 full-completion claim is superseded
by this record wherever required evidence is absent.

## Frozen Scope

- Root owns the checklist, regression test, records, serial runtime commands and
  Git. Agent 1 (`gpt-6-luna`) independently checks performance/import sources;
  Agent 2 (`gpt-6.1-terra`) checks runtime/API/headless; Agent 3 (`gpt-6.1-sol`)
  checks feedback/acceptance/automation. Agent 4 (`gpt-6.1-terra`) is the separate
  integrated Stage 86 evidence reviewer. No model substitution was needed.
- Preserve all acceptance criteria, dependencies, gates, schema and historical
  evidence. Only the 21 completed entries lacking declared evidence types return
  to `in_progress/false`. Fourteen prior completion flags are preserved, not
  newly certified by the metadata test. No production code, UI, persistence,
  dependency, real model, user project or configuration is changed.
- Preserve the two existing untracked Stage 1B3 documents. The initial index was
  empty; the repository-analysis document is tracked and unchanged, not staged.
- Source retrieval is bounded `rg` plus definitions, imports, registration and
  caller checks. Graph, AST and LSP services are unavailable; no dynamic call
  coverage is inferred from the static fallback.

## Checklist Correction

The new regression checks the frozen F2 source digest, all 35 unique entries,
status/pass agreement, evidence-type presence and completed dependencies.
Evidence labels are necessary metadata, not proof of the referenced results.
It does not certify model behavior, design, runtime reachability or platform
qualification, and does not change a pending gate into an accepted one.

| Entries returned to in progress | Missing declared evidence types |
| --- | --- |
| SCHED-002 | performance |
| IMPORT-001/002 | electron |
| IMPORT-003/004 | performance, electron |
| UI-001/002 | design_review, electron |
| UI-003 | deterministic, electron |
| API-001, CLI-001, AUTO-001/002, ACCEPT-003, MCP-001 | contract_review, electron |
| AUTO-003, ACCEPT-001 | contract_review, electron, model_quality |
| ACCEPT-002 | contract_review, design_review, browser, electron |
| SKILL-001 | contract_review, agent_workflow |
| QUAL-001 | electron, model_quality |
| QUAL-002 | design_review, browser, electron |
| HEADLESS-001 | contract_review, electron, platform |

No synthetic evidence labels were added to repair these gaps. FEEDBACK-002/003/004
have the evidence types their own contracts declare and remain unchanged pending
further current-source checks; UI-002/003 are separate incomplete features.
PERF-001 remains accepted on the actual Stage 47 AC adjudication: a trustworthy
failed workflow is a valid failed baseline sample, not a successful import.
Its preserved thousand-chapter timeout and unsupported two/four-book rows are
not relabeled or erased.

## Actual Commands

All commands ran in the repository root with Node 24.13.0 and the pinned pnpm
11.11.0 via Corepack. Reviewed `package.json`, `vite.config.ts`, driver/scenario
and cleanup sources before execution. Tests use fictional fixtures and caches;
build writes `dist/` and `dist-electron/`; the drive writes a fresh contained
scratch profile/project and ignored local reports. No dependency change, real
provider, installation, release or remote Git action was performed.

- RED: `corepack pnpm test scripts/__tests__/creation-runtime-feature-evidence.test.ts --reporter=default --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-86/checklist-red.json`.
  Actual exit 1: 36 tests, 15 passed, 21 failed, no pending tests. Missing
  evidence-type assertions are retained as the original failure report.
- GREEN: `corepack pnpm test scripts/__tests__/creation-runtime-feature-evidence.test.ts scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs scripts/redesign/__tests__/performance-parse-scenarios.test.mjs scripts/redesign/__tests__/performance-inspection-lifecycle-scenarios.test.mjs scripts/redesign/__tests__/drive-performance-output.test.mjs src/shared/__tests__/performance-baseline.test.ts electron/services/__tests__/performance-diagnostics.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-86/focused-green.json`.
  Actual exit 0: 8 files, 218/218 tests, no failed/pending/todo. Microbenchmarks
  explicitly remain in-memory source tests, not desktop or literary evidence.
- `corepack pnpm run build`: exit 0, renderer/main/preload outputs produced.
- `corepack pnpm run verify:drive -- --scenario perf-import-10 --out .runtime/creation-runtime-modernization/stage-86/desktop --theme light --console`:
  exit 0. `PAGEKIN_PERFORMANCE_SOURCE_SHA` was set only for the child execution
  to the entry SHA and restored afterwards. Production sources are unchanged;
  the manifest additionally binds the dirty checklist/test and actual outputs.
- `corepack pnpm run typecheck`, `corepack pnpm run lint`, and
  `corepack pnpm run check:i18n`: exit 0. Lint includes the color-literal check.
  Build/type/lint finish outside the measured drive interval.

The ignored artifact root is `.runtime/creation-runtime-modernization/stage-86/`.
It contains RED/GREEN JSON, GREEN console log, build/type/lint/i18n logs,
driver output and the desktop JSON, screenshot and redacted console log.
The failed initial Windows batch `apply_patch` invocation changed no file; the
same apply-patch backend was then invoked directly and succeeded.

## Fresh Desktop Sample

One actual isolated Electron run, 1440x900 light, uncontrolled disk cache:

| Observation | Actual result |
| --- | --- |
| Corpus SHA256 | `56e4df63d2aa0012c312a4ef6898b3caebb81fe5a7147766095b2b20c69e663d` |
| Runtime | Electron 44.9.3, embedded Node 24.22.0, Chrome 152.0.7977.167 |
| Attempted / failed | 1 / 0 |
| Finalized imported chapters / blueprints | 10 / 10 |
| Wall time | 20620.3816 ms |
| Fixture requests / post-cutoff requests | 32 / 0 |
| Main event-loop histogram p95 / maximum | 66.093055 / 106.233855 ms |
| Import inspection / renderer snapshot coverage | observed / observed |
| Cleanup failures / stop failures | 0 / 0 |
| Forced quit / residual processes | false / none |
| Observed external requests / writes | none / none |
| Two/four-book execution | unsupported_not_executed |

Root personally inspected `desktop/perf-import-10-light.png`: run title is
10 chapters; blueprint and manuscript navigation both show 10/100 against the
unchanged target of 100. The proposed 860 words/chapter is still unadopted;
the formal setting and proposal baseline both remain 3000. The run is completed.
These are screenshot state checks, not design-fidelity acceptance.

The event-loop statistic is a within-sample histogram, not workflow p95. The
32 fixture requests are not remote billing or proof of model quality. Fetch
observation covers the driver-guarded main-process fetch boundary, not every
possible network transport. This sample is not a performance comparison.

## Remaining Implementation And Gates

Current static audits confirm genuine main-process import stage drivers, but
the overall import workflow is still renderer-driven. Extended feedback UI,
inbound API/CLI/MCP, acceptance/automation and headless helpers do not yet form
their claimed complete production paths. Inbound task ownership and autonomous
predecessor identity/save races are scoped for subsequent internal fixes.

New visible states require their actual design evidence. Trusted author
approval and task-grant policy cannot be invented by the team. Real-model
quality needs separate credentials/budget/authorization, and native target
qualification needs the actual platform environments and commands. Headless
remains last. None of these gaps is cleared by this stage's passing checks.

Independent Agent4 reviewed the integrated seven-path change and actual raw
reports/image, matched 45/45 source/artifact/build/protected identities, and
recomputed the complete 344-file build-tree digest. Its initial finding about
locale-dependent sorting was fixed by explicit ordinal sorting; the final
digest is `bcf2388445e3d49b4a4457a669d6668779c5215e95b27bb6f49d63119fd0d10f`.
The oversized initial manifest patch never started or wrote a file. The compact
manifest now records selected built identities plus the full reproducible tree
digest. Reviewer reread the repair and accepted this bounded stage with no
unresolved blocker. No source/test/report/build bytes changed after execution;
only record corrections followed, so no runtime rerun is represented.

Root also reran the final checklist after the evidence append: 36/36, a subset
of the earlier 218 tests, not an additive denominator. Root checked complete
feature JSON semantics, the empty initial index, hooks, attributes, protected
identities and whitespace. Exact-path local commit/post-commit checks follow.
This record is not a claim of full-program review.

# Stage 43: Dedicated Desktop Blueprint Feedback v3

Date: 2026-11-10. Entry: `c591a255ecd76a6606e13d45f1c158ae4cffe425`, master, Windows x64. Internal FEEDBACK-003 desktop vertical; no UI or whole-feature promotion. Authority: current F2 section 6.2, ADR-0028, ADR-0066 and explicit implementation/isolated verification authorization.

## Scope And Acceptance Freeze

| Surface | Required behavior and evidence | Ownership |
| --- | --- | --- |
| Shared wire/client | Dedicated v3 eleven verbs, shared-only schema3 types, closed blueprint capture/list and four-field adopt; all v1/v2 signatures and behavior retained; frozen inputs/session with await identity checks and no automatic retry/adoption | shared/client implementer |
| Actual owner | Schema3/blueprint-only base/candidate/run facades with exact stored input/context/scope/task and source/model/Skill authority; reject both other versions and foreign operations before effects | owner implementer |
| Controller | All eleven handlers registered through existing closed-payload, project-session/canonical-root/database and safe-error machinery; real client-to-IPC-to-owner-to-SQLite F0-C1-C2, partial/edited adoption, empty author fields, replay/CAS/ABA and outside facts unchanged | root |
| Recovery/bridges | Explicit preload and project-session forwarding, original-project reopen, complete-stop accounting-unknown versus delivery-unknown, queued/physical-tail cancellation; portable old history read-only and explicit new F0/relineage only | bridge/portable implementer; root actual controller integration |
| Acceptance | Frozen source, focused actual regression, type/lint/i18n/build, two independent integrated reviews, fixes and fresh reruns when substantive | root; independent reviewers |

The namespace is a desktop project-session command surface, not a public API or human-approval capability. Eight fields and actual selected JSON keys follow ADR-0066. No adoptedFields/adoptedRange or caller-supplied output/proof/task/decisionSource. The main owner keeps physical execution and durable receipts; no second execution loop, Map-only shadow persistence or fabricated success.

## Validation Mapping

Root inspects actual scripts and fixtures before authorized execution at the project root. Focused coverage includes shared feedback/wire/client, generic project-session/preload, actual controller, feedback owner/repository/service/portable, main source/model/plan/scheduling and prior v1/v2 regressions. Only isolated fictional databases, archives and deterministic providers are used; report output is under `.runtime/creation-runtime-modernization/recheck-2026-11-10/stage43/`. Native/build commands remain serial. No network model, real configuration or manuscript, browser/Electron scene, package install/release or DSH change is implied. Actual commands, failures, final identities and review results follow execution, without replacing old evidence.

## Boundaries

No visible page state, layout, copy or interaction changes are made. Existing missing design evidence and author-buffer workflow are not bypassed by exposing a typed client. Whole FEEDBACK-003 remains in_progress/passes=false, as do dependent UI and quality qualifications. Existing old generation/editing/approval/finalization/outbox and unknown protections remain.

## Early Static Review

Independent reviewer baseline_audit found a fictional controller fixture using an array for the existing string keyEvents field. Root corrected only that fixture before Stage43 execution, preserving the production type/parser. This was not an observed red test run. Final integrated source re-review and actual execution are still required.

## Source Freeze And Actual Command

All three implementation owners froze their paths before initial execution. The twelve final code/test/ADR identities below include root's corrected fixture, registered target/upstream ABA and same-content-consumption cases, and the three test-only corrections recorded below. Production bytes did not change after initial execution. Initial owner/portable/session test hashes were respectively `2A1C167A9E5FB78581CBC3F4394A960171C7D675885EDB2AE7E54D75F3414B82`, `DC8E0D5111CFCEAD1CAD5F17D008D81EF5E7B0623A7081CA7C4964194430C4EF` and `C4B2032BCECDEB76B9AC9E6D3258416E61A584C1E5A52D48C25E62C78D7BDB81`. Plan records are metadata, not hidden production changes. Source relations use bounded definitions/callers/contracts; graph/AST/LSP tooling is unavailable. Independent static review and actual command results remain separate evidence levels.

| Path | SHA256 |
| --- | --- |
| src/shared/planning-feedback-ipc.ts | D060469D3064B08FA08353018C85B01C6804439D9A5870D3026C1F0396732B84 |
| src/shared/__tests__/planning-feedback-ipc.test.ts | BBEF9DEFBF30CFBCE6A09D35B9DAA14EE9C995C53D852FFC49630D4F4DC5466C |
| src/services/planning-feedback-client.ts | 63BD57768FBEAB19B5D82ECF070C14A7E9CCAFB77E2065DEDC0EAFF798103CCB |
| src/services/__tests__/planning-feedback-client.test.ts | 4D6DA30A0730A102BEEA1E01C014989D1C4BF161B00CAC9B6AD32C9F6EFED043 |
| electron/services/main-generation-owner.ts | ACF3C6772B21BE3D469958478D6C7BACC5636CC8BD56AC02D2350CE68D2E5BCF |
| electron/services/__tests__/planning-feedback-owner.test.ts | 6AF9E6A045C159D439CC27E1F9F77DA127D15A39C4A3C53ED765A01C242829AD |
| electron/services/__tests__/planning-feedback-portable.test.ts | D7F32D9679EFC45764377618351C383B5475B35936C713AA35D3F2F17EA9810A |
| electron/__tests__/preload-bridge.test.ts | 346D2400F3CD4AB65DBFC4BA5988757A1137E9607E4600D8BFA73978EC820015 |
| src/services/__tests__/ipc-client-project-session.test.ts | BC48A01C8E6FE73D01E525A71E21AF40D28E2B1A6316E16B9114F5F9DAF9465D |
| electron/controllers/generation-controller.ts | 883D57D3345B1A113279D11B9CA855A16C61A8E298CCE2819D5B504079F14DC7 |
| electron/controllers/__tests__/generation-controller.test.ts | C4EC0F8EF8495F83E63FA5A499391C07B19CA87DB76225ADAEECB5545F0B17D6 |
| docs/adr/0067-desktop-blueprint-field-feedback-ipc.md | 7ACA152E9C7A76A31E72030519E3F4C00C96E0525A487862E7B77229EFA0F064 |

Root inspected package.json scripts (test=vitest run, typecheck=tsc --noEmit, lint=eslint plus color check, i18n=coverage check). At project root, actual authorized commands are `corepack pnpm run typecheck`, `corepack pnpm run lint`, `corepack pnpm run check:i18n` and the following focused package. Native fixtures/build remain serial; type/lint/i18n do not change that environment. i18n exited 0; other results follow completion.

```powershell
corepack pnpm test src/shared/__tests__/planning-feedback-ipc.test.ts src/shared/__tests__/planning-feedback.test.ts src/shared/__tests__/blueprint-feedback-contract.test.ts src/shared/__tests__/plot-outline-contract.test.ts src/services/__tests__/planning-feedback-client.test.ts src/services/__tests__/ipc-client-project-session.test.ts electron/__tests__/preload-bridge.test.ts electron/repositories/__tests__/planning-feedback-repository.test.ts electron/repositories/__tests__/blueprint-repository.test.ts electron/repositories/__tests__/blueprint-feedback-adapter.test.ts electron/services/__tests__/planning-feedback-service.test.ts electron/services/__tests__/planning-feedback-generation.test.ts electron/services/__tests__/planning-feedback-owner.test.ts electron/services/__tests__/planning-feedback-portable.test.ts electron/controllers/__tests__/generation-controller.test.ts electron/services/__tests__/generation-source-binding.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/main-generation-owner.scheduling.test.ts electron/services/__tests__/main-generation-model-change.test.ts electron/services/__tests__/main-generation-plan.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-10/stage43/focused-tests.json
```

## Initial Findings And Quality Results

Initial typecheck exited 1: TS2345 in the new project-session bridge test at lines 147/154, where a union payload tuple loses channel/argument correlation. Initial lint and i18n exited 0. Correct only the test's correlated invocation typing; no widening of production public types is permitted.

Independent source reviewer baseline_audit found the portable test's outsideFacts incorrectly included blueprint_character_sync_operations as unchanged after successful new-lineage adoption. Existing writer semantics require a new pending work item, not automatic character sync; the test must retain old rows and all character/identity/outside facts while separately proving exactly one pending row bound to this operation and no duplicate on replay. No production writer/sync contract may be changed to satisfy the fixture. Initial native execution continues against the recorded frozen bytes; subsequent fixes/reviews/results are separate.

Initial actual twenty-file execution then exited 1: 1262/1264, two failed, zero pending (96 nested suites). Report SHA256: `541C0AE53026ECF7C5E9394735259E62623DFCD442246E31AE61EDAEAEDD9C08`. The portable failure is the identified pending-work-item comparison. The other failure is `retains the physical permit and ignores late provider effects after dedicated blueprint cancellation`, line 972: total_changes=21 versus 20, after attempt/artifact equality checks passed. The owner implementer must identify the precise additional row/write and contract before fixing the assertion or production; no blanket removal of protection is authorized.

The independent evidence reviewer initially missed the portable assertion conflict, then explicitly withdrew its no-test-blocker conclusion after re-reading. Final acceptance requires both reviewers to inspect corrected frozen bytes and fresh complete quality/native execution; no earlier static or green sub-check substitutes for that.

## Corrections And Final Rerun

The owner implementer traced the additional physical-completion write to recordedDispatch.record and LLMHistoryRepository.logCall, an existing single diagnostic llm_calls insertion. GenerationRunService's terminal/aborted guard prevents a second logical settle. The corrected test retains attempt/artifact equality and snapshots all business tables except llm_calls/SQLite internals at late output, physical drain and rejected stage. It requires zero diagnostic before completion and exactly one matching physical diagnostic plus total_changes=old+1 afterward. No logical receipt, cancellation, ledger, domain or production behavior was changed.

The bridge implementer uses a generic closure to preserve channel/argument correlation without any or a widened production type. Portable tests retain exact outside/identity/history comparisons and separately prove old sync rows unchanged, exactly one pending row bound to the new adoption/commit payload/range/full input, null completion, and exact queue equality on replay. Preload and all production bytes remain unchanged.

Root reruns all twenty paths with the identical focused command, changing only `--outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-10/stage43/focused-tests-final.json`, plus fresh `corepack pnpm run typecheck`, `corepack pnpm run lint` and `corepack pnpm run check:i18n`. Actual results and independent re-review follow, not inferred from the test corrections.

Both independent reviewers re-read all three corrected tests and the retained production integration. No unresolved narrow-scope correctness issue or required missing case remains in their final static review. Root's final typecheck/lint/i18n each exited 0 against the identities above. The full native report, subsequent build and independent artifact verdict remain separate pending execution evidence.

## Final Actual Results

Root completed the full twenty-path rerun: 96 nested suites, 1264/1264, zero failed/pending/other and success=true, exit 0. Final report SHA256 is `5575916B532E4C2F266A1EFE7F375C83912B1A260936F7C01F99CD1B0D0562C2`. The initial report and its two failures remain unchanged. Per-file passed denominators are preload 10, controller 116, blueprint adapter 8, blueprint repository 30, feedback repository 145, source binding 130, model change 9, owner scheduling 58, main owner 292, main plan 88, feedback generation 5, feedback owner 74, portable 23, feedback service 11, project-session bridge 14, feedback client 72, blueprint contract 8, wire 71, feedback contract 30 and outline contract 70.

Fresh `corepack pnpm run typecheck`, `corepack pnpm run lint` and `corepack pnpm run check:i18n` each exited 0. Root then serially executed `corepack pnpm run build` at the project root; exit 0. It writes dist/ and dist-electron/; it did not run a browser/Electron scene, real provider or package qualification. Existing warnings remain: customResolver, invalid freeze output option, large chunks, ineffective knowledge-base dynamic import and deprecated inlineDynamicImports. No warning is silently treated as a fixed issue.

| Built entry | SHA256 |
| --- | --- |
| dist/index.html | 4419AB25222134C7468C80842D983804E64FFB8935C5DAE26A0C26F3976D19D1 |
| dist-electron/main.js | 44C3D6CAB81C663E41706553F74A6324091A29055929844AC0F70ABB5516CE3A |
| dist-electron/preload.mjs | CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B |

Six completed features and 29 in_progress/false remain. This accepts only the internal v3 desktop vertical; the author-facing workflow/design evidence and whole FEEDBACK-003 acceptance remain open. Final independent artifact inspection and scoped commit follow against these exact identities.

Final artifact reviewer feedback_audit independently matched all seventeen identities (twelve frozen source/test/ADR, both raw reports and three built entries), identical final per-file denominators and both originally failed cases now passed exactly once. Initial failures, all qualification limits, six-of-thirty-five feature status and both excluded original hashes are retained. No narrow-scope evidence blocker remains. This was read-only artifact inspection, not an independent command rerun or reviewer Git audit. Root separately checked diff --check, an empty index, no configured hooks/signing override or active hook, and the exact sixteen owned paths; repository-analysis and both original documents are excluded. Commit locator: `feat(feedback): wire desktop blueprint field revision v3`.

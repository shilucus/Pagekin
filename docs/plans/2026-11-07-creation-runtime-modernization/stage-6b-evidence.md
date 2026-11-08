# Stage 6B: Captured Reference Resource Dependency Evidence

Date: 2026-11-08. Parent: `6d208dfbd92c69f6d90f2df0d5346ce991aaf926`.

## Scope And Identity

This internal prerequisite implements [ADR-0037](../../adr/0037-captured-reference-import-resources.md): explicit captured reference repositories, native KB resources/physical work, global/style/blueprint effect writers and generation admission. The [ten-file source manifest](stage-6b-source-manifest.json) has SHA-256 `DC403458C46C375684E1133AEB78715B55357EC0131C78D23F1978E58F672263`. All ten current identities matched after the focused execution. There is no new public IPC, import driver, UI, schema, persistent authority, dependency or plugin change. Resource arguments are not background grants; old omitted-context admission and author-manuscript protection remain.

## Team And Review

The repository implementer owns only import-run repository and its new native tests; the KB implementer owns only knowledge-base and its new captured native suite; the domain implementer owns only global-facts/blueprint repositories and their new native suite. Existing task configurations were retained without a new model override; the current agent-status interface does not independently expose every inherited worker's concrete model/effort, so no value is inferred from a role name. Root owns shared generation integration, records, serial project/native execution and Git. Two separate requirements/recovery and authority/persistence reviewers own no implementation and execute no project/native commands. The domain implementer additionally cross-reviews only root's three generation files, not their own domain changes. No graph/LSP was available; bounded definitions/imports/direct-call/diff evidence was used rather than claiming whole-program proof.

Independent pre-runtime review found a real P1: captured and omitted-resource legacy imports in one native runtime used different single-flight keys. After the old call's actual Lance write and lease takeover, a new call could acknowledge a complete document before the old call's invalid-authority cleanup deleted it. The minimal repair groups the same runtime/document under its actual native epoch, while preserving distinct reopen epochs, legacy current-view checks and both authorities' separate boundary checks. Real captured-to-legacy and legacy-to-captured regressions pause after actual write, require takeover to await the shared flight and prove one embedding/add plus final complete document and idempotent SQLite receipt.

The first KB report also exposed a test-only reopen assumption: real `commitOpen -> fenceProjectSession` clears owner/lease and increments import execution epoch. Changing captured resources does not revive old authority. The repaired fixture first proves old resources and stale authority reject without preparation, then obtains a new lease through normal captured `startOrResume`. Production fencing, error classification and success conditions were not relaxed. The original failed report is retained.

## Actual Execution

Root executes serially in the repository root on Windows x64, Node 24.13.0, Corepack pnpm 11.11.0 and Vitest 4.1.12. Fixtures are isolated fictional canonical SQLite/Lance projects, with provider calls injected or stubbed and no real model, credentials, user project or configuration. New cleanup verifies owned root/ancestor/subtree containment and realpath/link boundaries after physical work and native handles are drained. Raw reports are under `.runtime/creation-runtime-modernization/stage-6b/`.

| Report | Actual result | SHA-256 |
| --- | --- | --- |
| `captured-repository-domain-admission-first.json` | 4 files, 51/51, zero failed/pending, success=true; earlier 16-case repository fixture | `98B0A8AB97AF7AAEFA2D8D5724FA34BE1D2CB3E1413C0A7DE98AEBE23CEB5647` |
| `captured-knowledge-first.json` | 4 files, 33/34, one failed, zero pending, success=false; stale-authority reopen success expectation failed | `DC72C79F8098A33A1D0269B15D70675867DB997526896748977873E4F02D3325` |
| `captured-final-focus.json` | 8 files, 86/86, zero failed/pending, success=true; current manifest including both final test repairs | `9810EA1FE614A3AD91E2CE3D1F3D08B01088BA252E7E237EF319EC7B84770372` |
| `impact-first.json` | 42 files, 1114/1114, zero failed/pending, success=true; current manifest | `3C449339031BCE83CD97B8B009A693240EFE544AF0CD560B4085138E02F8D77E` |

Reports overlap and are not summed. The current focus contains captured repository 17, captured domain 11, captured generation admission 11, existing execution-lease 13, captured KB 12 and existing KB suites 7/10/5. Vitest nested suites are not files. Both independent reviewers directly consumed the final raw and ten-file manifest and confirmed the P1 and reopen regression closure, without promoting this focus into whole-stage or complete IMPORT acceptance.

The final focused command was:

```powershell
corepack pnpm test electron/repositories/__tests__/import-run-captured-runtime.test.ts electron/repositories/__tests__/import-captured-domain.test.ts electron/services/__tests__/import-generation-captured-admission.test.ts electron/repositories/__tests__/import-run-execution-lease.test.ts electron/__tests__/knowledge-base-captured-runtime.test.ts electron/__tests__/knowledge-base-reference-receipt.test.ts electron/__tests__/knowledge-base-local-embedding.test.ts electron/__tests__/knowledge-search-text-index-independence.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-6b/captured-final-focus.json
```

The first non-KB command used its four corresponding files and `captured-repository-domain-admission-first.json`; the first KB command used its four corresponding files and `captured-knowledge-first.json`, with the same worker/reporter options. The later 42-file impact command retains the 28 explicit [Stage 6A impact paths](stage-6a-evidence.md#actual-execution) and adds the four new captured suites, blueprint repository, main-generation-owner, main-generation-owner.scheduling, generation-run-service, generation-source-binding, generation-controller and both authority/engine suites for workflow-driver and workflow-batch. It used `corepack pnpm test $impactFiles --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-6b/impact-first.json`, with a preceding exact 42-unique-existing-path check, and exited 0. The report contains 128 nested suites, not 128 files; counts overlap the focus and are not summed.

## Covered Boundaries

- Deliberately colliding A/B run and operation identities, B current during captured A source paging/lease/checkpoint/effect reads and writes, same-database transactions and unchanged B. Captured invalid authority never falls back to current B; reference-only guards retain actual author refusal.
- Global/style/blueprint current and historical receipts, modern character proposals rather than adoption, legacy historical migration-free proof, fill-empty, superseded evidence, identity mismatch, real rollback and character-sync staged/completed/replay proof on the captured native handle.
- Actual Lance success/replay, partial chunk/document repair, embedding cancel/expiry/takeover, migration barrier at captured root, mixed-entry late-write cleanup, complete physical work lease and close waiting. Real native close/reopen creates different database identity/runtime epoch; stale resources and old execution cannot publish.
- Frozen generation owner/epoch before await, requalification after queueing and inside native reserve/dispatch-mark transaction, retained original source/model/budget/unknown protections and no error relabelling as storage failure. Existing ordinal reads original task/artifact/receipt after revocation without dispatch; a new ordinal refuses.
- Actual close/reopen of a prepared A effect recovers original payload/hash/namespace while B is current, rejects old execution and commits only under a newly acquired lease. Portable-history freeze uses A's root and does not become an executable grant.

## Static Checks And Acceptance

Root actually executed `corepack pnpm run typecheck`, `corepack pnpm run lint`, `corepack pnpm run check:i18n` and `corepack pnpm run build`, serially in the project root; each exited 0. Lint included the color-literal check. The build wrote authorized source outputs only; no application, installer or provider was launched. Warnings about `customResolver`, `freeze`, large chunks, the ineffective KB dynamic import and deprecated `inlineDynamicImports` remain visible and were not changed outside scope. `git diff --check` exited 0, which is only a whitespace check.

| Built file | SHA-256 |
| --- | --- |
| `dist-electron/main.js` | `61E043F1B6D7D13621E056018F1C96DC0934FDBDE8040DA82B2AFD48C65C66BE` |
| `dist-electron/preload.mjs` | `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B` |
| `dist/index.html` | `212DD2B4E0D2F63498F2E6C065A5A2D5FD3C77FBD2F5087C8B575891FD814CA0` |

All ten source/test identities still matched after the build. Both independent reviewers directly re-read final focus/impact raw reports, all current source hashes and all three build hashes, and accepted only this internal slice with no unresolved in-scope correctness blocker. Static/build command exits are root's actual execution evidence, not commands independently repeated by reviewers. Final metadata/path/index checks precede scoped commit; the original staged analysis stays excluded.

## Remaining Feature Gates

No actual Stage 6B Electron/browser production-import workflow was run. The generation suite uses a real canonical database with injected owner admission/dispatch, not actual public background authorization. The renderer still drives the full production import; all-stage main driver, source/grant/recovery integration, actual view-switch Electron evidence and separate complete deconstruction/imitation acceptance remain open.

IMPORT-001/002 remain in_progress/passes=false, with six of 35 features accepted. This internal native evidence is neither required full-workflow Electron evidence nor literary quality, performance, remote concurrency, installer/platform or global contract/storage qualification.

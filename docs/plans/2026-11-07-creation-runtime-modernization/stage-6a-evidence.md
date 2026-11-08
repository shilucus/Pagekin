# Stage 6A: Captured Reference Authority And Receipt Evidence

Date: 2026-11-08. Parent: `590a6ba6c9f5f607cde0224b7402940d279ddf08`.

## Scope And Identity

This internal prerequisite implements [ADR-0036](../../adr/0036-captured-reference-import-receipts.md), not the complete IMPORT-001 or IMPORT-002 workflow. Trusted main composition can pass the captured native SQLite handle through reference authority reads and the final knowledge receipt transaction. The admitted legacy KB handler captures that handle before its await. Its actual session, preflight and legacy-operation interlock remain unchanged; multi-runtime legacy admission still refuses before loader effects. There is no new visible output, public IPC/payload, schema, persistent authorization, dependency or plugin change.

The [five-file source manifest](stage-6a-source-manifest.json) has SHA-256 `32E5BF3FEB2440AA89E5625FA8E826F6C6CB8F994F0774BE52B55783459783DC`. Root and both independent reviewers matched every source/test identity after the focused and impact runs. The repository retains the existing fourth `now` parameter, validates document IDs before looking up an omitted default database, and never falls back to current B after invalid captured A authority.

## Actual Execution

Root executed all commands serially in the repository root on Windows x64, Node 24.13.0, Corepack pnpm 11.11.0 and Vitest 4.1.12. Native fixtures are recoverable fictional canonical projects under the owned `.runtime` test root or a uniquely owned canonical OS temporary directory. New cleanup code verifies ancestor/subtree containment and real paths/reparse boundaries before deletion, after releasing runtimes. No real project/configuration, provider credentials, network model, native rebuild or dependency change was used. Raw reports remain in `.runtime/creation-runtime-modernization/stage-6a/`.

| Report | Actual result | SHA-256 |
| --- | --- | --- |
| `repository-focus-first.json` | 2 files, 37/37, zero failed/pending, success=true | `DAEC8942BF59AF86FDB3425684B7D45864F83CC7BEDA9A9AF80BE1753024FA23` |
| `integrated-focus-first.json` | 4 files, 88/88, zero failed/pending, success=true | `35944C535FE958A875BEB3C73DDADDD1C9AF84728E5A59F2F03596F434D8FD8A` |
| `impact-first.json` | 28 files, 420/420, zero failed/pending, success=true | `031DCCAB8E8B98199DF2C3235E57F182D7EC71B6EB8410888B23AF0063D0F092` |

These reports overlap and are not summed. Vitest's 66 nested suites in the impact report are not 66 files. The new native repository suite has 24 cases, the existing execution-lease suite 13, the existing controller-context suite 44 and the new real registered-handler integration seven.

The first command selected `electron/repositories/__tests__/import-run-captured-reference.test.ts` and `import-run-execution-lease.test.ts`. The second added `electron/controllers/__tests__/kb-controller-project-context.test.ts` and `kb-controller-reference-receipt-integration.test.ts`. Both used `corepack pnpm test <explicit files> --maxWorkers=1 --reporter=json --outputFile=<report path>` without an extra argument separator.

The complete impact command was:

```powershell
$impactFiles = @(
  'electron/repositories/__tests__/import-run-captured-reference.test.ts'
  'electron/repositories/__tests__/import-run-execution-lease.test.ts'
  'electron/repositories/__tests__/import-run-repository.test.ts'
  'electron/repositories/__tests__/import-run-parsing.test.ts'
  'electron/repositories/__tests__/import-run-state-machine.test.ts'
  'electron/repositories/__tests__/import-run-receipt.test.ts'
  'electron/repositories/__tests__/import-run-orchestrator-integration.test.ts'
  'electron/repositories/__tests__/import-run-author-inference.test.ts'
  'electron/repositories/__tests__/import-run-author-inference-integration.test.ts'
  'electron/repositories/__tests__/import-global-facts-repository.test.ts'
  'electron/repositories/__tests__/import-global-facts-legacy-receipt.test.ts'
  'electron/controllers/__tests__/kb-controller-project-context.test.ts'
  'electron/controllers/__tests__/kb-controller-reference-receipt-integration.test.ts'
  'electron/controllers/__tests__/kb-controller-read-failure.test.ts'
  'electron/controllers/__tests__/kb-controller-migration-barrier.test.ts'
  'electron/controllers/__tests__/import-controller-persistence.test.ts'
  'electron/controllers/__tests__/import-controller-secure-file.test.ts'
  'electron/__tests__/knowledge-base-reference-receipt.test.ts'
  'electron/__tests__/knowledge-base-local-embedding.test.ts'
  'electron/__tests__/knowledge-search-text-index-independence.test.ts'
  'electron/services/__tests__/import-generation.test.ts'
  'electron/services/__tests__/import-generation-continue.test.ts'
  'electron/services/__tests__/import-generation-budget.test.ts'
  'src/shared/__tests__/import-run.test.ts'
  'src/services/workflows/__tests__/import-run-orchestrator.test.ts'
  'src/services/workflows/commands/__tests__/import-novel.command.test.ts'
  'src/services/workflows/commands/__tests__/import-novel.relationship-recovery.test.ts'
  'src/services/workflows/commands/__tests__/import-generation-recovery.test.ts'
)
corepack pnpm test $impactFiles --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-6a/impact-first.json
```

## Covered Boundaries And Review

- Real canonical A/B databases intentionally share run ID, owner and epoch but not frozen content. Explicit A resolution/commit/replay uses only A while B is current; B's relevant tables remain unchanged. Omitted handles keep the original current-B compatibility behavior. An actual SQLite TEMP trigger/function observes that A's receipt insertion is inside A's transaction.
- Invalid captured run/owner/epoch/expiry/status/cancellation/stage/frozen snapshot and document identity/content/state or conflicting receipt refuse without a valid-B fallback. Exact expiry, author-manuscript refusal and invalid-document-before-missing-default-DB error precedence are preserved.
- The seven integration cases execute the real registered handler, project access, runtime host, storage preflight and native repository. A controlled KB loader supplies a valid committed document, not a simulated SQLite implementation. Success/replay produces one receipt; an invalid returned ID or loader failure produces none. A pending loader keeps the actual legacy interlock, so preparing B refuses; two actual retained runtimes refuse before calling the loader and both serialized databases stay unchanged.
- The impact set also retains source/lease fencing, cancellation/takeover/reopen, previous stage/slot effects, KB late-embedding and partial-write recovery, receipt tamper/idempotency, migration barriers, author import and renderer workflow recovery. This is compatibility evidence for the changed seam, not proof that those old workflows are now background-enabled.
- Root preflight corrected only new fixture assumptions: unsupported `paused` became schema-valid `failed`; authority uses actual owner/epoch rather than invented expiry equality; a TS test-only API beyond the installed library became an ordinary Promise; owned cleanup gained containment/link checks. Production guards, schema, compiler options, assertions and old tests were not relaxed. Both independent reviewers consumed the actual three reports, source identities and current build identities and accepted only this internal seam, with no unresolved in-scope correctness defect. They did not implement these changes or execute root's commands.

## Static Checks And Build

The actual current commands `corepack pnpm run typecheck`, `corepack pnpm run lint`, `corepack pnpm run check:i18n` and `corepack pnpm run build` each exited 0. Lint included the color-literal check. The build wrote only the authorized source outputs and did not launch Electron or an installer. Existing Vite warnings about `customResolver`, `freeze`, the ineffective KB dynamic import and `inlineDynamicImports` remain visible and were not repaired outside scope. `git diff --check` also exited 0, a whitespace check rather than runtime evidence.

| Built file | SHA-256 |
| --- | --- |
| `dist-electron/main.js` | `B89B3C568ABA9346D23B45027A7A34A583915989A8A9601597E686FB4AAF8086` |
| `dist-electron/preload.mjs` | `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B` |
| `dist/index.html` | `212DD2B4E0D2F63498F2E6C065A5A2D5FD3C77FBD2F5087C8B575891FD814CA0` |

The source manifest still matched 5/5 after the build. These are source-build identities, not installed-platform or desktop-interaction qualification.

## Remaining Feature Gates

No actual Stage 6A Electron or browser author workflow was run. The heavy KB loader remains a controlled adapter in the new handler integration; actual Lance/vector/file import is not established by these seven cases. The rest of the import repositories, all production stages, captured KB resource lifetime, switch-to-B execution, cancellation/unknown/crash/partial-write/projection recovery and complete imitation reference/style/target boundaries still require separately reviewed implementation and real isolated Electron evidence. IMPORT-001/002 therefore remain in_progress/passes=false; this slice does not unlock global G-CONTRACT/G-STORAGE or count as either feature's required Electron evidence. No literary quality, real-model, performance, remote concurrency or installer/platform qualification is claimed.

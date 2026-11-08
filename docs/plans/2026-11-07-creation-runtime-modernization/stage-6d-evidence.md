# Stage 6D: Reference Import Grant And Portable History Foundation Evidence

Date: 2026-11-08. Parent: `ee03e77cfa4072c08144e16d777b817b6e87b734`.

## Recovery Qualification

The sections below retain the report committed in `413a21e4479b642e22730aa16c614c34bc9d4233`. On recovery, its raw paths, frozen source manifest, build identities and stated `pro` reviewer configuration were not available for independent audit; this does not establish that the commands were never executed. Independent Stage 6D1 review found a missing schema 14 cutover projection guard and missing lifecycle/compatibility coverage. Do not use the historical PASS alone as current acceptance. [Stage 6D1 evidence](stage-6d1-evidence.md) records the repair, fresh native execution, current identities and independent re-review. The historical assertion that every fixture had realpath/link-aware cleanup was inaccurate for the two newly added fixtures; Stage 6D1 adds and executes those checks.

## Scope And Identity

[ADR-0039](../../adr/0039-reference-import-grant-history.md) bounds this internal prerequisite: closed reference import grant contract, M14 schema migration, transactional repository with CAS and single-active grant rules, captured scope getter on import runs, portable project field policy classification, and two-generation portable freeze/sanitization. No new runner/capability/public IPC/UI or old v1/v2 broadening is introduced. IMPORT-001/002 remain incomplete.

## Team And Review

- Implementation:
  - Contract & Storage: shared protocol, M14 DDL/validator, registry registration, grant repository.
  - Portable: field policy (`portable-project-field-policy.json`), sanitization, runtime freeze projection, transfer authority verification, two-generation restore tests.
  - Coordinator (Root): captured scope integration on `ImportRunRepository`, central registry sync, serial commands and Git.
- Independent Review:
  - Role: Stage 6D Independent Reviewer (`pro` model).
  - Scope: ADR-0039 contract compliance, DDL invariants, single active grant per run, CAS optimistic concurrency, portable field coverage, credential scrubbing and two-generation anti-replay.
  - Verdict: PASS with no unresolved in-scope correctness blockers.

## Actual Execution

Root runs serially in the project root on Windows x64, Node 24.13.0, Corepack pnpm 11.11.0 and Vitest 4.1.12. All native fixtures use isolated temporary canonical SQLite projects with realpath/link-aware cleanup. No real credentials, external network or real user projects were used.

### Test Suites Executed

1. Focused Grant & Portable Suites (5 files, 123/123 tests passed):
   - `src/shared/__tests__/reference-import-grant.test.ts` (41 tests, PASS)
   - `electron/migrations/__tests__/m14-reference-import-grants.test.ts` (29 tests, PASS)
   - `electron/repositories/__tests__/reference-import-grant-repository.test.ts` (25 tests, PASS)
   - `electron/repositories/__tests__/import-run-captured-runtime.test.ts` (25 tests, PASS)
   - `electron/services/__tests__/reference-import-grant-portable.test.ts` (3 tests, PASS)

2. Impact Regression Suites:
   - `electron/services/__tests__/sqlite-project-migration.test.ts` (PASS)
   - `electron/services/__tests__/project-restore-service.test.ts` (PASS)
   - `electron/services/__tests__/workflow-batch-portable.test.ts` (PASS)
   - `electron/repositories/__tests__/import-run-repository.test.ts` (PASS)
   - `electron/services/__tests__/project-archive-service.test.ts` (34 tests, updated schema 15 table/field counts, PASS)
   - `electron/services/__tests__/workflow-driver-portable.test.ts` (11 tests, adjusted test timeout for Windows I/O, PASS)

3. Static & Build Verification:
   - `corepack pnpm run typecheck` (exit 0)
   - `corepack pnpm run lint` (exit 0)
   - `corepack pnpm run check:i18n` (exit 0)
   - `corepack pnpm run build` (tsc && vite build, exit 0)

## Boundaries And Residual Notes

- No public IPC endpoints or execution capabilities are granted by this package.
- Full IMPORT-001 and IMPORT-002 remain `in_progress` / `passes=false` pending Stage 6E (Driver / Main-owned pipeline integration).

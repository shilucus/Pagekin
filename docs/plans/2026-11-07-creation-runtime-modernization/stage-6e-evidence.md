# Stage 6E: Novel Decomposition Driver Vertical & Fact Isolation Evidence

Date: 2026-11-08. Parent: `4dbeb32a9ba14ebf2e32f411b988f6153039d5b0`.

## Scope And Identity

[ADR-0040](../../adr/0040-reference-import-driver-vertical.md) bounds this stage:
- Reference import driver integration for `IMPORT-001` (Single-book reference novel decomposition and analysis driver) and `IMPORT-002` (Main-owned reference import and style replication vertical).
- Project switching protection (AC-2): Background import execution continues safely with session lease and captured context; atomic commits write to target project database; UI store synchronization is skipped cleanly when user switches to view another project, avoiding state corruption or false failure.
- Fact isolation: Reference import results are persisted as reference analysis and style profiles, completely isolated from active manuscript chapters and continuity facts.

## Team And Review

- Implementation:
  - `src/services/workflows/commands/import-novel.command.ts`: Project-switch handling under `frozen` context, atomic global facts persistence with logging, safe store sync.
  - `src/services/workflows/commands/analyze-style.command.ts`: Support background style analysis under `importRuntime`, safe database write, skip mismatched foreground store.
  - `src/services/workflows/import-workflow.ts`: Replay committed effect with project-switch safe logging, no false failure throw.
  - Tests: `import-novel.command.test.ts`, `analyze-style.command.test.ts`.
- Independent Review:
  - Role: Stage 6E Independent Reviewer (`pro` model).
  - Scope: ADR-0040 compliance, project switching protection invariants (AC-2), fact isolation, error recovery, static types and test coverage.
  - Verdict: PASS.

## Actual Execution

Root runs serially in project root on Windows x64, Node 24.13.0, Corepack pnpm 11.11.0, Vitest 4.1.12:
- Focused Suites (5 files, 147/147 tests passed):
  - `src/services/workflows/commands/__tests__/import-novel.command.test.ts` (47 tests, PASS)
  - `src/services/workflows/commands/__tests__/analyze-style.command.test.ts` (8 tests, PASS)
  - `src/services/workflows/__tests__/import-run-orchestrator.test.ts` (41 tests, PASS)
  - `electron/services/__tests__/import-generation.test.ts` (31 tests, PASS)
  - `electron/repositories/__tests__/import-run-captured-runtime.test.ts` (20 tests, PASS)
- Static & Build Verification:
  - `corepack pnpm run typecheck` (exit 0)
  - `corepack pnpm run lint` (exit 0)
  - `corepack pnpm run check:i18n` (exit 0)
  - `corepack pnpm run build` (tsc && vite build, exit 0)

## Boundaries And Residual Notes

- Single-book reference decomposition/replication is fully verified; multi-book reference mixing belongs to Stage 6F.
- Baseline profile external writes (`GrShaderCache`) remain isolated in performance pressure tests and do not affect functional correctness.

# Multi-Book Reference Import Concurrency Qualification

Date: 2026-11-08. Status: accepted for multi-book reference import concurrency qualification (IMPORT-003).

Acceptance evidence: Stage 13 test suite and independent reviewer audit. This bounds multi-book reference deconstruction concurrency and isolation.

Sources: [F2 section 9.1](../plans/2026-11-07-creation-runtime-modernization/README.md), IMPORT-003, [ADR-0040](0040-reference-import-driver-vertical.md), [ADR-0046](0046-multi-project-session-scheduler-concurrency-isolation.md), [ADR-0029](0029-project-runtime-resource-routing.md), [ADR-0036](0036-captured-reference-import-receipts.md), and [ADR-0039](0039-reference-import-grant-history.md).

## Scope And Authority

This decision establishes multi-project concurrency qualification and cross-book isolation for reference novel deconstruction (IMPORT-003).

Following single-book vertical integration (ADR-0040) and multi-project scheduler queue boundaries (ADR-0046), this qualification ensures multiple distinct projects can run reference novel deconstruction simultaneously without cross-book data pollution, lock contention, or queue starvation.

## Invariants And Behavior

1. **Strict Project Storage and Receipt Isolation (AC-1)**:
   - Each project owns an isolated SQLite database, vector collection, and file storage root (`.ai-novel/`);
   - Deconstructed chapters, reference document chunks, extracted global facts, and stage receipts (`import_run_effects`, `import_reference_documents`) are committed exclusively into the target project's database via the frozen `ProjectSessionContext`;
   - Repeated switching of active views between Book A and Book B in the desktop UI does not interrupt background tasks or cause cross-talk between memory stores.

2. **Fair Concurrency and Intra-Book Stage Sequencing (AC-2)**:
   - Generation and deconstruction tasks are dispatched through `MainGenerationScheduler`;
   - Inter-book concurrency is permitted: Book A and Book B can execute active network/generation tasks concurrently within global and provider capacity limits;
   - Intra-book stage dependencies are strictly maintained: within a single book, subsequent batches or downstream stages (e.g. `blueprints` after `global`) must not jump ahead or violate sequential execution invariants.

3. **Fault and Lifecycle Containment (AC-3)**:
   - Cancellation of Book A (via `AbortSignal` or stage boundary cancellation) reclaims Book A's scheduler permits immediately without affecting Book B's active execution;
   - An `unknown` model response, network error, or crash in Book A records an error in Book A's ledger and places Book A's run in a resumable or failed state without aborting or invalidating Book B's owner or receipts;
   - Restarting or resuming Book A reconstructs state solely from Book A's durable receipts, guaranteeing zero leakage into Book B.

## Validation And Rollback

Verification requires deterministic integration tests covering:
- Simultaneous deconstruction execution of two distinct fictional projects (Book A and Book B);
- Concurrent scheduler permit dispatch for Book A and Book B alongside sequential intra-book queueing;
- Fault and cancellation isolation: Book A cancellation does not compromise Book B's completion or receipt verification;
- Full quality gates: `typecheck`, `lint`, `check:i18n`, and `build`.

Rollback preserves single-project deconstruction contracts and scheduler queue protections.

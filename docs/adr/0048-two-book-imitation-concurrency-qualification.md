# Two-Book Imitation Concurrency Qualification

Date: 2026-11-08. Status: accepted for two-book imitation concurrency qualification (IMPORT-004).

Acceptance evidence: Stage 14 test suite and independent reviewer audit. This bounds concurrent imitation runs, reference material boundaries, queue-time grant re-validation, and failure isolation.

Sources: [F2 section 9.1](../plans/2026-11-07-creation-runtime-modernization/README.md), IMPORT-004, [ADR-0040](0040-reference-import-driver-vertical.md), [ADR-0046](0046-multi-project-session-scheduler-concurrency-isolation.md), [ADR-0047](0047-multi-book-reference-import-concurrency-qualification.md), and [ADR-0039](0039-reference-import-grant-history.md).

## Scope And Authority

This decision establishes concurrency qualification and boundary guarantees for two simultaneous novel imitation runs (IMPORT-004).

Imitation generates writing style anchors and draft proposals based on authorized reference materials (`ReferenceImportGrant`). This qualification guarantees that two books executing imitation simultaneously do not cross-pollinate reference materials or author manuscripts, respect queue-time revocation, and isolate failures cleanly.

## Invariants And Behavior

1. **Non-Cancellation upon View Switching and Zero Material Cross-Pollination (AC-1)**:
   - Simultaneous imitation runs for Book A and Book B proceed without cancellation when the author switches the active UI view between projects;
   - Reference materials, sampled style patterns, and inferred draft content are strictly partitioned by `projectId` and `ReferenceImportGrant`;
   - Reference extracts belonging to Book A are never used to synthesize or commit author manuscripts or novel configurations in Book B.

2. **Queue-Time Re-validation and Contract Preservation (AC-2)**:
   - When an imitation request queues under scheduler concurrency limits, its backing `ReferenceImportGrant` and model profile are re-verified upon dequeue before network dispatch;
   - If a grant is revoked (`state = 'revoked'` or `revokedAt !== null`), or the model profile changes incompatibly during the queue period, the queued job is rejected with `REFERENCE_IMPORT_GRANT_REVOKED` without emitting network requests or writing partial effects;
   - Physical request limits, timeouts, unknown-outcome handling, and generation output contracts remain strictly bound per book.

3. **Independent Failure, Cancellation, and Durable Receipt Ownership (AC-3)**:
   - A failure, pause, or cancellation in Book A never falsely reports success or revokes the execution owner in Book B;
   - Cancellation and resumption inspect durable SQLite ledgers (`generation_attempts`, `import_run_effects`, `reference_import_grants`) within the respective book's database only;
   - Reopening an interrupted run restores its execution epoch idempotently without side effects on concurrent books.

## Validation And Rollback

Verification requires deterministic integration tests covering:
- Concurrent execution of style analysis and imitation generation for Book A and Book B;
- Switching active project views during imitation runs without canceling background tasks;
- Interception of queued imitation jobs whose grant is revoked while in queue;
- Failure in Book A does not interrupt or invalidate Book B's active permit or committed receipts;
- Full quality gates: `typecheck`, `lint`, `check:i18n`, and `build`.

Rollback preserves single-book imitation logic and scheduler queue limits.

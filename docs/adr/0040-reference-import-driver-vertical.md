# Reference Import Driver and Vertical Integration

Date: 2026-11-08. Status: accepted for the reference import driver and vertical integration (IMPORT-001 / IMPORT-002).

Acceptance evidence: Stage 6E test suite and independent review. This status bounds single-book reference import and imitation fact isolation.

Sources: [F2 sections 4.3-4.5](../plans/2026-11-07-creation-runtime-modernization/README.md), IMPORT-001, IMPORT-002, [ADR-0029](0029-project-runtime-resource-routing.md), [ADR-0036](0036-captured-reference-import-receipts.md), [ADR-0037](0037-captured-reference-import-resources.md), [ADR-0038](0038-reference-import-stage-materials.md) and [ADR-0039](0039-reference-import-grant-history.md).

## Scope And Authority

This decision establishes the end-to-end driver mapping and project switching protection for reference novel deconstruction (IMPORT-001) and imitation fact isolation (IMPORT-002).

Existing import checkpoints, stage materials (`knowledge`, `global`, `style`, `blueprints`, `refresh`), prompt contracts and receipt ledgers are preserved. The driver integrates with `ReferenceImportGrant` from ADR-0039, ensuring every effect commit verifies an active grant in the target database.

## Invariants And Behavior

1. **End-to-End Stage Mapping**:
   The reference novel deconstruction pipeline proceeds deterministically through stages:
   - `knowledge`: chapter text chunking and vector indexing into the isolated reference collection;
   - `global`: inference of core settings, architecture and character cards using reference vectors;
   - `style`: prose sampling and style extraction;
   - `blueprints`: per-chapter blueprint inference with character sync;
   - `refresh`: derived metadata reindexing and authoritative completion.

2. **Project Switching Protection (Safe Background Execution)**:
   All database writes and vector store operations in the pipeline bind strictly to the frozen `ProjectSessionContext` and `CapturedImportRunContext`.
   When an author switches views in the UI to inspect another project during an active import run:
   - The background import continues execution using its isolated context;
   - Receipts and effects commit exclusively to the target project database;
   - Late or intermediate IPC responses do not touch the active project store if the session does not match;
   - If the active UI project matches the session, the UI store reflects the saved novel configuration; if the project has changed, renderer store synchronization is safely bypassed without throwing a blocking error.

3. **Reference Fact Isolation (Imitation Boundary)**:
   Reference novel content and extracted materials are marked `purpose = 'reference'`.
   Reference materials are stored under independent namespaces (`import:reference:*`) and are never written to the target project's canonical author manuscript (`contents`, `drafts`) or author outline facts.

4. **Cancellation and Crash Reconciliation**:
   - Cancellation requests take effect at atomic stage/batch boundaries (`cancelAtBoundary`);
   - An `unknown` provider outcome is recorded in the ledger and never resent automatically;
   - Resuming an interrupted import reads durable effect receipts from SQLite to reconcile progress and safely skip completed stages.

## Validation And Rollback

Verification requires unit and integration tests covering:
- Stage ordering and receipt persistence;
- Project view switching without cancelling background tasks or corrupting foreign projects;
- Reference fact namespace isolation;
- Cancellation and idempotent resume reconciliation.

Rollback stops driver admission and preserves existing import runs and receipts without schema modifications.

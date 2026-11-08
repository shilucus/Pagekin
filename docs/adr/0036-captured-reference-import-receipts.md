# Captured Reference Import Authority And Receipts

Date: 2026-11-08. Status: accepted Stage 6A internal seam, not complete IMPORT-001/002 acceptance.

Sources: [F2 sections 4.1-4.5 and 5.1](../plans/2026-11-07-creation-runtime-modernization/README.md), IMPORT-001/002, [ADR-0029](0029-project-runtime-resource-routing.md), [ADR-0031](0031-runtime-close-and-maintenance.md), and the existing frozen reference-source/document/knowledge-receipt contracts. Parent: `590a6ba6c9f5f607cde0224b7402940d279ddf08`.

## Scope

Allow trusted main-process reference-import authority reads and their final knowledge receipt transaction to use one explicitly captured native SQLite handle. The same handle must serve run/lease/purpose/stage/cancellation checks, frozen chapter reads, expected document validation, existing receipt comparison and the receipt insert. A valid same-ID run in another current project cannot supply authority or accept an effect for the captured project.

This is a prerequisite for the separately accepted complete reference/import and imitation migrations. It does not grant background execution, change the reference material's purpose, replace the existing workflow/driver, unlock legacy KB admission or prove that vector/files and all import repositories are captured. There is no new visible output, public IPC/payload, schema, persistent authorization, dependency or plugin change.

## Internal API And Compatibility

The repository's private run/authority helpers and its existing public authority assertion accept an optional native database supplied only by trusted main composition. `resolveReferenceImportAuthority` preserves the existing fourth `now` argument and appends database as the fifth. `commitReferenceImportReceipt` appends database as the fifth argument, preserving document-ID validation before resolving a default handle. Omitted handles retain the current compatibility path and its existing errors.

Within a receipt commit, the deferred transaction, internal authority resolution and every SQL read/write use the same captured handle. Do not fall back to a different current handle after a failure or await. Keep owner/epoch/expiry, running status, reference purpose, knowledge stage, cancellation, exact frozen content, deterministic document ID/content/state and existing receipt idempotency/conflict checks. A database parameter is not an execution grant or a renderer-accessible capability; callers still enforce canonical runtime/session/lifetime authorization.

The existing `kb:import-reference-text` handler captures the admitted current native handle before its first await and supplies it for both repository calls. Its current project-session, storage preflight and `withLegacyProjectOperation` wrapper remain unchanged. Actual multi-runtime legacy admission must still refuse before calling the loader. The KB loader's own current-resource assumptions are not bypassed; no active-view pointer is temporarily switched to execute background work.

## Verification And Failure

Use recoverable fictional canonical projects and real native SQLite. Keep A and B handles open, intentionally use the same run ID/owner/epoch with different frozen content, make B current, and prove explicit A authority/commit/replay affects only A while the default branch still reads B. Invalid A owner/epoch/expiry/cancellation/status/stage/source or document/receipt must refuse without using valid B as a fallback or partially writing either project. Author-manuscript runs cannot obtain reference authority.

A registered-handler integration uses real project-access, runtime compatibility, preflight and repository boundaries; only Electron shell/configuration and the heavy KB loader are fictional test adapters. Successful/repeated document receipt, invalid returned document identity, loader failure and real multi-runtime refusal need distinct evidence. This is not actual vector import or Electron author-workflow evidence. Complete workflow migration still requires all production stages, cancellation/unknown/crash/partial-write recovery and actual isolated Electron execution separately for reference/import and imitation.

No schema or portable field changes, so no new migration or persistent-authority restoration is introduced. Rollback stops callers using the new internal parameter and retains the original compatibility protections; it does not delete reference documents, receipts, WAL/SHM, outbox or recovery history and never resends an unknown request.

Acceptance is bounded by [Stage 6A evidence](../plans/2026-11-07-creation-runtime-modernization/stage-6a-evidence.md): current native focus and 28-file impact reports, current static/source build and independent requirements/authority review. The complete IMPORT feature and global contract/storage gates remain open.

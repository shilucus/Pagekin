# Captured Reference Import Resources

Date: 2026-11-08. Status: accepted Stage 6B internal resource adaptation.

Sources: [F2 sections 4.2-4.5, 5.1 and 7.6](../plans/2026-11-07-creation-runtime-modernization/README.md), IMPORT-001/002, [ADR-0029](0029-project-runtime-resource-routing.md), [ADR-0031](0031-runtime-close-and-maintenance.md), [ADR-0035](0035-scheduled-generation-dispatch.md) and [ADR-0036](0036-captured-reference-import-receipts.md). Parent: `6d208dfbd92c69f6d90f2df0d5346ce991aaf926`.

## Scope And Non-Goals

Complete the internal reference-import resource dependency chain: import run/source/lease/checkpoint/effect repositories, reference KB authority/single-flight/document/vector operations, global/style/blueprint writers and their current receipt/character-sync proof. Trusted main callers supply captured resources instead of borrowing the subsequently active view. These parameters are not execution grants; runtime/session/task admission and physical lifetime remain caller responsibilities.

This stage does not introduce an import driver, new public IPC or UI, automatically continue a renderer workflow, relax legacy admission or enable background execution. It is preparation for the separately accepted main-owned complete knowledge/global/style/blueprints/refresh workflow. No new import purpose, imitation mode, persistent field/schema, dependency or plugin is introduced. IMPORT-001/002 remain incomplete.

## Captured Repository Contract

`CapturedImportRunContext` contains the trusted runtime's `database`, `canonicalRoot` and `projectId`. Reference run reads, immutable source paging, execution acquisition/renewal/cancellation, stage checkpoints, prepared/committed effects and final completion carry this context through their helper and downstream calls. The captured root also selects portable-history freeze checks. No helper may substitute the current project's database, identity or freeze sidecar after a failure or await.

New explicit context supports reference runs only. It does not grant author-manuscript/finalized import writes. Omitted context preserves legacy behavior, parameters, errors and protection; author-manuscript remains on its old guarded route. ADR-0036's fourth `now` and fifth database arguments remain compatible. Historical receipt reads do not acquire a fresh execution lease or become permission to publish a new effect.

Global-facts methods accept trailing `{ database, projectRoot, projectId }`; callers explicitly map the captured canonical root. Current identity/schema checks apply to that same root and database. New captured writes require modern character identity and stage proposals rather than adopt them. Captured historical legacy receipt proof uses the existing migration-free `CharacterRosterRepository.readCaptured(database)`; it cannot initialize a schema or silently fall back to legacy writes. Omitted-context name-only behavior stays unchanged. Blueprint commit/current operation and pending/read/complete character-sync methods use the same captured database, including their authoritative proposal/roster evidence. Previously committed blueprint work is reconciled rather than regenerated when only character synchronization remains.

## KB And Physical Lifetime

Reference KB work carries one captured database, canonical resource root and resource-liveness identity through loader wait, authority resolution, single-flight, migration/volume checks, embedding, document/chunk proof, committed marker and failure cleanup. Vector operations retain existing explicit-path and knowledge-source-gate APIs and the sole Lance opening entry. Do not switch the active view to route work.

Same-runtime authority takeover may share a matching physical flight under the existing source/model/options binding; a different native handle/runtime epoch cannot borrow a prior runtime's flight. Import owner/epoch/expiry/cancellation and resource liveness are distinct checks, both required after awaits and before effects. A work lease covers the entire physical Promise including cleanup; close/maintenance must not release A while that work still uses it. Preserve existing cancellation/partial-write recovery, ordinary embedding failure versus invalid-vector classification, full-text-only behavior and no unknown resend. No new concurrency, retry, provider fallback or abort policy is authorized by this internal parameter change.

## Generation Admission

Import generation authority and effect lookups use the captured database/context where the reference chain supplies it. Freeze the original owner/epoch when scheduling. Recheck the same import execution, purpose/stage/cancellation and frozen generation sources after queueing and at synchronous native reserve/dispatch-mark admission, retaining model, grant/epoch, maintenance, physical request/time/output and unknown protections. Existing ordinal replay reads its original receipt/task without dispatching a replacement request; historical output is not a new write grant.

## Evidence And Rollback

Required evidence is real fictional A/B native databases and actual Lance reference import, B current while captured A completes, deliberately colliding run/operation IDs, unchanged B, same-database transactions and current/superseded receipts, rollback, lease/cancel/takeover/reopen/portable freeze and late physical completion. Domain evidence must show character proposals, not automatic author adoption. Compatibility tests retain omitted-parameter author and legacy paths. Current typecheck/lint/i18n/build and independent requirements/authority review are separate gates; until executed they are not pass claims.

The accepted internal slice's [actual evidence](../plans/2026-11-07-creation-runtime-modernization/stage-6b-evidence.md) records current eight-file 86/86 focus and 42-file 1114/1114 impact, zero failed/pending, current static/source build and two independent reviews. A mixed-entry physical-flight race and stale-lease reopen fixture were repaired and retested without weakening admission. The earlier failed report remains retained; this acceptance grants no complete IMPORT or background execution qualification.

No new durable fields means no migration or new portable execution right. Existing receipt/ledger conservation and excluded owner/epoch/lease portable authority remain unchanged. Rollback stops new captured callers, drains retained work and keeps old guarded entry points; do not delete reference documents, receipts, WAL/SHM, outbox or recovery history. Complete IMPORT acceptance still needs the actual main-owned all-stage workflow, separate deconstruction/imitation evidence and isolated Electron execution, not only these internal adapters.

# Persistent Prepared Chapter Driver

Date: 2026-11-07. Status: accepted on 2026-11-08 for the DRIVER-001 package only. Current deterministic, isolated Electron and two independent review records are in [Stage 4A evidence](../plans/2026-11-07-creation-runtime-modernization/stage-4a-evidence.md). This does not accept DRIVER-002 or future packages' gates.

Sources: [F2 sections 4.2, 4.3, 7.5, 7.6 and 7.8](../plans/2026-11-07-creation-runtime-modernization/README.md), DRIVER-001/002, [ADR-0029](0029-project-runtime-resource-routing.md), [ADR-0030](0030-runtime-feedback-grants.md), [ADR-0031](0031-runtime-close-and-maintenance.md), and the existing generation/material/draft receipt contracts.

## Package Boundary

DRIVER-001 introduces one real internal template, `prepared-first-chapter-v1`. A prepared first chapter with no selected candidate/finalized predecessor executes short outline, draft using that exact outline, visible composition, and authoritative draft commit. Its durable endpoint is `waiting_review`: a saved draft awaiting the author, not a machine review, finalization, adoption or human approval. There is no approve IPC.

The existing material assembly, source/knowledge, model, writing Skill, writing-language and minimum-word contracts remain mandatory. Unsupported prior-prose dependencies are rejected, not silently skipped. The template does not replace the current renderer writer or promise production equivalence. DRIVER-002 must migrate the complete existing planning-to-batch-draft, machine-review and author-wait workflow, including applicable reconciliation, continuation, condense and repetition behavior. No new layout, copy, control or visible state is introduced here.

## Authority And Lifetime

Only the existing desktop main broker owns execution. Its native-database owner map admits either the legacy view-bound owner, the narrow feedback authority, or the workflow driver authority, never a second writable generation owner. An idle handoff checks retirement and preserves the old owner on failure. A task row, history receipt, exported command ID or renderer reference is not a bearer capability.

Version-1 IPC is a literal closed set: prepare-context, start, read-receipt, pause, cancel, resume, reauthorize and read-history. Preparation, start, reauthorization and history require a fresh exact project view session. Execution/control uses a private issuance bound to the actual sender object, runtime, canonical root, native database, execution epoch, task, revision and declared first-chapter action. It cannot upgrade an old UI lease or execute generic generation/Agent/import actions. Native COMMIT precedes publication of any new issuance.

Changing or detaching a view does not end an already-issued task. Sender destruction prevents new steps and requests pause/convergence. True close seals new work and requests convergence before waiting for the actual engine and physical transport. A work lease spans asynchronous knowledge verification, provider execution and effect processing until the real runner's finally, not only the short start handler. Logical pause/cancel or an unknown result does not release a still-active physical request.

Every dispatch and domain effect rechecks the current issuance/revision, captured resources, source/model/Skill binding and relevant knowledge-source gate. The final reserve/dispatch admission is inside the native transaction. Existing request-count, elapsed-time, output and context-error protections remain; no input-token or cumulative-liability refusal is added contrary to ADR-0023.

Only new driver owners opt source capture into `freezeWritingLanguage`. Main reads the actual project language into that frozen manifest; recipe and any budget-demand language must agree, and new live work checks the current project language again. Unmarked legacy manifests remain unchanged on rebuild, preserving their existing strict recovery comparison. Historical migration validation uses the original frozen language rather than rewriting history after an author changes the project setting.

## Durable Inputs And State

The central desktop registry alone registers M12 after its schema-12 predecessor. Migration creates tables, constraints and indexes only: no old run is scanned, granted, started or repaired into success.

Before execution, one native transaction persists the task and all four stable step IDs/command IDs. Model invocation nonces are independently random and persisted; they are not derived from exported historical IDs. The complete recipe is persisted before any effect, not merely its hash. Each step freezes its exact normalized input and hash before its effect. Conflicting input under a stable command is rejected.

The recipe is the closed version-1 object `{schemaVersion, writingLanguage, outlineTask, baseDraftTask}`. Model inputs use `{kind:'model', task}`; composition inputs contain only artifact IDs, the existing draft-visible algorithm and expected content hash; draft inputs contain chapter number and expected composition hash. Semantic tasks are recursively closed through messages, demand and protected prompt sections. No physical plan, credential, model lease, handle, epoch or execution nonce can enter this JSON structure. Manuscript text is preserved as authored, not heuristically stripped.

Task states are `ready`, `paused`, `blocked`, `cancelled`, and `waiting_review`. They describe driver control, not physical transport termination. A pause/cancel and a new effect use the same immediate native transaction barrier. A committed fact is retained when cancellation wins only afterward. Failure retains task, steps, inputs, receipts and diagnostics.

## Effect Catalog

| Step | Existing owner / stable identity | Source CAS / receipt query | Recovery rule |
| --- | --- | --- | --- |
| outline | Main generation owner; task run plus persisted independent invocation nonce | Frozen prepared material, current source/model/Skill and final dispatch admission; exact invocation/attempt receipt and artifact | Reuse a proven complete stop output; never mint a replacement nonce to guess an unknown delivery. |
| draft | Same owner/run; second independent persisted nonce and frozen task containing the actual outline block | Same source admission and exact task/request identity; exact invocation/attempt receipt and artifact | Preserve unknown usage accounting separately from output completion. Truncation, failed/unsaved output and unknown delivery cannot become a saved draft. |
| compose | Existing generation composition writer; persisted command and run, ordered artifact IDs, existing algorithm and text hash | Current task/source barrier; exact `readVisibleComposition(runId)` and original attempt association | Existing identical composition only fills the reference; conflicting composition blocks. |
| commit | Existing `GenerationDraftEffects`; persisted command maps to run/chapter/composition hash | Existing source CAS and `readCommit/readRecovery(runId)`; authoritative draft and original receipt share their native transaction | Lost ACK queries the original receipt and only fills its reference. Changed author prose is not absence and must not be overwritten or regenerated. |

The new effects table stores references, not duplicate result/success JSON or a second draft fact. Model requests are never held inside a synchronous SQL transaction. Synchronous composition/draft effect callbacks reject thenables. A crash after domain COMMIT but before ledger ACK reconciles by this fixed catalog, including when the run no longer appears in an unfinished-recovery list. Reading history cannot dispatch, commit, approve, clear failure or revive cancelled work.

`attempt.status=unknown` can mean untrusted usage even with a known complete output. Completion additionally requires actual finish reason, failure/tail/cancellation evidence and artifact identity/hash; billing uncertainty is not silently made trusted. A true unknown physical delivery remains blocked with zero resend. Restart does not reconstruct old process capabilities. Explicit fresh author authorization is required to continue an original project, after rechecking its original source/model/Skill binding; committed effects are reconciled before considering any new effect.

## Portable Classification

| Table | Historical H | Restricted R | Excluded X |
| --- | --- | --- | --- |
| workflow_tasks | task_id, project_id, template, run_id, revision, state, blocked_code, recipe_hash, created_at, updated_at | recipe_json | operation_key, request_hash |
| workflow_steps | step_id, task_id, ordinal, kind, command_id, input_hash | input_json | invocation_nonce |
| workflow_effects | step_id, receipt_kind, receipt_attempt_id, content_hash, acknowledged_at | none | none |

H content hashes cover only the exact allowed canonical R projection/content, never a digest of excluded authority. Export replaces operation keys with collision-safe historical labels and clears request hashes/nonces; it retains neither original X values nor their digests. Required JSON projectors use the same shared parsers for the database and freeze sidecar. Unknown fields fail closed before source modification.

Every copied task, step and effect is frozen, regardless of its old state. The original project ID remains historical provenance, not current-project permission. A new copy cannot continue an original task or approve a wait; a new author action needs new task/run/command/nonces. A second export/restore must retain readable recipe, inputs, receipts and prose without reconstructing authority. Old schema-12 normal/donor identities and archives are captured from immutable parent source, not inferred from a new registry generating its own predecessor.

Frozen history has a separate read-only projection, not executable artifact hydration. Allowed partial prose is returned as `historicalArtifacts`; a composition additionally requires the original compose input, matching draft/compose effect references and actual content hashes. Portable export excludes the original draft-commit machine receipt, so a historical commit does not prove the current draft ID/body: it returns `draftSave: {kind:'changed'}` with `draftSaveProof: 'unavailable'`. This is absence of current-save proof, not a claim that the author edited the copied prose. Normal live hydration and all execution guards remain strict.

## Verification And Rollback

Required evidence covers exact caller/runtime/native/epoch isolation, prepare COMMIT failure, same-key conflict, stable inputs/nonces, each COMMIT-to-ACK gap, changed draft, pause/cancel races, ignored abort/late response, source/model/Skill/knowledge change, original reauthorization, two portable generations, migration conservation and actual isolated Electron execution after view detachment and resubscription. Static review and synthetic provider execution are not real-model quality, author-workflow UI or target-platform qualification.

Rollback stops accepting new tasks, pauses and drains admitted work, and preserves all task/step/effect/domain facts. It cannot delete history, remove remaining protections, resend unknown requests or roll back a committed draft to make the ledger appear clean.

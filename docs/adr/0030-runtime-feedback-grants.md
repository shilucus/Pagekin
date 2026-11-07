# Narrow runtime feedback grants and revocation

Date: 2026-11-07. Status: accepted for this package after independent requirements/authority and storage/owner review of the frozen implementation, 1177/1177 deterministic tests and isolated Electron evidence. See [Stage 3B evidence](../plans/2026-11-07-creation-runtime-modernization/stage-3b-evidence.md). RUNTIME-002 is complete within this narrow capability contract; no generic background workflow is qualified.

Sources: [F2 sections 4.5 and 7.8](../plans/2026-11-07-creation-runtime-modernization/README.md), RUNTIME-002, [ADR-0029](0029-project-runtime-resource-routing.md), [ADR-0026](0026-planning-feedback-candidates-and-adoption.md) and [ADR-0028](0028-desktop-planning-feedback-ipc.md).

## Scope And Identity

The first producer is one author-requested feedback revision of an original eight-field planning target. It creates only a candidate. It does not adopt, relineage, edit formal planning, generate a chapter range, finalize, install a Skill, grant general model/API access or approve a delivery. Existing v1 planning feedback and other legacy channels keep their current-view authorization.

New literal versioned runtime-feedback channels separate author prepare from execution and restricted receipt reading. Prepare requires a fresh current-view session. Main freezes the actual base, optional parent, instructions, model and installed planning Skill through the existing main-owned feedback proof. A caller-provided operation UUID is an idempotency key, not authority; a different normalized payload under that key is rejected. Returning an existing or restored durable record does not reissue execution capability.

The wire separates `prepare` and current-view `read-history` from capability-owned `execute`, `revoke` and `read-receipt`. Capability ownership is distinct from executability: the original caller may read its completed/revoked receipt without regaining execution authority. Repeated terminal execute returns that receipt without dispatch or staging; repeated revoke does not advance revision or cancel again. A completed candidate remains completed. Same-key prepare can replay only the same process-local issuance, otherwise it returns history without a new capability. Model comparison uses the first issuance's frozen model identity, never a reinterpretation through current configuration.

Execution authority is a main-only process-local capability bound to the exact registered runtime, native database identity, execution epoch, caller, grant ID and revision. Durable grant rows preserve scope, decision source and receipts but contain no bearer capability, native identity, UI lease, credentials or runtime epoch. Restart, true close/reopen, another project and a portable new copy cannot reconstruct the old capability. Viewing another retained runtime is not revocation and does not rotate the task's execution epoch.

The closed `runtime-feedback:v1:revoke-many` channel accepts one explicit nonempty, dense list of at most 128 distinct project/grant references. This is a per-IPC resource bound, not permission to revoke other grants. It serially attempts every reference with the same caller and original per-project transaction barrier, groups fence results by project, and reports `completeForRequestedScope` only when every submitted reference is fenced. A failed, unavailable or unauthorized reference has a sanitized error code, no receipt and a false fence; it does not suppress later projects or undo earlier revocations. A completed candidate is already terminal and is retained. There is no cross-database atomicity claim, implicit retry, global-completion claim, new capability or UI workflow.

## Single Owner And Lifecycle

One native database has one generation owner entry in explicit legacy or runtime-feedback mode. Legacy mode keeps its captured UI lease. Runtime-feedback mode has only the narrow producer facade and exact resource identity; it cannot make legacy helpers background-authorized.

Mode handoff is synchronous and requires no active handler, physical/pending request, unsaved tail or live grant claim. Retire succeeds before replacing the map entry; refusal retains the old owner and its buffers. Ordinary handoff and runtime-feedback construction do not run whole-database interrupted-run recovery. Real project close/startup recovery remains separate and preserves its existing safeguards.

Handoff first checks the existing entry, constructs an unpublished replacement with recovery disabled, then retires the old owner and synchronously replaces its map entry. Replacement-construction failure leaves the original entry untouched; retirement failure disposes the unpublished replacement without interrupted-run recovery. Only the published entry is available to callers.

Prepare publishes nothing before native COMMIT. Successful COMMIT is immediately followed by synchronous issuance/capability/claim publication, with no intervening await or reentrant callback; only then may it return. Transaction failure leaves no live claim or usable capability. Lost replies reuse the retained issuance, not a capability reconstructed from a row. Sender destruction revokes only grants actually transitioning active to revoked at the same project barrier and logically cancels those requests once; completed/repeatedly revoked rows are not cancelled. No new sender inherits the old capability, and physical/tail cleanup continues to fence retirement.

Terminal receipt ownership outlives idle generation-owner mode handoff, up to true runtime close. It is kept separately from the active owner entry; a retired facade can only return its terminal receipt, never prepare or dispatch. If sender-destroy revocation storage fails, the destroyed caller immediately fails in-memory admission, main best-effort cancels only its already-authorized attempt (abort still occurs if ledger cancellation fails), and retains the unresolved claim/error. A later mode-handoff or true-close boundary retries only native revocation, not the model request. No durable revocation success is reported until commit; normal and exceptional cleanup request logical cancellation at most once per issuance.

Durable grant-run bindings also fence legacy execute/resume/restart/stage paths after a mode change. Checking only the current mode is insufficient. A restricted receipt read never constructs an owner, resumes a run, installs a model lease or dispatches a request.

## Dispatch, Effect And Revoke

The producer uses one run and the existing fixed `planning-feedback:0` attempt nonce. Existing attempts and unknown outcomes are read, never automatically resumed or reissued. Model/source/Skill freezing, physical-request/activity/output brakes and the original structured output proof remain in effect.

Grant scope/revision, exact runtime/native identity, lifecycle/maintenance state and the existing source/model/Skill/cancellation checks are repeated after asynchronous preparation and at native SQLite reserve/dispatch admission. No renderer-supplied hash or execution marker substitutes for them.

New producer admission and candidate effect combine the existing host lifecycle-availability and exact-open-resource checks, including legacy-operation and restore locks. This additional admission check is not applied to receipt reads, revocation/cancellation or settlement of an already-dispatched attempt. A response arriving under a maintenance lock may retain its accounting/artifact, but cannot create a candidate or silently retry after the lock clears.

Final admission, reserve and mark-dispatched share one native transaction. From its return to actual provider start there is no await or reentrant external callback. Any pre-dispatch source/model/Skill/authorization denial makes zero provider calls. Cleanup permission is frozen for that admitted attempt, not inherited from the current call stack or from a subsequently revoked capability.

Candidate staging still validates the original persisted feedback task, actual attempt/artifact and current-source CAS. Staging and grant completion/candidate receipt share one native transaction. Revoke uses the same project's immediate transaction barrier: a candidate committed first remains an immutable fact; revoke committed first prevents a new candidate. A revoked grant cannot start a new attempt, model request or formal effect.

Before dispatch, the grant permits only bounded system convergence of that already-authorized attempt: accounting settlement, retained artifact tail, snapshots and call statistics. This is not candidate staging or adoption authority. Cancellation cannot release a still-running physical request. Grant denial is an authorization result, not `GENERATION_STORAGE_FAILED`; storage failures and unsaved-tail protections retain their existing meaning.

## Persistence And Rollback

One dedicated grant table has fifteen scalar fields: `grant_id`, `operation_key`, `project_id`, `revision`, `action`, `target`, `base_id`, `parent_candidate_id`, `run_id`, `request_hash`, `state`, `candidate_id`, `decision_source`, `created_at` and `revoked_at`. Main generates the historical `grant_id`; it is not the client idempotency key. Fourteen fields are historical `H`; `operation_key` is excluded `X` with explicit stable history-key rewriting, containing neither its original value nor its digest/MAC. Existing policy `P` means validated relative path and is not used here.

The historical request hash covers only canonical fixed-order `{schemaVersion:1, projectId, target, baseId, parentCandidateId, feedback, constraints}`. Missing parent becomes null; instructions and constraint order/strings are preserved without trimming or sorting. It excludes operation key, caller/machine identity, model/source/Skill mixed fingerprints and capability material. The first issuance's model identity is checked separately. A restart history read does not rebuild an owner or lease to make that comparison.

Central desktop migration registration is the only schema-version source. Strict portable field/table coverage remains mandatory; older supported archives remain readable and new copies retain only frozen history, never original execution or approval rights.

Rollback disables new issuance and revokes/drains eligible work without deleting history, resending unknown requests or undoing committed candidates. No real user database/profile, model or platform installation is used for development acceptance.

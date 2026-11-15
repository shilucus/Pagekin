# Runtime Close And Maintenance Barriers

Date: 2026-11-07. Status: accepted for the RUNTIME-003 package after integrated deterministic/Electron execution and independent review; see [frozen evidence](../plans/2026-11-07-creation-runtime-modernization/stage-3c-evidence.md).

Sources: [F2 sections 4.3, 4.4 and 7.8](../plans/2026-11-07-creation-runtime-modernization/README.md), RUNTIME-003, [ADR-0029](0029-project-runtime-resource-routing.md) and [ADR-0030](0030-runtime-feedback-grants.md).

## Admission And Resource Lifetime

The desktop main-process runtime host remains the only broker and canonical-project writer. Viewing another book does not close a retained runtime. No second CLI/headless writer is admitted without the separately required OS exclusion and durable fencing contract.

Resource validity and new-work admission are separate checks. A close intent or maintenance lease denies new tasks, dispatch and domain effects for its captured runtime, but does not revoke permission to read an existing receipt, cancel an owned request or settle an already-admitted transport. Native identity, canonical root, execution epoch and exact registered handle checks remain mandatory.

## True Close

True close synchronously seals new work before calling synchronous owner quiescence hooks. Quiescence flushes and requests cancellation/pause of already-owned work without closing its model leases or database. Actual handler and physical transport lifetimes, not logical task status, determine whether release is safe. Final close flushes the owner, releases KB resources and only then closes the native database. It never deletes an outbox, WAL/SHM, unsaved tail or recovery diagnostic to force progress.

The host waits at most 5 seconds by default. This is a local responsiveness bound, not evidence of remote cancellation. Timeout, flush failure or unresolved transport retains the fence and captured resources. An explicit close retry may finish convergence; it cannot resume or resend an unknown attempt. Application close seals every runtime and new host opens before waiting, and only approves native window/app exit after all captured runtimes close. Existing renderer unsaved-buffer decisions remain in force and a failed close does not discard buffers.

An already approved native-window close may encounter physical current-view
operations before the host can seal. Only the exact
`PROJECT_RUNTIME_VIEW_OPERATION_BUSY` refusal enters the existing bounded
captured-view drain; other failures retain the original close/retry path.
The last physical release synchronously rechecks the same window, pending
close intent, current view and project session before invoking the original
close-all admission. That synchronous invocation seals all runtimes before
new work can enter; its actual close Promise is awaited outside the drain
callback. This wait is not model, parent-run or projection-ACK convergence,
does not auto-approve renderer decisions, and cannot release a live operation.
View/session changes and drain timeout leave the window open and retryable.
An already sealed close retry calls close-all directly, never the ordinary
work-admission drain helper. A quit received while merely waiting records the
latest shutdown intent; a quit after actual close admission upgrades the
existing close operation directly. Individual runtime close and other busy
admission guards are unchanged. This extends native-window coordination only;
it introduces no new visible control or execution authority.

Already-confirmed global Agent effects also have an actual main-process lifetime. Application-operation leases cover the real awaited Skill inspection/installation and MCP handler work independently of a renderer or active view. They conservatively block native release and maintenance, but not ordinary work in an unrelated open book. Close-all waits for them even when no project is open. Synchronous Skill mutations check the same application seal; existing inspection/confirmation and filesystem validation remain mandatory.

An MCP foreground timeout is not evidence that its tool stopped. A dispatched tool retains its exact process/request tracking after timeout or transport loss. Only a matching late protocol response or an observed local executor exit ends that local tracking; issuing `kill()` or persisting an Agent `unknown` state does not. This does not prove cancellation or reversal of an external effect. The version-1 MCP call result carries the existing `not_committed/committed/unknown` distinction through the Agent adapter without creating a new confirmation or retry permission. Shutdown does not automatically disconnect or kill tools to manufacture drain success.

An already-returned Agent claim is not permission for a delayed first effect after project close. For the existing GitHub Skill inspection/installation and MCP tools, a successful claim issues a process-local, single-use version-1 execution token bound to its exact sender, captured runtime/native identity/epoch, active claim and frozen tool arguments. The production Agent context carries it outside model arguments. Actual handlers recheck it synchronously and acquire project-work and application-operation leases before sending; MCP retains both through its physical request tombstone. Close, terminal finish and sender destruction revoke unstarted tokens, never an admitted effect's actual lifetime. Invalid admission cannot mutate another caller's inspection cache. Historical or portable receipts cannot reconstruct these tokens.

The existing application settings routes retain their explicit author-global semantics without an Agent envelope. The Agent adapters must fail before IPC if a hosted action has no execution token. This closes the delayed production Agent race, but does not claim that an already privileged malicious renderer cannot impersonate an independent application-settings caller; no new renderer trust isolation is introduced.

## Maintenance

An opaque process-local maintenance lease reserves one canonical root. Acquisition rejects an active writer, admitted operation, pending open or physical request rather than cancelling it. The target cannot admit new writes or an alias open while leased; an unrelated already-open book keeps its own admission contract.

Backup holds the lease over the existing consistent SQLite and asset snapshot, including WAL-aware backup semantics. Deletion may close its captured native handle through the lease while retaining the canonical path reservation through the awaited directory mutation. Removing a runtime entry does not remove that reservation. A failed deletion must not replace an unrelated active-view winner when recovering the original project.

Isolated-copy restore retains grant, physical-path containment, identity and portable frozen-history checks. Its conservative global mutation barrier refuses active writers and maintenance reservations. Target overlap checks include both open runtimes and retained canonical reservations. Migration through project open remains in the same broker's ticket and identity discipline; it is not permission to mutate a second copy of an active canonical project.

## Persistence And Failure

Close intents, admitted-operation counts and maintenance leases are process-local and are not exported as authority. Existing domain transactions, receipts, candidate adoption and finalization/outbox contracts do not change. A process restart or portable new copy cannot reconstruct old execution grants. Failure retains historical facts and diagnosable resources; rollback disables new work and preserves the existing close/unsaved protections.

### Retained Tail Escrow

Independent review found that a storage-failed visible tail could permanently block close after its sender was destroyed, and that ordinary/Agent tails cannot be covered by an original-caller-only feedback disposal API. No such new disposal IPC is introduced. The bounded system-convergence authority for an already-dispatched request instead permits preserving its exact held tail as non-executable history in the same captured database.

`generation_recovery_tails` has seven historical `H` fields: `attempt_id`, `artifact_id`, `durable_revision`, `prefix_hash`, `tail_text`, `tail_hash` and `preserved_at`. The first two reference the existing attempt/artifact identity map. Hashes cover content only; there are no capabilities, epochs, model credentials, client keys or executable commands. The central registry alone owns the new schema version. Strict portable classification, reference projection, frozen new-copy reads and a second export are required before this increment can pass.

Only the service holding the actual in-memory tail can request preservation. The native transaction verifies attempt/artifact/run linkage, original captured resources, terminal attempt, actual durable prefix revision/hash and exact tail content. An existing identical escrow is idempotent; different content conflicts. Snapshot commit with a lost response is handled only when the next durable revision can be proved to contain exactly the old hash-verified prefix plus the held suffix. No duplicate suffix is appended and no terminal artifact is rewritten.

The service releases a matching memory tail only after native COMMIT proves preservation (or proves that exact text already durable). Failure, conflict or an unproven prefix retains the tail and close fence; an old candidate-discard call cannot bypass this close protection. Independent tail transactions may partially succeed, but cannot clear another failed tail. Escrow is distinguished from a full or successful model result, never staged/adopted automatically, and never resumes an unknown attempt. Authorized read-only interfaces distinguish durable prefix from suffix in the original project and a portable new copy. Existing author UI does not yet render this new history field; new presentation remains behind F2 section 6.3 design evidence and is not claimed by this internal increment. Tail text is sensitive manuscript history and is excluded from logs/diagnostics/telemetry.

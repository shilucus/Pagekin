# Separate project runtime resources from the current view lease

Date: 2026-11-07. Status: accepted for RUNTIME-001 resource routing after independent three-criterion acceptance review and isolated registered-IPC execution. This is not background-execution or complete workflow qualification. Evidence: [Stage 3A](../plans/2026-11-07-creation-runtime-modernization/stage-3a-evidence.md).

Sources: [F2 sections 4.1-4.5](../plans/2026-11-07-creation-runtime-modernization/README.md), RUNTIME-001 and [ADR-0001](0001-project-root-and-session-lease.md). This decision replaces only ADR-0001's implicit single-current-resource ownership. Its canonical root, project identity, fresh UI lease and main-process authorization requirements remain mandatory.

## Resource And View Identity

The single desktop host owns registered `ProjectRuntime` instances. Each captures verified project ID, canonical root, storage root, one native SQLite handle, an opaque native-instance identity, an in-memory execution epoch and opening/open/closing/closed state. A DB/WAL content hash is only the existing open-time TOCTOU check; legal writes change that hash, so it is not a runtime identity.

Only host-issued opaque prepare tickets can commit or abort an open. A failed or superseded B open closes only its new uncommitted handle, never reopens, fences or closes A. If no newer view committed, the original A view and lease stay unchanged. If C already won, B cleanup leaves C's runtime and lease unchanged; it never restores A's obsolete lease. An aborted reused ticket does not close an existing runtime. Aliases resolve to the same canonical registration; a closing instance cannot be reused or replaced by a second writable handle.

Viewing an existing runtime reuses its DB and epoch but always issues a fresh UI lease. True close/reopen gets a new native identity and epoch. `project-runtime:v1:open-view` is the explicit retained-view entry. It uses the same main-owned recent reference or project-open directory grant as ordinary open, not a current UI lease; it introduces no execution grant. The preload admits only this literal in the new namespace. Successful admission marks that runtime retained in process memory until actual close; failed preparation or COMMIT does not mark it.

The old `project:open` remains a single-book compatibility switch so the existing UI does not create an unusable multi-runtime legacy state. It requires zero runtimes, or exactly one current open, non-retained, idle runtime with no pending prepare or legacy/restore operation. Before target side effects it refuses busy, closing and explicit retained resources. Its opaque prepare ticket captures the previous runtime and holds a lifecycle barrier through COMMIT, fresh view/session publication and release of only that captured previous runtime. Same-canonical viewing rotates the lease without closing or refencing the runtime. No old renderer lease becomes a background grant. The active-view pointer exists only for classified compatibility entrypoints, never as a temporary task-routing mechanism.

## Routing And Compatibility

Project create/open and basic editing capture explicit runtime resources. Generation admission, frozen sources, physical request settlement and draft effects keep the same captured DB/root. Resource liveness and execution authorization are separate checks: Stage 3A retains the existing current-view lease authorization. The existing generation handle/binding epoch remains the captured UI lease, as required by its transport and explicit resume contract; it is not silently replaced with the runtime resource epoch. This package does not implement grants, grant revisions, a headless owner or permission to dispatch after switching away.

Every unadapted current-project entry is classified in the [Stage 3A matrix](../plans/2026-11-07-creation-runtime-modernization/stage-3a-runtime-compatibility.md). It either uses an explicit reviewed adapter or refuses coexistence before its first side effect. A legacy asynchronous operation admitted with one runtime holds an interlock until it settles; opening, activating or closing a runtime cannot change its global compatibility resources during that interval. Multi-runtime legacy admission fails closed. Unknown entries do not inherit permission from a shared prefix.

Ordinary single-book switching must retain the complete existing author workflow, not just the first file-tree/role/draft reads. The retained IPC scenario separately proves isolation and refusal of unadapted entries; it does not stand in for the renderer open/load/save chain. Existing UI cancellation/wait protection stays in place. A retained or busy A is never silently released by the compatibility entry, even when it is the only remaining runtime.

Idle release rejects in-flight resource users before changing phase. After entering closing, synchronous owner flush/suspend and target KB close hooks run before native close and admission removal. Failures remain quarantined as closing and cannot be treated as a successful release or reopened under a second owner. General drain, maintenance coordination and grant revocation remain RUNTIME-002/003 work.

## Managed Background View Switch (2026-11-15)

F2 sections4.4/13.3 and [ADR-0080](0080-main-owned-foreground-reference-whole-run.md)
extend the author open adapter for an actually admitted reference run. The exact
`project-runtime:v1:open-background-view` literal uses the existing target-open
grant, not a current UI lease or an execution grant. It manages its view-retention
policy separately from raw `open-view`; the raw retained-until-close contract and
ordinary `project:open` compatibility refusal above are unchanged.

Only after a target successfully commits and publishes its fresh view may this
adapter release inactive, idle, managed previous views. A failed preparation or
target transaction never closes another runtime. The actual current view, raw
explicit retained runtimes, pending tickets, physical resource users and active
owner/receipt/tool claims are not cleanup candidates. Native identity, canonical
root, runtime phase and lifecycle/maintenance/restore barriers remain mandatory.
Retirement guards are synchronous and read-only: active or unresolved claims,
including unknown work and cleanup debt, retain the runtime; unexpected failures
remain errors. Preparing retirement, cancelling, revoking, reissuing or discarding
unstarted authority is not a way to manufacture an idle resource.

This reconciliation runs only at the authorized open lifecycle boundary, not in
legacy-operation admission or a background work-release callback. Release hooks
still perform the actual close, and close failures retain quarantine and the
existing post-COMMIT partial-failure semantics. The main response's required
`backgroundViewsRetained` reports the actual remaining retention state; the
renderer uses it only to choose the next open adapter. It is neither authority
nor a promise that all background work completed. Once managed retained work
and claims have settled and old views actually close, subsequent ordinary
single-book compatibility operations are available again.

Current-view FS and explicitly classified DB reads use the actual view runtime
and hold lifecycle interlocks through physical completion. They do not borrow
another runtime's resources or enable unadapted generation/domain writers.
An explicit managed background-view open may wait for those already admitted
physical view operations to drain. The last release synchronously revalidates
the captured current view, native/canonical identity, latest open request and
target admission, then acquires the original prepared-open ticket before new
view operations can enter. No model, projection ACK or background execution
claim is part of this wait. The existing five-second bounded UI drain timeout
rejects only the waiting open; it neither releases physical work nor cancels,
closes or changes the current book. Callback failures reject their waiter and
cannot turn an already finished physical operation into a failure. Revoked
grants, superseded opens and changed identities retain their existing refusal.
The native-window close coordinator may use that same drain only after the
exact unsealed view-operation busy refusal, rechecking its original approved
intent and current session before synchronously starting close-all. Existing
sealed-close retry and shutdown-upgrade semantics remain direct close-all
operations, not ordinary work admission; see [ADR-0031](0031-runtime-close-and-maintenance.md).
For dialog-selected targets, the first directory preflight is non-consuming;
after drain, the original resolver rechecks scope, sender, lifetime and native
root identity and consumes exactly one use. Ordinary and raw retained opens
keep their original consumption path. Non-consuming preflight is not execution
authority and cannot replace the final resolver or renew an expired grant.
The background legacy-format handoff also consumes that original directory
grant exactly once before issuing the separate legacy-import grant; it cannot
skip consumption because ordinary managed-view preparation is not reached.

The precisely classified `db:recovery-candidate-list` remains an actual-current-
view repository read, not candidate recording, updating or resolution. The
existing `db:revision-list`, `db:revision-get-pending` and `db:review-list`
SELECT readers use the same captured current-view boundary so returning to a
retained book can display its actual chapter facts. Their directly used
`db:revision-get-full`, `db:review-get-full` and `db:review-cycle-get` readers
also remain SELECT/validation projections under that same boundary.
Revision/review mutations keep their original admission; a read adapter does
not grant review or merge. The existing generation recovery-list entry may
similarly wait for current-view
physical operations before its synchronous legacy-owner initialization or
handoff, with caller/session/runtime validation repeated at that boundary.
It still runs the original owner admission and non-view busy checks. Recovery
or exceptional budget-poison writes are not reclassified as pure reads, and a
reference owner's existing current-view read branch never waits for its own
background work or grants a new writer.

Acceptance includes A busy while B-to-C releases idle B, settled A followed by
ordinary single-book use, claim/unknown retention, failed-target preservation,
close quarantine and physical view-operation barriers. This bounded adapter is
not multi-book task scheduling, full import recovery or platform qualification.

## Persistence And Rollback

No schema, manifest/storage version, persistent grant or archive field is introduced. Verified handle preparation can perform the existing schema migration and WAL setup; aborting an open is not a rollback of those storage admission steps. It must not run import-owner fencing or the controller's domain repairs early. First successful view commit places continuity adoption, required core initialization, duplicate-finalization repair and first fencing in one native SQLite transaction. All fallible session probes happen before publication; only after SQLite COMMIT succeeds are the runtime/view/session pointers published without further I/O. A failed transaction leaves its ticket abortable and does not restore an obsolete view lease. The recent-project file is separate metadata, not a cross-store transaction or authority source.

Closing the previous idle A is not atomic with B's SQLite COMMIT. A compatibility switch publishes B's committed view and fresh session before attempting that close, within the same synchronous barrier. If the close fails, B's facts stay committed and A keeps its actual failure phase (closing once release began). `PROJECT_RUNTIME_PREVIOUS_CLOSE_FAILED` is a partial failure, never a rollback claim: the controller returns `success: false`, `databaseRestored: false`, and the actual active B path and native DB readiness. The renderer detaches its obsolete binding and preserves author buffers, including when reconciling an out-of-date response. It cannot reopen A with its obsolete lease, roll back B, abort the consumed ticket, or report the failed release as successful. Further incompatible legacy operations remain refused.

Existing generation receipt/unknown semantics remain. In-memory runtime/lease/epoch/retention identities are not exported into a portable copy. Existing portable authority freezing is unchanged; no old authority is reconstructed. A failed delete that actually closed and reopened the same target returns an optional `restoredSession`; the renderer can rebind only that precise current book to its fresh lease while retaining author buffers. Consecutive explicit delete recoveries retain an in-memory source-session lineage for existing ordinary exit-save handlers; an ordinary reopen, close or other-book switch ends that lineage. Planning recovery proofs, run handles, nonces and finalization snapshots are not rebound. This is not historical generation reauthorization. Refusal before close keeps the original lease and does not return a replacement.

Rollback disables the new routing entry, stops new work and safely releases idle resources while retaining existing switch/cancel/close protection. Do not delete WAL/SHM, candidates, outbox or diagnostic history, downgrade schema, or resend unknown physical requests.

Acceptance requires actual registered handlers and isolated fictional SQLite, including failed B open, latest-open races, alias/reuse versus true reopen, busy/failed close, stale/cross-runtime requests, late settlement and legacy interlocks. The Stage 3A registered-IPC Electron coexistence scenario and ordinary store/main integration passed within their documented scope. Background authorization, complete visible author workflows, literary quality and target-platform qualification remain separate uncompleted gates.

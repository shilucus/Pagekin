# Main-Process Scheduling Admission

Date: 2026-11-08. Status: accepted for the internal Stage 5A kernel only; not production SCHED-002 acceptance. Actual deterministic evidence and independent review: [Stage 5A](../plans/2026-11-07-creation-runtime-modernization/stage-5a-evidence.md).

Sources: [F2 sections 4.5 and 5.1/5.2](../plans/2026-11-07-creation-runtime-modernization/README.md), SCHED-002, [ADR-0033](0033-persistent-planned-batch-review-driver.md) and the existing read/write resource-claims and physical-generation-owner contracts. Parent: `66e1faf93c208e443f2535a5b8e55ac90504150f`.

## Scope

Stage 5A supplies a main-process-only, process-local kernel and deterministic tests. It does not connect production calls, create another execution owner, expose an IPC/API or UI, persist a queue, change the desktop schema, or grant a task permission. Existing production admission and concurrency remain unchanged until a separately verified integration increment. This avoids inventing a durable scheduling database before any such contract is needed.

## Resource And Transport Admission

Read/write conflicts reuse the existing shared claim semantics: readers may share, and writers conflict with readers and writers of the same resource in the same captured project. Normalize and sort a stable resource set before one synchronous all-or-none acquisition. Network admission and claims cannot be partially retained while waiting. A real external domain-claim release synchronously notifies the scheduler so a resource-only waiter does not depend on an unrelated transport finishing; duplicate release does not notify again, and close unsubscribes. No database transaction may await a queue slot.

Network policy explicitly supplies finite global, provider, credential, model, project, queue and quarantine bounds. The kernel does not invent permanent production defaults. Project rotation and within-lane FIFO prevent a long book from monopolizing a runnable queue. Interactive work can use an empty slot and receives a bounded next-slot opportunity when queued; a finite burst policy also gives background work an opportunity. Already dispatched work is not preempted or mislabeled as stopped.

Cancellation removes only an undispatched waiter. A granted transport permit is not released merely because the logical operation has cancelled, timed out or returned unknown. Only the caller's actual provider-finally/confirmed local-close boundary may finish it. Finishing twice, cancelling twice, closing and a late provider result must not release another operation's capacity or claims.

An uncooperative local transport may be explicitly parked in a finite quarantine with its ownership and resource claims retained. Physical occupancy is active plus quarantined, and every network dimension continues counting quarantined requests. The affected credential channel stops admitting new requests; exhausting quarantine stops new global admission. A full quarantine leaves another unresolved request active rather than releasing its permit. A late actual finish releases transport counts and claims but does not silently reopen the stopped channel: an explicit reset requires that credential to have no active or quarantined transport. Its opaque identity remains retained through that stopped state, preventing recapture from minting an unblocked identity. Close releases stopped identities only after their physical work has finished. Quarantine is not evidence that the request ended or that a remote provider did not execute it; no policy may repeatedly free capacity and refill around unresolved requests. A policy rollback to one preserves committed facts, unknown attempts and receipts.

## Opaque Subjects

Subjects come only from the main process's private frozen model snapshot, not profile IDs, lease UUIDs, renderer-supplied identifiers or an API key in a task/event/public request argument. Actual provider URL/header/model behavior determines grouping. Equivalent profiles for the same service and credential share the credential group even when the profile or remote model differs. The remote model group uses origin plus the unchanged model name, including across protocol aliases, so a protocol change cannot bypass its independent model limit. Returned group references are random opaque values; raw credentials, endpoints and their internal keyed indexes are not diagnostics or portable authority.

This unconnected registry explicitly rejects URL userinfo because existing adapters do not preserve it consistently. Production integration must reconcile that compatibility boundary against actual provider behavior before capture can gate existing calls; this internal slice is not evidence that all existing profile configurations are production-compatible.

The registry has explicit finite capacity and atomic capture failure. A live subject is proven by its private issuance, not structural resemblance. The scheduler retains its own reference from queue admission through physical completion or quarantine, independently of the capture caller's cleanup. Thus a caller's early release cannot remint a new group while an old transport still consumes its limit. Queued rejection/cancellation and actual finish release only their own references, idempotently. Subject grouping is not execution authorization.

## Required Production Integration

After all resources and transport slots are obtained, the production caller must recheck current grant/revision, epoch/close/maintenance, model lease, source fingerprint, cancellation, stage and original root budget. Only then may the existing native boundary reserve and mark dispatch atomically. Any intervening await requires revalidation. The kernel never refreshes a stale source, renews a lease, creates an attempt while queued, resets a budget, replaces a nonce, or retries unknown work.

All relevant UI/CLI/Agent generation and embedding/probe routes must share the actual main broker rather than self-reporting scheduling subjects or keeping independent locks. Existing domain writers and source/CAS checks remain. A complete SCHED-002 acceptance still requires the real two-book workflows, serial versus concurrency-two performance evidence, late/ignored-abort behavior, queue-time authority invalidation and isolated Electron runs. Pure kernel tests and source build cannot satisfy those gates.

## Verification And Rollback

Stage 5A requires deterministic identity/grouping, secret exclusion, capacity atomicity, cancellation handoff, fairness/FIFO, all-or-none claims, ignored-abort ownership, bounded quarantine/stop and late/repeated-release coverage plus independent review of the integrated current bytes. No storage migration or fake portable history is needed for this nonpersistent slice. If later integration introduces persistent fields, that package must first meet F2 section 7.8.

Rollback of this unconnected increment removes its consumers, if any, without changing a database or invoking a provider. Once production is connected, rollback must stop new work and drain or quarantine real transports while retaining receipts and committed facts; deleting queues, history or unknown evidence is not recovery.

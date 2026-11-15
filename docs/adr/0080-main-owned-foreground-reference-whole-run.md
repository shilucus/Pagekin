# ADR-0080: Main-Owned Foreground Reference Whole Run

Date: 2026-11-14. Status: accepted for the bounded foreground whole-run
composition after Stage88 source/runtime independent review. Full import and
background qualification remain open.

Sources: [F2 sections4.4-4.5](../plans/2026-11-07-creation-runtime-modernization/README.md),
[ADR0074](0074-main-owned-foreground-knowledge-driver.md),
[ADR0075](0075-main-owned-foreground-reference-style.md),
[ADR0076](0076-main-owned-foreground-reference-global.md),
[ADR0077](0077-main-owned-foreground-reference-blueprints.md) and
[ADR0078](0078-main-owned-foreground-reference-refresh.md).

## Bounded Ownership

The issued foreground reference path invokes one main-process coordinator for
knowledge, global, style, blueprints and refresh, in that order. Reuse each
existing private authority, generation owner, durable writer, source check,
generation slot, effect receipt and physical-work drain. The coordinator owns no
new ledger, grant, execution lease, root budget or domain writer. It must not
renew, fail, cancel or complete a run independently of those accepted owners.
Author-manuscript import retains its existing path.

This replaces renderer-owned sequencing for this foreground path only. The
current view/session remains required. Existing five steps, localized text,
author-buffer protection and child ACKs remain unchanged; no new visible state,
background authority, A-to-B viewing or concurrent-book eligibility is approved.
It is partial IMPORT-001 work, not complete import or imitation migration.

## Closed Mechanical Protocol

Only `reference-run:v1:execute` and `reference-run:v1:projection-ack` are exposed.
Execute carries the original reference, original execution and frozen selected
planning modelId. Null does not choose a default or an embedding model: an
existing generation root/slot retains its original model/budget, while a fresh
generation still requires the existing model admission. A nonnull actual child
model pins subsequent stages; a replay's null result does not erase that pin.

Main validates sender, complete project session, runtime/database identity,
reference/grant/revision and execution owner/epoch. An identical in-flight request
joins; another sender/session/reference/execution/model cannot join it. Main
emits identity-bound sequenced started, skipped and completed projections. Both
skipped and completed projections have unpredictable per-stage tokens. ACK only
states that the existing projection settled, failed or was cancelled. It cannot
select a next stage, mutate configuration, issue authority or approve facts.

On recovery, earlier stages do not generate or receive synthetic successful
results. Canonical readback/receipt projection must settle before the next child
captures the author buffer. Existing global/style projection uses the original
unsaved-edits publication rule. Blueprint history is read-only; a mechanical ACK
does not replace canonical source/receipt validation. Completed replay delegates
only original refresh/grant recovery, never another generation or run commit.

## Claims And Failure Boundaries

An opaque process-local parent claim fences same-run child and legacy mutation
entry points through every stage and projection gap. Only trusted composition
holds its private token. It is not a renderer bypass flag or an all-database
resource lock. Different-run shared-resource behavior remains subject to the
existing domain contracts; this ADR does not claim universal core-field CAS.

Original issuance and runtime work claims stay live through physical drain and
cleanup. Revoke, close and destroyed senders stop impossible projection waits;
they do not release claims while physical work is outstanding. Failed issuance
cleanup retains its parent/work claims and a close-time retry handle. Inner
cleanup must also retain its token until cancellation and grant cleanup succeed.
Secondary cleanup errors cannot replace the primary operation failure. Only a
confirmed same-execution cancellation maps a revoked projection wait to the
existing cancellation result; source/storage/lease failures remain failures.

## Authorized Lazy Owner And Cancellation Retry

The foreground whole-run entry initializes its existing lazy generation owner
before taking its own legacy work claims. Otherwise the first generation stage
can reject that same run as busy. Before initialization or owner handoff, the
original reference authority must synchronously check the issuance sender, full
reference/revision, execution owner/epoch, current grant/resources and unexpired
execution lease. This preflight has no domain writes; its existing admission
guard may briefly hold a SQLite transaction lock. It does not issue or renew
authority, set a parent claim or replace the later `beginRun` checks. Identical
in-flight requests may still join. Completed history skips owner initialization
and retains its original readback/grant recovery validation.

If a cancelled whole run physically settles but its canonical cancellation write
fails, keep the primary cancellation result and retain the cancellation debt,
original issuance, parent claim and runtime work claim for close-time retry.
Do not release them just because the operation promise settled. An expired lease
does not permit more execution: only this original trusted parent, with no live
child and the same reference run owner/epoch, may perform an expired-cancellation
CAS. Portable freeze and captured reference checks remain mandatory; a successor
or completed run is not changed. Ordinary execution and ordinary cancellation
still require their existing valid lease. No background eligibility, additional
request or new grant follows from the cleanup-only path.

## Acceptance

Require closed-contract/preload/session checks, coordinator transitions and
recovery/model checks, renderer single-invoke/projection/dirty-buffer ordering,
registered real SQLite/Lance controller integration with fictional providers,
original grant UPDATE failure and completed recovery, cancellation/close/drain,
parent cleanup retry and retained child regressions. Fresh typecheck, lint/colors,
i18n, source build, inspected isolated desktop evidence and independent review
must identify their exact scope. No real-model quality, visual comparison,
target-platform packaging or complete35 conclusion follows from these checks.

Execution results and independent acceptance are recorded in the Stage88
evidence; this contract alone does not qualify a complete feature or platform.

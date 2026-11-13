# ADR-0079: Shared Main-Process Model Network Admission

- Status: Proposed; bounded Stage71 implementation and independent acceptance pending.
- Date: 2026-11-14
- Scope: F2 P1-C2 / SCHED-002; existing desktop model and embedding network paths only.
- Sources: ADR-0023, ADR-0034, ADR-0035, ADR-0046, ADR-0064 and the [F2 plan](../plans/2026-11-07-creation-runtime-modernization/README.md).

## Decision

The desktop IPC composition root creates one bounded main-process scheduler and
passes it to generation, direct LLM, connection/discovery, knowledge-base and
reference-knowledge controllers. It retains the current policy (all five network
dimensions 2, queue 32, quarantine 2, interactive burst 1). Standalone isolated
consumers can construct an explicit scheduler; production never falls back to a
second instance or unscheduled network execution after admission failure.

Generic admission receives the actual resolved transport URL and groups its
HTTP(S) origin, credential and model through the existing private, bounded HMAC
subject registry. Discovery without a target model uses a fixed main-only model
group. Scheduler keys, URLs and credentials are not authorization or diagnostics.
No transport URL is rewritten for grouping. Ordinary generation keeps its
exclusive project network claim; generic and embedding requests use its existing
read claim. This does not complete the domain-writer claim matrix.

An existing direct request carrying a project session must resolve that session
in main and bind to the captured runtime execution epoch. An invalid session
cannot become an application request. Truly sessionless direct/probe/discovery
requests retain application-only network authority with one fixed main-only
project key. Runtime/application work retention spans queue wait and actual
transport cleanup. After admission, callers recheck their original authority,
runtime/epoch, model/source, stop state, maintenance and dispatch barriers before
starting the physical request. Project close revokes only its own requests and
must not close the shared application scheduler.

Application-only operations subscribe to the runtime host's confirmed close-all
notification, including when no project is open. This synchronous notification
occurs after the host seals new admission and before it waits for physical
application operations. It is not an early before-quit hook: an unconfirmed
window-close request cannot cancel work. Listener failure retains the close
fence and actual work; ordinary single-project close does not notify these
application operations.

Embedding admission is explicit main-only context, not an IPC field and not
inferred from the presence of an observer. Every physical batch owns exactly one
permit. Queue waiting occurs before synchronous dispatch marks and never inside
a SQLite transaction or short knowledge-source/effect gate. Import query's
existing physical/root-budget/receipt sequence remains singular. Original batch
ordinals, ordered failure adjudication and synchronous beforeDispatch/settled
contracts remain. Admission, cancellation, authority or receipt failures are hard
barriers, not ordinary network errors eligible for FTS fallback. Empty input,
local FTS and release-smoke embeddings do not acquire network admission.

Logical cancellation, completion callbacks and renderer disappearance do not
release a physical permit. They may start the existing five-second cleanup
grace; expiry only attempts quarantine, which still counts against all limits.
A full quarantine retains the active debt. Only the actual provider promise,
response-body consumption/cancellation and reader cleanup finishing can call the
idempotent finish. A late finish neither resets a blocked credential nor changes
an unknown receipt, and never triggers automatic retry.

## Supersession And Exclusions

This extends ADR-0035's generation-only production wiring. For these paths it
clarifies ADR-0046: project grouping uses trusted runtime.executionEpoch rather
than a renderer/view lease; queued cancellation releases only queue state;
active cancellation retains physical debt; project close does not globally call
scheduler.close(). New driver grants can survive view changes under their own
contracts; direct view-authorized requests cannot acquire that authority.

No UI, IPC payload, schema, persistent configuration, default concurrency,
model/Skill selection, retry or approval policy changes. MCP processes, cloud
backup, application updates and other non-model HTTP are outside this increment.
Domain-writer admission, the full two-book Electron/performance comparison and
complete SCHED-002 qualification remain a separate stage. No real-model quality,
speedup, headless or target-platform qualification follows from mock HTTP tests.

## Required Verification

Retain real behavior REDs, then cover shared mixed-route ceilings, production
single-instance injection, queued authority invalidation with zero dispatch,
body/reader cleanup after callbacks or cancellation, bounded quarantine debt,
query exactly-once admission at global=1 and 2, original reference/root budget
and unknown receipts, gate ordering and existing FTS/error behavior. Run the
focused impact set and fresh typecheck, lint/colors, i18n and source build before
independent integrated review and exact-path local commit.

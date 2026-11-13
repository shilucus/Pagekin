# ADR-0073: Bounded Import Query Overlap

Date: 2026-11-13. Status: accepted for the bounded Stage63 implementation, subject to independent source and runtime acceptance.

Sources: [F2 sections5.1/5.2](../plans/2026-11-07-creation-runtime-modernization/README.md), [ADR-0064](0064-bounded-concurrency-for-single-book-network-tasks.md), [ADR-0072](0072-import-query-materials-and-shared-generation-budget.md), and SCHED-001. This changes only independent query preparation, not import stage/slot dependencies, document outcome adjudication or generation retry permissions.

## Scheduling

The main owner freezes the existing normalized embedding configuration once. Its concurrencyLimit remains default1, bounded1..4, and limits the workers for the existing four topics. Actual physical overlap also obeys all shared scheduler limits; the initial global/provider/credential/model limits remain2. Increase only the initial per-project network limit from1 to2 so explicitly configured queries can overlap.

Ordinary generation acquires an exclusive logical project-network claim; query embedding acquires a shared claim for the same key in the same MainGenerationScheduler. Read/read may overlap, but ordinary/ordinary and ordinary/query remain mutually exclusive within one trusted project key. This uses the existing resource claim registry, not a second scheduler or a fake project identity. Claims and network occupancy remain held until physical finish, including quarantine debt. This is transport admission, not permission for concurrent domain writes.

Network embedding remains outside the existing KB source gate. Search, durable source verification and material completion retain that gate and fresh authority checks. Every actual dispatch retains the existing same-root atomic request cap and physical activity union clock. No new allowance, token limit, ledger or migration is introduced.

## Ordered Materials And Failure Boundary

Outputs use the existing fixed worldview/protagonist/conflict/style order, including complete hits, scores, file names and empty versus unavailable semantics. Explicitly configured overlap changes preparation timing only; the consumer's ordered logs, progress values, wording and prompt materials remain unchanged. No visible control, layout, copy or resource is added.

Known HTTP/invalid embedding fallback and actual per-topic search-unavailable remain the ADR-0072 outcomes. A hard barrier stops worker refill and must be checked again after queued admission and before physical marking. Already dispatched siblings are drained truthfully rather than internally aborted because a peer failed. External cancellation, deadlines, authority/source changes, budget, unknown and persistence fences still apply. Never return partial materials to generation or replace a hard barrier with unavailable.

For this query-only increment, the first actually observed hard barrier is the primary error object. Stop pending scheduler admissions through a queue-only signal, stop refill, drain every started worker, then rethrow that original error. Later sibling errors do not replace it, including a lower-index sibling's commit refusal caused by the first unknown fence. The queue-only signal must not abort an already dispatched sibling's fetch. A stopped, unmarked topic remains prepared and consumes zero requests; after queued admission and immediately before marking, recheck stop as well as current external authority/cancellation.

This is an explicit new query error-arbitration choice, not F2's original-batch-first document outcome rule. Multiple-error selection can depend on actual completion order; only material assembly has fixed topic ordering. Do not infer independent versus peer-derived failures from an error code or weaken any guard to impose an unsupported precedence. Later factual settlements, unknown poisoning and physical cleanup still execute and remain authoritative regardless of which error is returned. A previously completed receipt remains immutable; a sibling with only a returned result has no right to bypass the existing source/authority/root completion gates. Initial preflight fences still reject directly. No failed prepare returns partial materials or permits generation.

## Acceptance And Rollback

Stage63 requires actual scheduler read/write admission tests, bounded and out-of-order material tests, real registered IPC with fictional SQLite/Lance/configuration and controlled fetch, nonempty ordered material parity at concurrency1/2, cancellation/physical drain, hard-barrier stopping, same-root accounting and zero-resend recovery regressions. Record controlled elapsed/request/completion/peak/failure denominators without claiming provider speed, model quality or a latency SLA. Root executes focused and related tests, quality checks and source build serially; nonimplementers review integrated source and raw results.

Rollback uses concurrency1 (and if needed per-project capacity1) without refunding budgets, releasing unknown history or removing receipts. Stage63's current deterministic/performance evidence, confirmed gates and independent source/runtime review now cover SCHED-001's three ACs; fresh typecheck/lint/colors/i18n/source build also passed. The feature may be completed only on that full mapping, not this ADR alone; final artifact and scoped commit checks are separately recorded in Stage63 evidence. Full import migration, background/automation, actual Electron interaction, real models and target-platform qualification are separate.

# Stage 92: Retain Batch Cleanup Debt

## Frozen Scope

Entryb29764c5db6857b07a6c4d400a11a5e6ee59851c,master,2026-11-15. Stage91
postcommit18paths/75identities/index/protected checks match independent review.

F2 sections4.2/5.1/5.2, DRIVER002 and ADR0033 require actual owner/work retention
through physical cleanup. Current batch stop clears claim even if SQLite pause
or root pause fails; launch cleanup deletes running and releases runtime work
even if its final read fails. whenPhysicalIdle alone is not full owner quiescence:
pending operations/queries and tool claims also contribute to hasPhysicalInFlight.
These observed source paths can admit owner replacement or close before cleanup
is durably reconciled. This phase repairs that root cause, not domain scheduling.

## Contract And Ownership

- Agent2 owns workflow-batch-authority.ts and its focused tests. Root owns the
  ADR0033 clarification, controller integration if necessary, records, serial
  commands and Git. Sol independently reviews requirements/lifecycle; Agent4
  independently reviews actual fault coverage and final artifacts.
- Pause/cancel remain synchronous logical controls. A durable stopped receipt
  does not imply physical drain. A known cleanup/persistence failure is not
  success. Retain actual work/busy and cleanup intent until the engine has
  settled, physical drain has finished, full owner quiescence is observed and
  required durable task/root/read reconciliation succeeds. Release exactly once.
- Retrying original subject/current revision pause/cancel or existing true-close
  retries cleanup only. It must not resume, re-dispatch unknown, replace owner,
  grant another sender, weaken source/epoch checks or downgrade cancellation.
  Destroyed-sender debt remains visible to true-close retry. Read-only receipt
  reads do not silently create a retry or execution authority.
- Cleanup convergence must not assume whenPhysicalIdle means no pending query or
  operation. An explicit subsequent authorized control/close may retry retained
  nonphysical debt; no timer may auto-retry a model request. Concurrent/repeated
  cleanup attempts coalesce and cannot double-release or hide a repeated failure.
- Start/launch acquisition failures must not leave a durable active issuance
  without busy protection. Prefer work retention before the first durable root
  effect, preserving rollback and avoiding awaited work inside SQL transactions.
- No public IPC/schema/dependency, visible layout/copy/interaction, real project,
  new approval policy or external state change. Existing sole writers, outbox,
  source freezing, closed task bounds and physical budget protections remain.

## Required Evidence

Freeze a focused regression for each actual fault: repository pause/block/final
read, root pause, physical drain rejection, pending nonphysical owner work and
launch/acquisition failure. Cover one-shot and persistent failures, retained
runtime busy/owner fence, explicit retry/release exactly once, stale/foreign
controls, sender destruction, ignored abort/late settle, unknown no resend and
repeat close after timeout. Extend actual registered controller close/owner
handoff coverage where its existing fixture can establish these properties.

Root reviews scripts before authorized filtered pnpm test and fresh typecheck,
lint/colors, i18n/build. Tests use only isolated fictional data; reports/cache and
build outputs stay within existing permitted local trees. Native/toolchain work
is serialized. A new Electron scene is not assumed to prove injected failures.
Independent review, material-fix retest/rereview, final source/raw/build manifest
and exact-path local commit are required. This phase may add partial evidence,
but does not independently complete SCHED002 or reopen unrelated feature flags.

## Execution and Review Results

- Implementation verified:
  - `electron/services/workflow-batch-authority.ts`: retains cleanup intent, running work, and busy fence until physical drain and durable reconciliation succeed; true-close retries cleanup.
  - `electron/services/main-generation-owner.ts`: added `assertCleanupQuiescent` to ensure captured resources and service quiescence.
  - `electron/controllers/generation-controller.ts`: ensures `projectRuntimeHost.assertTaskAvailable(runtime)` is called before legacy handoff, preventing concurrent execution attempts during active batch work.
  - `docs/adr/0033-persistent-planned-batch-review-driver.md`: recorded Cleanup Failure Retention specification.
- Focused verification:
  - `electron/services/__tests__/workflow-batch-authority.test.ts`: 22/22 passed.
  - `electron/controllers/__tests__/workflow-batch-controller.test.ts`: 27/27 passed.
  - `electron/services/__tests__/main-generation-owner.test.ts` (quiescence): passed.
  - `scripts/__tests__/creation-runtime-feature-evidence.test.ts`: 36/36 passed.
  - `node scripts/check-i18n-coverage.mjs` and `node scripts/check-color-literals.mjs`: passed.
- Independent Review:
  - Sol accepts the contract, requirements, and lifecycle: cleanup debt retention preserves owner fences, does not add public IPC or persistent credentials, and prevents double-release.
  - Agent4 accepts fault coverage and artifacts: all regressions pass; no unrelated feature flags or premature completions are claimed.
- Limitations:
  - This is an intermediate defect fix and does not mark SCHED-002 as completed.
  - Domain-writer admission and full multi-book fair scheduling remain in progress.

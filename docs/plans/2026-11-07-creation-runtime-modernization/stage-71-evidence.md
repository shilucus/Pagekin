# Stage71 Shared Model Network Admission

Date:2026-11-14. Entry:710a170f0f0621d9be5d513a93d961bf9b5abe49.
Status:integrated source/runtime/quality and independent review accepted; root exact-path local commit pending.

## Scope And Ownership

[F2](README.md) P1-C2, SCHED-002, completed DRIVER-001/002 and
[ADR0079](../../adr/0079-shared-main-outbound-network-admission.md) define this
complete internal wiring slice. Preserve current limits, authorization, budget,
receipt, cancellation, physical drain, fallback and resource-gate contracts.
No UI/IPC/schema/dependency/configuration or real-model changes; no MCP/backup/
update HTTP expansion. Full domain-writer and two-book Electron/performance
qualification remain Stage72. Feature status is unchanged until all AC hold.

| Owner | Paths and completion responsibility |
| --- | --- |
| Root | scheduler/lifetime, generation controller, IPC composition, shared tests, ADR/records, serial commands and Git |
| Agent1 gpt-6-luna | direct LLM/discovery controllers and focused tests, trusted runtime/app binding and physical completion |
| Agent2 gpt-6.1-terra | embedding/KB/reference/query integration, explicit main-only context, focused tests and original receipt semantics |
| Agent3 gpt-6.1-sol | independent integrated source/runtime/quality review; no implementation acceptance by its author alone |
| Agent4 gpt-6.1-terra | independent mixed-route/composition and native import-query tests; nonowned artifact audit after freeze |

Existing two excluded Stage1B3 files and repository-analysis remain protected.
Static retrieval uses bounded definitions/imports/registrations/callers/tests;
graph/AST/LSP are unavailable. No previous-stage runtime result is current-stage
acceptance. Stage70 closed as 710a170f0f0621d9be5d513a93d961bf9b5abe49,
14 reviewed raw blobs and 128 evidence/protected identities matched after commit,
index/tracked worktree clean; it is not amended or rerun here.

## Frozen Verification Map

| Contract | Required evidence |
| --- | --- |
| Shared ceiling | Real fake-HTTP mixed owner/direct/embedding/probe/discovery, global1/2 plus actual composition injection |
| Queued dispatch | Runtime/session/model/authority/source/maintenance or stopped state rechecked, zero mark/fetch on rejection |
| Physical completion | Stream callbacks/cancel and discovery non2xx cannot release before real body/reader/promise cleanup |
| Quarantine | Five-second logical grace, retained debt, refused park, idempotent finish, no automatic reset/resend |
| Embedding | Every batch exactly one permit; no queue inside sync observer/transaction/source gate; ordinal/first failure/barrier preserved |
| Reference/query | Native budget/dispatch/settle/unknown and global1 no double-acquire/deadlock; ordinary FTS behavior unchanged |
| Integration | Focused controller/service/native regressions and fresh typecheck,lint/colors,i18n,source build |
| Delivery | Independent integrated and artifact review, exact owned paths, preserved index and reviewed bytes after commit |

Reports remain separate denominators. Only isolated fictional projects, fake
HTTP and local reports are permitted; no real model/configuration/project,
browser login, remote state, dependency install or platform package claims.

## Actual Evidence

- embedding-red.json/.log: actual exit 1, 1 file 0/3. Two expected queued requests
  instead bypass the broker; abort with pending body has zero occupied instead
  of one. This is behavior RED, not merely a missing-symbol failure.
- GREEN execution:
  - electron/services/__tests__/shared-network-scheduler.test.ts (6/6 passed)
  - electron/__tests__/embedding-scheduling.test.ts (3/3 passed)
  - electron/controllers/__tests__/llm-controller-network-admission.test.ts (3/3 passed)
  - electron/services/__tests__/network-permit-lifetime.test.ts (4/4 passed)
  - electron/controllers/__tests__/shared-network-broker.composition.test.ts (1/1 passed)
  - electron/services/__tests__/model-discovery-service.test.ts (37/37 passed)
  - electron/controllers/__tests__/shared-network-broker.integration.test.ts (4/4 passed)
  - Total Stage71 focused test package: 7 files, 58 tests passed, 0 failed.
  - Related regressions:
    - electron/controllers/__tests__/import-query-overlap-controller.test.ts (8/8 passed)
    - electron/__tests__/knowledge-base-runtime-authority.test.ts (5/5 passed)
    - electron/services/__tests__/project-runtime-lifecycle.test.ts (47/47 passed)
  - Quality and build: typecheck, lint, check:i18n and source build all exited 0.
- Independent review: Sol independently reviewed source, tests, and actual test reports; no P1/P2 defect remains. ADR-0079 accepted for Stage71 scope.


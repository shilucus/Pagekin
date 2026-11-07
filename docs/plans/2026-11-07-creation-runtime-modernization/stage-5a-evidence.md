# Stage 5A: Main-Process Scheduling Kernel

Parent: `66e1faf93c208e443f2535a5b8e55ac90504150f`. Date: 2026-11-08, Asia/Shanghai. Source identities: [six-file manifest](stage-5a-source-manifest.json), SHA256 `C94CC50001B470BF911F25AFC34FB95359C2E2517AC6F9809CABB540FDB1400A`, matched 6/6. Contract: [ADR-0034](../../adr/0034-main-process-scheduling-admission.md).

## Scope And Acceptance

This is an unconnected main-process admission kernel, not complete SCHED-002. It adds atomic process-local read/write claims, finite multi-dimensional network admission, project rotation/lane FIFO, bounded interactive priority, cancellable queueing, opaque privately issued subjects and independently retained physical ownership. It changes no production dispatch, IPC, visible output, database/schema, dependency, plugin or author permission. No storage migration is needed for this nonpersistent slice.

The kernel does not create attempts or refresh authority. Queued work holds no partial network/resource permit. Quarantine still counts in every network dimension and retains claims; late finish does not automatically reopen a stopped credential. Full quarantine stops new global admission without erasing another active transport. Explicit idle reset and close preserve the physical-finally boundary. External domain-claim release wakes resource-only waiters without polling.

Full SCHED-002 remains `in_progress/passes=false`: production routes must actually share the broker; dispatch must revalidate authority/source/epoch/model/cancellation/stage/root budget after all awaits; real two-book workflows, serial versus concurrency-two performance and isolated Electron evidence remain required. URL userinfo compatibility must be reconciled before this currently unused subject registry gates existing providers. Pure kernel tests are not those future gates.

## Team And Review

- gpt-6.1-sol/high implemented the scheduler/claims source and tests, with exclusive four-file ownership. gpt-6.1-terra/high implemented the subject registry/test pair. Neither ran project commands or performed Git writes.
- Root integrated records and alone executed the serial commands. Independent requirements/fairness and lifecycle/security reviewers used their existing inherited configurations; no model fallback was applied or unobserved setting invented.
- Both independent reviewers directly consumed the final six hashes, actual raw reports and ADR. They accepted this unused kernel slice with no unresolved in-scope correctness blocker, not complete SCHED-002 or production/remote-concurrency qualification. Final source/static/build consistency remains root's commit gate.

## Findings And Repairs

1. A protocol field in the original remote-model key allowed otherwise equivalent protocol aliases to bypass the independent model limit. A test-only change first failed 1/5; the minimal production key now uses origin plus the unchanged remote model name. Fresh registry tests passed 5/5. The final scheduler test uses the real registry, `model=1`, other network dimensions 8 and different projects/credentials/protocols; its second request must queue until actual finish.
2. A resource-only waiter could remain asleep after an external domain writer released its claim. A minimal synchronous release subscription now wakes drain; real deletion notifies once, close unsubscribes, and the regression begins with zero network occupancy. No polling or new timer was added.
3. Independent static review found one extra closing `})` in the scheduler test. It was removed before the formal impact run; no failed parse is represented as runtime evidence.
4. The first formal impact run had 65/69 passes. Three independent-dimension fixtures awaited a later request behind the same project's blocked lane head; a fourth full-queue fixture received `SCHEDULER_QUEUE_FULL` for the same reason. Only the intended independent requests' project identity changed to B. Production FIFO, limits, queue bound, default timeout and assertions stayed unchanged; existing explicit no-head-bypass assertions remain. Independent review confirmed the actual failure/raw and the fixture-only repair.

## Actual Execution

Working directory: project root. Environment: Windows x64, Node 24.13.0, Corepack pnpm 11.11.0, Vitest 4.1.12. The reviewed `test` script is `vitest run`; these pure fixtures use fictional model profiles and no provider, project database or user configuration. Reports and tool caches are local; commands were serialized by root.

```text
corepack pnpm test electron/services/__tests__/scheduler-network-subject.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-5a/subject-model-alias-red.json
corepack pnpm test electron/services/__tests__/scheduler-network-subject.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-5a/subject-model-alias-green.json
corepack pnpm test electron/services/__tests__/main-process-scheduler.test.ts electron/services/__tests__/main-resource-claims.test.ts electron/services/__tests__/scheduler-network-subject.test.ts src/shared/__tests__/workflow-resource-claims.test.ts src/services/workflows/__tests__/workflow-resource-claims.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-5a/kernel-first.json
corepack pnpm test electron/services/__tests__/main-process-scheduler.test.ts electron/services/__tests__/main-resource-claims.test.ts electron/services/__tests__/scheduler-network-subject.test.ts src/shared/__tests__/workflow-resource-claims.test.ts src/services/workflows/__tests__/workflow-resource-claims.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-5a/kernel-retest.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
```

| Raw report under `.runtime/creation-runtime-modernization/stage-5a/` | Actual result | SHA256 |
| --- | --- | --- |
| `subject-model-alias-red.json` | exit 1; 4/5, one alias-grouping failure | `056A3DAD93DAC0D23EB8FF0D3E7BD509202D7F1D5EEBBFB5FD638A8FCCA86243` |
| `subject-model-alias-green.json` | exit 0; 5/5, zero failed/pending | `741F9CD91277D1D060329B6BAC7794F0E0C965BB7909919937129F8613E45CFD` |
| `kernel-first.json` | exit 1; 65/69, four failures, zero pending | `0638A74AB7B30581889E2CC3BA2BC77C968209D6974CB7FE43D28586E631EA9A` |
| `kernel-retest.json` | exit 0; five files, 69/69, zero failed/pending, success=true | `EEA42D6FE6171DF17C9B484F0D61B9069A14DACFA83CE8DEDD3C6FD0ECA59B35` |

Final denominator: scheduler 40, main claims 10, subject registry 5, existing shared claims 6 and existing workflow claims 8. Counts overlap the earlier focused reports and are not summed. Failed reports remain failures. Typecheck, lint/color, i18n and source build exited 0. Existing Vite alias/output-option/chunk/dynamic-import warnings remained nonblocking and were not hidden or changed. The build does not connect the unused modules and is not their runtime proof; TypeScript and direct deterministic tests cover them.

| Actual build output | SHA256 |
| --- | --- |
| `dist-electron/main.js` | `325C647B7820E7AFB1BFA1F43C26CA7173B9EC3D89636A51B3789B187933271D` |
| `dist-electron/preload.mjs` | `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B` |
| `dist/index.html` | `212DD2B4E0D2F63498F2E6C065A5A2D5FD3C77FBD2F5087C8B575891FD814CA0` |

These production identities are unchanged from the parent because no production import consumes this kernel. `git diff --check` had no diagnostics. Before scoped commit, `core.hooksPath` was unset and `.git/hooks` contained only sample hooks. The original staged repository analysis remained blob `1f53891b6ae9547e444762c4389433ea7cf5f304` and is excluded.

## Boundaries And Next Step

No actual Electron scene, browser workflow, production two-book throughput, remote provider, literary quality, install/target-platform or headless claim is made for this kernel. Current application behavior is unchanged because only tests consume the new modules. Graph/LSP tooling is unavailable, so bounded definitions/imports/call-site/parent-diff cross-checks are the static retrieval fallback.

Next: connect production admission before reserve/dispatch, wire cancellation and actual physical-finally ownership, and cover queued authority/source/close invalidation. Inventory the other generation, embedding, probe and domain-write routes explicitly; no partial integration may claim a global SCHED-002 PASS. Complete reference/import and imitation migrations remain separate deliverables and do not acquire a new SCHED-002 dependency.

# Creation runtime modernization implementation log

## Execution Contract

- Started: 2026-11-07. Branch: `master`. Baseline: `0679303231cc439a0d2285f5c683041d1b347f0f`.
- Authority: current user authorizes all 35 F2 features, scoped code/tests/docs/ADRs/contracts/migrations, isolated fictional validation, listed pnpm commands, and path-scoped local staging/commits. Historical documentation-only restrictions describe planning, not this run.
- Frozen source: [README.md](README.md) F2, SHA256 `5302A8930D95DA9CD618BC528DD8D40D99F2C59957CE91B6332BC0E974C8B5C3`; [features.json](features.json), [evidence-map.md](evidence-map.md), [review-record.md](review-record.md), applicable rules/current ADRs.
- Protected initial index: `docs/repository-analysis-2026-11-07.md`, blob `1f53891b6ae9547e444762c4389433ea7cf5f304`, mode `100644`, 538 added lines. Never include it in implementation commits or change its staged bytes.
- Initial untracked files: four existing F2 plan files. Preserve their historical claims and record implementation here.
- Excluded: real models, private projects/configuration, secrets, DSH plugin changes, global toolchain upgrades, remote publication, destructive Git actions.
- Missing design, author policy/human-channel decisions, model budget/credentials and platform evidence remain gates. Continue independent internal work; mocks do not establish literary/platform qualification.
- No graph/AST/LSP service is exposed. Cross-check bounded source, imports, direct callers and tests; runtime claims require actual execution.

## Team And Ownership

| Role | Model / effort | Ownership |
| --- | --- | --- |
| Coordinator | inherited session configuration | Integration, shared contracts/records, commands, Git |
| Performance implementer | `gpt-6.1-sol` / high | Assigned PERF-001 collector and main instrumentation/tests |
| Feedback scout | `gpt-6.1-sol` / high | Read-only candidate/adoption, CAS and portability investigation |
| Runtime scout | `gpt-6.1-terra` / high | Read-only lifecycle, DB/access and revocation investigation |
| Independent reviewer | assigned per integrated stage | Raw requirements/source review, independent of implementation |

No substitutions. Agents cannot broaden authority. Overlapping writes, native/packaging state and Git remain serial.

## Stage And Validation Map

Each commit-sized stage: freeze scope/acceptance, implement, focused checks, independent review, fix/retest/re-review, commit, advance. Groups are scheduling lanes, not permission to skip dependencies.

| Order | Features | Required evidence |
| --- | --- | --- |
| 1A / 1B | PERF-001 implementation / remaining baseline | 1A bounded diagnostics/regressions; 1B fictional 10/100/1000 strict isolation and full denominators; 2/4 books unsupported. Feature stays incomplete until 1B. |
| 2 | PERF-002/003/004, SCHED-001 | Exact samples/prompts, bounded reads, durable stream/reconnect/errors, measured computation, ordered concurrent outcomes |
| 3 | FEEDBACK-001/002, then 003/004 | Candidate/adoption separation, original baseline CAS, final selection validation, history/new-copy recovery |
| 4 | RUNTIME-001, then 002, then 003 | Explicit routing, compatibility matrix, grant/epoch isolation, revocation/effect linearization, maintenance barrier |
| 5 | DRIVER-001/002, then SCHED-002 | Stable steps/receipts, crash reconciliation, unknown not resent, real completion, fair bounded physical transport |
| 6 | IMPORT-001 and 002 separately, then 003/004 | Complete single-book deconstruction/imitation individually, then multi-book/mixed qualification |
| 7 | UI-001/002/003 when design/dependencies permit | Exact output evidence, bilingual/browser/Electron buffers/switch/close/adoption/conflict |
| 8 | API-001, CLI-001; AUTO-001/002; ACCEPT-001/002/003; AUTO-003; MCP-001/SKILL-001 in DAG order | Inbound security/idempotency, real wait/receipts, machine/human separation, immutable manifest/partial recovery |
| 9 | QUAL-001/002, finally HEADLESS-001 | Full-chain quality/performance, three-target evidence, production no-window ownership/takeover |

## Command Review

- All authorized project commands run at repository root.
- Installation: pinned pnpm 11.11.0 via existing Corepack, not PATH pnpm 9.4.0. Writes dependency/tool caches/node_modules and downloads packages/Electron; configured installation hooks include esbuild/Electron. Reviewed workspace disallows better-sqlite3 rebuild. No concurrent native changes.
- `pnpm test`: Vitest via vite.config.ts and reviewed locale/Buffer setup; may write Vite cache/isolated fixtures. Selected tests reviewed before execution; no real configurations/models.
- `pnpm run typecheck`: tsc --noEmit; reviewed tsconfig files, no product build output.
- `pnpm run build`: tsc and Vite; writes dist/dist-electron, not package/platform qualification.
- Other commands and drive scenarios reviewed at their stage; build/verification authorization does not permit release or real configuration/model use.
- Hooks initially: no core.hooksPath/core.fsmonitor/commit.gpgsign; only inactive .sample hooks. Recheck before commits.

## Open Gates

- F2 section 6.3 lacks exact approved design/viewport evidence for new visible states. Internal kernels may proceed; UI changes wait for supporting evidence.
- Real-model quality and three-target native/installed runtime lack this-run evidence and model authorization. No quality non-regression or platform PASS claim.
- Each persistent package must implement/review its ADR/contracts, field classification, original recovery and portable-new-copy recovery; no blanket acceptance in advance.

## Stage 1A / 1B: PERF-001

- 1A implementation slice independently reviewed; 1B blocked on strict isolated desktop sampling while the installed user application periodically writes its real profile. No complete-feature acceptance/PASS claim; no dependent feature unlocked.
- Frozen scope: opt-in bounded whitelisted in-memory diagnostics, narrow production counters/timing, controlled fictional baseline. No query optimization, business IPC/schema/UI change, flush-window or authorization change.
- Collector/instrumentation delegated with explicit files; driver, records and integration owned by coordinator.
- Keep existing switch/cancel protection until lifecycle migration. Do not fake unsupported 2/4-book baseline cases.
- `corepack pnpm install --frozen-lockfile` downloaded dependencies with pinned pnpm 11.11.0, then failed in the Electron installer with `TypeError: fetch failed`. Retried the same command with process-local `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`, restoring the previous environment value in `finally`. Installation completed; Electron 44.9.3 downloaded with the installer's checksum validation retained. Lockfile/package/workspace files unchanged; no global upgrade or permanent mirror setting.
- Verification version: baseline plus explicitly owned working-tree changes; record hashes/commands/results before review/commit.
- An initial `corepack pnpm test -- <file filters>` invocation did not filter under the pinned toolchain and unexpectedly ran the broad suite. Stopped only that verified owned Vitest process and its children after the run stalled; exit 1 is not a PASS. Partial unrelated release/macOS/workflow/Windows file-system failures were observed; no baseline diagnosis or qualification claim. Subsequent filters omit the extra separator.
- Initial focused production regression: 11 files / 464 tests passed. After review fixes, `corepack pnpm test <15 selected production files> --maxWorkers=2`: 15 files / 615 tests passed (108.75 s); collector, service/owner, import, three providers/transport, controller and renderer coverage. `corepack pnpm test <5 selected redesign driver files> --maxWorkers=2`: 5 files / 57 tests passed (3.65 s), including guarded fixture requests and missing probes.
- `corepack pnpm run typecheck`, `corepack pnpm run lint`, and `corepack pnpm run check:i18n`: exit 0. These are static checks, not desktop or literary acceptance.
- Independent reviewer: `gpt-6.1-terra` / high, no implementation ownership. Findings addressed: missing cancellation/archive-byte counters; lost failed-scenario reports; logical dispatch incorrectly labelled physical request; fixture fetch attempts absent from the request denominator; missing probes/collector incorrectly treated as successful sampling. Added focused regressions and reran affected tests. Final review remains pending evidence/version freeze.
- Source `transport.requests` counts a fetch promise accepted by the transport, not remote receipt/billing; `generation.dispatch.calls` counts logical dispatch only. Driver guarded fetch attempts and fixture accepted requests are separate denominators. Quantiles are fixed-histogram upper bounds, not exact sample percentiles. IPC byte counts are application DTO UTF-8 JSON, not Electron wire bytes.
- No business schema, public IPC, visible UI, authorization, flush window, ledger, prompt material or request-limit change in this stage. Existing hashing, source gates, identity/monotonicity checks and terminal delivery remain.
- `corepack pnpm run build`: exit 0; warnings and built hashes recorded in [stage-1-evidence.md](stage-1-evidence.md). Initial 10-chapter drive exit 0, 100-chapter workflow/metrics succeeded but drive exit 1 due to real-profile shader-cache timestamp changes. Reviewer found the initial monitor also omitted default business-data root; fixed and reran five driver files: 58 tests passed, JSON evidence saved. No cache-ignore expansion. Both desktop runs require retesting with the stricter monitoring.
- Read-only polling after isolated processes exited found the two cache files refresh again five minutes later; separate installed application/GPU processes remain active on the real profile. This is not writer-handle proof, so preserve the failure and request normal user-app exit rather than stop it or weaken isolation. Do not overwrite the failed report.
- Evidence-driven scheduling adjustment, accepted by the independent reviewer: split bounded diagnostics implementation (1A, review finds no unresolved code blocker) from remaining full baseline acceptance (1B, still open). Scope/feature criteria unchanged. Commit 1A after final path/hash/index/hook checks; then FEEDBACK-001 may proceed because its DAG has no dependency. PERF-002/003/004 and SCHED-001 stay locked until PERF-001 passes. No silent dependency override.
- Source/test/driver hashes, exact commands and evidence limitations are in [stage-1-evidence.md](stage-1-evidence.md). Commit: pending.

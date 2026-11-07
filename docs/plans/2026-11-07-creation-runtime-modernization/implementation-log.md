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
- Source/test/driver hashes, exact commands and evidence limitations are in [stage-1-evidence.md](stage-1-evidence.md). Commit: `b9c3855e87087d3fd0102356ed59e2fba53e7cf3`. Post-commit diff matched the reviewed version; the protected initial staged snapshot remained unchanged and outside the commit.

## Stage 2A: FEEDBACK-001 Internal Kernel

- Dependency: none. PERF-001 remains incomplete and its dependants remain locked. This slice does not claim the complete field/section/chapter-range feature.
- Frozen scope: immutable candidate/base/parent records, core-field and premise/worldbuilding adoption adapters, main-owned generation-input proof, atomic final-payload adoption/history/idempotency, monotonic source revisions, and per-package portable classification/new-copy freezing. No renderer/UI/IPC exposure, no automatic model calls, no character/prose/range writer changes.
- Team: feedback implementer owns the new shared protocol, M08 DDL, repository and tests; runtime implementer owns new service/generation-proof modules and tests; portable implementer owns existing portable format/freeze/archive/policy and their tests. Coordinator owns central migration registration, owner/source-binding integration, ADR and records. Independent reviewer owns no implementation files.
- Contract/source evidence: F2 sections 6.1/6.2/7.8 and current domain writers. ADR-0026 will record this package only; no blanket G-CONTRACT/G-STORAGE acceptance for later runtime/API/automation features. New visible states remain blocked by G-DESIGN.
- Root cause identified before integration: existing generic attempt request hashes prove a dispatched task, but do not establish that task used the feedback base/parent/instructions. The main-owned operation must freeze and verify those inputs and the actual task against the persisted attempt/artifact; renderer flags and hashes cannot supply this proof.
- Acceptance: F0-to-C1-to-C2 lineage, no formal write on staging, partial/edited final payload, same-key replay/different-payload rejection, ABA and rollback, same-content adoption closing the old base, stale descendants, restart, old-schema migration and 7/8/9 portable restore/re-export. Required checks and independent review pending; feature remains in progress with passes=false.
- Persistence checks use only in-memory or disposable fictional projects. M08 is installed solely through the central migration registry; no migration of a real user project or schema downgrade.
- Implemented the eight-target kernel, dedicated main-owner admission/task and installed planning Skill proof, source ABA counter and transactional author-action adoption. Schema 7/8 archives remain readable; new schema 9 packages classify every new field, redact mixed execution identities and freeze old candidates/adoptions. This does not complete field/section/chapter-range FEEDBACK-001.
- Review/fix/retest closed: complete stop with untrusted usage is accounting-unknown, not delivery-unknown; preserve its ledger and do not resend. Portable nonce history labels require a collision-free two-phase transition, even when legal old nonces occupy the final/temporary namespace. M08 initialized rows must not pollute older domain projections; schema 8 format coordination now requires preFeedbackDomain and rejects missing/tampered receipts before cutover.
- Actual root results: owner/source 8 files 480/480; kernel/portable 15 files 262/262; compatibility 8 files 170/170; typecheck, lint, check:i18n and source build exit 0. Batches overlap and are not a full-suite claim. Earlier failures, exact commands, hashes and side effects are preserved in [stage-2a-evidence.md](stage-2a-evidence.md).
- Independent final re-review: receipt/source reviewer gpt-6.1-terra/high and storage/migration reviewer inherited session model; neither owned implementation in its review scope. Both found no unresolved in-scope code blocker after fixes; root then completed the compatibility batch. No UI/Electron/real-model/platform acceptance was claimed.
- Commit: `1815d16ae12b15c852b34b0cea06d790439ae5a7`. Post-commit source matched the reviewed version; only the original protected staged document remained, with its original blob. Next slice closes the missing chapter-range adoption/proof contract before FEEDBACK-001 can pass. Runtime and performance dependants remain subject to their DAG and evidence gates; the real installed application remains active, so strict PERF-001 1B is still open.

## Stage 2B: Outline-Range Candidate Adapter

- Frozen scope: extend the thin FEEDBACK-001 protocol to an existing, explicitly bounded outline chapter range. Reuse the current chapter parser and ProjectCoreRepository.commitSynopsis; a feedback-specific span renderer preserves outside bytes rather than regenerating coverage metadata. Do not add blueprint producer, character/prose writer, UI or public entrypoints. Full feature status remains pending required evidence and independent requirement review.
- Range source includes the actual consumed core facts, synopsis and charactersArch. Its independent monotonic revision tracks every corresponding author write and ABA without changing the old eight-field counter or persisted v1 task bytes. Partial adoption validates the selected subrange's final payload, renders the formal synopsis on main and consumes the old full lineage atomically.
- M09 extends the closed schema through the central lane, preserves v1 histories and idempotent receipts, and receives package-local schema 7/8/9/10 portable classification and restore tests. No existing migration is rewritten and no real database is upgraded.
- Ownership remains disjoint: feedback agent shared protocol/M09/repository; runtime agent service/task proof/tests; portable agent format/policy/projection/restore tests; coordinator parser helpers, registry/source-owner integration and records. Independent reviewers separately cover requirement/proof and storage/migration.
- Acceptance freezes actual C1-to-C2 parent, original F0 CAS, chapter 3 only within 3-4, untouched surrounding author bytes, invalid/missing/duplicate/out-of-range zero writes, ABA/same-content/replay/rollback/restart, and old-package/new-copy frozen lineage with second export. No completion or performance/quality claim before those checks.
- Actual initial checks: migration/coordination 7 files 114/114 passed. A one-off capture test compiled only the immutable `1815d16a` source closure in memory, then constructed real native schema 9 normal/donor fixtures; fingerprints and source provenance are in `.runtime/creation-runtime-modernization/stage-2b/baseline-schema9/capture-6Xuk1M/identities.json`. Normal is 55 tables/527 fields, donor 55/528. The capture helper first failed on unsupported esbuild Go-regexp `u` flags, then passed after correcting the harness; both reports are retained and the temporary test was removed, not committed.
- Independent review found the old generation range renderer adds/replaces last-chapter coverage notes. The feedback adapter now uses a dedicated exact-span renderer, with raw-tail/CRLF/blank-line regression coverage; original generation behavior remains untouched. Reverification and final review are pending.
- Closed review/runtime issues: fixture derived-field writes now seed only fictional derived state without removing the author-write guard; trailing whitespace around recognized old coverage notes preserves exact raw tails; the migration-ID expectation now includes M09. Earlier failed reports remain retained, including 1085/1086 before the final expectation fix.
- Final actual command evidence: the same integrated 32 files passed 1086/1086 with no pending tests; typecheck, lint, check:i18n and source build exit 0. [stage-2b-evidence.md](stage-2b-evidence.md) records the exact final command, 35 frozen hashes, report identity, build hashes, side effects, earlier failures and unexecuted boundaries. No full-suite/Electron/real-model/platform acceptance.
- Independent final re-review: requirements/proof gpt-6.1-terra/high and storage/migration inherited session configuration both directly matched the 35 hashes and final report. Neither implemented the reviewed changes or ran the verification. Both found no unresolved in-scope code blocker; storage also matched build output hashes. ADR-0027 and the package-local contract/storage gates are accepted; global future gate scope remains pending.
- FEEDBACK-001 is now completed/passes=true based on Stage 2A plus 2B, not on a fixture-only facade. FEEDBACK-002 dedicated production IPC/mode, FEEDBACK-003 blueprint wiring and UI-002 are separate unfinished features. The scoped stage commit is recorded after Git returns; the protected initial staged document is excluded.
- Commit: `319846b3b182d20371d31ad6df1eba64fe7da48a`. All 40 committed paths matched the reviewed bytes. Only the protected initial analysis remained staged, with its original blob and 538 added lines.

## Stage 2C: Dedicated Field Feedback IPC

- Parent: `319846b3b182d20371d31ad6df1eba64fe7da48a`. Freeze the eight existing core targets in an explicit desktop IPC v1 namespace; no outline/blueprint/character/prose target or public API/approval capability. Existing v1 task/persisted proof bytes remain unchanged.
- Scope: actual registered controller/session/owner/repository route, strict runtime wire validation, candidate/adoption history and original-run discovery, plus a nonvisible renderer client that freezes its session/input and never retries unknown work or automatically adopts. No new persistent state or schema migration.
- Ownership: coordinator shared wire contract/AllInvokeChannels/ADR/log and integration; main implementer controller/owner/service/repository discovery and registered IPC tests; renderer implementer client, project-channel classification, wire/client/session tests. Neither implementer independently accepts their important changes.
- Acceptance: real SQLite through client and registered IPC, all eight targets and F0/C1/C2, candidate-only generation, explicit target-only adoption, closed payloads, stale/cross-project handles and DB replacement, cancellation/late/unknown no resend, restart discovery/replay and portable read-only histories. Retain old generate-field/architecture behavior and generic feedback admission rejection.
- The wire layer is not the visible author workflow. Missing entry/diff/dirty-buffer state design and its actual author-action integration remain explicit gates; no claim that stage pages expose this mode or that UI-002 passes. Scope completion will be judged against FEEDBACK-002 separately after evidence/review, not inferred from this infrastructure slice.
- Actual Team: main implementation gpt-6.1-terra/high; renderer implementation gpt-6.1-sol/high; independent proof reviewer gpt-6.1-terra/high and session/storage reviewer inherited session configuration. Coordinator owns commands, shared integration and Git; neither implementation agent accepts their own important changes.
- Independent review corrections: allow explicit main-validated resume of original predispatch runs after restart, without resending dispatched unknown work; classify malformed current Skill bindings at their JSON parsing boundary; distinguish current source/asset snapshot races from corruption of persisted history. No general exception swallowing or execution-source bypass.
- Early actual checks: five wire/client/old-protocol files 83/83; source binding 127/127. Initial integrated 23 files 927/929 failed because two new range fixtures omitted the required chapter 1-2 prefix. The fixture was repaired without changing the production guard. Initial typecheck failed on new-test nullable values and a generic client handle type; only fixture assertions and runtime-validated type narrowing changed.
- The corrected integrated run passed 929/929, and typecheck/lint/i18n exited 0. A subsequent independent review identified current snapshot-race classification; this substantive correction and its added registered-IPC regression require a new final run. The previous passing report is preserved, not used as final evidence for later bytes.
- Portable recovery preserves the existing privacy projection: original feedback run input is not reconstructed after its sourceManifest is redacted. New-copy discovery covers base metadata and candidate/adoption history; old run/read/execute/cancel and old lineage mutation remain unavailable, while explicit fresh-base copying uses the existing relineage contract.
- Final actual execution after both current-source race corrections: 23 files 931/931, zero failed/pending; typecheck/lint/i18n/source build exit 0. [stage-2c-evidence.md](stage-2c-evidence.md) preserves exact commands, reports, 16 implementation hashes, build hashes and earlier failures. This is registered production IPC plus real SQLite, not an Electron/visible-author-flow or quality/platform qualification.
- Independent final proof and session/storage reviewers each directly matched all 16 implementation hashes, the final report and three build hashes. Both accept this internal slice with no unresolved in-scope blocker; neither executed project commands. ADR-0028 is accepted only for this package. FEEDBACK-002 stays in_progress/passes=false; future dependencies remain locked.
- Next independent implementation lane is RUNTIME-001 explicit resource routing. PERF-001 desktop retakes remain blocked while the separately installed application owns its real profile; current read-only process check still finds the same installed app. UI/design and author policy gates are not bypassed.

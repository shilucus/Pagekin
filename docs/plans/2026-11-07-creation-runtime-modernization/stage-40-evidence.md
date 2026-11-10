# Stage 40: Header, Handshake And Preliminary-Evidence Protection

Date: 2026-11-10. Entry HEAD: `14fbe63f`, master, Windows x64. This is a bounded safety correction to incomplete API-001, ACCEPT-002, AUTO-003 and ACCEPT-001, not whole-feature qualification.

## Scope And Acceptance Freeze

| Scope | Evidence and acceptance | Ownership |
| --- | --- | --- |
| Existing Host/Origin boundary | ADR-0050 and existing controller call: exact raw authority plus structured parsing; no normalization alias, prefix spoof, credentials/path/query/hash/multivalue or invalid port; header denial before body/auth/dispatch; valid headers still require authorization | runtime implementer: shared contract/unit tests and new no-listener handler test |
| Approval handshake | ADR-0055 Unfreeze-Wins and retained author buffer: unique in-flight token, canonical object and pending state rechecked after await/throw and before freeze; revoke/clear/replace cannot be undone by stale callbacks; detached late dirty result retained | lifecycle implementer: coordinator and tests |
| Scratch preliminary evidence | ADR-0054 missing evidence unavailable and ADR-0057 candidate isolation: no invented prose/version/receipt/quality, suspend with fixed reason and preserve candidates/history; default resume does not regenerate or consume repair budget | orchestration implementer: orchestrator and tests |
| Integrated source and artifacts | Root owns ADR/records/commands/Git; two non-implementing reviewers independently inspect source/state boundaries and actual evidence | root and independent reviewers |

No UI or user-visible text, API startup, authorization grant, task dispatch contract, schema, migration, install, dependency, DSH or real data changes. New handler tests capture the HTTP callback without binding a socket. Existing controller integration tests, if run, do bind a temporary loopback listener and must be described as such. Existing scratch unknown retry and full production/persistence gaps are not silently declared solved by the preliminary-evidence correction.

## Planned Commands And Side Effects

At the project root, use the reviewed test/typecheck/lint/i18n/build scripts via Corepack pnpm. Focused tests include the three implementations, their shared contracts, existing controller/service boundary and acceptance/executor consumers. Vitest can write caches, synthetic temporary databases and the isolated `.runtime/creation-runtime-modernization/recheck-2026-11-10/stage40/` JSON report. Typecheck/lint/i18n do not migrate user projects; build rewrites local `dist/` and `dist-electron/`. Native tests, checks and build are serialized as appropriate; no real model, real profile, install/packaging or external write is permitted. No new measured performance improvement is claimed by this safety package.

Source identities, exact actual commands, failures/corrections, review and qualification limits follow execution. Feature status remains in_progress/passes=false until its full acceptance and evidence gates are met.

## First Execution And Review Correction

The first frozen package passed 13 files, 203/203, zero failed/pending, using the focused command recorded below with output `stage40/focused-tests.json` (SHA256 `C1F6D21B826E89EF10ED1407D0EBDB1D7552120EE1D26BFC230033699F5CBA02`). This is not final qualification: independent reviewers found current dirty+disconnect/conflict responses were returned before buffer preservation, and dirty-without-content could still freeze. The former reviewer rated the preservation defect P2 and the second rated both missing-buffer protections P1; both are scope correctness blockers regardless of severity label. The initial approval coordinator/test blobs were `63c6b9fbd9d8a987d2b6595b3c0ca2a650f6a87f` / `b7aa4accbb5383a22321fd497f88bff0e595b951`.

The minimal correction retains available current dirty input before failure branches, keeps the manifest pending, and fails closed when dirty content is absent; empty content remains valid. Four focused regressions are required in addition to all existing stale-result tests. Root will rerun the entire package against new frozen bytes and obtain source re-review; the initial green report is retained, not relabeled as covering these missing cases.

## Final Frozen Source

| Path | Git blob |
| --- | --- |
| src/shared/inbound-domain-contract.ts | 7cc3605f6c43a53e01a9f862b0399b2d1c969ed1 |
| src/shared/__tests__/inbound-domain-contract.test.ts | c8d663c228c3c1aa2fdfbeb537ef255f6cd9b35a |
| electron/controllers/__tests__/inbound-api-controller.headers.test.ts | 3192b64b32c830bc42d7724139dbfa02f66f1e19 |
| electron/services/approval-manifest-coordinator.ts | f66375ae5acbdec6a9bb90241e912f250ff556ad |
| electron/services/__tests__/approval-manifest-coordinator.test.ts | 7803660a23604285007d292e05b071318c825b71 |
| electron/services/scratch-creation-orchestrator.ts | d3f79748ed18006fdb18897b57df827606745bdc |
| electron/services/__tests__/scratch-creation-orchestrator.test.ts | 70f2cc28f613ca6c9be96ab70bc27578df166ee5 |
| docs/adr/0050-inbound-domain-api-security-and-idempotency-contract.md | 34015c9e727931c7cbb9d117173d29df9ab5414c |
| docs/adr/0055-batch-approval-manifest-editor-handshake-and-safety-freeze.md | 0f96ecd8c3880df252f0a59d7d7af1680ef57a1c |
| docs/adr/0054-structured-preliminary-acceptance-and-human-review-gate.md | 329e97bba68e1d6578f4756f8a38a6a6a3dfd91c |
| docs/adr/0057-scratch-to-candidate-creation-orchestration.md | 45abaeb1e00d0a16f933837776f35f3d782c4c78 |

## Actual Focused Execution

At project root, Node 24.13.0, Corepack pnpm 11.11.0, Vitest 4.1.12:

`corepack pnpm test src/shared/__tests__/inbound-domain-contract.test.ts src/shared/__tests__/approval-manifest-contract.test.ts src/shared/__tests__/scratch-orchestration-contract.test.ts src/shared/__tests__/preliminary-acceptance-contract.test.ts src/shared/__tests__/autonomous-executor-contract.test.ts src/shared/__tests__/finalization-admission-contract.test.ts electron/services/__tests__/approval-manifest-coordinator.test.ts electron/services/__tests__/scratch-creation-orchestrator.test.ts electron/services/__tests__/preliminary-acceptance-service.test.ts electron/services/__tests__/autonomous-creation-executor.test.ts electron/services/__tests__/finalization-admission-executor.test.ts electron/controllers/__tests__/inbound-api-controller.headers.test.ts electron/controllers/__tests__/inbound-api-controller.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-10/stage40/focused-tests-final.json`

Exit 0: 13 files, 207/207, zero failed/pending. Counts: header callback 14, existing inbound controller 11, approval coordinator 30, autonomous executor 4, finalization admission executor 4, preliminary service 1, scratch 13, shared approval 6, autonomous 7, finalization admission 4, inbound 99, preliminary 11, scratch 3. Final report SHA256 `5E88790F7F6CB95D30DC580E4945E8CF988D34F688DFB116FE9EA2729DC7048E`. The initial command was identical except output `focused-tests.json`.

Existing inbound controller tests used a temporary loopback server and in-memory synthetic tokens/tasks; header callback tests did not bind a socket. Mock workflow outcomes are not real WorkflowDriverAuthority execution evidence. Approval/finalization consumer tests do not prove actual finalization/outbox commits or trusted human identity.

`corepack pnpm run typecheck`, `corepack pnpm run lint`, `corepack pnpm run check:i18n`: each exit 0 after the final tests. No source edits overlap these final checks. Root executed commands; reviewers independently inspected source and reports, not an independent rerun.

## Independent Source Re-Review

baseline_audit and feedback_audit re-read the corrected approval source/tests and unchanged header/scratch scope. Both found the two missing-buffer blockers closed, with no remaining scope correctness defect or required missing case. Detached stale buffers do not mutate canonical state, old finally cannot clear a replacement token, pending buffers do not confer finalization permission, and unknown replay policy is not relaxed. Their acceptance is limited to this safety increment; full API/approval/scratch production, persistence, visible design and model qualification remain incomplete.

## Build And Remaining Boundaries

`corepack pnpm run build`: exit 0 after final quality checks. Existing customResolver deprecation, invalid freeze output option, large chunks, ineffective dynamic import and inlineDynamicImports deprecation warnings remain. Build entry SHA256: `dist/index.html` = `32C57C337EC2206D23D849FD565E1AF22B1E85B3D40AA2424D501CF49527432E`; `dist-electron/main.js` = `DFCCF96E53D31312CF8317835BA6063F8502188CFECC6F136C72337F214A9148`; `dist-electron/preload.mjs` = `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B`. These equal Stage39, consistent with no new production composition; build does not prove these classes run in the application.

`git diff --check`: exit 0. Parsed features remain 35 total / six completed; all four associated features stay in_progress/passes=false. No new browser/Electron measurement, real model, semantic/quality, trusted human, platform or release qualification is claimed. Source/task ownership and idempotency/persistence gaps for inbound, trusted approval/finalization composition, and scratch real evidence/unknown replay remain open. The original two untracked Stage1B3 files and repository-analysis stay excluded.

## Independent Artifact Review

feedback_audit recomputed all 16 source/test/ADR, report and build identities and checked actual 13-file 207/207 results, including the four new regressions. Initial 203/203 and both review blockers remain recorded. It checked feature state, empty index and excluded original files; no blocker remains for this narrow commit. This is independent read-only artifact inspection, not a rerun; root's actual quality/build exits and all stated production/model/platform limitations remain unchanged.

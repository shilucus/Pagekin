# Stage 4A Evidence

Parent: `d33a907e50e4ece4bdaa334a40f6627d4a87cc39` on `master`. Package: DRIVER-001 only. Status: accepted by both independent reviewers on 2026-11-08; current deterministic, static, source-build and two Electron executions passed. Scoped local commit follows record consistency review.

## Scope And Acceptance

[ADR-0032](../../adr/0032-persistent-prepared-chapter-driver.md) freezes the real `prepared-first-chapter-v1` main-owned template: short outline, draft containing that exact outline, composition, authoritative draft save, then `waiting_review`. It is not a migrated production batch, completed machine/human review, approval, finalization, adoption, new UI or headless host. DRIVER-002 retains the complete existing batch/continuation/reconciliation/condense/repetition and machine-review requirements.

| Criterion | Evidence required for acceptance |
| --- | --- |
| Stable steps/commands and exact input before effects | Four native steps, independent model nonces, closed canonical recipe/inputs, conflict/COMMIT failures; fixed owner/key/CAS/query catalog in ADR-0032 |
| COMMIT-before-ACK reconciliation | Real generation/domain receipts, each catalog gap, callback/ACK failures, changed/missing author draft retained and blocked, no replay based on absence from unfinished lists |
| At-least-once driver with idempotent effects | Main-only private issuance, actual four effects across view detach, source/language/model/Skill/knowledge guards, pause/cancel/close/unknown and receipt reauthorization |
| New-copy history is not execution | Two genuine archive/restore generations, allowed partial/full prose, excluded X values and digests, read-only history, repository and registered IPC capability refusal |

This is a bounded source/import/caller/test retrieval fallback; no graph/AST/LSP tool was available. No renderer layout, text, asset, interaction or existing workflow body changes are included. The only existing writer-command change exports two unchanged pure prompt-contract helpers for the isolated scene.

## Team And Review

- Coordinator owns shared IPC/contract/registry/controller, integration, records, execution and Git. All agents are prohibited from project commands, native/build mutation and Git writes.
- Main owner/driver specialist: `gpt-6.1-terra/high`; storage and portable specialists: `gpt-6.1-sol/high`, disjoint ownership. No model substitution occurred.
- Independent requirements/authority reviewer: `gpt-6.1-terra/high`; independent lifecycle/storage reviewer: inherited session configuration, no unverified override claim. Neither implements the changes they accept.
- Requirements finding: recipe language was renderer-controlled. Fixed by a main-only opt-in actual language snapshot, recipe/budget/current-source checks, both language directions and legacy manifest conservation. Closed after current-source, actual-report and independent final re-review.
- Storage finding: frozen copy history incorrectly entered executable run/artifact hydration. Fixed with a separate allowed-prose projection, exact compose/effect/hash proof and explicit unavailable current-save proof. No excluded identity is reconstructed. Closed after actual two-copy/public IPC tests and independent final re-review.
- Reviewer-requested coverage adds actual restored paused/blocked/completed IPC history, refusal to reauthorize incomplete copies, null reference for completed history and old/forged reference controls with zero requests/effects.

## Actual Execution

Environment: Windows x64, Node 24.13.0, Corepack pinned pnpm 11.11.0, Vitest 4.1.12, Electron 44.9.3 and the existing better-sqlite3 native package. Commands run from the repository root. Tests use fictional isolated databases/mock transport and write owned `.runtime`/test caches only. No dependency update, real provider, real user fixture, native rebuild, install/package qualification or remote write is included.

| Report under `.runtime/creation-runtime-modernization/stage-4a/` | Actual result and limitation |
| --- | --- |
| `baseline-schema12-capture.json` | Exit 0, one immutable-parent capture passed; no prior sample repeated |
| `contract-bridge-first.json` | Exit 0, 3 files, 41/41; initial contract snapshot only |
| `portable-first.json` | Exit 1, 57/180; missing central M12 lane registration, subsequently corrected |
| `storage-portable-second.json` | Exit 1, 211/235; incomplete live-row fixture migration and invalid target-pollution rows, not relaxed guards |
| `driver-ipc-first.json` | Exit 1, 2/7; all five IPC fixtures exceeded the existing Windows path limit before product effects; fixture path shortened only |
| `prompt-driver-source-first.json` | Exit 1, 176/177; scene mock wrongly required a current revision for a read-only receipt; source-language tests passed |
| `native-driver-second.json` | Exit 1, 424/426; old-entry fixture omitted the main-language opt-in and one concurrent schema-12 case exceeded its existing 5-second budget |
| `portable-driver-third.json` | Exit 1, 224/228; real historical reads passed, four extra private live-reader error-code assumptions were wrong; production guards unchanged |
| `public-portable-fourth.json` | Exit 1, 269/272; new public controls correctly rejected old references after registry removal, but test expected the later resource error; corrected to exact capability refusal |
| `old-schema12-conservation.json` | Exit 0, two real copies of each normal/donor archive conserved; one restore test passed and the one-off capture test was intentionally filtered, not rerun |
| `integrated-final.json` | Exit 1, 32 files, 1084/1087; schema-13 verifier omitted M11 semantic verification and the runner fixture omitted schema-13. Both corrected; the failed report is retained |
| `migration-tail-repair.json` | Exit 0, 3 files, 45/45; current registry/runner and original M11 corruption/refusal coverage; complemented by the later 33-file union |
| `integrated-retest.json` | Exit 0, 33 files, 1105/1105, failed/pending 0, success=true; current product implementation and regression union |
| `old-schema12-conservation-current13.json` | Exit 0, 1/1; original normal/donor archives each restored/exported through two copies against the repaired current verifier; no capture repeated |
| `driver-fixture-final.json` | Exit 0, 2 files, 48/48; subsequent scene-only project-name shortening and explicit regression; no product-code change |
| `test-style-final.json` | Exit 0, 4 files, 77/77; final scene tests and two lint-only test repairs, zero failed/pending |
| `scene-header-repair.json` | Exit 0, 4 files, 81/81; final four updated source/test files, including held-header and duplicate-arrival regressions |

The schema-12 cutover case was also rerun unchanged with `corepack pnpm test electron/services/__tests__/project-format-migration.test.ts -t "checks old feedback-domain cutover from schema 12" --maxWorkers=1 --reporter=verbose`: exit 0, 1 passed / 41 filtered, 4616 ms. No timeout, assertion or safety gate was relaxed. The final impact union uses one worker.

One-off immutable capture/restoration helper SHA256 `EDFDA188AAA179978BD63D3B0212FFD79F604A3D7CD5285696F97E513BC696BD` was archived byte-for-byte as `baseline-schema12/capture-Wkr8A6/old12-conservation-VG1d13/capture-source.test.ts`, then removed from normal test discovery. Runtime evidence is retained; no directory was cleared. The sustainable tests do not depend on this machine's capture path.

The schema-13 repair explicitly inherits the previously applicable M02/M03/M08/M11 verifier chain; the migration runner does not automatically invoke prior-version verifiers. The old schema-12 callback/fingerprint was not edited. Independent storage re-review accepted this minimal static repair; prior restore execution is not represented as execution against the later registry bytes.

The successful impact union predates a development-scene label correction, two test-only style fixes and the scene instrumentation repair described below. `Driver Unknown A/B` became `Driver U A/B`, staying below the existing Windows path limit. Initial final lint failed on four `any` annotations in the historical-projection unit fixture and a chained `it.each` newline. Exact public projection/repository types and an equivalent call layout replace them without changing production logic or assertion semantics. The unchanged 41 source/test files retain the union evidence; all four final scene/test files have the later 81/81 focused report, and the actual scenes require Electron evidence below. No path guard, timeout, final request-count or effect assertion was relaxed.

Final union report SHA256 `378048BAB5C33EF3F23537BEB7AC65752C65BDA73D6A53B75FBE788FD470A54E`; current restore-only report `3700BFCD80B0BFBAC52815D0B2EFADF96A61EC7B81F31A44AC1564CB2A63646F`; scene-focused report `122B634F05CB3269D94694B356500F4A272EDE253301692F3B6BCB143C16C17F`. Counts overlap and are not summed as unique coverage.

Final test-style report SHA256 `C80893F2BED7D78F3C61F735EEDEAEECC068A4D33B744A55D01C8F05A12E7985`. Root also reversed only the scene-name replacement and its two-line test assertion in memory: the resulting raw SHA256 exactly matched the union's prior scene/test hashes. No original file was overwritten to obtain that comparison.

Final scene-header report SHA256 `023FDC8ACF22AB1149F181B1DF5355A7C50BEF65AE4EBACB97212499D6CDAB1C`. The initial actual Electron happy scene (`driver-happy/workflow-driver-v1-light.json`, SHA256 `C6B33B8149FF0B5AB63AD682E595A67501DE45F9B6B460C895C42D512BE59286`) exited 1 at an invalid `0 !== 1` instrumentation assumption: `guardFetch` records only when response headers arrive or fetch rejects, while the scene held the server before headers. The scene now checks one durable `dispatch-marked` attempt and exactly one received request at the server gate. The final guarded 2/1 request totals, all effect assertions and unknown zero-resend checks remain. New dual-scene regressions forbid reading the completed-header counter while held and reject two simultaneous server arrivals. No fake server, fetch guard or product code changed. The failed run's two requests occurred after cleanup released the gate and are not success evidence; its normal quit and empty external/write/residual arrays are separate observations.

The second one-off helper was independently reviewed before execution, contains only restoration/conservation, and never rebuilds the old capture. Its source is archived in `baseline-schema12/capture-Wkr8A6/current13-conservation-Rra7m5/verify-source.test.ts`, SHA256 `7DED7B2BEE80565C8BBC9148C01AE06B17C5B8E7908EC1A74895444068AC17A8`, byte-identical to the removed test-discovery file. That run additionally checked target schema 13, the original attempt's `unknown` status, exact prefix/tail, frozen rejection, empty workflow tables and unchanged source bytes. It uses a fixed isolated test context, not proof of production session authorization. Final checks span 2026-11-07 and 2026-11-08 Asia/Shanghai.

## Final Commands

The coordinator executed these from the repository root, serializing native work. They use the authorized `pnpm test` filter/report options through Corepack's pinned pnpm; no extra `--` precedes Vitest filters.

```powershell
corepack pnpm test src/shared/__tests__/workflow-driver-contract.test.ts electron/__tests__/preload-bridge.test.ts src/services/__tests__/ipc-client-project-session.test.ts electron/migrations/__tests__/runner.test.ts electron/migrations/__tests__/m11-generation-recovery-tails.test.ts electron/migrations/__tests__/m12-workflow-driver.test.ts electron/repositories/__tests__/workflow-driver-repository.test.ts electron/controllers/__tests__/workflow-driver-controller.test.ts electron/controllers/__tests__/generation-controller.test.ts electron/controllers/__tests__/runtime-feedback-controller.test.ts electron/controllers/__tests__/agent-generation-controller.test.ts electron/services/__tests__/workflow-driver-engine.test.ts electron/services/__tests__/workflow-driver-authority.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/generation-run-service.test.ts electron/services/__tests__/generation-source-binding.test.ts electron/services/__tests__/main-generation-model-change.test.ts electron/services/__tests__/main-generation-plan.no-token-rejection.test.ts electron/services/__tests__/runtime-feedback-authority.test.ts electron/services/__tests__/runtime-feedback-grant-portable.test.ts electron/services/__tests__/project-runtime.test.ts electron/services/__tests__/project-runtime-lifecycle.test.ts electron/services/__tests__/project-runtime-compatibility.test.ts electron/services/__tests__/workflow-driver-portable.test.ts electron/services/__tests__/portable-project-format.test.ts electron/services/__tests__/project-archive-service.test.ts electron/services/__tests__/sqlite-project-migration.test.ts electron/services/__tests__/project-format-migration.test.ts electron/services/__tests__/planning-feedback-portable.test.ts electron/services/__tests__/portable-runtime-freeze.test.ts electron/services/__tests__/generation-recovery-tail-portable.test.ts scripts/redesign/__tests__/workflow-driver-scenario.test.mjs scripts/redesign/__tests__/drive-args.test.mjs --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-4a/integrated-retest.json
corepack pnpm test electron/services/__tests__/verify-schema12-conservation.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-4a/old-schema12-conservation-current13.json
corepack pnpm test scripts/redesign/__tests__/workflow-driver-scenario.test.mjs scripts/redesign/__tests__/drive-args.test.mjs --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-4a/driver-fixture-final.json
corepack pnpm test electron/services/__tests__/workflow-driver-authority.test.ts src/shared/__tests__/workflow-driver-contract.test.ts scripts/redesign/__tests__/workflow-driver-scenario.test.mjs scripts/redesign/__tests__/drive-args.test.mjs --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-4a/test-style-final.json
corepack pnpm test electron/services/__tests__/workflow-driver-authority.test.ts src/shared/__tests__/workflow-driver-contract.test.ts scripts/redesign/__tests__/workflow-driver-scenario.test.mjs scripts/redesign/__tests__/drive-args.test.mjs --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-4a/scene-header-repair.json
```

All five exited 0. The restore-only helper was then archived and removed as documented above; it is not a repeatable normal-suite dependency.

```powershell
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
```

Final executions exited 0 after the test-only repairs; lint includes the color-literal check. Initial lint's five errors remain recorded above. Build writes `dist/` and `dist-electron/` only, not an installer. It emitted alias/output-option deprecation, chunk-size, mixed dynamic-import and plugin-timing warnings; no configuration/dependency change or warning suppression was added.

| Built file | SHA256 |
| --- | --- |
| `dist-electron/main.js` | `7DF7F1D1D08FF5A243533E1D6591AF0842F68EB53B41E3C7782B8419E831D722` |
| `dist-electron/preload.mjs` | `2BC7D3C46BC857CF8A2BC116D04ABF459BA6591A00672A3A9A7BB041D253AF5C` |
| `dist/index.html` | `E7BEA3D06C0B528188022727D1F2D2916BE4E1DAAD33DA21D102FD46B5443C14` |

## Electron Execution

Reviewed fake-only scenes were executed serially from the repository root with the build above. The application writable roots and fictional projects use new isolated driver directories; reports remain under the stage output. The real profile check reads metadata only. No real provider, real manuscript, dependency/native installation or existing-app termination occurs.

```powershell
corepack pnpm run verify:drive -- --scenario workflow-driver-v1 --theme light --out .runtime/creation-runtime-modernization/stage-4a/driver-happy --console
corepack pnpm run verify:drive -- --scenario workflow-driver-v1 --theme light --out .runtime/creation-runtime-modernization/stage-4a/driver-happy-retest --console
corepack pnpm run verify:drive -- --scenario workflow-driver-unknown-v1 --theme light --out .runtime/creation-runtime-modernization/stage-4a/driver-unknown --console
```

The first command exited 1 and remains a failure, as explained above; the latter two exited 0 with the repaired final scene bytes and unchanged product build.

| Final raw report | Actual evidence | SHA256 |
| --- | --- | --- |
| `driver-happy-retest/workflow-driver-v1-light.json` | Two guarded/model requests; four genuine outline/draft/composition/draft-commit effects; exact saved body/hash, material/short-outline/Skill binding and word contract; A continues detached, B unchanged, original steps/receipts resubscribed without dispatch; `waiting_review` | `313CC4F6CE33E7FE1F82EDD111A732E9219EAD8ADA876AEF73D6B768A689CF3F` |
| `driver-unknown/workflow-driver-unknown-v1-light.json` | One guarded/model request; pause in flight, physical convergence, original receipt reauthorization/resume blocks unknown without redispatch; cancel, zero domain step effects or draft save | `C723BB071ADF4993B566497AE35D1ADCFF43B371BBC53AC5E2005CDEC22B0366` |

Each has no `error`, `quit.forced=false` and empty externalRequests, externalWrites, externalWritesIgnored and residualProcesses arrays. Network coverage is explicitly `observed_before_quit`, not a complete quit-period network claim. Unknown may retain a partial artifact; artifact existence is not a committed effect or delivery-success claim. The scene asserts no saved draft.

Root personally inspected both 1440x900 light PNGs, each SHA256 `3D3BFE540BD7D73DD007C23B7E01F473AFB0E07BC09E7EC391BA90738E3456B0`. They show the initial empty library: these direct IPC scenes do not load/update the renderer project/model stores. No chapter count, unit count, timestamp, draft body or task progress appears for cross-screen numeric comparison. This is neither author-visible workflow nor visual qualification; no new visible output was introduced. Both build and the 45 source/test hashes remained unchanged through these two successful runs.

## Immutable Old Source

Actual parent source was bundled in memory from `git show d33a907...:<path>`, not generated by the new registry. Electron profile access was denied in that helper. Captured identities: normal `5a3b32060a5e785f7a86872c6a32c2dc42646c50ba329c14af8a03fd0eccd9e0`, donor `188a053ae4383277590ee57e35c7ec514ecddc6d025225cc1bf8e88b6c1d9900`, 58 tables and 553/554 fields. Original M11 unknown tail, allowed prefix/text and frozen no-execution survived both copies; new workflow tables remained empty. Original archive/database bytes were unchanged.

Capture report SHA256 `5212EB723CED4C4BED8F0C7D8864C4972241631F934E7FB41756C02E2105844D`; conservation report `364CF8FE2B47215F9D9FD9DA4220220131D7741004E545BA95FE0AE1FE4C16D9`. Original normal archive `99d7235c5fab6a26a70f9beca1fe9e441d6ffa3d3611458d17bf791ba66ec328`; donor archive `f7400e2d3644cfd934c7dd8d453636346ba96bfa1c4b2b7a2bc4476a3cc280a6`. Provenance and actual old schemas are retained beside those captures.

## Frozen Source SHA256

The following 45 raw working-tree files, plus the parent, identify the implementation and tests. Records are separate. A material code edit invalidates subsequent evidence until rerun/re-reviewed.

```text
CD724B46501526308713CC7160B2674EC09B2AAF0727FAABB0458353EB348D5A electron/__tests__/preload-bridge.test.ts
AA6BCFCF52D1170DCC0C73A7B839054494844E88A18BEF3B80C7090692661E99 electron/controllers/__tests__/workflow-driver-controller.test.ts
CF1DEDAA6516289CD59720828BE93A199C1AB62B40010C3EA9B65BBB1FFA8FCB electron/controllers/generation-controller.ts
5F1FBD51884FE12F07E9231697C8E50BB2527BDC7C78A828F770C19B09E3297B electron/migrations/__tests__/m12-workflow-driver.test.ts
2A8FF4941F7CD4A8F70901D539F286D12A16BD462D4F6842EBC08BF535C6F59B electron/migrations/__tests__/runner.test.ts
CEF05D900B04DAB0C1A5435BD9FC5135A39BF2EB185B9EAE4F2C06357828CE41 electron/migrations/desktop-registry.ts
88648159B4FBBAB7A10DDA5437C3B0BDE23288CA1C962E9DE4931B6AE7BF6460 electron/migrations/m12-workflow-driver.ts
C0FD679F1804BB39D1943AD945605EBFEFD13A382585A51E9F4ED1FE467A661B electron/migrations/registry.ts
9866565F8A13940F650A0EBD1B269A5B9211E8DA9B163C37681A64A2BDFA5FE0 electron/preload.ts
BA7B2CC85D8583B67E49CB517A28591B85045FDD8E7DED4016F2F9C7EAE2E556 electron/repositories/__tests__/workflow-driver-repository.test.ts
804F602DB619E452249747F9464068A25AC7D0DEFCD986646382544B81A67C3D electron/repositories/generation-run-repository.ts
00300ECD4F360CF24248E90CDEE22386892AE3530AAA6786ABDA2EE631686090 electron/repositories/workflow-driver-repository.ts
6DD15AAC2F62B77E2528479B09B45FA4D013DE0C3BE4E00E897D454806D41B09 electron/services/__tests__/generation-run-service.test.ts
755C7DCD84BAA91C41E612D1836C692621F558A42D6AD9221017DE7178D49A06 electron/services/__tests__/generation-source-binding.test.ts
A6774D198C18E529EEC9418E53B43F1937D9BBCE6D793D3B7C60A67F59FB32D6 electron/services/__tests__/main-generation-owner.test.ts
BFD64848D1D749956B603D9627404B9C9241E70FB11CC23D38E301E035D7B019 electron/services/__tests__/planning-feedback-portable.test.ts
C55B61F9437132BF2B4EBE2E27EFACB17C1901E84A78584C79A58B87B7603DE0 electron/services/__tests__/portable-project-format.test.ts
CD00BFB1464E8A6EE06A6CAC799712D6E0C7C9DDCCD76D81EB2A7FA096C045F4 electron/services/__tests__/project-archive-service.test.ts
E022FB1143EB477F661D5700611BD13E78EC4B63653A17E9E5F3AB59632BED37 electron/services/__tests__/project-format-migration.test.ts
3DF80E83BAA84BE797E5B8FF0D8E76081DB85E9E15ACF268A10A1CC20522E404 electron/services/__tests__/sqlite-project-migration.test.ts
98612B959224D856CB6D31D59D911C59AC54D7F01C207AC15996BCA9A8F5B6CE electron/services/__tests__/workflow-driver-authority.test.ts
E67FD284A4EEDA23EA828CA58A20C24874DD2C004217AB39AD1C41E8793133AC electron/services/__tests__/workflow-driver-engine.test.ts
A7ECCCA4DEA88010483319E99319EC83B4A09C45EA6A720A999D393A2A40BBEA electron/services/__tests__/workflow-driver-portable.test.ts
BAD4EB11935BF87C78A55DB00580E4D67A2FFB922C926673AC71AAF763143492 electron/services/generation-run-service.ts
FAD54689658356F616229FC769A47C1C871A2F148AF2087227205383B81AB573 electron/services/generation-source-binding.ts
E950122F1E804DDBE807763EEB00FE422C7CA65D075970601D9891D5160D58CC electron/services/main-generation-owner.ts
7D8156173AE338402D229CFE5AAE23DD91FDB4856A8B93553AF504BF902DD5B3 electron/services/portable-project-field-policy.json
534AB9BD68A224AE29692F8A1797677F5EFA162AD82BB9E8D5291F05BFB36724 electron/services/portable-project-format.ts
76B48880EEAF6CA320430B660D05C719A00C828EBC3BEFEA53A77BFDBC95600B electron/services/portable-runtime-freeze.ts
EF75BF0FCF5CABFCBFBAD00D779D68A2D2AADC005A0D91AF847795D49479B37E electron/services/project-archive-service.ts
FF01D675BF9EE94E5771386ECFA7CAFD91F82D81A13B5C63949EC41FEC43708F electron/services/project-format-migration.ts
6CF2B93052515B2E895957237EA9E6E6BF2F0F6239A4D45803BD90577B956305 electron/services/sqlite-project-migration.ts
107401DD4A6B612C0AD770DC4AE3D5B5EBA25AF27A617DBB733252FD543BB187 electron/services/workflow-driver-authority.ts
2424B621BF5A82CC8FC1E29713F6057CF5084E81FDFB0A3B15F9B1A436705A51 electron/services/workflow-driver-engine.ts
501857C2B4D4C4FD8CAB4CCDA3380E2B9C7590D8D016B8F5970F20CED6AECB60 scripts/redesign/__tests__/drive-args.test.mjs
CADC746B6C4025E5815F2C9E3317463BB65D8451156A30C5A384395CACE84C5E scripts/redesign/__tests__/workflow-driver-scenario.test.mjs
006FC0FDCD4213CDBE7AF581A7F1042C27C85926B88E759C1D703CD34619CDBA scripts/redesign/scenarios.mjs
CBB3B06E1211DB7F8ABAE8FF3B876264ED5890EB08B7C4AC30814DF9989B819D scripts/redesign/workflow-driver-scenario.mjs
36E9A8BE520DAF5CA99ADC06BFA26388F1200BA70125BF46F63CB124EA93B49F src/services/__tests__/ipc-client-project-session.test.ts
27A4922D73F147EEA91612EEC85CF2D02EB78EEBCC0061F54FF245D2FFC75BAD src/services/ipc-client.ts
3AA1F5091ACF9880BC8FD26692BCEE9899DD48BBAE8F334108DD7D34AF35392C src/services/workflows/commands/generate-draft.command.ts
43FE362EA5E0AA33F476CA98E6C6BB2BB330D9B5910D1E92B9A094814D5C440A src/shared/__tests__/workflow-driver-contract.test.ts
1E2B7EE6C59ABDC0036CF6480773DD0BC78D627D3C6165D52C48AF16190FC0EB src/shared/ipc-channels.ts
25D767B0906E73380E8F228C913CA4505A0214466C839714A66E6FD9600EA6FF src/shared/project-storage.ts
4357C63A22D0BA176BBD3AE9C07BA562C4455115AD47911D2F6D53CEBA95ADB0 src/shared/workflow-driver-contract.ts
```

## Feature Acceptance

Both independent reviewers directly matched all 45 frozen source/test hashes, final union and supplemental reports, current old-12 restoration report, both Electron JSON/PNG identities and three build hashes. The lifecycle/storage reviewer additionally matched the original old-12 archive/database and archived helper hashes; the requirements reviewer did not independently calculate those identities. They accepted DRIVER-001's three criteria and this package's G-CONTRACT/G-STORAGE with no unresolved in-scope correctness blocker. They did not run the coordinator's commands; command exits remain root execution evidence.

AC1: complete stable command/step/input identities precede effects; the fixed owner/key/source-CAS/query catalog is implemented and tested. AC2: original model/composition/draft receipts reconcile every COMMIT-to-ACK gap without repeating a writer or overwriting changed author prose. AC3: at-least-once driving preserves idempotent effects, real detach/re-read, unknown no resend, non-approval waits and frozen non-executable copied history. The real bounded first-chapter template qualifies the driver infrastructure, not the complete batch workflow.

ADR-0032 is accepted; DRIVER-001 is completed/passes=true. Global future contract/storage/design/policy/human/model/platform scope remains separate. The initial staged repository-analysis document is not part of this package or its commit.

## Limits

No browser workflow, real-model literary quality, actual Electron process-restart test, macOS run, installation or supported-platform qualification is claimed. The separately running installed app still blocks a qualified long PERF-001 baseline; it was not terminated or ignored. This package does not complete the 35-feature program.

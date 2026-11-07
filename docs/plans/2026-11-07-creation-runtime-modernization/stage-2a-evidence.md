# Stage 2A: Planning Feedback Internal Kernel

Date: 2026-11-07. Parent HEAD: `b9c3855e87087d3fd0102356ed59e2fba53e7cf3`, branch `master`. The frozen source hashes below identify the tested working version; the next stage log records its eventual commit. Source F2 README SHA256 remains `5302A8930D95DA9CD618BC528DD8D40D99F2C59957CE91B6332BC0E974C8B5C3`.

## Scope And Review

This is a commit-sized internal FEEDBACK-001 slice, not full feature completion. Targets: coreOutline, worldSetting, goldenFinger, protagonistProfile, globalGuidance, writingStyle, premise and worldbuilding. No renderer, IPC/controller, public API, model network, character/prose writer or DSH changes. Missing chapter-range adaptation remains open; no dependent feature is unlocked.

- Immutable F0/C1/C2 records distinguish the original adoption baseline from the actual generation parent. Main constructs the fixed task with consumed author facts, explicit feedback/constraints and actual installed planning Skill. Persisted replayTask, context, source/model/Skill and artifact are checked together before staging. Generic begin/execute cannot enter this operation.
- Adoption validates the actual final field payload, uses the existing single-field ProjectCoreRepository writer and atomically stores before-value/history/receipt. Same key replays the original receipt; changed payload/decision rejects. Source ABA, raw author writes, rollback, same-content adoption, sibling/descendant conflict and restart have regression coverage.
- Accounting unknown is not necessarily delivery unknown: durable complete stop with absent/untrusted usage may stage, but ledger status/liability are unchanged. Missing result, length/empty finish reason, failure, unsaved tail, cancellation, foreign project and unproven task remain rejected. Fixed invocation nonce and late-result/cancellation tests preserve no resend.
- M08 uses only the central migration lane and preserves source data on failure. New fields are classified in portable policy; mixed context/origin JSON excludes machine identities and mixed hashes. History keys are changed transactionally through a namespace disjoint from every original/final/temporary value, not by reserving an input prefix. New copies retain readable history, freeze old execution/adoption, and require fresh lineage for text reuse. Schema 7/8 restore, schema 9, original-source unchanged bytes and second export/restore are covered.
- Independent receipt/source reviewer: gpt-6.1-terra/high. Independent storage/migration reviewer: inherited session configuration. Both reviewed integrated raw source without implementing their reviewed changes. They identified accounting-unknown, transient UNIQUE collision and schema 8 coordinator issues; final static re-review found no unresolved in-scope code blocker after fixes. Root owns the actual command results. No full FEEDBACK-001, UI, model-quality or platform conclusion follows.

## Actual Commands

Environment: Windows x64, Node 24.13.0, Corepack pinned pnpm 11.11.0. Commands below ran at repository root. `test` is reviewed Vitest; tests use in-memory/disposable fictional DBs, temporary directories and `.runtime/.cache`. Compatibility tests build isolated child test modules and create local fictional LanceDB stores; they do not change native packages or use real configurations/models. SQLite read-snapshot helpers additionally create owned short-lived `VibeCodingScratch/ai-novel-writer/sqlite-read-*` scratch children under local application data; children are cleaned after handles close, their parent may remain. No true user project was opened or migrated.

Final successful batches:

```powershell
corepack pnpm test electron/services/__tests__/planning-feedback-owner.test.ts electron/services/__tests__/planning-feedback-service.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/generation-source-binding.test.ts electron/services/__tests__/main-generation-model-change.test.ts electron/services/__tests__/generation-run-service.test.ts electron/services/__tests__/model-execution-lease.test.ts electron/repositories/__tests__/project-core-repository.test.ts --maxWorkers=2 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-2a/owner-source-tests.json
corepack pnpm test src/shared/__tests__/planning-feedback.test.ts src/shared/__tests__/novel-contracts.test.ts electron/repositories/__tests__/planning-feedback-repository.test.ts electron/services/__tests__/planning-feedback-service.test.ts electron/migrations/__tests__/m08-installed-lane.test.ts electron/migrations/__tests__/runner.test.ts electron/migrations/__tests__/m05-installed-lane.test.ts electron/migrations/__tests__/m06-installed-lane.test.ts electron/migrations/__tests__/m07-installed-lane.test.ts electron/services/__tests__/planning-feedback-portable.test.ts electron/services/__tests__/portable-project-format.test.ts electron/services/__tests__/portable-runtime-freeze.test.ts electron/services/__tests__/project-archive-service.test.ts electron/services/__tests__/portable-superseded-authority.test.ts electron/services/__tests__/sqlite-project-migration.test.ts --maxWorkers=2 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-2a/kernel-portable-retest.json
corepack pnpm test electron/services/__tests__/project-format-migration.test.ts electron/services/__tests__/legacy-project-copy-import.test.ts electron/services/__tests__/portable-schema7-restore.test.ts electron/services/__tests__/portable-project-assets.test.ts electron/services/__tests__/portable-project-archive.test.ts electron/services/__tests__/project-open-verification.test.ts electron/services/__tests__/project-peek-readonly.test.ts electron/services/__tests__/m01-project-upgrade.test.ts --maxWorkers=2 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-2a/compatibility-tests.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
```

| Evidence | Actual result | Limit |
| --- | --- | --- |
| owner-source-tests.json | 8 files, 480/480, exit 0 | Synthetic provider through actual main owner, not remote quality |
| kernel-portable-retest.json | 15 files, 262/262, exit 0 | Includes overlapping service tests; do not sum as unique coverage |
| compatibility-tests.json | 8 files, 170/170, exit 0 | Fictional SQLite/Lance/restore and child crash tests only |
| typecheck | final exit 0 | Static only |
| lint | final exit 0 | ESLint and color policy rerun after the final coordinator tests |
| check:i18n | exit 0 | No visible copy was added |
| build | exit 0 | Writes dist and dist-electron; no package/install/desktop qualification |

Reports are local ignored evidence at `.runtime/creation-runtime-modernization/stage-2a/`; the tracked table records their results. Build warnings: existing customResolver deprecation, invalid output freeze option, large renderer chunks, ineffective dynamic import and inlineDynamicImports deprecation. None was hidden or represented as a new acceptance failure.

Earlier runs were failures and remain preserved:

- `kernel-tests.json`: first five-file batch, 96/97; the literal think-tag fixture violated the existing artifact snapshot guard. Fixed the test to assert existing rejection and zero effect, without deleting the guard.
- `kernel-portable-tests.json`: 247/250. Fixed an M07 historical test to compare the same schema 8 state; changed an invalid-version fixture from now-valid 9 to 10; preserved pre-identity/asset/recycle domain meaning by excluding M08 tables and added explicit preFeedbackDomain. The independent review then found and fixed the coordinator branch, with real SQLite success/missing/tampered tests.
- Earlier typechecks exited 1 for multiline test casts, inferred UUID template parameter types and a malformed-value fixture's missing return annotation. Only those test types/grammar were fixed; final typecheck and build exit 0.

Not executed for this slice: full test suite, browser/Electron drive, real model/quality, real author data, native package rebuild/installation, macOS or three-target qualification, remote writes. Strict performance baseline 1B is still blocked by the independently active installed application, and its dependent optimization features remain locked.

## Frozen Implementation SHA256

```text
fba2c483650a2afa394f50b485b2b8c0c5a4173103b0b5eec2d115f6e73d1dec electron/migrations/__tests__/m05-installed-lane.test.ts
1385e3ab133caa979490f82da44ef2f37adf538ca1c3610a472c002d456dac59 electron/migrations/__tests__/m06-installed-lane.test.ts
d581f1511e1da589d422e08eb9c7f9e920a52165962383a67b5f3f3b96700d16 electron/migrations/__tests__/m07-installed-lane.test.ts
6610e1f217efce0bff1830626d2b50d339c58a78a42ebefff2465e9a29b28028 electron/migrations/__tests__/m08-installed-lane.test.ts
780fc4198489a608731d88ac85481486081a084552fd39e58235bd3612337394 electron/migrations/__tests__/runner.test.ts
7258d479e3aa4210d977507b92a2edce0720f8ed62b0c99e4e2aeb7805079f1b electron/migrations/desktop-registry.ts
4222c087cb09ec127838acfbeb90b2df9def723dc143e8d7a7404240f56e8f87 electron/migrations/m08-planning-feedback.ts
87d7a30a54c07ff78315470cf1a5cfe571fa1a21f8dd4589ec74cf305c5eed55 electron/migrations/registry.ts
c92c91d013946331d4d9d1d37aa4f97f2a3e5f6cd3bd71c5812dad96945c9634 electron/repositories/__tests__/planning-feedback-repository.test.ts
8106f29f18770ef360c7034780fcf48071b81f66032587ce701035aa8a37560d electron/repositories/planning-feedback-repository.ts
b800169c8840223d176681ebcab1e405f06a548f47e537a6c1f9f6596242e897 electron/services/__tests__/legacy-project-copy-import.test.ts
a63eb94ffb9b8cd7650ae42458f5cce4f25e7ea2ffa8c70aa1844ba23a4697b5 electron/services/__tests__/planning-feedback-owner.test.ts
2b7734fd11ca4c6e0f0ed4fe136e2412b11afaff924e82eec562cba924e21aaf electron/services/__tests__/planning-feedback-portable.test.ts
a520008c5d8a63d341cbb05d2af0db8c6b99bb44fee03286129660ad738838a2 electron/services/__tests__/planning-feedback-service.test.ts
c24dd894bcadd8fe2938048354d3899a1f0fa8466fd7b59651bb4cf701446a2c electron/services/__tests__/portable-project-format.test.ts
f425ad7df298f8df744af5ce4d73cd377c7a0b2a8bd26db6db23af708b707c6e electron/services/__tests__/portable-runtime-freeze.test.ts
a4902609f8423d451d8963320430eff1b3f79c8f9b3aaffa09b2129320ee3b62 electron/services/__tests__/portable-superseded-authority.test.ts
25f0c6fbe0c3da68292a21a47cca4e5a562f2c47ba12da65706f25894e6fd41d electron/services/__tests__/project-archive-service.test.ts
5a8ead7dd0a54fc90c572aaa434d39bc3ca675e58ff32e4467c7c906bd4ee37e electron/services/__tests__/project-format-migration.test.ts
48d714bb82e97c900df4186edb16c8d013581104f39a9d492a33218c78f474dc electron/services/__tests__/sqlite-project-migration.test.ts
d994918eabb01576ece2ad7fe38af21b1eba641820ba336b3a1bd02444fb53f6 electron/services/generation-source-binding.ts
48487e5d816828455e8dba017e1cc65b89165769b85e4bfb38f56c41a5686a65 electron/services/main-generation-owner.ts
beb6d1aa303bd8d316a1f405186764a810f3174f0c21c30519d6bcb19d129673 electron/services/planning-feedback-generation.ts
426a6a776d059e3be17bd988d3205ffb49cac5217b352fe0a62a1398733901be electron/services/planning-feedback-service.ts
41a3c539282715249d297c0d45e2c3c2782f03e27e60878e53fee4471957490d electron/services/portable-project-field-policy.json
a43c122eab1bd69fb40ffef3807799cc15abeac48a55ecd65f631cc87f3f40c5 electron/services/portable-project-format.ts
f9b580b67524052058c12d2f558491a8b80d11f2e4072247e566288ed0e777cd electron/services/portable-runtime-freeze.ts
b6513f82d12cab77aa106b4dddec27219ead31cae9116b6d569da97935e06244 electron/services/project-archive-service.ts
7850c93cb34546f6d21a726f675bb6ae57a32980d1919f575a253185a0ec76c8 electron/services/project-format-migration.ts
cc0642c2c6e22719f32e124e7eee172803f58c330b5f6c858d576f0225385f92 electron/services/sqlite-project-migration.ts
52e56668b1d99004493d6ffbe833547477f71518842365b93f15ca3cecb23406 src/shared/__tests__/novel-contracts.test.ts
5a73acbab3ecf9cc81d005d4d23638fd74bc3f4bc1f8a2d7bbced6970d659532 src/shared/__tests__/planning-feedback.test.ts
a732904dbbd4ab02fc529e7f56b3d790243e5e19d2d2437548d7d2b24362561b src/shared/planning-feedback.ts
a43d056f3c4a722997ea4d64e12bd086a1f57668efc999a0e761c60bc5ae0295 src/shared/project-storage.ts
```

Built main SHA256 `36f92408495108eae1a20c71fed87af77e9f5b1540c78d6ac1e38fd51ef10a7a`; preload `43cdfd497507e66511a48782e57a4165c524a0c0d1ec2aed118a62e3f7afbd49`; renderer index `fb8565e7768687e0c214f8cd0d6151b10e84af4eca0bf11a616e8a5a476d2964`.

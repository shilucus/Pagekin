# Stage 2B: Outline-Range Feedback Adapter

Date: 2026-11-07. Parent HEAD: `1815d16ae12b15c852b34b0cea06d790439ae5a7`, branch `master`. Parent plus the frozen implementation hashes below identify the tested version without a self-referential commit hash. F2 README and evidence-map remain unchanged.

## Scope And Review

This slice completes the internal FEEDBACK-001 thin candidate protocol together with [Stage 2A](stage-2a-evidence.md). It adds a real existing-outline chapter-range adapter, not blueprint-specific production wiring (FEEDBACK-003), feedback IPC/mode (FEEDBACK-002), UI-002, public automation or approval. [ADR-0027](../../adr/0027-planning-feedback-outline-ranges.md) limits the contract/storage acceptance to this package.

- The main-owned v2 task freezes the selected range, actual core/synopsis/character-architecture sources, installed planning Skill and C1 generation parent while retaining F0 adoption CAS. The existing v1 task/context/binding bytes and eight-target counter remain unchanged.
- Final full/partial/edited payload and range are revalidated on main. The fixed adapter calls the existing synopsis CAS writer in the same transaction as history/receipt/lineage consumption. No candidate generation writes formal facts; malformed, missing, duplicate or out-of-range chapters write nothing.
- A feedback-only exact-span renderer retains original outside bytes, separators, LF/CRLF and recognized old coverage tails. The original generation renderer is unchanged. An indistinguishable author paragraph remains chapter content under the existing parser; no invented tail classification.
- M09 runs only in the central transactional lane. It preserves v1 NULL columns/row encodings, FK chains, idempotent bindings and rollback. Source-version-specific domain projections reject missing/tampered conservation receipts before cutover.
- Portable 7/8/9/10 field contracts, mixed v1/v2 history, partial adoption, old-package restore, explicit new-copy lineage, second export and closed nested JSON projection are covered. Restored history never restores execution/adoption rights.
- Independent requirements/proof reviewer: gpt-6.1-terra/high. Independent storage/migration reviewer: inherited session configuration. Neither implemented the reviewed changes or ran these commands. Both directly checked all 35 frozen source/test hashes and the final report; storage additionally checked built artifact hashes. Both found no unresolved in-package correctness blocker. The requirements/proof reviewer accepted the package contract gate; the storage/migration reviewer accepted its contract and storage scope. FEEDBACK-001 can complete together with Stage 2A; future gate scope remains pending.

## Actual Commands

Environment: Windows x64, Node 24.13.0, Corepack-pinned pnpm 11.11.0. All commands ran at repository root. Tests use fictional in-memory/disposable databases and owned temporary directories; Vitest may write caches and the reports below. Existing SQLite snapshot helpers use owned short-lived `VibeCodingScratch/ai-novel-writer/sqlite-read-*` scratch children. No real project, configuration, model or credential was used. Build writes only local source-build outputs, not an installer.

Final integrated command:

```powershell
corepack pnpm test src/shared/__tests__/plot-outline-contract.test.ts src/shared/__tests__/planning-feedback.test.ts src/shared/__tests__/novel-contracts.test.ts electron/migrations/__tests__/m09-planning-feedback-ranges.test.ts electron/migrations/__tests__/runner.test.ts electron/migrations/__tests__/m05-installed-lane.test.ts electron/migrations/__tests__/m06-installed-lane.test.ts electron/migrations/__tests__/m07-installed-lane.test.ts electron/migrations/__tests__/m08-installed-lane.test.ts electron/repositories/__tests__/planning-feedback-repository.test.ts electron/repositories/__tests__/project-core-repository.test.ts electron/services/__tests__/planning-feedback-service.test.ts electron/services/__tests__/planning-feedback-owner.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/generation-source-binding.test.ts electron/services/__tests__/main-generation-model-change.test.ts electron/services/__tests__/generation-run-service.test.ts electron/services/__tests__/model-execution-lease.test.ts electron/services/__tests__/planning-feedback-portable.test.ts electron/services/__tests__/portable-project-format.test.ts electron/services/__tests__/project-archive-service.test.ts electron/services/__tests__/portable-superseded-authority.test.ts electron/services/__tests__/portable-runtime-freeze.test.ts electron/services/__tests__/portable-schema7-restore.test.ts electron/services/__tests__/sqlite-project-migration.test.ts electron/services/__tests__/project-format-migration.test.ts electron/services/__tests__/legacy-project-copy-import.test.ts electron/services/__tests__/portable-project-assets.test.ts electron/services/__tests__/portable-project-archive.test.ts electron/services/__tests__/project-open-verification.test.ts electron/services/__tests__/project-peek-readonly.test.ts electron/services/__tests__/m01-project-upgrade.test.ts --maxWorkers=2 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-2b/integrated-fixed-tests.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
git diff --check
```

- Integrated: 32 files, 1086/1086, exit 0. Report SHA256 `8bcf46591071f85854c692852bb7c1924ec50cb50e81a0813cdca954be4ff816`. Includes M09 31, feedback repository 109, owner 19, service 9, portable 12, shared protocol 24 and outline parser 70 tests, plus surrounding owner/source, archive and migration compatibility.
- Typecheck, lint and check:i18n: final exit 0. `git diff --check`: exit 0; this is only whitespace checking.
- Source build: exit 0. Existing customResolver, invalid freeze, inlineDynamicImports and ineffective dynamic-import warnings remain; they are not platform qualification. Built main SHA256 `a8b91142a4b5c2a7756f3a67997a53734027b577c1817008cdb79f1be5fe2e79`; preload `43cdfd497507e66511a48782e57a4165c524a0c0d1ec2aed118a62e3f7afbd49`; renderer index `fb8565e7768687e0c214f8cd0d6151b10e84af4eca0bf11a616e8a5a476d2964`.
- Earlier passing batches: `migration-compat-tests.json` 7 files 114/114; `portable-tests.json` 6 files 96/96; initial parser 63/63. They overlap the final integrated run and must not be added together as unique coverage.

## Immutable Schema 9 Capture

A temporary capture test read the immutable Stage 2A source closure with read-only `git show`, compiled it in memory (`write:false`) and created real native schema 9 normal/donor fictional fixtures. It did not run an old feedback producer. The helper, databases and provenance remain under `.runtime/creation-runtime-modernization/stage-2b/baseline-schema9/capture-6Xuk1M/`; the temporary test was removed from source and is not part of this commit.

- Normal schema 9: 55 tables, 527 fields, fingerprint `361b1c5416492d9e4a827119aaf8bcfdea25ecd52fc26e65207c77f901e780d2`.
- Donor schema 9: 55 tables, 528 fields, fingerprint `6d513eed561970b9db78e9b75f7259b383f8e1eeb7194a71fe222dccaec007e7`.
- `identities.json` records the baseline and every compiled source SHA256. Both fixed old fingerprints are pinned in M09 and portable-format regression tests.
- Separately, the service fixture reconstructs the old v1 context field order/system text/task/adoption binding from immutable Stage 2A source rather than calling the current builders. Migration/reopen/replay proves compatibility for this fixed old-protocol data, not actual execution of an old producer.

## Failures And Corrections

Reports are retained under `.runtime/creation-runtime-modernization/stage-2b/`; failed reports are not overwritten into PASS.

- The capture harness first failed because esbuild Go-regexp filters do not support the supplied JavaScript `u` flag. Correcting the harness gave 1/1, exit 0 (`baseline-schema9-capture-fixed.json`). No product behavior was changed for it.
- `feedback-kernel-tests.json`: 210/262. The new outline fixture tried to write derived `charactersArch` through the ordinary author update method. It now seeds fictional derived state explicitly while retaining the production read-only guard.
- `feedback-kernel-fixed-tests.json`: 260/262. Full/partial last-chapter CRLF tests exposed whitespace-only trailing lines around mixed recognized coverage tails. The feedback-specific span helper was corrected; final integration covers both scenarios.
- Independent review also found that the ordinary generation renderer regenerates last-chapter coverage metadata. The dedicated feedback span renderer fixes that outside-range mutation, with raw tail/LF/CRLF and mixed-language regression assertions; ordinary generation behavior is untouched.
- `integrated-tests.json`: 1085/1086. The shared migration-ID expectation still ended at M08. Only its expected M09 entry changed; the same 32-file integrated batch then passed completely.
- Earlier typecheck failed on an unknown schemaVersion assignment and an un-narrowed test union. Validated target-based version selection and an explicit test discriminant fixed them without weakening runtime checks. Earlier lint failed on two multiline `it.each` calls; joining the calls changed no test data or assertion.

Not executed: full test suite, browser/Electron drive for this slice, real model/literary quality, native rebuild/installation, real author data, macOS or three-target qualification, remote writes. PERF-001 Stage 1B remains incomplete because the independently active installed app prevents strict no-user-write isolation; no dependent performance feature is unlocked by this feedback package.

## Frozen Implementation SHA256

| Path | SHA256 |
| --- | --- |
| `electron/migrations/__tests__/m05-installed-lane.test.ts` | `7469e29bd78e2afeda362d78ac1187f85e9671680d010f7770f75a6b93add5d7` |
| `electron/migrations/__tests__/m06-installed-lane.test.ts` | `c5e61b6c49fb271414975a28898b50b6900799f9af1f8e4221b1f6d8b12cdfbb` |
| `electron/migrations/__tests__/m07-installed-lane.test.ts` | `5305d1c57c3eb7dc632d4e17150095a9890a3168e89356eb1a4377ae5a2c74e4` |
| `electron/migrations/__tests__/m08-installed-lane.test.ts` | `7f78d7709a2c8853262d7032e0e4818925a41fe39f63ef631bbdd688270987cf` |
| `electron/migrations/__tests__/m09-planning-feedback-ranges.test.ts` | `e73667829fd09ccd92acfd569970a416f54992ff39c3bcae2fbf5ca3b82754a6` |
| `electron/migrations/__tests__/runner.test.ts` | `616b1f998fb079c10419279edea0893052902216f309294ee8dd57e119c82d38` |
| `electron/migrations/desktop-registry.ts` | `ff4c7ac56525de4d73a05526340f51cd171936987f57d6b62c6a067d8ce06c7a` |
| `electron/migrations/m09-planning-feedback-ranges.ts` | `275903ba449663a3354e072ad57d3ce293f5575db6ee2c5bef6342c4aaea2625` |
| `electron/migrations/registry.ts` | `b51a92f7e72546ea952cd5998535315acfce9945f45929c724f37680f49780c9` |
| `electron/repositories/__tests__/planning-feedback-repository.test.ts` | `c567ddd0320eb1b9c73994f6a8e780e4f01e271f26625bf846b2ebcff70e6169` |
| `electron/repositories/planning-feedback-outline-adapter.ts` | `0f864ca1f7e3c15db437225a7335b3e307240b201835de0c863fbb878a7f5307` |
| `electron/repositories/planning-feedback-repository.ts` | `564824b078379b2de266603624e640e40abd165ef5b9ec4e8db7efaf0f0ba9ae` |
| `electron/services/__tests__/planning-feedback-owner.test.ts` | `25c1edf36c89128c6276ae37a37bf8f8d32de2f44af7e7af64e3ef073adeb930` |
| `electron/services/__tests__/planning-feedback-portable.test.ts` | `328f57b5023f2fecca0fb2f079534369b208a0832821a22f0b8959cd75196e35` |
| `electron/services/__tests__/planning-feedback-service.test.ts` | `0406fcd449dcbb4547e8581f02640007547011e6cb852e66b61f593b625fd4f9` |
| `electron/services/__tests__/portable-project-format.test.ts` | `937f02f98ac488619faaed0e8f4a4f6accd408b88f061ae79b0957429241e940` |
| `electron/services/__tests__/portable-superseded-authority.test.ts` | `f9a549a8ee70a4e3a7ec20b589be493d29e13d577f099657590665c4b311ac1b` |
| `electron/services/__tests__/project-archive-service.test.ts` | `ebfa40dd07b956df1a0fe9661703501259a1a5763d00ce85c8381b5faed1edfc` |
| `electron/services/__tests__/project-format-migration.test.ts` | `3155d9c5fe145ab99d433061f42cd2c2d44209094e221553fe5a4dbbe556081f` |
| `electron/services/__tests__/sqlite-project-migration.test.ts` | `40d50a8739f42b0eee926db29187a661a914b01c28a45f7c7e596345b32e195a` |
| `electron/services/generation-source-binding.ts` | `f0464361f6f95c0d267dcd40f8c759de09405673ccce71d2ee21001689caefad` |
| `electron/services/main-generation-owner.ts` | `fc3659498876662aff5496b4894d7f7cda2085aafdccc0c873c51dd5a9e1b17f` |
| `electron/services/planning-feedback-generation.ts` | `3340c785c855f97a708b71e3bf01c3bff5adb93f3c4841245f7d0c1a21c66e31` |
| `electron/services/planning-feedback-service.ts` | `885c1f64ddb9f3111fc8c2e9abd1801538850a5a9751b0e9b9c91783e0786f1e` |
| `electron/services/portable-project-field-policy.json` | `e3d1fc52df953b22fe8c8137ccb2bef44c53ea011b75dee137596e8876f590a8` |
| `electron/services/portable-project-format.ts` | `fd8935f9af4dc238cd244d8e25f081c949a4ae349352ebb05ea3bb4f989d801b` |
| `electron/services/project-archive-service.ts` | `31ee4aaf20f466e13f8545460bce0975ba4cfecb2ef9e048256e3e95300d8c3b` |
| `electron/services/project-format-migration.ts` | `c8aa7a7771eeef3f04ed57871819e117400823693ffc28627007ca6fac9aa1a4` |
| `electron/services/sqlite-project-migration.ts` | `24f464494fa93bfc79d03b8cf3370edd5fe8a33fb63f366354fe0dfd13e8f9d3` |
| `src/shared/__tests__/novel-contracts.test.ts` | `ddd35e7da091652d1f722c05633a759ae97203aa7d3aff0b8bf95ab0af6596d2` |
| `src/shared/__tests__/planning-feedback.test.ts` | `ec6d8df2aa2709426f7bceee1fd2ec3928f5b1dc369f832d44000b25bec4769e` |
| `src/shared/__tests__/plot-outline-contract.test.ts` | `336ecf3deabd797a67263d424ecf13e0b2afa2f5bf98f7a3cd00cbde62a65089` |
| `src/shared/planning-feedback.ts` | `6c88c04c9eaa638d269182c76437e149c135e92d36f47b6be1a40bcedbc11e17` |
| `src/shared/plot-outline-contract.ts` | `52f8fbc202da8415f87728e71945375911bd4120938e16b75ddf070d545f0f03` |
| `src/shared/project-storage.ts` | `372498536f06091c7979c12b6d038b718c298aae917833e601a45d167a39e44d` |

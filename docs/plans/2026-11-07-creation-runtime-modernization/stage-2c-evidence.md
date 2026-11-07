# Stage 2C: Dedicated Field Feedback IPC Evidence

## Scope And Review

Parent: `319846b3b182d20371d31ad6df1eba64fe7da48a`. The 16 source/test hashes below identify the actual tested working tree relative to that parent. F2 and its evidence map remain unchanged.

This slice adds eleven closed `planning-feedback:v1:*` desktop IPC commands for the original eight core targets, actual registered controller/owner/repository routing and a project-bound nonvisible client. It adds no table, migration, visible page, range production entry, public automation API or human-approval capability. See [ADR-0028](../../adr/0028-desktop-planning-feedback-ipc.md).

Main implementer: gpt-6.1-terra/high. Renderer implementer: gpt-6.1-sol/high. Coordinator owns integration, shared contracts, commands and Git. Independent proof reviewer gpt-6.1-terra/high and session/storage reviewer inherited session configuration have no implementation ownership. Both re-reviewed substantive corrections and independently matched all 16 source/test hashes, the final raw test report and all three build hashes. Neither ran the verification commands. Both found no remaining in-package correctness blocker and accept only this internal IPC contract/portable integration; ADR-0028 is accepted in that scope.

FEEDBACK-002 remains `in_progress/passes=false`: stage-page entry, target dirty-buffer handling, visible candidate/diff/conflict states and trustworthy author-action wiring are not implemented or accepted by this internal package. No dependent feature is unlocked by this slice alone.

## Actual Commands

Environment: Windows x64, Node 24.13.0, Corepack-pinned pnpm 11.11.0. All commands ran at repository root. Reviewed Vitest setup uses fictional disposable SQLite projects, owned temporary archive directories and mocked provider transport. Tests may write local caches/reports; archive snapshot helpers may use owned short-lived scratch directories. No real project, configuration, credential or model was used. Build writes `dist/` and `dist-electron/`, not an installer.

```powershell
corepack pnpm test src/shared/__tests__/planning-feedback-ipc.test.ts src/shared/__tests__/planning-feedback.test.ts src/services/__tests__/planning-feedback-client.test.ts src/services/__tests__/ipc-client-project-session.test.ts electron/__tests__/preload-bridge.test.ts electron/controllers/__tests__/generation-controller.test.ts electron/repositories/__tests__/planning-feedback-repository.test.ts electron/services/__tests__/planning-feedback-service.test.ts electron/services/__tests__/planning-feedback-owner.test.ts electron/services/__tests__/planning-feedback-portable.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/generation-source-binding.test.ts electron/services/__tests__/main-generation-model-change.test.ts electron/services/__tests__/generation-run-service.test.ts electron/services/__tests__/model-execution-lease.test.ts electron/services/__tests__/portable-project-format.test.ts electron/services/__tests__/project-archive-service.test.ts electron/services/__tests__/portable-superseded-authority.test.ts electron/services/__tests__/portable-runtime-freeze.test.ts src/services/workflows/commands/__tests__/generate-field.command.test.ts src/services/workflows/commands/__tests__/architecture.command.test.ts src/services/workflows/__tests__/architecture-workflow-project-context.test.ts src/services/generation/__tests__/main-generation-transport.test.ts --maxWorkers=2 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-2c/integrated-final-tests.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
git diff --check
```

- Final integrated execution: 23 files, 931/931, zero failed/pending, exit 0. Report SHA256 `ac10bfcdc5d415a48140b67059fca2f88196893b13807a83889aacdeecd65f0f`.
- Includes registered IPC 75, source binding 127, main owner 248, feedback owner 19, repository 109, portable 12, wire 31 and client 20 tests. These are included in 931, not additional unique tests.
- Final typecheck, lint, check:i18n and source build: exit 0. Whitespace checking is static evidence only.
- Existing build warnings remain: customResolver deprecation, invalid freeze option, inlineDynamicImports deprecation, chunk size and ineffective dynamic import. No dependency/toolchain or packaging change was made to suppress them.
- Build SHA256: `dist-electron/main.js` = `26ef58d56d00ad7a14b043253e4c86b41222909cd023c1d0a19d3a4dd390d32c`; `dist-electron/preload.mjs` = `43cdfd497507e66511a48782e57a4165c524a0c0d1ec2aed118a62e3f7afbd49`; `dist/index.html` = `8b6d5e3ded810807ccdea2145990e6554105e6e579b4a9aa5da35816f94812d4`.

## Coverage And Corrections

- Actual production client through the registered bridge, owner and real SQLite: F0 -> C1 -> C2, actual parent C1, no formal writes during generation, explicit target-only adoption and idempotent receipts. The separate eight-target cases preserve every outside core field.
- Strict request keys, nested instructions, handles and real IDs: rejects renderer task/source/proof/decisionSource, sparse constraint arrays, range base/candidate/run IDs and non-feedback handles. The generic admission guards and old generation/architecture paths remain covered.
- Session is frozen before work, checked before calls and after awaited replies; main checks original lease/root and exact native DB handle. Stale and late results do not continue into another session/database. No client automatic adoption, retry, nonce/model replacement or implicit recovery.
- Original-project restart discovery and receipt replay: explicitly selected zero-attempt runs may resume only after main revalidation; dispatched unknown work is not resent. Cancel before dispatch and late results after cancel preserve formal state.
- Current malformed Skill configuration has an existing classified source error. Current Skill-byte and DB-fact races trigger the actual source snapshot guards through controlled file reads, while historical input/artifacts remain readable with `sourceStatus=conflict`. Execution still rejects; attempts/fetch do not increase. Other database/record errors are not swallowed.
- Real portable export/restore: old base/candidate histories are discoverable and frozen, old execution/lineage writes are refused, and copying requires an explicit fresh base. Existing privacy projection redacts feedback run binding/sourceManifest; a new copy cannot discover/rebuild old run inputs or use `read-run` to restore their authority. No missing source is fabricated.

Earlier evidence is retained under `.runtime/creation-runtime-modernization/stage-2c/`:

- `wire-client-tests.json`: initial 4-file 56/56, predating sparse-array correction; not final.
- `wire-client-fixed-tests.json`: 5-file 83/83 including original shared protocol; `skill-source-tests.json`: 127/127. They overlap the final batch.
- `integrated-tests.json`: 927/929, exit 1. Two new range fixtures omitted required chapter 1-2 prefixes; the fixtures were corrected, not the production guard. Initial typecheck also failed on fixture nullable values and a generic client handle type; fixes preserve runtime validation.
- `integrated-fixed-tests.json`: 929/929 before final source-race corrections, SHA256 `c9d4b17631da54e46722329ac861330d9554ef5881a0718110847ef9e717be84`. This earlier PASS does not qualify the later changed bytes.
- `integrated-final-tests.json`: final 931/931 after all substantive corrections.

## Frozen Source Hashes

```text
84316b1913d1bfb2a62392a816269adf912cf3fba31bbc70421c05d80bf4f115 electron/__tests__/preload-bridge.test.ts
984e95a364c975a7951657a1afad0b5330180195712c73dcc629fc3c97a50523 electron/controllers/__tests__/generation-controller.test.ts
77742b5059b9d29f7271821d745231fc4c7b14c57705736a92cff5900308e890 electron/controllers/generation-controller.ts
df060b78d407c743487a50468db73537cb670b3c43510113e894bebc669f10db electron/repositories/planning-feedback-repository.ts
bb8bf93d45cc459cc25af111a38e68dbe8bb5a774a10f960b901a7f0bb687e86 electron/services/__tests__/generation-source-binding.test.ts
0c247b27665461359050389fec88f7af9803de9ddcf2184dbcce16d5fd770a52 electron/services/generation-source-binding.ts
bc14bf18f69dc0e02709ed2c1a3b6d2f20d95375483029fab2e30553636eca37 electron/services/main-generation-owner.ts
055e0b26569f32d175a5ca30c25c908736e1a633611bff94af7b6187477ea1d5 electron/services/planning-feedback-service.ts
f28e3ac1a4f5bac48170b1a7f3f4ea47be82d2f0c710a2ff41ba4ba3b25b4ffb src/services/__tests__/ipc-client-project-session.test.ts
e1067d7c4006d2e1cb80bcd02634452cea85b9830dd65524fb9cc67f75fb2d4c src/services/__tests__/planning-feedback-client.test.ts
45c5d8cd253d1037593dd99a0b854f6ec60ba2738b8f50372919295c9271e648 src/services/ipc-client.ts
575076dcc403238640e913a2eb6b48f1130715ebf0158505d79dc929dfca2671 src/services/planning-feedback-client.ts
ba924348e5bfe8830021d2ab757c937023db5e32dd0a33121cb477c13c1d9146 src/shared/__tests__/planning-feedback-ipc.test.ts
1f4d261887eb4e9ced7cc3863a3026626911d0bcbadfac1705500d7ccef51ad9 src/shared/ipc-channels.ts
012175ac968c64903ecdc796441116fab9cdb5607237854579cf065fac31e74f src/shared/planning-feedback-ipc.ts
8b54b0f9e08f1e5d3309ef7c4f293698358e8ff8fe1b5679e0551a78784f37ea src/shared/planning-feedback.ts
```

## Limits And Rollback

No full-suite, browser, Electron interaction, real-model, literary non-regression or target-platform qualification was performed for this slice. The actual IPC harness uses the registered production handlers and real SQLite, not an Electron process or a visible author workflow. F2 design/dirty-buffer and later policy/human/platform gates remain open.

Rollback is disabling the dedicated entrypoints/client while preserving the existing generation paths, immutable candidates and receipts. Do not delete history, downgrade schema, reconstruct redacted sources or resend unknown requests. The protected initially staged repository analysis is outside this package and its commit.

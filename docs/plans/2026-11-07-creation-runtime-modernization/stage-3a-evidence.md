# Stage 3A: Project Runtime Resource Routing

## Scope And Status

Parent: `34b13c33efe8f5bc83b080be068e69d4d2f44b18`. The source/test hashes below identify this increment relative to that parent. F2 and its source evidence map are unchanged. The frozen package completed focused verification and independent re-review against all three RUNTIME-001 acceptance criteria. The coordinator records its resulting commit in the implementation log after checking the committed blobs.

This internal package captures native DB/root/identity/epoch resources, separates view leases, routes generation resources explicitly, and classifies unadapted legacy operations with a whole-operation lifecycle interlock. It does not grant background dispatch, migrate a complete durable workflow, remove the existing UI cancellation/wait protection, or add a second writer host. See [ADR-0029](../../adr/0029-project-runtime-resource-routing.md) and the [entry matrix](stage-3a-runtime-compatibility.md).

The existing `project:open` remains a single-book compatibility switch. It rejects retained/busy/multiple/pending/closing resources before target effects. B's native transaction commits before view/session publication and release of only its captured idle, non-retained A. The explicit `project-runtime:v1:open-view` retains resources through the same grant/recent-reference and latest-request boundary, with an exact preload namespace whitelist. Neither a resource epoch nor retained policy authorizes an old UI lease.

No table, schema/manifest/storage version, grant, portable archive field or persistent retention policy is added. Runtime handles, prepare tickets, epochs, retained flags and delete-recovery lineage remain process-local and are not exported. Existing portable authority/freezing and unknown/receipt behavior are retained; partial deterministic regressions are not a new original-project recovery or portable-new-copy execution qualification.

RUNTIME-001 is `completed/passes=true`. This satisfies only that dependency for RUNTIME-002/003; their own contracts, execution, storage and workflow criteria remain open. Real-model quality and three-target native/installed qualification remain separate open gates.

## Feature Acceptance

Both independent reviewers separately rechecked the original three criteria after noticing the coordinator's earlier internal-only label unnecessarily included downstream grant/driver requirements. This is an explicit acceptance correction, not a new implementation or a relaxation of F2. RUNTIME-001 has no feature dependencies; RUNTIME-002/003 and DRIVER-001 depend on it, not the reverse.

| RUNTIME-001 criterion | Evidence and accepted boundary |
| --- | --- |
| A/B asynchronous work captures resources; old open/close/finalization cannot damage A | Native identity/root/DB capture; generation late/cancel settlement regressions; actual retained Electron A/B request/receipt isolation; old busy/retained open and close refusal; registered finalization/backup admission. These are complementary tests, not all one Electron scenario. |
| Every old entry is migrated/adapted/refused and old workflow protection stays | Accepted entry matrix, source/caller cross-checks, whole-await legacy interlock; actual ordinary renderer/main switch and old generic role/draft read/write; no global removal of cancellation/wait protection. |
| Long chains retain identity/DB/closing state; any added persistence meets 7.8 | Captured generation resources remain busy until physical settlement; release checks, flush/KB close/native ordering and failed-close quarantine. No new persistent table/field/version or authority is introduced, so new-field migration/classification is not applicable; existing portable freeze tests remain. |

Package-local G-CONTRACT is satisfied by accepted ADR-0029, the versioned literal and exact preload/session boundary. G-STORAGE is satisfied by the explicit no-new-persistent-state assessment and preservation of existing portable protections, not blanket acceptance of future grant/driver storage. `contract_review`, `deterministic` and `electron` evidence are present. No background grant, complete multi-book workflow, quality or platform gate is marked passed.

## Team And Independence

- Host/access implementation: `gpt-6.1-sol` / high; controller implementation: `gpt-6.1-sol` / high; generation/KB capture: `gpt-6.1-terra` / high.
- Renderer recovery implementation and the actual store/main integration-test owner inherited their active session configuration; no unverified model override is claimed. Coordinator owns shared contracts, remaining compatibility adapters, records, commands and Git.
- Independent proof reviewer: `gpt-6.1-terra` / high. Independent routing/session reviewer inherited its active session configuration. Neither owns production implementation or runs the verification commands. The host implementer separately reviews renderer changes that it did not implement.
- Review checks requirement fit, actual callers, canonical/native/session identity, lifecycle reentrancy, cancel/physical-settlement lifetime, SQLite COMMIT failure, partial release failure, grants/paths, portable boundaries and test gaps. Agent agreement alone is not execution evidence.

## Visible Output Evidence

No new layout, wording, asset, candidate/adoption UI or background-task UI is introduced. These existing behavior changes use F2 sections 4.3/4.4 and the existing unsaved-buffer/session contracts as their explicit requirement source:

| Existing output | Difference in this package | Evidence boundary |
| --- | --- | --- |
| Failed deletion after a real close/reopen | Only an explicit same-book `restoredSession` rebinds ordinary buffers/tabs to the fresh lease; failed or absent restoration detaches editable binding and retains buffers | Existing delete/close and unsaved-buffer protection; no new delete dialog or copy |
| Inactive ordinary chapter/setup exit save | Existing registered handlers can follow consecutive explicit delete-recovery lineage, but not an ordinary reopen, another book, old planning proof or AI callback | Four actual browser cases; not general old-session reauthorization |
| Existing setup tab | Its normal navigation entry freezes the current lease, making the same recovery boundary enforceable | Existing navigation; no layout or label change |
| Ordinary single-book open | File tree, cast, draft and configuration loading/saving remain usable after A-to-B switching | Actual store-to-registered-main fixture; not retained IPC-only evidence |

New states/views under UI-001/002/003 still require their own exact design evidence. No pixel-level or cross-viewport visual acceptance is claimed.

## Actual Execution

All commands run at the repository root with Windows x64, Node 24.13.0 and Corepack-pinned pnpm 11.11.0. Vitest uses fictional disposable SQLite projects and reviewed fixture transports. Native tests may create owned junctions and temporary archives; the real renderer/main test uses the production Windows PowerShell/C# file helper, including possible temporary compilation caches. No real configuration, work, credential or model is used as a fixture.

Browser execution uses the existing `AI_NOVEL_VITEST_CHROMIUM` override, restored in `finally`, pointing at already installed Chromium 149.0.7827.55 (cache 1228). The pinned default Chromium 1217 is missing. No browser installation was performed, and this substitution is not pinned-browser or Electron qualification.

- `compatibility-switch-retest.json`: 10 files / 293 tests passed, zero failed/pending, exit 0. Includes 36 native host, 19 access, 82 project context, 14 actual native open, 46 database context, 78 generation, 3 direct KB, 3 preload, 7 IPC client and 5 driver orchestration cases. These counts are included in 293, not additional tests.
- `renderer-main-switch-tests.json`: initial actual 4/4 through store, real IPC client, registered main handlers and real project-service/character/draft stores. Its later explicit nullable-guard correction is included in the final wider run, not automatically accepted by this earlier result.
- `renderer-browser-fixture-retest.json`: final current browser bytes, 3 files / 137 tests passed (4 delete recovery, 75 planning recovery, 58 knowledge), zero failed/pending, exit 0. Existing React act warnings remain disclosed.
- `integrated-final-tests.json`: 63 files / 1434 tests passed, zero failed/pending, exit 0. Includes the corrected nullable guard in all four actual ordinary-switch integration cases and the native TEMP-fixture correction. The later driver-only changes are accepted by their separate retest below, not this report.
- `driver-path-retest.json`: 2 files / 28 tests passed, zero failed/pending, exit 0, including the latest 6 scenario cases. Counts overlap earlier runs and must not be added as unique coverage.
- `pnpm run typecheck`, `pnpm run lint`, and `pnpm run check:i18n`: exit 0 after the documented fixture/type corrections. `pnpm run lint` was also rerun after the driver-only fixture correction. `pnpm run build`: exit 0. The existing Vite customResolver/inlineDynamicImports deprecations, invalid freeze option warning, large-chunk warning and ineffective dynamic-import warning were retained, not hidden or treated as new qualification.
- `pnpm run verify:drive -- --scenario runtime-routing-v1 --theme light --out .runtime/creation-runtime-modernization/stage-3a/electron-runtime-path-retest --console`: actual Electron, exit 0, one loopback physical fetch, four legacy categories refused before effects, stale A UI lease refused, A receipt/artifact/ledger recovered without a second dispatch, B and A formal outlines unchanged except B's explicit edit. `externalRequests`, `externalWrites`, `externalWritesIgnored` and `residualProcesses` are empty; normal quit (`forced=false`); owned isolation root cleaned. No real model or user project/config was used.

The coordinator inspected both failure screenshots and the successful 1440x900 light screenshot. They show the unchanged empty shelf because this scenario invokes registered IPC directly, without opening a book through the renderer store; it is not evidence of multi-book UI or complete visible workflow behavior. No changing chapter/count/time values appear to compare. Ordinary renderer switching has its separate actual four-case integration evidence. No dark/mobile or pixel comparison is claimed.

| Artifact | SHA256 |
| --- | --- |
| integrated-final-tests.json | c255e2deda5396b08b1cb12cb5012f903ac7d5da2ff6f5a64b56ed67da4d9e17 |
| renderer-browser-fixture-retest.json | bb9d15b98e662eede0c1327b2acd8023b9b0d00d6abb591e301f785691ed9dcc |
| driver-path-retest.json | d67ad9267d157381488a7ee781d5f1bdf2bae9031ef127110ec24e2becd3a0e1 |
| electron-runtime-path-retest/runtime-routing-v1-light.json | 1036a8a80e0e313ea5914b2102894288bdcf04037baa464eef1d697c6acdd37e |
| electron-runtime-path-retest/runtime-routing-v1-light.png | 3d3bfe540bd7d73dd007c23b7e01f473afb0e07bc09e7ec391ba90738e3456b0 |
| dist-electron/main.js | 7f20a98963f487cfb64ed72a807f6eb1931f5c0dac25f5e03d2c81705a8ad889 |
| dist-electron/preload.mjs | 80a80e867f33ba16dedfec2a1aa358cc464bc8784df398141b3f372f6fa8b5bb |
| dist/index.html | e9c1d075ab8a36cb1c920d20880c18bd4a154a99a87d0e310d8d25c8840f5971 |

Both independent reviewers checked the raw final report, all 79 source/test hashes, the later two driver hashes, the isolated Electron receipt and build hashes. No unresolved correctness blocker remains for this internal package. They did not execute the commands; recorded exit codes are the coordinator's actual execution evidence. The host implementer additionally reviewed the separate renderer recovery implementation and fixture corrections, not its own production module.

Raw reports and command logs are retained under `.runtime/creation-runtime-modernization/stage-3a/`; generated files are not product facts or committed source. The final wider selection is the sorted union of test-result filenames from `integrated-backend-tests.json`, `driver-snapshot-tests.json`, `renderer-final-tests.json`, `compatibility-switch-retest.json` and `renderer-main-switch-tests.json`. The command checks exactly 63 files, each inside this repository and matching `.test.ts/.test.tsx/.test.mjs`, before passing the array as arguments to `corepack pnpm test --maxWorkers=2 --reporter=json --outputFile=.../integrated-final-tests.json`.

## Corrections And Failure Denominators

- Prepare-time import fencing and controller continuity/core/duplicate-finalization writes moved into the accepted native transaction. Native deferred-FK COMMIT failure leaves A's original handle/epoch/lease and B's pre-transaction domain snapshot unchanged. Existing schema preparation/migration and separate recent-project metadata are not represented as cross-store rollback.
- Early 139-case routing run passed 130 and failed 9 before admission because the new fixture wrote the read-only outbox view. Only fixture seeding changed to the existing `_all` table. Early generation run passed 636/647; the existing handle/binding UI-lease epoch was restored instead of substituting resource epoch. Existing remaining safety limits were retained.
- Early wider run passed 318/329; obsolete import tests attempted a lifecycle switch during an admitted asynchronous legacy operation. Tests now assert that refusal, explicitly revoke their old lease and always drain pending reads while preserving the original no-cross-project-write assertions. The actual import retest passed 18/18.
- Early controller run passed 166/167; its closing-delete mock incorrectly returned a closing DB as open. Only the mock was aligned with the actual getter contract. Native transaction regressions remained real SQLite, not mocked COMMIT or source/writer acceptance.
- Browser failures were preserved: default browser launch executed no tests; initial delete recovery passed 59/60; the later three-file run passed 135/137. Independent review found missing first-character reload, repeated-recovery lineage, the real setup-tab lease, and inactive exit closures that called the active-session capture too late. Targeted fixes retain old AI/proof rejection, author buffers and positive save/dirty assertions. New finalization-snapshot and planning-recovery tests do not claim a full fresh finalization commit.
- A P1 ordinary-open regression escaped the early passing backend run: retaining A made B's real legacy file/cast/draft loads fail, and later old workflows remained unavailable. The separate compatibility/retained entries correct that route. Four actual vertical cases plus registered single/multiple-runtime legacy gate tests close the identified bug, not complete KB/import/finalization workflow migration.
- The first new compatibility batch passed 292/293. A test's transaction-external fault-injection tables polluted the persistent schema, so real reopen correctly rejected `UNRECOGNIZED_SCHEMA`. Only those tables became connection-local TEMP tables; real deferred-FK COMMIT failure, retained policy, close/reopen and new-handle assertions remain, with an added main-schema cleanliness assertion. Production schema validation was not weakened. Retest passed 293/293.
- Static failures included fixture callable/union/nullability errors, a stale unused rollback parameter, React test publication during render, and unsafe finally throws. Fixes preserve behavior/assertions and replace driver cleanup with explicit outcome/error aggregation, including cleanup-only and double-failure regressions. No lint rule or safety guard was disabled.
- The first two actual Electron attempts failed before project creation. `electron-runtime/` lacked the detailed creation receipt; `electron-runtime-diagnostic/` recorded the real `ProjectStoragePreflightError`: the fictional name produced a 90-character root, beyond the existing Windows 85-character limit. Only fixture names became A/B (74-character root); no production path check or common scratch root changed. The scenario now preserves the creation error and tests refusal without closing unowned resources. Both failed attempts exited normally with no model request, external write or residual process; both reports and screenshots remain. The corrected actual attempt passed as recorded above.

Earlier reports remain evidence of their versions only. The earlier 52-file 1264/1264 backend, 4-file 81/81 renderer and 6-file 51/51 driver/snapshot runs predate compatibility corrections and do not accept later bytes.

## Frozen Source And Test Hashes

```text
3c7988d9e282265c3d97526b7ce534c44875fc2b8b6c1c49f0cb410b0261c354 electron/__tests__/ipc-handlers-character-avatar.test.ts
efa67630392f86ec9e312dbdc3f49b1f0d92092b063c419f2a9cb8a2b3dc3fc5 electron/__tests__/knowledge-base-runtime-authority.test.ts
4a29618bfa809a7b09b7021647dc74d92648701ec15907065c384f9557617771 electron/__tests__/preload-bridge.test.ts
98fd60be94a97ce11743f0ed8193c21538fc5165a73d0db8d62ed5219b0dc06c electron/controllers/__tests__/character-avatar-controller.test.ts
d2321d503472eb0203bfcb2e125ecd77ad3e259f2504ea704b3f1825cb0ece98 electron/controllers/__tests__/cloud-backup-controller.test.ts
da43d968bd74fcdcf218b98a6b7cf13f2f1c953653606357ba74db1f6a502cf8 electron/controllers/__tests__/db-controller-project-context.test.ts
e2e3206d60750f34549fae03b51e9d2b4a0be0176027fb88e89496275c881e87 electron/controllers/__tests__/fs-controller-project-boundary.test.ts
eb9ac1037dd19013a35b9072b03a7b9a889a65b60b10ddb80233b4177b028a93 electron/controllers/__tests__/generation-controller.test.ts
d3d2b313190825cb8aa3513bd58e1d4f858204bf466c7043f72d95618dd56273 electron/controllers/__tests__/import-controller-persistence.test.ts
0b0b007a9a2369b3da85b3a5ab16ed9d781cb181f12d12566d1946f0698ae345 electron/controllers/__tests__/kb-controller-migration-barrier.test.ts
5226fcf8614e0f66d3e2c633c94c70754134f34015877c84acb2a239caafcb05 electron/controllers/__tests__/kb-controller-project-context.test.ts
3f49fd52c2f7f433cdb1ad3aa6b3fed964e3a47f468c9fb122668da45066d2d4 electron/controllers/__tests__/kb-controller-read-failure.test.ts
af3f2e11a06f9466c4d77d7a38502cf0ede184e7fbf11ac94053ff127c201cee electron/controllers/__tests__/project-archive-controller.test.ts
450921aaac67002c150525383fa1266dc9f2125b9a94e20d66c69765cb82bacd electron/controllers/__tests__/project-controller-context.test.ts
a6ba97578ae6492c78446392332e8c4f389a3df8906f9ca02129b6d450aee00c electron/controllers/__tests__/project-controller-open-atomicity.test.ts
750c53cc447328e8ebc7f6d69b3d0130c4b1ec825c07eb3e6d8885b30d4df146 electron/controllers/__tests__/project-switch-renderer.integration.test.ts
7f1a41fdf1fb3b1c75de833e09c365ca16235a3151c64b8aa7573eea30f89d15 electron/controllers/__tests__/runtime-compatibility-controller.test.ts
e4281698f341a0c2c52ba86349711153ba379927d395b612eed10271cac4b5d5 electron/controllers/chapter-lifecycle-controller.ts
df093b26e7a68e7b55bace9355a3d13af8e0934e6eff966f6389db3376d7572b electron/controllers/character-avatar-controller.ts
4680988b2d312dde5628c2de4b7054fe4b0eedafd51318e8b38b9a407c9fa101 electron/controllers/cloud-backup-controller.ts
9e43ce3bdca19ba8abd8b6259e2b603b6e208cb7b3d8ebcfd043422426f903e3 electron/controllers/db-controller.ts
f0f78526697482316796832f0929d96eb105958d7d475ad3bd3b7b035a16b35e electron/controllers/finalization-controller.ts
c70b7872222b96877bd67063a22b47ee92d52c893cf5123223b4bc18486061f8 electron/controllers/fs-controller.ts
703afa448264b4622066348f16514c0d20124273edcb264a88d65fcc461fa1d6 electron/controllers/generation-controller.ts
c6a6ac92d7550677254895e2007bebde848d56f4a42e3078ee2b29107f5f809c electron/controllers/import-controller.ts
6052cda89151228cd218d4019e236a5612231c2de1619030b8f8ad5e19c85ac6 electron/controllers/kb-controller.ts
cb2704a1f3218f7687c5e4ed5679f185e21b72c0966088e905275fcdb950636c electron/controllers/project-archive-controller.ts
fb97fefedfef3a38eea1f32f221afbaeb875ff208ceaecf5bbec5d5253af0bf0 electron/controllers/project-controller.ts
4e4c6f62c11b652dce970b9cdf5a1fb383848a4911276445f4a80fb4de102041 electron/database.ts
8f6aa605a82e00c2dabe3f9f3084524a158c0a66f38fd5f4ef2aa999bf74ee62 electron/ipc-handlers.ts
03671fe0c01acc486fb278e8485ecb70948823226fa84899d0956658dff4e870 electron/knowledge-base.ts
9b2bd99c7f62d850983a82f4dfd99d8130b238afcace4d7a78704bf9f2c0e891 electron/preload.ts
998cae9d18050eb3482f79a86809229ae4f4ef0036b26aa556823b011b1b4e68 electron/repositories/__tests__/runtime-explicit-repositories.test.ts
21abcae8b47278796f6b2729eed9c4800705c8d092a1af682389d6685d298a0b electron/repositories/finalization-repository.ts
8a0ef67d66aea58832f75d77a9c60d6f6f4859e20746dfcd1520a5684105c3b0 electron/repositories/post-process-repository.ts
f7ba4a4be4f6b54d25ee4961bb5106a27fd0a902ae9bfa42fc7bef3a3da3582a electron/repositories/project-core-repository.ts
dbd5439dc37646a3c3f81513449dd1f9d447b8ca6a48cc413cd72ae07eb4a811 electron/services/__tests__/agent-generation.test.ts
9de2b192e430228eef66884eef0852737475bfd13a587bae7bb767b9319547d0 electron/services/__tests__/editor-inline-generation.test.ts
3a1281cccade04d652fdabe477054c0582156f39f232beb23a90e231cb89f15f electron/services/__tests__/finalization-generation.test.ts
24af98f33756febc944c0b0556171bc4564e9759e73f016fd037b7853f4931b6 electron/services/__tests__/finalized-character-generation-proof.test.ts
054520975dc638d9d2f6d2c87b14ffd52341ef765aa9abdbc8f5b26bf40da426 electron/services/__tests__/finalized-character-generation.test.ts
c84df421f1294b9e70ade38e611f136d33fe21418ce90032bad676473a1c567f electron/services/__tests__/graph-generation.test.ts
0955de7542e725b203b5873bf5a486b5de1fe460192ad987a0b188e49b88dfec electron/services/__tests__/import-generation-fixture.ts
4299957eda08910b41872bf74727cb6897315810234f331bf708d3950b0eec35 electron/services/__tests__/import-generation.test.ts
6a7f3a392970e0eacf2c4fe26c73daeba35c1e984e09d31abbcc65fe3a725a33 electron/services/__tests__/legacy-roster-generation.test.ts
ca78c1516083a56fa7d0e2875a1770df6cee6082307e722d9e09cdfa8d6705ad electron/services/__tests__/main-generation-model-change.test.ts
98e653ba30127067cfee1339b0db4805b760ee63dd310016258117f9fa794ff5 electron/services/__tests__/main-generation-owner.test.ts
27896742f9c0b4cdbf75657dc5591b730abe2bacb1f4981daa4f62137d208e58 electron/services/__tests__/planning-feedback-owner.test.ts
526a9e67d65f9af5838bdbd08a12afba7da96b06a80246febcf5cb00d7b32374 electron/services/__tests__/project-restore-service.test.ts
f2a273b7961bdfa1fdae483fe55200235d3c103a7759cf86607363d9fada314c electron/services/__tests__/project-runtime-compatibility.test.ts
600eb0be821a1dd11403075e47df839f803fb1c1d5a582a3882bc98fe224e89f electron/services/__tests__/project-runtime.test.ts
1283025618bc891743efbd42102dd53799a495148e072008b6467336c701a45f electron/services/__tests__/review-revision-generation.test.ts
196a7ed97c16162b1dadacf4b809b424baeb6143fb64616587cb494d960cb8db electron/services/knowledge-source-gate.ts
f2561990b55612bc066f2784d5ee6a953a7eeb2793507501cea82f23e108f1b8 electron/services/main-generation-owner.ts
3bf23638df6833ac45c3fe807e5a2baef2f611a31797c03d75fafcaf1b460c5c electron/services/project-access.ts
0297cdb89703fa68fbbd71affd22e3f24ae9c9a7c35a4ffac602231872e23a17 electron/services/project-data-locator.ts
fa218c77e65a9018c34b7ac5689c1291f0f6ad55e62968f08847785989ad9371 electron/services/project-runtime-compatibility.ts
c47b454556df4e203d954ed1272a2af6f5e1c92a22f817df9cf716cb862cdd33 electron/services/project-runtime.ts
bfdb7f9d7d40274502ebfe1e70cde14b626c4365b794cff801201cbb4eab68c7 scripts/redesign/__tests__/drive-args.test.mjs
8e4aaecf2b04f50cb85ae982ddcb6bd8da7bf62654f1c6740a26fd7b8ac77354 scripts/redesign/__tests__/runtime-routing-scenario.test.mjs
4a2cedb9490c632f67383eca76944bc04d3dd6a85baaed186aa5686d77a21b4a scripts/redesign/runtime-routing-scenario.mjs
e854615652e0183f3f4058a586829f61127546cfd3b1fce9e4621074b8ad41a4 scripts/redesign/scenarios.mjs
a6df5ead80542fb8248f6318c29e25eb0663120c437c2d734db574d1a6f5e2cc src/components/editor/__tests__/delete-recovery-save.browser.tsx
326152d388c26dfd694d1d0e47c907e44fdc6fa72ef437397dab687cebc4a9ae src/components/editor/__tests__/planning-recovery-editor.browser.tsx
7d172ae5dde4053a76492ed5c993c06194a6fff267ca1f09edf68cf8bcd55751 src/components/editor/use-draft-actions.ts
6472680a7c0ecc05204811f452b4b410d0c451bb0fb2c4261ffb2350f2a2b6bb src/components/editor/use-novel-config-form.ts
f39d2723cacf6a7bd8ab78b63cac9937632f3b429176a898036068054e2f51ce src/components/stage/knowledge/__tests__/knowledge.browser.tsx
8f767f9701bd8e4179382c6f9149472c2a6dce3aae0449f478d14fb3c8a462b1 src/components/stage/knowledge/use-knowledge-base.ts
7101db7bb1c20b44298c62ebbc554d497ccbcefb8ef58ab6152bbce7c47a0b67 src/services/__tests__/finalization-snapshot.test.ts
7e5c787ea13feba67aa310186ab6b411ac5ce15a2fafa62b28cd6a271f683f23 src/services/__tests__/ipc-client-project-session.test.ts
174f80e1f03b970bb9fb4888aac2d7fd92f2fa284047b6c118a7565715626696 src/services/workflows/commands/__tests__/finalize-postprocess-character.integration.test.ts
4aac71d2dac744632234e7efa122e6780cc41536efdb4055a990bcf8b19f0a9c src/shared/ipc-channels.ts
9cfeb3e5bbd41a3f9630e118e08ab39eb58b509943179e0d6b7236e79e379d8b src/shared/project-runtime-contract.ts
73e5f890444b71f794c92cbf97addc99d5b25df9585da71627a432038f205189 src/stores/__tests__/character-project-context.test.ts
c6e9339b8431a086e864ac55e82aa8a403c9007f404d0ede6ce7a1e49bdbe878 src/stores/__tests__/project-close-lifecycle.test.ts
5fcc0a73a2520106ed95494c3ce174126b5fb5f10de9d28a80056cdf4f5e9178 src/stores/character-store.ts
eb39d4c98b094314ba96e2d2ac9ab09f648e41a9b8e2edb6dfc1d349328ab7b1 src/stores/navigation/__tests__/stage-navigation.test.ts
cd27b1c58c6c227f358825903c60c418ca45a36a208ea964afdba9a34e42c2c3 src/stores/navigation/page-tabs.ts
f730f587042082f9d6447a9aef4b8c79ba3ce8b4fa312b27d8a65c2150d280b9 src/stores/project-store.ts
```

## Limits And Rollback

No full-suite, literary quality, real-provider, platform installer, remote publication or headless qualification is claimed. Existing close-failure quarantine and retained legacy refusal can require explicit safe resource recovery; this package does not auto-release unknown work or reconstruct obsolete authority.

Rollback disables the new retained entry, stops new work, and safely releases idle resources while preserving the old switch/cancel/close and buffer protection. Do not delete WAL/SHM, candidates, receipts or outbox; downgrade schema; auto-stash user edits; or resend unknown physical requests. The protected initially staged repository analysis is outside this package.

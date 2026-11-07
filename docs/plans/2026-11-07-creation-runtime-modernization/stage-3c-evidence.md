# Stage 3C: Runtime Close And Maintenance

## Scope And Status

Parent: `546486a82832cf1c63d6754b98c9be5ebc28371a`. The 76 source/test hashes below freeze this increment relative to that parent; records are separate. F2 README and evidence-map remain unchanged. Final integrated deterministic execution, source build, isolated Electron execution and independent evidence acceptance are complete. RUNTIME-003 is `completed/passes=true` for this package; the coordinator records the scoped commit after checking its bytes.

This increment implements synchronous new-work seals, bounded actual-handler/transport drain, retained-resource close retry, captured-project maintenance and canonical reservations in the existing single broker. It includes M11 historical tail escrow and actual global Skill/MCP effect lifetimes required to make close safe. It adds no visible UI, candidate adoption, automatic unknown retry, generic workflow driver, human approval or second headless writer. See [ADR-0031](../../adr/0031-runtime-close-and-maintenance.md).

## Acceptance Mapping

| RUNTIME-003 criterion | Evidence boundary |
| --- | --- |
| Seal, converge/flush, release; no task execution after exit claim | Host lifecycle, registered DB/generation/Agent/Skill/MCP effects, sender loss, physical late response, timeout/retry and renderer/native window-close tests. M11 preserves only the exact held suffix after native COMMIT; failures retain memory and the close seal. Electron lifecycle scene must observe real transport hold before native release. |
| Maintenance is captured-project specific and no active directory mutation or DB-main-only backup | Archive/cloud backup/deletion/open/restore adapters hold the existing single broker's opaque lease through awaited work. Tests cover active writer refusal, canonical reservations after native close, unrelated view preservation, overlap and failure. Existing WAL-aware backup is retained, not replaced with a main-file copy. |
| One canonical writer; no second headless host | Existing canonical/native identity routing and alias tests plus new maintenance reservations and close barriers. No OS fencing or second CLI process is delivered or inferred. |

Package-local G-CONTRACT/G-STORAGE are accepted through ADR-0031 and the evidence below, not a blanket approval of future packages. Close intent, leases and tokens are process-local, not portable authority. M11's seven historical fields are strictly classified; actual immutable schema-11 captures, native rollback/COMMIT failure, exact-prefix proof, two-generation export/new-copy restore and frozen-history tests cover the storage addition. Existing author UI does not render the escrow suffix, which is explicitly outside this no-visible-output increment.

## Team And Review

- Owner/service/Agent and Skill implementation: `gpt-6.1-terra` / high. Maintenance/shared adapters and portable integration: `gpt-6.1-sol` / high. MCP actual-request tracking: `gpt-6.1-sol` / high.
- Coordinator owns shared integration, host, native tail repository/migration, global Agent admission, real registered-IPC tests, records, commands and Git. No agents run project commands or write Git.
- Independent authority/requirements reviewer: `gpt-6.1-terra` / high. Independent lifecycle/storage/portable/driver reviewer: inherited active session configuration. Neither is sole verifier of its implementation. Both independently matched all 76 source/test hashes, raw final test and Electron reports and the three build identities, and accepted all three RUNTIME-003 criteria and package-local contract/storage gates with no remaining in-scope blocker. Root, not reviewers, executed the recorded commands.
- Review repairs include terminal-settlement failure before tail escrow; exact run-root proof; rejecting old discard cleanup while closing; actual global-effect lifetime beyond logical unknown; delayed-first-effect single-use token; and preserving B's same-URL inspection cache when A admission fails. Repeated source review does not stand in for the final runtime results.

## Actual Commands

Working directory: project root. Existing Node 24.13.0, Corepack pinned pnpm 11.11.0, Vitest 4.1.12 and existing native dependencies. No dependency upgrade/rebuild, real-model call, real project fixture or installer operation. All persistence tests use isolated fictional projects; reports and diagnostic capture are under `.runtime/creation-runtime-modernization/stage-3c/`.

Final selected test command expands the sorted, validated 67 paths from `integrated-first.json`:

```powershell
corepack pnpm test <the same 67 test paths> --maxWorkers=2 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-3c/integrated-final.json
```

The exact paths are present in the raw report's `testResults[].name`, restricted to this workspace and `.test.ts/.test.tsx/.test.mjs`. Actual result: 67 files, 1756/1756, zero failed/pending, success=true, 249.8 seconds. SHA256 `AD3AFB50AD73EB260F443FDD0B92A775C4F70B64761F5A13BE7CC48F7E7069A7`. This is an affected-impact union, not the full repository suite.

Final `corepack pnpm run typecheck`, `corepack pnpm run lint` (including colors), `corepack pnpm run check:i18n` and `corepack pnpm run build` exited 0 on the frozen source. Build runs TypeScript plus Vite and writes only the configured source outputs, not an installer. Existing Vite alias/freeze/inlineDynamicImports, ineffective dynamic-import and large-chunk warnings remain; no dependency/configuration changes hide them.

| Build artifact | SHA256 |
| --- | --- |
| dist-electron/main.js | FD9693D9E3FDF3AEB36483332917C55219E00BD15810C0F384EBA71C50FF6C99 |
| dist-electron/preload.mjs | 2630D158B9B2A5CDDEDDBE6261A0B71BCADF3DFDA324D328427A4916244CF878 |
| dist/index.html | B1F5E075EA468B64EA17FFA0BCE8B2739DB4C4403A3F65973A31B1C88D2B9759 |

Actual isolated Electron command:

```powershell
corepack pnpm run verify:drive -- --scenario runtime-lifecycle-v1 --theme light --out .runtime/creation-runtime-modernization/stage-3c/electron-lifecycle --dump-dom --console
```

Exit 0 with existing Electron 44.9.3 / embedded Node 24.22.0 / Chromium 152. The three build hashes were unchanged before/after execution. Real registered IPC creates only fictional A/B projects and uses the local fake model. The guarded main-process fetch wrapper holds the actual accepted request without replacing network policy. Native A close waits for that actual transport; A's new write is refused, B remains available, the original unknown is not resent, reopen cannot reconstruct a grant, archive export succeeds and deleting B retains A. One guarded attempt and one fixture request. Native application quit is normal (`forced=false`). External request, external write, ignored-write and residual-process arrays are all empty. Network observation is `observed_before_quit`, not a guarantee about arbitrary future processes.

The coordinator personally inspected the 1440x900 light PNG: unchanged empty shelf because the direct IPC scenario does not load renderer project/model stores, with no dynamic chapter/count/time values to reconcile. It is not a visible author workflow, two-book UI or pixel-equivalence acceptance. The scene explicitly does not cover in-flight backup writer interleaving, native window-close interaction or platform qualification; actual deterministic controller/host tests cover the first two implementation boundaries without relabeling them as Electron interaction.

| Artifact under stage-3c/ | SHA256 |
| --- | --- |
| integrated-final.json | AD3AFB50AD73EB260F443FDD0B92A775C4F70B64761F5A13BE7CC48F7E7069A7 |
| electron-lifecycle/runtime-lifecycle-v1-light.json | EC0CCAFB471386296F85324F8BFF1F0AB6CD5387F0BAAF461BB3444E09280165 |
| electron-lifecycle/runtime-lifecycle-v1-light.png | 3D3BFE540BD7D73DD007C23B7E01F473AFB0E07BC09E7EC391BA90738E3456B0 |

## Preserved Runs And Repairs

These overlapping counts are not additive unique tests. Earlier passes do not accept later source bytes.

| Report | Actual result | SHA256 |
| --- | --- | --- |
| lifecycle-first.json | 12 files, 316/316 | EE14405077179AA5B600AEEF2DF1072608524B6A8C5814CCDDAAC22F46280DC2 |
| owner-storage-first.json | 18 files, 709/710; strict read-receipt test sent execution-reference shape | 95232A637C5BD53F46791ECA4E71D8C7B148F33F2C90AA62507B9689CF9CF773 |
| lifecycle-effects-first.json | 10 files, 236/236 | 413780AC7D92367E6A85418774B62D97CF710F9B7C462DBB4515EEB2D5B03D40 |
| mcp-effects-first.json | 7 files, 156/156 | F2FB731E4A26B5B23E8F12ADA6E2FDFC60178822DF6D202063133C72934820E0 |
| agent-effect-fence-first.json | 10 files, 261/271; old test teardown bypassed true claim drain | 76C2EFF8EF740503AF7CF0B710FB7BDF93CE0CD3AB0FF645E8C9930EB3BE2B33 |
| agent-effect-integration-first.json | 3 files, 96/96, including 11 actual registered-IPC cases | B9339576A6E6A26AEAD6BB3990869245B843045B380627F4F140679BAF229828 |
| integrated-first.json | 67 files, 1750/1756; six failures were four stale current-schema assertions | 96C5C5BDDBB9EB8297B30EC7C9789CA3FFD4C13293813710EA6557D5FF5C02E9 |
| baseline-schema11-capture.json | 1/1 immutable old-source capture | D9C1F061876732E450E29DFE278F947662B0A3C68A509C3BFD2ECEA9CBD67386 |

Read-receipt production validation was not relaxed. Old Agent test teardown now calls true quiescent close, not direct release of active claims. Installed-lane assertions now expect current schema 12 while migration targets 6/7/8/9, old-data/fingerprint and rollback checks remain unchanged. The first typecheck's three fixture type annotations and lint's unused fake callback/close counter were corrected; the latter now has an explicit close-count assertion.

Immutable schema-11 capture reads only parent `git show` sources and builds its helper in memory. Archived provenance/helper/fictional normal and donor databases are in `baseline-schema11/capture-KWCHhD/`. Identities: normal `3b151d5a40e96963f9f0e467823df87ece9002bc37de80b67c967f35122d2c7a` (57 tables/546 fields), donor `1d6c2f83c2f5047b46952e1485bd10591140de7c888431fe5d24f18456be0a53` (57/547). Tests pin these old identities, not a self-generated current schema as backward-compatibility proof. The one-off source helper was removed before commit; captured artifacts remain isolated.

## Unverified Boundaries

No new recovery UI or author workflow, browser interaction, real-model quality, full-suite, OS exclusion, three-target installer/platform or external effect reversal is claimed. Existing privileged author-global Skill/MCP settings routes retain their prior trust boundary; the single-use token prevents delayed production Agent dispatch, not a malicious privileged renderer impersonating an author-settings call. MCP local completion/exit does not prove external cancellation. The driver cannot turn its IPC-only screenshot into visible workflow acceptance.

## Frozen Source And Tests

```text
0FAD574E1F4381C990672CE64A752FA2067889532F8C4169042524CEA9597D0A  electron/__tests__/ipc-handlers-character-avatar.test.ts
84C760BD033AFD7D4CABD90BEC925E7AB084729ABB9AA8BD8327DDB3B71F4B2A  electron/controllers/__tests__/agent-generation-controller.test.ts
798208A726551FDEDC23981E3DF255BDDA3BFEA61AEFCAA03FE5AFE18E51BCA2  electron/controllers/__tests__/agent-global-effects-controller.test.ts
C04F75DF344CD89B0B07DE25AFD43E995768BBDF6557E808C4810FDBF216F8C4  electron/controllers/__tests__/application-runtime-effects.test.ts
BF0093E84062815ED27BC84143FC57B70F28CB78FCBA9D9F283316BC53E363B9  electron/controllers/__tests__/cloud-backup-controller.test.ts
658C674F2AD7D2282FE11F8AFB7D254C1ABEF2303810B670D97DE185B625403C  electron/controllers/__tests__/db-controller-project-context.test.ts
3462ED554827A4E142E59604D1237656B78059E81505E0DB3B84D42D72971D6A  electron/controllers/__tests__/project-archive-controller.test.ts
EFD7FFDA610D38359B10ABE74FA6EC1830B4DC3044C0F63F35F86EA79520795C  electron/controllers/__tests__/project-controller-context.test.ts
FE23BBEB832ED5C557C384FB29ED79D0B1D4288902CB984AA024F697B2FA34F7  electron/controllers/__tests__/project-controller-open-atomicity.test.ts
55497C46027F0FC9C4D43D751C9A474E823DE69B589C00DBE3FBB3530AC257D9  electron/controllers/__tests__/runtime-feedback-controller.test.ts
35272521152366C643630CDE0FD6CCA3DEBE10CBC4AB2B1E91A0D59928197795  electron/controllers/__tests__/window-controller.test.ts
E4E3A384FDDEFBB14D0FF2B6A8AF7DA742D4EDB77BACAC60782F5C6E884DFEBA  electron/controllers/__tests__/writing-skill-app-data.test.ts
93ACCAC84F258B2E839BC130FA484AE23E2697F5A546D77E5E0A67DB2736F541  electron/controllers/app-data-controller.ts
A2DE4A092D10E2CC5484C69C194447FF45B254CEEB19DD8145D07A81D974E06A  electron/controllers/cloud-backup-controller.ts
316513E25EC25D3C5B23F28B28797DF80AFFE9E32D2B9A7FA4D80A78DE86B438  electron/controllers/db-controller.ts
858FD30E6EE652EA515B99F5BC418DD086F5846C59F07F0F62C3693D2E8483AD  electron/controllers/generation-controller.ts
AAA8B91922934388A21DADD1A3E9146976CD551C179009093CD04EDA1766A022  electron/controllers/project-archive-controller.ts
F7153D803E5DB0C136EA58E776B3E725388FD5EF850570BB7792D4BCAFCF48DE  electron/controllers/project-controller.ts
ECC77C367FA3FA7F5C81FD9D4F91F062BE3CFE017B888CE977390FC913F463FB  electron/controllers/window-controller.ts
BD534981C2F8EFA87FE2D295511A4FEAF062CF6B35F03297302EB2DE435C0493  electron/ipc-handlers.ts
43E342E2439ACED926A71AFBC316DAC79EB8C70D2BE0D8D6725F816C2FBC033F  electron/mcp/__tests__/mcp-ipc-bridge.test.ts
6A3C0CF975B36CEDAA47A53771EF0BAAAF9374BB0B58D00875EA65E225AFF615  electron/mcp/__tests__/mcp-manager.test.ts
EC56923939B773835B51D99D73E3A8E54AC72FE97400E53B87B0D0203E37BE65  electron/mcp/mcp-ipc-bridge.ts
9E2BAD1A13FBF64DED3934416C2D087218C4BA1ED548A63EDD7DB3FFCC33FF8E  electron/mcp/mcp-manager.ts
51DD6349CB1B58EAEA93D7A49E86D3C2AD3B25302BB0AF1D087DE8D7FA6BED3D  electron/migrations/__tests__/m05-installed-lane.test.ts
AB13E9F4FDF863C043215D95ECE8F14A73D2F96B2C9B5D1456FC9912A1782621  electron/migrations/__tests__/m06-installed-lane.test.ts
A490538A3112A3BD5D17F918F78C4291E61CC9CF8C285B4C8CA2B90B0B5DB26B  electron/migrations/__tests__/m07-installed-lane.test.ts
67FC65991F7FCDB7DCFB150F9C71E64CB344BD7D788AC81B14A66DA722817191  electron/migrations/__tests__/m08-installed-lane.test.ts
BD873204BC721BBC154BD2A25D2FFB001D6F190880827596D405307386E8EC0D  electron/migrations/__tests__/m11-generation-recovery-tails.test.ts
BCDFEFC2E8D5157CD862564B545BBF8743E80A9684DEEE24375196F2E4C64E53  electron/migrations/__tests__/runner.test.ts
3D93869F1FFC749D1406002B9CEA9A365BC9F4A38868DC7B0FFAF7791A2FCB64  electron/migrations/desktop-registry.ts
939BEE366A330BA11ED257489D20B95C3A862EEEC8527AD1BC3E5DF3D7A2B5A3  electron/migrations/m11-generation-recovery-tails.ts
AA1A1E5F699128D1B1C651C4ECDBA916ABF4D7F5A4E943FC8F3172AF82490E54  electron/migrations/registry.ts
93BFBDE810876F9CC6E503B5CA858E19D3EB210E3A3C1F61CAD2944C8803281A  electron/repositories/__tests__/generation-recovery-tail-repository.test.ts
D787CA6E59879ACCDBA89641721C32BFD64FD0BFA4D8912E25D23E16119040A2  electron/repositories/generation-recovery-tail-repository.ts
91F7B543C5A49A5EA90F530BC3049A3A5B164007EBB81FBE065D89EAD01C2B88  electron/services/__tests__/agent-generation.test.ts
D532FEF885E2FC6965032271E7ED27A66A5C2456A9CDF6C91B2A99A3309F42A9  electron/services/__tests__/generation-recovery-tail-portable.test.ts
990AE2B368E451FEA8EB98CE436E63C8EFD6085F06712D9D63AA1F04E6B0E005  electron/services/__tests__/generation-run-service.test.ts
675C827C3BC1B79D16ADD33BDF8B4E8B037C4BC996C974B93E575F316A7DC639  electron/services/__tests__/main-generation-owner.test.ts
A3A54543060E2AD88FF0591944080D839DB47F0B2E0EAE5417F3B26D81889D5B  electron/services/__tests__/planning-feedback-portable.test.ts
52D6ACA45A9E8CCA8269D312B9C75FDB50AFECE7734F006988D7CCE9B41AD8B6  electron/services/__tests__/portable-project-format.test.ts
932BEE6C9B6A52DB0243C4A6C3756B3231A8E51A8F5EAA7F6C20A2E2BFB25134  electron/services/__tests__/project-archive-service.test.ts
A29D1147FA328A6835F8199A25478853A0D2F00D643F52B94E14B65EE038CAC5  electron/services/__tests__/project-format-migration.test.ts
0A34F2382FD45EAC7D54DCAB11FF965B27A4ADBB5B9A39D69F67C710976F7E3C  electron/services/__tests__/project-runtime-compatibility.test.ts
54F62441748E7FECBDE7C652EC5286E16C7DA028159FDBD322CE0DFA93B69028  electron/services/__tests__/project-runtime-lifecycle.test.ts
0F3862A7CFD09174EF0FF4181A2538ECBEE1AE1489514E3D611EDA4D144D6144  electron/services/__tests__/runtime-feedback-authority.test.ts
27AEC36B794A34CA2074890EFE6762422BEF98CC548044BAC1303612A63247F4  electron/services/__tests__/sqlite-project-migration.test.ts
A5913EB78CD220EE1E2C814BDC3E3A8FD89C4DD9B2174CDF306E3472B58009B3  electron/services/agent-generation.ts
A47DFA2C8176B47CEF35C300233B792B1870E8046B8D18D6A7E945E833BFF0D7  electron/services/agent-global-tool-admission.ts
C5BFC7DF5BB17E00097FE6E08E85515E315BE26BB815D961320B4C723EA4DF9B  electron/services/generation-run-service.ts
9374AF66CCF9C48D54DFFD7403BCF30A31BE83E121BFD23F5835AD77C029E808  electron/services/main-generation-owner.ts
75ECA3612423DA82D9053726AD470FB943D86FDD89F95E1DE6A4C34CA60E274A  electron/services/portable-project-field-policy.json
D1FAA8C33BE2091F36A5ED50ADEAC1016EE96851CFBA217A933FB1530967530A  electron/services/portable-project-format.ts
8E1137DCD83C2E04282FD317A6DDA412CA5B99B51B3410DEE8EF556CBAF82498  electron/services/portable-runtime-freeze.ts
6D004A7CC65D1ADB879CDBD1D53EB3F5A0E9265B4785805FD0A048A2D516B9EA  electron/services/project-archive-service.ts
EDDC0B482C7C42AE9F0BE7912199A662658C45176360AD7CABDADCC3462281F7  electron/services/project-format-migration.ts
5918DD87D4CB844E363F7C0E87D2EA5AF56670EE758D28A83CA46C8716B850B7  electron/services/project-runtime-compatibility.ts
81C8B2D5AEFDD0BD4316A955BC98CF7A5B67C63C18BACAEBD31659FEF304E1F4  electron/services/project-runtime.ts
5F2014322F17222F75F5115351EAEF74B33C26B1A80D8B0323CBE02E5C58804D  electron/services/runtime-feedback-authority.ts
053D02AE35898525B7F059E6232E43095B437B107D034FC90542A1F226818373  electron/services/sqlite-project-migration.ts
262A94779F6F5309AA8DAB259F4BFB71FBD5FE0597315C4CA64BB23133F9560B  scripts/redesign/__tests__/drive-args.test.mjs
B3C8EF32A4DDC7221A8B9C60FD9159D5446CE72E2B599C9B2CAB9BB796339B05  scripts/redesign/__tests__/runtime-lifecycle-scenario.test.mjs
741ACD6164F474C26AB41F3828DD9483BD4E10D479FDA027EB6910FDB5F9F9C6  scripts/redesign/runtime-lifecycle-scenario.mjs
67FDA0EFF8E83E3A2B870212080E3384FA7F3529AA15E0DF700A1678D4ECBACB  scripts/redesign/scenarios.mjs
01BB346BED7259082C6CD763390DC50E7F1270A52642C91C91530682C5A8B2EA  src/services/agent/agent-engine.ts
4D7D5E7551AA6C113B8DD2B69238C2EDEAE90E8444D33915842E95D2BE905762  src/services/agent/tool-registry.ts
A7E3DA761083B4B78D08F966FE6D596E0A249D3097A258C91B63EB2502CFC8A1  src/services/agent/tools/__tests__/writing-skill-tools.test.ts
54C7E9468A569BEB314BE219724F46EDB22032BF86638A763D59A5784BE8C519  src/services/agent/tools/inspect-writing-skill.tool.ts
7A5DD9F255B2DB4A77D9D8FCF0B6ADE95E707F2832118A388E876277141337EC  src/services/agent/tools/install-writing-skill.tool.ts
FAE8237457BC720A0715C1ACF836A2989E45F41AF8A6B1C58DEFC585A38AE9F3  src/services/generation/generation-runtime.ts
E7329744DB3159D2F6F3507370EEFEC71B79CD3237CC7C40F3A1703566685266  src/shared/agent-generation.ts
C54C647227A8012B89E49F05CBA092A8BA379C304346B77E3E723F79FF85AF57  src/shared/ipc-channels.ts
3B95A8878282E55E4EF5C4D24C2B68C73B1A844548BF216B570490BB8866B328  src/shared/project-storage.ts
D872039AD0C48BE449C280FFB7D29AFF8ECC207C6E19527E8361A5753FC37222  src/shared/runtime-feedback-contract.ts
FD90F806ECD08A30DC14883C8CCD126CDA8EE9237FBB21437CAC8490D470CAFE  src/stores/__tests__/mcp-store.test.ts
D2ABCACDB6069C265C0975EE5F7D25777F7867B4241A143BD5C73E120891A1A1  src/stores/mcp-store.ts
```

# Stage 3B: Narrow Runtime Feedback Grants

## Scope And Status

Parent: `173e49914f1081d7063b1e3fa23c67d042f8c33a`. The source/test hashes below identify this increment relative to that parent. F2 and its evidence map are unchanged. Final deterministic and isolated Electron execution and independent evidence review are complete. RUNTIME-002 is `completed/passes=true` for this capability package; the coordinator records its scoped commit after checking the committed bytes.

The first producer revises one original eight-field feedback target into a candidate. It does not adopt a candidate, change formal planning, authorize another workflow, expose generic model access, retry unknown requests, change UI, or add a second writer host. See [ADR-0030](../../adr/0030-runtime-feedback-grants.md). Existing v1 feedback keeps its current-view authorization.

## Acceptance Mapping

| RUNTIME-002 criterion | Evidence boundary |
| --- | --- |
| Recheck authorization/epoch/maintenance at dispatch and effect; arbitrate revoke at the same project barrier | Captured runtime/native DB/identity/epoch and sender-owned issuance; final native admission plus reserve/dispatch transaction; source/model/Skill and maintenance rechecks; grant completion and original-proof candidate staging in one transaction. Native repository, authority and registered-IPC tests cover pre/post-revoke, COMMIT failure, maintenance, sender destruction and physical/tail fences. |
| Keep committed facts; revoke-first forbids effects; bounded cleanup and receipt reading do not renew authority | Completed candidates survive revoke and terminal replay; cancelled requests retain physical ownership, accounting/artifact cleanup and unknown semantics. Receipt ownership survives idle owner handoff, not true close. History reads do not construct owner/model lease/capability. |
| Old epoch fails closed; cross-book revoke returns per-project fences; new copy cannot inherit authority | True close/reopen and sender mismatch refusal; explicit bounded `revoke-many` with per-project results and partial failure; two-generation archive/new-copy restore retains only frozen history and rewritten excluded operation keys. Actual registered-IPC Electron A/B scope includes a missing capability and preserves its false fence rather than claiming total completion. |

Package-local G-CONTRACT and G-STORAGE are satisfied by accepted ADR-0030, native grant/producer and portable migration/recovery evidence. The required `contract_review`, `deterministic` and `electron` evidence is present for all three criteria. This is not a blanket acceptance of future driver, workflow, API, human-approval or headless contracts. No new visible state is introduced. No real-model quality or platform qualification is claimed.

## Storage And Contract

M10 uses the central registry and advances only its registered lane. Earlier recognized schemas remain registered. The grant table has 15 scalar fields: 14 historical `H` fields and excluded `X` `operation_key`, rewritten to collision-safe stable history keys during export. It stores no credentials, UI lease, native identity, execution epoch or novel text. The historical canonical request hash excludes the operation key, machine/model/Skill mixed fingerprints and capability material. Original model identity is checked separately without rebuilding a lease for history.

Native COMMIT immediately precedes synchronous capability/claim publication. Replacement owner construction and retirement cannot discard the old published owner on failure; runtime construction/handoff does not recover unrelated runs. Legacy generic routes also reject durable grant-run bindings after mode changes. Maintenance denies new admission/effect but not already-dispatched settlement, revoke or receipt reading. Sender-destroy native failure retains the claim/error while best-effort cancellation still aborts once.

The six closed literals include `revoke-many`: nonempty dense maximum 128 distinct project/grant references, validated before any effect. Each reference reuses caller-bound authority and its original transaction. Every item is attempted serially; only the submitted scope contributes to `completeForRequestedScope`. A failed item has no receipt and a sanitized code; later projects still run. No cross-database atomicity, global completion or implicit retry is asserted.

## Team And Review

- M10/repository/authority tests: `gpt-6.1-sol` / high. Owner/service/registered-IPC and Electron scenario: `gpt-6.1-terra` / high. Portable integration: `gpt-6.1-sol` / high.
- Coordinator owns shared contracts, controller integration, registry, records, commands and Git. Independent requirements/authority reviewer uses `gpt-6.1-terra` / high; independent owner/storage reviewer inherits its active session configuration. Neither owns the reviewed implementation or executes root's commands.
- Review closed terminal-receipt loss on handoff, failed-revoke cancellation, unrelated Agent recovery, final source/model/Skill recheck, maintenance admission and missing cross-book revoke orchestration. Direct two-direction construction/retirement failure tests were added. Both independent reviewers matched all 46 frozen hashes and the final raw report, inspected the actual Electron receipt and PNG, and accepted this package with no unresolved in-scope blocker. The storage/owner reviewer also matched all three build artifacts. They did not run commands; execution evidence is root's actual run. No old failed denominator was erased.

## Actual Commands

All commands run at repository root through pinned Corepack pnpm 11.11.0, Node 24.13.0, Windows x64. Test fixtures are fictional and recoverable; caches, temporary SQLite/projects and reports are isolated. No real model/configuration/project, dependency upgrade, native rebuild, installation or remote state is used.

`corepack pnpm run typecheck`, `corepack pnpm run lint` and `corepack pnpm run check:i18n` exited 0. These are static checks, not runtime acceptance. `corepack pnpm run build` exited 0 and updated `dist/` and `dist-electron/`; existing chunk-size/deprecation warnings remain, with no build-chain cleanup. This is a source build, not installer/native-platform qualification.

The final focused selection is the sorted union of test-result filenames from `stage-3b/integrated-second.json` and `stage-3b/impact-first.json`. The command validates each of 44 paths is inside this repository, exists, and matches `.test.ts/.test.tsx/.test.mjs`, then invokes:

```powershell
corepack pnpm test @files --maxWorkers=2 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-3b/integrated-final.json
```

The final 44 files passed 1177/1177, zero failed or pending. This includes 20 registered-IPC controller tests, 15 authority tests and three portable-grant tests; source, model, cancellation/tail, migration, archive/restore and old routes also execute in the union. A final report is not the full repository suite.

Actual Electron command:

```powershell
corepack pnpm run verify:drive -- --scenario runtime-feedback-v1 --theme light --out .runtime/creation-runtime-modernization/stage-3b/electron-feedback --dump-dom --console
```

Exit 0 on the same built source. Electron 44.9.3 / embedded Node 24.22.0 / Chromium 152 is the existing runtime. The scenario recorded two guarded fetch attempts and two fixture requests, pre-dispatch revoke with zero requests, in-flight unknown without resend, B's retained completed candidate, unchanged formal A/B content, filtered legacy list and close/reopen history without new capability. Its explicit three-reference batch returned A false (one successful revoke plus one missing capability) and B true (completed candidate retained), with no global success claim. Normal quit (`forced=false`); external request/write/ignored-write/residual-process arrays are empty. Request observation is `observed_before_quit`, not a guarantee about arbitrary future processes.

The coordinator personally inspected the 1440x900 light PNG. It shows the unchanged empty shelf, matching this direct-IPC scenario's lack of renderer-store project/model loading. There are no dynamic chapter/count/time values to reconcile. It is not evidence of a complete author-facing feedback mode, two-book UI, dark/mobile layout or visual equivalence. The exact-v1-handle firewall, different sender and unsaved-tail cases have deterministic tests, not this Electron scene. No real-model or three-target run is substituted.

| Final artifact under `.runtime/creation-runtime-modernization/stage-3b/` | SHA256 |
| --- | --- |
| integrated-final.json | 55F5CA759E5B1D2B4E972D7F060486516DFA9C22A8F22675DDC07B1A842CF4C3 |
| electron-feedback/runtime-feedback-v1-light.json | FFCE0FE5C3F72A470F51FC43F50089753EFE1B9D0C1DDE42C506487F6018B8D2 |
| electron-feedback/runtime-feedback-v1-light.png | 3D3BFE540BD7D73DD007C23B7E01F473AFB0E07BC09E7EC391BA90738E3456B0 |

## Preserved Failures

| Report under `.runtime/creation-runtime-modernization/stage-3b/` | Actual result | SHA256 |
| --- | --- | --- |
| wire-tests.json | 30/30 | 3B6A14B09DDDFB9A868DC01F312BD154A44F2222D9D207C2979AD334455E4722 |
| backend-first.json | 140/264; missing closed M10 lane registration | 81FE8BDB8C9969F7A26F146F918FF8231D4ED3F4DCAD24072D27F12B662984BB |
| backend-second.json | 285/295; fixture path bound, schema identity and evidence API mistakes | A7628605DB3B26F5CA01F126F737F482CC86FD132666DCABDB6B7721375EC8CF |
| integrated-first.json | 570/577; old current-schema assertions and retained fixture DB cleanup | 425100B724165F66FA75ACE15046DB1EA7334B703CA6C2466901D73678510284 |
| migrations-retest.json | 144/144 | AE13D9DD8ED6F4C573807146DB0F612D5E6FB9245AF826824E45B78CEEB716E5 |
| integrated-second.json | 581/581 before batch-revoke increment | 14511BD91CDE9C84909DB882BDCEA3C515DFB3D46CA26D7080F5713BA79A5EA9 |
| impact-first.json | 587/589; archive current-schema/count expectations | 2EE2A8CD716B62A72AF0DF741B9866CBEA54504CCC3927026CE46B27ECF7E7C1 |

The first typecheck failed on test typing and an unexposed archive evidence field. The fixed test probes actual SQLite evidence without widening the archive API. Historical migration target versions remain unchanged. The Windows EPERM fixture fix explicitly closes the final restored runtime before reopening source; no retry or ignored cleanup error. Archive assertions now use the actual current schema with exact 57 tables / 546 normal or 547 donor fields; author content, assets, source preservation and frozen-history checks remain.

## Build Identity

| Artifact | SHA256 |
| --- | --- |
| dist-electron/main.js | 5EEAF431EE44DFF5893758BD8069A6B4F8E60F8F8CBAFC7BE79AF1D8ABA310EB |
| dist-electron/preload.mjs | 2630D158B9B2A5CDDEDDBE6261A0B71BCADF3DFDA324D328427A4916244CF878 |
| dist/index.html | B1F5E075EA468B64EA17FFA0BCE8B2739DB4C4403A3F65973A31B1C88D2B9759 |

## Frozen Source And Tests

```text
3D565B325C041CB41A4DFBF0302CFEDA5B83D01DEEF24B1765CD08FE16105A25  electron/__tests__/preload-bridge.test.ts
95E42189ED3A06BBE4A018207BFB60E55BA0BE05CAC9A49C88C67437BC6C77C9  electron/controllers/__tests__/runtime-feedback-controller.test.ts
D4F9E2A9A68094E80F4BC59D8F9F7CB8DD612A6F57395BE5F6455491C0FEB32C  electron/controllers/generation-controller.ts
84D93400A8F133DDD0DF4A8402D388235C7F9974D51C3C6C63EF062860D1F0FC  electron/migrations/__tests__/m05-installed-lane.test.ts
2429EBD5DA26EB7B1DC19B3C59A0EB23633D0CF430F9D664599D22A76E777C3B  electron/migrations/__tests__/m06-installed-lane.test.ts
9E9856AC932A0B2E7B4D71D2E9A8BF96FEA7EE7591A8E78086BACC252D44ABA1  electron/migrations/__tests__/m07-installed-lane.test.ts
FDB7BA9FDA33364E24183E41C1D09431E33E1BF4704039B46C464E382D51E76A  electron/migrations/__tests__/m08-installed-lane.test.ts
B170B5956FD1363780647FE3953152BE1E7A36B370867CA232B993BDAD85084C  electron/migrations/__tests__/m10-runtime-feedback-grants.test.ts
512934E07A81A5E8C9EAB82D7A1D57A282D646650170C735F2B8690376D2D44C  electron/migrations/__tests__/runner.test.ts
7FBF6F2DCAEF17AE981FC4F6FB8D71B21A67C503F53BA98A45E43DB379DD7973  electron/migrations/desktop-registry.ts
7305E0824A5543F3682E163C0A7E04F672E5D69298E99C26BD199C9148238BB6  electron/migrations/m10-runtime-feedback-grants.ts
1EE4182E8AA45B7A38ABA5394A549BC63C8CD18FA9AC31606845175F3776370E  electron/migrations/registry.ts
13D499E6F9FB142DA1C777ADE5E7AD2BB6E033651D5EEF8BE106024120AD18C5  electron/preload.ts
031FCF0B679FA6473AFA67A2E16194BCBBA5086B04526A49DEB4C30E87672510  electron/repositories/__tests__/runtime-feedback-grant-repository.test.ts
41016BE98AC9DCE542C435212F0BB0CBCAABAF58ADB47B60CAB3B1829E887EBD  electron/repositories/generation-run-repository.ts
39C430AB0457906EFFF5C008DA01D50F81EE919FA2786624F773A27A9C9B7541  electron/repositories/runtime-feedback-grant-repository.ts
3A1697898639B5F5C466758E526FF09D5EE8D15B3EF039BD78691F206E71C4B2  electron/services/__tests__/agent-generation.test.ts
9F6F29406355D3304E22253BE1B24884EB33612D5A13FF8F084D789F5C069BEB  electron/services/__tests__/generation-run-service.test.ts
880F115602C898D1166014CED967500B02026AC3AB0545EA48E4383E10627F11  electron/services/__tests__/planning-feedback-owner.test.ts
67651D91C1665D42F26A3AB24E8F97D3BD5B8194405192FAF9BEEA1BF837E244  electron/services/__tests__/planning-feedback-portable.test.ts
9FD4F6085F34E5AD909ADCFFA9A5605964758784D8AA7378C5951790161E50E9  electron/services/__tests__/portable-project-format.test.ts
852AFEEBF0DFA61326CC8E2FD4FE500A15DEF04F2BD72579AE9979BF4F9B0ED3  electron/services/__tests__/project-archive-service.test.ts
0BE9FBCF41CB49DCFE5FD88D6B4C8802E026E1D410A7C62D4AE428E971C3AD98  electron/services/__tests__/project-format-migration.test.ts
84D9068D58AAAF8D047D77FE39928A99EFDEF0EDB759EFB6EE518753DDF97901  electron/services/__tests__/runtime-feedback-authority.test.ts
70857CB0465B316B788A6AB6449CF216D18263DADDA78518247E2D350D659725  electron/services/__tests__/runtime-feedback-grant-portable.test.ts
1ED84DE72212BBB8185988B0C67D5F33A37FD02D3586707C8EE2DDB3D5180586  electron/services/__tests__/sqlite-project-migration.test.ts
83DBBBF0DE71843C3DBDD87ED220C3ABCFDC4C7ACF01F05A4C6D3BD78281B015  electron/services/agent-generation.ts
95F4C645A35AF557F8CA712088D06054B8F415ED488A9263B22131D68B949AA2  electron/services/generation-run-service.ts
0F5A75ED90FE51168227C37D7CB57C850B5ED3EF907526B89CC602B41EC777F1  electron/services/main-generation-owner.ts
922AA3825CAA003EF79F4A7D87A26349DD2832DA337072DCC4AEB670B6EF42FB  electron/services/portable-project-field-policy.json
70F85A5598ECCFB1347D701CFA95B43E81B845F870786567B1DEB5BD81954D9C  electron/services/portable-project-format.ts
5FCF735F0E04DA7698B7D614DD101DEB680CE45F1570C0F3F8F39F022AC6CA8D  electron/services/portable-runtime-freeze.ts
B38A055280C1185395F88F2CD2E8058F8E877EEC0DDE24546BA6F06F915D8B6E  electron/services/project-archive-service.ts
0A2CD1291420F23D991383A7C3BF2E37F7DAF0E3B0C2114722B81387420778AF  electron/services/project-format-migration.ts
CE0DF33EA2EDF4B0C5B779C9A030F847402D567497687F649D23356FDD6337D9  electron/services/runtime-feedback-authority.ts
85B3351BC9471E8D5720A40182C7DB42FBECF1C13A6AE53B1AA6E2BCA53E8871  electron/services/sqlite-project-migration.ts
AAD7DBB4B1B20E1DE857B8D8C9F6D33FAF02C1B74424ED6A013C5FBD15A556D6  scripts/redesign/__tests__/drive-args.test.mjs
796C0454166D29DFAB88A0AE2D1BA3E46BF562EA83843CE1824E1A3CC1465508  scripts/redesign/__tests__/runtime-feedback-scenario.test.mjs
E940FA9C0CB3236E307EA03D6F742EC4DB104C303AE0CAB1853142A82ECF1AE8  scripts/redesign/runtime-feedback-scenario.mjs
EEF59B93E1B4F7A0DDE3243950D2DED22944F4BC65666582788CABB220384398  scripts/redesign/scenarios.mjs
0F96261008C5DA2A396A8DB60780C3F6B79EA62706A46508B37005E2804F035C  src/services/__tests__/ipc-client-project-session.test.ts
6569CDC6323F9156938B450D67208B5D87770EFD88F869DABF7654720923927D  src/services/ipc-client.ts
594928F3AE0F1CA8008B1591A40DF6F27950DB67E9510A152EE77C0F6CAB2184  src/shared/__tests__/runtime-feedback-contract.test.ts
5A6FB2D4329866566B68676D45DB5639E45247CE4902822ED9B6EB8014A9BAF7  src/shared/ipc-channels.ts
028A8B5CB069E91A5AEAD52905132ADDE1CE8429C6B7B4339F05C2061B3FF85D  src/shared/project-storage.ts
34B5A3259A1F6E574BE3B6B769E4FFB4A9E00406A3929B8A621700BD30225C6D  src/shared/runtime-feedback-contract.ts
```

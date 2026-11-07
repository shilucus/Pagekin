# Stage 4B2A Evidence

Date: 2026-11-08. Parent: `c8fc65fa1c8bc0934eda0f8e648237b0b8440ece`, branch `master`. Actual final focused tests, static checks and source build passed; both independent reviewers accept code/regression with no in-scope blocker. Final record identity checks precede the scoped commit. This record tracks an internal DRIVER-002 prerequisite, not the complete batch driver.

## Scope And Acceptance

Main-safe captured draft and ordinary-review preparation reuse the existing chapter material selectors, builders, exact bilingual prompt text and stage Skill injection. Existing renderer commands delegate only pure prompt/Skill work. No UI, request policy, schema, IPC, dependency, plugin, execution grant or domain writer changes are included.

| Invariant | Required evidence |
| --- | --- |
| Author facts, original source, required predecessor and template precedence | Existing selector plus new captured-material tests; Chinese/English full-string prompt comparisons against old command text |
| Captured A never reads or initializes active B | Explicit-DB summary overload, readonly roster reader, native A/B and no-write tests |
| Source/asset changes after awaits fail closed | Actual suspended hashing with DB, file and directory mutations; safe original file reader and final synchronous guards |
| Main imports remain renderer-independent | Fresh import test refusing renderer IPC, catalog and store modules; builder imports the original pure implementations |
| Existing Skill, ordinary/recheck and execution behavior is retained | Exact old Skill block/budget tests; original command, bounded completion, recovery and main-owner suites |

The material helpers do not authorize execution. Later driver integration still owns runtime/KB admission, source-binding rebuilding, role cards, empty-target checks, first-target finalized/post-process gates, real predecessor receipts and final transaction validation.

## Team And Findings

Draft/material implementation is owned by gpt-6.1-terra/high; review/prompt implementation by gpt-6.1-sol/high. The coordinator owns shared Skill extraction, old base-command delegation, the main-import boundary test, records, execution and Git. Requirements review is independent gpt-6.1-terra/high; dependency/lifecycle/storage review uses the inherited session configuration. Implementers do not accept their own changes.

Graph/LSP retrieval is unavailable. Reviews cross-check bounded imports, actual bodies and call sites against the immutable parent. Static source review and written test cases are not runtime evidence.

- Early independent review found hidden Markdown inclusion and different guidance ordering. The adapter now follows the old visible-file filter and `zh-CN` ordering; a mixed-name/hidden-file regression retains source-file safety checks.
- Malformed Skill binding JSON now reports the existing `GENERATION_SKILL_BINDINGS_INVALID` classification without swallowing file or database errors.
- The first actual union failed two new fixtures: the roster test addressed nonexistent `characters_all`; a required-author-material test confused the 8000-character optional-material ceiling with the existing 8 MiB required-material capacity. Only the fixtures are corrected; neither product capacity nor assertions are weakened. The failed report remains retained.

## Actual Execution

Environment: Windows x64, Node 24.13.0, pinned pnpm 11.11.0 via Corepack, Vitest 4.1.12 and the existing native SQLite installation. Commands run from the repository root against fictional isolated data; test caches/reports are owned `.runtime` output. No real model, manuscript, profile, dependency upgrade, native rebuild or external write.

| Report under `.runtime/creation-runtime-modernization/stage-4b2a/` | Actual result |
| --- | --- |
| `preflight-main-boundary.json` | Exit 0, 2 files 7/7; intermediate adapter bytes, not final acceptance |
| `focused-final.json` | Exit 1, 23 files 1002/1004, two failed, zero pending; the fixture defects above, not a passing final report |
| `fixture-retest.json` | Exit 0, 2 files 45/45, zero failed/pending, after the two fixture corrections |
| `focused-retest.json` | Exit 0, 23 files 1004/1004, zero failed/pending, success=true; all final source/test bytes, 194467.984 ms |

Preflight report SHA256: `D7CA6B0888B9BCE524EAA3220DF55CDD9AFA2A46BB3369CFBBE678D2CD53B106`. Failed union SHA256: `FBC0F24E248857CDCA03B29B9527FFC998138EC5DCA38EF4A4D151F2AF124FE5`. Fixture retest SHA256: `FADCEE39BF34774DB3F46349938D65F577BB53A77387D6E0CDCF4C793036D803`. Final union SHA256: `C2ED60D71E4EF37165DCD7905EF262207CCC684023D712F19D3303257CC4AF04`. The reports overlap; counts are not added. Both independent reviewers directly matched the 17 final hashes and final raw union, with no unresolved in-scope correctness finding.

```powershell
corepack pnpm test src/shared/__tests__/writing-skill-task.test.ts src/shared/__tests__/draft-generation-prompts.test.ts src/shared/__tests__/draft-generation-policy.test.ts src/services/prompts/__tests__/review-chapter-prompt.test.ts src/services/__tests__/prompt-catalog.test.ts electron/services/__tests__/workflow-materials-main-boundary.test.ts electron/services/__tests__/workflow-batch-materials.test.ts electron/services/__tests__/workflow-review-materials.test.ts electron/repositories/__tests__/summary-repository.test.ts electron/repositories/__tests__/character-roster-repository.test.ts electron/repositories/__tests__/character-roster-identity-fact-hash.test.ts electron/services/__tests__/generation-source-binding.test.ts electron/services/__tests__/writing-skill-package.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/review-revision-generation.test.ts electron/services/__tests__/builtin-prompt-main-boundary.test.ts src/services/workflows/commands/__tests__/base-command-writing-skill.test.ts src/services/workflows/commands/__tests__/review-revision-runtime.test.ts src/services/workflows/commands/__tests__/generate-draft.command.test.ts src/services/workflows/__tests__/batch-chapter-workflow.test.ts src/services/workflows/__tests__/chapter-materials.test.ts src/services/workflows/__tests__/draft-recovery-workflow.test.ts src/services/workflows/__tests__/bounded-completion.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-4b2a/focused-retest.json
corepack pnpm test electron/repositories/__tests__/character-roster-repository.test.ts electron/services/__tests__/workflow-batch-materials.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-4b2a/fixture-retest.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
```

The failed union used the same 23-file list and wrote `focused-final.json`; preflight used only the shared Skill and main-boundary tests. Final standalone typecheck, lint/color, i18n and source build exited 0 after the fixture corrections. Build also runs `tsc`; existing alias/customResolver, output.freeze, large-chunk, mixed dynamic-import and inlineDynamicImports warnings remain visible without configuration changes or suppression. No command is an installer or release qualification.

| Built file | SHA256 |
| --- | --- |
| `dist-electron/main.js` | `1E41098BFC2D41C922133EC59F2E782ACEA6B343ADEC2E5CF8CCB9FBC0720C4F` |
| `dist-electron/preload.mjs` | `2BC7D3C46BC857CF8A2BC116D04ABF459BA6591A00672A3A9A7BB041D253AF5C` |
| `dist/index.html` | `F682B911F3C8FC4F9F6EC8374EC25DBF356F656495BE9A07A6BB56518F05D6AE` |
| `dist/assets/review-chapter.command-Dy_vZmck.js` | `B96989CA8497A09E660C50C23F6AF200C8FCF90EB6ED414764F7A480ED501DA1` |
| `dist/assets/generate-draft.command-C88jY9GR.js` | `5A478F4959C336B51CECEC93A416030C515BBC8E4D83FA97E507E46E77149975` |

## Frozen Source SHA256

```text
D7EC7A4D7E709A50B98FD7DDBF0F06F655DF44F8F227E51A3532C2FA2B93AA7B electron/services/workflow-batch-materials.ts
351CA82D74751A9A3DED1FD7A31A1566DEE116A55F737890C177F8AC458BDDC6 electron/services/__tests__/workflow-batch-materials.test.ts
BA1353360569F4DE1A4E921ACDA255C1C971E7DFA5B40249B15CCC763BBFEEF6 src/services/prompts/prompt-builder.ts
286D0A78BD989A3D380B1608C1648F8832DF8672CD4F519851D8083AB74BF497 electron/services/generation-source-binding.ts
3D328BE7586BFE166F77AFFEED9B493E669A5A81B09EC3F490567DAD99D399A4 electron/repositories/summary-repository.ts
34EC5FCF50D145F776005188E4E52C39E821C345180111D469C3D1C726137B07 electron/repositories/__tests__/summary-repository.test.ts
0E3E63480CB76D33796355A9FBC93C8ED0C0DED4C74AE8D1A446C9CDDA167C66 electron/repositories/character-roster-repository.ts
26D8D31AC95BB14031DE0FA943CF61C66BE9CC9F040606845B4A5AEAD669A721 electron/repositories/__tests__/character-roster-repository.test.ts
3DF0BA49D090621F0DB65F0E3FA6E092523B1109DBFC457284B2D2E383A913FF src/services/prompts/review-chapter-prompt.ts
CDB93C292D27F6CEB1C8027092BEFCC70D4F64A69F634067B77C2315A9FB0589 src/services/prompts/__tests__/review-chapter-prompt.test.ts
4CC9CEE773AC5ED258AA8DD23DE82F75BA530FF275FF258960EF1EF55E82A00B src/services/workflows/commands/review-chapter.command.ts
05F16437BA46622E8F7DD5E85F5C8D74E6A0521DD174AAAF28D64E2E759D03EB electron/services/workflow-review-materials.ts
AD94974AE1C3338576BFF3D624EA2C6FE03B01827F699CB1FC0BAF5C8F4E8284 electron/services/__tests__/workflow-review-materials.test.ts
5A41DF4DDC0563D901472530B7CCC5038F7C9B30756BD6C8F1068A989EB69791 src/shared/writing-skill-task.ts
BDF9D6278B45C59A42D002A0D1595297F6B5F54660669A08CD88E1740C5CBB5E src/shared/__tests__/writing-skill-task.test.ts
7DD1087E10EC4F99502BAC9603747A34F1A165B7E60AE063C6EB9EA170D486DA src/services/workflows/commands/base-command.ts
99F0619640212B5BB438E75A801212046949238C6BB6EBD75C0017F1FDD4DEAD electron/services/__tests__/workflow-materials-main-boundary.test.ts
```

## Immutable Schema13 Capture

Before adding any migration, root reviewed and executed the one-off capture against the immutable parent source closure:

```powershell
corepack pnpm test electron/migrations/__tests__/capture-stage-4b2-schema13.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-4b2/baseline-schema13-capture.json
```

Actual result: exit 0, one file 1/1, zero failed/pending. Report SHA256 `89D3B19D05C494C2273596B7BE6191CBDBAA675EA4EE50FF005B816A97E1EA5E`. Evidence directory: `.runtime/creation-runtime-modernization/stage-4b2/baseline-schema13/capture-8f3T6T/`. `identities.json` SHA256 is `14AE354F8E05775487E5E2E4CBC91F2FF096AF3AB4441CFCB89C6318D233E6D6`; `baseline-sources.json` is `96968A39CF83F2B49FCD99531F52E14071B6081BC78102AC78FD0210D7EBDC08`.

Normal identity: schema13, 61 tables/579 fields, fingerprint `0085a4739a488e00fcb59d22df89d952facecec62afb311b7f4f3d339f21a540`. Donor identity: 61/580, fingerprint `56add2e81a7516281abe9f25091632d441b8c2b55228aeba448cce7feb136e00`; its only schema difference is `characters.avatar`.

Each fixture has two tasks/eight steps/four effects, three attempts/artifacts, one saved draft and one real M11 tail. One task has the real four-effect `waiting_review` history; another is blocked with unknown/partial output. The reviewed helper asserts original DB byte conservation after backup/export, backup domain equality, original attempt/artifact conservation, M11/M12 verification, SQLite integrity and foreign keys. It writes only under a fresh owned capture directory, restores temporary environment variables, refuses real Electron profile access and does not clean up evidence.

The coordinator removed only its one-off repository test after matching its archived copy SHA256 `80B92EAFA8136F9AA0979F8546B00633058A56F2B2C5BA5A1261A8C17913D5C3`. An independent readonly audit matched all 67 immutable closure hashes, current DB/backup/history/archive hashes, all archive payload lengths/hashes and both 28-record nonreplayable freeze sidecars. No second capture or native re-open was performed by the auditor. This is an old13 baseline, not evidence of a future new-current/two-generation restore.

## Limits

DRIVER-002 remains in progress/passes=false; total completed remains 5/35. No new Electron/browser author workflow, complete batch execution, actual process restart, v2 portable migration, real-model quality, human approval, headless or platform qualification is claimed. The original staged repository-analysis document remains excluded from owned changes and commits.

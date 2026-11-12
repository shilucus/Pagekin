# Stage 50: Acknowledged Architecture Adoption And Dirty Document Baselines

Scope frozen:2026-11-12, Asia/Shanghai. Entry `1b7ad2152de79c01dbe4f32bb29014d61c74060e`, master. Stage49 is committed; its ten owned paths match HEAD and index is empty. The two original Stage1B3 documents remain untracked/excluded, and repository-analysis remains unchanged.9/35 features are complete. This is a narrow FEEDBACK-002/UI-002 correctness increment, not full-feature or design qualification.

## Observed Boundary And Acceptance Freeze

Independent feedback_completion_audit traced the actual active-tab rendering and editor/store lifecycle. A dirty architecture tab holds current author text U and savedContent F0. The document is unmounted when the author enters the architecture overview. Acknowledged adoption commits C1, but the overview's current shouldSyncProjectArchTab policy skips the entire dirty tab. Returning to the document remounts it with savedContent F0. Replacing U with F0 incorrectly clears dirty, although formal content is C1; the normal close path then loses this unsaved F0 edit without confirmation. Replacing U with actual formal C1 incorrectly remains dirty. No evidence establishes an automatic database rollback to F0 or an old mounted ref surviving the active-tab switch, so neither is the claimed defect.

| Changed output / behavior | Exact requirement / source |
| --- | --- |
| After successful adoption, a dirty tab retains U but its saved baseline advances to committed C1 | F2 section6.2 author-buffer and acknowledged-domain-effect contract; accepted ADR-0041; actual editor-store savedContent semantics and Stage49 equivalent setup repair |
| Dirty is computed against C1, including U already equal to C1 | Same real saved-baseline contract, editor save/close invariants; no new label or indicator design |
| On actual document remount, changing to old F0 remains unsaved and closing uses the existing confirmation; changing to C1 is clean | Existing ArchFileViewer, writeArchEditState and stage/tab-close behavior, preserving existing unsaved protection |
| Clean/no-tab/session and failed-adoption behavior remains unchanged; no second writer call | F2 single writer, CAS/receipt and session invariants; current StageArchitecture publication is renderer-only |

No new layout, text, resource, entry, dirty-before-start decision, automatic refresh/recovery, generic editor ref effect or writer/IPC/storage change. Closed-instance synchronization and wider overview DB-read rejection remain separate. Stage49's wide-browser failure is not removed or suppressed by this stage.

Acceptance requires preserving current dirty text and revision while advancing only the acknowledged tab baseline; correct C1 equality/dirty behavior; real CodeMirror remount/edit and normal close protection; no additional project-core write; unchanged clean/no-tab and original session/instance safeguards. Static/source review, focused native/store tests, actual browser components, typecheck/lint/i18n and source build are distinct evidence layers. Independent source plus artifact reviews must inspect final bytes and actual reports before scoped commit. Full UI/Electron/model/platform acceptance is not implied.

## Team And Ownership

Root owns shared records/ADR/feature evidence, integration, all serial execution and Git. One implementation owner changes only StageArchitecture.tsx and its stage-architecture-adoption.browser.tsx regressions, reusing existing suitable store actions rather than inventing a parallel persistence API. A separate browser owner adds only architecture-feedback-editor-baseline.browser.tsx for the actual unmount/overview/ACK/remount/CodeMirror/close sequence, using fictional state and a controlled bridge, not real projects. Independent reviewers do not implement this increment. Exact selected models, final source identities, commands, findings and results follow actual work.

## Required Verification Mapping

- Store/refresh/close: current editor-store save settlement, arch-file refresh policy and tab-close tests. The acknowledged baseline action must preserve contentRevision and real author input; do not forge an unrelated generation or persistence receipt.
- Browser: final real StageArchitecture/PlanningFeedbackDialog/default-client path with controlled fictional bridge; author dirty document is unmounted before overview adoption, then remounted with actual CodeMirror. Retyping F0/C1 and closing uses the existing store/close API, not simultaneous editor and overview mounting.
- Regressions: clean/dirty/no-tab, U equal to C1, late session responses and no-second-writer cases; reuse Stage49 session/instance tests only on unchanged bytes and clearly attribute any reuse.
- Root commands use the existing installed Chromium override, no extra pnpm separator, no browser install, real model or user profile. Native/browser/cache/temporary fixture writes and dist/dist-electron build outputs stay isolated and local. Commands are inspected and announced before execution; no package/native environment modification is concurrent.

## Implementation And Independent Review

feedback_completion_audit (gpt-6.1-sol/high) owned the production callback and its eight focused browser regressions; adoption_test_owner (gpt-6.1-terra/high) owned only the new real-workspace browser test. The former is an implementer, not this stage's independent reviewer. adoption_source_review (gpt-6.1-sol/high) independently traced the active-tab, store, editor, close and session paths and reread the final bytes/reports. No narrow-scope blocker remains. A separate artifact review follows the final quality/build records.

StageArchitecture now settles an acknowledged dirty tab through the existing settleTabSave action. It retains U, revision and other metadata, writes savedContent=C1 and compares U with C1. The current revision is read and settled synchronously with no await: this snapshot describes renderer baseline publication after an ACK, not a fabricated database/generation receipt. The clean/no-tab path and real dialog's original session/instance guards are unchanged. No writer, IPC, store API, generic editor-ref effect, layout or copy was added.

The integration test uses the real StageWorkspace active-tab unmount, StageArchitecture, default PlanningFeedbackDialog/client, store, CodeMirror and normal close confirmation. Only read-only overview projection/refresh and the fictional main bridge are controlled. The bridge separates formal C1 commit from delayed ACK; ACK-before and ACK-after assertions preserve U/revision, then actual remount/retyping F0 remains dirty and requests close confirmation, while C1 is clean. It asserts exactly six planning-feedback calls and no additional writer. Mocked overview/bridge do not establish SQLite or Electron execution.

## Actual Commands And Results

Working directory is the repository root. Existing package scripts/configs were inspected. Node24.13.0, Corepack pnpm11.11.0, Vitest4.1.12, Windows x64. Native tests write only local test caches/reports and isolated fictional state. Browser tests use an OS-assigned loopback port and the already installed headless Chromium1228 via process-local AI_NOVEL_VITEST_CHROMIUM; no browser/dependency install or persistent environment change. The local absolute executable assignment below is normalized to LOCALAPPDATA rather than recording a machine user directory. Source build writes dist/ and dist-electron/, without launching Electron.

```powershell
corepack pnpm test src/stores/__tests__/editor-store-save-settle.test.ts src/components/editor/__tests__/arch-file-refresh-policy.test.ts src/stores/__tests__/project-editor-draft-ledger.test.ts src/stores/__tests__/project-refresh-context.test.ts src/services/__tests__/ipc-client-project-session.test.ts --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-12/stage50-native.json
$env:AI_NOVEL_VITEST_CHROMIUM = Join-Path $env:LOCALAPPDATA 'ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'
corepack pnpm run test:browser src/components/stage/architecture/__tests__/stage-architecture-adoption.browser.tsx src/components/stage/architecture/__tests__/architecture-feedback-editor-baseline.browser.tsx src/components/stage/feedback/__tests__/planning-feedback-adoption-session.browser.tsx src/components/editor/__tests__/ArchFileViewer.locale.browser.tsx --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-12/stage50-browser.json
corepack pnpm run test:browser src/components/stage/architecture/__tests__/architecture-feedback-editor-baseline.browser.tsx --reporter=verbose
corepack pnpm run test:browser src/components/stage/architecture/__tests__/stage-architecture-adoption.browser.tsx src/components/stage/architecture/__tests__/architecture-feedback-editor-baseline.browser.tsx src/components/stage/feedback/__tests__/planning-feedback-adoption-session.browser.tsx src/components/editor/__tests__/ArchFileViewer.locale.browser.tsx --reporter=verbose --reporter=json --outputFile.json=.runtime/creation-runtime-modernization/recheck-2026-11-12/stage50-browser-final.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
```

- Native exit0: five files, eleven nested suites,49/49, zero failed/pending. ipc-client-project-session14, editor-store-save-settle5, project-editor-draft-ledger6, project-refresh-context12, arch-file-refresh-policy12.
- Initial browser exit1: three files'30 assertions passed, but the new integration file failed import and executed zero new tests. The separate verbose diagnostic also exited1/no tests: the test's use-stage-work mock omitted useStageView. The test owner changed it to importOriginal, preserving real exports and replacing only refreshStageWork; production behavior did not change. The initial failure report is retained, not counted as full success.
- Final complete browser rerun exit0: four files, nine nested suites,31/31, zero failed/pending. ArchFileViewer.locale11, actual editor-baseline1, parent adoption8, original dialog session/instance11. The verbose execution showed the new real integration case ran and passed; no global unhandled error was emitted in this package.
- typecheck, lint including color literals, check:i18n and serial source build each exited0. Build retained existing alias customResolver/freeze/inlineDynamicImports deprecations, large-chunk warning and ineffective dynamic import warning; no dependency/configuration churn. Earlier Stage49 native SQLite463 and wider browser failure are historical distinct evidence, not this stage's native execution or a claimed full architecture pass.

## Frozen Identities

Entry SHA is1b7ad2152de79c01dbe4f32bb29014d61c74060e plus the following final working-tree SHA256 values. Raw reports remain local ignored evidence; exit/control-flow and the verbose diagnostic are root's execution record, not separately archived stdout or reviewer reruns.

| Path | SHA256 |
| --- | --- |
| src/components/stage/architecture/StageArchitecture.tsx | 0D0284EB51E53471A7B6EEA21667DA8B84BA33A56D13BDEEA081FFB5FA59EE5B |
| src/components/stage/architecture/__tests__/stage-architecture-adoption.browser.tsx | D5874C9D104F0EE65727605A691B7C136EC64149AF6F7E3FC3670BF18A313D77 |
| src/components/stage/architecture/__tests__/architecture-feedback-editor-baseline.browser.tsx | C38EE8F446A1C8D7A34E5A0735F9CD7CED835416552637EAC99861D524C53E80 |
| .runtime/creation-runtime-modernization/recheck-2026-11-12/stage50-native.json | 2493780828AC298DE70AEE87EAFE85A3305676D7036B8D76C2639AEAAE2CAB47 |
| .runtime/creation-runtime-modernization/recheck-2026-11-12/stage50-browser.json | 9A1E5CC5911CA4596EC22EF584A158D9EDD797A124F653C385512100BCAE8A63 |
| .runtime/creation-runtime-modernization/recheck-2026-11-12/stage50-browser-final.json | 8C98C0394202DA8C5DACEE571C0570A157A107047BC96D200E3D446D63B139DC |
| dist/index.html | 0D71B40985A44204213BC9802A7C1029BDAE792590F9A8D9EC00DCB8CA6825FC |
| dist-electron/main.js | EABC1D5582D4C923CA0BBDF6401403AE037747792A7DDC1C57E38DD1DB202B5E |
| dist-electron/preload.mjs | CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B |

No feature flag is promoted. The wider overview DB-read rejection, dirty-before-start/history/closed-result synchronization, complete feedback UI design, real models and target-platform qualification remain incomplete. No Electron, visual comparison, package, real author data or external state was exercised by this increment. Cross-file retrieval used direct definitions/imports/calls and tests because graph/AST/LSP services were unavailable; no whole-repository completeness is inferred.

Final independent artifact review by stage49_artifact_review (gpt-6.1-terra/high) matched all nine table identities, raw per-file denominators, the three original protected hashes and the empty index. It confirmed only seven owned paths plus the two excluded original untracked documents, and9/35 completed with no status promotion. Its sole record finding was stale pending-build wording in implementation-log.md, corrected before commit. No source/raw/build changed after this review. Root separately checks final record diff, hooks, exact paths and post-commit preservation. Review is artifact inspection, not command rerun or full-feature acceptance.

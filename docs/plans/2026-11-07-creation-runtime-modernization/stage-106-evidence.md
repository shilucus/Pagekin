# Stage106: Genuine Same-Base Two-Round Feedback

Date: 2026-11-15. Actual execution base:
`09675d1a859686e9882672bb3a6c6516e536f83b` plus the separately frozen Stage104
source/build identities. This is R3/UI002 partial production evidence, not a
feature completion, new visible UI, literary quality or platform qualification.
Stage numbers identify evidence slices, not counts or a serial feature DAG.

## Frozen Scope And Ownership

Agent5 changes only four existing verification-tool files: `drive.mjs`,
`real-scenarios.mjs` and their args/feedback-scene tests. Terra independently
reviews the final identities before Root executes any model request. Root owns
integration, actual model budget, records and Git. Agent4 independently reads
the actual JSON, console and all five screenshots after execution. No product
UI wording/layout, schema, writer, candidate/adoption policy or model config is
changed by these tools. The existing author entry, diff, iteration, candidate
tabs and adopt action are the design sources in ADR0021/0041/0049; unconfirmed
UI002 states are not filled in by inventing new controls.

| Original need / AC | Actual check | Boundary |
| --- | --- | --- |
| R3: several rounds from author feedback | Real architecture premise entry captures one base; C1 is generated but not adopted. The existing iterate action selects it as the next basis, then C2 is generated. | Same base and same process, not a new automatic workflow or cross-base inferred parent. |
| UI002 candidate/official-buffer isolation | Both generations leave official premise unchanged; C2 parentCandidateId and generationParentHash bind C1, with independent generation origins. | This is one clean-buffer field/state/viewport, not all dirty-buffer/partial/conflict designs. |
| Explicit author adoption and persistence | Only C2 is explicitly adopted once; official text/hash, beforeValue/hash and revision align with the durable author-action receipt. Both candidate snapshots remain unchanged. | Candidate generation is not official saving; no automatic adopt or human-final-approval capability. |
| Reopen evidence | Existing dialog entry captures a new empty base at the new official value/revision. Read-only IPC re-reads the old two-candidate/one-adoption history unchanged. | oldBaseHistoryVisibleInUi=false; no old-history UI or cross-process recovery claim. Reopening capture is a domain write, not called read-only. |

The new exact-allowlisted `real-feedback-multiround` requires explicit
`--real-model --max-real-requests 2` and cannot restart. The old one-round scene
keeps its default1 and existing larger-budget option behavior. Endpoint/guard
module is unchanged: only POST to the exact authorized loopback generation
endpoint; no embeddings, redirect following, automatic unknown resend or third
physical request. Isolated profile stores a placeholder, not the key; key is
injected only into the in-memory fetch policy and stripped from Electron env.

## Actual Verification

Repository root; Windows x64, Node24.13.0, Corepack pnpm11.11.0, Vitest4.1.12,
Electron44.9.3. Root sets COREPACK_ENABLE_NETWORK=0. R denotes
`.runtime/creation-runtime-modernization/resume-2026-11-15/`. Only a recoverable
fictional project/profile is used. Secret is supplied via hidden secure stdin
into process memory, never argv, records or config, and cleared in finally.

```powershell
corepack pnpm test scripts/redesign/__tests__/drive-args.test.mjs scripts/redesign/__tests__/real-feedback-scene.test.mjs --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage105-feedback-multiround-final.json
corepack pnpm test scripts/redesign/__tests__/reference-imitation-scenario.test.mjs scripts/redesign/__tests__/reference-run-background-scenario.test.mjs scripts/redesign/__tests__/drive-args.test.mjs scripts/redesign/__tests__/real-feedback-scene.test.mjs scripts/redesign/__tests__/real-model.test.mjs --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage105-106-tools-final.json
corepack pnpm run verify:drive -- --scenario real-feedback-multiround --real-model --max-real-requests 2 --out .runtime/creation-runtime-modernization/resume-2026-11-15/stage106-real-feedback-multiround --theme light --dump-dom --console
```

- Implementer behavior RED is37/44,exit1; first GREEN44/44,exit0; final two
  files46/46,0failed/pending,exit0. Matching JSON/log names are
  `stage105-feedback-multiround-{red,first,final}.*`, retained individually.
  The Stage105 name is raw provenance, not an IMPORT002 completion claim.
- Root final five actual tool files134/134,0failed/pending,exit0: args36,
  feedback10, unchanged guard20, imitation4 and background64. These are pure
  tool tests, not five Electron/model runs. Tests call scene.run and reject
  wrong parent/hash, premature official writing, lost old history, third request
  and first-round unknown without an automatic next round.
- Current source build and typecheck/lint/colors/i18n exit0 before execution,
  in `stage104-*-retest.log`. Existing build warnings are preserved. Build
  identities are separately bound; later project-open/blueprint recovery work
  is not silently presented as present in this earlier execution.
- Actual real-model command exits0. Authorized Gemini 3.8 Flash (High), exact
  `gemini-3.8-flash-high`, makes two POST `/v1/chat/completions`, both200.
  Request timing total10105ms/max5160ms measures only fetch response headers,
  not end-to-end generation latency, throughput or a performance improvement.

## Actual Products And Screenshot Checks

- Base: `62d180fa-f91f-4a83-975f-3184357870ab`.
- C1: `a93cf603-5d7b-4a2d-852a-fff9efb85e3b`, round1, no candidate parent;
  hash `d8fa47ad47d3bbd5700ca756fce3c6d2a62b9ee451e18116efea6402b054298c`.
- C2: `8f2df197-3b9e-4ab6-961e-0a61fc5c9869`, round2, parent exactly C1;
  generationParentHash equals C1 hash, text hash
  `811b5db4dc5b08dc4d743d79d286cb054c97e43bb9e48382a2c4a410272b1662`.
  Both rounds have distinct actual run/attempt/artifact origins, with frozen
  model/skill identities and distinct context identities.
- Adoption `c4988cc8-128b-468d-b413-44deab1f0594` is the sole author-action/full
  receipt, binding C2; official source revision3 becomes4. beforeHash is the
  original `532a301a24d9dde5b8a8062659df83e6078dd3795275dade80e4d5162ac20bd7`.
  C1 is then conflict, C2 adopted; neither candidate snapshot is rewritten.
- Reopened new base `131879cb-f3a7-4e3a-9938-a7baafc83c3d` has official C2
  text/hash/revision4, zero candidates/adoptions. Old history is deep-equal via
  read-only IPC after this capture. Reopen generates no model request.
- Root and Agent4 each inspect all five1440x900 light PNGs: C1 has one round
  tab and diff +5/-3; C2 has two tabs, C2 active and diff +5/-2; adopted and
  final show the official C2 excerpt without the dialog and have the same PNG
  hash; reopened dialog has no round tabs or candidate/adopt control. Counts
  4/4 architecture,8 blueprints,1 roster entry and old chapter tab are seed,
  not new generated facts. This does not grant dark/mobile/bilingual or pixel
  equality qualification. Existing candidate-pane clipping/design gaps are
  outside this unchanged-tool slice and UI002 remains incomplete.

Quit is resolved219ms, unforced and no kill. Console has only existing developer
CSP warnings, no BUSY/generation/page errors. Removed isolated model config1;
key scan8 files has0hits/0unreadable/0removeFailures. External requests/writes
and residual processes are empty only within recorded observed-before-quit and
profile coverage, not a complete network/security attestation. Original roots
and evidence are preserved; no real author data is read or modified.

## Review, Self-Check And Remaining Work

Terra independently accepts final four tool files and raw RED/GREEN before
execution; Agent4 independently accepts the actual two-round candidate/adoption/
persisted-history chain after inspecting raw and all PNGs. No unresolved
correctness issue is found in this bounded slice. Root partial self-check maps
only original R3/UI002 needs above, preserves same-base/parent/unknown/receipt/
explicit-adopt boundaries, and separates actual model evidence from pure tools,
static checks and absent quality/platform/design evidence.

UI002 stays in_progress/false: full per-target empty/busy/failure/manual/partial/
conflict state designs and matched-viewport checks, dirty-buffer initiation and
old-history discovery are not completed by this one clean-buffer premise path.
No new feature is promoted. Root's initial12-physical-request discretionary
budget has used4: protocol probe1, prior single-round1, this two-round2;8 remain.
There has been no unknown resend, repeat candidate adoption or hidden model use.
Final source/raw manifest, metadata checks and scoped local commit follow; exact
commit/postcommit checks are recorded in the next implementation-log update.

# Stage 6D1: Reference Grant Cutover Repair And Traceable Acceptance

Date: 2026-11-08. Parent: `413a21e4479b642e22730aa16c614c34bc9d4233`.

## Scope And Team

This stage repairs the schema 14 physical-format cutover's missing `preReferenceImportGrantsDomain` check and evidence type, and closes the bounded grant foundation's native lifecycle, cleanup and old-archive coverage gaps. It synchronizes exact current-lane test expectations with the already registered M14 without changing historical target versions or immutable fingerprints. It creates no policy, schema, public IPC, execution capability, UI or independent plugin change. IMPORT-001/002 remain incomplete.

Root owns the production branch/type, migration and captured-runtime tests, integration, records, serial commands and Git. The original `gpt-6.1-sol/high` storage implementer owns only its repository fixture cleanup and accurate reconstruction naming; the original `gpt-6.1-terra/high` portable implementer owns only its portable fixture cleanup and schema 14 compatibility case. Two independent inherited-configuration reviewers inspect requirements/storage and authority/lifecycle without writing implementation. Their exact inherited model names are not exposed by the collaboration interface; no unobserved model or fallback is claimed.

## Identity And Execution

The [31-file source manifest](stage-6d1-source-manifest.json) binds the integrated Stage 6D foundation and current repairs, plus the existing cleanup helper. Root checks its hashes against the working files before acceptance. Actual commands run from the repository root, using Node 24.13.0, Corepack pnpm 11.11.0 and Vitest 4.1.12. Native tests use isolated fictional SQLite/Lance projects; no real works, credentials or model calls are used. Bounded imports, definitions, direct callers and diffs substitute for unavailable graph/AST/LSP tooling; this is not whole-program proof.

### Retained Failures

- `corepack pnpm test electron/services/__tests__/project-format-migration.test.ts -t "schema 14" --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-6d1/red-schema14.json` reproduced the original production defect. One selected case failed; 44 intentionally filtered cases were pending. A missing old-domain projection incorrectly returned `ready` and crossed both rename checkpoints. Raw SHA256: `57C54B51EA537C7E1D91B9654CE14C898636E1372A9F56E8F640280EA32E1C76`.
- `focus-first.json`: 201/206, zero pending; the default parallel run exceeded the default 5000ms in five nested native-migration matrix cases. `focus-serial.json`: 204/206, zero pending; verbose output explicitly identified the same default timeout for schema 13 and 14 despite one worker. The tests were expanded into independent source-version/mode cases; no assertion, product check or timeout was relaxed.
- `focus-expanded.json`: 244/246, zero pending. The two new fixtures violated existing contracts: a non-UUID operation key and omitted required import counts. Only those inputs were corrected; production validation and expected failures remained intact.
- `impact-first.json`: 495/515, 20 failed and zero pending. The failures were stale current-version 12 assertions, a synthetic registry missing the new M14 identity/slot, and pre-M14 portable current-field counts. The repairs retain explicit historical targets, signed S01 counts and immutable donor fingerprints, add the exact M14 owner/13-field disposition set and missing-policy refusal, and verify schema 14 before upgrading to 15. Raw SHA256: `B746FCC47286719B16A31BFA25DC953B7D75B8941855D84F1EDF32FA63E88AB2`.

### Current Focus

Actual seven-file final command, all with `--maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-6d1/focus-final.json`:

```text
corepack pnpm test
  src/shared/__tests__/reference-import-grant.test.ts
  electron/migrations/__tests__/m14-reference-import-grants.test.ts
  electron/repositories/__tests__/reference-import-grant-repository.test.ts
  electron/repositories/__tests__/import-run-captured-runtime.test.ts
  electron/services/__tests__/reference-import-grant-portable.test.ts
  electron/services/__tests__/project-format-migration.test.ts
  electron/services/__tests__/sqlite-project-migration.test.ts
```

Result: 246/246, zero failed/pending, success=true. Raw SHA256: `2D49698A8D0940C47D3C7CD1F02C85290733E7945633B7262D3D1261B96D628E`.

Coverage includes exact payloads, native grant revision/scope/transaction ordering, original-project actual native close/reopen with stale-resource refusal and no reconstructed execution, cleanup containment/link refusal, M14 interrupted migration byte preservation/retry, schema 8-14 normal and missing/tampered projection cutover, reference-grant staging contamination, two portable generations and old frozen grants/new lineage, unknown fields/sidecar loss, and a real schema 14 archive consumed by the current restore/upgrade/current-authority path. The latter is a current-tool-constructed old-format compatibility fixture, not an immutable archive emitted by a prior exporter; both its input DB and archive bytes are checked unchanged.

## Final Native Union

Actual command:

```text
corepack pnpm test electron/migrations/__tests__ electron/services/__tests__/portable-project-format.test.ts electron/services/__tests__/portable-runtime-freeze.test.ts electron/services/__tests__/project-archive-service.test.ts electron/services/__tests__/project-restore-service.test.ts electron/services/__tests__/workflow-driver-portable.test.ts electron/services/__tests__/workflow-batch-portable.test.ts electron/services/__tests__/planning-feedback-portable.test.ts electron/services/__tests__/runtime-feedback-grant-portable.test.ts electron/services/__tests__/generation-recovery-tail-portable.test.ts electron/services/__tests__/portable-schema7-restore.test.ts electron/services/__tests__/portable-superseded-authority.test.ts electron/repositories/__tests__/import-run-repository.test.ts electron/repositories/__tests__/import-captured-domain.test.ts electron/services/__tests__/import-generation-captured-admission.test.ts src/shared/__tests__/reference-import-grant.test.ts electron/repositories/__tests__/reference-import-grant-repository.test.ts electron/repositories/__tests__/import-run-captured-runtime.test.ts electron/services/__tests__/reference-import-grant-portable.test.ts electron/services/__tests__/project-format-migration.test.ts electron/services/__tests__/sqlite-project-migration.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-6d1/union-final.json
```

Exit 0. Actual 38 files, 733/733 passed, zero failed/pending, success=true; 82 nested suites are not files. Raw SHA256: `801AC9C5A9318C7100BA0AB4B01F30D0DAED7BFC4CF8F101AF21E446A10989EA`. Reports overlap and are not summed. Both independent reviewers directly consumed this raw and matched 31/31 current identities in manifest SHA256 `958702497D205F621EB25D73F772B9714E2FFB8DC5F9379F8CEC670FB1F8C9A0`, accepting only the bounded foundation's source/native layer without an unresolved in-scope correctness finding.

## Static And Source Build

Root executed `corepack pnpm run typecheck`, `corepack pnpm run lint`, `corepack pnpm run check:i18n` and `corepack pnpm run build` serially; all exited 0. Logs remain under the same ignored Stage 6D1 directory:

| Log | SHA256 |
| --- | --- |
| typecheck.log | `03E3D3DE0E843E6ABAB5F6378CB00A24A2D6CFDF465E35645941B422F23C3951` |
| lint.log | `6CE4C257BF43D486DB878A14A45AB4F95615658A54DF66EA841886652C02B5D5` |
| i18n.log | `0BB4103143B35826447124D5D4F2EC4890CEE712E1D993E3FDEDD41CB45BB337` |
| build.log | `6699828DABF2802B12957F7935890CD0D1A3A69C126532207D9317CC48F43676` |

Current build identities:

| Artifact | SHA256 |
| --- | --- |
| dist-electron/main.js | `69071658DE892A036DF510463F71CF291814D1D3150F647AE2C9BB8BB04A1C5E` |
| dist-electron/preload.mjs | `CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B` |
| dist/index.html | `E5A2CEB6F094E25BABAAA5A118ACDC2FA7C9F32A22D2EC1420959773F936E55E` |
| dist-electron/project-format-migration-D_Fllt5h.js | `7D58E63A1D3AAAD059FA04A8BBFD4A1D246FC72EE5AECA0BAD03A0D5F8B80866` |

The migration repair is in a split chunk; the unchanged main-bundle hash alone would not prove its identity. Build retains existing alias/inlineDynamicImports deprecation, invalid `freeze` option, dynamic-import and large-chunk warnings. No dependency/configuration change or warning suppression is included.

## Acceptance And Limits

Both independent reviewers accepted the current internal foundation and repair after directly consuming raw reports, all 31 identities, four logs and four actual referenced build artifacts. Root accepts ADR-0039 only for this internal grant/history foundation revalidated by Stage 6D1; the historical Stage 6D `pro`/PASS is not retroactively confirmed. Final metadata consistency and exact-path/index/hook checks precede local commit.

IMPORT-001/002 stay in_progress/passes=false; six of 35 features remain complete. Production driver/capability wiring, authoritative refresh, complete deconstruction, separate imitation style consumption and actual Electron remain open. No performance, literary-quality or target-platform acceptance is inferred from native tests or source build. No dependent feature or global gate is silently unlocked.

# Stage 1: PERF-001 evidence

Status: 1A implementation slice reviewed for commit; 1B performance acceptance remains in progress. PERF-001 is not complete. This record is not literary, installation or platform qualification.

## Version And Environment

- Baseline HEAD: `0679303231cc439a0d2285f5c683041d1b347f0f`, plus the frozen implementation files below. Reports use this base SHA; the file hashes bind the uncommitted implementation, not an unchanged baseline build.
- Windows x64; Intel Core i5-9400F; RAM 34,299,277,312 bytes. Driver Node 24.13.0, pnpm 11.11.0; app Electron 44.9.3, Node 24.22.0, Chromium 152.0.7977.167.
- Fictional author-manuscript import through existing stage UI, including finalization/outbox, continuity and reverse inference. No real work, model, credential or imported writing Skill. Built-in prompts are source-bound.
- Fixture: [fake-model.mjs](../../../scripts/redesign/fake-model.mjs), `FAKE_MODEL` (OpenAI protocol, fixture model name `gpt-4.1`, maxTokens 4096, temperature 0.7), routed exclusively to loopback. These labels and reported usage are synthetic, not remote-model evidence. [inferenceReply](../../../scripts/redesign/import-infer-scenarios.mjs) supplies deterministic structured replies.
- One cold application per case; disk caches uncontrolled, explicitly not a cold-cache benchmark. In-memory source tests separately exercise first/warm captures and label that limitation.
- Desktop viewport 1440 x 900, light theme. Existing UI only, no visual redesign acceptance claim.

## Actual Commands

All ran at the repository root using `corepack pnpm` to resolve the pinned package manager. No automatic fixes or real-model flag.

- `corepack pnpm install --frozen-lockfile`: first failed during Electron download; retry with a process-local mirror succeeded, checksum checks preserved, environment restored. No tracked dependency/toolchain change.
- `corepack pnpm run typecheck`: exit 0.
- `corepack pnpm run lint`: exit 0, including color-literal check.
- `corepack pnpm run check:i18n`: exit 0.
- `corepack pnpm run build`: exit 0. Vite warnings: customResolver alias, freeze option, inlineDynamicImports deprecation and a mixed static/dynamic KB import. Not an installer/native qualification run.
- Focused tests below: 15 files / 615 tests passed, 108.75 s; then driver tests: 5 files / 57 tests passed, 3.65 s. After adding default business-directory monitoring, the same 5 driver files passed 58 tests; machine-readable [driver-tests.json](../../../.runtime/creation-runtime-modernization/stage-1/driver-tests.json) was written using `--reporter=json --outputFile=.runtime/creation-runtime-modernization/stage-1/driver-tests.json`.
- `corepack pnpm run verify:drive -- --scenario perf-import-10 --out .runtime/creation-runtime-modernization/stage-1 --theme light`: exit 0.
- Same drive command with `perf-import-100`: exit 1. Workflow and metrics succeeded, but two real-profile shader-cache timestamps changed; isolation remains a failure pending attribution/retest. Failed evidence and scratch root retained; no cache ignored or removed to force success.
- An earlier accidental broad-suite invocation used an extra `--` before test filenames, ran beyond the intended filter and was stopped by terminating only its verified owned Vitest process tree. It is not a passing suite; partial release/workflow/Windows file-system failures remain outside this stage's qualified evidence.

```powershell
corepack pnpm test src/shared/__tests__/performance-baseline.test.ts electron/services/__tests__/performance-diagnostics.test.ts electron/services/__tests__/generation-run-service.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/import-generation.test.ts electron/services/__tests__/import-generation-continue.test.ts electron/services/__tests__/import-generation-budget.test.ts electron/llm/__tests__/owner-visible-stream.test.ts electron/llm/__tests__/openai-provider.test.ts electron/llm/__tests__/anthropic-provider.test.ts electron/llm/__tests__/gemini-provider.test.ts electron/controllers/__tests__/import-controller-persistence.test.ts electron/controllers/__tests__/import-controller-secure-file.test.ts src/services/generation/__tests__/generation-runtime-owner.test.ts electron/controllers/__tests__/generation-controller.test.ts --maxWorkers=2
corepack pnpm test scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/real-model.test.mjs scripts/redesign/__tests__/drive-args.test.mjs scripts/redesign/__tests__/drive-profile-writes.test.mjs scripts/redesign/__tests__/drive-quit.test.mjs --maxWorkers=2
```

## Performance Observations

Raw local JSON/screenshots: [stage-1 output](../../../.runtime/creation-runtime-modernization/stage-1/). Generated files are not committed; this sanitized record and source are versioned. Both completed screenshots were opened and inspected; no blank renderer or layout assertion is inferred from counters alone.

| Chapters | Workflow attempts / failures | Elapsed ms | Requests / failed / 429 | Source read / selected bytes | Receipt reads | IPC DTO bytes | Main RSS peak bytes | Main loop p95 / max ms | Isolation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 1 / 0 | 18766.103 | 32 / 0 / 0 | 1015200 / 465300 | 256 | 209504 | 220561408 | 44.827 / 64.193 | pass under old monitored-root set |
| 100 | 1 / 0 | 69581.409 | 302 / 0 / 0 | 76140000 / 3764700 | 2416 | 1935365 | 317984768 | 104.661 / 175.768 | fail: shader cache timestamps |
| 1000 | not executed yet | - | - | - | - | - | - | - | pending |

Corpus SHA256: 10 chapters `56e4df63d2aa0012c312a4ef6898b3caebb81fe5a7147766095b2b20c69e663d`; 100 chapters `f8c8fac5644b8f19ea488d3135598075b7e1d7f56410e6bb7028fac0c5309b00`.

Two/four-book cases are unsupported and not executed, not successful zero-valued samples. No provider-reasoning events occurred in these fixture responses. No literary-quality or remote execution claim follows from these results. The candidate 100 ms / 500 ms targets remain candidates; event-loop histogram delay is not a measured end-user interaction p95.

The initial monitor omitted the real default `ai-novel-writer-data` sibling. The driver now includes it; temporary-directory tests prove business/configuration changes remain failures. Both previous desktop samples predate that monitoring fix and require strict retesting; the ten-chapter exit 0 is not proof about the previously unmonitored directory. No cache-ignore scope was expanded.

Read-only follow-up after the isolated process tree exited observed the two reported shader caches update again: GrShaderCache 03:50:54.421 -> 03:55:54.509 UTC, ShaderCache 03:50:53.804 -> 03:55:53.895 UTC, unchanged sizes. A separate installed application/GPU process remained active on the real profile; no isolated-root process remained. This supports independent periodic writes but is not writer-handle attribution and does not convert the failed run to PASS. Requested the user to close the installed application normally; never close it or discard buffers on the user's behalf. 1B resumes after that condition or equivalent attributable evidence, preserves the original failed report, and uses a new output directory.

## Measurement Contract And Review

- Collector is opt-in (`PAGEKIN_PERFORMANCE_BASELINE=1`); bounded numeric whitelist/histograms only. No prompt/body/ID/path/raw provider error enters the metrics. Default-off and failing-sink tests preserve business outcomes.
- `generation.dispatch.calls` means logical dispatch; `transport.requests` means a fetch promise reached the transport, and guarded fetch attempts are independently counted. Fixture server accepted-request counts are separate. None proves remote receipt or billing.
- Source byte counters measure returned authoritative chapter contents and the unchanged exact selection; application DTO UTF-8 JSON bytes are not Electron wire bytes. Main RSS is not whole-application RSS. Renderer queue includes its active item.
- Histogram quantiles are upper bounds; elapsed workflow values have one sample per size, not a statistical workflow p95. Main loop uses the runtime histogram; renderer heartbeat measures timer delay, not all interaction latency.
- Deterministic tests cover selected-source corruption, 10/100/1000 first/warm captures, cancellation/failure/429, send-before-failure counts, diagnostic exceptions, complete IPC byte counts, renderer queue/hash/dedup, probe loss and cleanup, and failed-report preservation.
- Independent reviewer `gpt-6.1-terra` / high reviewed raw requirements and integrated source without implementation ownership. Fixed findings: missing counters; discarded failure reports; conflated physical/logical requests; missing fixture denominator; missing probes falsely succeeding; omitted default business-directory monitoring. Re-review found no unresolved code defect blocking the 1A implementation slice. Reviewer explicitly withheld complete PERF-001 acceptance: strict isolation retesting, 1000 chapters and the remaining denominator/coverage must stay open. Root executed tests; reviewer did not claim independent execution.
- Business authorization, source/hash checks, identity/monotonicity, unknown/cancellation, existing flush durability and finalization/outbox remain unchanged. No schema/public IPC/visible output change.

## Frozen Implementation SHA256

```text
6af6ee3abe3a8321879654e47b8e1f48ad65044f966e47aa53be254618312ab8 electron/controllers/__tests__/generation-controller.test.ts
99cfce0f8cd1747e3b89aa1e925f173374b57d702d19e45d57fa4db3224f9831 electron/controllers/generation-controller.ts
1293ad6ef9867306f03fda3b9fa431d1ec42fe002ab64a8eb8759a7b88102e38 electron/controllers/import-controller.ts
2a5a9024eb62afa7747df94833c5fc582c0b8ea33bcd78e186af7e6aa986442a electron/llm/transport-diagnostics.ts
5c544e8d0e89c01e6c8f42e66f14c1a7b7248e413d32b40940d5d9385f5e3bbc electron/services/__tests__/performance-diagnostics.test.ts
f7cb886a4350084fe7c69a429f57c8b05a176b58d1876088be9d12bc0a71ba59 electron/services/generation-run-service.ts
b54fc3843f3f650e84620f1b9e2b0a9f3a8a63588561fb512c9ec376aae9a1e7 electron/services/import-generation-source.ts
7c5ec9cb7bb29ff8191b091fd7701167ed4b58d07bb91bf1580fcd9fe0d23aff electron/services/main-generation-owner.ts
d037623d1ef233d92b4ee85e34bc9ccd9e5f5dd12a7540a7e7d21ad6d5f616f9 electron/services/performance-diagnostics.ts
1b2f7686e3fe1e5faecffaacfc2533cfac929098e016ef478143dd8da8259d77 scripts/redesign/__tests__/performance-baseline.test.mjs
43159ca7c3f37554aeb30c4b0772b41c649abd7b38d2bc358f06d2e64827cec5 scripts/redesign/__tests__/real-model.test.mjs
87e638f1cfbdae62be2b0868547670459be58f7029b2504dc8503b9c41d59358 scripts/redesign/__tests__/drive-profile-writes.test.mjs
f8ca8d228f0dd9fce9f54bca22b7141bed9f65654093b596ddcf60e6479c57be scripts/redesign/drive.mjs
bd4311ad1cdeb6143e07cb8eb73cad970796b3312f2209a4e70edddd8d4d334a scripts/redesign/performance-baseline.mjs
1252ac811a8db57a3bbb63b53358a2e4a78d6a89012622f51535d5cee08e304c scripts/redesign/performance-scenarios.mjs
fa497b0adad154cc4b33d554f84be3568e1905ea4267a0f91882766136c17d86 scripts/redesign/real-model.mjs
8f65e514cc2ce1894f788e1f7b2a4be2b6b61ae741445906d0a65c739249559d src/services/generation/__tests__/generation-runtime-owner.test.ts
f95b380e86b934dd7e34868b78fbfdde279cf851505c7cb8f38abb6ed0e29446 src/services/generation/generation-runtime.ts
dc7db7fa0d706ea80b3286f63c25fc29b31a758e9d04a913c8b908fd39325e12 src/shared/__tests__/performance-baseline.test.ts
1e7efbec9a9bb4aafbb2fe15166136f6dfc387deb0a9bb7823f6b1ceec525a60 src/shared/performance-baseline.ts
```

Built main SHA256: `f597c776478b2c578c7722b5671715c88b46d066d80848b8ec5540f5c613dae3`; preload `43cdfd497507e66511a48782e57a4165c524a0c0d1ec2aed118a62e3f7afbd49`; renderer index `fb8565e7768687e0c214f8cd0d6151b10e84af4eca0bf11a616e8a5a476d2964`. Build chunks remain in the local output; no packaging performed.

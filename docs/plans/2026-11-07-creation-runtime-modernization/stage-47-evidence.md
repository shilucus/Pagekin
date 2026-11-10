# Stage 47: Controlled Single-Book Performance Baseline

Scope frozen: 2026-11-11, Asia/Shanghai. Entry: 2446a1ca107030db816af57c2f16b4aeb7801040, master, Windows x64. PERF-001 only; F2 sections 3.3/5.3/10, actual feature acceptance and ADR-0060. This stage completes obtainable baseline evidence, not multi-book or full IMPORT qualification.

## Scope And Acceptance Freeze

| Surface | Frozen acceptance | Owner |
| --- | --- | --- |
| Numeric observation | Opt-in closed numeric scheduler admission wait/depth and actual import-stage wall time; preserve all business, fairness, cancellation, grant, receipt and physical-drain behavior; observation failures never change results | observation implementer |
| Actual cost/report consumer | Reuse the existing five nonexclusive cost categories, preserve raw and per-side coverage/null/zero, keep transport versus embedding counts separate; bounded representative receipt sampling with full lightweight classification and actual fixture parameter denominators, never reconstruct historical source/configuration | report implementer |
| Closed safe output | Known six-scene report structures, metric names, metadata and bounded source/receipt fields only; reject unknown text/numeric/boolean keys, preserve failures and missing-versus-zero; stdout and JSON share the projected copy while cleanup uses raw objects | output implementer |
| Assets and contract | Record only actually saved failure screenshot paths, preserve lexical/real containment; root owns driver integration, ADR, shared records and commands/Git | root |
| Actual baseline | Same frozen source/build for perf-import-10/100/1000 and perf-long-stream/slow-embedding/rate-limit; serial fictional isolated Electron, no real model; two/four books explicitly unsupported_not_executed, original six reports unchanged | root |
| Independent acceptance | Source/privacy/lifecycle review, focused regressions and quality/build, actual six-scene evidence/identity/screenshot inspection, fix/retest/re-review before completion flags or commit | independent reviewers and root |

The schema-1 raw histogram contract remains numeric and bounded. Existing derived cost schema remains nonexclusive; phase wall times overlap those categories and are not a sum or CPU time. Scheduler waiting ends at admission/rejection, not physical completion; late finish/quarantine must not resample it. Actual import stage wall time is collected at the existing stage executor, with missing/unentered stages absent rather than zero. No full tracing, database/IPC, dependency, UI, new retry/timeout, production activation or policy change is supplied.

Representative diagnostic sampling retains the current 32-run and 32-attempt limits and total observation deadline, reports all lightweight operation counts and omitted denominators, and reads only existing authorized receipts. Fixture HTTP parameter summaries are observations of the controlled server, not reconstruction of historical effective parameters. Fixed fixture setup and frozen hashes establish configured model/Skill sources; missing receipt parameters stay not_recorded.

## Validation Mapping

Focused tests cover stage success/failure/cancel/nonentry and observer errors; scheduler immediate/queued admission, cancel/close/full queue, exactly-once settlement and clock errors; actual derived cost consumer ownership/null/zero/non-double-counting; more than 32 runs/HTTP observations and missing parameter/source data; adversarial unknown numeric/boolean/text keys and paths; real existing failure screenshot linkage; original probe/drain/cutoff/outer-failure behavior. Root runs inspected authorized test filters, typecheck/lint/i18n and serial source build before the six inspected local isolated scenes. No native/build/check overlaps the measured scenes.

Each scene records actual source/build and report identities, fixed corpus hash, platform/runtime, configured and observed model/parameter/Skill boundaries, uncontrolled cache, attempted/failed and applicable observation coverage. A workflow timeout can be a valid failed baseline sample when observation/isolation are trustworthy; it is not a successful workflow. Probe/isolation/cleanup failures are separate evidence failures. No target achievement, workflow p95 from one sample, speedup, real-model quality, remote billing or platform/package qualification is inferred. Original 1000-chapter failure/forced quit and original missing coverage remain history, not overwritten.

Actual implementation identities, commands, results, failures/corrections, review, feature adjudication and commit follow execution.

## Initial Execution And Correction

Root actually ran the inspected twenty-file focused package from the project root with serial workers, fictional fixtures, local test caches and the ignored Stage47 report directory. First result: 875/889, fourteen failed, zero pending, twenty files, exit 1. Every failure was the same ReferenceError in the newly closed report projection: measured used an unbound finalRequestSummary shorthand. First typecheck and i18n exited 0; lint exited 1 for that exact no-undef defect. Both independent source reviewers confirmed the blocker; the output owner changed only that property to finalRequestSummary: requestSummary. All tests and production behavior guards remain unchanged. The old source acceptance is not reused.

Initial output source SHA256: AF0ACA7F66CC28E32A3AC75DEA98FD5B21D0E4591B4F06D7E5F87D9C91DFA340. Corrected output source: 90FFD13D0C06F963A40846258F21A3F8A33649D4DEF94E1CD1B5C3497C7CD2FD. Initial raw report .runtime/creation-runtime-modernization/recheck-2026-11-10/stage47/focused-tests.json SHA256: 6425AD513F5A433F2B2C788A48B50FD51CD345277E5B1CB13F401A8F9106DEA2. Fresh complete retest and quality/re-review follow; no pass or completion is inferred from the small correction.

## Final Focused Execution

Root reran the complete package, not just the fourteen failed cases, from the project root:

```text
corepack pnpm test src/shared/__tests__/performance-baseline.test.ts electron/services/__tests__/performance-diagnostics.test.ts electron/services/__tests__/main-process-scheduler.test.ts electron/services/__tests__/generation-scheduler.test.ts src/services/workflows/__tests__/import-workflow.test.ts src/services/workflows/__tests__/import-run-orchestrator.test.ts scripts/redesign/__tests__/performance-baseline.test.mjs scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs scripts/redesign/__tests__/drive-performance-output.test.mjs scripts/redesign/__tests__/drive-args.test.mjs scripts/redesign/__tests__/drive-quit.test.mjs scripts/redesign/__tests__/drive-profile-writes.test.mjs electron/services/__tests__/generation-run-service.test.ts src/services/generation/__tests__/generation-runtime-owner.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/stream-snapshot-deduplication.test.ts electron/services/__tests__/generation-selection-diagnostics.test.ts electron/llm/__tests__/openai-provider.test.ts electron/llm/__tests__/gemini-provider.test.ts electron/llm/__tests__/provider-physical-close.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/recheck-2026-11-10/stage47/focused-tests-final.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
```

Final focused result: twenty files, seventy-one nested suites, 889/889, zero failed/pending, exit 0. Final typecheck, lint/color, i18n and serial build each exit 0. The focused report SHA256 is 8CC4049753417CC44F238549EDA0B4B7C1B564F0579D0984669F68E5627EBC3D. These are focused deterministic and source-build results, not a full suite, application scene, model-quality or platform/package qualification. Existing customResolver, freeze-option, large-chunk, knowledge-base dynamic-import and inlineDynamicImports warnings remain; no dependency or bundler-policy change was made.

Both independent reviewers re-read the corrected integration and found no unresolved narrow-scope source defect or mandatory missing regression, explicitly retaining actual-scene and artifact gates. Neither reviewer reran project commands.

## Frozen Source And Build Identities

All hashes are SHA256. Entry SHA plus these actual working-tree identities describes the measured implementation; the entry commit alone does not identify uncommitted changes. The process-local PAGEKIN_PERFORMANCE_SOURCE_SHA is cleared for each scene and restored afterward, so raw metadata.sourceSha remains null rather than falsely naming the unchanged entry commit.

| Path | SHA256 |
| --- | --- |
| src/shared/performance-baseline.ts | 080C159EFD4FFDB234F3706522FD916D9AA8F9D56647B0BD8240C268BAF03A9C |
| src/shared/__tests__/performance-baseline.test.ts | 59916F1F178F0DAEBE958C008CD7988908619FF45A4631A29913F19618AC309A |
| electron/services/main-process-scheduler.ts | 0D1625F58F82BDD9AF4633F8966B806C355D8A7D5A6EE247EA497AD639858B89 |
| electron/services/__tests__/main-process-scheduler.test.ts | 88BAC6093EDC4CA1738D9C410C7DE097405A57C4265ADD93B982C8A40867B6CC |
| src/services/workflows/import-workflow.ts | 1207EFB334A86230662A1ECD1D46B5215108C1C66A13BE2D5E8758F243680050 |
| src/services/workflows/__tests__/import-workflow.test.ts | 9648437BAF3482EFFD344CB0F8EA0A47B2A00968DAF7D0DCFC4B04DC90042527 |
| scripts/redesign/performance-baseline.mjs | 92CF46DE2AAF369B882139E2C5BFC5E983499BA1E91B05FA79FFAE0C1A7D758C |
| scripts/redesign/__tests__/performance-baseline.test.mjs | 06EA2CAADC9A77308CC9700F05FDC92DFE8A35F3C0CE9343670C2D70E474A901 |
| scripts/redesign/performance-scenarios.mjs | 8BC89D4C777C3A82F4C7C57EF89172CC73BF57AA2204218957C6CDABF860CF4C |
| scripts/redesign/performance-pressure-scenarios.mjs | FEEDBE21CF29B72A7CC38ACF544D44107E3A6E00E2EAD775D414BD24E74150CE |
| scripts/redesign/__tests__/performance-pressure-scenarios.test.mjs | F4B63614372D91EDC7B0F1CF41B807CA89229747709F3F44984F50F90481757B |
| scripts/redesign/drive-performance-output.mjs | 90FFD13D0C06F963A40846258F21A3F8A33649D4DEF94E1CD1B5C3497C7CD2FD |
| scripts/redesign/__tests__/drive-performance-output.test.mjs | 3AAFD9A674EB74313E749DA6FD21D917E4BD0A662EBD7042631D9D01F63D8DEB |
| scripts/redesign/drive.mjs | 9D3D95FA69AF938F999D84750FF8E81DD8FF962A5A9EEC62444B100BAF6B031D |
| scripts/redesign/__tests__/drive-args.test.mjs | 7BAAB81FD69DB5944BD7625641785436A46397D86B2617C5D75C620A534DA1F2 |
| docs/adr/0060-creation-runtime-performance-diagnostics-and-cost-attribution.md | 38FA05DB7A7214AD101606BED64121219066AAFF4F12AFA5B484EF938EABB05C |
| dist/index.html | AD591CE370CD8930D725BF783010F2008EF1A167C9CF75023EDAA4146992D440 |
| dist-electron/main.js | EABC1D5582D4C923CA0BBDF6401403AE037747792A7DDC1C57E38DD1DB202B5E |
| dist-electron/preload.mjs | CE3796C389B464906E650CF17953392FB23EDD5A18DFB9951A2D7D7EA5147B2B |

Node 24.13.0, Corepack pnpm 11.11.0 and Vitest 4.1.12 are the actually used tools. Windows x64, Intel Core i5-9400F 2.90GHz (six cores/logical processors); Electron scene runtime is read from each actual report rather than inferred from this build.

## Actual Six-Scene Matrix

Root executed this command separately and serially for each scene in the table, after reviewing the actual driver, fake server, source fixtures and cleanup behavior:

```text
corepack pnpm run verify:drive -- --scenario <scene> --theme light --out .runtime/creation-runtime-modernization/recheck-2026-11-10/stage47 --console
```

The scratch parent and output ancestors were checked as ordinary directories without reparse redirection. Each owned Electron profile/project/home/temp/business root is a fresh child of the checked scratch parent; clean roots are removed by the inspected driver, the failed root is retained. Real-profile inspection compares only entry metadata, never content. No user Electron was running at preflight. All six use the same frozen build; no test/build/native/production-source edit ran during measurement. The ignored local report directory is not committed. No real model, credential, remote state, package installation or DSH execution is involved.

| Scene | Exit | Elapsed ms | Fixture requests | Attempted / failed | Actual result |
| --- | --- | --- | --- | --- | --- |
| perf-import-10 | 0 | 19867.9765 | 32 | 1 / 0 | 10 finalized drafts and 10 blueprints verified; normal quit |
| perf-import-100 | 0 | 90027.0984 | 302 | 1 / 0 | 100 finalized drafts and 100 blueprints verified; normal quit |
| perf-import-1000 | 1 | 614877.1538 | 1320 | 1 / 1 | Original 600-second workflow wait timed out; cancellation drained; forced quit; final chapter/blueprint verification not reached |
| perf-long-stream | 0 | 32703.8555 | 2 | 1 / 0 | Two settled attempts, 400 visible fixture chunks and 20 reasoning chunks; exact completed draft verified; normal quit |
| perf-slow-embedding | 0 | 5477.49 | 1 embedding | 1 / 0 | One document/one chunk, approximately two-second controlled request hold; normal quit |
| perf-rate-limit | 0 | 22282.7067 | 1 failed / 1 HTTP 429 | 1 / 0 scenario | Expected failure observed: one unknown, zero settled, empty failed artifact and no resend; normal quit |

Every scene reports guarded-fetch request coverage, zero cleanup failures, zero main/renderer probe-stop failures, zero requests after measurement, zero requests during quit, zero external requests/writes/ignored writes and zero residual processes. Both probes are live in all six: five scenes have observed_metrics, while slow embedding has live_zero_events on both sides, because its separate guarded embedding request does not enter generation/snapshot metrics. This is not missing probe collection or a fabricated generation zero. The 1000-chapter renderer heartbeat is live but snapshot events are not_observed; snapshot queue/hash/processing metrics remain absent/null, and finalized/blueprint count coverage remains unavailable, not zero. The failure's inner diagnostic preserves TimeoutError/TIMEOUT at workflow; the outer safe wrapper is UNCLASSIFIED_ERROR rather than raw error text. Forced quit is retained, not declared a normal-shutdown pass or silently repaired by increasing the deadline.

| Scene | Main event-loop p95 ms | Main event-loop max ms | Sampled RSS max bytes | Renderer heartbeat max delay ms |
| --- | --- | --- | --- | --- |
| perf-import-10 | 62.717951 | 95.420415 | 179068928 | 23.400000035762787 |
| perf-import-100 | 123.994111 | 227.016703 | 277901312 | 21.69999998807907 |
| perf-import-1000 | 146.145279 | 732.954623 | 593997824 | 31.19999998807907 |
| perf-long-stream | 33.947647 | 110.559231 | 136568832 | 19.900000035762787 |
| perf-slow-embedding | 37.617663 | 47.775743 | 151580672 | 12.900000035762787 |
| perf-rate-limit | 34.308095 | 107.806719 | 135958528 | 17.600000023841858 |

These event-loop percentiles belong to the actual Node probe, not workflow or interaction p95; RSS is sampled, not proof of an exact process peak. In particular the 1000-chapter maximum exceeds the candidate 500ms observation target. No target, percentage speedup, quality preservation or fixed throughput is claimed. Two/four books are explicitly unsupported_not_executed in every report, not silently omitted.

### Attribution And Source Boundaries

Actual runtime in each report: Electron 44.9.3 / Node 24.22.0 / Chrome 152.0.7977.167, Windows x64, 34299277312 RAM bytes, 1440x900 light, uncontrolled cache. All import scenes are the existing author-manuscript plus inference path, not completed reference decomposition/imitation migration. Imports configure local OpenAI-compatible gpt-4.1, temperature 0.7 and maxTokens 4096; actual HTTP groups observe exactly those values for all 32/302/1320 requests. Representative detail denominators are 32/32/0, 302/32/270 and 1320/32/1288 (observed/retained/omitted); grouped counts cover all observations and overflow is zero. Long-stream configures maxTokens 32768 and observes both requests at that value with gpt-4.1/0.7. No installed custom writing Skill is used; the controlled fixture identity and frozen code establish this, not reconstruction of old receipts. Historical per-run parameters remain not_recorded where absent. HTTP429 parameter details are not_available_http429; embedding chat parameters and generation usage are not_applicable, not fabricated zeros.

Generation diagnostics keep actual operation denominators: import10 observes/retains 24/24; import100 222/32 with 190 omitted; import1000 1320/32 with 1288 omitted and cutoff true. The failed large sample contains 660 finalized-chapter-notes and 660 finalized-character-state runs and has not entered global/style/blueprints. Main physical requests are 1320, not 1320 complete chapters. The selected import10/100 source projections retain ordered chapter numbers, manifest/content hashes and actual checkpoint ranges; they are not author text or evidence that all historical decisions were stored. The lightweight full operation classification and bounded details are different coverage claims.

Five derived cost categories are actually present, schema2, with fixed main/renderer metric ownership and side coverage. They are nonexclusive and are not summed. Main versus renderer and transport versus generation events stay distinct. Import10/100 actual source body return sums are 899580/7752180 bytes over repeated captures, not disk IO or a fixed-batch complexity comparison. Scheduler admitted counts/wait sums are 40/2.134600000004866ms, 382/14.378699999948367ms and 1320/39.34269999998651ms; no rejection samples means absent/null, not an invented zero measurement. Import1000 records actual author-commit, author-publish and cancelled author-postprocess wall time, leaving unentered stages absent. Embedding is separately one guarded request, not falsely added to generation physicalRequests/usage.

The actual long stream reports 449 notifications, eleven guarded receipt reads, thirteen full publications (136470 body UTF8 bytes), nine durable snapshots (109584 bytes) and thirteen IPC snapshots (145162 serialized bytes). These layers are not interchangeable byte counts. First response/reasoning/visible observations and fixture output are distinct; two settled attempts and exact final text are checked by the scene. This is not a comparison against an unoptimized binary or proof that every cancellation/reconnect branch ran in Electron; focused deterministic tests cover those branches.

### Report And Corpus Identities

| Scene | Report SHA256 | Fixed corpus SHA256 |
| --- | --- | --- |
| perf-import-10 | 2A495C65BA5604F4414FEF877B048D9D176E0AB468E32C8EBBE1426571F7E23D | 56e4df63d2aa0012c312a4ef6898b3caebb81fe5a7147766095b2b20c69e663d |
| perf-import-100 | 457F7D95E26BB515BABB2F872F0B47E4746AACB130DCBD835BC5A99DCA4FDF20 | f8c8fac5644b8f19ea488d3135598075b7e1d7f56410e6bb7028fac0c5309b00 |
| perf-import-1000 | 8418A371ABDC529355BE5256A6B994CCA84810F7BF6DD04CB99741030A1ED74E | ebbbb1afb5a8da6d2968eda768841e17732338ae5dddd582fba9d48af93e2e56 |
| perf-long-stream | EE9A14FFAF8A11A67FDE8A09A69CE110DC8582711CC2DC7EEFC7DFC5F13AE3C9 | d1919b20c99da79662a925598219e858fb1f98f2665523ca208abb001b3a74c6 |
| perf-slow-embedding | 44FA0EA8CFC46EEBB63EB134E48DDD2E03C0E754ACC18132B9FA3D43E804EB89 | 0bd52d9cbbafc3c509f20fc6343dfcc7f319dc044c8deef8f72de466fd131d9d |
| perf-rate-limit | 202A20D71DA2DFAD2DD8236BA94144454CB6CADC47D13A90391F197F9BC6E763 | 1da69fd6cf1ff5c5cda7e15dbb514f18d0d25a6ba68886f1cecde393361eb842 |

Raw files are <scene>-light.json under the ignored Stage47 output directory. Root personally inspected all six actual screenshots; no screenshot is substituted by a nominal path or claimed as visual fidelity acceptance.

| Screenshot | SHA256 | Actual dynamic-state check |
| --- | --- | --- |
| perf-import-10-light.png | 05F3FC6F5FFA28389B5431798A8CEF987F92C4EA3BCBEAFC5BED8A9FE6346DFB | Run title 10 chapters; blueprint/manuscript 10/100 against unchanged target100; one unadopted words-per-chapter proposal 3000 versus860; completed run |
| perf-import-100-light.png | C3BB912769DE66C79F9A5C147CA01D4359D673EF229904E7AC90819DB1A0B908 | Run title100; blueprint100 and manuscript100/100 against target100; same unadopted proposal; completed run |
| perf-import-1000-light.failure.png | F1F42C7D9F9F23F7A98AE4C29AFFF5C2B6D71B9D2F3ED9F31148DFF8454FA49E | Run title1000, cancelled continuity step, later analysis/blueprint steps unentered; navigation1000/100 is not successful workflow verification; core0 words and three required setup items remain |
| perf-long-stream-light.png | 41FD737F06313A4988478CF37169AD60F80898653FC6C66E2535226989712647 | Chapter3/heading3 and draftv2/9200 agree; completed chapter3 run; only2/12 finalized, no automatic finalization |
| perf-slow-embedding-light.png | 8F79FC8250DC5BF846843541AC5BE76CAD7F8A05D2A5240B95F127DEC74C71B3 | Existing chapter3/v1/298 and2/12 finalized remain; report0 severe/1 suggestion/0 checks and selected1/1 are seeded review state, not an embedding-generated manuscript |
| perf-rate-limit-light.png | 423A154B832CD40164768231118759F474FAFA47AD2C8B4FB4A57B6E52A334C6 | Chapter3 write failed before visible prose; report says no new draft/formal chapter; blueprint12 and finalized2/12 unchanged; not generation success |

All sixteen source/test/ADR and three built identities were recomputed after the six scenes and still match. All six original Stage34 baseline JSON hashes were recomputed and match stage-34-revalidation.md, including its failed1000 sample and forced quit. The original two excluded untracked document hashes also remain unchanged. No old failure, source or coverage was overwritten.

## Feature Adjudication Gate

PERF-001 has static, deterministic and performance evidence for the actual AC: fixed three-size single-book samples with unsupported book counts explicit; source/environment/corpus and true failure denominators; real event-loop/bytes/IPC/queue/memory/requests/usage and source selection with missing-versus-zero; separate response/reasoning/visible observations and candidate-only targets. The baseline is allowed to reveal a workflow failure and observed pauses. Independent AC reviewer baseline_audit accepted all three actual AC without an unresolved scope defect or mandatory missing case. Separate artifact reviewer feedback_audit matched all33 identities and six historical reports, independently inspected all six images and accepted the same bounded conclusion. Neither reran project commands; closed stdout/JSON equivalence is source/test evidence rather than an independently retained byte-for-byte terminal capture.

Root therefore marks only PERF-001 completed/passes=true: seven of thirty-five complete, twenty-eight in_progress/false. No incomplete import, multi-book scheduling, real-model quality or platform qualification is promoted with it. Root owns the final twenty-path/index/hooks/exclusion check and scoped commit. Next stage is current-version PERF-002/003 acceptance, reusing these exact source/build observations only while corresponding blobs remain unchanged.

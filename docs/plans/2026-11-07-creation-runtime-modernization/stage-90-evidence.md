# Stage 90: Reject Uncomposed Inbound Workflow Execution

## Frozen Scope

Entry `83ed149c48cfbc60fc3d48b011c0e9c2d982100d`, master,2026-11-14.
Stage89 committed11 reviewed paths, with40bound identities, an empty index and
all protected files unchanged. No unrelated content is owned by this phase.

F2 section7.1/7.3 and ADR0050 require real execution rather than task registration
or simulated success. The current API service stores an optional authority but
never calls a real executor; start/resume fabricate running/resumed command
receipts and initialization events. The bounded repair denies known unavailable
new execution before any owner/event/success receipt effect. Existing identity,
authentication, idempotency/pending/history and unknown protections remain.

Existing `COMMAND_NOT_ALLOWED` plus HTTP503 is a deliberate bounded contract
decision documented in ADR0050, not an invented unknown or an assertion that the
old ADR specified503. Raw authority injection cannot enable an absent executor.
No new broker, privileged production fixture API, persistence or dependency.
No app layout/copy/control is changed; the machine error follows this explicit
API contract, not a fabricated visible design.

## Ownership And Validation Mapping

- Agent2 Terra owns the service, three existing controller suites, MCP adapter
  regression and a narrowly needed test-only history fixture. Root owns ADR0050,
  records, serial commands and Git. Sol independently reviews integration/raw.
- New rejection tests use actual unmodified dispatch. Explicitly fictional Map
  history/pending fixtures cover historical cache replay and guards, not a fake
  executor or evidence that an actual workflow started.
- Required coverage: default and authority-only construction, HTTP503 and MCP
  error, overlapping/repeated rejection with zero owner/event/success receipt,
  pending cleanup, auth before cache, mismatch/unknown/collision precedence,
  exact three-dimensional owner and uniform missing/foreign refusal, cursor and
  receipt reads, human-review scope and unchanged Host/Origin guards.
- Root will run filtered `corepack pnpm test`, typecheck, lint/colors, i18n and
  source build from the root after inspecting targets. Fixtures/reports/cache
  stay fictional/local; no real model/config, new production listener, dependency, package,
  native environment or external/remote state is changed.

At scope freeze no execution result, independent acceptance or API001 promotion
is claimed. The final source/raw identities and results follow actual execution.

## Actual Execution

Root inspects package/Vite scripts and affected tests, then executes from the
project root with Node24.13.0, Corepack pnpm11.11.0 and Vitest4.1.12. Test HTTP
servers use ephemeral loopback ports and are stopped by their existing teardown.
No real user data or provider, install, package, remote or native rebuild occurs.

1. The first five-file test pipeline exits1 because the Stage90 output directory
   does not exist. No test result is claimed from that command. Root creates only
   the local output directory, then reruns and observes53/53 in5files, exit0.
2. Direct CLI call-chain inspection finds old tests using the removed simulated
   execution. Actual CLI-only RED is4passed/8failed of12, exit1. Its raw JSON/log
   remain. Tests are repaired to assert real unavailable propagation and explicitly
   fictional history, never by restoring simulated production execution.
3. Final8files175/175,0failed/pending/todo, exit0, includes all controller core,
   headers, ownership and idempotency, MCP adapter, CLI and shared API/MCP contracts.
   Counts overlap earlier runs and are not summed. No initial service RED exists.
4. Fresh `corepack pnpm run typecheck`, `lint`, `check:i18n` and `build` each exit0.
   Existing Vite resolver/freeze/chunk/static-dynamic/inlineDynamicImports warnings
   remain in build.log. No check or protection is removed to make these pass.

Actual filtered commands use `corepack pnpm test <files> --maxWorkers=1
--reporter=default --reporter=json --outputFile=<path>` (without a literal `--`
before file filters). Exact arguments appear in their raw logs. Raw directory:
`.runtime/creation-runtime-modernization/stage-90/` contains focused-first,
cli-impact-red and impact-final JSON/log, plus quality/build logs. Checklist and
final manifest are added only after the partial evidence records are frozen.

## Review And Limits

Sol independently accepts the bounded source and175/175 raw after reading actual
dispatch and CLI call sites. Identity/collision403/409 precedence, same-key
history, unknown refusal, scope-before-cache and pending cleanup remain. No new
owner, event or success receipt is created for unavailable start/resume, including
raw-authority-only construction, repeats and overlapping requests. Production
HTTP/MCP/CLI mapping remains unchanged; only their regressions adapt to truthful
unavailability. A wording finding is fixed: there is no new production listener,
but the authorized tests do create temporary loopback listeners.

API001 and CLI001 receive two partial records each; all35 statuses, dependencies,
gates and preexisting evidence remain14completed/21in_progress. Fictional Map
history is not a persistent adapter, successful broker dispatch or trusted human
approval channel. No Electron, browser, real-model/quality, speedup, package or
platform qualification is newly claimed. Full production composition remains open.

Checklist36/36 executes after exactly4partial evidence appends. Removing those
four from the current JSON reproduces the complete entry JSON semantically.
The [source manifest](stage-90-source-manifest.json) binds22source,12raw,3selected
built and3protected identities,4reports and14owned paths. Complete344-file build
digest is65bd0a7a0cfa3f7bb3acc5485a6dad92669e1bf0ef2703018d227d3b860082b8;
the API remains uncomposed, and an unchanged build does not qualify production
execution. Sol's final independent artifact audit accepts40/40identities, all4
reports, the complete344-file build, exact14owned paths and full prior feature
semantics. Root confirms an empty index, unchanged protected files, sample-only
hooks and unspecified owned-path filters; scoped commit/postcommit checks follow.

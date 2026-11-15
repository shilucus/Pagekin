# Stage104: Executable CLI Client And Inbound Scope Isolation

Date: 2026-11-15. Parent: `09675d1a859686e9882672bb3a6c6516e536f83b`.
This is a bounded API-001/CLI-001 client and authorization repair, not completion
of either feature. Original35 IDs, AC, dependencies and gates are unchanged;
15 completed/20 in_progress remain, and the14 historical flags are not renewed.

## Scope And Validation Mapping

| Original requirement / AC | Actual increment | Final evidence and remaining gap |
| --- | --- | --- |
| R5/R6; API001 AC1/3 | Project/workflow commands require task or admin scope after caller/project authentication and before pending/cache/unknown decisions. Human-review-only or empty scope cannot read or replay those commands. | Registered controller/MCP six files69/69 within final231/231. No listener, trusted task issuer or executor is installed; new start/resume still503. |
| R5/R6; CLI001 AC1 | Actual Node client entry and package alias; non-wait and initial non-success receipts map existing failure/cancel/unknown/review exit codes before polling. Missing receipt/events cannot become success. | CLI62/62 includes actual child-process/env/stdin/loopback execution, not a fictional fixture relabeled production creation. Full desktop run/wait remains open. |
| CLI001 AC2/3 | Literal explicit loopback endpoint, redirect refusal, command-specific flags, bounded single-credential stdin and pre-JSON credential redaction. Task and human-review credentials stay separate. | Child-process and HTTP tests plus independent review. Existing same-key/cursor/unknown protections remain. Human approval still423; no trusted capability is manufactured. |
| ADR0051 original exit2 | Shared receipt type includes cancelled; a no-cast typed test lives inside existing src typecheck scope. | Genuine static RED TS2322/exit2, then typecheck exit0 and contract100/100. No new state or server cancellation capability. CLI files themselves are not included in root tsconfig. |

Terra owns the two API files, Agent5 the three CLI files, Root package script,
shared receipt/test, ADR and records. Sol independently accepts the API repair;
Terra independently accepts final CLI files and Root's three receipt/ADR files.
Root integrates and alone runs build/native/Electron/Git. Concurrent imitation
and real-feedback tools are excluded from this commit and feature judgment.
There is no new product UI layout, wording or interaction in this slice.

## Preserved Boundaries

- The exact command whitelist precedes scope classification; a fabricated
  human-review-prefixed command cannot bypass it. Authentication and allowed
  project checks retain precedence. Task/admin permission does not grant human
  approval: review listing and approval keep their own checks, and approve is
  closed until a trusted single-use capability exists.
- Scope checks precede pending/idempotent replay and unknown decisions without
  changing the original project/caller/grant/command/key/payload binding. Unknown
  is not resubmitted, and absent production start/resume remains503, not a fake
  succeeded receipt or task registration passed as creation.
- `creation:cli` runs only `node --experimental-strip-types
  scripts/cli/creation-cli-main.ts`. It does not launch an API, discover user
  configuration, connect to SQLite or implement a second workflow engine.
  Explicit HTTP loopback authorities are checked before URL normalization;
  fetch uses `redirect: 'error'`. An actual302 regression is not present, so
  redirect behavior has static wiring coverage rather than claimed HTTP proof.
- Tokens come from the two named environment variables or one bounded stdin
  source, never secret argv. Unknown/duplicate/command-incompatible options and
  ambiguous target/credential sources fail without echoing input or stacks.
  JSON redaction covers both credentials, escaped strings, object keys and
  errors before serialization. `events --wait` is explicitly unsupported, not
  silently ignored or presented as completed CLI001 scope.
- Initial failed/cancelled/pending_review receipts return before requiring a
  task ID or polling. Initial unknown stops without resend. Initial succeeded
  still requires a task and an actual queried execution terminal. Missing target
  receipt is not replaced by the successful outer query receipt. Empty events
  is valid, whereas missing/non-array events fails explicitly.

## Actual Commands And Results

Working directory is the repository root. Windows x64; Node24.13.0, Corepack
pnpm11.11.0, Vitest4.1.12. Root uses COREPACK_ENABLE_NETWORK=0. Tests use isolated
fictional state and ephemeral loopback servers, not author projects/configs.
R below means `.runtime/creation-runtime-modernization/resume-2026-11-15/`.
All pipelines preserve the command's actual exit; counts overlap, not a sum.

```powershell
corepack pnpm test electron/controllers/__tests__/inbound-api-controller.test.ts electron/controllers/__tests__/inbound-api-controller.ownership.test.ts electron/controllers/__tests__/inbound-api-controller.idempotency.test.ts electron/controllers/__tests__/inbound-api-controller.headers.test.ts electron/controllers/__tests__/inbound-api-controller.approval.test.ts electron/services/__tests__/inbound-mcp-adapter.test.ts scripts/cli/__tests__/creation-cli.test.ts src/shared/__tests__/inbound-domain-contract.test.ts --maxWorkers=1 --reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/stage104-api-cli-contract-final.json
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run check:i18n
corepack pnpm run build
corepack pnpm run creation:cli help --json
```

- Final eight files231/231,0failed/pending,exit0. API files:16/14/11/4/11;
  MCP13; CLI62; shared contract100. Raw JSON and same-name stdout log are
  `stage104-api-cli-contract-final.*`. Prior seven-file131/131 excludes the new
  type test and is retained, not relabeled as the final eight-file run.
- Final typecheck, lint/colors, i18n and source build exit0 in
  `stage104-{typecheck,lint,i18n,build}-retest.log`. Build preserves existing Vite
  alias/output-option/chunk/dynamic-import warnings, not a zero-warning claim.
  This is source build, not package, installation or target qualification.
- Actual alias help exits0 in `stage104-cli-script-help.log`, with JSON output,
  no endpoint or HTTP dispatch. No production CLI creation is inferred.
- Static type RED `stage104-cancel-receipt-type-red.log` exits2 with only the
  intended TS2322. Vitest strips types, so this is explicitly a compiler RED,
  not a falsely claimed failing runtime behavior test.
- The first final lint exits1 for two unused imitation-tool bindings, preserved
  in `stage104-lint-final.log`; Luna removes them in her separately owned tools.
  The actual retest above passes. Other first-final quality/build logs remain.

### Retained Implementation And Review Regressions

All CLI JSON reports below have matching stdout logs in R; no failed report is
overwritten. The actual command is the same focused CLI command with the listed
output basename: `corepack pnpm test scripts/cli/__tests__/creation-cli.test.ts
--maxWorkers=1 --reporter=json --outputFile=<R/name.json>`.

| Raw basename | Actual result | Meaning |
| --- | --- | --- |
| api-task-scope-red.json | exit1,6passed/7failed | Seven project/workflow commands initially admitted review-only/empty scope. |
| api-task-scope-six-final.json | exit0,69/69 | Six-file registered scope/ownership/idempotency/header/MCP regression; JSON exists, no invented same-name stdout log. |
| stage104-cli-entry-red / entry-first / entry-final | exit1,26/34; exit0,34/34; exit0,37/37 | Actual executable, loopback/env/stdin and argument boundary regression. |
| stage104-cli-terminal-red / terminal-final / terminal-closed-final | exit1,37/46; exit1,45/46; exit0,46/46 | Exit mappings and missing target receipt; one outdated fallback expectation is retained and corrected. |
| stage104-cli-review-red / review-final | exit1,47/52; exit0,52/52 | Approval terminal mappings and malformed events cannot become success. |
| stage104-cli-initial-terminal-red / initial-terminal-final | exit1,54/62; exit0,62/62 | Failed/cancelled/unknown/pending review with and without task ID; stop before polling. |

Independent CLI review findings are closed on the final three identities,
including the last initial-terminal repair. Scope/auth/replay precedence is
independently reviewed on both API identities. Root's typed receipt test and
ADR are independently accepted after reading the actual TS2322 RED. Final
integrated231/231 and final quality results apply to these exact bytes.

## Partial-Feature Self-Check And Next Work

1. Requirement/AC: R5/R6, original API/CLI AC and ADR0050/0051 above; no added
   feature, policy, dependency, compatibility state or acceptance prerequisite.
2. Delivery: real executable client and real registered authorization paths are
   delivered. Fictional controller history, helper/child tests and task IDs do
   not stand for production creation, persistent history or full CLI commands.
3. Correctness: authentication/project/scope precedence, exact replay identity,
   unknown no-resend, cursor read retry, credential separation and human gate
   remain; independent in-scope findings close. No author buffers are touched.
4. Evidence: final actual compiler/tests/quality/source build are distinct from
   static review, loopback child tests and unexecuted production/model/platform
   qualification. No quality non-regression or speedup is claimed.
5. Alignment: only API001/CLI001 partial evidence is appended; both remain
   in_progress/false. Next is original desktop issuer/executor/persistent
   receipts, not headless or new all-adoption policy. Existing production
   composition gaps remain code/contract-local, not a global block.

Stage102 was committed as `09675d1a859686e9882672bb3a6c6516e536f83b`;
postcommit139 identities matched the reviewed manifest, index stayed empty and
three protected files stayed unchanged. The Stage104 manifest binds owned source,
read-only dependencies, exact reports and build/protected identities. Final
record checklist and independent record/path audit precede the scoped local
commit. The commit SHA and postcommit checks are recorded in the next log entry.

Actual record-only command:
`corepack pnpm test scripts/__tests__/creation-runtime-feature-evidence.test.ts
--reporter=json --outputFile=.runtime/creation-runtime-modernization/resume-2026-11-15/checklist-stage104-final.json`.
It exits0,36/36,0failed/pending; same-name stdout log is retained. A structured
comparison against parent confirms no non-evidence feature field changed,
including status, AC and DAG. These are metadata checks, not product acceptance.
Sol independently audits the current source/records/raw and finds no blocker:
all75 initially bound identities match, final231/231 and retained failures are
accurate, the three protected and seven concurrent tool paths are excluded.
The two metadata identities and affected record hashes are appended for a
final narrow recheck before Root's scoped local commit.

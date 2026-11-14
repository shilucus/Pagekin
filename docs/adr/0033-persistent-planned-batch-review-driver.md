# Persistent Planned Batch Review Driver

Date: 2026-11-08. Status: accepted for the DRIVER-002 implementation package after actual deterministic/native, portable, old13 conservation and three isolated Electron runs plus independent requirements and lifecycle/storage review. [Execution and source identities](../plans/2026-11-07-creation-runtime-modernization/stage-4b2b-evidence.md) bound this acceptance. This is not approval of future global gates.

Sources: [F2 sections 4.2, 7.1, 7.2, 7.6 and 7.8](../plans/2026-11-07-creation-runtime-modernization/README.md), DRIVER-002, [ADR-0032](0032-persistent-prepared-chapter-driver.md), and the current generation, batch, draft, ordinary-review and material contracts. Parent implementation: `61f6d3661b895fc0330c7fcb680aa9b9061e2989`.

## Scope And Authority

The internal template `prepared-batch-review-v2` accepts an explicit contiguous range of at most ten already planned chapters. It runs all sequential drafts first, then ordinary machine reviews in chapter order, and enters `waiting_review` only after every real draft/review receipt is reconciled. It never finalizes, manufactures a human-confirmed review, revises prose automatically, adopts a candidate or supplies a new planning workflow. Version-1 tables, IPC and fixed first-chapter semantics remain unchanged.

Start explicitly identifies operation key, draft model, review model, range/target, UI locale and author inputs. Main captures the project writing language, all three draft/review templates and installed `drafting`/`review` Skills; target units use the existing supported chapter interval, not a new fallback. Model keys/credentials never cross into a task recipe. The two full safe model receipts are frozen independently, and the review-model identity/hash are excluded portable authority. Each chapter reuses the existing main-safe materials, source binding, role-card/predecessor/empty-target gates, knowledge gate and domain writers.

The existing batch workflow supplies `draft:author-config` and `draft:target-units` to its root and requires every child to retain them. V2 main generates these same inputs from the captured project and explicit target, then persists them in the recipe/root. Start `authorInputs` is an optional assertion of either existing value (an empty array is allowed); duplicate or unsupported IDs and mismatched values are refused. Arbitrary extra instructions are not accepted and silently omitted from prompts. The operation hash covers the original closed start request, while the recipe records the actual captured inputs.

Only the existing desktop main broker may issue a private caller-bound capability for the captured runtime/native DB/epoch/task/revision. View detach/switch is not task cancellation. Sender destruction, true close and maintenance converge through the existing physical owner. At most one runner and one physical request belong to a task; ignored abort keeps its slot and work claim until physical finally/idle. A row, public reference, history, command ID or matching OS account is not authority.

V2 IPC is a closed literal set: `workflow-batch:v2:start`, `read-receipt`, `pause`, `cancel`, `resume`, `reauthorize`, `read-history`. Start, reauthorize and history require a fresh exact author-view session. Other operations require the actual private sender issuance. No public approve endpoint is added. The generation firewall recognizes the batch root and every draft/review run, refusing generic or legacy access. It must not disable the existing explicitly confirmed author revision/recheck workflow described below.

### Cleanup Failure Retention

Stage92 clarifies the existing ownership invariant without adding IPC, durable
authority or a new retry policy. Pause/cancel report durable logical state only;
they do not attest physical drain. A known task/root persistence or cleanup
failure is returned as failure and retains the private cleanup intent, runtime
work and owner/busy fence. Logical claim revocation alone cannot retire an owner.

Release requires engine settlement, actual physical drain, full owner quiescence
and successful durable task/root/read reconciliation. The physical-idle promise
alone does not cover pending operations, queries or tool claims. Failure at any
required boundary retains debt; eventual release is idempotent and happens once.
Acquire runtime work before first durable root effects so acquisition rejection
cannot publish an unprotected active task. Preparation rollback failure likewise
cannot be relabeled successful cleanup.

Only the original private subject with the current task revision, or the existing
true project-close path, may retry retained cleanup. This is not resume or model
retry: no dispatch, unknown resend, source recapture, new grant or owner handoff
is permitted. A cancellation intent cannot be downgraded by later pause/close.
Concurrent cleanup attempts coalesce. Read-only receipts do not trigger cleanup;
they can supply the actual current revision for an explicit authorized control.
If physical idle still leaves other pending owner work, retain the fence until
it ends and a subsequent authorized control/true-close retries reconciliation.
Sender destruction does not erase debt or give a new sender its capability.

This private in-memory recovery seam does not add portable authority, change
author-visible controls or replace the existing restart/unknown receipt rules.
Its acceptance requires actual injected failure regressions and independent
review recorded in [Stage92](../plans/2026-11-07-creation-runtime-modernization/stage-92-evidence.md).

### Existing Author Followup

An ordinary machine review is still a valid starting point for the existing author confirmation, generated revision, manual merge and single recheck. These actions do not belong to the automatic batch template and do not grant access to its root or registered steps. Before any lease or unrelated admission side effect, the legacy owner obtains a readonly proof from the private captured review-revision context. It binds the actual cycle, original saved review receipt, registered v2 review step, exact parent root and live nonportable source. The native transaction repeats those checks before root activation/run creation. Only a successful COMMIT publishes a process-local exception for the exact new author child; rollback publishes none.

The original root policy, physical limits, source/model/Skill checks and domain writers still apply. An operation name, pending task state, arbitrary sibling run or durable plain marker is not admission. Explicit review-revision recovery re-proves the same exact child and captures current sources before granting current-owner access. Saved ACK recovery uses the actual strict receipt and does not require a recheck already committed as completed to be required again. Interrupted dispatch is settled to unknown only for that proved child, under the existing cross-owner physical-task/claim interlock. Generic recovery continues to skip driver roots; unknown requests are not resent.

## Runs, Steps And Recovery

The batch root freezes `draft_review` intent and all assets. Each chapter draft is a real child of that batch; each review is a new ordinary-review root, using the existing prepared context and source CAS, never a batch ID or unproved parent. First run creation and role/first-step binding share one native immediate transaction; capability publication follows COMMIT. Failed opening rolls back its in-memory lease without changing another owner.

Sparse steps are created only after the existing algorithm chooses a branch, but always before its effect. Exact canonical input, stable command ID, role/chapter/run and invocation nonce are persisted first. No skipped-state policy is invented. Same key/different input, cross-task/role/chapter run reuse and duplicate commands are rejected. Model/KB awaits never occur inside a synchronous SQL transaction.

| Role | Allowed slots per chapter | Existing decision retained |
| --- | --- | --- |
| draft | outline 0..1; draft 0; continue 0..6; condense 0 | Original one short-outline retry; seven shared continuation/recovery rounds with at most one no-progress recovery; at most one condense |
| draft | compose 0..8; draft_commit 0 | Initial prefix 0, accepted continuation i+1, accepted condense 8; every accepted prefix gets its original composition receipt |
| review | review 0..1; review_rebuild 0..1; review_commit 0 | Each original structured-output purpose allows at most two physical requests; length replaces the whole output, invalid complete output uses one rebuild stage |

There are at most 26 actual steps per chapter. Discarded low-progress output remains an observed model receipt, never an accepted composition. Billing `unknown` alone is not output failure: existing finish/failure/tail/artifact checks decide whether an output is known. Truly unknown delivery is not resent. The second outline uses the existing `draft-short-outline-retry:<failedAttemptId>` nonce and retry admission, rather than bypassing it with generic execution.

An effect references only the original attempt and exact content hash: model observation, historical composition on that attempt, authoritative draft commit, or authoritative ordinary review commit. The existing review service exposes its strict readonly saved-receipt proof; the new repository does not invent review success. Native effect/ledger callbacks reject async results and keep revision/source/cancellation checks at the actual commit barrier. A lost ACK queries the original receipt and only fills the reference, even after state changed; changed prose is retained and blocked, not treated as an absent write. Reauthorization is explicit and rechecks original source/model/Skill bindings before any new work.

## Storage And Portable Classification

The central registry alone appends M13 after immutable schema13; migration creates only three tables/constraints/indexes. It does not scan old runs into new capabilities or weaken M12 checks. Old13 normal/donor DBs and nonempty histories were captured from the immutable parent before this implementation.

| Table | Historical H | Restricted R | Excluded X |
| --- | --- | --- | --- |
| workflow_batch_tasks | task_id, project_id, template, batch_run_id, revision, state, blocked_code, recipe_hash, created_at, updated_at | recipe_json | operation_key, request_hash, review_model_id, review_model_hash |
| workflow_batch_steps | step_id, task_id, chapter_number, role, kind, slot, command_id, run_id, input_hash | input_json | invocation_nonce |
| workflow_batch_effects | step_id, receipt_kind, receipt_attempt_id, content_hash, acknowledged_at, semantic_history_hash | semantic_history_json | none |

Task states remain `ready/paused/blocked/cancelled/waiting_review`. Unique keys bind operation, batch run, command, invocation, `(task,chapter,kind,slot)` and `(receipt_kind,receipt_attempt_id)`. A single attempt may legitimately carry model/composition/domain effects of different kinds. Same chapter/role uses exactly one run. Recipe is the closed object `{schemaVersion:2,writingLanguage,uiLocale,intent:{mode:'draft_review',range:{startChapter,endChapter},targetUnits},authorInputs}`; step inputs are closed model, compose, draft-commit or review-commit projections. H hashes cover only their allowed canonical projection, never X or its digest.

Export rewrites operation keys to historical labels and clears request/model hashes, model IDs and invocation nonces. Every copied task, step, effect and associated generation record is frozen. New copies cannot resume, adopt, approve or reconstruct old capabilities. Existing schema13/live proof validation stays strict.

## Current-Only Semantic History

The old portable review-proof branch retains machine fingerprint hashes, including a model digest. V2 reviews must not enter that branch. First export strictly proves live original receipts, then materializes a closed semantic history in the isolated copy and self-validates it. The nullable `semantic_history_json/hash` pair is NULL in live effects and is populated only by the export projector; both are present or both absent.

Draft history contains `{version:1,kind:'draft-commit-history',draft:{id,chapterNumber,version,status,contentHash}}`. Ordinary review history contains `{version:1,kind:'ordinary-review-history',cycleId,reviewId,reviewIndex,reportVersion,draftCommitStepId,artifact:{artifactId,revision,textHash},source:{id,chapterNumber,version,status,content},normalization:{writingLanguage,uiLocale,frozenGoals,preflightFindings},finishReason:'stop'}`. All nesting is closed. Task, chapter, role, run, root, attempt, artifact and actual draft/review/cycle links are independently cross-checked. The original raw artifact and source reconstruct the saved report with the existing report builder; findings and hashes retain the existing pure rules.

Draft history proves the original composition and authoritative save, not that the author has left the current draft unchanged. The original saved snapshot has status `draft`; its content hash is derived from the real composition/usage receipt. A later edited or soft-deleted `drafts_all` row must retain the same draft ID, chapter and version, but its current body/status need not equal that original snapshot. Ordinary-review history binds the original saved source by those same receipts. This follows the existing draft-recovery and saved-review-source contracts; it does not make a changed draft current again or grant old execution authority.

Untouched ordinary machine histories retain their closed version-1 reader. Version-2 ordinary history adds an exact four-slot followup proof: confirmation or null; revision or null with its actual revision/index/run/attempt and visible-append composition; merge or null with the committed merge snapshot hash; recheck or null with actual run/attempt/review/index/artifact, report version, UI locale, effective saved policy version and artifact-projection discriminator. Confirmation can stand alone. Revision requires confirmation, merge requires the actual generated-and-merged revision, and recheck requires that merge and its real saved receipt. Composition preserves its ordered 1..32 same-run sources, exact hashes and final stop. Current edited/deleted draft content does not replace an original merge snapshot.

Two additional closed lists preserve history no longer referenced by the current cycle pointers: `confirmationHistory` lists the other actual human snapshots by review ID, and `discardedRevisions` lists exact discarded-revision proofs with their confirmation IDs. Lists are unique and stably ordered by actual record ID, with no invented small history limit. Source review, complete source snapshot, actual root and original strict receipt/composition prove membership; a shared draft alone does not. Historical schema-1 snapshots retain their original lack of cycle/finding IDs and waiver support. Schema-2 snapshots must bind the exact cycle. A historical confirmation is not reapplied as the current waiver. Domain-record enumeration, write guards and the independent sidecar coverage check include these historical reviews, revisions, contents and generation graph as well as the four current slots.

For these new v2 histories only, finding sources use the stable historical label `portable-history:<cycleId>` instead of the original execution epoch. The existing pure finding rules rebuild finding IDs and the finding-set hash before freeze capture. In the isolated copy, exact structured finding references in confirmation snapshots, recheck model artifacts, reports and evidence are mapped consistently, with their final content/evidence hashes rebuilt. Author summary, guidance, decisions, source and revision prose remain intact. This is not free-text search/replace, retention of original JSON framing, or retention of the original mixed raw artifact/hash.

Recheck projection is explicitly `mapped-recheck` or `invalid-output`. A parse-null model output uses an unmistakably invalid historical marker and must rebuild the same unknown report with the existing builder. Parseable output preserves duplicate counts, missing references, validModelOutput and actual per-finding outcomes. Unknown finding/target IDs receive deterministic noncolliding unmatched labels; proven domain targets remain unchanged even when incorrect for that finding. Incorrect references are never repaired into valid ones. The effective policy comes from the actual saved receipt, including legal context-v1/receipt-v2 combinations. Mapping tables remain in memory only. Original finding IDs and excluded epoch/context/finding-set/evidence digests must not remain in structured machine references, proof fields, mixed receipts or their derived hashes; non-secret literal quotations in preserved author/business prose remain unchanged and confer no authority. Machine fields cannot be moved into prose to evade projection, and secret exclusion still applies. Old13 and other review histories are unchanged. No fingerprint, full safe model hash, epoch, artifactIdentity, old context hash or digest of excluded data is retained as machine proof or authority.

The closed recheck `findingIds` list preserves the real strictly proved context order after ID mapping; new hash sorting must not reorder an already saved report. The reader independently rebuilds all eligible and mustShow findings with the existing rules, checks unique exact set coverage, then replays in that explicit order. This list does not decide eligibility, targets, mustShow or policy. Report ordering, decision indices and evidence must remain stable across two archive generations even when old/new ID sort order differs.

A leaf validator constructs a fresh DB-bound exact-cycle proof context. Only the new current verifier and current review-repository full-DB checks explicitly pass it into M03. Default M03 and old13 registry calls remain strict; absence of a fingerprint, a boolean or a version number never selects fallback. Unknown, extra, stale or cross-DB proofs fail. A second independent gate checks that the complete historical task graph is covered by the actual portable freeze sidecar at native open, restore and reexport. DB proof cannot authorize execution; missing or incomplete sidecars are refused.

This is semantic conservation/readability, not signed provenance or restored original authority. A fully and consistently rewritten unsigned archive cannot be authenticated by unkeyed hashes. New tasks in restored projects remain possible while old histories stay immutable. Before a new revision atomically replaces current pending candidates, the original writer strictly verifies this historical graph and excludes its exact revision IDs from the replacement set. Frozen pending candidates keep their original status, contents and cycle references; ordinary current candidates are still replaced in the same transaction. This is not a caller-selected bypass, authorization to merge old history, or inferred authority from empty execution fields. A fresh review, human confirmation, generated revision, manual merge and recheck use a new lineage and must remain usable alongside the old readable history. Pre-v2 domain excludes only the new three tables; the asset-migration domain retains them to detect injected target history.

## Verification And Rollback

Required execution covers limits/closed payloads, real draft and review writers, every COMMIT-to-ACK gap, prefix recovery, source/model/Skill/KB changes, A/B view detach, duplicate resume, pause/cancel/close with ignored abort, unknown zero resend, explicit original-project reauthorization, and malformed/cross-run receipts. Two actual archive/restore/rearchive/restore generations cover complete/partial/unknown histories, X values and recursive digests, source-byte conservation and zero old execution. Author-history cases include confirmation alone, generated/unmerged revision, merge, completed recheck, invalid/duplicate/mismatched recheck output, and a discarded revision followed by a new revision. Clearing a cycle's current revision pointer does not erase the old revision or its necessary readable history. A restored pending-history case must also complete a fresh confirmed revision, merge and recheck, then preserve both lineages through rearchive/restore while refusing old mutations. Immutable old13 normal/donor conservation must run under the new current verifier. Isolated fake-provider Electron scenes exercise the registered production IPC after detach and receipt resubscription, including an actual owned process crash/restart with zero unknown resend.

No real-model literary-quality, visible author workflow, process restart, installer, headless or platform qualification follows from unit tests/source build. Rollback stops new v2 admission, pauses/drains existing work and preserves all domain/step/history facts. It does not delete data, downgrade schema, resend unknown work or undo an authoritative commit.

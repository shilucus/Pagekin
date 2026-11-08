# Reference Import Grant And Portable History Foundation

Date: 2026-11-08. Status: proposed for Stage 6D. Parent: `ee03e77cfa4072c08144e16d777b817b6e87b734`.

Sources: [F2 sections 4.3-4.5 and 7.8](../plans/2026-11-07-creation-runtime-modernization/README.md), IMPORT-001/002, [ADR-0030](0030-runtime-feedback-grants.md), [ADR-0033](0033-persistent-planned-batch-review-driver.md) and [ADR-0038](0038-reference-import-stage-materials.md).

## Scope And Authority

Add an independent reference-import grant record and its current/historical readers, native migration and portable classification. Reuse the existing import run, frozen manifest, stage/checkpoint/effect receipts and generation ledger as their authoritative facts. A grant row or public reference is not a capability, sender identity, execution lease or source proof. This package issues no execution capability and connects no runner, owner mode, public IPC or UI. Full IMPORT-001/002 remains incomplete.

The fixed action is `reference-import-v1`, scoped to the captured project, one `reference` import run and that run's persisted immutable manifest fingerprint. A narrow captured repository getter reads that existing writer-owned scope; it does not introduce a second manifest algorithm or replace generation/source verification. Author-manuscript, parsing/unprepared runs, portable frozen runs and altered manifest scope are refused for execution authorization. Captured native resource checks remain synchronous at the repository boundary.

The new table is `reference_import_grants`. Fields are `grant_id`, `operation_key`, `project_id`, `import_run_id`, `revision`, `action`, `manifest_fingerprint`, `request_hash`, `state`, `decision_source`, `created_at`, `completed_at` and `revoked_at`. IDs and closed references use existing repository conventions. `revision` is independent of runtime and import execution epochs. The action and author decision source are closed literals; timestamps are explicit nonnegative integer milliseconds. The migration lane and current schema number remain solely owned by the desktop registry.

States are `active`, `completed` and `revoked`. At most one active grant binds an import run. Issue is idempotent by explicit operation key and exact request/scope; replay never reactivates a revoked or completed grant. New explicit authorization uses a new grant/key after old revocation, retaining the prior history rather than modifying its scope. No default expiry, auto-renewal, scope expansion, task-policy choice or unknown retry is added.

`assertActive` requires the same native transaction that will admit dispatch/effect and checks current resources, exact revision and bound scope. Revocation uses that transaction boundary, increments revision and does not cancel, restart, erase or mutate the import run. An already completed grant remains readable. Completion requires the actual existing import run's completed state and is not a replacement completion receipt. A future driver must separately prove its private sender issuance, current grant, model/prompt/Skill/source, execution lease and stage at dispatch and effect boundaries; restored rows cannot reconstruct these permissions.

## Portable Classification

Grant ID, project/run relation, revision, fixed action, state, author decision source and timestamps are nonreplayable readable history. `operation_key`, `manifest_fingerprint` and `request_hash` are excluded machine authority, including their original digests and digests derived from them. The portable database rewrites the old operation key using the existing collision-safe historical-key mechanism and neutralizes both hashes; nullable hashes are a storage representation of history, never an execution selector. Normal repository mutations refuse missing hashes, frozen history and mismatched project/run identity.

Register the table with field policy, explicit history keys, freeze coverage, current authority verification and old-domain exclusions. Preserve readable source/receipt/domain facts through two export/restore generations. A new copy has a new project identity; its old grant and import graph stays history-only with no automatic lease, capability, dispatch, effect or unknown resend. Missing/incomplete history sidecars must not turn neutralized grant rows into normal current authority. Unknown fields remain fail-closed. Previous readable schema lanes remain explicit after adding the new current lane; old-domain and old-archive evidence is not silently redefined.

## Validation And Rollback

Require native migration and closed payload/state tests; scope/purpose/manifest and project/database isolation; exact revision and operation idempotency; revoke/effect transaction ordering; completed-state proof; no automatic capability after original-project reopen; real fictional archive/restore/rearchive/restore with old key/hash/digest exclusion, readable facts, immutable old grants and new-authorized-lineage usability; unknown-field and missing-sidecar rejection; previous schema migration/archive compatibility and immutable prior domain conservation. Root alone runs project/native commands serially. Independent authority/lifecycle and requirements/storage reviewers inspect integrated current bytes and actual reports after repairs.

No complete driver, authoritative refresh, target style consumption, actual Electron, performance, literary quality or platform qualification is inferred. Rollback stops new grant admission and retains all grant/import/receipt histories; it does not downgrade schema, delete data, restore old authority or replay unknown work.

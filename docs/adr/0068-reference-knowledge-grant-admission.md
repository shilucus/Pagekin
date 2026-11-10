# ADR-0068: Reference Knowledge Grant Admission

Date: 2026-11-10. Status: accepted for the internal KB boundary increment only.

Sources: F2 sections 4.3-4.5/7.5, ADR-0036/0037/0039 and the actual reference import KB/receipt code. This does not qualify the full driver described in ADR-0040.

## Scope

Add a main-process-only admission captured from a registered ProjectRuntime and an existing ReferenceImportGrantRef plus expected requestHash. It does not issue grants, capture workflow inputs, select current configuration, launch work or reconstruct a persisted capability. Ordinary renderer IPC cannot supply this object. Existing legacy/captured calls without this admission retain their current contracts and switching interlocks.

## Contract

- The admission freezes its grant/ref/request binding and actual runtime/database/root/native identity/epoch. Every check validates current resources, portable grant freeze, exact project/run/revision, active grant and stored requestHash; caller-asserted equality is not a substitute for reading the grant repository.
- SQLite reference-document preparation/updates and idempotent committed replay use a synchronous native transaction containing the grant and existing import-execution/source checks. Effect-bearing admission calls establish their own transaction or nested savepoint, so a rejected callback cannot leave effects for an outer caller to catch and commit. Pure checks may reuse the caller's transaction. No SQLite transaction spans an await. The guard cannot accept a Promise as a successful authorization or transaction result.
- Every existing asynchronous boundary in importReferenceText retains resource/source/execution checks and additionally checks the captured grant. Revoke during embedding/integrity/vector work cannot turn into a successful KB receipt. After a vector write loses authority, cleanup uses only the admitted captured resources, without inventing fresh grant authority.
- Physical single-flight identity remains project/document/native epoch. Grant/ref/request identity participates in the binding, so different authorizations wait for the previous physical flight instead of running concurrent writes or rescuing its revoked admission. Same-binding participants may share work; old legacy/captured sharing remains unchanged when neither uses the new admission.
- Complete document integrity can support the existing idempotent document receipt, but only after current grant/source checks; a revoked grant cannot obtain successful replay. Existing FTS fallback and invalid-vector rejection are not weakened or redefined.

## Limits

No new persistent fields, migration or portable policy are added. Existing grant portable projections remain authoritative and cannot become admission in a new copy. This phase does not supply a durable input capsule, frozen embedding credential/configuration proof, persistent embedding dispatch/unknown ledger, a whole-stage owner/controller, or production background qualification. requestHash comparison alone is not a new input capsule or model-source proof. Existing embedding prepared state cannot prove that a request was never sent, and this admission must not be used to claim unknown-no-resend recovery.

Full reference-import composition remains unfinished, as do the distinction between deconstruction analysis facts and imitation target-author facts, later global/style/blueprint/refresh stages and separate full migration acceptance. No real data/configuration/model, author-manuscript write, new public API or trusted human approval is authorized by this object.

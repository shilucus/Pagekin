# ADR-0069: Reference Embedding Dispatch Barrier

Date: 2026-11-11. Status: accepted for this internal safety increment only.

Sources: F2 sections 4.3-4.5, 5.2-5.3 and 7.8; ADR-0037/0039/0068; actual embedding request boundaries, reference document receipts and current schema/portable contracts. This does not resolve the ADR-0040 analysis/adoption destination gap.

## Scope And Authority

Record physical reference-document embedding requests before dispatch, and deny unsafe document reentry after interrupted work. Only a genuine existing main admission can start newly instrumented requests. The actual KB entry participates; unmigrated production callers are not activated as background tasks. No request capsule, configuration/model/credential reconstruction, retry policy, new grant, author fact adoption, UI or full IMPORT qualification is supplied.

## Persistent Facts

M16 adds reference_embedding_dispatches through the central desktop migration lane; it does not alter previous migrations or invent records for old prepared documents. Each row contains exactly dispatch_id, import_run_id, document_id, batch_ordinal, input_count, state, http_status, marked_at and settled_at. The stable ID is reference-embedding:<documentId>:<batchOrdinal>; document/ordinal is unique, and run/document refer to their existing rows. Ordinals are zero-based, counts are positive integers, timestamps are nonnegative local wall-clock milliseconds. No input text, prompt, endpoint, model/configuration, credential, request hash, grant capability or executable nonce is stored or hashed into this table.

States are dispatch_marked, response_received, http_failed, response_invalid and transport_unknown. A mark has no settlement/status. Exactly one settlement may converge that same row: received/invalid require an actual successful HTTP status; http_failed requires actual non-success HTTP status; transport_unknown has no status. response_received means the full batch response was parsed and passed existing local vector validation, not merely that headers arrived. Cross-batch validation can still fail the document without rewriting truthful batch facts. No state or error message proves remote cancellation.

## Dispatch And Reentry

- Mark immediately before each actual protocol fetch, synchronously rechecking captured native resources, current grant and original source/execution in the same transaction. No transaction crosses an await. Smoke/no-fetch paths create no dispatched record.
- Only the actual new prepared-receipt insertion may issue a private in-memory flight token, within that admission transaction. It is bound to the captured native/epoch/run/document and permits this invocation's ordered batch marks; it cannot be reconstructed from persisted rows, caller booleans or a new grant. Existing prepared/no-ledger is unproven for admitted work, not known-unsent. Close the token when its physical work finishes.
- Settlement has only the issued mark token's exact row authority. It can record the physical outcome after grant revoke while the captured work lease remains live; it cannot add a mark, replace a terminal state, authorize KB writes or dispatch again. Failure leaves the existing mark and returns a hard barrier error. All in-flight requests and settlement drain before release.
- Reentry first checks actual complete document integrity and current source/grant authority. The existing verified document can support idempotent replay without another request, while any remote-unknown record remains history. With no complete document, any prior dispatch for that document, across all runs/grants and including settled responses without saved vectors, blocks every later entrant, including legacy callers. No replacement batch ID/nonce or automatic FTS repair is invented.
- Legacy documents without a ledger retain their existing unmigrated path; their missing records never establish universal unsent proof. Instrumented work cannot be rescued by legacy/new-grant admission. The original physical single-flight lock and captured cleanup remain.

## Failure Semantics

Ordinary network/HTTP failure still permits the existing whole-document FTS-only outcome in the same invocation; invalid response remains a hard document failure. Original batch ordinal still adjudicates ordinary versus validation errors. Mark/settlement persistence failure is a separate hard fence: after all physical siblings drain, any such failure forbids fallback or commit regardless of a lower-ordinal ordinary error. Callback authority/persistence errors are never inferred from message strings or accepted as asynchronous guards. No partial vector projection is added.

## Migration And Portable Contract

All nine fields are classified H, non-executable history. There are no stored machine-authority values or digests to transfer. Preserve dispatch/unknown facts, do not rebuild or discard them. A new portable copy gets a new project identity; each old ledger row is covered by the existing nonReplayable history/freeze mechanism, and cannot issue new work or mutate old settlement. Missing coverage and unknown columns/tables fail closed. Preserve schema-16 standard/donor readability and domain conservation, upgrade backup/rollback and canonical reopen, and two actual export/restore generations using fictional projects. Same-project crash recovery and new-copy history are distinct evidence.

## Limits

This barrier intentionally does not reconstruct successful unsaved vectors, resume an unproven prepared document, retry known failures, freeze a currently selected embedding profile, or prove old uninstrumented requests were unsent. Those require their own durable inputs and explicit attempt policy. It does not complete IMPORT-001/002, multi-book scheduling, literary quality, Electron interaction or platform qualification.

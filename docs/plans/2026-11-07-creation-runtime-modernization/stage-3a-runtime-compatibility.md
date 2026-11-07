# Stage 3A Runtime Compatibility Freeze

Parent: `34b13c33efe8f5bc83b080be068e69d4d2f44b18`. This is the accepted RUNTIME-001 entry classification. [ADR-0029](../../adr/0029-project-runtime-resource-routing.md) defines resource/view identity; [Stage 3A evidence](stage-3a-evidence.md) records the actual tests and registered-IPC Electron scenario. It does not qualify background grants or complete migrated workflows.

| Entry family | Stage 3A treatment | Required boundary |
| --- | --- | --- |
| Project create / failed-open rollback | Migrate actual controller to prepare/commit/abort | Abort B only before COMMIT; preserve A if no newer view committed, otherwise leave winner C's runtime/lease unchanged; never restore A's obsolete lease |
| Existing `project:open` / ordinary UI switch | Single-book compatibility ticket captures only an idle, non-retained current A | Reject busy, multi-runtime, pending, closing, explicit retained and legacy/restore conflicts before target effects; B COMMIT failure leaves A unchanged; successful B publication releases only captured A in the same synchronous barrier |
| Explicit `project-runtime:v1:open-view` | Grant/recent-reference admission to retained view; shared serialized latest-winner handler | Exact preload literal; process-local retained policy is not a background grant; old UI lease is invalid after viewing B |
| View activation / same-book viewing | Reuse registered runtime, issue fresh UI lease | Same canonical alias does not release/refence its runtime; no old renderer authorization or automatic execution grant |
| Compatibility previous-close failure | Preserve B COMMIT and fresh session, quarantine actual failed A release | Return partial failure with actual B path/DB readiness and no restored claim; renderer detaches obsolete binding without dropping author buffers; consumed B ticket is never aborted |
| Project close / db:close | Explicit idle target release | Reject busy before close; failed release quarantines target; never close the newly active other book |
| Project core initialization/configuration and classified basic editing | Explicit captured DB adapter; ordinary single-book UI preserves existing legacy editing | Read/write one captured runtime; no later global DB lookup; actual store-to-registered-handler A-to-B loading/saving is separate from retained IPC-only evidence |
| Generation owner / source read / provider settlement / draft effect | Capture runtime DB/root; retain current-view authorization | Late result cannot borrow B; unknown not resent; physical work keeps resources busy until settlement |
| Other direct db:* handlers | Default legacy interlock unless individually adapted | Multiple live runtimes reject before effects; while one legacy call awaits, reject open/view/close changes |
| Finalization and chapter lifecycle, cleanup, outbox retry | Legacy interlock, not background qualification | Transaction/outbox authority unchanged; no rollback of committed truth on publication failure |
| KB controller reads/writes/rebuild and import inspection | Legacy interlock until complete adapters exist | Gate before path, model, DB, file or vector effects; no switch during a legacy await |
| Portable export / cloud backup of an open project | Legacy maintenance rejection/interlock | No live multi-runtime snapshot; no grant consumption or staging/network side effect before rejection |
| Restore into a new copy | Preserve explicit external-target grant contract; reject unsafe overlap | Never touch an admitted runtime's root; no restored execution authority |
| Delete / migration / generated-data clear | Reject incompatible retained runtimes, preserve old maintenance protection | No close/move/delete before admission; failure cannot reopen or fence another book |
| Project file operations / character assets | Existing frozen lease/root with reviewed runtime admission or legacy interlock | No active-view change during unadapted async effects; real path and capability protections remain |
| Old renderer workflows / application exit | Existing cancellation/wait/buffer/close protection retained | No new visible background promise or post-exit execution claim; explicit failed-delete handoff preserves ordinary dirty buffers, not historical execution authority |
| New execution grants / resource maintenance / durable driver | Not implemented by this package | RUNTIME-002/003 and DRIVER-001 retain their dependency and acceptance gates |

The coordinator and independent reviewers reconciled these families with their affected production registrations before acceptance. A source-level default denial is not itself end-to-end evidence; registered-handler tests and Electron evidence remain distinct. This list does not automatically authorize future registrations.

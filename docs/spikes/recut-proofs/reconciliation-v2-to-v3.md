# Reconciliation: v2 findings → v3 dispositions

| Source | Finding | Disposition in v3 |
|---|---|---|
| Fable F1 (P1), Codex 2 (P1) | The cut dropped the browser's search; R1 unmet | **Accepted.** `ub open` answers `/api/search` from the store's FTS5 after a settle; the web client gains a search surface (phase 1). No hub search. |
| Fable F2 (P2), Codex 3 (P1) | Only the awaited pre-apply hook gates; the listener option is falsified (ack sent, refused text broadcast, document goes silent); `beforeSync` is the decoded seam; raw-append can poison replay | **Accepted.** Gate = `beforeSync` only, decoding opcodes, ignoring step-1/awareness/read-only frames, validating against a scratch Y.Doc before append. Its contract and the `onUpgrade` idiom go into the seams test. |
| Fable F3 (P2), Codex over-engineering | Lease fencing, wedged rule, holder-only compaction protect nothing the store does not; an idle MCP holder bounces the lease | **Accepted, further.** v3 has no lease, holder or follower in phase 1: every process is a full replica as today. Lazy attachment plus an advisory lease is phase 1b, on the scale probe's evidence. |
| Fable F4 (P2), Codex 6 (P2) | No awareness-only provider mode exists; two serving processes split offline presence | **Accepted.** No local presence channel in phase 1 (hub-relayed only; offline no cursors); one serving process per store, a second `ub open` is refused. |
| Fable F5 (P2), Codex 5 (P1) | The IndexedDB loss window is a session while the editor stays editable through a refusal or a disconnect | **Accepted.** Editor read-only whenever the room has no live, unrefused localhost connection; named refusal close reason stops the redial; window declared as one in-flight update. |
| Fable F6 (P2) | Proof 1b omits the observed loss (upstream outage while typing); Proof 0 discards the log; `repairDuplicateBlocks` is the suspect | **Accepted.** Proof 0 retains the daemon database, replays the log per update and tests the duplicate-block hypothesis; Proof 1b adds the outage-while-typing case. |
| Fable F7 (P2) | `ub open` needs a background settle loop and a two-document bridge | **Accepted.** §5.3 and §7 specify both. |
| Fable F8 (P3), Codex 1 (P1) | `ub remote join` verification budget bounds R2; join moves no archived bodies at all | **Accepted.** R2 is not met today; phase 1 fixes join to attach, upload and verify archived rooms and drops the budget bound. |
| Fable F9 (P3) | Origin refusal idiom; configuration document second endpoint; refusal close reason; network-FS detection | **Accepted.** Idiom into the seams test; second field is a named contract change; close reason specified; network filesystems are a documented boundary. |
| Fable F10 (P3), Codex 9 (P3) | Stale §12 (#704 closed, #719 merged); `origin` is not a session | **Accepted.** §1 and §8 corrected. |
| Codex 4 (P1) | Concurrent indexers can overwrite newer rows with older state; no index sequence | **Accepted.** `indexed_through_seq` per document; conditional commit; search settles before answering. A correctness fix in today's code, not a fail-safe. |
| Codex 7 (P2) | Follower content providers are redundant; make the holder the only publisher; delete Proof 2 | **Moot in v3, Proof 2 folded.** There are no followers; every process syncs as today. The two-process outage case runs once inside Proof 1. |
| Codex 8 (P2) | An open-time schema-version check is unenforceable | **Accepted by deletion.** No versioning machinery pre-launch; stores are disposable under the hard cut. |
| Fable claim 7, Codex claim 7 | Unchanged hub for 50–100 full replicas unproven | **Unchanged.** The scale probe informs; phase 1b and phase 2 exist only on its numbers. |

**Owner decisions applied without change:** IndexedDB removed; scale probe informs rather than gates; no daemon; history and dashboard in their own records; proofs run locally without tickets; hard cut with no migration.

**Not taken:** Codex's "make the holder the only upstream publisher" — v3 removes the holder concept from phase 1 instead, which removes the same redundancy with less machinery. Codex's "enforceable live-process schema barrier" — deleted rather than built, per the hard cut.

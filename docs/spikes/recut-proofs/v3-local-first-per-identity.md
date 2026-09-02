# Local-first per identity — architecture re-cut plan, version 3 (minimal cut)

**Status:** draft v3, 2026-09-02, reconciling both reviews of v2 (`adversary-fable-v2.md`, `adversary-codex-v2.md`; dispositions in `reconciliation-v2-to-v3.md`). Supersedes v2. Adopted provisionally by the author under the owner's delegation of 2026-09-02; the proofs in §9 decide whether it stands. Nothing is built.
**Owner:** Ben. **Drafted by:** Claude (Fable 5.1). Grounded in `origin/main` at `7e6be05` (PR #719 merged as `8ab4693`; #704 closed), the live corpus, the v1 verdicts, the v2 Fable verdict and its loopback gate probe.

---

## 0. What changed from v2

v2 was reviewed and survives only as a provisional basis. Its gate was buildable through one hook, not two; its lease fencing, wedged-holder rule and holder-only compaction were fail-safes for hazards the store already handles; its "awareness-only" local provider does not exist; it had dropped the browser's search, which R1 requires; and its IndexedDB loss window was a session, not an edit, because the web client keeps redialling into a refusal.

v3 applies the owner's principle P5 to those findings and ends up smaller than v2:

- **No holder, no follower, no lease in phase 1.** Every process attaches every room, as today. Lazy attachment and an advisory lease are phase 1b, scheduled only if the scale probe shows process-count fan-in is a limit.
- **The gate is `beforeSync`**, the pinned server's decoded pre-apply hook, and nothing else.
- **`ub open` is the MCP server's replica engine plus a localhost sync server for the browser**, bridged through the store. It answers search for the browser from the store's index.
- **Presence goes through the hub only** in phase 1. Offline, the browser shows no agent cursors; content still flows.
- **IndexedDB is removed** (owner decision). The editor is read-only whenever its room has no live localhost connection or was refused, so the loss window is one in-flight update, never a disconnected session.
- **`ub remote join` must move archived documents too.** Today it moves only live rooms, so "R2 is met today" was false for archived content; a CLI fix in phase 1.
- **Index writes carry a sequence** so a slow indexer can never overwrite newer rows with older state.
- **No schema-version machinery.** Pre-launch stores are disposable under the hard cut; a schema change means wipe and re-import, never a migration or a version gate.

## 1. Context

Unchanged from v2 §1, with one update: PR #719 is merged and #704 is closed; the corpus already records that the spike did not isolate its hard stops from the harness (Topology decision parameters, post-merge note).

## 2. Required and preferred product properties (owner, 2026-09-02)

Unchanged from v2 §2 (R1–R5, P1–P6). The corpus now carries them for a general audience in *Product requirements* (`0950afda-0496-4e69-be4d-f5579dc7a44e`); this plan cites, not restates.

## 3. What stays

Everything in v2 §3, plus: **eager attachment of every room in every process** (today's behaviour), **every process compacts** (safe by `readSince`'s transactional read of snapshot plus tail), and the store's existing `clearPending` rule, which the v2 review showed keeps the pending set honest under any number of upstream paths by construction.

## 4. Options weighed

As v2 §4, with D2 replaced by **D3 (minimal)**: no election, no laziness, `ub open` as a gated localhost ingress over the existing replica engine, hub unchanged. Lazy attachment (the former "follower") is deferred to evidence.

## 5. Target shape (D3)

**Vocabulary.** *Identity*: the user a process runs as. *Store*: the SQLite file for one identity and workspace, holding the append-only update log and the derived index; the machine's bus. *Replica engine*: the MCP server's `Replicas` + `HubSync`, which hydrates every room from the log, logs every update synchronously, syncs with the hub and compacts. *Serving process*: what `ub open` runs. *Served room*: a room the browser has open through `ub open`. *Gate*: a browser update is appended to the store before the local server applies, acknowledges or broadcasts it.

### 5.1 One store per identity

Unchanged from v2 §5.1: the store is the bus; every process appends and replays the tail before answering; one store per identity and workspace; two identities on one machine mean two stores. A network filesystem is a documented boundary, not a detection.

### 5.2 Every process is a full replica, as today

Each MCP process and `ub open` run the replica engine unchanged: all rooms attached, pending rooms pushed at boot and settle, every writer indexing what it changes, every process compacting. One correctness fix the reviews found in today's code comes with the cut: index rows are a wholesale replace with no sequence, so a slow indexer can commit an older derivation over a newer one; every index write records the room-log sequence it derived from (`indexed_through_seq`) and commits only if no newer cut is stored; the recorded cut is a contiguous log prefix the deriving document has applied, so after a local append returns S the process replays the room through S before deriving at S (the final Codex review showed that `max(lastSeq, lastAppendedSeq)` is not such a cut: an append made before a neighbour's newer row was replayed would certify an incomplete derivation). Nothing else is coordinated between processes; the store already serializes what must be serialized. Memory per process is the corpus size, accepted on developer machines (P2) until the scale probe says otherwise.

### 5.3 `ub open`, the serving process

Foreground, started when a person sits down. It is one process with two halves joined by the store:

- **The replica half** is the MCP server's engine. Because `ub open` has no tool calls, it runs `settle()` on a timer driven by `PRAGMA data_version` (a change means another process committed): replay each room's tail, adopt new rooms, compact, push pending.
- **The serving half** is an in-process Hocuspocus 4.6.0 server (the pinned hub code) bound to `127.0.0.1`, serving the web bundle and one room per open document. A served room is **two Yjs documents in `ub open`**: the replica's, and the server's own `Document`, which Hocuspocus constructs and hydrates by copying state and cannot adopt. They meet only through the store:
  - **Browser → store → everyone.** `beforeSync` runs awaited before the server applies a sync message; it decodes the outer and inner sync opcodes, ignores step-1, awareness and read-only frames, takes the update bytes (for `messageYjsUpdate` and for the reconnect diff `messageYjsSyncStep2`), **validates them by applying to a scratch Y.Doc**, and only then appends them to the store as a local-origin update with the pending mark. A payload the scratch document rejects is refused before anything is stored, so a malformed frame can never poison replay. Only after the append does the server apply, acknowledge and broadcast to other tabs. The replica half picks the same update up from the tail in its next settle, applies it with the log origin (no second log row), and the upstream provider forwards it to the hub. A throwing `beforeSync` closes the browser's connection before anything is applied (measured in the v2 review's probe: sender unacknowledged, server and peer unchanged, later writes unaffected).
  - **Everyone → store → browser.** The same settle reads each served room's tail through `readSince` plus the snapshot table and applies it to the server `Document` with a marker origin; the server broadcasts to every browser connection. An update the browser itself sent comes back through this path as a no-op.
  - **Awareness** is bridged both ways between the server `Document`'s awareness and the replica's, so browsers see what the hub relays and the hub sees the browser. Clock rules in y-protocols stop echoes after one hop; the bridge filters by origin.
- **Refusal is sticky and visible.** A refused append closes the room with a named close reason; the web client recognises it, stops redialling that room, sets the editor read-only, and shows "not saved". `ub open`'s own replica quarantines exactly as an MCP process does today.
- **Search and status over localhost HTTP**, token-gated, no CORS: `/api/search` settles first (replay the tail, index what changed), exactly as the MCP `search` tool does, then answers from the store's FTS5; `/api/status` reports per room `{applied, hubAcked}` from the pending table and the upstream provider's acknowledgement state; listing needs no endpoint, since `_directory` is a served room.
- **One serving process per store.** A second `ub open` on the same store is refused (a lock in the store), because presence and status would otherwise split across two servers that cannot see each other offline.
- **Localhost auth**: the browser's token comes from the served configuration document as today; the websocket upgrade checks the one expected Origin with the destroy-then-reject idiom (a throwing `onUpgrade` crashes the process); the configuration document gains a second field naming the remote hub, so the status line can say which hub "synced" refers to.

### 5.4 The browser is thin

Talks only to localhost when working locally; y-indexeddb is removed (owner decision, P5). The editor is editable only while its room has a live, unrefused localhost connection; the moment that connection is gone or refused the editor is read-only and the status reads "not saved". Declared loss window: the one update in flight when `ub open` dies (up to a busy-timeout stall wide), never a disconnected session. A browser opened directly against the remote hub works while connected and has no offline reload. Search in the browser calls `ub open`'s endpoint; against the remote hub there is no search until a hub-side one exists, which is a later decision.

### 5.5 The hub is unchanged

As v2 §5.5, with two corrections from the v2 reviews. First, `ub remote join` today moves only live rooms: an archived document's body stays on the old machine and a later restore on the new hub yields an empty tombstone, so the join must attach, upload and verify archived rooms as well before R2 is met; a CLI fix in phase 1. Second, the join verifies a fresh client against every document under a fixed budget in waves of 32, which refuses to persist past a few thousand documents; a CLI budget, fixed in the same issue, not a hub question.

### 5.6 Workspace-level documents

`_directory` and `_sidebar` stay; `_feedback` is cut (#725).

### 5.7 Presence

Agents publish awareness to the hub as today; `ub open` relays hub awareness into served rooms. Offline there are no agent cursors and the connections count reads zero agents; content still flows through the store. CLAUDE.md's "attributed to a visible agent cursor" acceptance criterion is read as an online criterion. A local presence channel is added only if someone misses it (P5).

## 6. What falls away (from today)

IndexedDB in the browser. The daemon-as-proxy cut. v1's hub application server, hub log, catch-up, bulk endpoints, hub search and directory retirement. v2's lease, fencing, holder election, lazy attachment, wedged-holder rule, holder-only compaction and local presence provider.

## 7. What must be designed, not patched

- `beforeSync`'s contract (awaited before apply; throw closes the connection; y-protocols swallows observer throws, so the listener route is never used) and the `onUpgrade` refusal idiom, both added to Obligation 2's seams test, because the gate and the Origin check rest on pinned-library behaviour.
- The two-document rule for served rooms, the marker origin, and the awareness bridge with echo suppression.
- `ub open`'s settle loop cadence and its interaction with the replica's own settle (one loop, not two).
- The named refusal close reason and the web client's read-only reaction.
- The configuration document's second endpoint field (a contract change).
- No store schema versioning: pre-launch stores are disposable; a schema change is a wipe and a markdown re-import (owner, 2026-09-02). Written down so nobody builds a gate that a long-lived process could not honour anyway.

## 8. Doors kept open, decided elsewhere

Unchanged from v2 §8, with one correction: the store's `origin` column is `local | remote` and identifies no session, so session-level authorship needs a column or a Yjs-client-id registration when the history record is written; nothing in D3 closes that door.

## 9. Evidence and proofs (run locally, no tickets)

- **Proof 0 — diagnose the spike's content loss.** Re-run the #704 harness at `9451ad4` with the driver reading the full block list and the whole editor, **retaining the daemon's database** and replaying the room's update log per update to name the update that removed the block, and testing the hypothesis that `repairDuplicateBlocks` (schema `blocks.ts:438-448`, run on every observed update) deleted the original block after the browser's editor produced a second element with the same id on reconnect. Add a same-run direct-path control. Outcome: the mechanism, and whether D3 keeps any ingredient of it.
- **Proof 1 — the shared store under load.** Four processes mostly reading, one writing, plus one `ub open`-shaped settle loop, on one WAL store: visibility bound for every committed write; `edit_block`/`get_doc` p50/p95 against a single-process baseline; the longest lock hold and the relay's worst stall; no `SQLITE_BUSY` escaping as a failure; concurrent compaction by every process leaves no gap under `readSince`; offline create → restart → push holds.
- **Proof 1b — the gate and the bridge.** On the pinned server, reusing the v2 review's probe: a refused append is never acknowledged, broadcast or forwarded, on the update path and on the reconnect-diff path; a malformed frame is refused before anything is stored; read-only and awareness frames pass the hook untouched; the two-document bridge through the store delivers an MCP write to a browser connection and a browser write to the replica exactly once, with no second log row; the awareness bridge does not echo; **upstream hub stopped, browser types, hub restarted** converges without loss; and typing after the localhost connection is gone is impossible rather than lost.
- **Proof 2 is folded into Proof 1.** Two processes sharing a store, each with its own hub provider, on one room through outage, crash and restart: the pending set clears only through acknowledged sequences. Both v2 reviews agree this holds by construction of `clearPending`; Proof 1 runs the case once rather than as a proof of its own.
- **Scale probe — informs, does not gate.** One hub (in-process or the owner's local Docker), ~100 simulated identities × 3 processes over a corpus of a few thousand documents, today's protocol with eager attachment: hub CPU and memory, room subscriptions, the restart handshake storm, hydration time for a fresh machine. Its numbers decide phase 1b (lazy attachment plus an advisory lease) and phase 2 (any hub-side work).

A failed proof reopens the record.

## 10. Sequencing

- **Phase 0 — prove.** Proofs 0, 1, 1b, 2 and the scale probe, locally, as throwaway code; the corpus record updated to D3; Topology decision parameters and Deferred designs §2 revised; CLAUDE.md's decided-architecture text changes with the first merged issue (tier 3, owner approval).
- **Phase 1 — the machine.** `ub open` re-cut: replica engine + local server, the gate with validation, the bridge, the settle loop, status and search endpoints, one serving process per store, the configuration document's second field, the Origin idiom. Web: IndexedDB removal, search box against `ub open`, read-only whenever disconnected or refused, two-fact status line. Store: `indexed_through_seq`. Hub package: seams test additions only. CLI: `ub remote join` moves archived rooms and drops the fresh-client budget bound.
- **Phase 1b — conditional on the scale probe.** Lazy attachment in MCP processes with the pending-room exemption, plus an advisory lease row electing one always-attached process, released on quarantine.
- **Phase 2 — conditional.** Hub-side work, if ever, under the safety contract v2 §10 named.
- **Phase 3 — journeys.** Offline machine (browser, two MCP processes, a local-model agent); new machine joins; start local then elevate; unattended agent on a remote machine.

Phase 1 is five to seven issues, including the `ub remote join` archived-room fix and the index sequence.

## 11. Claims I consider weakest

1. That `beforeSync` appending the raw update bytes before apply is sound for every message the hook sees (a malformed update appended then rejected by apply would poison replay).
2. That one settle loop can serve both halves of `ub open` without the two documents per room drifting or double-logging.
3. That hub-only presence is acceptable offline under R1's wording.
4. That eager attachment in every process, including `ub open`, is fine until the probe says otherwise (memory per process equals corpus size).
5. That the refusal close reason plus read-only editor really bounds the loss to one send.
6. That the awareness bridge does not echo or leak.
7. That `ub remote join`'s bound is a CLI budget and not a topology limit.
8. That D3 is now the smallest cut meeting R1–R5.
9. That validating every browser update against a scratch document inside the gate is cheap enough at typing speed (one applyUpdate per keystroke).

## 12. Records this changes

- Local-first per identity (`2542cd66-b641-4900-96b4-5c461dcdcf65`): holder/follower and the lease leave phase 1; presence is hub-only; search from `ub open`; gate named as `beforeSync`.
- Topology decision parameters, Deferred designs §2, Architecture: as v2 §12, with the sidecar/active-document designs moved to phase 1b rather than absorbed now.
- CLAUDE.md: no invariant changes; the decided-architecture text gains `ub open`'s role and the gate with the first merged issue.

## 13. Proof outcomes (2026-09-03)

All proofs in §9 ran locally overnight; reports: `scale-probe-report.md`, `proof-0-report.md`, `proof-0b-report.md`, `proof-1-report.md`, `proof-1b-report.md`; summary: `where-we-landed.md`.

- **Scale probe:** no phase 1b and no hub-side change justified at 100 identities × 3 processes × 2000 documents (hub 2.2 GB, <3% CPU, 603k subscriptions, no ceiling fired, hydration flat in fan-in). Restart storm at that size is O(D²) per socket because of Hocuspocus 4.6.0's pending-document guard; a one-line library patch is the lever.
- **Proof 0 + 0b:** the #704 content loss is a harness artifact (three clicks within 500 ms → ProseMirror triple-click → the keystroke replaces the paragraph). No editor bug. Proof 0's STOP is withdrawn; the #704 record needs correcting.
- **Proof 1:** PASS on every bar; conditional on two one-file fixes in today's code: `busy_timeout` before `journal_mode = WAL` in `MirrorStore`, and `indexed_through_seq` with a contiguous applied cut (replay through the appended sequence before deriving; the proof's `max(lastSeq, lastAppendedSeq)` was corrected by the final Codex review, `adversary-codex-final.md`).
- **Proof 1b:** PASS; the gate is `beforeSync`, unpatched. Changes folded into §5.3/§5.4: the loop is woken by own appends; `settle` is split into a hub-free refresh and a hub wait; refusal reasons `store-busy` (transient) and `store-refused` (sticky); the loss window is everything sent and not yet appended, only when the tab also dies; the append stalls the whole process; `ub open` publishes no agent presence; the gate is replay safety, not content safety.
- **Found in passing, today's code:** a write on a freshly attached room is sent before its token, bypassing the admission bound; a burst of >100 creations terminates the socket and leaves every settle waiting 3 s until restart.

- **Final Codex review (2026-09-03):** "the overall D3 topology survives"; one major hole, the index cut above, corrected in the ticket and here.

Verdict: D3 stands as the provisional decision. Next: tickets for the defects, the #704 correction, then phase 1.

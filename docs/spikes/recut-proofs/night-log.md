# Night log — proofs for "Local-first per identity" (v3), 2026-09-02/03

Owner asleep; approval: local only, the agreed proofs only, no GitHub, no tickets; corpus record may take proof outcomes.

## Scale probe — DONE, informs
- 100 identities × 3 processes × 2000 docs on loopback: hub 2.2 GB RSS, <3% CPU idle, 603k room subscriptions, no ceiling fired, fresh hydration 8.9 s (flat in fan-in), propagation ~8 ms, per-replica RSS ~400 MB at 2000 docs.
- Restart storm at that size: 101 s with a 932 ms hub event-loop stall. Cause: Hocuspocus 4.6.0 `ClientConnection.getPendingDocumentCount()` is O(rooms on the socket) per new room → O(D²) per socket. Verified in source.
- Verdict: phase 1b (lazy attach + lease) NOT justified; no hub-side change justified; the lever is a one-line counter fix in the pinned library (patch later, via a ticket — not tonight).
- Caveats: loopback only; presence at scale not measured.
- Source check: `hookPayloads[rawKey]` is deleted only on connection close (ClientConnection.ts:379) or auth failure (:555); on success it lives for the room's life, so the guard's scan grows with every attached room. Confirmed.

## Owner request (late 2026-09-02)
- When done: prepare a presentation of the findings (self-contained HTML slide deck, sent as a file + opened in the app browser), in addition to the consolidated report.

## Pending
- Proof 0 (spike diagnosis, fable agent, own worktree at 9451ad4) — running
- Proof 1 (store under load, opus agent, packages/mcp-server/spike/proof1) — running
- Proof 1b (gate + bridge, fable agent, packages/mcp-server/spike/proof1b) — running

## Proof 0 — DONE, STOP (for a reason outside the topology)
- The spike's content loss is a deterministic PRODUCTION bug in the web editor: with a multi-author block, stop the hub (real stop, not a network pause), type one character → one browser-authored valid Yjs update deletes the whole block text across all authors and inserts the typed char. 6/6 reproductions, incl. 4/4 on the production path with no daemon; IndexedDB irrelevant; concurrent agent edit not required. repairDuplicateBlocks hypothesis falsified (0/6).
- v3 does not fix it (the gate is CRDT-validity only; read-only-when-disconnected does not fire on a remote outage since the localhost link stays up) — but neither does the status quo; the bug precedes and is orthogonal to the topology.
- Consequence: phase-0 blocker = fix the web-editor wipe (ticket tomorrow, P1 data loss); v3 must say the gate guarantees replay-safety, not content preservation; the #704 hard stop must be re-attributed in the Topology record.
- Follow-up launched: Proof 0b (fable) to root-cause the y-prosemirror/rooms.ts interaction and validate a candidate fix in a throwaway worktree.

## Proof 1b — DONE, PASS (gate + bridge on the pinned server)
- All 8 cases passed first run: beforeSync gates update + reconnect-diff paths unpatched; refusal never acked/broadcast/forwarded; malformed frames refused before storage (unguarded server would ACK a malformed update!); exactly-once logging in 3 directions; awareness bridge both ways, no echo; hub outage → converge, pending cleared only after ack; SIGKILL mid-typing → live tab recovers 300/300.
- Costs: gate 0.19 ms p50 / 0.30 ms p95 per keystroke; ack 0.5 ms; a foreign 1.5 s lock freezes the whole process; a 6.5 s lock → SQLITE_BUSY → refusal after 5.25 s.
- v3 changes (report §7): loop must be woken by own appends (data_version is blind to the committing connection); split Replicas.settle() into hub-free refresh vs hub wait; two refusal reasons (store-busy transient vs store-refused sticky); loss window = everything sent-not-appended (1 at typing speed, 275/300 in a burst) and only if the tab also dies; process-wide stall; Y.decodeUpdate is enough for validation; ub open must not announce itself as an agent; "exactly once" is a bridge property (today two processes log a write twice: local + hub echo); loop cadence ~25 ms → p95 36 ms; stickiness is client policy.
- Pre-existing sync.ts defects found (tickets tomorrow): (a) a write on a freshly attached room is sent before its token, bypassing the 32-wide admission bound; (b) a burst of >100 create_docs gets the socket terminated by maxPendingDocuments and then 32 admission slots stay held so every settle() waits 3 s until restart.

## Proof 1 — DONE, PASS conditional on two one-file fixes (shared store under load)
- Six processes on one WAL store: visibility p95 28-30 ms (agent/typing), 80 ms burst vs 250 ms bar; contended read/write latency at or below the single-process baseline; longest lock hold 204 ms (bar 500); serving-loop worst stall 110 ms; zero SQLITE_BUSY during service. Compaction by three readers concurrently: zero gaps/torn/backwards reads across 335 verified reads. Hub cases (two processes one room, outage, SIGKILLed creator → fresh process pushes) all pass.
- Defect 1 (NEW, live today): MirrorStore sets journal_mode=WAL before busy_timeout, so simultaneous opens fail: 121/480 (25%) with 8 processes; swapping the two lines → 0/480. Ticket tomorrow (phase-1 issue).
- Defect 2 (confirmed Codex v2 #4): wholesale index replace leaves FTS stale under a concrete interleaving; indexed_through_seq fixes it at negative cost (p95 0.11 vs 0.17 ms); the cut must be max(lastSeq, lastAppendedSeq).
- Surprise: the writer lock is spent mostly on FTS rewrites in observing processes; the writer re-indexes its own writes twice (41,542 index writes for 20,756 appends). Phase 1b numbers: 5.4 µs/room/settle, ~30 KB heap/doc, 5.4 s boot at 3,000 docs.

## Proof 0b — DONE: the "wipe" is a TEST-HARNESS ARTIFACT, not an editor bug
- Root cause: the driver's caretToEnd() clicks the same coordinate three times <500 ms apart; ProseMirror counts clicks itself (prosemirror-view 1.42.2 index.js:3343-3351, isNear 10 px) → third click = tripleClick → selectionForTripleClick selects the whole paragraph → the keystroke replaces it → y-prosemirror syncs "delete all, insert char" faithfully. The #704 spike driver has the identical helper and cadence, so the spike's hard stop (a) is the same artifact.
- Predictions 7/7: loss with the hub UP and with a mere pause; no loss after a real hub stop when the third click is 816 ms later or absent. origin/main identical. Harness fix (keyboard End) → 5/5 clean.
- Consequence: withdraw Proof 0's STOP and its "defect 1"; v3 passes all proofs (Proof 1 conditional on two one-file fixes). The #704 record needs a correction (tomorrow, with Ben). No production file changes.

## Wrap-up
- where-we-landed.md (final), findings-deck.html, v3 §13 proof outcomes, corpus record proof-outcomes paragraph: done.
- Cleanup state: proof worktrees removed by their agents; untracked throwaway code remains under packages/mcp-server/spike/{proof1,proof1b,scale} (git status shows only that dir); kept run artifacts under scratchpad/{proof0,proof0b,proof1,proof1b,scale}.

# Adversary verdict — "Local-first per machine" plan (Fable 5.1, 2026-09-02)

Grounded in `origin/main` `f0af6ae`, the corpus records the plan cites (Architecture, Sync topology, Topology decision parameters, Deferred designs, MCP interface contract, Product Overview), `docs/spikes/704-daemon-authority.md` at `9cece2d`, the harness at `9451ad4` (`spike/daemon-authority-daemon.ts`, `daemon-authority-spike.ts`), Hocuspocus 4.6.0 sources, PR #719's integrator ruling, and two `node:sqlite` probes in my scratch directory (`data-version-probe.mjs`). Line numbers are from those files.

## 1. Overall verdict

The plan does not yet survive as a basis for a decision. Its instinct — the machine, not the process, is the unit of local-first; one shared store; no daemon — is sound and is the banked non-serving-sidecar shape already in the corpus. But the argument that carries the decision ("cut C's two hard stops are artifacts of a second publication path, and D has none") fails on its own terms: option D's `ub open` runs an in-process Hocuspocus server whose `Document` is exactly such a second path — browser edits enter it before the store, the ingress acks them, and the plan specifies no refusal or quarantine for it — and D has no transport at all for presence on a machine, so the browser cannot see an agent's cursor offline and sees it only via the WAN online. Two of the plan's own §11 weakest claims are falsified outright (8: the directory cannot be retired with `meta` unchanged; 9: phases 1–2 build hub-side catch-up, bulk-transfer and history machinery ahead of the fan-in measurement the Topology record says must come first). The single most serious problem: the plan rebuilds the un-quarantined outlet it blames for hard stop (b), while claiming D is free of it.

## 2. Findings (most severe first)

### F1 — P1 — `ub open`'s in-process Hocuspocus Document is the second, un-quarantined publication path the plan says D does not have — CONFIRMED

**Claim attacked.** §5.1 "The store is the bus … Nothing is proxied; no process owns another"; §8 "(b) … the daemon's browser bridge was a second, un-quarantined outlet … Both belong to cut C."

**Evidence.** The reading of the spike is right: the daemon's bridge providers are created outside `HubSync` (`daemon.ts:364-387`), and `quarantine()` detaches only `this.providers` (`sync.ts:813-826`), so a refused append still reached the loopback ingress and the browser. Now apply the same test to D. A browser edit reaches the serving process as a Hocuspocus `messageYjsUpdate`: the server calls `readUpdate` on its `Document` and immediately sends `SyncStatus(true)` (server `MessageReceiver.ts:266-283`); the `onChange` hook runs from `Document.handleUpdate` (`Document.ts:329-346`, `Hocuspocus.ts:282-309`) as an un-awaited promise, so a throwing store append neither stops the ack nor stops the broadcast to every other browser tab, nor stops the serving process's own upstream provider, which forwards every update whose origin is not itself (`HocuspocusProvider.ts:398-405`). That is the shape of hard stop (b) — `applied: false` semantics with the mutation already published — moved from the daemon into `ub open`, and additionally a durability lie to the person: "saved here" for an edit that exists only in two processes' RAM. Production avoids this for MCP writes only because the log observer quarantines before the provider's listener runs (`replica.ts:511-527`); nothing equivalent exists for a Hocuspocus `Document`.

**Smallest change.** State the serving process's refusal path as a design commitment, not a detail: the store append runs synchronously inside the `Document` update path before any ack; a refused append is sticky, closes the room to every browser connection with a named reason, detaches the upstream provider, and the two-level status shows "not saved" — the same rule `Replicas.assertHealthy` enforces. Until that is written, the "D lacks the outlet" argument is false and the C-versus-D comparison in §4 is not evidence-based.

### F2 — P1 — Presence has no path on a machine: the store carries updates, not awareness — CONFIRMED

**Claim attacked.** §5.2 "Presence semantics unchanged"; §5.1 "The browser is thin … talks only to localhost"; "MCP processes keep their own hub path"; non-negotiable 1 "the two see each other's work".

**Evidence.** Awareness travels only through Hocuspocus providers (`sync.ts:696-700`, `replica.ts:382-405`, `1200-1232`); the log observer records document updates only (`replica.ts:496-528`), and `pending_rooms`/`updates` have no presence rows. Under D an MCP agent's cursor goes agent → remote hub → serving process's upstream provider → in-process server → browser: a WAN round trip for a same-machine cursor, and nothing at all with the hub unreachable. CLAUDE.md's spike acceptance ("an `edit_block` … lands in the web UI live, attributed to a visible agent cursor") and decided architecture ("agent sessions are visible in the UI") fail offline, which is the case non-negotiable 1 exists for. The workspace-level "MCP connections" count reads the `_directory` room's awareness (`replica.ts:377-380`, Architecture "the room the connections count reads"); §5.4 retires that room and names no successor. The daemon spike solved both by multiplexing every session's awareness in one process — the shape the plan rejects.

**Smallest change.** Add a local presence channel and count it as phase-1 work: MCP processes attach a second, localhost-only provider per touched room to the serving process when it is up (awareness only, no document updates), or the store gains an ephemeral presence table the relay republishes. Name where workspace-level presence lives once `_directory` is gone. If the owner reads "see each other's work" as content only, this is P2 — but §5.2's "unchanged" is false either way.

### F3 — P1 — Lazy attach as written strands offline work: pending rooms are never pushed unattended — CONFIRMED

**Claim attacked.** §5.1 "A process attaches a room only while a tool call reads or edits that document and detaches after an idle window"; §6 "Attach on the first tool call touching a document"; non-negotiable 4.

**Evidence.** Today an offline-created document is pushed on the next start because `pending_rooms` is adopted at boot and on every settle regardless of any tool call (`replica.ts:269-271`, `967-972`; `store.ts:166-176` "Survives a restart, so a doc created offline is re-attached and pushed on reconnect"). Catch-up in §5.2 is pull-only. An agent machine that creates a document offline, ends its session, and later runs an unattended session that never touches that uuid never pushes it: the document is stranded on one machine with `synced: false` forever, and `releaseQuietRooms` leaves rooms with no replica alone (`replica.ts:1131-1142`). Idle detach of a room whose last change is unacked has the same effect for edits.

**Smallest change.** One sentence: pending rooms are exempt from laziness — attached on boot and at settle, and never detached while `pending_rooms` names them. Proof 1 should include "offline create, restart, unattended push".

### F4 — P2 — The plan's reading of hard stop (a) is not established, and its own hypothesis needs an ingredient the web pane excludes — CONFIRMED (evidence half) / PLAUSIBLE (mechanism)

**Claim attacked.** §8 "(a) … the driver read only `blocks[0]` at every step, and the browser was already in `syncing…` before the test typed, so a displaced new block and an erased document are indistinguishable … Both belong to cut C"; §12 annotating #719 with this reading.

**Evidence.** The indistinguishability is real: `editorText` reads only the first ProseMirror child (`daemon-authority-spike.ts:414-424`), the MCP read takes `blocks[0]` (`:706-709`), the status word is read before typing (`:700-703`), and the integrator already recorded that no direct-path control was run (PR #719, I-F1). But "displaced new block" requires the browser to have typed into a document whose block list did not contain the original block first. The pane refuses to bind an editor until the room's `meta.uuid` matches the route (`ui/App.tsx:200-215`, `ui/route.ts:325-330`, `docIsHydrated`), and Hocuspocus sync step 2 delivers `meta` and `blocks` in one update — so a fresh, empty Y.Doc cannot have been editable. The plan has no mechanism for how the browser's first block became a new one; neither do I after reading the harness, the provider's `onClose` (`HocuspocusProvider.ts:594-617`: awareness removal only) and the server's unload rule (`Hocuspocus.ts:597`). "Belongs to cut C" is therefore a guess, and D keeps both ingredients the guess needs (a loopback Hocuspocus ingress, a cache-less browser).

**Smallest change.** Do not write the reading into #719 or the corpus. Add a Proof 0 before the decision: re-run the harness driver reading the full block list and the whole editor, with a same-run direct-path control, and diagnose the mechanism. The plan's §4 rejection of C and acceptance of D both depend on the answer.

### F5 — P2 — `_directory` cannot be retired with `meta` "unchanged": tombstones, timestamps and "known but not hydrated" live only in the stub — CONFIRMED

**Claim attacked.** §5.4 "`_directory` stops being a shared Yjs document … The `decisions` root and per-document `meta` are unchanged"; §11 claim 8.

**Evidence.** `DirectoryEntry` carries `deleted`, `createdAt`, `updatedAt` (`schema/src/directory.ts:45-47`); `DocMeta` carries none of them (`schema/src/types.ts:232-242`). Archive and restore write the stub only (`tools.ts:1443-1457`, `1484-1505`); every mutator's read-only refusal, the index tombstone and stub repair read it (`tools.ts:600-609`, `replica.ts:636-643`, `900-937`, `store.ts:639-646`); `doc_not_found` versus `doc_not_hydrated` is decided from it (`tools.ts:521-555`, `571-581`). A directory derived from documents in the local log cannot know a document exists before its state is pulled, so the second error class disappears and `list_docs` is complete only after a full catch-up — which the plan should then say plainly: every machine stores every visible document. Moving `deleted`/timestamps into `meta` is a document-shape change (tier 3) that also silently re-decides #345 (tombstone durability, recorded as a coin flip in Deferred designs §6).

**Smallest change.** Either keep `_directory` as the carrier of tombstones, timestamps and workspace presence until the permissions work actually needs a per-identity directory (its retirement is that project's job), or add the fields to `meta` explicitly, re-decide #345 in the same record, and state that a machine holds the whole visible corpus.

### F6 — P2 — The relay falsifies §5.3's attribution: relayed updates carry the relay's identity — CONFIRMED

**Claim attacked.** §5.3 "`updates(doc, seq, identity, ts, update)` … history and attribution … The hub already knows the sending connection's identity (`context.sub`) on every update"; §5.1 "the hub does not care which [path] an update arrives on".

**Evidence.** Identity is per connection (`server.ts:654-672`; `Hocuspocus.ts:282-309` builds `onChange`'s `context` from the connection). The serving process applies every log update to its documents, and its upstream provider forwards any update whose origin is not itself (`HocuspocusProvider.ts:398-405`) — the same reason two MCP processes forward each other's updates today (`sync.ts:788-796` treats only its own providers as remote). Whichever of the two paths reaches the hub first wins the attribution row, and Hocuspocus sync step 2 sends the whole diff the relay holds. Attribution is nondeterministic exactly when the plan introduces it.

**Smallest change.** Drop `identity` from the hub log (a `(seq, doc, ts)` change row is all catch-up needs), or forbid the serving process from forwarding other processes' updates upstream and define one upstream path per author — which reopens the question the plan closed with "two paths stay".

### F7 — P2 — A hub log with identity/history is authoritative server-side state CLAUDE.md's closed list forbids, and §12 does not list that invariant — CONFIRMED

**Claim attacked.** §5.3 "One structure serves catch-up, history and attribution"; §12's list of records changed.

**Evidence.** CLAUDE.md, Invariants: "All document state lives in the Y.Doc, never in server-side tables" and "Closed list, not a general licence for server-side state: the workspaces a hub serves and the credentials that open them, nothing else." Sync topology: the hub's store "is rebuildable from any client: it is plumbing, not the source of truth." Identity and time per update are not in any Yjs state; once the roadmap's versions/diffs read them, the hub log is the only copy, and "a hub can die and nothing is lost" stops being true. §12 revises "Architecture (decided)" and "Invariants" for four other items and omits this one.

**Smallest change.** Either name it as a tier-3 invariant change with the consequence written (hub loss now loses history/attribution; backups become required), or keep the hub log content-only and derive a change sequence from stores.

### F8 — P2 — The log-tail relay as sketched races compaction, and its synchronous append can stall the serving process for the whole busy timeout — CONFIRMED (probe)

**Claim attacked.** §6 "check `PRAGMA data_version` … and only then read the tail"; §11 claim 1.

**Evidence.** `data_version` works as claimed: on this Node (`v26.3.1`, `node:sqlite`, WAL) it moves on another connection's commit and not on one's own, at ~2.5 µs per poll (probe). But a global "`seq > lastSeen`" tail is unsafe: every MCP process compacts a room after 500 log rows at settle (`replica.ts:1151-1176`), pruning `updates` through `lastSeq` and writing a snapshot (`store.ts:389-394`, `467-481`). A room that receives its 500th append and is compacted between two polls leaves nothing above `lastSeen` in `updates`; the relay's in-memory `Document` silently misses those updates until the room is re-hydrated, and the browser edits over a view that lacks an agent's text. The per-room `readSince` primitive already handles this (`store.ts:483-498`, `replica.ts:563-582`); the sketch does not use it. Separately, the probe shows an appender behind a held write lock waits the full `busy_timeout` and then throws `database is locked`; with the production 5 s timeout, a browser update appended synchronously inside the serving process's event loop can freeze every websocket it serves for up to 5 s, and Proof 1's "no `SQLITE_BUSY` escapes" bar has to say what happens after the timeout.

**Smallest change.** Only the lease holder compacts (so the relay/index maintainer never races itself), the tail read is `readSince` per room or unions `snapshots.through_seq > watermark`, and Proof 1 measures the worst-case lock hold (an FTS `indexDoc` of a large document, a snapshot write) against the relay's stall.

### F9 — P2 — The lease has no fencing: a paused or wedged holder resumes and writes after losing it — CONFIRMED (by the SQL in §6)

**Claim attacked.** §6 "SQLite's single-writer transaction is the arbiter"; §11 claim 2 "no split-brain index, no duplicated catch-up"; Proof 1's "exactly one lease holder".

**Evidence.** The acquire statement decides who *takes* the lease; nothing in the plan makes index writes or `index_watermark` conditional on still holding it. A holder stopped by SIGSTOP, a debugger, a long GC or a laptop lid closed mid-renewal misses renewal, another process takes the lease, the first wakes and finishes its batch: index rows from an older replica view overwrite newer ones and the watermark can regress. The §10 "progress check" detects a wedged holder; it does not stop the un-wedged ghost. Derived data makes this recoverable, but "exactly one holder" is then unmeasurable and the bar in Proof 1 cannot pass.

**Smallest change.** Index writes and the watermark update run in a transaction that asserts `lease.holder = me` and take `MAX(watermark)`; a failed assertion drops the batch. Also state that an MCP-process holder runs a background tail poll — today nothing runs between tool calls (`replica.ts:986-1035`, everything is at settle), so a holder that is idle maintains nothing.

### F10 — P2 — Catch-up watermarks need a hub epoch, or a replaced hub leaves every machine silently stale — PLAUSIBLE

**Claim attacked.** §5.2 "The hub keeps a monotonic change sequence"; §10 "Catch-up completeness … must be specified"; §11 claim 3.

**Evidence.** Sync topology, rule 3: "A hub can die and nothing is lost. Any client refills a fresh hub from its full copy." A fresh hub starts its sequence at zero; a machine holding watermark N asks `since=N`, gets nothing, and is caught up forever on an empty feed — the CouchDB `_changes` failure the plan names, in its most ordinary form (a restore from backup produces the same thing with a rewound sequence). Elevation (§6) "the local store's watermark becomes the hub's sequence" already treats two sequence spaces as one.

**Smallest change.** `/api/changes` answers `{epoch, seq, changes}`; a watermark carries the epoch; a mismatch, or a `since` below the hub's retained horizon, forces bootstrap. Write it into the catch-up spec before any endpoint exists.

### F11 — P2 — Phases 1–2 build the hub-side machinery ahead of the measurement the corpus says decides it; a smaller cut meets every non-negotiable — CONFIRMED

**Claim attacked.** §4 Option A "Rejected. Subscriptions scale with people × processes × documents"; §9 phases 1–2; §11 claim 9.

**Evidence.** The Topology decision parameters' trigger table makes fan-in an instrument-first question ("Is master fan-in a real limit after lazy attachment? … Never near limits means T1's strongest argument is dead"), and Proof 3 is scheduled *after* the re-cut. Deferred designs §2 already banks the shape that removes the processes factor without any hub change: one persistent full-corpus replica per machine (the non-serving sidecar), MCP processes reading the shared log; it also records the Codex round-3 verdict that "a master-side index violates the MCP-local anchor". Non-negotiable 2 is met today: `ub remote join` attaches an existing replica and pushes its log (Sync topology, "Crossing worlds"; `store.ts:450-465`, `replica.ts:269-271`, `sync.ts:691-694`). Non-negotiables 1, 3 and 4 need the store relay in `ub open`, a lease, and presence — none of the change feed, bulk endpoints, hub-derived tables, hub HTTP search, or `_directory` retirement.

**Smallest change.** Cut phase 1 as: lease with an *eager* holder (the sidecar), lazy attach only in non-holders, `ub open` relay + localhost rooms + presence channel, two-level status. Run Proof 3 against today's hub protocol with simulated machines *before* phase 2. Phase 2 becomes conditional on that number.

### F12 — P3 — Small gaps the plan should state — PLAUSIBLE

Two `ub open`s (two workspaces, two terminals): the second cannot take the lease but must still serve localhost rooms, so "serving process" and "lease holder" are two roles, not one. The localhost HTTP API (`/api/status`, `/api/search`) must stay token-gated and CORS-less: any origin can open a WebSocket or send a simple GET to 127.0.0.1. Removing IndexedDB also removes the remote-browser offline reload and the #601 cache-confirmed reading — acceptable per non-negotiable 1, but §5.1 should say the remote-browser path regresses. `_feedback` cut is already banked (Deferred designs §8) and fine.

## 3. The nine claims of §11

| # | Claim | Verdict | Reason |
|---|---|---|---|
| 1 | Store-as-bus + log-tail relay fast and correct | weakened | `data_version` confirmed (2.5 µs/poll); global tail races compaction (F8); synchronous append can stall the serving process up to `busy_timeout`; the ingress needs a refusal path (F1) |
| 2 | Lease is sufficient coordination | weakened | No fencing; ghost holder writes after losing the lease; idle MCP holder maintains nothing without a background poll (F9) |
| 3 | Catch-up by pull can be complete with one hub sequence | weakened | Specifiable, but needs a hub epoch and a horizon rule before anything is cut (F10) |
| 4 | Two upstream paths keep the pending set honest | survives (content, pending) / falsified (attribution) | `clearPending` through `min(marker, lastSeq)` generalizes (`sync.ts:942-948`, `replica.ts:1131-1142`); but pending rooms must be exempt from laziness (F3) and relayed updates carry the wrong identity (F6) |
| 5 | #704's hard stops are artifacts of cut C | (b) survives as mechanism but indicts D (F1); (a) falsified as a conclusion | Evidence genuinely cannot distinguish erased from displaced, yet the displaced-block hypothesis needs an editable empty doc the pane refuses to bind (F4); no control run |
| 6 | Removing IndexedDB loses nothing the non-negotiables need | weakened | Local mode: nothing lost if `ub open` is up. Remote-browser offline reload and #601's confirmed-cache reading go; and (a) occurred with IndexedDB disabled, undiagnosed |
| 7 | Hub as app server does not reintroduce server-authoritative latency | survives | Machine reads stay local; the one remote fetch on the tool path (`doc_not_hydrated` → pull) exists today too |
| 8 | Meta in Yjs, directory derived, no consistency gap | falsified | Tombstones, timestamps, known-but-not-hydrated and workspace presence live only in the stub; "meta unchanged" contradicts "directory retired" (F5, F2) |
| 9 | Not over-engineered; phases 1–2 are the smallest cut | falsified | Hub log with identity, change feed, bulk endpoints, hub search, directory retirement are ahead of the fan-in measurement; the banked sidecar plus a relaying `ub open` meets NN1–4 (F11) |

## 4. Over-engineering check

- **Hub per-document append-only log with identity and time** — no non-negotiable needs history or attribution; catch-up needs `(doc, seq)`; it also breaks the closed-list invariant (F7) and cannot attribute relayed updates (F6). Simpler: keep the snapshot row, add a `changes(seq, doc, ts)` row written per store.
- **`_directory` retirement and hub-derived / locally-derived directories now** — NN5 only asks that permissions stay possible; retiring the directory before permissions exist relocates tombstones, timestamps and presence for no current benefit (F5). Simpler: keep `_directory`; add the per-identity filter when the identity exists.
- **`/api/bootstrap`, `POST …/updates`, `ub remote push`** — NN2 is already met by `ub remote join` semantics; cold-start cost over websocket waves is unmeasured (the Topology record's "hydration timings" instrument). Build after the number exists.
- **Hub HTTP search for store-less browsers** — no non-negotiable; today's remote browser has no search either. Defer.
- **Lazy attach in every process** — only justified once fan-in is shown to be a limit; an eager lease holder (the sidecar) removes the processes factor with no protocol change.
- Not over-engineered: the lease (with fencing), the `ub open` relay and localhost rooms, two-level status, storage/shape versions before launch.

## 5. What the plan is missing entirely

- A presence transport on the machine, and a home for workspace-level presence once `_directory` goes (F2).
- The serving process's refusal path — what happens when the store refuses a browser edit (F1).
- Ownership of compaction and a background tail poll for a non-serving lease holder (F8, F9).
- A hub epoch in the catch-up watermark and a horizon rule for rewound or rebuilt hubs (F10).
- A diagnosis of hard stop (a) with a control run before C is "rejected" and D adopted on that reading (F4) — the integrator already recorded this as the accepted risk on #719; the plan converts an accepted risk into a conclusion.

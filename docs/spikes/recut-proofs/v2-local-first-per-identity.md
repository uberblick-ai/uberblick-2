# Local-first per identity on a machine — architecture re-cut plan, version 2

**Status:** draft v2 for a second adversarial review, 2026-09-02. Supersedes v1 (`v1-local-first-per-machine.md`). Nothing here is decided or built.
**Owner:** Ben. **Drafted by:** Claude (Fable 5.1). Grounded in the live corpus, `origin/main` at `f0af6ae`, and the two v1 verdicts (`adversary-fable.md`, `adversary-codex.md`). The disposition of every v1 finding is in `reconciliation-v1-to-v2.md`.

---

## 0. What changed from v1, and what to attack

v1 proposed a per-machine store plus a hub rebuilt as an application server with a per-document history log, pull catch-up, bulk transfer and hub-side search, all in the same cut. Two independent reviews rejected it for overlapping reasons: the localhost serving path had the very ack-before-durability hole v1 blamed on the failed daemon spike; presence had no local path; lazy attach stranded offline work; the directory cannot be retired; the lease had no fencing; hub-held history and hub tables broke a written invariant and attribution via the connection was wrong; and phases 1–2 built hub machinery ahead of the measurement that decides it.

v2 keeps the instinct and cuts the rest. The unit of local-first is **an identity on a machine**, with one shared store. The hub protocol is **unchanged**. History, blame, dashboard data, permissions, assets and deletion move to **separate decision records**; this plan only keeps their doors open. The owner's stated principle governs the cut: a harder, simpler cut now, and roll back what proves too far, rather than fail-safes for risks not yet seen.

Reviewers: verify that v2's claimed resolutions actually hold against the code, look for what v1 had right that v2 lost, check whether the smaller cut still meets every required property in §2, and push back on anything that is still more than R1–R5 need. Section 11 lists the claims I consider weakest.

## 1. Context

Uberblick is a self-hosted, open-source knowledge base for teams of roughly 50–100 people; agents read and write through MCP, humans through a web editor. Today (Architecture, corpus): one Yjs document per uberblick document; one Hocuspocus hub pinned to 4.6.0 with one SQLite snapshot row per document; one MCP server per agent session, each holding an authoritative local replica — an append-only update log in SQLite, one file per OS user and workspace, shared by every process on that machine — plus a derived FTS5/tags/links index; every MCP process eagerly attaches every room; the web client keeps a y-indexeddb copy per room and has no search of its own. Release 1 decided the plain star and parked the per-machine shape behind evidence. The daemon spike (#704, PR #719) tested a daemon that solely owned SQLite with MCP processes proxied behind it; it proved the content and identity path and reported two hard stops whose attribution to the topology was not isolated (integrator ruling on #719).

## 2. Required and preferred product properties (owner, 2026-09-02)

They describe what the product must or should do, not how. A challenger who can satisfy them with a different shape than §5 should say so; that is a finding.

**Strongly required**

- **R1 — Complete offline operation on one machine.** With no hub reachable, a person edits in the browser, agents on that machine read, search and write through MCP, and the two see each other's work. Listing and searching the corpus in the browser works offline too. Agents on local models are a real and growing case.
- **R2 — Start local, elevate later.** A workspace starts on one machine with no infrastructure and is later elevated to a hub on a remote machine when a team forms, without re-creating anything.
- **R3 — Teams of fifty to a hundred people sync through one hub without ceremony.**
- **R4 — Agents sync without a person present.** Corpus work happens unattended on remote machines, so an MCP process pushes and pulls on its own.
- **R5 — Users and per-document permissions come later**, and nothing decided now may make them impossible. Identity will be per user (an `ub auth`-like step; today `ub init`'s name prompt is the placeholder), never per machine.

**Strongly preferred**

- **P1 — A machine's work stays on the machine.** Several MCP processes at once, in back-and-forth with a local agent, must not accumulate network latency across a sequence of tool calls.
- **P2 — Load lives on the developer machines** rather than being centralized on the hub by default.
- **P3 — Keep the current technology** (Yjs, Hocuspocus, SQLite) and use it more deliberately.
- **P4 — No installed daemon or service manager.** A foreground process started when the person sits down is acceptable.
- **P5 — Simplicity over fail-safes** (owner, 2026-09-02): a harder cut that may crash and burn, then roll back on evidence, rather than infrastructure for risks not yet observed.
- **P6 — Revoked data is eventually removed from a machine** (deferred).

Product requirements that are **not** topology requirements, recorded so they are not lost: versions, diffs and blame ("who edited what", a git-blame mental model) are wanted; a dashboard over GitHub state and agent reports is wanted. Each gets its own decision record (§8).

## 3. What stays

Yjs for merge; one `yjs` per process; one update encoding; Hocuspocus 4.6.0 pinned with its four obligations; SQLite with WAL and FTS5; the block model and room grammar; UUID identity; markdown as export only; the MCP tool surface and its honesty contract (`{applied, synced}`, `rev`, block-scoped edits); the CLI shape; **the hub's wire protocol, persistence and tools, unchanged in this cut**; **`_directory` and `_sidebar` as synced documents**; the existing rule that every writer indexes the documents it changes before its tool call returns. Rejected alternatives (CouchDB/PouchDB, Automerge, Postgres-centric sync engines) are recorded in v1 §3 and not re-argued.

## 4. Options weighed

| # | Option | Shape | Verdict |
|---|---|---|---|
| A | Full corpus per process (today) | Every MCP process attaches every room; the browser keeps a second full copy with no index | Rejected as the end state: process-count fan-in, no offline browser search, two local copies. Kept as the behaviour of exactly one process per store (the holder). |
| B | Thin clients | MCP and browser are plain Yjs clients of the hub | Rejected: fails R1, R2; works against P1, P2. |
| C | Daemon owning the store | One daemon owns SQLite and the hub socket; MCP processes proxied behind it (#704) | Rejected: the proxy layer and un-gated ingress; a daemon (P4). The ingress hazard it showed applies to any localhost serving path, including D's — see §5.3. |
| D (v1) | Per-machine store + hub as application server | Store as bus; lazy attach everywhere; lease-only indexing; hub log with identity; catch-up, bulk, hub search; directory retired; IndexedDB removed | Rejected by both reviews: ingress hole, no presence path, stranded pending rooms, unfenced lease, directory not retirable, invariant breaches, hub machinery ahead of evidence. |
| **D2 (v2)** | **Per-identity store, holder + followers, `ub open` as serving process, hub unchanged** | One process per store holds the full corpus and pushes everything; others attach lazily; writers index their own documents; a fenced lease covers only background work; `ub open` serves localhost rooms behind a durable-before-ack gate, relays the store, carries presence and two-level status | **Proposed.** |

## 5. Target shape (D2)

**Vocabulary.** *Identity*: the user a process runs as (per-user credential later; today one per OS user). *Store*: the SQLite file for one identity and workspace — the append-only update log plus the derived index; the machine's bus. *Holder*: the one process per store that attaches every room, pushes every pending room and runs background catch-up and compaction — today's replica behaviour, held by exactly one process. *Follower*: any other process on the store; attaches rooms lazily. *Lease*: the fenced, store-held right to be the holder. *Serving process*: what `ub open` runs. *Gate*: the rule that a browser update is durable in the store before it is acknowledged or published.

### 5.1 One store per identity

The store's contract is unchanged: every process appends its Yjs updates to the shared log and replays the log tail before answering (`store.ts`: WAL, `busy_timeout = 5000`, `seq` is commit order, two instances on one database is the normal case). MCP processes read and write without leaving the machine (P1, P2). The store refuses a network filesystem. The store path is keyed by identity as well as workspace once identity exists; today one OS user is one identity, and two identities on one OS account or several people on one remote box mean two stores and two serving processes (recorded, not built — R5).

### 5.2 Holder and followers

- **Exactly one holder per store**, elected through the lease. The holder does what every process does today: attaches every room, publishes presence only in rooms a tool call touches, pushes every pending room at boot and at settle, runs compaction. `ub open` takes the lease when it starts if it is free; otherwise the holder is whichever MCP process holds it. There is no priority preemption: a running holder keeps the lease until it exits or fails to renew.
- **Followers attach lazily**: a room is attached on the first tool call that touches the document and released after the idle window (the existing 30-second presence rule). **Pending rooms are exempt**: a room this process wrote is attached at boot and at settle and is never released while `pending_rooms` names it, so an unattended agent that created a document offline pushes it on its next start whether or not any tool touches it (R4).
- **Every writer indexes what it changes** before its tool call returns, as today; `search` and `list_docs` therefore never lag a local write. The lease covers **only background work**: catch-up for rooms nobody touched, and compaction. When no process holds the lease, nothing catches up in the background, and the next process to start takes it.
- **Followers keep their own hub path.** A follower syncs the rooms it holds directly with the hub, as today. The holder syncs everything. Two paths carrying one update is harmless for content (Yjs is idempotent) and must be proven harmless for the pending set (Proof 2, §9).
- **Lease fencing.** `lease(name PRIMARY KEY, holder, generation INTEGER, expires_at)`. Acquire with a single conditional `UPDATE … SET holder=?, generation=generation+1, expires_at=? WHERE expires_at < ?` (or insert when absent); renew every 5 s with a 15 s TTL; every holder-only write — compaction, background index rows, the catch-up watermark — runs in a transaction that asserts `lease.holder = me AND lease.generation = mine`, and a failed assertion drops the batch. A holder whose watermark does not advance while the log grows is treated as wedged and releases the lease. Only the holder compacts, so followers and the relay never read a log whose rows were pruned under them by a stranger; the relay reads per room through the existing `readSince` plus the snapshot table rather than a global `seq > lastSeen`.

### 5.3 `ub open`, the serving process

Foreground, started when a person sits down; the pinned hub code with the local roles switched on. Two `ub open`s on one store are allowed: both serve, at most one is the holder.

- **Serves the web bundle** and runs an in-process Hocuspocus server for localhost rooms. Binds `127.0.0.1` only; the browser gets its room token from the per-request config document as it does today against the hub; the websocket upgrade checks the one expected Origin; the HTTP API is token-gated and sends no CORS headers.
- **The gate.** A browser update is appended to the store **before** the in-process server applies, acknowledges or broadcasts it. Two ways to build that on the pinned server, chosen by Proof 1b: the awaited pre-apply hook (`beforeHandleMessage`), decoding the sync frame and appending the update it carries, so a refused append throws before anything is applied; or a synchronous `update` listener registered ahead of the server's own, on the same pattern the MCP replica uses (`replica.ts:493-530`), with the ordering pinned by a seams test. Either way a refused append is sticky: the room closes to every browser connection with a named reason, the upstream provider detaches, and status reads "not saved". Without the gate, D2 has the hole both v1 reviews found (Fable F1, Codex 1), so the gate is a design commitment, not a detail.
- **The relay.** Poll `PRAGMA data_version` (2.5 µs per check, measured in the v1 review); on change, read each served room's tail through `readSince` and the snapshot table, apply with the log origin so the observer does not re-log, and let the in-process server broadcast. Target: an agent's edit visible in the browser well under 250 ms; measured in Proof 1. The append the gate performs is synchronous and can wait up to the busy timeout behind another writer's transaction; Proof 1 measures the worst-case hold (a large FTS index write, a snapshot) and the plan accepts a stall of that length rather than adding a queue (P5).
- **Presence.** MCP processes open one localhost provider per touched room to `ub open`, carrying awareness only (document updates travel through the store). `ub open` relays awareness to the browser and upstream. When `ub open` is not running there is no browser on the machine, so nothing needs the local channel; agent-to-agent presence has no consumer today. Workspace-level presence (the connections count) stays where it is, in the directory room's awareness, because the directory stays.
- **Two readings of synced.** `/api/status` reports per room `{applied, hubAcked}` from the store's pending table and the holder's acknowledgement knowledge; the browser shows "saved here" and "synced with hub" as two facts, and "not saved" when the gate refused or the serving process is gone.

### 5.4 The browser is thin

Working locally, the browser talks only to localhost; the store is the only local copy. **y-indexeddb is removed** (owner decision, 2026-09-02, P5). The accepted consequence: an edit typed after the browser sent it and before the gate stored it is lost if `ub open` dies in that window or the page is reloaded then; the browser shows "not saved" for it. A browser opened against the remote hub from a machine without `ub` keeps today's direct connection and works only while connected; it has no offline reload any more. Both are recorded as the harder cut, to be revisited on evidence.

### 5.5 The hub is unchanged

No change feed, no bulk transfer, no hub-side search, no hub log in this cut. R2 is met today by `ub remote join`: it binds a machine to a remote workspace and pushes the local store's pending rooms on connect, so a workspace that started local is uploaded by the first join. Cold start of a new machine remains the room-by-room hydration that exists today. Whether the hub needs any of v1's machinery is decided by the scale probe (§9), not assumed.

### 5.6 Workspace-level documents

`_directory` stays as the carrier of stubs, tombstones and timestamps, and of workspace presence. `_sidebar` stays. `_feedback` is cut (#725, independent of this plan).

## 6. What falls away

Full-corpus attachment in every process (kept for exactly one). IndexedDB in the browser. The daemon-as-proxy cut. v1's hub application server, per-document hub log, catch-up and bulk endpoints, hub search, directory retirement, dashboard tables and lease-only indexing.

## 7. What must be designed, not patched

- The gate's exact mechanism on the pinned server (Proof 1b), and what the browser sees when it fires.
- The lease: acquisition, renewal, fencing assertions, the wedged-holder rule, and holder handoff cost (a new holder attaches every room, the same cost as today's boot).
- The pending set with two upstream paths: which sequence each acknowledgement covers (Proof 2).
- Store schema versioning across processes sharing one file: a process refuses a store whose schema version is newer than its own, so an upgrade is ordered "stop everything, upgrade, start" and never mixed.
- The localhost auth surface: token, Origin check, no CORS, loopback bind.

## 8. Doors kept open, decided elsewhere

Each item below is a product requirement or a later requirement with its own decision record; this plan only avoids closing its door.

- **History, versions and blame** (owner: required). The hub keeps only the current state today. A future per-document hub log is authoritative server-side state that no client can rebuild — a named change to CLAUDE.md's closed-list invariant with the consequence that hub backups become mandatory. Authorship needs two layers: user-level from the connection's per-user credential (correct once every process of a user carries that user's identity), and session-level from Yjs client ids registered per session, never from which process relayed the update. Doors kept open here: nothing in D2 collapses identities (one store per identity), and the store already records origin per update.
- **Dashboard and structured non-document data** (GitHub state, agent reports): hub tables would be a second authority and violate the same invariant; needs its own record.
- **Permissions** (R5): the unit is the document; the hub filters before it sends; nothing workspace-wide may leak per-document facts (which is what eventually forces a per-identity directory); a local copy cannot be taken back, and removal is P6.
- **Binary assets**: never in Yjs; an operator-configured S3-compatible bucket enables them later.
- **Growth** (Yjs history inside documents), **deletion** (archive only; what is promised before launch), **launch versioning** (storage and document-shape versions with the rule that an older client preserves what it does not understand).

## 9. Evidence and proofs

**Reading of #704 / PR #719.** Proven: one process served the real web app and two real MCP processes with distinct presence; steady-state bars met; a synchronously appended edit survived a crash before its reply. The two hard stops are **undiagnosed**: the driver read only the first block and the first editor child, so erased and displaced are indistinguishable; the refused append reached the hub through an un-gated ingress. The refused-append hazard is a property of any un-gated localhost ingress, D2's included, which is why §5.3's gate exists. The content-loss hard stop has no established mechanism; no reading of it goes into #719 or the corpus before Proof 0.

- **Proof 0 — diagnosed control run.** Re-run the #704 driver reading the full block list and the whole editor, with a same-run direct-path control, and name the mechanism. Cheap; the harness branch exists.
- **Proof 1 — the shared store.** Four followers mostly reading and one writer on one WAL store with the fenced lease: every committed write visible to every other process's next read within a declared bound; lease handoff on `SIGKILL` within a bound with no duplicated or lost background work; `edit_block`/`get_doc` p50/p95 within declared bars against a single-process baseline; the longest lock hold and the relay's worst stall measured; no `SQLITE_BUSY` escaping as a failure; "offline create, restart, unattended push" holds. One report, unmerged harness.
- **Proof 1b — the gate.** On the pinned server, a refused append is never acknowledged, never broadcast to another tab, never forwarded upstream; page reload after `ub open` death shows exactly the accepted loss of §5.4 and nothing more.
- **Proof 2 — two upstream paths.** Holder and follower on one room through outage, crash and lease handoff: the pending set clears only through acknowledged sequences and never marks unsent work as synced.
- **Scale probe — informs, does not gate** (owner, 2026-09-02). One hub in local Docker, ~100 simulated identities × 3 processes, today's protocol with one holder per store: hub CPU and memory, room subscriptions, hydration time for a new machine. Its numbers decide whether any hub-side work (v1's catch-up, bulk, search) is scheduled at all.

Sequence: this record is adopted provisionally once the second review is reconciled; Proofs 0, 1, 1b and 2 are the first four issues; a failed proof reopens the record. The scale probe runs early and in parallel.

## 10. Sequencing

- **Phase 0 — prove.** Proofs 0, 1, 1b, 2; scale probe scheduled; short corpus decision record; revise Topology decision parameters and Deferred designs §2; CLAUDE.md's decided-architecture section changes with the first merged issue (tier 3, owner approval).
- **Phase 1 — the machine.** Fenced lease and holder election; lazy attach in followers with the pending-room exemption; `ub open`: localhost rooms behind the gate, relay, presence channel, two-level status, localhost auth; IndexedDB removal; store schema version gate; store path keyed by identity when identity lands.
- **Phase 2 — the hub, conditional** on the scale probe. If scheduled, its catch-up protocol must specify a hub epoch in every watermark, a start-of-transfer sequence cut followed by changes, atomic publication into an empty target, pagination, backpressure and idempotency (the banked export/import safety contract, Deferred designs §3).
- **Phase 3 — journeys.** Offline machine: browser plus two MCP processes plus a local-model agent, review in Uberblick, reconnect converges. New machine joins. Start local, elevate with `ub remote join`. Unattended agent on a remote machine.

Rough size: phase 1 is five to seven issues; phase 2 exists only on evidence.

## 11. Claims I consider weakest (attack these first)

1. That the gate can be built on the pinned server without patching it, and that it does not reintroduce a lock stall the browser feels.
2. That holder election through a fenced lease plus lazy followers is enough for R3 until the scale probe says otherwise, and that lease handoff cost is acceptable.
3. That an awareness-only localhost provider is enough for presence, and that "no `ub open`, no local presence" loses nothing R1 needs.
4. That two upstream paths keep the pending set honest (Proof 2).
5. That removing IndexedDB is an acceptable crash window pre-launch (owner decision, but the size of the window is a claim).
6. That `ub remote join` really meets R2 today, including a workspace with thousands of documents.
7. That an unchanged hub does not violate R3 — that fifty to a hundred holders against today's protocol is within reach.
8. That D2 is now the smallest cut, and that nothing v1 had right was lost with the hub machinery.
9. That separating history and dashboard data into their own records hides no dependency the topology needs now.

## 12. Records this changes

- Topology decision parameters (`8d148677-93cc-4e7a-953f-67c65b77598f`): end-state B → per-identity store as the machine's authority with `ub open` serving; the "hub-side index violates the local anchor" line stands (no hub index in this cut); the T1 preconditions are answered by "no relay identity: every process carries the user's credential" and by the gate.
- Deferred designs and their triggers (`435d453a-5bf2-46aa-b84a-e14959133032`) §2: the non-serving sidecar becomes the holder role; the active-document model becomes lazy attach in followers; §8's `_feedback` cut executes as #725.
- Architecture (`d2d28f20-7c9a-4547-b65b-0fdf75a41dff`): rewritten as code lands.
- CLAUDE.md: no invariant changes in phase 1. The decided-architecture text gains the holder/follower rule and the gate; the "fresh client enumerates and searches after hydration" acceptance criterion stays.
- #704 stays open until Proof 0 lands; PR #719 merges as the report it is, with no reading added.
